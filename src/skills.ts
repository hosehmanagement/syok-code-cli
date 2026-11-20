// Skills: a SKILL.md file of instructions the AI follows, including commands it runs itself.
// Looked for in: <project>/.syok/skills, <project>/.claude/skills (Claude-style skills work as they are), installed plugins,
// ~/.syok/skills and ~/.claude/skills. A skill is either <dir>/<name>/SKILL.md or <dir>/<name>.md.
// The first one found wins: the project's own, then plugins, then the home folder. A plugin's skill can always be named
// <plugin>:<skill>, as in Claude Code.
// Like Claude Code, the AI is shown each skill's name and description and opens one by itself when it fits (the "skill"
// tool), unless the skill says disable-model-invocation: true. You can also start one yourself with /<skill>.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pluginDirs, pluginDir } from "./plugins.ts";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface Skill {
  name: string; description: string; body: string; file: string; source: "project" | "home";
  /** The skill's own folder (scripts/ and references/ it mentions are in it). */
  dir: string;
  /** The plugin it came with, and that plugin's folder (${CLAUDE_PLUGIN_ROOT}). */
  plugin?: string; pluginRoot?: string;
  /** false when the skill says disable-model-invocation: true (only the user can start it). */
  modelInvocable: boolean;
  argumentHint?: string;
  /** Command prefixes the skill asks to run without asking each time (from allowed-tools: Bash(npm test:*)). */
  allowed: string[];
  /** Commands the skill's own text shows in code blocks (for the user to read before it runs). */
  commands: string[];
  /** True when the skill is about running commands, so finishing without running any is not acceptable. */
  needsRun: boolean;
}

const FENCE = /^```[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)^```/gm;
const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "terminal", "powershell", "ps1", "pwsh", "cmd", "bat"]);
const NEEDS_CMD_WORDS = /\b(run|execute|install|build|compile|deploy|lint|format|migrate|start the server|npm|npx|pnpm|yarn|bun|pip|pytest|cargo|go (?:test|build|run)|make|docker|git (?:commit|push|pull|clone|checkout)|curl|kubectl|terraform)\b/gi;

export const safeName = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

/** Split the --- front matter off the top. Simple "key: value" lines are read, and values continued on indented lines. */
export function splitFront(text: string): { meta: Record<string, string>; body: string } {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { meta: {}, body: t };
  const meta: Record<string, string> = {};
  let key = "";
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    // "key: >-" and "key: |" start a value written on the following indented lines; the marker itself is not part of the value.
    if (kv) { key = kv[1].toLowerCase(); const v = kv[2].trim(); meta[key] = /^[>|][+-]?\d*$/.test(v) ? "" : v.replace(/^["']|["']$/g, ""); }
    else if (key && /^\s+(-\s+)?\S/.test(line)) meta[key] = (meta[key] + " " + line.replace(/^\s+(-\s+)?/, "")).trim();
  }
  return { meta, body: t.slice(m[0].length) };
}

/** allowed-tools: Bash(npm test:*), Bash(git status)  ->  ["npm test", "git status"] */
export function parseAllowed(v: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (v || "").matchAll(/Bash\(([^)]*)\)/gi)) {
    const p = m[1].trim().replace(/:\*$/, "").replace(/\s*\*$/, "").trim();
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

/** Commands shown in the skill's code blocks (shell blocks, or lines starting with "$ "). */
export function findCommands(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(FENCE)) {
    const lang = (m[1] || "").toLowerCase();
    if (lang && !SHELL_LANGS.has(lang)) continue;
    for (let line of m[2].split("\n")) {
      line = line.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      if (!lang && !/^\$\s/.test(line)) continue;
      out.push(line.replace(/^\$\s+/, "").slice(0, 300));
    }
  }
  return [...new Set(out)].slice(0, 40);
}

export function parseSkill(text: string, fallbackName: string, file = "", source: "project" | "home" = "project"): Skill {
  const { meta, body } = splitFront(text);
  const name = safeName(meta.name || fallbackName) || "skill";
  const commands = findCommands(body);
  const allowed = parseAllowed(meta["allowed-tools"] || meta.allowed_tools || meta.allowedtools);
  const words = (body.match(NEEDS_CMD_WORDS) || []).length;
  const explicit = /^(true|yes|run)$/i.test(meta["syok-run"] || meta.run || "");
  return {
    name, description: (meta.description || firstLine(body)).slice(0, 300), body: body.trim(), file, source, allowed, commands,
    dir: file ? dirname(file) : "", modelInvocable: !/^(true|yes)$/i.test(meta["disable-model-invocation"] || ""),
    ...(meta["argument-hint"] ? { argumentHint: meta["argument-hint"].slice(0, 120) } : {}),
    needsRun: explicit || commands.length > 0 || allowed.length > 0 || words >= 4,
  };
}
const firstLine = (b: string) => (b.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) || "").slice(0, 200);

function readDir(dir: string, source: "project" | "home", into: Map<string, Skill>, plugin?: { name: string; root: string }) {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names.sort()) {
    const p = join(dir, n);
    try {
      let file = "", fallback = n;
      if (statSync(p).isDirectory()) { file = join(p, "SKILL.md"); if (!existsSync(file)) continue; }
      else if (/\.md$/i.test(n)) { file = p; fallback = n.replace(/\.md$/i, ""); }
      else continue;
      const sk = parseSkill(readFileSync(file, "utf8"), fallback, file, source);
      if (plugin) { sk.plugin = plugin.name; sk.pluginRoot = plugin.root; into.set(plugin.name + ":" + sk.name, sk); }
      if (!into.has(sk.name)) into.set(sk.name, sk);
    } catch { /* unreadable skill: skip it */ }
  }
}

/** All skills the user has: the project's own first, then installed plugins, then the home folder.
 *  A plugin's skills are also listed as <plugin>:<skill>. Use uniqueSkills() to list each skill once. */
export function loadSkills(root: string, home = homedir()): Map<string, Skill> {
  const m = new Map<string, Skill>();
  readDir(join(root, ".syok", "skills"), "project", m);
  readDir(join(root, ".claude", "skills"), "project", m);
  for (const p of pluginDirs(root, home)) readDir(join(p, "skills"), p.startsWith(join(home, ".syok")) ? "home" : "project", m, { name: basename(p), root: p });
  readDir(join(home, ".syok", "skills"), "home", m);
  readDir(join(home, ".claude", "skills"), "home", m);
  return m;
}
/** Each skill once (the map also holds <plugin>:<skill> names). */
export const uniqueSkills = (m: Map<string, Skill>): Skill[] => [...new Set(m.values())];
/** The name to show: plain when that name leads to this skill, else <plugin>:<skill>. */
export const skillLabel = (m: Map<string, Skill>, sk: Skill): string => (m.get(sk.name) === sk || !sk.plugin ? sk.name : sk.plugin + ":" + sk.name);

/** Fills in what Claude Code fills in: the plugin's folder, the skill's folder and the arguments. */
export function expandVars(text: string, v: { pluginRoot?: string; skillDir?: string; args?: string; projectDir?: string; positional?: boolean }): string {
  let t = text;
  const sub = (names: string[], val: string | undefined) => { if (val === undefined) return; for (const n of names) t = t.split("${" + n + "}").join(val).replace(new RegExp("\\$" + n + "(?![A-Za-z0-9_])", "g"), () => val); };
  sub(["CLAUDE_PLUGIN_ROOT", "SYOK_PLUGIN_ROOT"], v.pluginRoot);
  sub(["CLAUDE_SKILL_DIR"], v.skillDir);
  sub(["CLAUDE_PROJECT_DIR"], v.projectDir);
  if (v.skillDir !== undefined) t = t.split("{{skill_dir}}").join(v.skillDir);
  if (v.args !== undefined) {
    const parts = splitArgs(v.args);
    t = t.replace(/\$\{ARGUMENTS:-([^}]*)\}/g, (_, d) => v.args || d).replace(/\$ARGUMENTS\[(\d+)\]/g, (_, i) => parts[+i] ?? "").replace(/\$ARGUMENTS\b/g, () => v.args!);
    // $0, $1 ... only in slash commands: in a skill they are far more often part of a shell or awk example.
    // Claude Code now counts from $0; older commands count from $1. A command that uses $0 counts from 0, others from 1.
    if (v.positional) { const from0 = /\$0(?![\d])/.test(t); t = t.replace(/\$(\d)(?![\d])/g, (all, i) => (from0 ? parts[+i] ?? "" : +i >= 1 ? parts[+i - 1] ?? "" : all)); }
  }
  return t;
}
/** Paths that point into Claude Code's own plugin folders, turned into the plugin's folder here (when it is installed):
 *  $(cc-plugin-root <plugin>), ~/.claude/plugins/marketplaces/<market>/plugins/<plugin> and ~/.claude/plugins/cache/<market>/<plugin>/<version>. */
export function claudePaths(text: string, find: (plugin: string) => string | null): string {
  const home = "(?:~|\\$HOME|\\$\\{HOME\\})";
  return text
    .replace(/\$\(\s*cc-plugin-root\s+([a-z0-9][\w.-]*)\s*\)/g, (all, p) => find(p) ?? all)
    .replace(new RegExp(home + "/\\.claude/plugins/marketplaces/[^/\\s\"'`]+/plugins/([a-z0-9][\\w.-]*)", "g"), (all, p) => find(p) ?? all)
    .replace(new RegExp(home + "/\\.claude/plugins/cache/[^/\\s\"'`]+/([a-z0-9][\\w.-]*)/[^/\\s\"'`]+", "g"), (all, p) => find(p) ?? all);
}
const CLAUDE_TOOLS_RE = /\b(AskUserQuestion|TodoWrite|TodoRead|WebFetch|WebSearch|Task\(|Skill\()/;
const CLAUDE_TOOLS_NOTE = "(This skill was written for Claude Code. Its tool names mean, here: AskUserQuestion = ask the user in your reply, or if you must keep going, take the sensible default and say so; TodoWrite/TodoRead = keep a short checklist in your messages; Task or Agent = the delegate tool; Skill(plugin:name) or /plugin:name = the skill tool with that name; Read, Write, Edit, Grep, Glob, Bash = read_file, write_file, edit_file, search, find_files, run_command; WebFetch, WebSearch = web_fetch, web_search.)";

/** "a 'b c' d" -> ["a", "b c", "d"] */
export function splitArgs(s: string): string[] {
  const out: string[] = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
/** "!`git status`" in a skill or command means "run this first" in Claude Code. Syok Code asks the AI to run it, with the usual permission. */
export const inlineRuns = (text: string): string => text.replace(/!`([^`\n]+)`/g, (_, c) => "`" + c + "` (run this command first with run_command and use its output)");

/** The skill's text as the AI reads it: variables filled in, and where its files are. */
export function skillText(sk: Skill, args = "", projectDir?: string): string {
  let body = inlineRuns(expandVars(sk.body, { pluginRoot: sk.pluginRoot, skillDir: sk.dir, args, projectDir }));
  if (projectDir) body = claudePaths(body, (p) => pluginDir(p, projectDir));
  if (CLAUDE_TOOLS_RE.test(body)) body = CLAUDE_TOOLS_NOTE + "\n\n" + body;
  return (sk.dir ? `Base directory for this skill: ${sk.dir}\n(Paths such as scripts/, references/ or assets/ in it are inside that folder. Run its scripts from there by full path; your own work stays in the project folder.)\n\n` : "") + body;
}

/** The short list the AI sees, so it can open a fitting skill itself. Kept small: names and one line each. */
export function skillCatalog(m: Map<string, Skill>, maxChars = 8000): string {
  const list = uniqueSkills(m).filter((s) => s.modelInvocable);
  if (!list.length) return "";
  const lines: string[] = []; let n = 0;
  for (const s of list) { const l = `- ${skillLabel(m, s)}: ${s.description.replace(/\s+/g, " ").slice(0, 250)}`; if (n + l.length > maxChars) { lines.push(`- ...and ${list.length - lines.length} more: call the skill tool with name "list" to see them all`); break; } lines.push(l); n += l.length + 1; }
  return "\n\nSkills you can use (instructions written for tasks like these). When the user's task matches one, call the skill tool with its name FIRST, then follow what it says; it may tell you to run scripts from its own folder. Do not use a skill that does not fit.\n" + lines.join("\n");
}

/** A github.com page address (or owner/repo/path) turned into the raw file address. */
export function rawUrl(src: string): string {
  const s = src.trim();
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/.exec(s);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/.exec(s);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4].replace(/\/+$/, "")}/SKILL.md`;
  if (/^https?:\/\//.test(s)) return s;
  m = /^([\w.-]+)\/([\w.-]+)\/(.+)$/.exec(s);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/${/\.md$/i.test(m[3]) ? m[3] : m[3].replace(/\/+$/, "") + "/SKILL.md"}`;
  return "";
}

/** Download a SKILL.md and save it in <project>/.syok/skills/<name>/SKILL.md. Nothing in it is run until you start the skill. */
export async function addSkill(root: string, src: string, f: typeof fetch = fetch): Promise<{ ok: boolean; message: string; name?: string }> {
  const local = existsSync(src) && statSync(src).isFile();
  const url = local ? "" : rawUrl(src);
  if (!local && !url) return { ok: false, message: "Give a github.com link to a SKILL.md, owner/repo/path, or a file on this computer." };
  let text = "";
  try {
    if (local) text = readFileSync(src, "utf8");
    else { const r = await f(url); if (!r.ok) return { ok: false, message: `Could not download it (${r.status}). Check the address: ${url}` }; text = await r.text(); }
  } catch (e: any) { return { ok: false, message: "Could not download it: " + (e?.message || e) }; }
  if (text.length > 200_000) return { ok: false, message: "That file is too big to be a skill (over 200 KB)." };
  if (!text.trim()) return { ok: false, message: "That file is empty." };
  const tail = (local ? src : url).replace(/[\\/]SKILL\.md$/i, "").split(/[\\/]/).pop() || "skill";
  const sk = parseSkill(text, tail.replace(/\.md$/i, ""));
  const dir = join(root, ".syok", "skills", sk.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
  return { ok: true, name: sk.name, message: `Added skill "${sk.name}"${sk.commands.length ? ` (it mentions ${sk.commands.length} command${sk.commands.length === 1 ? "" : "s"}; you will see them before it runs)` : ""}.` };
}

/** What the user reads before a skill starts. */
export function preview(sk: Skill): string {
  const L = [`Skill: ${sk.name}${sk.description ? " - " + sk.description : ""}`];
  if (sk.commands.length) L.push("Commands it mentions:", ...sk.commands.slice(0, 12).map((c) => "  " + c), ...(sk.commands.length > 12 ? [`  ...and ${sk.commands.length - 12} more`] : []));
  else L.push(sk.needsRun ? "It is about running commands, but names none up front." : "It names no commands; it is guidance for the AI.");
  if (sk.allowed.length) L.push("It asks to run these without asking each time: " + sk.allowed.join(", "));
  return L.join("\n");
}

/** The task text the AI receives: do it now, run commands yourself, follow the skill. */
export function buildSkillTask(sk: Skill, request: string, root?: string): string {
  const need = sk.needsRun
    ? "This skill is about running commands. Run the commands it needs yourself with run_command, one at a time, read each result, and fix problems and continue. Do not only describe commands and do not ask the user to run them."
    : "Follow the skill's method.";
  // Skill files written for a command-line tool are sometimes out of date with the tool that is really installed.
  const tool = "The installed program is the truth, not this text. If a command from the skill fails with \"No such command\", \"no such option\" or a usage message, do not retry variations by guessing: run the tool's own --help, then the --help of the exact subcommand, and follow what they print. In a usage line like \"tool [OPTIONS] COMMAND [ARGS]\", the options listed for the tool itself (for example --project or --json) go BEFORE the command name, and each command is a fresh start: a tool that needs a file or project must be given it again on every command.";
  return [
    `Run the skill "${sk.name}" now.`,
    request ? `What the user wants: ${request}` : "The user gave no extra details: use the project folder and sensible defaults, and do not stop to ask.",
    need,
    ...(sk.needsRun ? [tool] : []),
    "If a command is blocked or the user says no, say exactly which command and why in your final summary. Never claim you ran something you did not.",
    "",
    `=== Skill: ${sk.name} ===`,
    skillText(sk, request, root).slice(0, 24_000),
    "=== End of skill ===",
  ].join("\n");
}

/** Nudge text when the AI finishes without running a single command. */
export const MUST_RUN_NUDGE = "You finished without running any command, but this skill needs real commands run. Run them now with run_command. If you truly cannot (the user declined, or the command is blocked), call finish again and name the exact command and the reason.";
