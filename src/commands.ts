import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pluginDirs } from "./plugins.ts";
import { expandVars, inlineRuns } from "./skills.ts";

/** Your own slash commands: a Markdown file in .syok/commands (or .claude/commands, or ~/.syok/commands) becomes /name. */
export interface Cmd { name: string; description: string; body: string; source: string; /** The plugin folder it came from (${CLAUDE_PLUGIN_ROOT}). */ pluginRoot?: string; argumentHint?: string }
export function parseFront(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const l of m[1].split(/\r?\n/)) { const k = /^([\w-]+):\s*(.*)$/.exec(l); if (k) meta[k[1]] = k[2].replace(/^["']|["']$/g, ""); }
  return { meta, body: m[2] };
}
function readDir(dir: string, source: string, out: Map<string, Cmd>, pluginRoot?: string) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (!/\.md$/i.test(f)) continue;
    const name = f.replace(/\.md$/i, "").toLowerCase(); if (!/^[\w-]+$/.test(name)) continue;
    try {
      const { meta, body } = parseFront(readFileSync(join(dir, f), "utf8"));
      const c: Cmd = { name, description: meta.description || body.trim().split("\n")[0].slice(0, 80), body: body.trim(), source, ...(pluginRoot ? { pluginRoot } : {}), ...(meta["argument-hint"] ? { argumentHint: meta["argument-hint"] } : {}) };
      // A plugin's command can always be called /<plugin>:<command>, as in Claude Code.
      if (pluginRoot) out.set(basename(pluginRoot) + ":" + name, c);
      out.set(name, c);
    } catch {}
  }
}
export function loadCommands(root: string, home = homedir()): Map<string, Cmd> {
  const m = new Map<string, Cmd>();
  for (const p of pluginDirs(root, home)) readDir(join(p, "commands"), "plugin", m, p);
  readDir(join(home, ".syok", "commands"), "home", m);
  readDir(join(root, ".claude", "commands"), "project", m);
  readDir(join(root, ".syok", "commands"), "project", m);
  return m;
}
export function renderCommand(c: Cmd, args: string): string {
  const uses = /\$ARGUMENTS|\$[1-9]/.test(c.body);
  const body = inlineRuns(expandVars(c.body, { pluginRoot: c.pluginRoot, args, positional: true }));
  return uses ? body : body + (args ? "\n\nArguments: " + args : "");
}
export function describeCommands(m: Map<string, Cmd>): string {
  if (!m.size) return "No custom commands yet. Create .syok/commands/review.md (first line = what it does; use $ARGUMENTS for what you type after /review).";
  return [...m.entries()].filter(([k, c]) => k === c.name || (k.includes(":") && m.get(c.name) !== c)).map(([k, c]) => ({ ...c, name: k })).map((c) => "  /" + c.name + (c.source === "plugin" ? "  (plugin)" : c.source === "home" ? "  (yours, all projects)" : "") + " - " + c.description).join("\n");
}
