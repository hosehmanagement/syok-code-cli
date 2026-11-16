#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent, makeCtx, undoAll, askModel, type Msg , emptyUsage, mergeUsage, describeUsage, type Result } from "./agent.ts";
import { sessionDiff } from "./tools.ts";
import { colorize } from "./diff.ts";
import { startMcp } from "./mcp.ts";
import { buildTask, KINDS, type Kind } from "./tasks.ts";
import { READONLY, syncSandbox } from "./tools.ts";
import { pickProfile } from "./profiles.ts";
import { MODES, type Mode } from "./perm.ts";
import { loadSkills, addSkill, preview, buildSkillTask, type Skill } from "./skills.ts";
import { currentShell } from "./shell.ts";
import { newSessionId, saveSession, loadSession, describeSessions } from "./session.ts";
import { takeCheckpoint, rewindTo, describeCheckpoints, type Checkpoint } from "./checkpoint.ts";
import { loadCommands, renderCommand, describeCommands } from "./commands.ts";
import { addPlugin, removePlugin, listPlugins, describePlugins, pluginSettings } from "./plugins.ts";
import { extractImages } from "./image.ts";
import { summarizeHistory } from "./compactor.ts";
import { reviewTask, openPr, realRun } from "./pr.ts";
import { sandboxCall, sandboxExec, sandboxPut } from "./sandbox.ts";
import { runJobRunner, describeJobs, jobLog, stopJob } from "./jobs.ts";
import { selfUpdate, sha256 } from "./update.ts";

function arg(n: string, d = "") { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const has = (n: string) => process.argv.includes(n);
const JSON_OUT = has("--json") || arg("--output-format") === "json";
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
Web (the AI can look things up; in ask mode you approve the first search and each new site):
  --no-web                                     switch web_search and web_fetch off   (or "web": false in .syok/settings.json)
  "allow_hosts": ["python.org"]                in .syok/settings.json: sites that may be read without asking
  EXA_API_KEY=...                              optional: your own Exa key for a more reliable search
Heavy jobs on a rented cloud computer (your own Modal account; billed to you per second while it is on):
  syok run --on modal -- python train.py       send this folder, run the command there, show its output live, switch the computer off
     --gpu T4|L4|A10|A100   --image python:3.12-slim   --timeout 60 (minutes, at most 1440)   --cpu 4   --memory 8192 (MB)
     --out results          bring the folder "results" back into this project when it ends
     --no-upload            do not send this folder      --detach   leave it running and come back later
     (being tested, not switched on yet: --on codespace --codespace <name> runs it on your own GitHub Codespace)
  syok remote                                  list detached runs
  syok remote logs <n> [--tail 200]            see the output of a detached run
  syok remote stop <n>                         bring back results and switch its computer off
Checks after edits (on by default):
  every edit is followed by a fast syntax check of that file; before finishing, the project's own check runs once
  (the "typecheck", "check" or "lint" script in package.json, cargo check, or go vet) and failures go back to the AI to fix
  --no-checks                                  switch both off   (or "checks": false in .syok/settings.json)
  "check_command": "npm run typecheck"         in .syok/settings.json: your own project check
Usage: after each task you see tokens in and out and which provider answered; /usage shows the session total.
  "prices": { "gpt-5": { "in": 1.25, "out": 10 } }   in .syok/settings.json: US dollars per million tokens, for a cost estimate
Updating:
  syok update                                  get the newest Syok Code (checked before it replaces anything)
Saved jobs (long scripts that keep running after you exit; the AI starts them with job_start):
  syok jobs                                    list them          syok logs <n> [--tail 4000]   read the end of the log
  syok stop <n>                                stop one           (files live in .syok/jobs/<n>/)
Codespace link (lets the Syok website run commands in your own GitHub Codespace):
  syok bridge                                  start the small command server (a Codespace from the Syok template does this by itself)
  syok pair <code>                             link this Codespace to your Syok account with the one-time code shown in Syok
  syok unpair                                  make a new secret, so the old link stops working
Chats, plans and checkpoints:
  syok --continue | --resume [number|id]   pick up a saved chat (every chat is saved in .syok/sessions); syok sessions lists them
  --mode plan           planning only: it explores and writes a plan, and nothing changes until you approve
  In chat: /plan <task>  /compact [focus]  /resume [n]  /sessions  /checkpoint [name]  /checkpoints  /rewind [n]  /init  /image <file> <question>  (or write @shot.png in a message)
Your own commands and plugins:
  .syok/commands/<name>.md becomes /<name> ($ARGUMENTS = what you type after it); syok commands lists them
  syok plugin add <owner/repo|folder> | list | remove <name>      bundles of skills, commands and hooks
GitHub:
  syok review <pull request number or link> [--comment]   read-only review of a pull request (needs the gh program)
  syok pr "title"                                          commit your changes to a branch, push it and open a pull request (asks first)
Isolation: dangerous commands are always blocked. For real isolation use the Daytona sandbox:  syok sandbox start owner/repo | status | stop   then add --sandbox
  With --sandbox, commands run in the sandbox's copy of your GitHub repository and every file the AI edits is copied there too.
  The sandbox starts from what is on GitHub, so push your own uncommitted changes first if the commands need them.
Scripts and CI: syok -p "task" --json   or pipe the task in:  echo "task" | syok -p -
Options:
  --cwd <folder>        project folder (default: current folder)
  --model <name>        model or preset (default: syok-coder; syok-auto = general routing)
  --mode <ask|accept-edits|plan|auto>   ask = ask before edits and commands (default)
                        accept-edits = edit freely, ask before other commands
                        auto = run everything except blocked commands
  --profile <name>      tuning profile from profiles.json
  --max-steps <n>       stop after n steps
  --general             general terminal mode: not only programming (scripts, data, system tasks, automation)
  --timeout <sec>       default time limit for one command (default 120)
  --max-timeout <sec>   the most one command may run (default 600, up to 86400); longer work belongs in a saved job
  --no-stream           wait for the full answer instead of showing it as it is written
  --json                print the result as JSON (for tests and scripts)
Setup: set SYOK_BASE_URL (your Syok address) and SYOK_API_KEY (a syk_ key from Syok > Developer API),
or put {"base":"...","key":"..."} in ~/.syok/config.json.
In chat: /skills  /skill <name> <task>  (or /<name> <task>)  /gen /translate /debug /explain /test (same as above)  /diff (show every change so far)  /undo  /mode <m>  /model <m>  /jobs  /usage (tokens and providers this session)  /help  /exit
Extras (in <project>/.syok/settings.json):
  "hooks": { "PreToolUse": [{"match":"edit_file|write_file","command":"./check.sh"}], "PostToolUse": [...], "Stop": [{"command":"npm test"}] }
      your command gets the event as JSON on its input; exit code 2 blocks the action (or sends the message back to the AI for Stop)
  "mcpServers": { "name": { "command": "node", "args": ["server.js"] } }   local tool servers (MCP over stdio)
  "allow": ["npm run"], "deny": ["curl"]    command prefixes to always allow / block
The AI can also delegate to helper agents (read-only explorers run in parallel) and run background jobs (dev servers).`;
if (has("--help") || has("-h")) { console.log(HELP); process.exit(0); }
if (["plugin", "plugins", "sessions", "commands"].includes(process.argv[2] ?? "")) {
  const here = resolve(arg("--cwd", process.cwd())); const sub0 = process.argv[2]; const a = process.argv.slice(3).filter((x) => !x.startsWith("--"));
  if (sub0 === "sessions") console.log(describeSessions(here));
  else if (sub0 === "commands") console.log(describeCommands(loadCommands(here)));
  else if (a[0] === "add") { const r = await addPlugin(here, a[1] || ""); console.log(r.message); process.exit(r.ok ? 0 : 2); }
  else if (a[0] === "remove") console.log(removePlugin(here, a[1] || "") ? "Removed." : "No such plugin in this project.");
  else console.log(describePlugins(listPlugins(here)));
  process.exit(0);
}
if (["bridge", "pair", "unpair"].includes(process.argv[2] ?? "")) {
  // The bridge needs no API key: it only serves commands to a caller that holds its secret.
  const { bridgeCommand } = await import("./bridge.ts");
  process.exit(await bridgeCommand(process.argv.slice(2), { base: process.env.SYOK_BASE_URL || readJson(join(homedir(), ".syok", "config.json")).base || "" }));
}
if (process.argv[2] === "__jobrun") { process.exit(await runJobRunner(process.argv[3] || "")); } // internal: the runner of a saved job
if (process.argv[2] === "update") {
  // Needs no API key. Replaces the installed one-file program after checking the download.
  const self = process.argv[1] || ""; let current = ""; try { current = sha256(readFileSync(self)); } catch {}
  const r = await selfUpdate({ self, current }); (r.ok ? console.log : console.error)(r.message); process.exit(r.ok ? 0 : 1);
}
if (process.argv[2] === "run" || process.argv[2] === "remote") {
  // Remote runs need no Syok key: they use your own cloud account (Modal) straight from this computer.
  const { remoteCommand } = await import("./remote-cli.ts");
  process.exit(await remoteCommand(process.argv.slice(2)));
}
if (["jobs", "logs", "stop"].includes(process.argv[2] ?? "")) {
  // Saved jobs need no API key: they are just files in <project>/.syok/jobs.
  const here = resolve(arg("--cwd", process.cwd())); const sub1 = process.argv[2]; const rest = process.argv.slice(3).filter((x, i, all) => !x.startsWith("--") && !["--cwd", "--tail"].includes(all[i - 1] ?? ""));
  if (sub1 === "jobs") console.log(describeJobs(here));
  else if (!rest[0] || !/^\d+$/.test(rest[0])) { console.error("Use: syok " + sub1 + " <job number>   (syok jobs lists them)"); process.exit(2); }
  else if (sub1 === "logs") { const t = +arg("--tail", "4000") || 4000; console.log(jobLog(here, +rest[0], t)); }
  else console.log(stopJob(here, +rest[0]));
  process.exit(0);
}
const cfg = readJson(join(homedir(), ".syok", "config.json"));
const base = process.env.SYOK_BASE_URL || cfg.base || "", key = process.env.SYOK_API_KEY || cfg.key || "";
if (!base || !key) { console.error("Missing SYOK_BASE_URL or SYOK_API_KEY. Run: syok --help"); process.exit(2); }
const root = resolve(arg("--cwd", process.cwd()));
let model = arg("--model", "syok-coder"), mode = arg("--mode", "ask") as Mode;
if (!MODES.includes(mode)) { console.error("Unknown mode. Use one of: " + MODES.join(", ")); process.exit(2); }
const table = existsSync(join(root, "profiles.json")) ? readJson(join(root, "profiles.json")) : {};
const settings = pluginSettings(root, readJson(join(root, ".syok", "settings.json")));
if (has("--general")) settings.general = true;
if (arg("--timeout")) settings.timeout_sec = +arg("--timeout");
if (arg("--max-timeout")) settings.max_timeout_sec = +arg("--max-timeout");
const profile = pickProfile(model, arg("--profile") || undefined, table);
if (arg("--max-steps")) profile.maxSteps = +arg("--max-steps");
const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (what: string, detail: string) => {
  if (!rl) return false;
  const a = (await rl.question(`\nAllow ${what}?\n${process.stdout.isTTY ? colorize(detail.slice(0, 1800)) : detail.slice(0, 1800)}\n[y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
};
const log = (s: string) => { if (!JSON_OUT) console.log(s); };
const ctx = makeCtx(root, mode, ask, settings, profile);
if (settings.mcpServers) ctx.mcp = await startMcp(settings.mcpServers, root, (s) => console.error(s));
const cleanup = () => { ctx.bg.stopAll(); ctx.mcp.forEach((x) => x.stop()); };
process.on("exit", cleanup); process.on("SIGINT", () => { cleanup(); process.exit(130); });
const onToken = !JSON_OUT && !has("--no-stream") ? (s: string) => process.stdout.write(s) : undefined;
ctx.web = { base, key, exaKey: process.env.EXA_API_KEY || undefined, state: {} };
if (has("--no-web")) settings.web = false;
if (has("--no-checks")) settings.checks = false;
// What this whole session used (every task, skill and helper added up); shown by /usage and after each task.
const sessionUsage = emptyUsage();
function report(r: Result, extra = ""): string {
  mergeUsage(sessionUsage, r.usage);
  const chk = r.check ? (r.check.passed === true ? `; project check passed (${r.check.command})` : r.check.passed === false ? `; PROJECT CHECK STILL FAILING (${r.check.command})` : `; project check not run (${r.check.command})`) : "";
  return `(${r.steps} steps, files changed: ${r.touched.join(", ") || "none"}${extra}${chk})\n(${describeUsage(r.usage, settings.prices)})`;
}
if (has("--sandbox")) { ctx.sandbox = (cmd, secs) => sandboxExec({ base, key }, cmd, secs); ctx.sandboxPut = (rel, content) => sandboxPut({ base, key }, rel, content); }
const resumeRef = has("--resume") ? (arg("--resume").startsWith("-") ? "" : arg("--resume")) : "";
const resumed = has("--continue") || has("--resume") ? loadSession(root, resumeRef || undefined) : null;
if ((has("--continue") || has("--resume")) && !resumed) { console.error("No saved chat to continue. Chats are saved in .syok/sessions."); process.exit(2); }
let sessionId = resumed?.id || newSessionId();
if (resumed && !has("--model") && resumed.model) model = resumed.model;
let history: Msg[] | undefined = resumed?.messages;
const cps: Checkpoint[] = [];
const persist = () => { if (history?.length) { try { saveSession(root, { id: sessionId, model, mode, messages: history }); } catch {} } };
const INIT_TASK = "Explore this project and create SYOK.md in the project root for future sessions: what the project is, how to build and test it (exact commands), the folder layout, code style rules you can see, and anything easy to get wrong. Keep it under 60 lines and do not invent facts. If SYOK.md already exists, improve it instead.";
async function turn(text: string) {
  const im = extractImages(root, text); im.notes.forEach((n) => console.log("(" + n + ")"));
  takeCheckpoint(ctx, cps, text, history?.length || 0);
  try {
    const r = await runAgent({ root, task: im.text, images: im.images, base, key, model, mode, ask, settings, profile, ctx, log, history, onToken });
    history = r.messages; persist();
    console.log("\n" + r.summary + "\n" + report(r));
  } catch (e: any) { console.log("Error: " + e.message); }
}
async function readStdin(): Promise<string> { const ch: Buffer[] = []; for await (const c of process.stdin) ch.push(c as Buffer); return Buffer.concat(ch).toString("utf8").trim(); }
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
  if (!JSON_OUT) console.log(preview(sk) + `\n(commands run in ${currentShell().label})\n`);
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
if (process.argv[2] === "sandbox") {
  const a = process.argv.slice(3).filter((x) => !x.startsWith("--")); const act = a[0] || "status";
  if (!["start", "stop", "status"].includes(act)) { console.error("Use: syok sandbox start owner/repo | status | stop"); process.exit(2); }
  const r = await sandboxCall({ base, key }, act, act === "start" ? { repo: a[1] } : {});
  console.log(r.ok ? JSON.stringify(r.data).slice(0, 800) : "The sandbox said HTTP " + r.status + ": " + JSON.stringify(r.data).slice(0, 300));
  process.exit(r.ok ? 0 : 1);
}
if (process.argv[2] === "review") {
  const ref = process.argv.slice(3).find((x) => !x.startsWith("--")) || "";
  if (!ref) { console.error("Use: syok review <pull request number or link> [--comment]"); process.exit(2); }
  const t = reviewTask(ref, realRun, root);
  if (t.error) { console.error(t.error); process.exit(2); }
  ctx.allowed = READONLY;
  const r = await runAgent({ root, task: t.task!, base, key, model, mode: "ask", ask, settings, profile, ctx, log, onToken });
  console.log("\n" + r.summary);
  if (has("--comment") && r.summary && (mode === "auto" || await ask("post this review as a comment on the pull request", r.summary))) { const c = realRun("gh", ["pr", "comment", ref, "--body", r.summary], root); console.log(c.code ? "Could not post the comment: " + c.out.slice(0, 200) : "Comment posted."); }
  rl?.close(); process.exit(r.stopped === "finished" || r.stopped === "answered" ? 0 : 1);
}
if (process.argv[2] === "pr") {
  const title = process.argv.slice(3).filter((x) => !x.startsWith("--")).join(" ").trim() || "Changes from Syok Code";
  const r = await openPr(title, realRun, root, mode === "auto" ? async () => true : ask);
  console.log(r.message); rl?.close(); process.exit(r.ok ? 0 : 1);
}
if (process.argv[2] === "skills" || process.argv[2] === "skill") {
  const pos = positional(process.argv.slice(3));
  if (process.argv[2] === "skills" || !pos.length || pos[0] === "list") { console.log(listSkills()); process.exit(0); }
  if (pos[0] === "add") { const r = await addSkill(root, pos[1] || ""); console.log(r.message); process.exit(r.ok ? 0 : 2); }
  const sk = loadSkills(root).get(pos[0].toLowerCase());
  if (!sk) { console.error(`No skill named "${pos[0]}". Your skills:\n` + listSkills()); process.exit(2); }
  const r = await runSkill(sk, pos.slice(1).join(" "));
  if (JSON_OUT) console.log(JSON.stringify({ summary: r.summary, steps: r.steps, tokens: r.tokens, touched: r.touched, stopped: r.stopped, commands: r.commands, declined: r.declined }));
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
if (prompt === "-" || (!prompt && !rl && !KINDS.includes(sub))) prompt = await readStdin();
if (prompt) {
  if (readOnlyRun) ctx.allowed = READONLY;
  const im = extractImages(root, prompt); im.notes.forEach((n) => console.error("(" + n + ")"));
  const r = await runAgent({ root, task: im.text, images: im.images, base, key, model, mode, ask, settings, profile, ctx, log, history, onToken });
  history = r.messages; persist();
  if (JSON_OUT) console.log(JSON.stringify({ summary: r.summary, session: sessionId, steps: r.steps, tokens: r.tokens, touched: r.touched, stopped: r.stopped, ranTests: r.ranTests, commands: r.commands, declined: r.declined, usage: r.usage, check: r.check ?? null }));
  else console.log("\n" + r.summary + "\n" + report(r));
  rl?.close(); process.exit(r.stopped === "finished" || r.stopped === "answered" ? 0 : 1);
}
if (!rl) { console.error("No task given. Use -p \"task\" or run in a terminal."); process.exit(2); }
console.log(`Syok Code in ${root}  (mode: ${mode}, model: ${model}). Type /help.`);
if (resumed) console.log("Continuing chat: " + resumed.title);
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
    try { const r = await runAgent({ root, task: b.task, base, key, model, mode, ask, settings, profile, ctx, log, history, onToken }); history = r.messages; persist(); console.log("\n" + r.summary + `\n(${r.steps} steps, files changed: ${r.touched.join(", ") || "none"})`); }
    catch (e: any) { console.log("Error: " + e.message); } finally { ctx.allowed = undefined; }
    continue;
  }
  if (line === "/diff") { const d = sessionDiff(ctx); console.log(d ? colorize(d) : "No changes yet."); continue; }
  if (line === "/jobs") { console.log(ctx.bg.list() + "\nSaved jobs (keep running after you exit):\n" + describeJobs(root)); continue; }
  if (line === "/sessions") { console.log(describeSessions(root)); continue; }
  if (line === "/resume" || line.startsWith("/resume ")) {
    const ref = line.slice(7).trim();
    if (!ref) { console.log(describeSessions(root) + "\nType /resume <number> to open one."); continue; }
    const s2 = loadSession(root, ref);
    if (!s2) { console.log("No such chat."); continue; }
    history = s2.messages; sessionId = s2.id; if (s2.model) model = s2.model; console.log("Continuing: " + s2.title); continue;
  }
  if (line === "/plugins") { console.log(describePlugins(listPlugins(root))); continue; }
  if (line === "/commands") { console.log(describeCommands(loadCommands(root))); continue; }
  if (line === "/checkpoints") { console.log(describeCheckpoints(cps)); continue; }
  if (line === "/checkpoint" || line.startsWith("/checkpoint ")) { const c = takeCheckpoint(ctx, cps, line.slice(11).trim() || "manual", history?.length || 0); console.log("Checkpoint " + c.n + " saved."); continue; }
  if (line === "/rewind" || line.startsWith("/rewind ")) {
    const n = +line.slice(7).trim() || (cps.length ? cps[cps.length - 1].n : 0);
    const rw = rewindTo(ctx, cps, n);
    if (!rw) { console.log("No checkpoint " + n + ".\n" + describeCheckpoints(cps)); continue; }
    history = history && rw.msgLen > 0 ? history.slice(0, rw.msgLen) : undefined; persist();
    if (rw.restored.length && ctx.sandboxPut) console.log([...new Set(await syncSandbox(ctx, rw.restored))].join("\n"));
    console.log("Rewound to checkpoint " + n + ". " + (rw.restored.length ? "Restored: " + rw.restored.join(", ") : "No files needed restoring.")); continue;
  }
  if (line === "/compact" || line.startsWith("/compact ")) {
    if (!history || history.length < 8) { console.log("The chat is still short; nothing to compact."); continue; }
    try { const sm2 = await summarizeHistory(history, (p) => askModel(base, key, model, p), { focus: line.slice(8).trim() }); history = sm2.messages; persist(); console.log(sm2.removed ? "Summarized " + sm2.removed + " older messages." : "Nothing to summarize yet."); } catch (e: any) { console.log("Error: " + e.message); }
    continue;
  }
  if (line === "/plan" || line.startsWith("/plan ")) {
    const t = line.slice(5).trim(); if (!t) { console.log("Use: /plan <what you want done>"); continue; }
    const before = ctx.mode; ctx.mode = "plan";
    try {
      takeCheckpoint(ctx, cps, "plan: " + t, history?.length || 0);
      const r1 = await runAgent({ root, task: t, base, key, model, mode: "plan", ask, settings, profile, ctx, log, history, onToken }); history = r1.messages; persist();
      console.log("\n" + r1.summary);
      ctx.mode = before === "plan" ? "accept-edits" : before;
      if (await ask("carry out this plan (changes allowed in mode " + ctx.mode + ")", "")) {
        mode = ctx.mode;
        const r2 = await runAgent({ root, task: "The user approved your plan. Carry it out now, then run the checks.", base, key, model, mode, ask, settings, profile, ctx, log, history, onToken }); history = r2.messages; persist();
        console.log("\n" + r2.summary + "\n(" + r2.steps + " steps, files changed: " + (r2.touched.join(", ") || "none") + ")");
      } else ctx.mode = before;
    } catch (e: any) { ctx.mode = before; console.log("Error: " + e.message); }
    continue;
  }
  const cm = /^\/([\w-]+)(?=\s|$)\s*(.*)$/.exec(line);
  const custom = cm ? loadCommands(root).get(cm[1].toLowerCase()) : undefined;
  if (cm && (cm[1] === "init" || cm[1] === "image" || custom)) { await turn(cm[1] === "init" ? INIT_TASK : cm[1] === "image" ? cm[2] : renderCommand(custom!, cm[2])); continue; }
  if (line === "/usage" || line === "/cost") { console.log("This session so far: " + describeUsage(sessionUsage, settings.prices) + (settings.prices ? "" : "\n(No money amount: Syok cannot know each provider's price. Add \"prices\" to .syok/settings.json to get an estimate.)")); continue; }
  if (line === "/undo") { const d = undoAll(ctx); console.log(d.length ? "Restored: " + d.join(", ") : "Nothing to undo."); if (d.length && ctx.sandboxPut) console.log([...new Set(await syncSandbox(ctx, d))].join("\n")); continue; }
  if (line === "/mode" || line.startsWith("/mode ")) { const w = line.slice(5).trim() as Mode; const nm = w || MODES[(MODES.indexOf(mode) + 1) % MODES.length]; if (!MODES.includes(nm)) { console.log("Modes: " + MODES.join(", ")); continue; } mode = nm; ctx.mode = nm; console.log("Mode: " + nm); continue; }
  if (line.startsWith("/model ")) { model = line.slice(7).trim(); console.log("Model: " + model); continue; }
  const sm = /^\/skills?(?=\s|$)\s*(.*)$/.exec(line), sx = /^\/([\w-]+)(?=\s|$)\s*(.*)$/.exec(line);
  const toks = sm ? words(sm[1]) : [];
  if (sm && (!toks.length || toks[0] === "list")) { console.log(listSkills()); continue; }
  if (sm && toks[0] === "add") { console.log((await addSkill(root, toks[1] || "")).message); continue; }
  const skName = sm ? toks[0] : sx ? sx[1] : "", skRest = sm ? toks.slice(1).join(" ") : sx ? sx[2] : "";
  const found = skName ? loadSkills(root).get(skName.toLowerCase()) : undefined;
  if (sm && !found) { console.log(`No skill named "${skName}". Your skills:\n` + listSkills()); continue; }
  if (found) {
    try { const r = await runSkill(found, skRest, history); history = r.messages; persist(); console.log("\n" + r.summary + "\n" + skillReport(found, r)); } catch (e: any) { console.log("Error: " + e.message); }
    continue;
  }
  await turn(line);
}
rl.close();
