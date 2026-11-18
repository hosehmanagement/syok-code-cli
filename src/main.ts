#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
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
import { cleanupParallel } from "./parallel.ts";

function arg(n: string, d = "") { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const has = (n: string) => process.argv.includes(n);
const JSON_OUT = has("--json") || arg("--output-format") === "json";
function readJson(p: string) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }
const HELP = `Syok Code (command line)
Usage:
  syok                       chat in the current folder
  syok -p "fix the failing test"   run one task and print the result
  syok -p "task" --stay            run one task, then stay in the chat
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
GitHub: let people write "@syok <what to do>" in issues and pull requests (runs in GitHub Actions, on your Syok key):
  syok github-action [--force]                 write .github/workflows/syok.yml into this project and show the two secrets to add
Checking your setup:
  syok setup                                   a few questions, asked once: address, key, how much it asks, model, web, confinement, checks, parallel workers
  syok setup --show | --reset                  see your saved choices | forget them (address and key stay)
  syok mcp                                     list the hosted tool servers of this project and whether you are signed in
  syok mcp login <name> | logout <name>        sign in to a hosted tool server through your browser | forget the pass (--no-browser: only print the address)
  syok doctor                                  check the address, the key, a real AI answer and the programs Syok Code uses
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
Your own helpers (custom agents):
  .syok/agents/<name>.md   a helper with its own instructions and tools ("tools: read, search" makes it read-only); syok agents lists them
  files made for Claude Code (.claude/agents) and GitHub Copilot (.github/agents/*.agent.md) are used as they are
Your own commands and plugins:
  .syok/commands/<name>.md becomes /<name> ($ARGUMENTS = what you type after it); syok commands lists them
  syok plugin add <owner/repo|folder> | list | remove <name>      bundles of skills, commands and hooks
GitHub:
  syok review <pull request number or link> [--comment]   read-only review of a pull request (needs the gh program)
  syok cloud "what to do next"                              hand your work to GitHub's cloud: pushes it to a branch, opens a draft pull request and starts the @syok job there (asks first; in chat: /cloud <what to do>)
  syok pr "title"                                          commit your changes to a branch, push it and open a pull request (asks first)
Confinement: every command the AI runs is held inside the project folder by the operating system.
  Linux and Mac: ON by default. Commands may read the computer but write only in the project and the temporary folder; folders with keys
    (.ssh, .aws...) cannot be read, and a command cannot find your keys by looking at other running programs.
    --no-confine switches it off for one run (for example for Docker); "syok setup" changes your everyday choice.
    --confine-no-network   also no network.   Linux needs the program bubblewrap; Mac uses the built-in sandbox-exec.
    If it cannot work on this computer, Syok Code says so once and carries on; with --confine it stops instead.
  Windows: --confine gives write protection: commands can change files only in the project. They can still read other files.
    It marks the project folder for this; "syok confine undo" removes the mark. Inside WSL you get the full Linux kind.
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
  --workers <n>         parallel editing: how many workers may change the project at once, each in its own copy (default 2, at most 8, 0 = off).
                        Needs a git project. You are asked before they start; their changes are joined into your folder and /undo takes them back.
                        "parallel_workers": 3 in .syok/settings.json makes it the default
  --general             general terminal mode: not only programming (scripts, data, system tasks, automation)
  --timeout <sec>       default time limit for one command (default 120)
  --max-timeout <sec>   the most one command may run (default 600, up to 86400); longer work belongs in a saved job
  --no-stream           wait for the full answer instead of showing it as it is written
  --json                print the result as JSON (for tests and scripts)
Setup: run "syok setup". (Or set SYOK_BASE_URL, your Syok address, and SYOK_API_KEY, a syk_ key from Syok > Developer API;
or put {"base":"...","key":"..."} in ~/.syok/config.json.)
In chat: /skills  /skill <name> <task>  (or /<name> <task>)  /gen /translate /debug /explain /test (same as above)  /diff (show every change so far)  /undo  /mode <m>  /model <m>  /jobs  /usage (tokens and providers this session)  /help  /exit
Extras (in <project>/.syok/settings.json):
  "hooks": { "PreToolUse": [{"match":"edit_file|write_file","command":"./check.sh"}], "PostToolUse": [...], "Stop": [{"command":"npm test"}] }
      your command gets the event as JSON on its input; exit code 2 blocks the action (or sends the message back to the AI for Stop)
  "mcpServers": { "name": { "command": "node", "args": ["server.js"] } }   local tool servers (MCP over stdio)
  "mcpServers": { "name": { "url": "https://tools.example.com/mcp", "headers": { "Authorization": "Bearer \${MY_KEY}" } } }   hosted tool servers (MCP over HTTP); \${MY_KEY} is read from your environment
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
const { cleanDefaults, applyDefaults } = await import("./setup.ts");
const mine = cleanDefaults(cfg.defaults); // your personal choices from "syok setup"
if (process.argv[2] === "setup") {
  // A few questions, asked once. Needs no key: giving one is part of it.
  const S = await import("./setup.ts"); const sroot = resolve(arg("--cwd", process.cwd()));
  if (has("--show")) { console.log(S.describeDefaults(S.readConfig())); process.exit(0); }
  if (has("--reset")) { console.log(S.resetDefaults() ? "Your saved choices are forgotten. The address and the key stay." : "There were no saved choices."); process.exit(0); }
  const { planConfine, probeConfine } = await import("./confine.ts"); const { projectCheck, hasProgram } = await import("./checks.ts"); const { writeWorkflow, WORKFLOW_PATH } = await import("./action.ts");
  let onGithub = false; try { onGithub = /github\.com[:\/]/.test(readFileSync(join(sroot, ".git", "config"), "utf8")); } catch {}
  const io = S.terminalIO();
  const r = await S.runSetup({
    root: sroot, io, hasProgram, projectCheck: projectCheck(sroot, readJson(join(sroot, ".syok", "settings.json")))?.command || "",
    probe: (network) => { const plan = planConfine({ root: sroot, network }); return "problem" in plan ? plan.problem : probeConfine(plan); },
    canAddJob: onGithub && !existsSync(join(sroot, WORKFLOW_PATH)), addJob: () => writeWorkflow(sroot, false),
  });
  io.close();
  for (const n of r.notes) console.log("\nNote: " + n);
  const b2 = process.env.SYOK_BASE_URL || String(r.config.base || ""), k2 = process.env.SYOK_API_KEY || String(r.config.key || "");
  if (!b2 || !k2) { console.log("\nNot checked yet: the address or the key is still missing. Run syok setup again when you have them."); process.exit(1); }
  console.log("\nChecking that it works...\n");
  const { doctor, describeDoctor } = await import("./doctor.ts");
  const dr = await doctor({ base: b2, key: k2, root: sroot, model: String(r.config.defaults?.model || "syok-coder"), self: process.argv[1] || "" });
  console.log(describeDoctor(dr)); console.log(dr.ok ? "\nReady. Start with: syok" : "\nSaved, but something above needs fixing first. After fixing it, run: syok doctor");
  process.exit(dr.ok ? 0 : 1);
}
if (process.argv[2] === "github-action") {
  // Writes the workflow file that lets people write "@syok ..." in issues and pull requests. Needs no key.
  const { writeWorkflow } = await import("./action.ts"); const aroot = resolve(arg("--cwd", process.cwd()));
  const r = writeWorkflow(aroot, has("--force")); (r.ok ? console.log : console.error)(r.message); process.exit(r.ok ? 0 : 2);
}
if (process.argv[2] === "action") {
  // Runs inside GitHub Actions (see: syok github-action). A missing key is answered with a comment, so it is handled in there.
  const { runAction } = await import("./action.ts"); const aroot = resolve(arg("--cwd", process.cwd()));
  const m = arg("--model", "syok-coder");
  // In GitHub's cloud the keys of the job sit in the environment of this program and of the shell that started it. Removing
  // them from the AI's commands is not enough: a command could read them from the list of running programs. So the commands
  // are confined whenever this machine allows it (the workflow file installs what that needs).
  if (!has("--no-confine")) {
    const { planConfine, probeConfine, setConfine } = await import("./confine.ts");
    const plan = planConfine({ root: aroot }); const problem = "problem" in plan ? plan.problem : probeConfine(plan);
    if (problem) console.log("(Commands are NOT confined on this machine: " + problem.split("\n")[0].slice(0, 200) + " Keys are still removed from the commands' own environment.)");
    else { setConfine(plan as any); console.log(process.platform === "linux" ? "(Commands run confined: they cannot write outside the project or see other programs and their keys.)" : "(Commands run confined: they cannot write outside the project or read folders that hold keys.)"); }
  }
  const r = await runAction({
    run: realRun, log: (x) => console.log(x), env: { ...process.env, SYOK_BASE_URL: base, SYOK_API_KEY: key }, root: aroot,
    agent: async (task, o) => {
      const st = pluginSettings(aroot, readJson(join(aroot, ".syok", "settings.json"))); const pf = pickProfile(m, undefined, {});
      const c = makeCtx(aroot, "auto", async () => false, st, pf);
      c.web = { base, key, exaKey: process.env.EXA_API_KEY || undefined, state: {} };
      if (o.readOnly) c.allowed = READONLY;
      const res = await runAgent({ root: aroot, task, base, key, model: m, mode: "auto", settings: st, profile: pf, ctx: c, log: (x) => console.log(x) });
      c.bg.stopAll();
      return { summary: res.summary, stopped: res.stopped, touched: res.touched, usageLine: describeUsage(res.usage, st.prices), check: res.check };
    },
  });
  console.log("Result: " + r.did); process.exit(r.code);
}
if (process.argv[2] === "mcp") {
  // Signing in to hosted tool servers through the browser. Needs no Syok key.
  const A = await import("./mcp-auth.ts"); const mroot = resolve(arg("--cwd", process.cwd()));
  const servers = (readJson(join(mroot, ".syok", "settings.json")).mcpServers || {}) as Record<string, any>;
  const sub = process.argv[3], name = process.argv[4];
  if (sub !== "login" && sub !== "logout") { console.log(A.describeLogins(servers)); process.exit(0); }
  if (!name || name.startsWith("--") || !servers[name]) { console.error(name && !name.startsWith("--") ? `There is no tool server named ${name} in this project's .syok/settings.json.` : `Say which server: syok mcp ${sub} <name>`); console.error(A.describeLogins(servers)); process.exit(2); }
  if (sub === "logout") { console.log(A.logout(name, servers[name])); process.exit(0); }
  const { secretOf } = await import("./mcp.ts");
  const r = await A.login(name, { url: servers[name].url, oauth: servers[name].oauth ? { ...servers[name].oauth, client_secret: secretOf(servers[name]) } : undefined }, { log: (t) => console.log(t), openUrl: has("--no-browser") ? () => {} : undefined });
  console.log(r.message); process.exit(r.ok ? 0 : 1);
}
if (process.argv[2] === "confine") {
  // Windows only: confinement marks the project folder so that confined commands may write in it. "undo" removes the mark.
  const croot = resolve(arg("--cwd", process.cwd()));
  if (process.platform !== "win32") { console.log("On Linux and Mac, confinement leaves no mark on your folders, so there is nothing to undo. It is on by default; --no-confine switches it off for one run, and syok setup changes your everyday choice."); process.exit(0); }
  const W = await import("./confine-win.ts");
  if (process.argv[3] === "undo") { const r = W.undoWindows(croot, homedir()); console.log(r.message); process.exit(r.ok ? 0 : 1); }
  const marked = W.markedFolders(homedir());
  console.log(marked.length ? "Folders that confinement has marked so confined commands may write in them:\n" + marked.map((m) => "  " + m).join("\n") + "\nRemove the mark from this folder: syok confine undo" : "Confinement has marked no folder on this computer. Use it with: syok --confine");
  process.exit(0);
}
if (process.argv[2] === "agents") {
  // Lists the custom helpers found for this project. Needs no key.
  const { loadAgents, describeAgents } = await import("./agents.ts");
  console.log(describeAgents(loadAgents(resolve(arg("--cwd", process.cwd()))))); process.exit(0);
}
if (process.argv[2] === "doctor") {
  // A health check. It runs with a missing address or key too, because finding that is its job.
  const { doctor, describeDoctor } = await import("./doctor.ts");
  const r = await doctor({ base, key, root: resolve(arg("--cwd", process.cwd())), model: arg("--model", mine.model || "syok-coder"), self: process.argv[1] || "" });
  console.log(JSON_OUT ? JSON.stringify(r) : describeDoctor(r)); process.exit(r.ok ? 0 : 1);
}
if (!base || !key) { console.error("Syok Code has no address or key yet. Run: syok setup   (a few questions, asked once). To see what is missing: syok doctor"); process.exit(2); }
const root = resolve(arg("--cwd", process.cwd()));
let model = arg("--model", mine.model || "syok-coder"), mode = arg("--mode", mine.mode || "ask") as Mode;
if (!MODES.includes(mode)) { console.error("Unknown mode. Use one of: " + MODES.join(", ")); process.exit(2); }
const table = existsSync(join(root, "profiles.json")) ? readJson(join(root, "profiles.json")) : {};
const settings = applyDefaults(pluginSettings(root, readJson(join(root, ".syok", "settings.json"))), mine);
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
const cleanup = () => { ctx.bg.stopAll(); ctx.mcp.forEach((x) => x.stop()); cleanupParallel(); };
process.on("exit", cleanup); process.on("SIGINT", () => { cleanup(); process.exit(130); });
const onToken = !JSON_OUT && !has("--no-stream") ? (s: string) => process.stdout.write(s) : undefined;
ctx.web = { base, key, exaKey: process.env.EXA_API_KEY || undefined, state: {} };
if (has("--no-web")) settings.web = false;
if (arg("--workers")) settings.parallel_workers = Math.floor(+arg("--workers")) || 0;
if (has("--no-checks")) settings.checks = false;
// What this whole session used (every task, skill and helper added up); shown by /usage and after each task.
const sessionUsage = emptyUsage();
let lastSummary = ""; // what the last task ended with: sent along by /cloud as notes
function report(r: Result, extra = ""): string {
  mergeUsage(sessionUsage, r.usage);
  const chk = r.check ? (r.check.passed === true ? `; project check passed (${r.check.command})` : r.check.passed === false ? `; PROJECT CHECK STILL FAILING (${r.check.command})` : `; project check not run (${r.check.command})`) : "";
  return `(${r.steps} steps, files changed: ${r.touched.join(", ") || "none"}${extra}${chk})\n(${describeUsage(r.usage, settings.prices)})`;
}
{
  // Hold the AI's commands inside the project folder.
  //  - Asked for (a flag, or "confine" in your settings): if it cannot be done on this computer, stop. Never run unconfined silently.
  //  - Not asked for: on Linux and Mac it is on anyway, unless you answered "off" in syok setup or add --no-confine.
  //    If it cannot be done then, say so once and carry on. On Windows it is never on by itself, because it marks the project folder.
  const asked = has("--confine") || has("--confine-no-network") || !!settings.confine;
  const byDefault = !asked && mine.confine !== false && (process.platform === "linux" || process.platform === "darwin");
  if (!has("--no-confine") && (asked || byDefault)) {
    const { planConfine, probeConfine, setConfine, describeConfine } = await import("./confine.ts");
    const plan = planConfine({ root, network: !(has("--confine-no-network") || settings.confine === "no-network") });
    const problem = "problem" in plan ? plan.problem : probeConfine(plan);
    if (problem && asked) { console.error(problem + (has("--confine") || has("--confine-no-network") ? "" : "\nConfinement is on in your settings. To run without it this once, add --no-confine.")); process.exit(2); }
    if (problem) { if (!JSON_OUT) console.error("(Commands are NOT confined here: " + problem.split("\n")[0].replace(/^--confine /, "confinement ").slice(0, 220) + " More: syok doctor. To stop this notice: answer \"off\" in syok setup, or add --no-confine.)"); }
    else { setConfine(plan as any); if (!JSON_OUT) console.error(describeConfine(plan as any) + (byDefault ? " (On by default; --no-confine switches it off for one run.)" : "")); }
  }
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
    history = r.messages; lastSummary = r.summary || lastSummary; persist();
    console.log("\n" + r.summary + "\n" + report(r));
  } catch (e: any) { console.log("Error: " + e.message); }
}
async function readStdin(): Promise<string> { const ch: Buffer[] = []; for await (const c of process.stdin) ch.push(c as Buffer); return Buffer.concat(ch).toString("utf8").trim(); }
const VALUE_FLAGS = new Set(["--lang", "--to", "--out", "--cwd", "--model", "--mode", "--profile", "--max-steps", "-p", "--task-file"]);
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
if (process.argv[2] === "cloud") {
  const { sendToCloud } = await import("./cloud.ts");
  const task = process.argv.slice(3).filter((x, i, all) => !x.startsWith("--") && !VALUE_FLAGS.has(all[i - 1] ?? "")).join(" ").trim();
  const r = await sendToCloud({ task, run: realRun, cwd: root, approve: mode === "auto" ? async () => true : ask });
  (r.ok ? console.log : console.error)(r.message); rl?.close(); process.exit(r.ok ? 0 : 1);
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
// --task-file: the task is read from a file (and the file removed). Used by the editor extension so that no character of the task passes through a shell.
const taskFile = arg("--task-file");
if (taskFile) {
  try { prompt = readFileSync(taskFile, "utf8").trim(); } catch (e: any) { console.error("Could not read the task file " + taskFile + ": " + e.message); process.exit(2); }
  try { rmSync(taskFile, { force: true }); } catch {}
  if (!prompt) { console.error("The task file is empty."); process.exit(2); }
}
// --stay: after the task, stay in the chat instead of exiting (needs a terminal).
const stay = has("--stay") && !!rl && !JSON_OUT;
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
  history = r.messages; lastSummary = r.summary || lastSummary; persist();
  if (JSON_OUT) console.log(JSON.stringify({ summary: r.summary, session: sessionId, steps: r.steps, tokens: r.tokens, touched: r.touched, stopped: r.stopped, ranTests: r.ranTests, commands: r.commands, declined: r.declined, usage: r.usage, check: r.check ?? null }));
  else console.log("\n" + r.summary + "\n" + report(r));
  if (!stay) { rl?.close(); process.exit(r.stopped === "finished" || r.stopped === "answered" ? 0 : 1); }
  ctx.allowed = undefined;
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
    try { const r = await runAgent({ root, task: b.task, base, key, model, mode, ask, settings, profile, ctx, log, history, onToken }); history = r.messages; lastSummary = r.summary || lastSummary; persist(); console.log("\n" + r.summary + `\n(${r.steps} steps, files changed: ${r.touched.join(", ") || "none"})`); }
    catch (e: any) { console.log("Error: " + e.message); } finally { ctx.allowed = undefined; }
    continue;
  }
  if (line === "/cloud" || line.startsWith("/cloud ")) {
    const { sendToCloud } = await import("./cloud.ts");
    const r = await sendToCloud({ task: line.slice(6).trim(), notes: lastSummary, run: realRun, cwd: root, approve: ask });
    console.log(r.message); continue;
  }
  if (line === "/agents") { const { describeAgents } = await import("./agents.ts"); console.log(describeAgents(ctx.agents || [])); continue; }
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
    try { const r = await runSkill(found, skRest, history); history = r.messages; lastSummary = r.summary || lastSummary; persist(); console.log("\n" + r.summary + "\n" + skillReport(found, r)); } catch (e: any) { console.log("Error: " + e.message); }
    continue;
  }
  await turn(line);
}
rl.close();
