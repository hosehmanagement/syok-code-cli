// Custom named helpers ("agents"): one small text file per helper, with its own instructions and the tools it may use.
// Syok's own files live in .syok/agents/<name>.md. Files already written for Claude Code (.claude/agents/<name>.md) and for
// GitHub Copilot (.github/agents/<name>.agent.md) are read too, so nothing has to be rewritten.
// A helper file can only NARROW what a helper may do. The permission mode and the questions you are asked stay the same.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pluginDirs } from "./plugins.ts";
import { splitFront, safeName } from "./skills.ts";
import { READONLY, TOOLS, WEB_TOOLS } from "./tools.ts";

export interface Agent { name: string; description: string; prompt: string; allowed?: Set<string>; readOnly: boolean; from: string; file: string; unknownTools: string[] }

const EDIT = ["edit_file", "write_file"], RUN = ["run_command", "bg_start", "bg_output", "bg_stop", "job_start", "job_output", "job_stop"], READ = ["list_files", "read_file", "search", "find_files", "find_symbol", "outline"], WEB = ["web_search", "web_fetch"];
// Tool names as other tools write them (Claude Code's capitalised names, Copilot's short groups), in Syok's own names.
const ALIAS: Record<string, string[]> = {
  read: READ, ls: ["list_files"], glob: ["find_files"], grep: ["search", "find_symbol"], search: ["search", "find_files", "find_symbol", "outline"], codebase: READ, notebookread: ["read_file"],
  edit: EDIT, multiedit: ["edit_file"], write: ["write_file"], notebookedit: ["edit_file"], editfiles: EDIT,
  bash: RUN, shell: RUN, execute: RUN, terminal: RUN, runcommands: RUN, bashoutput: ["bg_output"], killshell: ["bg_stop"], killbash: ["bg_stop"],
  websearch: ["web_search"], webfetch: ["web_fetch"], web: WEB, fetch: ["web_fetch"],
};
let own: Set<string> | null = null; const OWN = { has: (n: string) => (own ||= new Set(TOOLS.map((t: any) => t.function.name as string))).has(n) }; // built on first use: this file and tools.ts load each other
/** Turn the "tools" line of a helper file into Syok tool names. Unknown names are reported, never guessed. */
export function parseTools(raw: string): { allowed: Set<string>; unknown: string[] } {
  const allowed = new Set<string>(["finish"]); const unknown: string[] = [];
  for (const part of raw.replace(/[\[\]"']/g, " ").split(/[,\n]|\s-\s|^\s*-\s/m)) {
    const word = part.trim().replace(/^-\s*/, "").replace(/\(.*\)$/, "").trim(); if (!word) continue; // "Bash(git:*)" counts as Bash
    for (const w of word.split(/\s+/)) {
      const k = w.toLowerCase().replace(/[^a-z_]/g, "");
      if (!k) continue;
      if (OWN.has(w) && w !== "delegate") allowed.add(w);
      else if (ALIAS[k]) ALIAS[k].forEach((t) => allowed.add(t));
      else if (k !== "delegate" && k !== "task" && k !== "agent" && k !== "todowrite" && k !== "todoread") unknown.push(w);
    }
  }
  return { allowed, unknown };
}
export function parseAgent(text: string, fallbackName: string, from: string, file: string): Agent | null {
  const { meta, body } = splitFront(text);
  const name = safeName(meta.name || fallbackName); const prompt = body.trim();
  if (!name || !prompt || ["explorer", "worker"].includes(name)) return null; // the two built-in roles cannot be replaced
  let allowed: Set<string> | undefined; let unknownTools: string[] = [];
  const truthy = (v?: string) => /^(true|yes|1)$/i.test((v || "").trim());
  if (meta.tools !== undefined && meta.tools.trim() && meta.tools.trim() !== "*") { const p = parseTools(meta.tools); allowed = p.allowed; unknownTools = p.unknown; }
  if (truthy(meta.readonly) || truthy(meta["read-only"]) || truthy(meta.read_only)) { const ro = new Set<string>([...READONLY]); if (allowed) for (const t of [...ro]) { if (!allowed.has(t)) ro.delete(t); } allowed = ro; allowed.add("finish"); }
  const readOnly = !!allowed && [...allowed].every((t) => READONLY.has(t) || WEB_TOOLS.has(t));
  return { name, description: (meta.description || "").replace(/\s+/g, " ").trim().slice(0, 300), prompt: prompt.slice(0, 20_000), allowed, readOnly, from, file, unknownTools };
}
/** Every helper file found, nearest first: the project's own files win over the home folder's, Syok's over the others'. */
export function loadAgents(root: string, home = homedir()): Agent[] {
  const places: [string, string, RegExp][] = [
    [join(root, ".syok", "agents"), "project", /\.md$/i], [join(root, ".claude", "agents"), "project (Claude Code file)", /\.md$/i], [join(root, ".github", "agents"), "project (Copilot file)", /\.agent\.md$/i],
    [join(home, ".syok", "agents"), "home folder", /\.md$/i], [join(home, ".claude", "agents"), "home folder (Claude Code file)", /\.md$/i],
    // Helpers that came with installed plugins come last (in Claude Code too, plugin helpers lose name clashes).
    ...pluginDirs(root, home).map((p): [string, string, RegExp] => [join(p, "agents"), "plugin " + basename(p), /\.md$/i]),
  ];
  const out: Agent[] = []; const seen = new Set<string>();
  for (const [dir, from, re] of places) {
    let names: string[] = []; try { names = readdirSync(dir).sort(); } catch { continue; }
    for (const f of names) {
      if (!re.test(f)) continue; const file = join(dir, f);
      try { if (!statSync(file).isFile() || statSync(file).size > 200_000) continue; const a = parseAgent(readFileSync(file, "utf8"), f.replace(/(\.agent)?\.md$/i, ""), from, file); if (a && !seen.has(a.name)) { seen.add(a.name); out.push(a); } } catch {}
    }
    if (out.length >= 30) break;
  }
  return out.slice(0, 30);
}
export function describeAgents(list: Agent[]): string {
  if (!list.length) return "No custom helpers yet. Create one as .syok/agents/<name>.md:\n\n---\ndescription: Reviews changes for bugs\ntools: read, search\n---\nYou are a careful reviewer. Read the files you are pointed to and report real bugs with file and line.\n\nFiles made for Claude Code (.claude/agents) and GitHub Copilot (.github/agents/*.agent.md) are picked up as they are.";
  return list.map((a) => `  ${a.name}  [${a.allowed ? (a.readOnly ? "read-only" : "limited tools: " + [...a.allowed].filter((t) => t !== "finish").join(", ")) : "all tools"}]  ${a.description || "(no description)"}\n      from: ${a.from}${a.unknownTools.length ? "\n      not understood in its tools line (left out): " + a.unknownTools.join(", ") : ""}`).join("\n");
}
/** The lines added to the delegate tool's description so the AI knows which helpers exist. */
export function agentsHint(list: Agent[]): string {
  if (!list.length) return "";
  return " The user also defined these helpers; use one by giving its name as role: " + list.map((a) => `'${a.name}' (${a.readOnly ? "read-only" : "may change things"}${a.description ? ": " + a.description.slice(0, 160) : ""})`).join("; ") + ".";
}
export const agentSystem = (a: Agent) => `You are "${a.name}", a helper for Syok Code. Follow these instructions from the user's helper file:\n\n${a.prompt}\n\nDo only the sub-task you were given. When done call finish with a compact answer (exact file paths with line numbers where it helps). ${a.readOnly ? "You cannot change anything." : "Make the smallest change that solves it and run the relevant check."}`;
