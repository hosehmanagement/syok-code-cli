#!/usr/bin/env bun
// Scores Syok Code on small coding tasks. Usage:
//   bun evals/run.ts --check                      prove every task fails before the fix and passes after it (no AI needed)
//   bun evals/run.ts --model syok-auto --profile default [--tasks js-,py-] [--mode auto]
// Needs SYOK_BASE_URL and SYOK_API_KEY for AI runs.
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runAgent } from "../src/agent.ts";
import { pickProfile } from "../src/profiles.ts";

const arg = (n: string, d = "") => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n: string) => process.argv.includes(n);
const dir = resolve(import.meta.dir, "tasks");
if (!existsSync(dir)) spawnSync("python3", [resolve(import.meta.dir, "make_tasks.py")], { stdio: "inherit" }); // tasks are generated from make_tasks.py
const filter = arg("--tasks").split(",").filter(Boolean);
const ids = readdirSync(dir).filter((d) => !filter.length || filter.some((f) => d.startsWith(f))).sort();
const sh = (cmd: string, cwd: string, secs = 90) => { const r = spawnSync("bash", ["-lc", cmd], { cwd, timeout: secs * 1000, encoding: "utf8" }); return { ok: r.status === 0, out: ((r.stdout || "") + (r.stderr || "")).slice(-1500) }; };
function prep(id: string) {
  const w = mkdtempSync(join(tmpdir(), "ev-" + id + "-"));
  cpSync(join(dir, id, "files"), w, { recursive: true });
  sh("git init -q && git add -A && git -c user.email=e@e -c user.name=e commit -qm init", w);
  return w;
}
const overlay = (id: string, sub: string, w: string) => { const p = join(dir, id, sub); if (existsSync(p)) cpSync(p, w, { recursive: true }); };

if (has("--check")) {
  let bad = 0;
  for (const id of ids) {
    const t = JSON.parse(readFileSync(join(dir, id, "task.json"), "utf8"));
    const a = prep(id); overlay(id, "hidden", a); const before = sh(t.verify, a);
    const b = prep(id); overlay(id, "solution", b); overlay(id, "hidden", b); const after = sh(t.verify, b);
    const good = !before.ok && after.ok; if (!good) bad++;
    console.log(`${good ? "OK  " : "BAD "} ${id}  (fails before: ${!before.ok}, passes after fix: ${after.ok})`);
    if (!good) console.log((before.ok ? "BEFORE passed unexpectedly\n" : "") + (!after.ok ? after.out : ""));
  }
  console.log(bad ? `${bad} task(s) are broken` : `all ${ids.length} tasks are valid`); process.exit(bad ? 1 : 0);
}

const base = process.env.SYOK_BASE_URL || "", key = process.env.SYOK_API_KEY || "";
if (!base || !key) { console.error("Set SYOK_BASE_URL and SYOK_API_KEY (or use --check)."); process.exit(2); }
const model = arg("--model", "syok-auto"), mode = arg("--mode", "auto") as any;
const table = existsSync(resolve(import.meta.dir, "..", "profiles.json")) ? JSON.parse(readFileSync(resolve(import.meta.dir, "..", "profiles.json"), "utf8")) : {};
const profile = pickProfile(model, arg("--profile") || undefined, table);
if (arg("--max-steps")) profile.maxSteps = +arg("--max-steps");
const rows: any[] = [];
for (const id of ids) {
  const t = JSON.parse(readFileSync(join(dir, id, "task.json"), "utf8"));
  const w = prep(id); const t0 = Date.now(); let err = "", r: any = null;
  try { r = await runAgent({ root: w, task: t.prompt, base, key, model, mode, profile, ask: async () => false, log: (s) => { if (/throttled by Cloudflare/.test(s)) console.log("  " + s); } }); } catch (e: any) { err = e.message; }
  overlay(id, "hidden", w); const v = sh(t.verify, w);
  // Who answered: e.g. "claude x6, builtin x2"; plus the failed attempts the router reported before the first answer of the step that changed provider.
  const routes: { provider: string; model: string; attempts: string; details: string }[] = r?.routes ?? [];
  const saidWhy = [...new Set(routes.map((x) => x.details).filter(Boolean))].slice(0, 3).join(" || ");
  const byProvider: Record<string, number> = {}; for (const x of routes) byProvider[x.provider || "?"] = (byProvider[x.provider || "?"] || 0) + 1;
  const via = Object.entries(byProvider).map(([p, n]) => `${p} x${n}`).join(", ");
  const failedAttempts = [...new Set(routes.flatMap((x) => x.attempts.split(",").filter((a) => a && !/:success$/.test(a))))].slice(0, 8).join(",");
  const row = { id, pass: v.ok, steps: r?.steps ?? 0, tokens: r?.tokens ?? 0, secs: Math.round((Date.now() - t0) / 1000), stopped: r?.stopped ?? "error", error: err, ranTests: !!r?.ranTests, via: byProvider, failedAttempts, saidWhy };
  rows.push(row); console.log(`${row.pass ? "PASS" : "FAIL"} ${id}  steps=${row.steps} tokens=${row.tokens} ${row.secs}s ${row.stopped}${via ? "  via " + via : ""}${failedAttempts ? "  (skipped: " + failedAttempts + ")" : ""}${err ? " ERR " + err.slice(0, 400) : ""}`);
  if (saidWhy) console.log("   providers said: " + saidWhy.slice(0, 900));
  if (/daily limit/.test(err)) { console.log("Stopping: the Syok key hit its daily limit, so the remaining tasks were not run."); break; }
  if (!row.pass && !err) console.log("   why: " + (v.out.trim().split("\n").slice(-8).join(" | ").slice(-500)) + "\n   agent said: " + String(r?.summary || "").replace(/\s+/g, " ").slice(0, 300));
}
const passed = rows.filter((r) => r.pass).length;
const summary = { model, profile: profile.name, profileSettings: profile, passed, total: rows.length, rate: +(passed / Math.max(1, rows.length)).toFixed(3), steps: rows.reduce((n, r) => n + r.steps, 0), tokens: rows.reduce((n, r) => n + r.tokens, 0), rows };
mkdirSync("evals/results", { recursive: true });
const out = `evals/results/${new Date().toISOString().replace(/[:.]/g, "-")}-${model.replace(/[^\w.-]/g, "_")}-${profile.name}.json`;
writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`\nScore: ${passed}/${rows.length} (${Math.round(summary.rate * 100)}%)  steps=${summary.steps} tokens=${summary.tokens}\nSaved ${out}`);
