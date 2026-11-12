import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Settings } from "./perm.ts";

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

/** Your settings plus the hooks and tool servers that installed plugins bring. */
export function pluginSettings(root: string, base: Settings, home = homedir()): Settings {
  const s: Settings = { ...base, hooks: { ...(base.hooks || {}) }, mcpServers: { ...(base.mcpServers || {}) } };
  for (const p of listPlugins(root, home)) {
    const j = readJson(join(p.dir, "settings.json"));
    for (const [ev, arr] of Object.entries(j.hooks || {})) s.hooks![ev] = [...(s.hooks![ev] || []), ...(arr as any[])];
    for (const [k, v] of Object.entries(j.mcpServers || {})) s.mcpServers![clean(p.name) + "-" + clean(k)] = v as any;
  }
  return s;
}
export function describePlugins(list: Plugin[]): string {
  if (!list.length) return "No plugins yet. Add one:  syok plugin add owner/repo   (or a folder path)";
  return list.map((p) => "  " + p.name + (p.scope === "home" ? "  (yours, all projects)" : "") + " - " + p.skills + " skills, " + p.commands + " commands" + (p.description ? " - " + p.description : "")).join("\n");
}
export function removePlugin(root: string, name: string): boolean {
  const d = join(root, ".syok", "plugins", clean(name));
  if (!clean(name) || !existsSync(d)) return false;
  rmSync(d, { recursive: true, force: true }); return true;
}
export async function addPlugin(root: string, ref: string, f: typeof fetch = fetch): Promise<{ ok: boolean; message: string; name?: string }> {
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
    if (!existsSync(join(from, "plugin.json")) && !existsSync(join(from, "skills")) && !existsSync(join(from, "commands"))) return { ok: false, message: "That folder has no plugin.json, skills folder or commands folder, so it is not a plugin." };
    const name = clean(String(readJson(join(from, "plugin.json")).name || fallback)) || "plugin";
    const dest = join(root, ".syok", "plugins", name);
    rmSync(dest, { recursive: true, force: true }); mkdirSync(dirname(dest), { recursive: true });
    cpSync(from, dest, { recursive: true, filter: (p) => !/(^|[\\/])\.git([\\/]|$)/.test(p) && !lstatSync(p).isSymbolicLink() });
    const st = readJson(join(dest, "settings.json"));
    const risky = Object.keys(st.hooks || {}).length || Object.keys(st.mcpServers || {}).length;
    const p = listPlugins(root, join(root, ".nohome")).find((x) => x.name === name);
    return { ok: true, name, message: "Added plugin " + name + " (" + (p?.skills ?? 0) + " skills, " + (p?.commands ?? 0) + " commands)." + (risky ? "\nWARNING: it also adds hooks or tool servers, which run commands on your computer. Keep it only if you trust it. Remove with: syok plugin remove " + name : "") };
  } finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
}
