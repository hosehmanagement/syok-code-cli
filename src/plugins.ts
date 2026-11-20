import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Settings } from "./perm.ts";
/** Where a plugin may keep its own data between runs (Claude's ${CLAUDE_PLUGIN_DATA}). */
export const pluginDataDir = (plugin: string, home = homedir()) => join(home, ".syok", "plugin-data", plugin.replace(/[^\w.-]+/g, "-") || "plugin");

/** ${NAME} filled in everywhere inside a tool server's settings (command, args, env, url, headers). Other ${...} are left for later. */
function fillVars(v: unknown, vars: Record<string, string>): unknown {
  if (typeof v === "string") { let t = v; for (const [k, x] of Object.entries(vars)) t = t.split("${" + k + "}").join(x); return t; }
  if (Array.isArray(v)) return v.map((x) => fillVars(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillVars(x, vars)]));
  return v;
}

/** A plugin is a folder (or GitHub repository) that bundles skills/, commands/ and an optional settings.json (hooks, tool servers). */
export interface Plugin { name: string; dir: string; description: string; scope: "project" | "home"; skills: number; commands: number }
const roots = (root: string, home: string) => [{ dir: join(root, ".syok", "plugins"), scope: "project" as const }, { dir: join(home, ".syok", "plugins"), scope: "home" as const }];
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
function readJson(p: string): any { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }
const count = (d: string, f: (n: string) => boolean) => { try { return readdirSync(d).filter(f).length; } catch { return 0; } };

export function listPlugins(root: string, home = homedir()): Plugin[] {
  const out: Plugin[] = [];
  for (const r of roots(root, home)) {
    if (!existsSync(r.dir)) continue;
    for (const n of readdirSync(r.dir)) {
      const dir = join(r.dir, n);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      const j = readJson(join(dir, "plugin.json"));
      out.push({ name: n, dir, description: String(j.description || ""), scope: r.scope, skills: count(join(dir, "skills"), (x) => existsSync(join(dir, "skills", x, "SKILL.md"))), commands: count(join(dir, "commands"), (x) => /\.md$/i.test(x)) });
    }
  }
  return out;
}
export const pluginDirs = (root: string, home = homedir()): string[] => listPlugins(root, home).map((p) => p.dir);
/** The folder of an installed plugin by name: this project's first, then the home folder's. */
export function pluginDir(name: string, root: string, home = homedir()): string | null {
  const n = clean(name); if (!n) return null;
  for (const r of roots(root, home)) { const d = join(r.dir, n); if (existsSync(d) && statSync(d).isDirectory()) return d; }
  return null;
}

/** Commands get what Claude Code gives a plugin's commands: the plugins' own bin/ folders on PATH, and "cc-plugin-root <plugin>"
 *  (a helper that many cc-skills skills call to find their files) answering with the plugin's folder here. */
export function pluginEnv(root: string, env: NodeJS.ProcessEnv, home = homedir()): NodeJS.ProcessEnv {
  const dirs = pluginDirs(root, home);
  if (!dirs.length) return env;
  const shims = ensureShims(home);
  const win = process.platform === "win32", sep = win ? ";" : ":";
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const extra = [shims, ...dirs.map((d) => join(d, "bin")).filter((d) => existsSync(d))].filter(Boolean) as string[];
  // After the user's own PATH, as Claude Code does: a plugin can add commands but never replace git, node or anything already there.
  return { ...env, [pathKey]: [env[pathKey] || "", ...extra].filter(Boolean).join(sep), SYOK_PROJECT_DIR: root };
}
function ensureShims(home: string): string | null {
  const dir = join(home, ".syok", "shims");
  try {
    mkdirSync(dir, { recursive: true });
    const sh = join(dir, "cc-plugin-root"), cmd = join(dir, "cc-plugin-root.cmd");
    const shText = '#!/bin/sh\n# Syok Code: prints the folder of an installed plugin (stands in for the cc-skills helper of the same name).\nfor d in "$SYOK_PROJECT_DIR/.syok/plugins/$1" "$HOME/.syok/plugins/$1"; do\n  if [ -n "$1" ] && [ -d "$d" ]; then printf \'%s\\n\' "$d"; exit 0; fi\ndone\necho "cc-plugin-root: no plugin called $1 is installed (syok plugin list)" >&2\nexit 1\n';
    const cmdText = '@echo off\r\nrem Syok Code: prints the folder of an installed plugin.\r\nif "%~1"=="" goto none\r\nif exist "%SYOK_PROJECT_DIR%\\.syok\\plugins\\%~1\\" (echo %SYOK_PROJECT_DIR%\\.syok\\plugins\\%~1& exit /b 0)\r\nif exist "%USERPROFILE%\\.syok\\plugins\\%~1\\" (echo %USERPROFILE%\\.syok\\plugins\\%~1& exit /b 0)\r\n:none\r\necho cc-plugin-root: no plugin called %~1 is installed 1>&2\r\nexit /b 1\r\n';
    if (!existsSync(sh) || readFileSync(sh, "utf8") !== shText) writeFileSync(sh, shText, { mode: 0o755 });
    if (!existsSync(cmd) || readFileSync(cmd, "utf8") !== cmdText) writeFileSync(cmd, cmdText);
    return dir;
  } catch { return null; }
}

/** Your settings plus the hooks and tool servers that installed plugins bring. */
export function pluginSettings(root: string, base: Settings, home = homedir()): Settings {
  const s: Settings = { ...base, hooks: { ...(base.hooks || {}) }, mcpServers: { ...(base.mcpServers || {}) } };
  for (const p of listPlugins(root, home)) {
    const j = readJson(join(p.dir, "settings.json"));
    // Each hook knows its plugin's folder (${CLAUDE_PLUGIN_ROOT} for hooks that came from Claude Code plugins).
    for (const [ev, arr] of Object.entries(j.hooks || {})) s.hooks![ev] = [...(s.hooks![ev] || []), ...(Array.isArray(arr) ? arr : []).map((h: any) => ({ ...h, plugin: p.name, pluginRoot: p.dir }))];
    for (const [k, v] of Object.entries(j.mcpServers || {})) s.mcpServers![clean(p.name) + "-" + clean(k)] = fillVars(v, { CLAUDE_PLUGIN_ROOT: p.dir, SYOK_PLUGIN_ROOT: p.dir, CLAUDE_PLUGIN_DATA: pluginDataDir(p.name, home), CLAUDE_PROJECT_DIR: root }) as any;
  }
  return s;
}
export function describePlugins(list: Plugin[]): string {
  if (!list.length) return "No plugins yet. Add one:  syok plugin browse   (the Syok list), or  syok plugin add owner/repo   (a GitHub plugin or a Claude Code marketplace)";
  return list.map((p) => {
    const j = readJson(join(p.dir, "plugin.json"));
    const hooks = existsSync(join(p.dir, "settings.json")) ? "  [hooks on]" : existsSync(join(p.dir, "claude-hooks.off.json")) ? "  [hooks off: syok plugin hooks " + p.name + " on]" : "";
    return "  " + p.name + (p.scope === "home" ? "  (yours, all projects)" : "") + " - " + p.skills + " skills, " + p.commands + " commands" + hooks + (j.from ? "  (from " + String(j.from).slice(0, 80) + ")" : "") + (p.description ? " - " + p.description.slice(0, 160) : "");
  }).join("\n");
}
export function removePlugin(root: string, name: string): boolean {
  const d = join(root, ".syok", "plugins", clean(name));
  if (!clean(name) || !existsSync(d)) return false;
  rmSync(d, { recursive: true, force: true }); return true;
}
export async function addPlugin(root: string, ref: string, f: typeof fetch = fetch): Promise<{ ok: boolean; message: string; name?: string; claude?: boolean }> {
  let tmp = "", from = "", fallback = "";
  try {
    const src = resolve(ref);
    if (ref.trim() && existsSync(src) && statSync(src).isDirectory()) { from = src; fallback = basename(src); }
    else {
      const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(ref.trim());
      if (!m) return { ok: false, message: "Give a GitHub link or owner/repo, or the path of a plugin folder." };
      const r = await f("https://codeload.github.com/" + m[1] + "/" + m[2] + "/tar.gz/HEAD");
      if (!r.ok) return { ok: false, message: "Could not download " + m[1] + "/" + m[2] + " (HTTP " + r.status + "). Is the repository public?" };
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 25_000_000) return { ok: false, message: "That repository is larger than 25 MB." };
      tmp = mkdtempSync(join(tmpdir(), "syok-plugin-"));
      writeFileSync(join(tmp, "x.tgz"), buf); mkdirSync(join(tmp, "src"));
      const t = spawnSync("tar", ["-xzf", join(tmp, "x.tgz"), "-C", join(tmp, "src"), "--strip-components=1"], { encoding: "utf8" });
      if (t.status !== 0) return { ok: false, message: "Could not unpack the download: " + String(t.stderr || t.error?.message || "").slice(0, 200) };
      from = join(tmp, "src"); fallback = m[2];
    }
    const claude = existsSync(join(from, ".claude-plugin", "plugin.json")) || existsSync(join(from, "hooks", "hooks.json"));
    if (!existsSync(join(from, "plugin.json")) && !existsSync(join(from, "skills")) && !existsSync(join(from, "commands")) && !existsSync(join(from, "agents")) && !claude) return { ok: false, message: "That folder has no plugin.json, skills folder or commands folder, so it is not a plugin." };
    const name = clean(String(readJson(join(from, "plugin.json")).name || readJson(join(from, ".claude-plugin", "plugin.json")).name || fallback)) || "plugin";
    const dest = join(root, ".syok", "plugins", name);
    rmSync(dest, { recursive: true, force: true }); mkdirSync(dirname(dest), { recursive: true });
    cpSync(from, dest, { recursive: true, filter: (p) => !/(^|[\\/])\.git([\\/]|$)/.test(p) && !lstatSync(p).isSymbolicLink() });
    const st = readJson(join(dest, "settings.json"));
    const risky = Object.keys(st.hooks || {}).length || Object.keys(st.mcpServers || {}).length;
    const p = listPlugins(root, join(root, ".nohome")).find((x) => x.name === name);
    return { ok: true, name, claude, message: "Added plugin " + name + " (" + (p?.skills ?? 0) + " skills, " + (p?.commands ?? 0) + " commands)." + (risky ? "\nWARNING: it also adds hooks or tool servers, which run commands on your computer. Keep it only if you trust it. Remove with: syok plugin remove " + name : "") };
  } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}
