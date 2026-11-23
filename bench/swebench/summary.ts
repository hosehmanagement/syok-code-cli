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
export function pilotSummary(root: string): string {
  if (!existsSync(root)) return "No results.\n";
  const dirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort();
  return dirs.map((d) => runSummary(join(root, d), d)).join("\n") + "\n";
}
if (import.meta.main) {
  const root = process.argv[2];
  if (!root) { console.error("usage: bun bench/swebench/summary.ts <pilot folder>"); process.exit(2); }
  process.stdout.write(pilotSummary(root));
}
