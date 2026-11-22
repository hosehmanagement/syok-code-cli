// The comparison orchestrator: the same scenario, the same prompt, the same limits and (in a lane) the same model,
// given to several coding tools one after another, each in a fresh copy of the project. Then the SAME grader decides.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run, sh } from "./proc.ts";
import { type Scenario, DEFAULT_RUN_CAP_USD, materialize, runTests, changedProtected, restoreProtected, capturePatch, overlay } from "./scenario.ts";
import type { Adapter, Usage } from "../adapters/types.ts";

// ---------- models and the fair-test lanes ----------
export type Lane = "claude" | "gpt";
export interface ModelPin { pass: string; canonical: string }
/** "anthropic/Claude_Sonnet.4-5" -> "claude-sonnet-4-5". Used only to compare names, never sent to a tool. */
export function canonical(m: string): string {
  return m.trim().toLowerCase().replace(/^.*\//, "").replace(/[\s._:]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
/** "sonnet-4.5=claude-sonnet-4-5": pass "sonnet-4.5" to the tool, but it IS claude-sonnet-4-5 for the fairness check. */
export function parsePin(spec: string): ModelPin {
  const i = spec.indexOf("=");
  return i > 0 ? { pass: spec.slice(0, i), canonical: canonical(spec.slice(i + 1)) } : { pass: spec, canonical: canonical(spec) };
}
export function laneOf(model: string): Lane | null {
  const c = canonical(model);
  if (c.startsWith("claude")) return "claude";
  if (/^(gpt|o\d|codex)/.test(c)) return "gpt";
  return null;
}
/** The fair-test rule: in a lane every tool must use the same model, and that model must belong to the lane. Returns the reasons to refuse. */
export function laneProblems(lane: Lane, pins: Record<string, ModelPin | undefined>): string[] {
  const why: string[] = [];
  for (const [tool, p] of Object.entries(pins)) {
    if (!p) { why.push(`${tool} has no pinned model. Pass --model <name> (all tools) or --model-${tool} <name>.`); continue; }
    if (laneOf(p.canonical) !== lane) why.push(`${tool} is pinned to "${p.pass}", which is not a ${lane} model, so it cannot run in the ${lane} lane.`);
  }
  const names = [...new Set(Object.values(pins).filter(Boolean).map((p) => p!.canonical))];
  if (names.length > 1) why.push(`The tools are pinned to different models (${Object.entries(pins).map(([t, p]) => `${t}=${p?.pass ?? "none"}`).join(", ")}). ` +
    `The fair test is the same model with a different harness, so every tool must use the same model. If a tool spells the same model differently, write --model-<tool> <its name>=<common name>.`);
  return why;
}
/** Did any model other than the pinned one answer? (from what the tool itself reported) */
export function otherModels(seen: string[], pin: ModelPin): string[] {
  return seen.filter((s) => { const c = canonical(s); return !(c.includes(pin.canonical) || pin.canonical.includes(c)); });
}

// ---------- cost ----------
export type Prices = Record<string, { in?: number; out?: number }>;
export function loadPrices(file: string): Prices {
  if (!existsSync(file)) return {};
  const j = JSON.parse(readFileSync(file, "utf8"));
  return j.prices && typeof j.prices === "object" ? j.prices : {};
}
/** US dollars from the tool's own number, else from bench/prices.json (dollars per million tokens), else unknown. */
export function costOf(u: Usage, pin: ModelPin, prices: Prices): { usd: number | null; source: "tool" | "prices" | "unknown" } {
  if (u.costUsd !== null) return { usd: u.costUsd, source: "tool" };
  const key = Object.keys(prices).sort((a, b) => b.length - a.length).find((k) => pin.canonical.includes(canonical(k)));
  if (key && u.inputTokens !== null && u.outputTokens !== null) {
    const p = prices[key];
    return { usd: (u.inputTokens * (p.in ?? 0) + u.outputTokens * (p.out ?? 0)) / 1e6, source: "prices" };
  }
  return { usd: null, source: "unknown" };
}
/** The most a plan could spend if every run used its whole per-run budget. */
export function estimateSpend(scenarios: Scenario[], tools: number, runs: number): number {
  return scenarios.reduce((n, s) => n + (s.limits.maxCostUsd ?? DEFAULT_RUN_CAP_USD), 0) * tools * runs;
}

// ---------- one run ----------
export interface RunRecord {
  scenario: string; tool: string; label: string; model: string; run: number;
  passed: boolean;            // the grader passed (graded with the ORIGINAL protected tests put back)
  clean: boolean;             // passed, no regressions, no protected test touched, finished in time
  regressions: string[];      // existing test commands that passed before the tool ran and fail after
  testsWeakened: string[];    // protected test files the tool changed or deleted
  timedOut: boolean; toolExit: number | null; toolOk: boolean | null;
  tokens: { input: number | null; output: number | null; total: number | null };
  cost: { usd: number | null; source: string };
  steps: number | null;
  wallSec: number;
  humanInterventions: number; // always 0: every run is headless
  modelsSeen: string[]; otherModels: string[];
  limitsEnforcedByTool: string[];
  patchBytes: number;
  files: { stdout: string; stderr: string; patch: string; grader: string };
  error?: string;
  warnings: string[];
}
export interface RunOpts { adapter: Adapter; toolName: string; pin: ModelPin; runNo: number; prices: Prices; logDir: string; keep?: boolean; dryRun?: boolean }

export async function runOne(sc: Scenario, o: RunOpts): Promise<RunRecord> {
  const work = mkdtempSync(join(tmpdir(), `bench-${sc.id}-${o.toolName}-`));
  const tag = `${sc.id}--${o.toolName}--run${o.runNo}`;
  const f = { stdout: join(o.logDir, tag + ".stdout.txt"), stderr: join(o.logDir, tag + ".stderr.txt"), patch: join(o.logDir, tag + ".patch"), grader: join(o.logDir, tag + ".grader.txt") };
  const rec: RunRecord = { scenario: sc.id, tool: o.toolName, label: o.adapter.label, model: o.pin.pass, run: o.runNo, passed: false, clean: false, regressions: [], testsWeakened: [], timedOut: false, toolExit: null, toolOk: null,
    tokens: { input: null, output: null, total: null }, cost: { usd: null, source: "unknown" }, steps: null, wallSec: 0, humanInterventions: 0, modelsSeen: [], otherModels: [], limitsEnforcedByTool: [], patchBytes: 0, files: f, warnings: [] };
  mkdirSync(o.logDir, { recursive: true });
  try {
    const base = await materialize(sc, work);
    const before = await runTests(sc, work);
    for (const [n, ok] of Object.entries(before)) if (!ok) rec.warnings.push(`existing test "${n}" already failed before the tool ran (not counted as a regression)`);
    const c = o.adapter.command({ prompt: sc.prompt, cwd: work, model: o.pin.pass, limits: sc.limits, scenarioDir: sc.dir });
    rec.limitsEnforcedByTool = c.enforced;
    const r = await run(c.cmd, { cwd: work, timeoutMs: sc.limits.timeSec * 1000, env: c.env, stdin: c.stdin });
    rec.wallSec = Math.round(r.ms / 100) / 10; rec.timedOut = r.timedOut; rec.toolExit = r.code;
    writeFileSync(f.stdout, r.stdout); writeFileSync(f.stderr, r.stderr);
    const u = o.adapter.parse(r.stdout, r.stderr);
    rec.tokens = { input: u.inputTokens, output: u.outputTokens, total: u.totalTokens }; rec.steps = u.steps; rec.toolOk = u.ok;
    rec.cost = costOf(u, o.pin, o.prices);
    rec.modelsSeen = u.modelsSeen; rec.otherModels = otherModels(u.modelsSeen, o.pin);
    if (r.code === 127 && !r.stdout) rec.warnings.push("the tool could not be started: " + r.stderr.trim().slice(0, 200));
    const patch = await capturePatch(work, base);
    writeFileSync(f.patch, patch); rec.patchBytes = Buffer.byteLength(patch);
    rec.testsWeakened = await changedProtected(sc, work, base);
    await restoreProtected(sc, work, base);
    const after = await runTests(sc, work);
    rec.regressions = Object.keys(after).filter((n) => before[n] && !after[n]);
    if (sc.grader.files) overlay(resolve(sc.dir, sc.grader.files), work);
    const g = await sh(sc.grader.command, { cwd: work, timeoutMs: (sc.grader.timeSec ?? 300) * 1000 });
    writeFileSync(f.grader, `$ ${sc.grader.command}\n(exit ${g.code}${g.timedOut ? ", timed out" : ""})\n${g.stdout}\n${g.stderr}`);
    rec.passed = g.code === 0 && !g.timedOut;
    rec.clean = rec.passed && !rec.regressions.length && !rec.testsWeakened.length && !rec.timedOut;
  } catch (e: any) { rec.error = String(e?.message || e); }
  finally { if (!o.keep) try { rmSync(work, { recursive: true, force: true }); } catch {} else rec.warnings.push("project kept at " + work); }
  return rec;
}

// ---------- results ----------
const n = (v: number | null) => (v === null ? "unknown" : v >= 10000 ? Math.round(v / 1000) + "k" : String(v));
const money = (c: { usd: number | null; source: string }) => (c.usd === null ? "unknown" : "$" + (c.usd < 0.01 ? c.usd.toFixed(4) : c.usd.toFixed(2)) + (c.source === "prices" ? " (est.)" : ""));
export function markdown(rows: RunRecord[], meta: { lane?: string; dryRun?: boolean; started: string }): string {
  const out: string[] = [];
  out.push(`# Bench results ${meta.started}`, "");
  if (meta.dryRun) out.push("**Dry run:** every tool was replaced by the fake stand-in tool. These numbers test the bench itself, not any AI tool.", "");
  out.push(meta.lane ? `Lane: **${meta.lane}** (every tool pinned to the same model).` : "No lane: the tools may use different models, so this is NOT a same-model comparison.", "");
  out.push("| Scenario | Tool | Model | Run | Passed | Regressions | Tests weakened | Tokens | Cost | Time (s) | Human help | Notes |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const notes = [r.error ? "ERROR: " + r.error.slice(0, 120) : "", r.timedOut ? "hit the time limit" : "", r.otherModels.length ? "other models answered: " + r.otherModels.join(", ") : ""].filter(Boolean).join("; ");
    out.push(`| ${r.scenario} | ${r.tool} | ${r.model} | ${r.run} | ${r.passed ? "yes" : "no"} | ${r.regressions.length ? r.regressions.length + " (" + r.regressions.join(", ") + ")" : "0"} | ${r.testsWeakened.length ? r.testsWeakened.length + " (" + r.testsWeakened.join(", ") + ")" : "0"} | ${n(r.tokens.total)} | ${money(r.cost)} | ${r.wallSec} | ${r.humanInterventions} | ${notes.replace(/\|/g, "/")} |`);
  }
  out.push("", "## By tool", "", "| Tool | Clean passes | Passed | Regressions | Tests weakened | Total tokens | Total cost | Median time (s) |", "|---|---|---|---|---|---|---|---|");
  for (const t of [...new Set(rows.map((r) => r.tool))]) {
    const rs = rows.filter((r) => r.tool === t), times = rs.map((r) => r.wallSec).sort((a, b) => a - b);
    const tok = rs.every((r) => r.tokens.total !== null) ? n(rs.reduce((s, r) => s + (r.tokens.total ?? 0), 0)) : "unknown";
    const cost = rs.every((r) => r.cost.usd !== null) ? money({ usd: rs.reduce((s, r) => s + (r.cost.usd ?? 0), 0), source: rs.some((r) => r.cost.source === "prices") ? "prices" : "tool" }) : "unknown";
    out.push(`| ${t} | ${rs.filter((r) => r.clean).length}/${rs.length} | ${rs.filter((r) => r.passed).length}/${rs.length} | ${rs.reduce((s, r) => s + r.regressions.length, 0)} | ${rs.reduce((s, r) => s + r.testsWeakened.length, 0)} | ${tok} | ${cost} | ${times[Math.floor((times.length - 1) / 2)] ?? 0} |`);
  }
  out.push("", "Passed = the scenario's grader passed, run with the original protected tests put back. Clean = passed, no regressions, no protected test changed, within the time limit. " +
    "\"unknown\" = the tool did not report it (never guessed). \"(est.)\" = cost worked out from bench/prices.json, not reported by the tool.");
  return out.join("\n") + "\n";
}
