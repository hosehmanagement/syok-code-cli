// Skills: a SKILL.md file of instructions the AI follows, including commands it runs itself.
// Looked for in: <project>/.syok/skills, <project>/.claude/skills (Claude-style skills work as they are), ~/.syok/skills.
// A skill is either <dir>/<name>/SKILL.md or <dir>/<name>.md. A project skill beats a home-folder skill with the same name.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Skill {
  name: string; description: string; body: string; file: string; source: "project" | "home";
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

/** Split the --- front matter off the top. Only simple "key: value" lines are read. */
export function splitFront(text: string): { meta: Record<string, string>; body: string } {
  const t = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { meta: {}, body: t };
  const meta: Record<string, string> = {};
  let key = "";
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) { key = kv[1].toLowerCase(); meta[key] = kv[2].trim().replace(/^["']|["']$/g, ""); }
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
    needsRun: explicit || commands.length > 0 || allowed.length > 0 || words >= 4,
  };
}
const firstLine = (b: string) => (b.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) || "").slice(0, 200);

function readDir(dir: string, source: "project" | "home", into: Map<string, Skill>) {
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
      if (!into.has(sk.name)) into.set(sk.name, sk);
    } catch { /* unreadable skill: skip it */ }
  }
}

/** All skills the user has, project first. */
export function loadSkills(root: string, home = homedir()): Map<string, Skill> {
  const m = new Map<string, Skill>();
  readDir(join(root, ".syok", "skills"), "project", m);
  readDir(join(root, ".claude", "skills"), "project", m);
  readDir(join(home, ".syok", "skills"), "home", m);
  return m;
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
export function buildSkillTask(sk: Skill, request: string): string {
  const need = sk.needsRun
    ? "This skill is about running commands. Run the commands it needs yourself with run_command, one at a time, read each result, and fix problems and continue. Do not only describe commands and do not ask the user to run them."
    : "Follow the skill's method.";
  return [
    `Run the skill "${sk.name}" now.`,
    request ? `What the user wants: ${request}` : "The user gave no extra details: use the project folder and sensible defaults, and do not stop to ask.",
    need,
    "If a command is blocked or the user says no, say exactly which command and why in your final summary. Never claim you ran something you did not.",
    "",
    `=== Skill: ${sk.name} ===`,
    sk.body.slice(0, 24_000),
    "=== End of skill ===",
  ].join("\n");
}

/** Nudge text when the AI finishes without running a single command. */
export const MUST_RUN_NUDGE = "You finished without running any command, but this skill needs real commands run. Run them now with run_command. If you truly cannot (the user declined, or the command is blocked), call finish again and name the exact command and the reason.";
