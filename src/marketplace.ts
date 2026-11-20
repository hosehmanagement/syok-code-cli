// Claude Code plugin marketplaces in Syok Code.
//
//   syok plugin add owner/repo                 a repository with .claude-plugin/marketplace.json: shows the plugins in it
//   syok plugin add owner/repo <name> [...]    installs those plugins (only their own files are downloaded)
//   syok plugin add owner/repo@v1.2 <name>     the same, pinned to a tag, branch or commit
//   syok plugin add ./folder <name>            a marketplace on this computer
//
// A Claude Code plugin keeps its parts in fixed places: skills/<skill>/SKILL.md, commands/*.md, agents/*.md,
// hooks/hooks.json and .mcp.json (see https://code.claude.com/docs/en/plugins-reference). Skills, commands and helpers are
// plain text and are used as they are. Hooks and tool servers run programs on this computer, so they are switched on only
// after a clear yes; otherwise they are kept aside in claude-hooks.off.json and can be switched on later.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";

export interface MarketPlugin { name: string; description: string; version: string; category: string; keywords: string[]; source: PluginSource; /** Other plugins of the same marketplace it needs ("requires" or "dependencies"). */ requires: string[] }
export type PluginSource =
  | { kind: "path"; path: string }                                         // inside the marketplace's own repository
  | { kind: "github"; owner: string; repo: string; ref?: string; path?: string }
  | { kind: "unsupported"; why: string };
export interface Market { name: string; owner: string; description: string; plugins: MarketPlugin[] }
export type Where = { kind: "github"; owner: string; repo: string; ref?: string } | { kind: "local"; dir: string };

export interface MarketDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Asked before hooks or tool servers are switched on. No answer (no terminal) means no. */
  confirm?: (question: string) => Promise<boolean>;
  /** Switch hooks and tool servers on without asking (the user typed --with-hooks). */
  withHooks?: boolean;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const LIMIT_FILES = 800, LIMIT_BYTES = 40_000_000, LIMIT_FILE = 10_000_000;
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const str = (x: unknown, max = 400) => (typeof x === "string" ? x.slice(0, max) : "");
function readJson(p: string): any { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

/** "owner/repo", "owner/repo@ref", "https://github.com/owner/repo(.git)", "owner/repo:plugin" or a folder. */
export function parseWhere(ref: string, cwd = process.cwd()): { where: Where; plugin?: string } | null {
  const s = ref.trim();
  if (!s) return null;
  const local = resolve(cwd, s);
  if (existsSync(local) && statSync(local).isDirectory()) return { where: { kind: "local", dir: local } };
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([\w./-]+))?(?::([\w.-]+))?\/?$/.exec(s);
  if (!m) return null;
  return { where: { kind: "github", owner: m[1], repo: m[2], ...(m[3] ? { ref: m[3] } : {}) }, ...(m[4] ? { plugin: m[4] } : {}) };
}

function cleanSource(src: any): PluginSource {
  if (typeof src === "string") {
    const p = src.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (p === "." || p === "") return { kind: "path", path: "" }; // "." = the marketplace's own root folder
    if (p.split("/").some((x) => x === ".." || x === "") || p.startsWith("/")) return { kind: "unsupported", why: "its folder path is not inside the marketplace" };
    return { kind: "path", path: p };
  }
  if (src && typeof src === "object") {
    const kind = String(src.source || "");
    if (kind === "github" && /^[\w.-]+\/[\w.-]+$/.test(String(src.repo || ""))) {
      const [owner, repo] = String(src.repo).split("/");
      return { kind: "github", owner, repo, ...(src.ref ? { ref: String(src.ref) } : src.sha ? { ref: String(src.sha) } : {}), ...(src.path ? { path: String(src.path).replace(/^\.\//, "").replace(/\/+$/, "") } : {}) };
    }
    if ((kind === "url" || kind === "git") && typeof src.url === "string") {
      const g = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(src.url);
      if (g) return { kind: "github", owner: g[1], repo: g[2], ...(src.ref ? { ref: String(src.ref) } : src.sha ? { ref: String(src.sha) } : {}) };
      return { kind: "unsupported", why: "it lives in a git repository outside GitHub (" + String(src.url).slice(0, 80) + ")" };
    }
    if (kind === "git-subdir" && typeof src.url === "string") {
      const g = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(src.url);
      if (g) return { kind: "github", owner: g[1], repo: g[2], ...(src.ref ? { ref: String(src.ref) } : {}), ...(src.path ? { path: String(src.path).replace(/^\.\//, "").replace(/\/+$/, "") } : {}) };
    }
    return { kind: "unsupported", why: "its source type \"" + kind.slice(0, 20) + "\" is not one Syok Code can download yet" };
  }
  return { kind: "unsupported", why: "it has no source" };
}

/** The marketplace file, checked: only what Syok Code uses is kept. */
export function cleanMarket(j: any): Market | null {
  if (!j || typeof j !== "object" || !Array.isArray(j.plugins)) return null;
  const root = typeof j.metadata?.pluginRoot === "string" ? j.metadata.pluginRoot.replace(/^\.\//, "").replace(/\/+$/, "") : "";
  const seen = new Set<string>(); const plugins: MarketPlugin[] = [];
  for (const p of j.plugins.slice(0, 500)) {
    const name = str(p?.name, 64);
    if (!NAME.test(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    let source = cleanSource(p.source ?? "./" + name);
    // metadata.pluginRoot is put in front of bare plugin names ("formatter" means "<pluginRoot>/formatter").
    if (source.kind === "path" && root && typeof p.source === "string" && p.source !== "." && !p.source.startsWith("./") && !p.source.includes("/")) source = { kind: "path", path: root + "/" + source.path };
    const req = [...(Array.isArray(p.requires) ? p.requires : []), ...(Array.isArray(p.dependencies) ? p.dependencies : [])].map((x: any) => str(typeof x === "string" ? x : x?.name, 64)).filter((x: string) => NAME.test(x)).slice(0, 10);
    plugins.push({ name, description: str(p.description, 600), version: str(p.version, 40), category: str(p.category, 40), keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 20).map((k: unknown) => str(k, 40)).filter(Boolean) : [], source, requires: [...new Set(req)] });
  }
  return { name: str(j.name, 80) || "marketplace", owner: str(j.owner?.name, 80), description: str(j.description || j.metadata?.description, 300), plugins };
}

export function describeMarket(m: Market, label: string): string {
  const L = [`${m.name}${m.owner ? " by " + m.owner : ""}: ${m.plugins.length} plugin${m.plugins.length === 1 ? "" : "s"} (a Claude Code plugin marketplace, from ${label})`, ""];
  const w = Math.min(28, Math.max(...m.plugins.map((p) => p.name.length), 4));
  for (const p of m.plugins) {
    const d = p.description.replace(/\s+/g, " ");
    L.push(`  ${p.name.padEnd(w)}  ${p.category ? "[" + p.category + "] " : ""}${d.length > 110 ? d.slice(0, 107) + "..." : d}${p.source.kind === "unsupported" ? "  (cannot be installed: " + p.source.why + ")" : ""}`);
  }
  L.push("", `Install one or more:  syok plugin add ${label} <name> [<name> ...]`, "Skills, commands and helpers work as they are; they are instructions the AI follows, so install only from people you trust. Hooks and tool servers run programs on your computer, so you are asked before they are switched on.");
  return L.join("\n");
}

// ---- reading from GitHub or from a folder ----
const apiBase = (env: Record<string, string | undefined>) => (env.SYOK_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
const rawBase = (env: Record<string, string | undefined>) => (env.SYOK_GITHUB_RAW || "https://raw.githubusercontent.com").replace(/\/+$/, "");
function ghHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const t = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  return { accept: "application/vnd.github+json", "user-agent": "syok-code", ...(t ? { authorization: "Bearer " + t } : {}) };
}
const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Which branch to read when none was given. */
async function defaultRef(o: string, r: string, d: Required<Pick<MarketDeps, "fetchImpl" | "env">>): Promise<string> {
  const res = await d.fetchImpl(`${apiBase(d.env)}/repos/${o}/${r}`, { headers: ghHeaders(d.env) });
  if (res.status === 404) throw new Error(`GitHub has no public repository ${o}/${r}.`);
  if (res.status === 403 || res.status === 429) throw new Error(LIMITED);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${o}/${r}.`);
  const j: any = await res.json();
  return String(j.default_branch || "main");
}

export async function readMarket(where: Where, deps: MarketDeps = {}): Promise<{ market: Market | null; ref: string; note?: string }> {
  if (where.kind === "local") {
    const j = readJson(join(where.dir, ".claude-plugin", "marketplace.json"));
    return { market: cleanMarket(j), ref: "" };
  }
  const d = { fetchImpl: deps.fetchImpl ?? fetch, env: deps.env ?? process.env };
  // Reading the list needs no GitHub API call (those are limited to 60 an hour without a token): HEAD = the default branch.
  const ref = where.ref || "HEAD";
  const res = await d.fetchImpl(`${rawBase(d.env)}/${where.owner}/${where.repo}/${encPath(ref)}/.claude-plugin/marketplace.json`, { headers: { "user-agent": "syok-code" } });
  if (res.status === 404) return { market: null, ref };
  if (!res.ok) throw new Error(`Could not read the marketplace file (HTTP ${res.status}).`);
  const text = await res.text();
  if (text.length > 2_000_000) throw new Error("The marketplace file is larger than 2 MB.");
  let j: any = null; try { j = JSON.parse(text); } catch { throw new Error("The marketplace file is not valid JSON."); }
  return { market: cleanMarket(j), ref };
}

const LIMITED = "GitHub's limit for anonymous downloads is used up for now (60 an hour). Wait a while, or set GITHUB_TOKEN to a GitHub token and try again.";
const codeloadBase = (env: Record<string, string | undefined>) => (env.SYOK_GITHUB_CODELOAD || "https://codeload.github.com").replace(/\/+$/, "");

/** Download every file under <path>/ of a GitHub repository at <ref> into <dest>. Only that folder is fetched.
 *  When GitHub's file-list service says no (its anonymous limit), the repository's archive is used instead. */
export async function fetchFolder(o: string, r: string, ref: string, path: string, dest: string, deps: MarketDeps = {}): Promise<{ files: number; bytes: number }> {
  const d = { fetchImpl: deps.fetchImpl ?? fetch, env: deps.env ?? process.env };
  let res: Response | null = null;
  try { res = await d.fetchImpl(`${apiBase(d.env)}/repos/${o}/${r}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers: ghHeaders(d.env) }); } catch { res = null; }
  if (!res || res.status === 403 || res.status === 429) return fromArchive(o, r, ref, path, dest, d);
  if (res.status === 404) throw new Error(`GitHub has no ${ref} in ${o}/${r}.`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when listing the files of ${o}/${r}.`);
  const j: any = await res.json();
  if (j.truncated) throw new Error(`${o}/${r} is too large for GitHub to list in one go. Download it yourself and use: syok plugin add <folder> <name>`);
  const prefix = path ? path.replace(/\/+$/, "") + "/" : "";
  const blobs = (Array.isArray(j.tree) ? j.tree : []).filter((t: any) => t?.type === "blob" && typeof t.path === "string" && t.path.startsWith(prefix) && !/(^|\/)\.git(\/|$)/.test(t.path));
  if (!blobs.length) throw new Error(`There are no files in ${o}/${r}${path ? " under " + path : ""}.`);
  if (blobs.length > LIMIT_FILES) throw new Error(`That plugin has ${blobs.length} files; Syok Code takes at most ${LIMIT_FILES}.`);
  const total = blobs.reduce((n: number, b: any) => n + (Number(b.size) || 0), 0);
  if (total > LIMIT_BYTES) throw new Error(`That plugin is ${Math.round(total / 1e6)} MB; Syok Code takes at most ${LIMIT_BYTES / 1e6} MB.`);
  let bytes = 0; const queue = [...blobs];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const rel = b.path.slice(prefix.length);
      const out = safeJoin(dest, rel); if (!out) continue;
      if ((Number(b.size) || 0) > LIMIT_FILE) continue; // a very large file (a video, a model): skipped
      const fr = await d.fetchImpl(`${rawBase(d.env)}/${o}/${r}/${encPath(ref)}/${encPath(b.path)}`, { headers: { "user-agent": "syok-code" } });
      if (!fr.ok) throw new Error(`Could not download ${b.path} (HTTP ${fr.status}).`);
      const buf = Buffer.from(await fr.arrayBuffer()); bytes += buf.length;
      mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, buf);
      if (b.mode === "100755") { try { (await import("node:fs")).chmodSync(out, 0o755); } catch {} }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { files: blobs.length, bytes };
}
/** The whole repository as one archive (no API limit), unpacked aside; only <path>/ is kept. */
async function fromArchive(o: string, r: string, ref: string, path: string, dest: string, d: { fetchImpl: typeof fetch; env: Record<string, string | undefined> }): Promise<{ files: number; bytes: number }> {
  let res: Response;
  try { res = await d.fetchImpl(`${codeloadBase(d.env)}/${o}/${r}/tar.gz/${encPath(ref)}`, { headers: { "user-agent": "syok-code" } }); }
  catch (e: any) { throw new Error(LIMITED + " (The archive could not be downloaded either: " + String(e?.message || e).slice(0, 120) + ")"); }
  if (!res.ok) throw new Error(res.status === 404 ? `GitHub has no ${ref} in ${o}/${r}.` : LIMITED);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 80_000_000) throw new Error(`${o}/${r} is larger than 80 MB to download. Download it yourself and use: syok plugin add <folder> <name>`);
  const { mkdtempSync, readdirSync: rd } = await import("node:fs"); const { tmpdir } = await import("node:os"); const { spawnSync } = await import("node:child_process");
  const tmp = mkdtempSync(join(tmpdir(), "syok-market-"));
  try {
    writeFileSync(join(tmp, "x.tgz"), buf); mkdirSync(join(tmp, "src"));
    const t = spawnSync("tar", ["-xzf", join(tmp, "x.tgz"), "-C", join(tmp, "src"), "--strip-components=1"], { encoding: "utf8" });
    if (t.status !== 0) throw new Error("Could not unpack the download: " + String(t.stderr || t.error?.message || "").slice(0, 200));
    const from = path ? join(tmp, "src", ...path.split("/")) : join(tmp, "src");
    if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`There are no files in ${o}/${r}${path ? " under " + path : ""}.`);
    let files = 0, bytes = 0;
    const walkCopy = (src: string, out: string) => {
      for (const n of rd(src)) {
        if (n === ".git") continue;
        const a = join(src, n), b = join(out, n), st = lstatSync(a);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { walkCopy(a, b); continue; }
        if (st.size > LIMIT_FILE) continue;
        if (++files > LIMIT_FILES) throw new Error(`That plugin has more than ${LIMIT_FILES} files; Syok Code takes at most ${LIMIT_FILES}.`);
        bytes += st.size; mkdirSync(dirname(b), { recursive: true }); cpSync(a, b);
      }
    };
    walkCopy(from, dest);
    return { files, bytes };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
/** dest + rel, but only if the result stays inside dest. */
function safeJoin(dest: string, rel: string): string | null {
  const out = normalize(join(dest, rel));
  return out.startsWith(normalize(dest) + sep) ? out : null;
}

// ---- turning a downloaded Claude Code plugin into a Syok plugin ----
export interface Converted { skills: number; commands: number; agents: number; hooks: HookSummary[]; mcp: string[]; notes: string[] }
export interface HookSummary { event: string; matcher: string; command: string }
const SUPPORTED_EVENTS = new Set(["PreToolUse", "PostToolUse", "Stop", "UserPromptSubmit", "SessionStart"]);

/** Reads the Claude parts (plugin.json in .claude-plugin, hooks/hooks.json, .mcp.json) and writes what Syok reads. */
export function convertClaudePlugin(dir: string, meta: { name: string; description?: string; version?: string; from?: string; category?: string }): { converted: Converted; settings: any } {
  const manifest = readJson(join(dir, ".claude-plugin", "plugin.json")) || {};
  const notes: string[] = [];
  const count = (d: string, f: (n: string) => boolean) => { try { return readdirSync(join(dir, d)).filter(f).length; } catch { return 0; } };
  // Component folders: the defaults, plus extra ones named in plugin.json (they add to the defaults).
  const extra = (k: string): string[] => { const v = manifest[k]; return (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map((x: unknown) => String(x).replace(/^\.\//, "").replace(/\/+$/, "")).filter((x: string) => x && !x.includes("..")); };
  for (const [k, def] of [["skills", "skills"], ["commands", "commands"], ["agents", "agents"]] as const) {
    for (const p of extra(k)) {
      if (p === def || !existsSync(join(dir, p))) continue;
      // Copy the extra folder's entries into the default folder Syok reads.
      const st = statSync(join(dir, p));
      mkdirSync(join(dir, def), { recursive: true });
      if (st.isDirectory()) for (const n of readdirSync(join(dir, p))) { if (!existsSync(join(dir, def, n))) cpSync(join(dir, p, n), join(dir, def, n), { recursive: true }); }
      else if (!existsSync(join(dir, def, p.split("/").pop()!))) cpSync(join(dir, p), join(dir, def, p.split("/").pop()!));
    }
  }
  // Hooks: hooks/hooks.json, plus a "hooks" object or file path in plugin.json.
  const hookSets: any[] = [];
  const hj = readJson(join(dir, "hooks", "hooks.json")); if (hj) hookSets.push(hj.hooks || hj);
  if (manifest.hooks && typeof manifest.hooks === "object") hookSets.push(manifest.hooks.hooks || manifest.hooks);
  for (const p of typeof manifest.hooks === "string" ? [manifest.hooks] : Array.isArray(manifest.hooks) ? manifest.hooks.filter((x: unknown) => typeof x === "string") : []) {
    const f = readJson(join(dir, String(p).replace(/^\.\//, ""))); if (f) hookSets.push(f.hooks || f);
  }
  const hooks: Record<string, any[]> = {}; const summary: HookSummary[] = [];
  for (const set of hookSets) {
    for (const [ev, groups] of Object.entries(set || {})) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups as any[]) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          if (h?.type && h.type !== "command") { notes.push(`a ${ev} hook of type "${h.type}" was skipped (only command hooks run in Syok Code)`); continue; }
          if (typeof h?.command !== "string") continue;
          if (!SUPPORTED_EVENTS.has(ev)) { notes.push(`a ${ev} hook was skipped (Syok Code has no ${ev} moment)`); continue; }
          const matcher = typeof g.matcher === "string" ? g.matcher : "";
          (hooks[ev] ||= []).push({ claude: matcher || "*", command: h.command, ...(h.timeout ? { timeout_sec: Math.min(600, Number(h.timeout) || 60) } : {}), ...(h.async === true ? { async: true } : {}), plugin: meta.name });
          summary.push({ event: ev, matcher: matcher || "(every tool)", command: h.command.slice(0, 160) });
        }
      }
    }
  }
  // Tool servers: .mcp.json or plugin.json "mcpServers" (an object or a file path).
  const mcp: Record<string, any> = {};
  const addMcp = (j: any) => { const s = j?.mcpServers || j; if (s && typeof s === "object") for (const [k, v] of Object.entries(s)) if (v && typeof v === "object") mcp[k] = v; };
  addMcp(readJson(join(dir, ".mcp.json")));
  if (manifest.mcpServers && typeof manifest.mcpServers === "object") addMcp(manifest.mcpServers);
  if (typeof manifest.mcpServers === "string") addMcp(readJson(join(dir, manifest.mcpServers.replace(/^\.\//, ""))));
  const settings: any = {};
  if (Object.keys(hooks).length) settings.hooks = hooks;
  if (Object.keys(mcp).length) settings.mcpServers = mcp;
  // Syok's own plugin.json: what it is and where it came from (Claude's own manifest stays in .claude-plugin/).
  const own = readJson(join(dir, "plugin.json")) || {};
  writeFileSync(join(dir, "plugin.json"), JSON.stringify({ ...own, name: meta.name, description: meta.description || manifest.description || own.description || "", version: meta.version || manifest.version || own.version || "", ...(meta.from ? { from: meta.from } : {}), ...(meta.category ? { category: meta.category } : {}), format: "claude-code" }, null, 2) + "\n");
  return {
    converted: {
      skills: count("skills", (n) => existsSync(join(dir, "skills", n, "SKILL.md"))),
      commands: count("commands", (n) => /\.md$/i.test(n)), agents: count("agents", (n) => /\.md$/i.test(n)),
      hooks: summary, mcp: Object.keys(mcp), notes: [...new Set(notes)],
    },
    settings,
  };
}

function describeRisk(c: Converted): string {
  const L: string[] = [];
  if (c.hooks.length) { L.push(`It has ${c.hooks.length} hook${c.hooks.length === 1 ? "" : "s"} (programs that run on your computer around the AI's actions):`); for (const h of c.hooks.slice(0, 12)) L.push(`  ${h.event} ${h.matcher}: ${h.command}`); if (c.hooks.length > 12) L.push(`  ...and ${c.hooks.length - 12} more`); }
  if (c.mcp.length) L.push(`It starts ${c.mcp.length} tool server${c.mcp.length === 1 ? "" : "s"}: ${c.mcp.join(", ")}`);
  return L.join("\n");
}

/** Makes a downloaded Claude Code plugin folder ready for Syok Code. Hooks and tool servers are switched on only after a yes. */
export async function adoptClaudePlugin(dir: string, meta: { name: string; description?: string; version?: string; from?: string; category?: string }, deps: MarketDeps, trustWho: string): Promise<string> {
  const { converted: c, settings } = convertClaudePlugin(dir, meta);
  const risky = c.hooks.length > 0 || c.mcp.length > 0;
  let on = false;
  if (risky) {
    on = !!deps.withHooks || (deps.confirm ? await deps.confirm(`${meta.name}:\n${describeRisk(c)}\nSwitch these on? Only say yes if you trust ${trustWho}.`) : false);
    // Hooks and tool servers name the plugin's folder as ${CLAUDE_PLUGIN_ROOT}; it is filled in when they run.
    rmSync(join(dir, "settings.json"), { force: true }); rmSync(join(dir, "claude-hooks.off.json"), { force: true });
    writeFileSync(join(dir, on ? "settings.json" : "claude-hooks.off.json"), JSON.stringify(settings, null, 2) + "\n");
  }
  const parts = [`${c.skills} skill${c.skills === 1 ? "" : "s"}`, `${c.commands} command${c.commands === 1 ? "" : "s"}`, ...(c.agents ? [`${c.agents} helper${c.agents === 1 ? "" : "s"}`] : [])].join(", ");
  return ` (${parts}).` +
    (risky ? (on ? `\n  Hooks and tool servers are ON:\n${describeRisk(c).replace(/^/gm, "  ")}` : `\n  Its hooks and tool servers are OFF, so nothing of it runs by itself:\n${describeRisk(c).replace(/^/gm, "  ")}\n  To switch them on later: syok plugin hooks ${meta.name} on`) : "") +
    (c.notes.length ? "\n  Note: " + c.notes.join("; ") + "." : "");
}

/** syok plugin hooks <name> on|off: switch an installed plugin's hooks and tool servers on or off. */
export function switchHooks(root: string, name: string, on: boolean): string {
  const dir = join(root, ".syok", "plugins", clean(name));
  if (!clean(name) || !existsSync(dir)) return `No plugin called ${name} in this project.`;
  const live = join(dir, "settings.json"), off = join(dir, "claude-hooks.off.json");
  if (on) { if (!existsSync(off)) return existsSync(live) ? `${name}: its hooks and tool servers are already on.` : `${name} has no hooks or tool servers.`; cpSync(off, live); rmSync(off, { force: true }); return `${name}: hooks and tool servers are ON. They run commands on your computer. Switch off with: syok plugin hooks ${name} off`; }
  if (!existsSync(live)) return `${name}: its hooks and tool servers are already off.`;
  cpSync(live, off); rmSync(live, { force: true }); return `${name}: hooks and tool servers are OFF.`;
}

/** Install plugins from a marketplace into <root>/.syok/plugins/<name>. */
export async function installFromMarket(root: string, ref: string, names: string[], deps: MarketDeps = {}): Promise<{ ok: boolean; message: string; installed: string[]; notMarket?: boolean }> {
  const parsed = parseWhere(ref, root);
  if (!parsed) return { ok: false, message: "Give a GitHub repository (owner/repo) or the folder of a plugin marketplace.", installed: [] };
  const want = [...names, ...(parsed.plugin ? [parsed.plugin] : [])].map((n) => n.trim()).filter(Boolean);
  const label = parsed.where.kind === "github" ? `${parsed.where.owner}/${parsed.where.repo}${parsed.where.ref ? "@" + parsed.where.ref : ""}` : ref;
  let market: Market | null = null, mref = "";
  try { ({ market, ref: mref } = await readMarket(parsed.where, deps)); }
  catch (e: any) { return { ok: false, message: String(e?.message || e), installed: [] }; }
  if (!market) return { ok: false, notMarket: true, message: `${label} has no .claude-plugin/marketplace.json, so it is not a plugin marketplace.`, installed: [] };
  if (!want.length) return { ok: true, message: describeMarket(market, label), installed: [] };
  const out: string[] = []; const installed: string[] = []; let failed = 0;
  for (const n of want) {
    const p = market.plugins.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!p) { out.push(`${n}: not in ${market.name}. See the list with: syok plugin add ${label}`); failed++; continue; }
    if (p.source.kind === "unsupported") { out.push(`${p.name}: cannot be installed: ${p.source.why}.`); failed++; continue; }
    const name = clean(p.name) || "plugin";
    const dest = join(root, ".syok", "plugins", name);
    const tmp = dest + ".new";
    rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
    try {
      let from = "";
      if (parsed.where.kind === "local") {
        if (p.source.kind !== "path") throw new Error("it lives in another repository; install it from GitHub instead");
        const src = resolve(parsed.where.dir, p.source.path);
        if ((src !== parsed.where.dir && !src.startsWith(parsed.where.dir + sep)) || !existsSync(src)) throw new Error(`its folder ${p.source.path} is missing`);
        cpSync(src, tmp, { recursive: true, filter: (x) => { const rel = relative(src, x); return !/(^|[\\/])(\.git|\.syok|node_modules)([\\/]|$)/.test(rel) && !lstatSync(x).isSymbolicLink(); } });
        from = parsed.where.dir;
      } else if (p.source.kind === "path") {
        // Pin to the branch's name (not "HEAD"), so what was installed can be told and fetched again.
        if (mref === "HEAD") mref = await defaultRef(parsed.where.owner, parsed.where.repo, { fetchImpl: deps.fetchImpl ?? fetch, env: deps.env ?? process.env }).catch((e) => { if (String(e?.message || "").includes("60 an hour")) return "HEAD"; throw e; });
        await fetchFolder(parsed.where.owner, parsed.where.repo, mref, p.source.path, tmp, deps);
        from = `${parsed.where.owner}/${parsed.where.repo}@${mref}`;
      } else {
        const s = p.source; const d = { fetchImpl: deps.fetchImpl ?? fetch, env: deps.env ?? process.env };
        const sref = s.ref || (await defaultRef(s.owner, s.repo, d).catch((e) => { if (String(e?.message || "").includes("60 an hour")) return "HEAD"; throw e; }));
        await fetchFolder(s.owner, s.repo, sref, s.path || "", tmp, deps);
        from = `${s.owner}/${s.repo}@${sref}`;
      }
      const msg = await adoptClaudePlugin(tmp, { name, description: p.description, version: p.version, from: market.name + " (" + from + ")", category: p.category }, deps, market.owner || market.name);
      rmSync(dest, { recursive: true, force: true }); cpSync(tmp, dest, { recursive: true });
      installed.push(name);
      const missing = p.requires.filter((x) => !want.some((w) => w.toLowerCase() === x.toLowerCase()) && !existsSync(join(root, ".syok", "plugins", clean(x))));
      out.push(`Added ${name} from ${market.name}` + msg + (missing.length ? `\n  It works together with ${missing.join(", ")}: syok plugin add ${label} ${missing.join(" ")}` : ""));
    } catch (e: any) { out.push(`${p.name}: ${String(e?.message || e)}`); failed++; }
    finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  if (installed.length) out.push("", "Use a skill with /<skill> <what you want> (also /" + installed[0] + ":<skill>), or just ask: the AI sees the skills' descriptions and opens one when it fits. List them: syok skills");
  return { ok: failed === 0, message: out.join("\n"), installed };
}
