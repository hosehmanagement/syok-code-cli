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
import { loadSkills, addSkill, preview, buildSkillTask, type Skill } from "./skills.ts";
import { currentShell } from "./shell.ts";

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
Skills (instruction files the AI follows, including commands it runs itself):
  syok skills                                  list your skills (.syok/skills, .claude/skills and ~/.syok/skills)
  syok skill add <github-link|owner/repo/path|file>   save a skill into this project
  syok skill <name> "what you want"            run a skill: it shows its commands first, and you still approve each one (or use --mode auto)
Codespace link (lets the Syok website run commands in your own GitHub Codespace):
  syok bridge                                  start the small command server (a Codespace from the Syok template does this by itself)
  syok pair <code>                             link this Codespace to your Syok account with the one-time code shown in Syok
  syok unpair                                  make a new secret, so the old link stops working
Options:
  --cwd <folder>        project folder (default: current folder)
  --model <name>        model or preset (default: syok-coder; syok-auto = general routing)
  --mode <ask|accept-edits|auto>   ask = ask before edits and commands (default)
                        accept-edits = edit freely, ask before other commands
                        auto = run everything except blocked commands
  --profile <name>      tuning profile from profiles.json
  --max-steps <n>       stop after n steps
  --no-stream           wait for the full answer instead of showing it as it is written
  --json                print the result as JSON (for tests and scripts)
Setup: set SYOK_BASE_URL (your Syok address) and SYOK_API_KEY (a syk_ key from Syok > Developer API),
or put {"base":"...","key":"..."} in ~/.syok/config.json.
In chat: /skills  /skill <name> <task>  (or /<name> <task>)  /gen /translate /debug /explain /test (same as above)  /diff (show every change so far)  /undo  /mode <m>  /model <m>  /jobs  /help  /exit
Extras (in <project>/.syok/settings.json):
  "hooks": { "PreToolUse": [{"match":"edit_file|write_file","command":"./check.sh"}], "PostToolUse": [...], "Stop": [{"command":"npm test"}] }
      your command gets the event as JSON on its input; exit code 2 blocks the action (or sends the message back to the AI for Stop)
  "mcpServers": { "name": { "command": "node", "args": ["server.js"] } }   local tool servers (MCP over stdio)
  "allow": ["npm run"], "deny": ["curl"]    command prefixes to always allow / block
The AI can also delegate to helper agents (read-only explorers run in parallel) and run background jobs (dev servers).`;
if (has("--help") || has("-h")) { console.log(HELP); process.exit(0); }
if (["bridge", "pair", "unpair"].includes(process.argv[2] ?? "")) {
  // The bridge needs no API key: it only serves commands to a caller that holds its secret.
  const { bridgeCommand } = await import("./bridge.ts");
  process.exit(await bridgeCommand(process.argv.slice(2), { base: process.env.SYOK_BASE_URL || readJson(join(homedir(), ".syok", "config.json")).base || "" }));
}
const cfg = readJson(join(homedir(), ".syok", "config.json"));
const base = process.env.SYOK_BASE_URL || cfg.base || "", key = process.env.SYOK_API_KEY || cfg.key || "";
if (!base || !key) { console.error("Missing SYOK_BASE_URL or SYOK_API_KEY. Run: syok --help"); process.exit(2); }
const root = resolve(arg("--cwd", process.cwd()));
let model = arg("--model", "syok-coder"), mode = arg("--mode", "ask") as Mode;
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
const positional = (toks: string[]) => { const pos: string[] = []; for (let i = 0; i < toks.length; i++) { if (VALUE_FLAGS.has(toks[i])) i++; else if (!toks[i].startsWith("--")) pos.push(toks[i]); } return pos; };
function listSkills() {
  const m = loadSkills(root);
  if (!m.size) return "No skills yet. Add one:  syok skill add <github link to a SKILL.md>\nSkills live in .syok/skills/<name>/SKILL.md (Claude-style .claude/skills work too).";
  return [...m.values()].map((s) => `  ${s.name}${s.needsRun ? "  [runs commands]" : ""}${s.source === "home" ? "  (yours, all projects)" : ""} - ${s.description}`).join("\n");
}
async function runSkill(sk: Skill, request: string, hist?: Msg[]) {
  if (!has("--json")) console.log(preview(sk) + `\n(commands run in ${currentShell().label})\n`);
  const saved = ctx.settings;
  if (sk.allowed.length && mode !== "auto" && await ask("this skill to run these commands without asking each time (this run only): " + sk.allowed.join(", "), preview(sk))) ctx.settings = { ...saved, allow: [...(saved.allow || []), ...sk.allowed] };
  try { return await runAgent({ root, task: buildSkillTask(sk, request), base, key, model, mode, ask, settings: ctx.settings, profile, ctx, log, history: hist, onToken, mustRun: sk.needsRun }); }
  finally { ctx.settings = saved; }
}
function skillReport(sk: Skill, r: { commands: number; declined: number; steps: number; touched: string[] }) {
  const parts = [`${r.steps} steps`, `commands run: ${r.commands}`, ...(r.declined ? [`not allowed: ${r.declined}`] : []), `files changed: ${r.touched.join(", ") || "none"}`];
  const warn = sk.needsRun && !r.commands && !r.declined ? "\nWARNING: this skill needs commands, but the AI ran none, so the skill did not do its job. Try again, or pick a stronger model with --model." : "";
  return `(${parts.join(", ")})${warn}`;
}
if (process.argv[2] === "skills" || process.argv[2] === "skill") {
  const pos = positional(process.argv.slice(3));
  if (process.argv[2] === "skills" || !pos.length || pos[0] === "list") { console.log(listSkills()); process.exit(0); }
  if (pos[0] === "add") { const r = await addSkill(root, pos[1] || ""); console.log(r.message); process.exit(r.ok ? 0 : 2); }
  const sk = loadSkills(root).get(pos[0].toLowerCase());
  if (!sk) { console.error(`No skill named "${pos[0]}". Your skills:\n` + listSkills()); process.exit(2); }
  const r = await runSkill(sk, pos.slice(1).join(" "));
  if (has("--json")) console.log(JSON.stringify({ summary: r.summary, steps: r.steps, tokens: r.tokens, touched: r.touched, stopped: r.stopped, commands: r.commands, declined: r.declined }));
  else console.log("\n" + r.summary + "\n" + skillReport(sk, r));
  rl?.close(); process.exit(r.stopped === "finished" || r.stopped === "answered" ? 0 : 1);
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
  if (has("--json")) console.log(JSON.stringify({ summary: r.summary, steps: r.steps, tokens: r.tokens, touched: r.touched, stopped: r.stopped, ranTests: r.ranTests, commands: r.commands, declined: r.declined }));
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
  const sm = /^\/skills?(?=\s|$)\s*(.*)$/.exec(line), sx = /^\/([\w-]+)(?=\s|$)\s*(.*)$/.exec(line);
  const toks = sm ? words(sm[1]) : [];
  if (sm && (!toks.length || toks[0] === "list")) { console.log(listSkills()); continue; }
  if (sm && toks[0] === "add") { console.log((await addSkill(root, toks[1] || "")).message); continue; }
  const skName = sm ? toks[0] : sx ? sx[1] : "", skRest = sm ? toks.slice(1).join(" ") : sx ? sx[2] : "";
  const found = skName ? loadSkills(root).get(skName.toLowerCase()) : undefined;
  if (sm && !found) { console.log(`No skill named "${skName}". Your skills:\n` + listSkills()); continue; }
  if (found) {
    try { const r = await runSkill(found, skRest, history); history = r.messages; console.log("\n" + r.summary + "\n" + skillReport(found, r)); } catch (e: any) { console.log("Error: " + e.message); }
    continue;
  }
  try {
    const r = await runAgent({ root, task: line, base, key, model, mode, ask, settings, profile, ctx, log, history, onToken });
    history = r.messages; console.log("\n" + r.summary + `\n(${r.steps} steps, files changed: ${r.touched.join(", ") || "none"})`);
  } catch (e: any) { console.log("Error: " + e.message); }
}
rl.close();
