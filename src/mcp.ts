// Minimal MCP client. Lets Syok Code use tool servers: local ones (a program on this computer, over stdio) and hosted ones
// (a web address, over HTTP with a fixed key).
// Configure in .syok/settings.json:
//   { "mcpServers": { "local":  { "command": "node", "args": ["server.js"], "env": {} },
//                     "hosted": { "url": "https://tools.example.com/mcp", "headers": { "Authorization": "Bearer ${MY_TOOLS_KEY}" } } } }
// In a header value, ${NAME} is replaced by that environment variable, so the key itself need not be written in the file.
import { spawn, type ChildProcess } from "node:child_process";
import { cleanEnv, SECRET_ENV } from "./shell.ts";
export interface McpCfg { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }
export class McpClient {
  proc!: ChildProcess; buf = ""; id = 0; pending = new Map<number, (m: any) => void>(); tools: any[] = []; dead = "";
  constructor(public name: string, public cfg: McpCfg, public cwd: string) {}
  private send(o: any) { this.proc.stdin!.write(JSON.stringify(o) + "\n"); }
  private req(method: string, params: any, ms = 60000): Promise<any> {
    return new Promise((ok, no) => {
      if (this.dead) return no(new Error(this.dead));
      const id = ++this.id; const t = setTimeout(() => { this.pending.delete(id); no(new Error(`${method} timed out`)); }, ms);
      this.pending.set(id, (m) => { clearTimeout(t); m.error ? no(new Error(m.error.message || "MCP error")) : ok(m.result); });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  async start() {
    const env = { ...cleanEnv(), ...(this.cfg.env || {}) }; // a server gets only the keys its own settings name
    this.proc = spawn(this.cfg.command!, this.cfg.args || [], { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.on("data", (d) => {
      this.buf += d; let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); const f = m.id != null && this.pending.get(m.id); if (f) { this.pending.delete(m.id); f(m); } } catch {} }
    });
    let said = ""; this.proc.stderr!.on("data", (d) => { said = (said + d).slice(-600); }); // kept to explain a server that stops
    this.proc.on("error", (e) => { this.dead = "MCP server failed: " + e.message; for (const f of this.pending.values()) f({ error: { message: this.dead } }); });
    this.proc.on("close", (code) => { const last = said.trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 400); this.dead = this.dead || `its program stopped${code ? " with code " + code : ""}${last ? ". It said: " + last : ""}`; for (const f of this.pending.values()) f({ error: { message: this.dead } }); this.pending.clear(); });
    await this.req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "syok-code", version: "0.1.0" } }, 20000);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const r = await this.req("tools/list", {}, 20000);
    this.tools = r.tools || [];
  }
  defs() {
    return this.tools.map((t) => ({ type: "function", function: { name: `mcp__${this.name}__${t.name}`, description: `[${this.name}] ${t.description || t.name}`.slice(0, 600), parameters: t.inputSchema || { type: "object", properties: {} } } }));
  }
  async call(tool: string, args: any): Promise<string> {
    const r = await this.req("tools/call", { name: tool, arguments: args || {} });
    const text = (r.content || []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    return (r.isError ? "Tool error: " : "") + text;
  }
  stop() { try { this.proc.kill("SIGKILL"); } catch {} }
}
const toolDefsOf = (name: string, tools: any[]) => tools.map((t) => ({ type: "function", function: { name: `mcp__${name}__${t.name}`, description: `[${name}] ${t.description || t.name}`.slice(0, 600), parameters: t.inputSchema || { type: "object", properties: {} } } }));
const resultText = (r: any) => ((r?.isError ? "Tool error: " : "") + (r?.content || []).map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n"));

/** What is wrong with a hosted server's address, or "" when it may be used. */
export function urlProblem(url: string): string {
  let u: URL; try { u = new URL(url); } catch { return "its address is not a web address"; }
  if (u.username || u.password) return "its address must not contain a name or password (use headers)";
  if (u.protocol === "https:") return "";
  if (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return "";
  return "its address must start with https:// (http:// is only allowed for this computer itself)";
}
/** Fill ${NAME} in header values from the environment. Syok's own keys and tokens are never handed to a tool server. */
export function fillHeaders(headers: Record<string, string> | undefined, env: Record<string, string | undefined> = process.env): { headers: Record<string, string>; problem: string } {
  const out: Record<string, string> = {}; let problem = "";
  for (const [k, v] of Object.entries(headers || {})) {
    if (typeof v !== "string" || /[\r\n]/.test(k + v)) { problem ||= `header ${k} is not plain text`; continue; }
    out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      if (SECRET_ENV.includes(name)) { problem ||= `header ${k} asks for ${name}, which is never given to a tool server`; return ""; }
      const val = env[name]; if (!val) { problem ||= `header ${k} needs the environment variable ${name}, which is not set`; return ""; }
      return val.trim();
    });
  }
  return { headers: out, problem };
}
/** A hosted tool server (MCP "Streamable HTTP"): every request is one POST; the answer is JSON or a short event stream. */
export class HttpMcp {
  tools: any[] = []; id = 0; session = ""; headers: Record<string, string> = {}; version = "2025-06-18";
  constructor(public name: string, public cfg: McpCfg, public fetchImpl: typeof fetch = fetch) {}
  private async post(body: any, ms: number): Promise<any> {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), ms);
    try {
      const res = await this.fetchImpl(this.cfg.url!, { method: "POST", redirect: "error", signal: ac.signal, body: JSON.stringify(body),
        headers: { ...this.headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(this.session ? { "mcp-session-id": this.session } : {}), ...(body.method !== "initialize" ? { "mcp-protocol-version": this.version } : {}) } });
      if (res.status === 401 || res.status === 403) throw new Error(`the server refused the key (${res.status})`);
      if (res.status === 404 && this.session) throw Object.assign(new Error("the server forgot this session"), { expired: true });
      if (!res.ok) throw new Error(`the server answered with error ${res.status}`);
      const sid = res.headers.get("mcp-session-id"); if (sid && body.method === "initialize") this.session = sid;
      if (body.id == null) { try { await res.body?.cancel(); } catch {} return null; } // a notice: nothing to read
      const type = res.headers.get("content-type") || "";
      const text = await readCapped(res, 4_000_000);
      let msg: any = null;
      if (type.includes("text/event-stream")) {
        for (const ev of text.split(/\r?\n\r?\n/)) { const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n"); if (!data) continue; try { const m = JSON.parse(data); if (m && m.id === body.id && ("result" in m || "error" in m)) { msg = m; break; } } catch {} }
      } else { try { msg = JSON.parse(text); } catch {} }
      if (!msg || msg.id !== body.id) throw new Error("the server did not answer like a tool server");
      if (msg.error) throw new Error(String(msg.error.message || "tool server error").slice(0, 300));
      return msg.result;
    } catch (e: any) { if (ac.signal.aborted) throw new Error(`${body.method} timed out`); throw e; }
    finally { clearTimeout(timer); }
  }
  private req(method: string, params: any, ms = 60000) { return this.post({ jsonrpc: "2.0", id: ++this.id, method, params }, ms); }
  async start() {
    const p = urlProblem(this.cfg.url || ""); if (p) throw new Error(p);
    const h = fillHeaders(this.cfg.headers); if (h.problem) throw new Error(h.problem); this.headers = h.headers;
    this.session = "";
    const init = await this.req("initialize", { protocolVersion: this.version, capabilities: {}, clientInfo: { name: "syok-code", version: "0.1.0" } }, 20000);
    if (init?.protocolVersion) this.version = String(init.protocolVersion);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, 20000);
    const r = await this.req("tools/list", {}, 20000);
    this.tools = Array.isArray(r?.tools) ? r.tools.slice(0, 200) : [];
  }
  defs() { return toolDefsOf(this.name, this.tools); }
  async call(tool: string, args: any): Promise<string> {
    const once = () => this.req("tools/call", { name: tool, arguments: args || {} });
    let r: any; try { r = await once(); } catch (e: any) { if (!e?.expired) throw e; await this.start(); r = await once(); } // a forgotten session is started again, once
    return resultText(r);
  }
  stop() { if (this.session) { const s = this.session; this.session = ""; this.fetchImpl(this.cfg.url!, { method: "DELETE", headers: { ...this.headers, "mcp-session-id": s } }).catch(() => {}); } }
}
async function readCapped(res: Response, max: number): Promise<string> {
  const rd = res.body?.getReader(); if (!rd) return ""; const dec = new TextDecoder(); let out = "";
  for (;;) { const { done, value } = await rd.read(); if (done) break; out += dec.decode(value, { stream: true }); if (out.length > max) { try { await rd.cancel(); } catch {} throw new Error("the server's answer is too large"); } }
  return out + dec.decode();
}
export type ToolServer = McpClient | HttpMcp;
export async function startMcp(servers: Record<string, McpCfg> | undefined, cwd: string, log: (s: string) => void, fetchImpl: typeof fetch = fetch): Promise<ToolServer[]> {
  const out: ToolServer[] = [];
  for (const [name, cfg] of Object.entries(servers || {})) {
    const safe = name.replace(/[^\w-]/g, "_");
    if (!cfg || (!cfg.url && !cfg.command)) { log(`(tool server ${name} could not start: it needs a "command" or a "url")`); continue; }
    const c: ToolServer = cfg.url ? new HttpMcp(safe, cfg, fetchImpl) : new McpClient(safe, cfg, cwd);
    try { await c.start(); out.push(c); log(`(tool server ${name}: ${c.tools.length} tools${cfg.url ? ", hosted at " + new URL(cfg.url).host : ""})`); } catch (e: any) { c.stop(); log(`(tool server ${name} could not start: ${e.message})`); }
  }
  return out;
}
