import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, relative, dirname, join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { spawnCommand, killTree } from "./shell.ts";
import { isProtected, SECRET_LIKE, allowEdit, allowCommand, type Mode, type Asker, type Settings } from "./perm.ts";
import type { Profile } from "./profiles.ts";
import { unifiedDiff } from "./diff.ts";
import { Bg } from "./bg.ts";
import type { McpClient } from "./mcp.ts";

const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".next", "target"]);
const fn = (name: string, description: string, properties: any, required: string[]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
export const TOOLS = [
  fn("list_files", "List files and folders in a directory (relative to the project root). Use '.' for the root.", { path: { type: "string" } }, ["path"]),
  fn("read_file", "Read a text file with line numbers. Optional 1-based start_line and end_line for big files.", { path: { type: "string" }, start_line: { type: "integer" }, end_line: { type: "integer" } }, ["path"]),
  fn("search", "Search file contents with a regular expression. Returns file:line:text. Optional glob such as '*.ts' limits files.", { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, ["pattern"]),
  fn("find_files", "Find files by name pattern, for example '**/*.test.js'.", { pattern: { type: "string" } }, ["pattern"]),
  fn("edit_file", "Replace text in an existing file. old_text must match exactly and be unique (add surrounding lines if not). Set replace_all to change every match.", { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, replace_all: { type: "boolean" } }, ["path", "old_text", "new_text"]),
  fn("write_file", "Create a new file or fully replace a file with new content.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  fn("run_command", "Run a shell command in the project root (tests, build, git status...). Output is cut if long. timeout_sec defaults to 120.", { command: { type: "string" }, timeout_sec: { type: "integer" } }, ["command"]),
  fn("bg_start", "Start a long-running command in the background (dev server, watcher). Returns a job id. Use bg_output to read it and bg_stop to stop it.", { command: { type: "string" } }, ["command"]),
  fn("bg_output", "Read the latest output of a background job. Without id, lists all jobs.", { id: { type: "integer" } }, []),
  fn("bg_stop", "Stop a background job.", { id: { type: "integer" } }, ["id"]),
  fn("delegate", "Hand a sub-task to a helper with a fresh, empty context so it does not fill your memory. role 'explorer' (default) is read-only: use it to search or read a lot and get a short answer; several explorers in one message run in parallel. role 'worker' may edit files and run commands; use it for one self-contained change. Give a complete, specific task.", { task: { type: "string" }, role: { type: "string", enum: ["explorer", "worker"] } }, ["task"]),
  fn("finish", "Call when the task is done (or cannot be done). Give a short plain summary.", { summary: { type: "string" } }, ["summary"]),
];

export const READONLY = new Set(["list_files", "read_file", "search", "find_files", "finish"]);
export function toolDefs(c: Ctx): any[] {
  let t: any[] = TOOLS.filter((x) => !c.allowed || c.allowed.has(x.function.name));
  if (c.depth > 0) t = t.filter((x) => x.function.name !== "delegate");
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
export interface Ctx { root: string; mode: Mode; ask: Asker; settings: Settings; profile: Profile; snapshots: Map<string, string | null>; touched: Set<string>; ran: { tests: boolean; commands: number; declined: number }; bg: Bg; mcp: McpClient[]; depth: number; allowed?: Set<string>; sandbox?: (cmd: string, secs: number) => Promise<string> }
export function makeCtx(root: string, mode: Mode, ask: Asker, settings: Settings, profile: Profile): Ctx {
  return { root: resolve(root), mode, ask, settings, profile, snapshots: new Map(), touched: new Set(), ran: { tests: false, commands: 0, declined: 0 }, bg: new Bg(), mcp: [], depth: 0 };
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
        return `Wrote ${rel} (${(a.content || "").split("\n").length} lines).`;
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
        return `Edited ${rel}.`;
      }
      case "run_command": {
        const cmd = String(a.command || "");
        const p = await allowCommand(c.mode, c.ask, cmd, c.settings);
        if (!p.ok) { c.ran.declined++; return "Not run. " + p.why; }
        c.ran.commands++;
        if (/\b(test|pytest|unittest|jest|vitest|go test|cargo test|check)\b/.test(cmd)) c.ran.tests = true;
        const secs = Math.min(600, Math.max(5, a.timeout_sec || 120));
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
      case "bg_output": return a.id == null ? c.bg.list() : c.bg.output(+a.id, 4000);
      case "bg_stop": return c.bg.stop(+a.id);
      case "delegate": return "Error: delegate only works in the main agent loop.";
      default: return `Error: unknown tool ${name}.`;
    }
  } catch (e: any) { return "Error: " + (e?.message || e); }
}
function sh(c: Ctx, cmd: string, secs: number): Promise<string> {
  return new Promise((res) => {
    const env = { ...process.env }; delete env.SYOK_API_KEY; delete env.GITHUB_TOKEN;
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
