#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent, makeCtx, undoAll, type Msg } from "./agent.ts";
import { pickProfile } from "./profiles.ts";
import type { Mode } from "./perm.ts";

function arg(n: string, d = "") { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const has = (n: string) => process.argv.includes(n);
function readJson(p: string) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }
const HELP = `Syok Code (command line)
Usage:
  syok                       chat in the current folder
  syok -p "fix the failing test"   run one task and print the result
Options:
  --cwd <folder>        project folder (default: current folder)
  --model <name>        model or preset (default: syok-auto)
  --mode <ask|accept-edits|auto>   ask = ask before edits and commands (default)
                        accept-edits = edit freely, ask before other commands
                        auto = run everything except blocked commands
  --profile <name>      tuning profile from profiles.json
  --max-steps <n>       stop after n steps
  --json                print the result as JSON (for tests and scripts)
Setup: set SYOK_BASE_URL (your Syok address) and SYOK_API_KEY (a syk_ key from Syok > Developer API),
or put {"base":"...","key":"..."} in ~/.syok/config.json.
In chat: /undo  /mode <m>  /model <m>  /help  /exit`;
if (has("--help") || has("-h")) { console.log(HELP); process.exit(0); }
const cfg = readJson(join(homedir(), ".syok", "config.json"));
const base = process.env.SYOK_BASE_URL || cfg.base || "", key = process.env.SYOK_API_KEY || cfg.key || "";
if (!base || !key) { console.error("Missing SYOK_BASE_URL or SYOK_API_KEY. Run: syok --help"); process.exit(2); }
const root = resolve(arg("--cwd", process.cwd()));
let model = arg("--model", "syok-auto"), mode = arg("--mode", "ask") as Mode;
const table = existsSync(join(root, "profiles.json")) ? readJson(join(root, "profiles.json")) : {};
const settings = readJson(join(root, ".syok", "settings.json"));
const profile = pickProfile(model, arg("--profile") || undefined, table);
if (arg("--max-steps")) profile.maxSteps = +arg("--max-steps");
const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (what: string, detail: string) => {
  if (!rl) return false;
  const a = (await rl.question(`\nAllow ${what}?\n${detail.slice(0, 500)}\n[y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
};
const log = (s: string) => { if (!has("--json")) console.log(s); };
const ctx = makeCtx(root, mode, ask, settings, profile);
const prompt = arg("-p");
if (prompt) {
  const r = await runAgent({ root, task: prompt, base, key, model, mode, ask, settings, profile, ctx, log });
  if (has("--json")) console.log(JSON.stringify({ summary: r.summary, steps: r.steps, tokens: r.tokens, touched: r.touched, stopped: r.stopped, ranTests: r.ranTests }));
  else console.log("\n" + r.summary + `\n(${r.steps} steps, ${r.tokens} tokens, files changed: ${r.touched.join(", ") || "none"})`);
  rl?.close(); process.exit(r.stopped === "finished" || r.stopped === "answered" ? 0 : 1);
}
if (!rl) { console.error("No task given. Use -p \"task\" or run in a terminal."); process.exit(2); }
console.log(`Syok Code in ${root}  (mode: ${mode}, model: ${model}). Type /help.`);
let history: Msg[] | undefined;
for (;;) {
  const line = (await rl.question("\n> ")).trim();
  if (!line) continue;
  if (line === "/exit" || line === "/quit") break;
  if (line === "/help") { console.log(HELP); continue; }
  if (line === "/undo") { const d = undoAll(ctx); console.log(d.length ? "Restored: " + d.join(", ") : "Nothing to undo."); continue; }
  if (line.startsWith("/mode ")) { mode = line.slice(6).trim() as Mode; ctx.mode = mode; console.log("Mode: " + mode); continue; }
  if (line.startsWith("/model ")) { model = line.slice(7).trim(); console.log("Model: " + model); continue; }
  try {
    const r = await runAgent({ root, task: line, base, key, model, mode, ask, settings, profile, ctx, log, history });
    history = r.messages; console.log("\n" + r.summary + `\n(${r.steps} steps, files changed: ${r.touched.join(", ") || "none"})`);
  } catch (e: any) { console.log("Error: " + e.message); }
}
rl.close();
