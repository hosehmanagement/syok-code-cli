// Language helpers: exact code intelligence from each language's own tooling (the "language server" editors use).
// find_symbol and outline read the text; a language helper understands the code: which definition a name really
// refers to, every real use of it, its type, and the errors the compiler would report.
//
// Syok Code never downloads a helper by itself. It uses one that is already on the computer (or in the project's
// node_modules), and "syok lang" shows which are found and the one line that installs a missing one.
// A helper is a program that reads the project, so when confinement is on it runs confined like the AI's commands.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { cleanEnv } from "./shell.ts";
import { getConfine, confineArgv } from "./confine.ts";

export interface ServerSpec { command: string; args?: string[] }
export interface Lang { id: string; name: string; exts: string[]; ids: Record<string, string>; servers: ServerSpec[]; install: string; init?: any }
export const LANGS: Lang[] = [
  { id: "typescript", name: "TypeScript and JavaScript", exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"], ids: { ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact" }, servers: [{ command: "typescript-language-server", args: ["--stdio"] }], install: "npm install -g typescript-language-server typescript",
    // Without this, the first answers come from a quick helper that only knows one file: a definition would stop at the import line.
    init: { tsserver: { useSyntaxServer: "never" } } },
  { id: "python", name: "Python", exts: [".py", ".pyi"], ids: { ".py": "python", ".pyi": "python" }, servers: [{ command: "pyright-langserver", args: ["--stdio"] }, { command: "basedpyright-langserver", args: ["--stdio"] }, { command: "pylsp" }], install: "npm install -g pyright" },
  { id: "go", name: "Go", exts: [".go"], ids: { ".go": "go" }, servers: [{ command: "gopls" }], install: "go install golang.org/x/tools/gopls@latest" },
  { id: "rust", name: "Rust", exts: [".rs"], ids: { ".rs": "rust" }, servers: [{ command: "rust-analyzer" }], install: "rustup component add rust-analyzer" },
  { id: "c", name: "C and C++", exts: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"], ids: { ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp" }, servers: [{ command: "clangd" }], install: "install clangd with your package manager (the package is called clangd)" },
  { id: "ruby", name: "Ruby", exts: [".rb"], ids: { ".rb": "ruby" }, servers: [{ command: "ruby-lsp" }, { command: "solargraph", args: ["stdio"] }], install: "gem install ruby-lsp" },
  { id: "php", name: "PHP", exts: [".php"], ids: { ".php": "php" }, servers: [{ command: "intelephense", args: ["--stdio"] }], install: "npm install -g intelephense" },
];
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".next", "vendor", ".syok", "coverage"]);
export const langOf = (file: string): Lang | undefined => { const e = extname(file).toLowerCase(); return LANGS.find((l) => l.exts.includes(e)); };

/** Which languages this project is written in, by counting files (a quick look, not a full walk). */
export function detectLangs(root: string, limit = 3000): Array<{ lang: Lang; files: number }> {
  const count = new Map<string, number>(); let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (seen >= limit || depth > 6) return; let names: string[] = []; try { names = readdirSync(dir); } catch { return; }
    for (const n of names) { if (seen >= limit) return; if (SKIP.has(n) || n.startsWith(".")) continue; const p = join(dir, n); let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1); else { seen++; const l = langOf(n); if (l) count.set(l.id, (count.get(l.id) || 0) + 1); } }
  };
  walk(root, 0);
  return LANGS.filter((l) => count.has(l.id)).map((l) => ({ lang: l, files: count.get(l.id)! })).sort((a, b) => b.files - a.files);
}
const found = new Map<string, string>();
function which(name: string): string {
  if (!found.has(name)) { let p = ""; try { const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", windowsHide: true }); if (r.status === 0) p = String(r.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).find((x) => process.platform !== "win32" || /\.(cmd|exe|bat)$/i.test(x)) || String(r.stdout || "").split(/\r?\n/)[0].trim(); } catch {} found.set(name, p); }
  return found.get(name)!;
}
export function resetLspCache() { found.clear(); avail.clear(); }
export type LspSetting = false | Record<string, ServerSpec | false> | undefined;
/** The helper to start for a language in this project: one from the settings, one in the project's node_modules, or one on the computer. */
export function findServer(lang: Lang, root: string, setting: LspSetting): { exe: string; args: string[]; from: string } | null {
  if (setting === false) return null; const own = setting && typeof setting === "object" ? setting[lang.id] : undefined;
  if (own === false) return null;
  if (own && typeof own.command === "string" && own.command) { const exe = which(own.command) || (existsSync(resolve(root, own.command)) ? resolve(root, own.command) : ""); return exe ? { exe, args: Array.isArray(own.args) ? own.args.map(String) : [], from: "your settings" } : null; }
  for (const s of lang.servers) {
    const local = join(root, "node_modules", ".bin", s.command + (process.platform === "win32" ? ".cmd" : "")); if (existsSync(local)) return { exe: local, args: s.args || [], from: "this project" };
    const exe = which(s.command); if (exe) return { exe, args: s.args || [], from: "this computer" };
  }
  return null;
}
const avail = new Map<string, boolean>();
/** True when at least one language of this project has a helper that can be started. Remembered per project. */
export function lspAvailable(root: string, setting: LspSetting): boolean {
  if (setting === false) return false; const k = root + "\0" + JSON.stringify(setting ?? null);
  if (!avail.has(k)) avail.set(k, detectLangs(root).some((d) => !!findServer(d.lang, root, setting)));
  return avail.get(k)!;
}
/** For "syok lang": what this project is written in, which helpers are found, and how to get the missing ones. */
export function describeLangs(root: string, setting: LspSetting): string {
  const d = detectLangs(root); if (!d.length) return "No code in a language Syok Code has a helper for was found in this folder. (It knows: " + LANGS.map((l) => l.name).join(", ") + ".)";
  const L = ["Language helpers give the AI exact answers: where a name is really defined, every real use, types, and the compiler's errors.", ""];
  for (const { lang, files } of d) { const s = findServer(lang, root, setting);
    L.push(`  ${lang.name} (${files} file${files === 1 ? "" : "s"}): ${setting === false ? "switched off in the settings" : s ? `ready, using ${s.exe} (from ${s.from})` : "no helper found. Install one with:  " + lang.install}`); }
  L.push("", "Syok Code never downloads a helper by itself. After installing one, just start syok again. Without one, find_symbol and outline still work.");
  return L.join("\n");
}

// ---- talking to one helper ----
export class LspClient {
  proc!: ChildProcess; id = 0; buf = Buffer.alloc(0); pending = new Map<number, { ok: (v: any) => void; no: (e: Error) => void; t: any }>(); dead = ""; open = new Map<string, { version: number; mtime: number }>();
  changes = 0; diags = new Map<string, any[]>(); diagWait = new Map<string, Array<() => void>>(); caps: any = {}; said = "";
  constructor(public lang: Lang, public root: string, public exe: string, public args: string[]) {}
  private send(o: any) { if (this.dead) return; const body = Buffer.from(JSON.stringify(o), "utf8"); try { this.proc.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])); } catch {} }
  request(method: string, params: any, ms = 20000): Promise<any> {
    return new Promise((ok, no) => { if (this.dead) return no(new Error(this.dead)); const id = ++this.id;
      const t = setTimeout(() => { this.pending.delete(id); no(new Error(`the ${this.lang.name} helper did not answer in time`)); }, ms);
      this.pending.set(id, { ok, no, t }); this.send({ jsonrpc: "2.0", id, method, params }); });
  }
  notify(method: string, params: any) { this.send({ jsonrpc: "2.0", method, params }); }
  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const head = this.buf.indexOf("\r\n\r\n"); if (head < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, head).toString("ascii")); if (!m) { this.buf = this.buf.subarray(head + 4); continue; }
      const len = Number(m[1]); if (len > 64_000_000) { this.fail("the helper sent something far too large"); return; }
      if (this.buf.length < head + 4 + len) return;
      const body = this.buf.subarray(head + 4, head + 4 + len).toString("utf8"); this.buf = this.buf.subarray(head + 4 + len);
      let msg: any; try { msg = JSON.parse(body); } catch { continue; }
      if (msg.id !== undefined && (("result" in msg) || ("error" in msg)) && msg.method === undefined) { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); clearTimeout(p.t); msg.error ? p.no(new Error(String(msg.error.message || "the helper reported an error").slice(0, 300))) : p.ok(msg.result); } }
      else if (msg.method === "textDocument/publishDiagnostics") { const uri = String(msg.params?.uri || ""); this.diags.set(uri, Array.isArray(msg.params?.diagnostics) ? msg.params.diagnostics : []); const w = this.diagWait.get(uri); if (w) { this.diagWait.delete(uri); w.forEach((f) => f()); } }
      else if (msg.id !== undefined && msg.method) { // the helper asks us something: answer the few questions that matter, politely decline the rest
        const r = msg.method === "workspace/configuration" ? (msg.params?.items || []).map(() => null) : msg.method === "workspace/workspaceFolders" ? [{ uri: pathToFileURL(this.root).href, name: "project" }] : null;
        this.send({ jsonrpc: "2.0", id: msg.id, result: r });
      }
    }
  }
  private fail(why: string) { if (this.dead) return; this.dead = why; for (const p of this.pending.values()) { clearTimeout(p.t); p.no(new Error(why)); } this.pending.clear(); for (const w of this.diagWait.values()) w.forEach((f) => f()); this.diagWait.clear(); }
  async start() {
    const c = getConfine(); let exe = this.exe, args = this.args; const opts: any = { cwd: this.root, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
    if (c && c.kind === "windows-low" && c.low) { exe = c.low.cmd; args = ["/d", "/s", "/c", `""${this.exe}" ${this.args.join(" ")}"`]; opts.windowsVerbatimArguments = true; opts.env = { ...opts.env, ...c.low.env }; }
    else if (c) { const w = confineArgv(c, this.exe, this.args, this.root); exe = w.exe; args = w.args; }
    else if (process.platform === "win32" && /\.(cmd|bat)$/i.test(this.exe)) opts.shell = true;
    this.proc = spawn(opts.shell ? `"${exe}"` : exe, args, opts);
    this.proc.stdout!.on("data", (d: Buffer) => this.onData(d)); this.proc.stderr!.on("data", (d) => { this.said = (this.said + d).slice(-500); });
    this.proc.on("error", (e) => this.fail(`the ${this.lang.name} helper could not start: ${e.message}`));
    this.proc.on("close", (code) => this.fail(`the ${this.lang.name} helper stopped${code ? ` (code ${code})` : ""}${this.said.trim() ? ": " + this.said.trim().split("\n").slice(-2).join(" ").slice(0, 300) : ""}`));
    this.proc.stdin!.on("error", () => {});
    const rootUri = pathToFileURL(this.root).href;
    const init = await this.request("initialize", { processId: process.pid, rootUri, rootPath: this.root, workspaceFolders: [{ uri: rootUri, name: "project" }], clientInfo: { name: "syok-code" }, ...(this.lang.init ? { initializationOptions: this.lang.init } : {}),
      capabilities: { workspace: { workspaceFolders: true, configuration: true, didChangeWatchedFiles: { dynamicRegistration: false }, symbol: {} }, textDocument: { synchronization: { didSave: false }, definition: { linkSupport: true }, references: {}, hover: { contentFormat: ["plaintext", "markdown"] }, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, publishDiagnostics: {}, diagnostic: {} } } }, 45000);
    this.caps = init?.capabilities || {}; this.notify("initialized", {});
  }
  uri(abs: string) { return pathToFileURL(abs).href; }
  /** Makes sure the helper has the file as it is on the disk right now. */
  sync(abs: string): string {
    const uri = this.uri(abs); let text = "", mtime = 0; try { text = readFileSync(abs, "utf8"); mtime = statSync(abs).mtimeMs; } catch { return uri; }
    const o = this.open.get(uri); const lid = this.lang.ids[extname(abs).toLowerCase()] || this.lang.id;
    if (!o) { this.changes++; this.open.set(uri, { version: 1, mtime }); this.diags.delete(uri); this.notify("textDocument/didOpen", { textDocument: { uri, languageId: lid, version: 1, text } }); }
    else if (o.mtime !== mtime) { this.changes++; o.version++; o.mtime = mtime; this.diags.delete(uri); this.notify("textDocument/didChange", { textDocument: { uri, version: o.version }, contentChanges: [{ text }] }); }
    return uri;
  }
  /** Every file the helper has open is brought up to date, and it is told about files changed on the disk. */
  refresh(changed: string[] = []) {
    const before = this.changes;
    for (const uri of [...this.open.keys()]) { let abs = ""; try { abs = fileURLToPath(uri); } catch { continue; } if (existsSync(abs)) this.sync(abs); else { this.open.delete(uri); this.notify("textDocument/didClose", { textDocument: { uri } }); } }
    const mine = changed.filter((f) => langOf(f)?.id === this.lang.id);
    for (const f of mine) if (existsSync(f)) this.sync(f); // a helper does not always notice a change on the disk by itself: hand it the new text
    const ev = mine.map((f) => ({ uri: this.uri(f), type: existsSync(f) ? 2 : 3 }));
    if (ev.length) this.notify("workspace/didChangeWatchedFiles", { changes: ev });
    // A change in one file can create or remove errors in another, so every remembered list of problems is out of date now.
    if (this.changes !== before) this.diags.clear();
  }
  /** The problems the helper reports for a file, or null when it sent nothing in time (which is not the same as "no problems"). */
  async diagnostics(abs: string, ms = 15000): Promise<any[] | null> {
    const uri = this.sync(abs);
    if (this.caps.diagnosticProvider) { try { const r = await this.request("textDocument/diagnostic", { textDocument: { uri } }, ms); if (r && Array.isArray(r.items)) return r.items; } catch { if (this.dead) throw new Error(this.dead); } }
    if (!this.diags.has(uri)) await new Promise<void>((ok) => { const t = setTimeout(ok, ms); const l = this.diagWait.get(uri) || []; l.push(() => { clearTimeout(t); ok(); }); this.diagWait.set(uri, l); });
    if (this.dead) throw new Error(this.dead);
    if (this.diags.has(uri)) await new Promise((ok) => setTimeout(ok, 250)); // helpers often send a first, incomplete list: give the full one a moment
    return this.diags.get(uri) ?? null;
  }
  stop() { if (!this.proc || this.dead) return; const p = this.proc; this.request("shutdown", null, 2000).catch(() => {}).finally(() => { this.notify("exit", null); setTimeout(() => { try { p.kill(); } catch {} }, 300).unref?.(); }); setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 3000).unref?.(); }
}

export class LspSet {
  clients = new Map<string, Promise<LspClient>>(); synced = new Set<string>();
  constructor(public root: string, public setting: LspSetting) {}
  async forFile(abs: string): Promise<LspClient> {
    const lang = langOf(abs); if (!lang) throw new Error(`there is no language helper for ${extname(abs) || "this kind of"} files. Use find_symbol, outline or search instead`);
    const spec = findServer(lang, this.root, this.setting); if (!spec) throw new Error(`no ${lang.name} helper is installed on this computer (the user can install one with: ${lang.install}). Use find_symbol, outline or search instead`);
    let p = this.clients.get(lang.id);
    if (p) { const c = await p.catch(() => null); if (!c || c.dead) { this.clients.delete(lang.id); p = undefined; } }
    if (!p) { const c = new LspClient(lang, this.root, spec.exe, spec.args); p = c.start().then(() => c, (e) => { c.stop(); throw e; }); this.clients.set(lang.id, p); }
    return p;
  }
  stopAll() { for (const p of this.clients.values()) p.then((c) => c.stop(), () => {}); this.clients.clear(); }
}

// ---- the tool the AI calls ----
const KINDS = ["", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum member", "struct", "event", "operator", "type parameter"];
const SEV = ["", "error", "warning", "note", "hint"];
function lineOf(abs: string, n: number, cache: Map<string, string[]>): string { if (!cache.has(abs)) { try { cache.set(abs, readFileSync(abs, "utf8").split(/\r?\n/)); } catch { cache.set(abs, []); } } return (cache.get(abs)![n] || "").trim().slice(0, 160); }
function place(root: string, uri: string, range: any, cache: Map<string, string[]>): string {
  let abs = uri; try { abs = fileURLToPath(uri); } catch {} const rel = relative(root, abs); const inside = rel && !rel.startsWith("..") && !resolve(root, rel).includes(`${sep}node_modules${sep}`);
  const l = Number(range?.start?.line) || 0; return `${rel.startsWith("..") ? abs : rel.split(sep).join("/")}:${l + 1}${inside || !rel.startsWith("..") ? "  " + lineOf(abs, l, cache) : "  (outside the project)"}`;
}
function hoverText(h: any): string { const c = h?.contents; const one = (x: any): string => (typeof x === "string" ? x : x?.value ? String(x.value) : ""); const t = Array.isArray(c) ? c.map(one).join("\n") : one(c); return t.replace(/```\w*\n?/g, "").trim().slice(0, 1500); }

export interface LspArgs { action?: string; path?: string; line?: number; symbol?: string; query?: string }
/** Runs one question against the right helper and returns the answer as short text for the AI. */
export async function lspTool(set: LspSet, root: string, a: LspArgs, changed: string[] = []): Promise<string> {
  const action = String(a.action || ""); const cache = new Map<string, string[]>();
  if (!["definition", "references", "hover", "diagnostics", "symbols"].includes(action)) return "Error: action must be one of definition, references, hover, diagnostics, symbols.";
  if (action === "symbols" && a.query && !a.path) {
    const d = detectLangs(root).find((x) => findServer(x.lang, root, set.setting)); if (!d) return "Error: no language helper is available for this project.";
    const anyFile = firstFile(root, d.lang); if (!anyFile) return "Error: no source file found to start the helper with.";
    const c = await set.forFile(anyFile); c.sync(anyFile); c.refresh(changed);
    const r: any[] = (await c.request("workspace/symbol", { query: String(a.query) })) || [];
    if (!r.length) return `No symbol matching "${a.query}" was found by the ${c.lang.name} helper.`;
    return r.slice(0, 60).map((s) => `${KINDS[s.kind] || "symbol"} ${s.containerName ? s.containerName + "." : ""}${s.name}  ${place(root, s.location?.uri || "", s.location?.range, cache)}`).join("\n") + (r.length > 60 ? `\n...and ${r.length - 60} more` : "");
  }
  if (!a.path) return "Error: give the file in \"path\".";
  const abs = resolve(root, String(a.path)); const rel = relative(root, abs); if (rel.startsWith("..")) return "Error: the file is outside the project."; if (!existsSync(abs)) return `Error: ${a.path} does not exist.`;
  const c = await set.forFile(abs); c.refresh(changed); const uri = c.sync(abs);
  if (action === "diagnostics") {
    const d = await c.diagnostics(abs); if (d === null) return `The ${c.lang.name} helper did not report on ${a.path} in time, so this says nothing about whether the file is correct. Run the project's build or tests to find out.`;
    if (!d.length) return `The ${c.lang.name} helper reports no problems in ${a.path}.`;
    const sorted = [...d].sort((x, y) => (x.severity || 1) - (y.severity || 1) || (x.range?.start?.line || 0) - (y.range?.start?.line || 0));
    return `${d.filter((x) => (x.severity || 1) === 1).length} error(s), ${d.filter((x) => x.severity === 2).length} warning(s) in ${a.path}:\n` + sorted.slice(0, 50).map((x) => `${a.path}:${(x.range?.start?.line || 0) + 1}  ${SEV[x.severity || 1] || "error"}: ${String(x.message).replace(/\s+/g, " ").slice(0, 300)}${x.code !== undefined ? ` [${x.code}]` : ""}`).join("\n") + (d.length > 50 ? `\n...and ${d.length - 50} more` : "");
  }
  if (action === "symbols") {
    const r: any[] = (await c.request("textDocument/documentSymbol", { textDocument: { uri } })) || []; if (!r.length) return `The ${c.lang.name} helper found no symbols in ${a.path}.`;
    const out: string[] = []; const walk = (items: any[], depth: number) => { for (const s of items) { if (out.length >= 200) return; const range = s.selectionRange || s.range || s.location?.range; out.push(`${"  ".repeat(depth)}${(range?.start?.line || 0) + 1}: ${KINDS[s.kind] || "symbol"} ${s.name}${s.detail ? "  " + String(s.detail).slice(0, 80) : ""}`); if (Array.isArray(s.children)) walk(s.children, depth + 1); } };
    walk(r, 0); return out.join("\n");
  }
  // The other three need a position: a line, and the name on that line to point at.
  const lines = readFileSync(abs, "utf8").split(/\r?\n/); let ln = Math.floor(Number(a.line)) - 1; const sym = String(a.symbol || "");
  if (!Number.isInteger(ln) || ln < 0 || ln >= lines.length) { if (!sym) return "Error: give \"line\" (the line number) and \"symbol\" (the name on that line)."; ln = lines.findIndex((l) => new RegExp(`(^|[^\\w$])${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`).test(l)); if (ln < 0) return `Error: "${sym}" does not appear in ${a.path}.`; }
  let col = 0;
  if (sym) { const m = new RegExp(`(^|[^\\w$])(${sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})([^\\w$]|$)`).exec(lines[ln]); if (!m) return `Error: "${sym}" is not on line ${ln + 1} of ${a.path}. That line is: ${lines[ln].trim().slice(0, 160)}`; col = m.index + m[1].length; }
  else { col = Math.max(0, lines[ln].search(/\S/)); }
  const pos = { textDocument: { uri }, position: { line: ln, character: col } };
  if (action === "hover") { const h = await c.request("textDocument/hover", pos); const t = hoverText(h); return t || `The ${c.lang.name} helper has nothing to say about that spot.`; }
  if (action === "definition") {
    let r: any = await c.request("textDocument/definition", pos); if (r && !Array.isArray(r)) r = [r]; if (!r || !r.length) return `The ${c.lang.name} helper found no definition for ${sym || "that spot"}.`;
    return "Defined at:\n" + r.slice(0, 10).map((x: any) => place(root, x.targetUri || x.uri, x.targetSelectionRange || x.targetRange || x.range, cache)).join("\n");
  }
  const r: any[] = (await c.request("textDocument/references", { ...pos, context: { includeDeclaration: true } }, 40000)) || [];
  if (!r.length) return `The ${c.lang.name} helper found no uses of ${sym || "that spot"}.`;
  const rows = [...new Set(r.map((x) => place(root, x.uri, x.range, cache)))];
  return `${rows.length} place(s) refer to ${sym || "it"} (the definition included):\n` + rows.slice(0, 80).join("\n") + (rows.length > 80 ? `\n...and ${rows.length - 80} more` : "");
}
function firstFile(root: string, lang: Lang): string {
  let hit = ""; const walk = (dir: string, depth: number) => { if (hit || depth > 5) return; let names: string[] = []; try { names = readdirSync(dir); } catch { return; } for (const n of names.sort()) { if (hit) return; if (SKIP.has(n) || n.startsWith(".")) continue; const p = join(dir, n); let st; try { st = statSync(p); } catch { continue; } if (st.isDirectory()) walk(p, depth + 1); else if (lang.exts.includes(extname(n).toLowerCase())) hit = p; } };
  walk(root, 0); return hit;
}
