#!/usr/bin/env bun
// Headless comparison of coding tools on the same scenarios. Beginner guide: bench/README.md.
//   bun bench/run.ts --check                                   prove every scenario fails before its fix and passes after it (no AI)
//   bun bench/run.ts --dry-run --tools syok,claude             test the bench itself with a fake tool (spends nothing)
//   bun bench/run.ts --tools syok,claude --lane claude --model <model> [--runs 1] [--yes]
// Options: --scenarios <folder> (default bench/scenarios)  --only id1,id2  --model-<tool> <name>[=<common name>]
//          --max-spend <usd> (default 5)  --out <folder> (default bench/results)  --keep (keep the project folders)
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findScenarios, materialize, runTests, overlay, type Scenario } from "./lib/scenario.ts";
import { sh } from "./lib/proc.ts";
import { type Lane, type ModelPin, parsePin, laneProblems, loadPrices, estimateSpend, runOne, markdown, type RunRecord } from "./lib/bench.ts";
import { getAdapter, REAL_TOOLS } from "./adapters/index.ts";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const has = (k: string) => argv.includes(k);
const say = (s: string) => console.log(s);
const HERE = import.meta.dir;

export async function checkScenarios(scenarios: Scenario[]): Promise<number> {
  let bad = 0;
  for (const sc of scenarios) {
    const problems: string[] = [];
    const a = mkdtempSync(join(tmpdir(), "bench-check-"));
    try {
      await materialize(sc, a);
      const t = await runTests(sc, a);
      for (const [k, ok] of Object.entries(t)) if (!ok) problems.push(`existing test "${k}" fails before any change (it must pass, or regressions cannot be measured)`);
      if (sc.grader.files) overlay(resolve(sc.dir, sc.grader.files), a);
      const g0 = await sh(sc.grader.command, { cwd: a, timeoutMs: (sc.grader.timeSec ?? 300) * 1000 });
      if (g0.code === 0) problems.push("the grader already passes before the fix (the scenario tests nothing)");
    } catch (e: any) { problems.push(String(e.message || e)); }
    finally { rmSync(a, { recursive: true, force: true }); }
    const b = mkdtempSync(join(tmpdir(), "bench-check-"));
    try {
      await materialize(sc, b);
      overlay(join(sc.dir, "solution"), b);
      const t = await runTests(sc, b);
      for (const [k, ok] of Object.entries(t)) if (!ok) problems.push(`existing test "${k}" fails after the known fix`);
      if (sc.grader.files) overlay(resolve(sc.dir, sc.grader.files), b);
      const g1 = await sh(sc.grader.command, { cwd: b, timeoutMs: (sc.grader.timeSec ?? 300) * 1000 });
      if (g1.code !== 0) problems.push("the grader fails even with the known fix in solution/:\n" + (g1.stdout + g1.stderr).slice(-800));
    } catch (e: any) { problems.push(String(e.message || e)); }
    finally { rmSync(b, { recursive: true, force: true }); }
    say(`${problems.length ? "BAD " : "OK  "} ${sc.id}${problems.length ? "\n     " + problems.join("\n     ") : ""}`);
    if (problems.length) bad++;
  }
  say(bad ? `${bad} scenario(s) are broken` : `all ${scenarios.length} scenarios are valid`);
  return bad;
}

async function main(): Promise<number> {
  if (has("--help") || has("-h")) { say(readHelp()); return 0; }
  const scenarios = findScenarios(arg("--scenarios", join(HERE, "scenarios")), arg("--only").split(",").filter(Boolean));
  if (!scenarios.length) { console.error("No scenarios found."); return 2; }
  if (has("--check")) return (await checkScenarios(scenarios)) ? 1 : 0;

  const dryRun = has("--dry-run");
  const tools = arg("--tools", dryRun ? "syok,claude" : "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!tools.length) { console.error("Say which tools to compare: --tools syok,claude,codex,cursor (or --dry-run to test the bench)."); return 2; }
  for (const t of tools) if (!(REAL_TOOLS as readonly string[]).includes(t)) { console.error(`Unknown tool "${t}". Choose from: ${REAL_TOOLS.join(", ")}.`); return 2; }
  const runs = Math.max(1, Math.floor(+arg("--runs", "1")) || 1);
  const lane = arg("--lane") as Lane | "";
  if (lane && lane !== "claude" && lane !== "gpt") { console.error('--lane must be "claude" or "gpt".'); return 2; }

  // Models: --model for all, --model-<tool> to override one tool.
  const pins: Record<string, ModelPin | undefined> = {};
  for (const t of tools) { const s = arg("--model-" + t) || arg("--model"); pins[t] = s ? parsePin(s) : dryRun ? parsePin("fake-model") : undefined; }
  if (lane) {
    const why = laneProblems(lane, pins);
    if (why.length) { console.error(`Refusing to compare in the ${lane} lane:\n  - ` + why.join("\n  - ")); return 3; }
    say(`Lane ${lane}: every tool uses ${Object.values(pins)[0]!.canonical}.`);
  } else {
    for (const t of tools) if (!pins[t]) { console.error(`${t} has no model. Pass --model <name> or --model-${t} <name>.`); return 2; }
    const distinct = new Set(Object.values(pins).map((p) => p!.canonical));
    if (distinct.size > 1) say("Warning: the tools use different models, so this is not a same-model comparison. Use --lane claude or --lane gpt for the fair test.");
  }

  // Money: refuse a big plan without --yes.
  const est = dryRun ? 0 : estimateSpend(scenarios, tools.length, runs);
  const cap = +arg("--max-spend", "5");
  if (!dryRun) {
    say(`Plan: ${scenarios.length} scenario(s) x ${tools.length} tool(s) x ${runs} run(s) = ${scenarios.length * tools.length * runs} runs. Worst case about $${est.toFixed(2)} (each run's limits.maxCostUsd, or $2 when a scenario sets none).`);
    if (est > cap && !has("--yes")) { console.error(`That is more than --max-spend $${cap}. These runs spend real money on your own accounts. Add --yes to go ahead, or lower --runs.`); return 4; }
  }

  // Check every tool before spending anything.
  const adapters: Record<string, ReturnType<typeof getAdapter>> = {};
  for (const t of tools) {
    const ad = getAdapter(dryRun ? "fake" : t); adapters[t] = ad;
    const real = getAdapter(t);
    for (const w of real.unverified) say(`WARNING (UNVERIFIED): ${w}`);
    for (const note of real.notes || []) say(`Note (${t}): ${note}`);
    if (!dryRun) {
      const c = await ad.check();
      say(`${t}: ${c.installed ? "installed " + c.version : "NOT installed"}; ${c.loggedIn === null ? "login unknown" : c.loggedIn ? "logged in" : "NOT logged in"}. ${c.detail}`);
      if (!c.installed || c.loggedIn === false) { console.error(`Fix ${t} first (see bench/README.md), or leave it out of --tools.`); return 5; }
    }
  }

  const started = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(arg("--out", join(HERE, "results")));
  const logDir = join(outDir, started + (dryRun ? "-dry-run" : ""), "logs");
  const prices = loadPrices(join(HERE, "prices.json"));
  const rows: RunRecord[] = [];
  for (const sc of scenarios) for (let r = 1; r <= runs; r++) for (const t of tools) {
    say(`run ${sc.id} / ${t} / ${r} ...`);
    const rec = await runOne(sc, { adapter: adapters[t], toolName: t, pin: pins[t]!, runNo: r, prices, logDir, keep: has("--keep") });
    rows.push(rec);
    say(`  ${rec.passed ? "PASS" : "FAIL"}  regressions=${rec.regressions.length} weakened=${rec.testsWeakened.length} tokens=${rec.tokens.total ?? "unknown"} ${rec.wallSec}s${rec.timedOut ? " TIMED OUT" : ""}${rec.error ? " ERROR " + rec.error.slice(0, 200) : ""}`);
  }
  const meta = { started, lane: lane || undefined, dryRun, tools, runs, models: Object.fromEntries(Object.entries(pins).map(([k, v]) => [k, v?.pass])) };
  const base = join(outDir, started + (dryRun ? "-dry-run" : ""));
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "results.json"), JSON.stringify({ meta, rows }, null, 2));
  const md = markdown(rows, meta);
  writeFileSync(join(base, "results.md"), md);
  say("\n" + md + `\nSaved ${join(base, "results.json")} and results.md (tool logs and patches in ${logDir})`);
  return 0;
}
function readHelp() { return require("node:fs").readFileSync(import.meta.path, "utf8").split("\n").filter((l: string) => l.startsWith("//")).map((l: string) => l.slice(3)).join("\n"); }

if (import.meta.main) process.exit(await main());
