#!/usr/bin/env bun
// Run a coding tool on SWE-bench-style instances, one container per instance, and write predictions.jsonl in the format the
// OFFICIAL SWE-bench harness grades. Beginner guide: bench/README.md (section "SWE-bench").
//   bun bench/swebench/run.ts --dataset verified.jsonl --n 5 --seed 42 --tool syok --model <model> [--backend docker|modal] [--grade] [--yes]
//   bun bench/swebench/run.ts --dataset verified.jsonl --ids astropy__astropy-12907 --tool gold --grade     check the pipeline (no AI, no cost)
// Tools: syok, claude, codex, cursor; syok-direct (Syok Code with SYOK_BASE_URL=https://api.anthropic.com, see lane.ts); and two
// pseudo-tools that spend nothing: gold (applies the dataset's reference fix) and noop.
// Options: --timeout <sec per instance, default 1800>  --out <folder, default bench/swebench/out>  --platform linux/amd64
//          --max-spend <usd, default 5>  --cost-per-instance <usd, default 2>  --skip-install (the tool is already in the image)
//          --max-steps <n> (passed to tools that can stop themselves after n steps: Syok Code, Claude Code)
//          --no-web (the tool gets no web search or web fetch)  --same-model (mark every instance where a model other than
//          --model answered)  --label <name> (names the output folder and predictions; default the tool)  --run <n> (repeat number)
// Spending: before starting, the plan's worst case (--cost-per-instance x instances) must be within --max-spend (or --yes).
// While running, the money used so far (the tool's own number, else bench/prices.json) is added up, and no new instance is
// started once it reaches --max-spend. When a tool reports no money amount and no price matches, the live total is "unknown":
// then only the time limit and --max-steps bound the run, and the results say so.
// Output: predictions.jsonl, results.json (report.json is the same file, kept for older readers), results.md (the table).
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { q } from "../lib/proc.ts";
import { getAdapter } from "../adapters/index.ts";
import type { Adapter } from "../adapters/types.ts";
import { readDataset, select, predictionLine, promptFor, type Instance } from "./dataset.ts";
import { dockerBackend, modalBackend, type Backend, type Sandbox } from "./backends.ts";
import { grade, type Grade } from "./grade.ts";
import { loadPrices, type Prices } from "../lib/bench.ts";
import { adapterOf, ANTHROPIC_BASE, runAsCommand, giveFolderCommand, takeBackFolderCommand, stopUserProcessesCommand, sameModel } from "./lane.ts";

export interface InstanceReport {
  instance_id: string; image: string; tool: string; model: string;
  headMatchesBase: boolean | null;
  /** Files in /testbed that already differed from the dataset's base commit before the tool ran (never in the patch). */
  imageChangedFiles?: number | null;
  toolExit: number | null; toolTimedOut: boolean; toolSeconds: number;
  tokens: { input: number | null; output: number | null; total: number | null }; costUsd: number | null;
  /** Of tokens.input, how many were read from the prompt cache (only when the tool says so: Claude Code). */
  cacheReadTokens?: number | null;
  /** Where costUsd came from: the tool itself, bench/prices.json, bench/prices.json for the pinned model because the tool
   *  named no model (prices-assumed, labelled so), or nobody (unknown; never guessed). */
  costSource?: "tool" | "prices" | "prices-assumed" | "unknown" | "none";
  /** The tool's version inside the container (its adapter's containerVersion line). */
  toolVersion?: string;
  /** --same-model: true = only the pinned model answered, false = another model answered (otherModels), null = the tool
   *  named no model, so it is not confirmed. */
  sameModel?: boolean | null;
  otherModels?: string[];
  /** Which "<provider> / <model>" answered, with its share of steps and tokens (only what the tool itself reported). */
  modelsSeen?: string[];
  byModel?: Record<string, { steps: number; input: number; output: number }>;
  /** The tool's own notes that the provider changed during the run (Syok Code prints "(switched provider: a -> b)"). */
  switches?: string[];
  steps?: number | null;
  patchBytes: number;
  quickGrade: (Grade & { applied: boolean; note: string }) | { skipped: string };
  /** One word for the result: resolved, no-patch, did-not-apply, wrong-patch, timeout, error, not-graded. */
  outcome?: string;
  error?: string;
}
export interface InstanceOpts { backend: Backend; tool: string; adapter?: Adapter; model: string; timeoutSec: number; maxSteps?: number; doGrade: boolean; platform?: string; skipInstall?: boolean; logDir: string; prices?: Prices;
  /** No web search or web fetch for the tool. */ noWeb?: boolean;
  /** Check that only --model answered (the same-model lanes). */ sameModelCheck?: boolean }

/** Cost of one run: the tool's own number; else every answering model priced from bench/prices.json; else, only when the
 *  tool named NO model and a pinned model is given (the same-model lanes), its tokens priced as that model and labelled
 *  "prices-assumed"; else unknown. */
export function instanceCost(u: { costUsd: number | null; byModel?: Record<string, { input: number; output: number }>; inputTokens?: number | null; outputTokens?: number | null }, prices: Prices, assumeModel?: string): { usd: number | null; source: "tool" | "prices" | "prices-assumed" | "unknown" } {
  if (u.costUsd !== null) return { usd: u.costUsd, source: "tool" };
  const by = Object.entries(u.byModel || {});
  const keys = Object.keys(prices).sort((a, b) => b.length - a.length);
  if (!by.length && assumeModel && prices[assumeModel] && typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
    const p = prices[assumeModel];
    return { usd: (u.inputTokens * (p.in ?? 0) + u.outputTokens * (p.out ?? 0)) / 1e6, source: "prices-assumed" };
  }
  if (!by.length || !keys.length) return { usd: null, source: "unknown" };
  let usd = 0;
  for (const [name, b] of by) {
    const k = keys.find((x) => name.toLowerCase().includes(x.toLowerCase()));
    if (!k) return { usd: null, source: "unknown" }; // one unpriced model makes the whole run unknown
    usd += (b.input * (prices[k].in ?? 0) + b.output * (prices[k].out ?? 0)) / 1e6;
  }
  return { usd, source: "prices" };
}
/** One word for what happened (a run counts as solved only when the quick grade says RESOLVED). */
export function outcomeOf(r: InstanceReport): string {
  const g: any = r.quickGrade;
  if (g && "resolved" in g && g.resolved) return "resolved";
  if (r.error) return "error";
  if (r.toolTimedOut) return "timeout";
  if (!r.patchBytes) return "no-patch";
  if (g && "resolved" in g) return g.applied ? "wrong-patch" : "did-not-apply";
  return "not-graded";
}
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
/** The Markdown table for results.md and the GitHub job summary. */
export function resultsTable(meta: { tool: string; model: string; backend: string; gradedBy: string; maxSpendUsd?: number; spentUsd: number | null; stoppedEarly?: string; label?: string }, reports: InstanceReport[]): string {
  const resolved = reports.filter((r) => r.outcome === "resolved").length;
  const fmtTok = (n: number | null) => (n === null ? "unknown" : String(n));
  const money = (r: InstanceReport) => (r.costUsd === null ? (r.costSource === "none" ? "$0" : "unknown") : "$" + r.costUsd.toFixed(4) + (r.costSource === "prices" ? " (est.)" : r.costSource === "prices-assumed" ? " (est., model not reported)" : ""));
  const tok = (r: InstanceReport) => `${fmtTok(r.tokens.input)} / ${fmtTok(r.tokens.output)}` + (typeof r.cacheReadTokens === "number" ? ` (cache reads ${r.cacheReadTokens} of the input)` : "");
  const same = (r: InstanceReport) => (r.sameModel === false ? ` **OTHER MODEL ANSWERED: ${(r.otherModels || []).join(", ")}**` : r.sameModel === null ? " (model not confirmed: the tool named none)" : "");
  const L = [
    `### SWE-bench Verified pilot: ${meta.tool}${meta.tool === meta.model ? "" : " (model asked: " + meta.model + ")"}${meta.label && meta.label !== meta.tool ? " [" + meta.label + "]" : ""}`,
    "",
    `**${resolved}/${reports.length} resolved: quick-grade, not official.** Graded by: ${meta.gradedBy}. Backend: ${meta.backend}.`,
    "",
    "| Instance | Outcome | Patch bytes | FAIL_TO_PASS | PASS_TO_PASS | Tool time (s) | Tokens in / out | Cost | Models that answered | Note |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of reports) {
    const g: any = r.quickGrade;
    const f2p = "resolved" in g ? `${g.failToPass.passed}/${g.failToPass.total}` : "-", p2p = "resolved" in g ? `${g.passToPass.passed}/${g.passToPass.total}` : "-";
    const models = r.byModel && Object.keys(r.byModel).length ? Object.entries(r.byModel).map(([k, v]) => `${k} (${v.steps} steps)`).join("; ") : (r.modelsSeen || []).join("; ") || (r.tool === "gold" || r.tool === "noop" ? "none (no AI)" : "not reported");
    const note = r.error ? r.error.slice(0, 200) : "skipped" in g ? g.skipped : g.applied ? g.note : g.note.slice(0, 200);
    L.push(`| ${r.instance_id} | ${r.outcome} | ${r.patchBytes} | ${f2p} | ${p2p} | ${r.toolSeconds}${r.toolTimedOut ? " (time limit)" : ""} | ${tok(r)} | ${money(r)} | ${cell(models + same(r))} | ${cell(note)}${r.switches?.length ? " Provider switches: " + r.switches.length + "." : ""} |`);
  }
  L.push("", `Money used: ${meta.spentUsd === null ? "unknown (the tool reports no money amount and bench/prices.json has no matching price)" : "$" + meta.spentUsd.toFixed(4)}` +
    (meta.maxSpendUsd !== undefined ? `; cap $${meta.maxSpendUsd}` : "") + (meta.stoppedEarly ? `. STOPPED EARLY: ${meta.stoppedEarly}` : "") + ".",
    "", "The quick grade is a simplified copy of the official SWE-bench log readers, not the official harness. Only the official harness gives a real score.");
  return L.join("\n") + "\n";
}

const TESTBED = "/testbed";
// The patch is the difference between two snapshots of /testbed: one taken BEFORE the tool starts and one AFTER it stops.
// Each snapshot is a git tree written through a separate index file (GIT_INDEX_FILE), so the repository's own index, HEAD
// and branches are not touched. Why not "git diff <base_commit>": some official images already differ from the base commit
// before anyone works in them (the sphinx images edit tox.ini during setup; found when the noop pseudo-tool produced a
// 1314-byte patch on sphinx-doc__sphinx-7757 in run 45146868789). Those edits are part of the image the harness applies the
// patch to, so they must not be in the patch. Untracked files already in the image (build output) are in both snapshots too.
export const PRE_SNAPSHOT =
  "rm -f /tmp/syok-pre.idx && GIT_INDEX_FILE=/tmp/syok-pre.idx git add -A . >/dev/null 2>&1 && GIT_INDEX_FILE=/tmp/syok-pre.idx git write-tree > /tmp/syok-pre-tree.txt && test -s /tmp/syok-pre-tree.txt";
/** A safe folder or file path for a git ":(exclude)" pathspec (relative, no "..", plain characters only). */
const SAFE_PATH = /^(?!.*\.\.)[A-Za-z0-9._-][A-Za-z0-9._\/-]*$/;
/** Everything the tool changed: tracked or untracked, committed or not, compared with the snapshot taken before it ran.
 *  `exclude` = the tool's own bookkeeping folders (its adapter's patchExclude, for example Syok Code's .syok/ with its
 *  saved chats), which are never part of the fix and never go into predictions.jsonl. */
export const diffCommand = (exclude: string[] = []) => {
  for (const p of exclude) if (!SAFE_PATH.test(p)) throw new Error(`patchExclude path not allowed: ${p}`);
  const spec = exclude.length ? " -- . " + exclude.map((p) => `':(exclude)${p.replace(/\/+$/, "")}'`).join(" ") : "";
  return "rm -f /tmp/syok-post.idx && GIT_INDEX_FILE=/tmp/syok-post.idx git add -A . >/dev/null 2>&1 && post=$(GIT_INDEX_FILE=/tmp/syok-post.idx git write-tree) && git diff --binary \"$(cat /tmp/syok-pre-tree.txt)\" \"$post\"" + spec;
};
/** How many files in /testbed already differed from the dataset's base commit before the tool ran (the image's own setup
 *  edits, or an image whose HEAD is not the base commit). Recorded only; these differences are never in the patch. */
export const imageChangesCommand = (base: string) => `git diff --name-only ${/^[0-9a-f]{7,40}$/.test(base) ? base : "HEAD"} 2>/dev/null | wc -l`;
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
    // The snapshot before the tool runs (see PRE_SNAPSHOT): the patch will hold only what the tool changed.
    const ic = await box.exec(imageChangesCommand(x.base_commit), { cwd: TESTBED, timeoutSec: 120 });
    rep.imageChangedFiles = ic.code === 0 ? Number(ic.out.trim().split(/\s+/).pop()) || 0 : null;
    const pre = await box.exec(PRE_SNAPSHOT, { cwd: TESTBED, timeoutSec: 600 });
    if (pre.code !== 0) throw new Error("could not take the snapshot of /testbed before the tool ran: " + pre.out.slice(-300));
    if (o.tool === "gold" || o.tool === "noop") {
      rep.costUsd = 0; rep.costSource = "none"; // no AI is called
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
      const c = ad.command({ prompt: promptFor(x, TESTBED), cwd: TESTBED, model: o.model, limits: { timeSec: o.timeoutSec, ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}) }, inContainer: true, ...(o.noWeb ? { noWeb: true } : {}) });
      const envLine = Object.entries(c.env || {}).map(([k, v]) => `export ${k}=${q(v)}; `).join("");
      // A tool that must not run as root (Claude Code) runs as its own user, who owns /testbed only while the tool runs.
      const asUser = (line: string) => (ad.runAs ? runAsCommand(line, ad.runAs.user, ad.runAs.home) : line);
      if (ad.containerVersion) { const v = await box.exec(asUser(ad.containerVersion), { cwd: TESTBED, timeoutSec: 120 }); rep.toolVersion = v.code === 0 ? v.out.trim().split(/\r?\n/).pop()!.slice(0, 100) : "unknown"; }
      if (ad.runAs) {
        const g = await box.exec(giveFolderCommand(TESTBED, ad.runAs.user), { timeoutSec: 600 });
        if (g.code !== 0) throw new Error(`could not give ${TESTBED} to the user ${ad.runAs.user}: ` + g.out.trim().slice(-300));
      }
      const t0 = Date.now();
      const r = await box.exec(asUser(envLine + c.cmd.map(q).join(" ")), { cwd: TESTBED, timeoutSec: o.timeoutSec, env: ad.authEnv });
      rep.toolSeconds = Math.round((Date.now() - t0) / 1000); rep.toolExit = r.code; rep.toolTimedOut = r.timedOut;
      if (ad.runAs) {
        await box.exec(stopUserProcessesCommand(ad.runAs.user), { timeoutSec: 60 });
        const b = await box.exec(takeBackFolderCommand(TESTBED), { timeoutSec: 600 });
        if (b.code !== 0) throw new Error(`could not give ${TESTBED} back to its owner after the run: ` + b.out.trim().slice(-300));
      }
      writeFileSync(join(o.logDir, x.instance_id + ".tool.txt"), r.out);
      const u = ad.parse(r.out, "");
      rep.tokens = { input: u.inputTokens, output: u.outputTokens, total: u.totalTokens };
      rep.modelsSeen = u.modelsSeen; if (u.byModel) rep.byModel = u.byModel; rep.steps = u.steps;
      if (u.cacheReadTokens !== undefined) rep.cacheReadTokens = u.cacheReadTokens;
      if (o.sameModelCheck) { const sm = sameModel(u.modelsSeen, o.model); rep.sameModel = sm.ok; rep.otherModels = sm.others; }
      rep.switches = r.out.split(/\r?\n/).filter((l) => /switched provider/i.test(l)).map((l) => l.trim().slice(0, 300)).slice(0, 50);
      const cost = instanceCost({ costUsd: u.costUsd, byModel: u.byModel, inputTokens: u.inputTokens, outputTokens: u.outputTokens }, o.prices || {}, o.sameModelCheck ? o.model : undefined);
      rep.costUsd = cost.usd; rep.costSource = cost.source;
    }
    const d = await box.exec(diffCommand(o.adapter?.patchExclude || []), { cwd: TESTBED, timeoutSec: 600 });
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
  if (!tool) { console.error("Say which tool: --tool syok|syok-direct|claude|codex|cursor (or gold / noop to check the pipeline)."); return 2; }
  const adapter = pseudo ? undefined : getAdapter(adapterOf(tool));
  if (tool === "syok-direct" && (process.env.SYOK_BASE_URL || "").replace(/\/+$/, "") !== ANTHROPIC_BASE) {
    console.error(`syok-direct runs Syok Code straight against Anthropic: set SYOK_BASE_URL=${ANTHROPIC_BASE} and SYOK_API_KEY to an Anthropic API key for this run.`); return 2;
  }
  const runNo = arg("--run") ? +arg("--run") : null;
  if (runNo !== null && !(Number.isInteger(runNo) && runNo >= 1)) { console.error("--run must be a whole number from 1."); return 2; }
  const label = arg("--label", tool);
  if (!/^[A-Za-z0-9_.-]+$/.test(label)) { console.error("--label: letters, digits, _ . - only."); return 2; }
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
  const out = resolve(arg("--out", join(import.meta.dir, "out")), `${stamp}-${label}${runNo !== null ? "-run" + runNo : ""}`);
  const logDir = join(out, "logs"); mkdirSync(logDir, { recursive: true });
  const predFile = join(out, "predictions.jsonl");
  const reports: InstanceReport[] = [];
  const maxSteps = arg("--max-steps") ? +arg("--max-steps") : undefined;
  const cap = +arg("--max-spend", "5");
  const o: InstanceOpts = { backend, tool, adapter, model, timeoutSec, maxSteps, doGrade: has("--grade"), platform: arg("--platform") || undefined, skipInstall: has("--skip-install"), logDir, prices: loadPrices(join(import.meta.dir, "..", "prices.json")),
    noWeb: has("--no-web"), sameModelCheck: has("--same-model") && !pseudo };
  const modelName = pseudo ? tool : `${label}__${model}`;
  let spent: number | null = 0, stoppedEarly = "";
  const notRun: string[] = [];
  for (const x of picked) {
    if (spent !== null && spent >= cap) { notRun.push(x.instance_id); stoppedEarly ||= `the money used ($${spent.toFixed(4)}) reached --max-spend $${cap}; instances not started: `; continue; }
    console.log(`${x.instance_id}: image ${x.image}${x.imageFromRow ? "" : " (name built from the official rule; the row has no image field)"}`);
    const { patch, report } = await solveInstance(x, o);
    appendFileSync(predFile, predictionLine(x.instance_id, modelName, patch) + "\n");
    if (o.doGrade && !report.error) { try { report.quickGrade = await quickGrade(x, patch, o); } catch (e: any) { report.quickGrade = { skipped: "quick grade failed: " + String(e?.message || e) }; } }
    report.outcome = outcomeOf(report);
    reports.push(report);
    if (report.costUsd === null) { if (spent !== null) console.log("  The money used is unknown (the tool reports none and no price matches): from now on only the time limit and --max-steps bound the run."); spent = null; }
    else if (spent !== null) spent += report.costUsd;
    const g: any = report.quickGrade;
    console.log(`  patch ${report.patchBytes} bytes, tool ${report.toolSeconds}s${report.toolTimedOut ? " (TIMED OUT)" : ""}${report.error ? ", ERROR " + report.error.slice(0, 300) : ""}${"resolved" in g ? `, quick grade: ${g.resolved ? "RESOLVED" : "not resolved"} (FAIL_TO_PASS ${g.failToPass.passed}/${g.failToPass.total}, PASS_TO_PASS ${g.passToPass.passed}/${g.passToPass.total})` : g.skipped ? ", quick grade skipped: " + g.skipped : ""}` +
      (report.modelsSeen?.length ? `; answered by: ${report.modelsSeen.join(", ")}` : "") + (report.sameModel === false ? ` (OTHER MODEL ANSWERED: ${report.otherModels!.join(", ")})` : ""));
  }
  if (notRun.length) { stoppedEarly += notRun.join(", "); console.log("STOPPED EARLY: " + stoppedEarly); }
  const gradedBy = o.doGrade ? "quick local grade only (NOT the official harness)" : "not graded";
  const result = { tool, lane: label, run: runNo, model, backend: backend.name, gradedBy, maxSteps: maxSteps ?? null, timeoutSec, noWeb: o.noWeb === true, sameModelCheck: o.sameModelCheck === true,
    maxSpendUsd: cap, spentUsd: spent, stoppedEarly: stoppedEarly || null, notRun,
    resolved: reports.filter((r) => r.outcome === "resolved").length, total: reports.length, reports };
  writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(out, "report.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(out, "results.md"), resultsTable({ tool, model, backend: backend.name, gradedBy, maxSpendUsd: pseudo ? undefined : cap, spentUsd: spent, stoppedEarly, label: label + (runNo !== null ? " run " + runNo : "") }, reports));
  console.log(`\nWrote ${predFile}\n      ${join(out, "results.json")}\n      ${join(out, "results.md")}\n` +
    `This is NOT an official score. Grade the predictions with the official harness (see bench/README.md):\n` +
    `  swebench eval verified -p ${predFile} --run-id ${stamp} -j 4\n  (older harness: python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Verified --predictions_path ${predFile} --max_workers 4 --run_id ${stamp})`);
  return 0;
}
if (import.meta.main) process.exit(await main());
