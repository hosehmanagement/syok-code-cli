#!/usr/bin/env bun
// Run a coding tool on SWE-bench-style instances, one container per instance, and write predictions.jsonl in the format the
// OFFICIAL SWE-bench harness grades. Beginner guide: bench/README.md (section "SWE-bench").
//   bun bench/swebench/run.ts --dataset verified.jsonl --n 5 --seed 42 --tool syok --model <model> [--backend docker|modal] [--grade] [--yes]
//   bun bench/swebench/run.ts --dataset verified.jsonl --ids astropy__astropy-12907 --tool gold --grade     check the pipeline (no AI, no cost)
// Tools: syok, claude, codex, cursor; and two pseudo-tools that spend nothing: gold (applies the dataset's reference fix) and noop.
// Options: --timeout <sec per instance, default 1800>  --out <folder, default bench/swebench/out>  --platform linux/amd64
//          --max-spend <usd, default 5>  --cost-per-instance <usd, default 2>  --skip-install (the tool is already in the image)
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { q } from "../lib/proc.ts";
import { getAdapter } from "../adapters/index.ts";
import type { Adapter } from "../adapters/types.ts";
import { readDataset, select, predictionLine, promptFor, type Instance } from "./dataset.ts";
import { dockerBackend, modalBackend, type Backend, type Sandbox } from "./backends.ts";
import { grade, type Grade } from "./grade.ts";

export interface InstanceReport {
  instance_id: string; image: string; tool: string; model: string;
  headMatchesBase: boolean | null;
  toolExit: number | null; toolTimedOut: boolean; toolSeconds: number;
  tokens: { input: number | null; output: number | null; total: number | null }; costUsd: number | null;
  patchBytes: number;
  quickGrade: (Grade & { applied: boolean; note: string }) | { skipped: string };
  error?: string;
}
export interface InstanceOpts { backend: Backend; tool: string; adapter?: Adapter; model: string; timeoutSec: number; doGrade: boolean; platform?: string; skipInstall?: boolean; logDir: string }

const TESTBED = "/testbed";
export const PRE_UNTRACKED = "git ls-files --others --exclude-standard > /tmp/syok-pre-untracked.txt";
/** Changes to tracked files since the base commit, plus files the tool created (not the untracked files that were already there). */
export const diffCommand = (base: string) =>
  `git ls-files --others --exclude-standard | grep -vxF -f /tmp/syok-pre-untracked.txt | tr '\\n' '\\0' | xargs -0 -r git add -N -- 2>/dev/null; git diff --binary ${base} 2>/dev/null`;
/** Put text into the container as a file, through a local temporary file that is removed again afterwards. */
async function uploadText(box: Sandbox, name: string, text: string, remote: string): Promise<void> {
  const d = mkdtempSync(join(tmpdir(), "swebench-")); const f = join(d, name);
  try { writeFileSync(f, text); await box.upload(f, remote); } finally { rmSync(d, { recursive: true, force: true }); }
}

/** Start the instance's container, let the tool work in /testbed, and take everything it changed as a git diff. */
export async function solveInstance(x: Instance, o: InstanceOpts): Promise<{ patch: string; report: InstanceReport }> {
  const rep: InstanceReport = { instance_id: x.instance_id, image: x.image, tool: o.tool, model: o.model, headMatchesBase: null, toolExit: null, toolTimedOut: false, toolSeconds: 0, tokens: { input: null, output: null, total: null }, costUsd: null, patchBytes: 0, quickGrade: { skipped: "not asked (add --grade)" } };
  let box: Sandbox | null = null, patch = "";
  try {
    box = await o.backend.start(x.image, { platform: o.platform, timeoutSec: o.timeoutSec });
    const head = await box.exec(`git rev-parse HEAD 2>/dev/null`, { cwd: TESTBED, timeoutSec: 60 });
    rep.headMatchesBase = head.code === 0 ? head.out.trim().split(/\s+/).pop() === x.base_commit : null;
    // The official images can hold untracked build output in /testbed (for example build/ from installing the package).
    // Those files are listed now and left out of the patch later, so the patch holds only what the tool changed.
    const pre = await box.exec(PRE_UNTRACKED, { cwd: TESTBED, timeoutSec: 120 });
    if (pre.code !== 0) throw new Error("could not list the files already in /testbed: " + pre.out.slice(-300));
    if (o.tool === "gold" || o.tool === "noop") {
      if (o.tool === "gold") {
        if (!x.patch) throw new Error("this dataset row has no reference patch, so the gold pseudo-tool cannot run");
        await uploadText(box, "gold.patch", x.patch, "/tmp/gold.patch");
        const t0 = Date.now(); const r = await box.exec("git apply -v /tmp/gold.patch", { cwd: TESTBED, timeoutSec: 120 });
        rep.toolExit = r.code; rep.toolSeconds = Math.round((Date.now() - t0) / 1000);
      } else rep.toolExit = 0;
    } else {
      const ad = o.adapter!;
      if (!o.skipInstall) {
        for (const u of ad.containerUpload || []) await box.upload(u.local, u.remote);
        for (const line of ad.containerInstall || []) {
          const r = await box.exec(line, { timeoutSec: 900 });
          if (r.code !== 0) throw new Error(`installing ${ad.label} in the container failed (${line}): ${r.out.trim().slice(-400)}`);
        }
      }
      const c = ad.command({ prompt: promptFor(x, TESTBED), cwd: TESTBED, model: o.model, limits: { timeSec: o.timeoutSec }, inContainer: true });
      const envLine = Object.entries(c.env || {}).map(([k, v]) => `export ${k}=${q(v)}; `).join("");
      const t0 = Date.now();
      const r = await box.exec(envLine + c.cmd.map(q).join(" "), { cwd: TESTBED, timeoutSec: o.timeoutSec, env: ad.authEnv });
      rep.toolSeconds = Math.round((Date.now() - t0) / 1000); rep.toolExit = r.code; rep.toolTimedOut = r.timedOut;
      writeFileSync(join(o.logDir, x.instance_id + ".tool.txt"), r.out);
      const u = ad.parse(r.out, "");
      rep.tokens = { input: u.inputTokens, output: u.outputTokens, total: u.totalTokens }; rep.costUsd = u.costUsd;
    }
    const d = await box.exec(diffCommand(x.base_commit), { cwd: TESTBED, timeoutSec: 120 });
    if (d.code !== 0) throw new Error("git diff in the container failed: " + d.out.slice(-300));
    patch = d.out; rep.patchBytes = Buffer.byteLength(patch);
  } catch (e: any) { rep.error = String(e?.message || e); }
  finally { if (box) await box.stop().catch(() => {}); }
  return { patch, report: rep };
}

/** The quick local grade: a FRESH container, the patch applied the way the harness applies it, the row's eval_script run. */
export async function quickGrade(x: Instance, patch: string, o: InstanceOpts): Promise<InstanceReport["quickGrade"]> {
  if (!x.eval_script) return { skipped: "this dataset row has no eval_script (the classic princeton-nlp format); grade with the official harness" };
  if (!patch.trim()) return { skipped: "empty patch: nothing to grade (counts as not resolved)" };
  const box = await o.backend.start(x.image, { platform: o.platform, timeoutSec: o.timeoutSec });
  try {
    await uploadText(box, "model.patch", patch, "/tmp/model.patch");
    await uploadText(box, "eval.sh", x.eval_script, "/tmp/eval.sh");
    // The same order of attempts as the harness (run_evaluation.py): git apply, then git apply --3way, then patch --fuzz.
    const a = await box.exec("git apply --verbose /tmp/model.patch || git apply --verbose --3way /tmp/model.patch || patch --batch --forward --fuzz=5 -p1 -i /tmp/model.patch", { cwd: TESTBED, timeoutSec: 300 });
    if (a.code !== 0) return { ...grade("", x.FAIL_TO_PASS, x.PASS_TO_PASS, x.log_parser), applied: false, note: "the patch did not apply: " + a.out.trim().slice(-300) };
    const r = await box.exec("bash /tmp/eval.sh", { cwd: TESTBED, timeoutSec: o.timeoutSec });
    writeFileSync(join(o.logDir, x.instance_id + ".eval.txt"), r.out);
    return { ...grade(r.out, x.FAIL_TO_PASS, x.PASS_TO_PASS, x.log_parser), applied: true, note: r.timedOut ? "the tests hit the time limit" : "quick local grade (not the official harness)" };
  } finally { await box.stop().catch(() => {}); }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const arg = (k: string, d = "") => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
  const has = (k: string) => argv.includes(k);
  if (has("--help") || !arg("--dataset")) { console.log(require("node:fs").readFileSync(import.meta.path, "utf8").split("\n").filter((l: string) => l.startsWith("//")).map((l: string) => l.slice(3)).join("\n")); return arg("--dataset") ? 0 : 2; }
  const all = readDataset(arg("--dataset"));
  const picked = select(all, { ids: arg("--ids").split(",").filter(Boolean), n: arg("--n") ? +arg("--n") : undefined, seed: +arg("--seed", "42") });
  if (!picked.length) { console.error("No instances selected."); return 2; }
  const tool = arg("--tool");
  const pseudo = tool === "gold" || tool === "noop";
  if (!tool) { console.error("Say which tool: --tool syok|claude|codex|cursor (or gold / noop to check the pipeline)."); return 2; }
  const adapter = pseudo ? undefined : getAdapter(tool);
  const model = pseudo ? tool : arg("--model");
  if (!model) { console.error("Pin the model: --model <name> (the same model for every tool you compare)."); return 2; }
  if (adapter) {
    for (const w of [...adapter.unverified, ...(has("--skip-install") ? [] : adapter.containerUnverified || [])]) console.log("WARNING (UNVERIFIED): " + w);
    if (!adapter.containerInstall?.length && !has("--skip-install")) { console.error(`${adapter.label} has no container install steps; use --skip-install with an image that already has it.`); return 2; }
    const per = +arg("--cost-per-instance", "2"), est = per * picked.length, cap = +arg("--max-spend", "5");
    console.log(`Plan: ${picked.length} instance(s) with ${adapter.label} (${model}). Worst case about $${est.toFixed(2)} at $${per} per instance.`);
    if (est > cap && !has("--yes")) { console.error(`That is more than --max-spend $${cap}. These runs spend real money. Add --yes to go ahead.`); return 4; }
    for (const n of adapter.authEnv || []) if (process.env[n]) console.log(`Passing ${n} into the container (by name; the value is not printed).`);
  }
  const backend = arg("--backend", "docker") === "modal" ? modalBackend() : dockerBackend();
  const problem = await backend.problem();
  if (problem) { console.error(problem); return 5; }
  const timeoutSec = +arg("--timeout", "1800");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = resolve(arg("--out", join(import.meta.dir, "out")), `${stamp}-${tool}`);
  const logDir = join(out, "logs"); mkdirSync(logDir, { recursive: true });
  const predFile = join(out, "predictions.jsonl");
  const reports: InstanceReport[] = [];
  const o: InstanceOpts = { backend, tool, adapter, model, timeoutSec, doGrade: has("--grade"), platform: arg("--platform") || undefined, skipInstall: has("--skip-install"), logDir };
  const modelName = pseudo ? tool : `${tool}__${model}`;
  for (const x of picked) {
    console.log(`${x.instance_id}: image ${x.image}${x.imageFromRow ? "" : " (name built from the official rule; the row has no image field)"}`);
    const { patch, report } = await solveInstance(x, o);
    appendFileSync(predFile, predictionLine(x.instance_id, modelName, patch) + "\n");
    if (o.doGrade && !report.error) { try { report.quickGrade = await quickGrade(x, patch, o); } catch (e: any) { report.quickGrade = { skipped: "quick grade failed: " + String(e?.message || e) }; } }
    reports.push(report);
    const g: any = report.quickGrade;
    console.log(`  patch ${report.patchBytes} bytes, tool ${report.toolSeconds}s${report.toolTimedOut ? " (TIMED OUT)" : ""}${report.error ? ", ERROR " + report.error.slice(0, 300) : ""}${"resolved" in g ? `, quick grade: ${g.resolved ? "RESOLVED" : "not resolved"} (FAIL_TO_PASS ${g.failToPass.passed}/${g.failToPass.total}, PASS_TO_PASS ${g.passToPass.passed}/${g.passToPass.total})` : g.skipped ? ", quick grade skipped: " + g.skipped : ""}`);
  }
  writeFileSync(join(out, "report.json"), JSON.stringify({ tool, model, backend: backend.name, gradedBy: o.doGrade ? "quick local grade only (NOT the official harness)" : "not graded", reports }, null, 2));
  console.log(`\nWrote ${predFile}\n      ${join(out, "report.json")}\n` +
    `This is NOT an official score. Grade the predictions with the official harness (see bench/README.md):\n` +
    `  swebench eval verified -p ${predFile} --run-id ${stamp} -j 4\n  (older harness: python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified --predictions_path ${predFile} --max_workers 4 --run_id ${stamp})`);
  return 0;
}
if (import.meta.main) process.exit(await main());
