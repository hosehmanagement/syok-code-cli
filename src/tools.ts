import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { workerLimit, isGitProject } from "./parallel.ts";
import { resolve, relative, dirname, join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { spawnCommand, killTree, cleanEnv } from "./shell.ts";
import { isProtected, SECRET_LIKE, allowEdit, allowCommand, type Mode, type Asker, type Settings } from "./perm.ts";
import type { Profile } from "./profiles.ts";
import { unifiedDiff } from "./diff.ts";
import { Bg } from "./bg.ts";
import { startJob, jobLog, stopJob, describeJobs } from "./jobs.ts";
import { webFetch, webSearch, checkUrl, hostOf, type WebDeps } from "./web.ts";
import { quickCheck, quickLine } from "./checks.ts";
import { agentsHint, loadAgents, type Agent } from "./agents.ts";
import { findSymbol, describeSymbol, outline as symbolOutline, describeOutline, readSmall } from "./symbols.ts";

/** Seconds a run_command may take: the AI's request, limited by the user's settings (default max 10 minutes, hard ceiling 24 hours). */
export function commandTimeout(s: Settings, asked?: number): number {
  const envMax = Number(process.env.SYOK_MAX_TIMEOUT) || 0;
  const cap = Math.min(86400, Math.max(5, s.max_timeout_sec || envMax || 600));
  const def = Math.min(cap, Math.max(5, s.timeout_sec || 120));
  return Math.min(cap, Math.max(5, asked || def));
}
import type { ToolServer as McpClient } from "./mcp.ts";

const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".next", "target"]);
const fn = (name: string, description: string, properties: any, required: string[]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
export const TOOLS = [
  fn("list_files", "List files and folders in a directory (relative to the project root). Use '.' for the root.", { path: { type: "string" } }, ["path"]),
  fn("read_file", "Read a text file with line numbers. Optional 1-based start_line and end_line for big files.", { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, ["path"]),
  fn("search", "Search file contents with a regular expression. Returns file:line:text. Optional glob such as '*.ts' limits files.", { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, ["pattern"]),
  fn("find_files", "Find files by name pattern, for example '**/*.test.js'.", { pattern: { type: "string" } }, ["pattern"]),
  fn("find_symbol", "Find where a function, class, type or variable is DEFINED and where it is USED, by its exact name (case-sensitive). Faster and more exact than search for names: definitions and uses come back separately with file and line. show: 'both' (default), 'definition' or 'usages'.", { name: { type: "string" }, show: { type: "string", enum: ["both", "definition", "usages"] }, path: { type: "string" } }, ["name"]),
  fn("outline", "List what a code file defines (functions, classes, types, methods) with line numbers, without reading the whole file. Use it before read_file on a big file, then read only the lines you need.", { path: { type: "string" } }, ["path"]),
  fn("edit_file", "Replace text in an existing file. old_text must match exactly and be unique (add surrounding lines if not). Set replace_all to change every match.", { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } }, ["path", "old_text", "new_text"]),
  fn("write_file", "Create a new file or fully replace a file with new content.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  fn("run_command", "Run a shell command in the project root (tests, build, git status...). Output is cut if long. timeout_sec defaults to 120 (the user can change the default and the maximum). For anything that may run longer than a few minutes use job_start instead.",{ command: { type: "string" }, timeout_sec: { type: "integer" } }, ["command"]),
  fn("bg_start", "Start a long-running command in the background (dev server, watcher). Returns a job id. Use bg_output to read it and bg_stop to stop it.", { command: { type: "string" } }, ["command"]),
  fn("bg_output", "Read the latest output of a background job. Without id, lists all jobs.", { id: { type: "integer" } }, []),
  fn("bg_stop", "Stop a background job.", { id: { type: "integer" } }, ["id"]),
  fn("job_start", "Start a long script or heavy task that must KEEP RUNNING even after Syok Code exits (training, a big build, a scraper, a data job). Output goes to a log file in .syok/jobs. Returns a job id. Check it later with job_output (also in a new session) and stop it with job_stop. max_minutes is optional (0 = no limit). Use bg_start instead for a dev server you only need during this session.", { command: { type: "string" }, max_minutes: { type: "number" } }, ["command"]),
  fn("job_output", "Read the end of a saved job's log and whether it is still running or finished (with its exit code). Without id, lists all saved jobs. Optional tail = how many characters of the log to show (default 4000).", { id: { type: "integer" }, tail: { type: "integer" } }, []),
  fn("job_stop", "Stop a saved job (and everything it started).", { id: { type: "integer" } }, ["id"]),
  fn("web_search", "Search the web. Returns a numbered list of titles, addresses and short snippets. Use it for current facts, documentation, error messages and library versions you are not sure about; then read the best page with web_fetch.", { query: { type: "string" }, max_results: { type: "integer" } }, ["query"]),
  fn("web_fetch", "Read one web page (http or https) as plain text. Long pages come in parts: the reply says which characters are shown and the start value for the next part. Never put secrets or the user's private data in the address.", { url: { type: "string" }, start: { type: "integer" }, max_chars: { type: "integer" } }, ["url"]),
  fn("delegate", "Hand a sub-task to a helper with a fresh, empty context so it does not fill your memory. role 'explorer' (default) is read-only: use it to search or read a lot and get a short answer; several explorers in one message run in parallel. role 'worker' may edit files and run commands; use it for one self-contained change. Give a complete, specific task.", { task: { type: "string" }, role: { type: "string", description: "explorer, worker, or the name of one of the user's helpers" } }, ["task"]),
  fn("parallel_edit", "Run two or more workers AT THE SAME TIME, each making one change in its own separate copy of the project; afterwards their changes are joined into the real project. Use it when a job splits into independent changes that touch DIFFERENT files (for example: three modules that each need the same kind of update, or a feature plus its documentation). Do not use it for changes to the same file or for steps that depend on each other: do those yourself, in order. Each worker starts with an empty memory, so every task must be complete on its own: what to change, in which files, and how to check it. A worker whose change overlaps with another's is not joined, and you are told so you can redo it. After it returns, run the project's tests on the joined result.", { tasks: { type: "array", description: "two to eight tasks", items: { type: "object", properties: { name: { type: "string", description: "a short name, for example api or docs" }, task: { type: "string", description: "complete, specific instructions" } }, required: ["name", "task"] } } }, ["tasks"]),
  fn("finish", "Call when the task is done (or cannot be done). Give a short plain summary.", { summary: { type: "string" } }, ["summary"]),
];

export const WEB_TOOLS = new Set(["web_search", "web_fetch"]);
export const READONLY = new Set(["list_files", "read_file", "search", "find_files", "find_symbol", "outline", "finish"]);
export function toolDefs(c: Ctx): any[] {
  let t: any[] = TOOLS.filter((x) => !c.allowed || c.allowed.has(x.function.name));
  if (c.depth > 0) t = t.filter((x) => x.function.name !== "delegate");
  else if (c.agents?.length) t = t.map((x) => x.function.name === "delegate" ? { ...x, function: { ...x.function, description: x.function.description + agentsHint(c.agents!) } } : x);
  if (c.settings.web === false) t = t.filter((x) => !WEB_TOOLS.has(x.function.name));
  if (c.depth > 0 || c.mode === "plan" || workerLimit(c.settings) < 1 || !isGitProject(c.root)) t = t.filter((x) => x.function.name !== "parallel_edit");
  return c.allowed ? t : [...t, ...c.mcp.flatMap((m) => m.defs())];
}
/** Everything changed in this session, as a unified diff (for /diff). */
export function sessionDiff(c: Ctx): string {
  const out: string[] = [];
  for (const [rel, orig] of c.snapshots) {
    const abs = resolve(c.root, rel);
    const now = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const d = unifiedDiff(orig ?? "", now, rel); if (d) out.push(d);
  }
  return out.join("\n\n");
}
export interface Ctx { agents?: Agent[]; root: string; mode: Mode; ask: Asker; settings: Settings; profile: Profile; snapshots: Map<string, string | null>; touched: Set<string>; ran: { tests: boolean; commands: number; declined: number }; bg: Bg; mcp: McpClient[]; depth: number; allowed?: Set<string>; web?: WebDeps; webOk?: { hosts: Set<string>; search: boolean }; sandbox?: (cmd: string, secs: number) => Promise<string>; sandboxPut?: (rel: string, content: string | null) => Promise<string> }
export function makeCtx(root: string, mode: Mode, ask: Asker, settings: Settings, profile: Profile): Ctx {
  return { root: resolve(root), mode, ask, settings, profile, snapshots: new Map(), touched: new Set(), ran: { tests: false, commands: 0, declined: 0 }, bg: new Bg(), mcp: [], depth: 0, webOk: { hosts: new Set(), search: false }, agents: settings.agents === false ? [] : loadAgents(resolve(root)) };
}
function safePath(c: Ctx, p: string): { abs: string; rel: string } {
  const abs = resolve(c.root, p || ".");
  const rel = relative(c.root, abs).split(sep).join("/");
  if (rel.startsWith("..") || resolve(abs) !== abs) throw new Error("That path is outside the project folder.");
  return { abs, rel: rel || "." };
}
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.floor(n * 0.6)) + `\n...[${s.length - n} characters cut]...\n` + s.slice(-Math.floor(n * 0.4)));
function globRe(g: string): RegExp {
  let r = "";
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") { if (g[i + 1] === "*") { r += ".*"; i++; if (g[i + 1] === "/") i++; } else r += "[^/]*"; }
    else if (ch === "?") r += "[^/]"; else r += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + r + "$");
}
function walk(dir: string, root: string, out: string[] = [], limit = 5000): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= limit) break;
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(dir, e.name), root, out, limit); }
    else out.push(relative(root, join(dir, e.name)).split(sep).join("/"));
  }
  return out;
}
function snapshot(c: Ctx, abs: string, rel: string) { if (!c.snapshots.has(rel)) c.snapshots.set(rel, existsSync(abs) ? readFileSync(abs, "utf8") : null); }
function norm(s: string) { return s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n"); }
function fuzzyFind(text: string, old: string): { start: number; end: number } | null {
  const tl = text.split("\n"), ol = norm(old).split("\n").map((l) => l.trim());
  while (ol.length && ol[ol.length - 1] === "") ol.pop();
  if (!ol.length) return null;
  const hits: number[] = [];
  for (let i = 0; i + ol.length <= tl.length; i++) if (ol.every((l, k) => tl[i + k].trim() === l)) hits.push(i);
  if (hits.length !== 1) return null;
  const i = hits[0];
  const start = tl.slice(0, i).join("\n").length + (i ? 1 : 0);
  return { start, end: start + tl.slice(i, i + ol.length).join("\n").length };
}

export async function runTool(c: Ctx, name: string, a: any): Promise<string> {
  try {
    if (c.allowed && !c.allowed.has(name)) return `Error: ${name} is not available to this helper.`;
    if (name.startsWith("mcp__")) {
      const [, srv, ...rest] = name.split("__");
      const m = c.mcp.find((x) => x.name === srv);
      if (!m) return `Error: no tool server named ${srv}.`;
      if (c.mode !== "auto" && !(c.settings.allow || []).includes("mcp__" + srv) && !(await c.ask("use tool " + name, JSON.stringify(a).slice(0, 500)))) return "The user did not allow this tool.";
      return cut(await m.call(rest.join("__"), a), c.profile.maxToolChars);
    }
    switch (name) {
      case "list_files": {
        const { abs, rel } = safePath(c, a.path);
        const es = readdirSync(abs, { withFileTypes: true }).filter((e) => !SKIP.has(e.name)).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).sort();
        return es.length ? es.join("\n") : `(${rel} is empty)`;
      }
      case "read_file": {
        const { abs, rel } = safePath(c, a.path);
        if (!existsSync(abs)) return `Error: ${rel} does not exist. Use list_files or find_files.`;
        if (statSync(abs).isDirectory()) return `Error: ${rel} is a folder. Use list_files.`;
        if (statSync(abs).size > 2_000_000) return "Error: file is larger than 2 MB. Use search or read a line range.";
        const lines = readFileSync(abs, "utf8").split("\n");
        const s = Math.max(1, a.start_line || 1), e = Math.min(lines.length, a.end_line || lines.length);
        const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join("\n");
        return cut(body, c.profile.maxToolChars) + (e < lines.length && !a.end_line ? "" : "");
      }
      case "search": {
        const { abs } = safePath(c, a.path || ".");
        let re: RegExp; try { re = new RegExp(a.pattern); } catch { return "Error: that is not a valid regular expression."; }
        const gre = a.glob ? globRe(a.glob.includes("/") ? a.glob : "**/" + a.glob) : null;
        const files = statSync(abs).isDirectory() ? walk(abs, c.root) : [relative(c.root, abs)];
        const out: string[] = [];
        for (const f of files) {
          if (gre && !gre.test(f)) continue;
          let t: string; try { const p = resolve(c.root, f); if (statSync(p).size > 1_000_000) continue; t = readFileSync(p, "utf8"); } catch { continue; }
          if (t.includes("\0")) continue;
          t.split("\n").forEach((l, i) => { if (out.length < 200 && re.test(l)) out.push(`${f}:${i + 1}:${l.slice(0, 200)}`); });
          if (out.length >= 200) break;
        }
        return out.length ? out.join("\n") : "No matches.";
      }
      case "find_symbol": {
        const name = String(a.name || "").trim();
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*[?!]?$/.test(name)) return "Error: give one name (letters, digits, _ or $), for example find_symbol name=parseConfig. For other text use search.";
        const { abs } = safePath(c, a.path || ".");
        const files = statSync(abs).isDirectory() ? walk(abs, c.root) : [relative(c.root, abs).split(sep).join("/")];
        return cut(describeSymbol(name, findSymbol(name, files, readSmall(c.root)), a.show === "definition" || a.show === "usages" ? a.show : "both"), c.profile.maxToolChars);
      }
      case "outline": {
        const { abs, rel } = safePath(c, a.path);
        if (!existsSync(abs)) return `Error: ${rel} does not exist. Use list_files or find_files.`;
        if (statSync(abs).isDirectory()) return `Error: ${rel} is a folder. Use list_files.`;
        const text = readSmall(c.root)(rel); if (text === null) return "Error: that file is too large or is not text.";
        return cut(describeOutline(rel, symbolOutline(text, rel), text.split("\n").length), c.profile.maxToolChars);
      }
      case "find_files": {
        const re = globRe(a.pattern.includes("/") ? a.pattern : "**/" + a.pattern);
        const out = walk(c.root, c.root).filter((f) => re.test(f)).slice(0, 200);
        return out.length ? out.join("\n") : "No files match.";
      }
      case "write_file": {
        const { abs, rel } = safePath(c, a.path);
        if (isProtected(rel)) return `Error: ${rel} is protected and cannot be changed.`;
        if (SECRET_LIKE.test(a.content || "")) return "Error: the content looks like a secret key or token. Not written.";
        if (!(await allowEdit(c.mode, c.ask, rel, existsSync(abs) ? unifiedDiff(readFileSync(abs, "utf8"), a.content ?? "", rel) : "new file " + rel + "\n" + (a.content || "").slice(0, 1200)))) return "The user did not allow this change.";
        snapshot(c, abs, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, a.content ?? ""); c.touched.add(rel);
        return `Wrote ${rel} (${(a.content || "").split("\n").length} lines).` + (await afterEdit(c, abs, rel));
      }
      case "edit_file": {
        const { abs, rel } = safePath(c, a.path);
        if (isProtected(rel)) return `Error: ${rel} is protected and cannot be changed.`;
        if (!existsSync(abs)) return `Error: ${rel} does not exist. Use write_file to create it.`;
        if (SECRET_LIKE.test(a.new_text || "")) return "Error: the new text looks like a secret key or token. Not written.";
        const text = readFileSync(abs, "utf8"); const old = a.old_text ?? "";
        if (!old) return "Error: old_text is empty.";
        let next: string;
        const count = text.split(old).length - 1;
        if (count === 1 || (count > 1 && a.replace_all)) next = a.replace_all ? text.split(old).join(a.new_text) : text.replace(old, () => a.new_text);
        else if (count > 1) return `Error: old_text matches ${count} places in ${rel}. Add more surrounding lines to make it unique, or set replace_all.`;
        else {
          const f = c.profile.fuzzyEdit ? fuzzyFind(text, old) : null;
          if (!f) { const first = old.split("\n").find((l) => l.trim()) || ""; const at = first.trim() ? text.split("\n").findIndex((l) => l.includes(first.trim())) : -1; return `Error: old_text was not found in ${rel}.` + (at >= 0 ? ` A similar line exists at line ${at + 1}; read the file again and copy the text exactly.` : " Read the file again and copy the text exactly."); }
          next = text.slice(0, f.start) + a.new_text + text.slice(f.end);
        }
        if (!(await allowEdit(c.mode, c.ask, rel, unifiedDiff(text, next, rel)))) return "The user did not allow this change.";
        snapshot(c, abs, rel); writeFileSync(abs, next); c.touched.add(rel);
        return `Edited ${rel}.` + (await afterEdit(c, abs, rel));
      }
      case "run_command": {
        const cmd = String(a.command || "");
        const p = await allowCommand(c.mode, c.ask, cmd, c.settings);
        if (!p.ok) { c.ran.declined++; return "Not run. " + p.why; }
        c.ran.commands++;
        if (/\b(test|pytest|unittest|jest|vitest|go test|cargo test|check)\b/.test(cmd)) c.ran.tests = true;
        const secs = commandTimeout(c.settings, a.timeout_sec);
        return c.sandbox ? await c.sandbox(cmd, secs) : await sh(c, cmd, secs);
      }
      case "bg_start": {
        const cmd = String(a.command || "");
        const p = await allowCommand(c.mode, c.ask, cmd, c.settings);
        if (!p.ok) { c.ran.declined++; return "Not run. " + p.why; }
        c.ran.commands++;
        const id = c.bg.start(cmd, c.root);
        await new Promise((ok) => setTimeout(ok, 700));
        return `Started background job ${id}. Output so far:\n` + c.bg.output(id, 1500);
      }
      case "job_start": {
        const cmd = String(a.command || "");
        const p = await allowCommand(c.mode, c.ask, cmd, c.settings);
        if (!p.ok) { c.ran.declined++; return "Not run. " + p.why; }
        c.ran.commands++;
        const mins = Math.max(0, Number(a.max_minutes) || 0);
        const id = startJob(c.root, cmd, Math.round(mins * 60));
        await new Promise((ok) => setTimeout(ok, 700));
        return `Started saved job ${id}. It keeps running even if Syok Code exits. Log: .syok/jobs/${id}/out.log. Output so far:\n` + jobLog(c.root, id, 1500);
      }
      case "job_output": return a.id == null ? describeJobs(c.root) : jobLog(c.root, +a.id, a.tail || 4000);
      case "job_stop": return stopJob(c.root, +a.id);
      case "bg_output": return a.id == null ? c.bg.list() : c.bg.output(+a.id, 4000);
      case "bg_stop": return c.bg.stop(+a.id);
      case "web_search": {
        if (c.settings.web === false) return "Error: web tools are switched off in this project's settings.";
        const ok = (c.webOk ||= { hosts: new Set(), search: false });
        if (c.mode !== "auto" && !ok.search) {
          if (!(await c.ask("search the web", String(a.query || "").slice(0, 300)))) { c.ran.declined++; return "The user did not allow a web search."; }
          ok.search = true;
        }
        return cut(await webSearch({ query: a.query, max_results: a.max_results }, c.web || {}), c.profile.maxToolChars);
      }
      case "web_fetch": {
        if (c.settings.web === false) return "Error: web tools are switched off in this project's settings.";
        const chk = await checkUrl(a.url, c.web || {});
        if (!chk.ok) return "Error: " + chk.why;
        const ok = (c.webOk ||= { hosts: new Set(), search: false }), host = hostOf(chk.url!);
        if (c.mode !== "auto" && !ok.hosts.has(host) && !hostAllowed(host, c.settings.allow_hosts)) {
          if (!(await c.ask("read a web page", chk.url!.href.slice(0, 500) + (chk.local ? "\n(this address is on your own computer or private network)" : "")))) { c.ran.declined++; return "The user did not allow reading that web page."; }
          ok.hosts.add(host);
        }
        return await webFetch({ url: a.url, start: a.start, max_chars: Math.min(a.max_chars || 12000, c.profile.maxToolChars || 12000) }, c.web || {}, chk);
      }
      case "delegate": return "Error: delegate only works in the main agent loop.";
      case "parallel_edit": return "Error: parallel_edit only works in the main agent loop.";
      default: return `Error: unknown tool ${name}.`;
    }
  } catch (e: any) { return "Error: " + (e?.message || e); }
}
/** allow_hosts entries match the host itself and its sub-domains ("python.org" allows docs.python.org). */
export function hostAllowed(host: string, list?: string[]): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return (list || []).some((x) => { const a = String(x).toLowerCase().trim().replace(/^\*?\./, ""); return !!a && (h === a || h.endsWith("." + a)); });
}
/** The syntax check that follows every successful edit (switched off with "checks": false). A check that cannot run never blocks the edit. */
async function afterEdit(c: Ctx, abs: string, rel: string): Promise<string> {
  let out = "";
  if (c.settings.checks !== false) { try { out += quickLine(await quickCheck(abs, rel, c.root)); } catch {} }
  // With --sandbox, commands run in the sandbox's copy of the project: copy the edit there too.
  if (c.sandboxPut) out += "\n" + (await syncSandbox(c, [rel])).join("\n");
  return out;
}
/** Copy the current state of these project files into the sandbox (a file that no longer exists is removed there). */
export async function syncSandbox(c: Ctx, rels: string[]): Promise<string[]> {
  const notes: string[] = [];
  for (const rel of rels) {
    if (!c.sandboxPut) break;
    const abs = join(c.root, rel);
    try { notes.push(await c.sandboxPut(rel, existsSync(abs) ? readFileSync(abs, "utf8") : null)); }
    catch (e: any) { notes.push("WARNING: this edit is NOT in the sandbox (" + (e?.message || e) + ")."); }
  }
  return notes;
}
/** Run one command line in the project and return its output and exit code (used for the project check before finishing). */
export async function runCheckCommand(c: Ctx, cmd: string, secs: number): Promise<{ code: number | null; output: string }> {
  // With --sandbox the check runs where the commands run: in the sandbox.
  const raw = c.sandbox ? await c.sandbox(cmd, secs) : await sh(c, cmd, secs);
  const m = /\n?\[exit code (-?\d+|none)\]$/.exec(raw);
  return { code: m && m[1] !== "none" ? +m[1] : null, output: m ? raw.slice(0, m.index) : raw };
}
function sh(c: Ctx, cmd: string, secs: number): Promise<string> {
  return new Promise((res) => {
    const env = cleanEnv();
    const ch = spawnCommand(cmd, c.root, env, ["ignore", "pipe", "pipe"]);
    let out = "", done = false;
    const add = (d: Buffer) => { out += d.toString(); if (out.length > 400_000) out = out.slice(-200_000); };
    ch.stdout!.on("data", add); ch.stderr!.on("data", add);
    const kill = () => killTree(ch);
    const t = setTimeout(() => { if (!done) { kill(); out += `\n[stopped after ${secs} seconds]`; } }, secs * 1000);
    ch.on("close", (code) => { done = true; clearTimeout(t); res(cut(out.trim(), c.profile.maxToolChars) + `\n[exit code ${code ?? "none"}]`); });
    ch.on("error", (e) => { done = true; clearTimeout(t); res("Error: " + e.message); });
  });
}
export function undoAll(c: Ctx): string[] {
  const done: string[] = [];
  for (const [rel, orig] of c.snapshots) {
    const abs = resolve(c.root, rel);
    if (orig === null) { try { unlinkSync(abs); } catch {} } else writeFileSync(abs, orig);
    done.push(rel);
  }
  c.snapshots.clear(); c.touched.clear(); return done;
}
export { spawnSync };
