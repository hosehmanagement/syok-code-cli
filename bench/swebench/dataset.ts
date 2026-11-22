// SWE-bench-style datasets. Two real formats are read (field names checked on huggingface.co on 22 Nov 2026):
//  - princeton-nlp/SWE-bench_Verified (classic): repo, instance_id, base_commit, patch, test_patch, problem_statement, hints_text,
//    created_at, version, FAIL_TO_PASS and PASS_TO_PASS (JSON text holding a list), environment_setup_commit, difficulty.
//  - SWE-bench/SWE-bench_Verified (what `swebench eval verified` uses today): the same, plus image, eval_script, eval_type,
//    log_parser, and FAIL_TO_PASS / PASS_TO_PASS as real lists.
// Both are published as Parquet; bench/README.md shows how to save them as JSONL.
import { readFileSync } from "node:fs";

export interface Instance {
  instance_id: string; repo: string; base_commit: string; problem_statement: string;
  FAIL_TO_PASS: string[]; PASS_TO_PASS: string[];
  image: string;               // the official evaluation image (from the row, or built from the official naming rule)
  imageFromRow: boolean;
  eval_script?: string;        // the official test script (new format only); used by the quick local grade
  log_parser?: string;
  patch?: string;              // the reference fix (used only by the "gold" pseudo-tool that checks the pipeline)
  test_patch?: string;
  version?: string;
  hints_text?: string;
}
const list = (v: any, field: string, id: string): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") { try { const j = JSON.parse(v); if (Array.isArray(j)) return j.map(String); } catch {} }
  if (v === undefined || v === null) return [];
  throw new Error(`${id}: ${field} is neither a list nor JSON text holding a list`);
};
/**
 * The official image name when the row does not carry one. Rule from the swebench harness source
 * (swebench/image_builder/image_spec.py, ImageSpec.name): "sweb.eval.<arch>.<instance_id>:<tag>", with amd64 written x86_64,
 * prefixed by the Docker Hub namespace "swebench/", "__" replaced by "_1776_" (Docker Hub does not allow "__"), all lower case.
 * Example from the dataset itself: astropy__astropy-12907 -> swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest
 */
export function officialImage(instanceId: string, o: { namespace?: string; arch?: "x86_64" | "arm64"; tag?: string } = {}): string {
  const key = `sweb.eval.${o.arch ?? "x86_64"}.${instanceId}:${o.tag ?? "latest"}`;
  return `${o.namespace ?? "swebench"}/${key}`.replace(/__/g, "_1776_").toLowerCase();
}
export function normalize(row: any, i = 0): Instance {
  const id = row?.instance_id;
  if (!id || typeof id !== "string") throw new Error(`row ${i + 1}: instance_id is missing`);
  for (const k of ["repo", "base_commit", "problem_statement"]) if (!row[k]) throw new Error(`${id}: ${k} is missing`);
  return {
    instance_id: id, repo: row.repo, base_commit: row.base_commit, problem_statement: row.problem_statement,
    FAIL_TO_PASS: list(row.FAIL_TO_PASS, "FAIL_TO_PASS", id), PASS_TO_PASS: list(row.PASS_TO_PASS, "PASS_TO_PASS", id),
    image: row.image || officialImage(id), imageFromRow: !!row.image,
    eval_script: row.eval_script || undefined, log_parser: row.log_parser || undefined,
    patch: row.patch, test_patch: row.test_patch, version: row.version, hints_text: row.hints_text,
  };
}
/** A .jsonl file (one row per line, as `datasets ... .to_json()` writes) or a .json file holding a list. */
export function readDataset(file: string): Instance[] {
  const text = readFileSync(file, "utf8").trim();
  if (!text) return [];
  const rows = text.startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`${file} line ${i + 1} is not JSON`); } });
  return rows.map(normalize);
}
/** A fixed random choice: the same seed always picks the same instances, whatever order the file is in. */
export function select(all: Instance[], o: { ids?: string[]; n?: number; seed?: number }): Instance[] {
  if (o.ids?.length) {
    const by = new Map(all.map((x) => [x.instance_id, x]));
    const missing = o.ids.filter((id) => !by.has(id));
    if (missing.length) throw new Error(`Not in the dataset: ${missing.join(", ")}`);
    return o.ids.map((id) => by.get(id)!);
  }
  const sorted = [...all].sort((a, b) => (a.instance_id < b.instance_id ? -1 : a.instance_id > b.instance_id ? 1 : 0));
  let s = (o.seed ?? 42) >>> 0;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; // mulberry32
  for (let i = sorted.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sorted[i], sorted[j]] = [sorted[j], sorted[i]]; }
  return sorted.slice(0, Math.max(0, Math.min(o.n ?? sorted.length, sorted.length)));
}
/** One line of predictions.jsonl in the format the official harness reads (instance_id, model_name_or_path, model_patch). */
export function predictionLine(instanceId: string, model: string, patch: string): string {
  return JSON.stringify({ instance_id: instanceId, model_name_or_path: model, model_patch: patch });
}
/** The task text given to every tool: the issue, and where the code is. The same words for every tool. */
export function promptFor(x: Instance, cwd = "/testbed"): string {
  return `You are working in the git repository ${x.repo}, checked out in ${cwd}. Fix the issue below by changing the source code. ` +
    `Do not add, change or delete test files. Do not commit. When you are done, the fix must be left as uncommitted changes in ${cwd}.\n\n<issue>\n${x.problem_statement}\n</issue>\n`;
}
