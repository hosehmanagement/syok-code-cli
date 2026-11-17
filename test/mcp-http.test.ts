// Hosted tool servers (MCP over HTTP with a fixed key), against a real stand-in server that follows the protocol.
import { test, expect } from "bun:test";
import { HttpMcp, startMcp, urlProblem, fillHeaders } from "../src/mcp.ts";
import { runAgent } from "../src/agent.ts";
import { tmpProject, fakeAI, call } from "./helpers.ts";

interface Opts { sse?: boolean; key?: string; session?: boolean; forgetAfter?: number; noise?: boolean; big?: boolean; slow?: boolean }
function mcpServer(o: Opts = {}) {
  const seen: { method: string; rpc?: string; auth: string | null; session: string | null; version: string | null }[] = []; let sessions = new Set<string>(); let n = 0, calls = 0;
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const auth = req.headers.get("authorization"), sid = req.headers.get("mcp-session-id"), ver = req.headers.get("mcp-protocol-version");
    if (req.method === "DELETE") { seen.push({ method: "DELETE", auth, session: sid, version: ver }); if (sid) sessions.delete(sid); return new Response(null, { status: 200 }); }
    const body: any = await req.json(); seen.push({ method: "POST", rpc: body.method, auth, session: sid, version: ver });
    if (o.key && auth !== "Bearer " + o.key) return new Response("no", { status: 401 });
    if (!String(req.headers.get("accept")).includes("text/event-stream")) return new Response("bad accept", { status: 406 });
    const reply = (result: any, extra: Record<string, string> = {}) => {
      const msg = { jsonrpc: "2.0", id: body.id, result };
      if (!o.sse) return Response.json(msg, { headers: extra });
      const noise = o.noise ? `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { n: 1 } })}\n\n: a comment\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 9999, result: { wrong: true } })}\n\n` : "";
      return new Response(noise + `event: message\ndata: ${JSON.stringify(msg)}\n\n`, { headers: { "content-type": "text/event-stream", ...extra } });
    };
    if (body.method === "initialize") { const id = "sess-" + ++n; if (o.session) sessions.add(id); return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } }, o.session ? { "mcp-session-id": id } : {}); }
    if (o.session && (!sid || !sessions.has(sid))) return new Response("no session", { status: sid ? 404 : 400 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return reply({ tools: [{ name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } }, { name: "fail", description: "Always fails" }] });
    if (body.method === "tools/call") {
      calls++; if (o.forgetAfter && calls === o.forgetAfter) { sessions.clear(); return new Response("gone", { status: 404 }); }
      if (o.slow) await new Promise((r) => setTimeout(r, 2000));
      if (o.big) return reply({ content: [{ type: "text", text: "x".repeat(5_000_000) }] });
      if (body.params.name === "fail") return reply({ isError: true, content: [{ type: "text", text: "it broke" }] });
      if (body.params.name === "add") return reply({ content: [{ type: "text", text: String(body.params.arguments.a + body.params.arguments.b) }, { type: "image", data: "..." }] });
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Unknown tool" } });
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no such method" } });
  } });
  return { url: `http://127.0.0.1:${s.port}/mcp`, seen, stop: () => s.stop(true) };
}

test("addresses: https, or http only for this computer; no name or password in the address", () => {
  expect(urlProblem("https://tools.example.com/mcp")).toBe(""); expect(urlProblem("http://127.0.0.1:8080/mcp")).toBe(""); expect(urlProblem("http://localhost/mcp")).toBe("");
  expect(urlProblem("http://tools.example.com/mcp")).toContain("https://"); expect(urlProblem("http://169.254.169.254/latest")).toContain("https://"); expect(urlProblem("ftp://x")).toContain("https://");
  expect(urlProblem("not a url")).toContain("not a web address"); expect(urlProblem("https://user:pw@x.example/mcp")).toContain("name or password");
});

test("header values: ${NAME} comes from the environment; Syok's own keys are never handed over; a missing one is named", () => {
  expect(fillHeaders({ Authorization: "Bearer ${MY_KEY}", "X-Plain": "v" }, { MY_KEY: " abc \n" })).toEqual({ headers: { Authorization: "Bearer abc", "X-Plain": "v" }, problem: "" });
  expect(fillHeaders({ Authorization: "Bearer ${MY_KEY}" }, {}).problem).toBe("header Authorization needs the environment variable MY_KEY, which is not set");
  for (const secret of ["SYOK_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "MODAL_TOKEN_SECRET"]) { const r = fillHeaders({ A: "Bearer ${" + secret + "}" }, { [secret]: "real-secret-value" }); expect(r.problem).toContain("never given to a tool server"); expect(JSON.stringify(r.headers)).not.toContain("real-secret-value"); }
  expect(fillHeaders({ "X-A": "a\r\nInjected: 1" }, {}).problem).toContain("not plain text");
  expect(fillHeaders(undefined, {})).toEqual({ headers: {}, problem: "" });
});

for (const sse of [false, true]) test(`a hosted server answering as ${sse ? "an event stream" : "plain JSON"}: tools are listed and called, with the key, the session and the protocol version on every request`, async () => {
  const srv = mcpServer({ sse, key: "k-123", session: true, noise: true }); process.env.SYOK_TEST_MCP_KEY = "k-123";
  try {
    const c = new HttpMcp("calc", { url: srv.url, headers: { Authorization: "Bearer ${SYOK_TEST_MCP_KEY}" } }); await c.start();
    expect(c.tools.map((t) => t.name)).toEqual(["add", "fail"]); expect(c.defs()[0].function.name).toBe("mcp__calc__add"); expect(c.defs()[0].function.parameters.required).toEqual(["a", "b"]);
    expect(await c.call("add", { a: 2, b: 40 })).toBe("42\n[image]"); expect(await c.call("fail", {})).toBe("Tool error: it broke");
    await expect(c.call("nope", {})).rejects.toThrow("Unknown tool");
    expect(srv.seen.every((x) => x.auth === "Bearer k-123")).toBe(true);
    expect(srv.seen.map((x) => x.rpc)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call", "tools/call"]);
    expect(srv.seen[0].session).toBeNull(); expect(srv.seen[0].version).toBeNull(); expect(srv.seen.slice(1).every((x) => x.session === "sess-1" && x.version === "2025-03-26")).toBe(true);
    c.stop(); await new Promise((r) => setTimeout(r, 100)); expect(srv.seen.at(-1)).toMatchObject({ method: "DELETE", session: "sess-1", auth: "Bearer k-123" });
  } finally { srv.stop(); delete process.env.SYOK_TEST_MCP_KEY; }
});

test("problems are said plainly and nothing half-started is used: wrong key, plain http, a Syok secret in a header, not a tool server", async () => {
  const logs: string[] = []; const srv = mcpServer({ key: "right" }); const web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<html>hi</html>", { headers: { "content-type": "text/html" } }) });
  process.env.SYOK_TEST_MCP_KEY = "wrong"; const before = process.env.SYOK_API_KEY; process.env.SYOK_API_KEY = "syk_realrealrealrealreal1234";
  try {
    const got = await startMcp({
      refused: { url: srv.url, headers: { Authorization: "Bearer ${SYOK_TEST_MCP_KEY}" } },
      plain: { url: "http://tools.example.com/mcp" },
      steal: { url: srv.url, headers: { Authorization: "Bearer ${SYOK_API_KEY}" } },
      unset: { url: srv.url, headers: { Authorization: "Bearer ${SYOK_TEST_NOT_SET}" } },
      website: { url: `http://127.0.0.1:${web.port}/` },
      empty: {} as any,
    }, tmpProject({}), (s) => logs.push(s));
    expect(got).toEqual([]);
    expect(logs[0]).toBe("(tool server refused could not start: the server refused the key (401))");
    expect(logs[1]).toContain("must start with https://"); expect(logs[2]).toContain("asks for SYOK_API_KEY, which is never given to a tool server");
    expect(logs[3]).toContain("SYOK_TEST_NOT_SET, which is not set"); expect(logs[4]).toContain("did not answer like a tool server"); expect(logs[5]).toContain('needs a "command" or a "url"');
    expect(srv.seen.some((x) => String(x.auth).includes("syk_realreal"))).toBe(false); expect(srv.seen.length).toBe(1); // only the refused try reached the server
  } finally { srv.stop(); web.stop(true); delete process.env.SYOK_TEST_MCP_KEY; if (before === undefined) delete process.env.SYOK_API_KEY; else process.env.SYOK_API_KEY = before; }
});

test("a forgotten session is started again once; an oversized answer and a server that hangs are stopped", async () => {
  let srv = mcpServer({ session: true, forgetAfter: 2 });
  try { const c = new HttpMcp("calc", { url: srv.url }); await c.start(); expect(await c.call("add", { a: 1, b: 1 })).toBe("2\n[image]"); expect(await c.call("add", { a: 2, b: 3 })).toBe("5\n[image]"); expect(c.session).toBe("sess-2"); expect(srv.seen.filter((x) => x.rpc === "initialize").length).toBe(2); } finally { srv.stop(); }
  srv = mcpServer({ big: true });
  try { const c = new HttpMcp("calc", { url: srv.url }); await c.start(); await expect(c.call("add", { a: 1, b: 1 })).rejects.toThrow("too large"); } finally { srv.stop(); }
  srv = mcpServer({ slow: true });
  try { const c = new HttpMcp("calc", { url: srv.url }); await c.start(); (c as any).req = function (m: string, p: any) { return (this as any).post({ jsonrpc: "2.0", id: ++this.id, method: m, params: p }, 300); }; await expect(c.call("add", { a: 1, b: 1 })).rejects.toThrow("tools/call timed out"); } finally { srv.stop(); }
  // a redirect to somewhere else is not followed (the key would travel with it)
  const other = mcpServer({}); const redir = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { location: other.url } }) });
  try { const c = new HttpMcp("calc", { url: `http://127.0.0.1:${redir.port}/mcp`, headers: { Authorization: "Bearer abc" } }); await expect(c.start()).rejects.toThrow(); expect(other.seen.length).toBe(0); } finally { other.stop(); redir.stop(true); }
});

test("the agent uses a hosted tool like any other: asked first in ask mode, a no is respected, a broken call is reported and does not crash", async () => {
  const srv = mcpServer({ sse: true, session: true });
  try {
    const settings = { mcpServers: { calc: { url: srv.url } } }; const d = tmpProject({});
    const ai = fakeAI([call("mcp__calc__add", { a: 20, b: 22 }), call("mcp__calc__nope", {}), call("finish", { summary: "ok" })]);
    const r = await runAgent({ root: d, task: "t", base: "http://x", key: "k", mode: "auto", settings, fetchImpl: ai.f });
    expect(ai.seen[0].tools.map((t: any) => t.function.name)).toContain("mcp__calc__add");
    const outs = r.messages.filter((m) => m.role === "tool").map((m) => String(m.content)); expect(outs[0]).toBe("42\n[image]"); expect(outs[1]).toContain("Unknown tool"); expect(r.summary).toBe("ok");
    const asked: string[] = []; const ai2 = fakeAI([call("mcp__calc__add", { a: 1, b: 1 }), call("finish", { summary: "ok" })]); const n = srv.seen.filter((x) => x.rpc === "tools/call").length;
    const r2 = await runAgent({ root: d, task: "t", base: "http://x", key: "k", mode: "ask", ask: async (w) => { asked.push(w); return false; }, settings, fetchImpl: ai2.f });
    expect(asked).toEqual(["use tool mcp__calc__add"]); expect(r2.messages.filter((m) => m.role === "tool").map((m) => String(m.content))[0]).toBe("The user did not allow this tool.");
    expect(srv.seen.filter((x) => x.rpc === "tools/call").length).toBe(n);
  } finally { srv.stop(); }
});
