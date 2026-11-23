#!/usr/bin/env bun
// The pilot summary: for every run folder under <pilot folder>, the run's own table (results.md) and, per instance, the
// OFFICIAL SWE-bench harness result next to the quick grade. The official result is the one to report.
//   bun bench/swebench/summary.ts <pilot folder>        prints Markdown
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Official = "resolved" | "unresolved" | "empty patch" | "error" | "not graded";
/** The per-instance status from an official harness report (swebench reporting.py: *_ids lists). */
export function officialStatus(rep: any, id: string): Official {
  if (!rep) return "not graded";
  const has = (k: string) => Array.isArray(rep[k]) && rep[k].includes(id);
  if (has("resolved_ids")) return "resolved";
  if (has("empty_patch_ids")) return "empty patch";
  if (has("error_ids")) return "error";
  if (has("unresolved_ids")) return "unresolved";
  return "not graded";
}
export function runSummary(dir: string, name: string): string {
  const L: string[] = [];
  const res = existsSync(join(dir, "results.json")) ? JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) : null;
  const md = existsSync(join(dir, "results.md")) ? readFileSync(join(dir, "results.md"), "utf8") : "";
  const repFile = readdirSync(dir).find((f) => f.endsWith(`.pilot-${name}.json`));
  const rep = repFile ? JSON.parse(readFileSync(join(dir, repFile), "utf8")) : null;
  if (md) L.push(md.trimEnd(), "");
  const reports: any[] = res?.reports || [];
  if (rep) {
    const ok = reports.filter((r) => officialStatus(rep, r.instance_id) === "resolved").length;
    L.push(`**Official SWE-bench harness: ${rep.resolved_instances ?? ok}/${rep.submitted_instances ?? reports.length} resolved** ` +
      `(completed ${rep.completed_instances ?? "?"}, empty patch ${rep.empty_patch_instances ?? "?"}, errors ${rep.error_instances ?? "?"}). This is the result to report.`, "");
  } else L.push(existsSync(join(dir, "official.txt")) ? "Official harness: no report file (see official.txt in the artifact)." : "Official harness: not run.", "");
  if (reports.length) {
    L.push("| Instance | Official harness | Quick grade (not official) | Same answer? |", "|---|---|---|---|");
    for (const r of reports) {
      const off = officialStatus(rep, r.instance_id), quick = r.outcome ?? "?";
      const same = !rep ? "-" : (off === "resolved") === (quick === "resolved") ? "yes" : "**no** (report the official one)";
      L.push(`| ${r.instance_id} | ${off} | ${quick} | ${same} |`);
    }
    L.push("");
  }
  return L.join("\n");
}

// ---------- the per-lane table (the same-model lane: Claude Code vs Syok Code, each run up to 3 times) ----------
export interface RunRow {
  lane: string; run: number | null; tool: string; model: string;
  official: { resolved: number; submitted: number } | null; quick: { resolved: number; total: number };
  steps: number | null; tokensIn: number | null; tokensOut: number | null; cacheReads: number | null;
  models: string[]; otherModelInstances: number; notConfirmedInstances: number; versions: string[];
  wallSec: number; costUsd: number | null; costSources: string[];
}
const sumOrNull = (xs: Array<number | null | undefined>) => (xs.length && xs.every((x) => typeof x === "number") ? (xs as number[]).reduce((a, b) => a + b, 0) : null);
/** One row from one run folder's results.json (and its official harness report, when there is one). */
export function runRow(res: any, rep: any): RunRow {
  const reports: any[] = res?.reports || [];
  const official = rep ? { resolved: reports.filter((r) => officialStatus(rep, r.instance_id) === "resolved").length, submitted: reports.length } : null;
  const cache = reports.map((r) => r.cacheReadTokens).filter((x) => typeof x === "number");
  return {
    lane: res?.lane || res?.tool || "?", run: typeof res?.run === "number" ? res.run : null, tool: res?.tool || "?", model: res?.model || "?",
    official, quick: { resolved: reports.filter((r) => r.outcome === "resolved").length, total: reports.length },
    steps: sumOrNull(reports.map((r) => r.steps)), tokensIn: sumOrNull(reports.map((r) => r.tokens?.input)), tokensOut: sumOrNull(reports.map((r) => r.tokens?.output)),
    cacheReads: cache.length ? cache.reduce((a, b) => a + b, 0) : null,
    models: [...new Set(reports.flatMap((r) => r.modelsSeen || []))].sort(),
    otherModelInstances: reports.filter((r) => r.sameModel === false).length, notConfirmedInstances: reports.filter((r) => r.sameModel === null).length,
    versions: [...new Set(reports.map((r) => r.toolVersion).filter(Boolean))].sort(),
    wallSec: reports.reduce((a, r) => a + (Number(r.toolSeconds) || 0), 0),
    costUsd: sumOrNull(reports.map((r) => r.costUsd)), costSources: [...new Set(reports.map((r) => r.costSource).filter(Boolean))].sort(),
  };
}
/** Where a cost figure comes from, said plainly (Claude Code's own number is its own estimate, not the bill). */
export function costLabel(lane: string, sources: string[]): string {
  if (!sources.length) return "";
  if (sources.every((s) => s === "none")) return "no AI";
  if (sources.includes("unknown")) return "unknown for some instances";
  if (sources.every((s) => s === "tool")) return lane === "claude" ? "Claude Code estimate" : "the tool's own number";
  if (sources.every((s) => s === "prices")) return "computed from bench/prices.json";
  if (sources.every((s) => s === "prices" || s === "prices-assumed")) return "computed from bench/prices.json; the tool did not name the model for some instances";
  return "mixed: " + sources.join(", ");
}
/** Every run, one row each, then one "all runs" row per lane. Pure: the rows go in, Markdown comes out. */
export function laneTable(rows: RunRow[]): string {
  if (!rows.length) return "";
  const n = (x: number | null) => (x === null ? "unknown" : String(x));
  const L = [
    "## Per tool (each run is one row; \"all runs\" adds them up)",
    "",
    "| Lane | Run | Official resolved | Quick grade (not official) | Steps / turns | Tokens in / out | Cache reads (part of in) | Models that answered | Same model? | Version | Tool time (s) | Cost |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const line = (r: RunRow, run: string) => {
    const same = r.otherModelInstances ? `**NO: another model answered in ${r.otherModelInstances} instance(s)**` : r.notConfirmedInstances ? `not confirmed in ${r.notConfirmedInstances} instance(s) (no model named)` : r.models.length ? "yes" : "-";
    const cost = r.costUsd === null ? (r.costSources.includes("none") ? "$0" : "unknown") : `$${r.costUsd.toFixed(4)} (${costLabel(r.lane, r.costSources)})`;
    const off = r.official ? `${r.official.resolved}/${r.official.submitted}` : "not graded";
    L.push(`| ${r.lane} | ${run} | ${off} | ${r.quick.resolved}/${r.quick.total} | ${n(r.steps)} | ${n(r.tokensIn)} / ${n(r.tokensOut)} | ${r.cacheReads === null ? "-" : r.cacheReads} | ${r.models.join(", ") || "not reported"} | ${same} | ${r.versions.join(", ") || "-"} | ${r.wallSec} | ${cost} |`);
  };
  const lanes = [...new Set(rows.map((r) => r.lane))];
  for (const lane of lanes) {
    const rs = rows.filter((r) => r.lane === lane).sort((a, b) => (a.run ?? 0) - (b.run ?? 0));
    for (const r of rs) line(r, r.run === null ? "-" : String(r.run));
    if (rs.length > 1) {
      const add = (k: "steps" | "tokensIn" | "tokensOut" | "costUsd") => sumOrNull(rs.map((r) => r[k]));
      const caches = rs.map((r) => r.cacheReads).filter((x): x is number => x !== null);
      line({
        lane, run: null, tool: rs[0].tool, model: rs[0].model,
        official: rs.every((r) => r.official) ? { resolved: rs.reduce((a, r) => a + r.official!.resolved, 0), submitted: rs.reduce((a, r) => a + r.official!.submitted, 0) } : null,
        quick: { resolved: rs.reduce((a, r) => a + r.quick.resolved, 0), total: rs.reduce((a, r) => a + r.quick.total, 0) },
        steps: add("steps"), tokensIn: add("tokensIn"), tokensOut: add("tokensOut"), cacheReads: caches.length ? caches.reduce((a, b) => a + b, 0) : null,
        models: [...new Set(rs.flatMap((r) => r.models))].sort(), otherModelInstances: rs.reduce((a, r) => a + r.otherModelInstances, 0), notConfirmedInstances: rs.reduce((a, r) => a + r.notConfirmedInstances, 0),
        versions: [...new Set(rs.flatMap((r) => r.versions))].sort(), wallSec: rs.reduce((a, r) => a + r.wallSec, 0), costUsd: add("costUsd"), costSources: [...new Set(rs.flatMap((r) => r.costSources))].sort(),
      }, `**all ${rs.length} runs**`);
    }
  }
  L.push("", "Official resolved is the result to report. Claude Code's cost is its own client-side estimate (docs: agent-sdk/cost-tracking), not the bill; " +
    "Syok Code's cost is its tokens times bench/prices.json. Claude Code uses Anthropic's prompt caching; Syok Code direct goes through Anthropic's OpenAI-compatible endpoint, which has no prompt caching, so its input tokens are all billed at the full input price.", "");
  return L.join("\n") + "\n";
}
function runDirs(root: string): string[] {
  return readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort();
}
export function laneRows(root: string): RunRow[] {
  const rows: RunRow[] = [];
  for (const d of runDirs(root)) {
    const dir = join(root, d);
    if (!existsSync(join(dir, "results.json"))) continue;
    const res = JSON.parse(readFileSync(join(dir, "results.json"), "utf8"));
    const repFile = readdirSync(dir).find((f) => f.endsWith(`.pilot-${d}.json`));
    rows.push(runRow(res, repFile ? JSON.parse(readFileSync(join(dir, repFile), "utf8")) : null));
  }
  return rows;
}
export function pilotSummary(root: string): string {
  if (!existsSync(root)) return "No results.\n";
  const dirs = runDirs(root);
  const rows = laneRows(root);
  return (rows.length > 1 || rows.some((r) => r.run !== null) ? laneTable(rows) + "\n" : "") + dirs.map((d) => runSummary(join(root, d), d)).join("\n") + "\n";
}
if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: bun bench/swebench/summary.ts <pilot folder>"); process.exit(2); }
  process.stdout.write(pilotSummary(root));
}
