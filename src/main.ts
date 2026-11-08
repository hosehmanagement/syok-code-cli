#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent, makeCtx, undoAll, type Msg } from "./agent.ts";
import { sessionDiff } from "./tools.ts";
import { colorize } from "./diff.ts";
import { startMcp } from "./mcp.ts";
import { buildTask, KINDS, type Kind } from "./tasks.ts";
import { READONLY } from "./tools.ts";
import { pickProfile } from "./profiles.ts";
import type { Mode } from "./perm.ts";

function arg(n: string, d = "") { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const has = (n: string) => process.argv.includes(n);
function readJson(p: string) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }
const HELP = `Syok Code (command line)
Usage:
  syok                       chat in the current folder
  syok -p "fix the failing test"   run one task and print the result
Coding modes (work in 30+ languages, and check their own work):
  syok gen "a function that checks a palindrome" --lang python [--out file]   plain words -> working code
  syok translate utils.py --to go                 same behaviour in another language (new file beside the old one)
  syok debug ["what is wrong"]                    reproduce, find the cause, fix, prove it
  syok explain <file>                             plain-language explanation (read-only)
  syok test <file>                                write and run tests for a file
Options:
  --cwd <folder>        project folder (default: current folder)
  --model <name>        model or preset (default: syok-auto)
  --mode <ask|accept-edits|auto>   ask = ask before edits and commands (default)
                        accept-edits = edit freely, ask before other commands
                        auto = run everything except blocked commands
  --profile <name>      tuning profile from profiles.json
  --max-steps <n>       stop after n steps
  --no-stream           wait for the full answer instead of showing it as it is written
  --json                print the result as JSON (for tests and scripts)
Setup: set SYOK_BASE_URL (your Syok address) and SYOK_API_KEY (a syk_ key from Syok > Developer API),
or put {"base":"...","key":"..."} in ~/.syok/config.json.
In chat: /gen /translate /debug /explain /test (same as above)  /diff (show every change so far)  /undo  /mode <m>  /model <m>  /jobs  /help  /exit
Extras (in <project>/.syok/settings.json):
  "hooks": { "PreToolUse": [{"match":"edit_file|write_file","command":"./check.sh"}], "PostToolUse": [...], "Stop": [{"command":"npm test"}] }
      your command gets the event as JSON on its input; exit code 2 blocks the action (or sends the message back to the AI for Stop)
  "mcpServers": { "name": { "command": "node", "args": ["server.js"] } }   local tool servers (MCP over stdio)
  "allow": ["npm run"], "deny": ["curl"]    command prefixes to always allow / block
The AI can also delegate to helper agents (read-only explorers run in parallel) and run background jobs (dev servers).`;
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
  const a = (await rl.question(`\nAllow ${what}?\n${process.stdout.isTTY ? colorize(detail.slice(0, 1800)) : detail.slice(0, 1800)}\n[y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
};
const log = (s: string) => { if (!has("--json")) console.log(s); };
const ctx = makeCtx(root, mode, ask, settings, profile);
if (settings.mcpServers) ctx.mcp = await startMcp(settings.mcpServers, root, (s) => console.error(s));
const cleanup = () => { ctx.bg.stopAll(); ctx.mcp.forEach((x) => x.stop()); };
process.on("exit", cleanup); process.on("SIGINT", () => { cleanup(); process.exit(130); });
const onToken = !has("--json") && !has("--no-stream") ? (s: string) => process.stdout.write(s) : undefined;
const VALUE_FLAGS = new Set(["--lang", "--to", "--out", "--cwd", "--model", "--mode", "--profile", "--max-steps", "-p"]);
function words(s: string) { return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^(["'])(.*)\1$/, "$2")); }
function modeTask(kind: Kind, toks: string[]) {
  const pos: string[] = []; const f: Record<string, string> = {};
  for (let i = 0; i < toks.length; i++) { if (VALUE_FLAGS.has(toks[i])) { f[toks[i]] = toks[++i] || ""; } else if (!toks[i].startsWith("--")) pos.push(toks[i]); }
  const a = kind === "gen" || kind === "debug" ? { text: pos.join(" "), lang: f["--lang"], out: f["--out"] }
    : { file: pos[0], text: pos.slice(1).join(" ") || (kind === "explain" ? pos.join(" ") : ""), to: f["--to"] || pos[1], lang: f["--lang"], out: f["--out"] };
  if (kind === "explain" && pos.length > 1) { a.file = existsSync(join(root, pos[0])) ? pos[0] : undefined; a.text = a.file ? "" : pos.join(" "); }
  return buildTask(kind, a);
}
const sub = process.argv[2] as Kind;
let prompt = arg("-p"), readOnlyRun = false;
if (KINDS.includes(sub)) {
  const b = modeTask(sub, process.argv.slice(3));
  if (b.error) { console.error(b.error); process.exit(2); }
  prompt = b.task; readOnlyRun = b.readOnly;
}
if (prompt) {
  if (readOnlyRun) ctx.allowed = READONLY;
  const r = await runAgent({ root, task: prompt, base, key, model, mode, ask, settings, profile, ctx, log, onToken });
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
  const slash = /^\/(gen|translate|debug|explain|test)\b\s*(.*)$/.exec(line);
  if (slash) {
    const b = modeTask(slash[1] as Kind, words(slash[2]));
    if (b.error) { console.log(b.error); continue; }
    ctx.allowed = b.readOnly ? READONLY : undefined;
    try { const r = await runAgent({ root, task: b.task, base, key, model, mode, ask, settings, profile, ctx, log, history, onToken }); history = r.messages; console.log("\n" + r.summary + `\n(${r.steps} steps, files changed: ${r.touched.join(", ") || "none"})`); }
    catch (e: any) { console.log("Error: " + e.message); } finally { ctx.allowed = undefined; }
    continue;
  }
  if (line === "/diff") { const d = sessionDiff(ctx); console.log(d ? colorize(d) : "No changes yet."); continue; }
  if (line === "/jobs") { console.log(ctx.bg.list()); continue; }
  if (line === "/undo") { const d = undoAll(ctx); console.log(d.length ? "Restored: " + d.join(", ") : "Nothing to undo."); continue; }
  if (line.startsWith("/mode ")) { mode = line.slice(6).trim() as Mode; ctx.mode = mode; console.log("Mode: " + mode); continue; }
  if (line.startsWith("/model ")) { model = line.slice(7).trim(); console.log("Model: " + model); continue; }
  try {
    const r = await runAgent({ root, task: line, base, key, model, mode, ask, settings, profile, ctx, log, history, onToken });
    history = r.messages; console.log("\n" + r.summary + `\n(${r.steps} steps, files changed: ${r.touched.join(", ") || "none"})`);
  } catch (e: any) { console.log("Error: " + e.message); }
}
rl.close();
