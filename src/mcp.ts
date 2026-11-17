// Minimal MCP client over stdio (newline-delimited JSON-RPC). Lets Syok Code use local tool servers.
// Configure in .syok/settings.json: { "mcpServers": { "name": { "command": "node", "args": ["server.js"], "env": {} } } }
import { spawn, type ChildProcess } from "node:child_process";
import { cleanEnv } from "./shell.ts";
export interface McpCfg { command: string; args?: string[]; env?: Record<string, string> }
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
    this.proc = spawn(this.cfg.command, this.cfg.args || [], { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout!.on("data", (d) => {
      this.buf += d; let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (!line) continue; try { const m = JSON.parse(line); const f = m.id != null && this.pending.get(m.id); if (f) { this.pending.delete(m.id); f(m); } } catch {} }
    });
    this.proc.stderr!.on("data", () => {});
    this.proc.on("error", (e) => { this.dead = "MCP server failed: " + e.message; for (const f of this.pending.values()) f({ error: { message: this.dead } }); });
    this.proc.on("close", () => { this.dead = this.dead || "MCP server stopped"; for (const f of this.pending.values()) f({ error: { message: this.dead } }); this.pending.clear(); });
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
export async function startMcp(servers: Record<string, McpCfg> | undefined, cwd: string, log: (s: string) => void): Promise<McpClient[]> {
  const out: McpClient[] = [];
  for (const [name, cfg] of Object.entries(servers || {})) {
    const c = new McpClient(name.replace(/[^\w-]/g, "_"), cfg, cwd);
    try { await c.start(); out.push(c); log(`(tool server ${name}: ${c.tools.length} tools)`); } catch (e: any) { c.stop(); log(`(tool server ${name} could not start: ${e.message})`); }
  }
  return out;
}
