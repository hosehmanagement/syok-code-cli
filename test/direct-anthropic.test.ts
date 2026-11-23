// Syok Code used directly against Anthropic's API (SYOK_BASE_URL=https://api.anthropic.com) instead of a Syok router.
// A local HTTP server stands in for the API: requests for https://api.anthropic.com are sent to it, so nothing reaches the internet.
import { test, expect } from "bun:test";
import { runAgent, askModel, shapeBody, omitTemperature, maxTokensFromEnv, isAnthropicHost, routeOf } from "../src/agent.ts";
import { doctor } from "../src/doctor.ts";
import { webSearch } from "../src/web.ts";
import { tmpProject, call } from "./helpers.ts";

type Reply = { message?: any; sse?: string; headers?: Record<string, string> };
/** A stand-in chat completions server. Each request gets the next scripted reply; every request body is recorded. */
function standIn(script: Array<Reply | ((req: any) => Reply)>) {
  const seen: { path: string; auth: string | null; body: any }[] = []; let i = 0;
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const u = new URL(req.url); const body = req.method === "POST" ? await req.json() : undefined;
    seen.push({ path: u.pathname, auth: req.headers.get("authorization"), body });
    if (u.pathname !== "/v1/chat/completions") return Response.json({ type: "error", error: { type: "not_found_error", message: "Not found" } }, { status: 404 });
    // What Anthropic answers for a temperature below 1 on newer Claude models: the run must never send one in direct mode.
    if (body && "temperature" in body && body.model?.startsWith("claude") && body.temperature < 1) return Response.json({ error: { type: "invalid_request_error", message: "temperature is not supported" } }, { status: 400 });
    const step = script[Math.min(i++, script.length - 1)]; const r = typeof step === "function" ? step(body) : step;
    if (r.sse) return new Response(r.sse, { headers: { "content-type": "text/event-stream", ...(r.headers || {}) } });
    return Response.json({ id: "chatcmpl-1", object: "chat.completion", model: body.model, choices: [{ index: 0, message: r.message, finish_reason: r.message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }, { headers: r.headers || {} });
  } });
  const local = `http://127.0.0.1:${s.port}`;
  /** fetch that sends https://api.anthropic.com/... to the stand-in (a real HTTP request to this computer). */
  const anthropicFetch = ((u: any, o: any) => fetch(String(u).replace(/^https:\/\/api\.anthropic\.com/, local), o)) as typeof fetch;
  return { local, seen, anthropicFetch, stop: () => s.stop(true) };
}
const chats = (seen: { path: string; body: any }[]) => seen.filter((x) => x.path === "/v1/chat/completions").map((x) => x.body);
/** Runs fn with these environment variables set, then puts the old values back. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
}
const CLEAN = { SYOK_NO_TEMPERATURE: undefined, SYOK_MAX_TOKENS: undefined };

test("direct-anthropic helpers: host detection, temperature switch, SYOK_MAX_TOKENS parsing", () => {
  for (const b of ["https://api.anthropic.com", "https://api.anthropic.com/", "https://API.Anthropic.com/v1", " https://api.anthropic.com/v1/ "]) expect(isAnthropicHost(b)).toBe(true);
  for (const b of ["https://my-router.example.workers.dev/v1", "https://api.anthropic.com.evil.example", "https://evil.example/api.anthropic.com", "not a url", ""]) expect(isAnthropicHost(b)).toBe(false);
  expect(omitTemperature("https://api.anthropic.com", {})).toBe(true);
  expect(omitTemperature("https://router.example", {})).toBe(false);
  expect(omitTemperature("https://router.example", { SYOK_NO_TEMPERATURE: "1" })).toBe(true);
  expect(omitTemperature("https://router.example", { SYOK_NO_TEMPERATURE: "0" })).toBe(false);
  expect(maxTokensFromEnv({})).toBeUndefined(); expect(maxTokensFromEnv({ SYOK_MAX_TOKENS: "8192" })).toBe(8192); expect(maxTokensFromEnv({ SYOK_MAX_TOKENS: " 64 " })).toBe(64);
  for (const bad of ["0", "-5", "1.5", "abc", "", "1e4", "99999999999999999999"]) expect(maxTokensFromEnv({ SYOK_MAX_TOKENS: bad })).toBeUndefined();
  const body = { model: "m", temperature: 0.2 };
  expect(shapeBody("https://router.example", body, {})).toEqual({ model: "m", temperature: 0.2 });
  expect(shapeBody("https://api.anthropic.com", body, {})).toEqual({ model: "m" });
  expect(shapeBody("https://router.example", body, { SYOK_MAX_TOKENS: "4096" })).toEqual({ model: "m", temperature: 0.2, max_tokens: 4096 });
  expect(shapeBody("https://router.example", { model: "m", max_tokens: 16 }, { SYOK_MAX_TOKENS: "4096" })).toEqual({ model: "m", max_tokens: 16 }); // a request's own limit (doctor) is kept
  expect(body).toEqual({ model: "m", temperature: 0.2 }); // the caller's object is not changed
});

test("routeOf: router headers win; without them the provider comes from the address and the model from the answer", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  expect(routeOf("https://router.example", h({ "x-syok-provider": "claude", "x-syok-model": "claude-sonnet-5", "x-syok-attempts": "2" }), "something-else")).toEqual({ provider: "claude", model: "claude-sonnet-5", attempts: "2", details: "" });
  expect(routeOf("https://api.anthropic.com", h({}), "claude-sonnet-5")).toEqual({ provider: "anthropic", model: "claude-sonnet-5", attempts: "", details: "" });
  expect(routeOf("https://api.anthropic.com", h({}), undefined)).toEqual({ provider: "anthropic", model: "", attempts: "", details: "" });
  expect(routeOf("https://other.example", h({}), "gpt-x")).toEqual({ provider: "direct", model: "gpt-x", attempts: "", details: "" });
  expect(routeOf("https://other.example", h({}), undefined)).toEqual({ provider: "", model: "", attempts: "", details: "" }); // nothing known: nothing recorded, as before
});

test("direct mode: no temperature is sent, a tool-call round trip works, and usage.by holds the answering model's tokens", async () => {
  const d = tmpProject({ "a.txt": "hello from a\n" });
  const s = standIn([
    { message: { role: "assistant", content: "", tool_calls: [{ id: "toolu_01", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) } }] } },
    (req) => {
      // the tool result goes back with the same id, as the compatibility layer expects
      const tool = req.messages.find((m: any) => m.role === "tool");
      return { message: tool?.tool_call_id === "toolu_01" && String(tool.content).includes("hello from a") ? call("finish", { summary: "read it" }) : { role: "assistant", content: "tool result missing" } };
    },
  ]);
  try {
    const r = await withEnv(CLEAN, () => runAgent({ root: d, task: "read a.txt", base: "https://api.anthropic.com", key: "sk-ant-test-not-real", model: "claude-sonnet-5", mode: "auto", fetchImpl: s.anthropicFetch, noSummary: true }));
    expect(r.stopped).toBe("finished"); expect(r.summary).toBe("read it"); expect(r.steps).toBe(2);
    const sent = chats(s.seen); expect(sent.length).toBe(2);
    for (const b of sent) { expect("temperature" in b).toBe(false); expect("max_tokens" in b).toBe(false); expect(b.model).toBe("claude-sonnet-5"); expect(b.tools.length).toBeGreaterThan(5); }
    expect(s.seen.every((x) => x.auth === "Bearer sk-ant-test-not-real")).toBe(true);
    expect(r.usage.by).toEqual({ "anthropic / claude-sonnet-5": { steps: 2, input: 200, output: 40 } });
    expect(r.usage.input).toBe(200); expect(r.usage.output).toBe(40); expect(r.tokens).toBe(240);
    expect(r.routes.map((x) => x.provider + " / " + x.model)).toEqual(["anthropic / claude-sonnet-5", "anthropic / claude-sonnet-5"]);
  } finally { s.stop(); }
});

test("direct mode with streaming: no temperature, and the model named in the stream is recorded", async () => {
  const d = tmpProject({});
  const chunk = (o: any) => "data: " + JSON.stringify(o) + "\n\n";
  const sse = chunk({ model: "claude-sonnet-5", choices: [{ delta: { role: "assistant", content: "Hi" } }] }) + chunk({ model: "claude-sonnet-5", choices: [{ delta: { content: " there" } }] }) + chunk({ model: "claude-sonnet-5", choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }) + "data: [DONE]\n\n";
  const s = standIn([{ sse }]); let streamed = "";
  try {
    const r = await withEnv(CLEAN, () => runAgent({ root: d, task: "say hi", base: "https://api.anthropic.com/v1", key: "sk-ant-test-not-real", model: "claude-sonnet-5", fetchImpl: s.anthropicFetch, onToken: (t) => { streamed += t; }, noSummary: true }));
    expect(r.stopped).toBe("answered"); expect(streamed).toContain("Hi there");
    const sent = chats(s.seen); expect(sent[0].stream).toBe(true); expect("temperature" in sent[0]).toBe(false);
    expect(r.usage.by).toEqual({ "anthropic / claude-sonnet-5": { steps: 1, input: 50, output: 5 } });
  } finally { s.stop(); }
});

test("direct mode: the one-question call used to summarize a long chat sends no temperature either", async () => {
  const s = standIn([{ message: { role: "assistant", content: "a summary" } }]);
  try {
    const out = await withEnv(CLEAN, () => askModel("https://api.anthropic.com", "sk-ant-test-not-real", "claude-sonnet-5", "summarize", s.anthropicFetch));
    expect(out).toBe("a summary"); expect("temperature" in chats(s.seen)[0]).toBe(false);
  } finally { s.stop(); }
});

test("router path unchanged: temperature is sent, and usage.by is keyed by the X-Syok headers, not the answer's model field", async () => {
  const d = tmpProject({});
  const hdr = { "x-syok-provider": "groq", "x-syok-model": "llama-4", "x-syok-attempts": "1" };
  const s = standIn([{ message: call("list_files", {}), headers: hdr }, { message: call("finish", { summary: "done" }), headers: hdr }]);
  try {
    const r = await withEnv(CLEAN, () => runAgent({ root: d, task: "t", base: s.local + "/v1", key: "syk_test", model: "syok-coder", mode: "auto", fetchImpl: fetch, noSummary: true }));
    expect(r.stopped).toBe("finished");
    const sent = chats(s.seen); expect(sent.length).toBe(2);
    for (const b of sent) { expect(b.temperature).toBe(0.2); expect("max_tokens" in b).toBe(false); }
    expect(r.usage.by).toEqual({ "groq / llama-4": { steps: 2, input: 200, output: 40 } });
    expect(r.routes[0]).toEqual({ provider: "groq", model: "llama-4", attempts: "1", details: "" });
    expect(await withEnv(CLEAN, () => askModel(s.local, "syk_test", "syok-coder", "q", fetch))).toBe("");
    expect(chats(s.seen)[2].temperature).toBe(0.2);
  } finally { s.stop(); }
});

test("another address: SYOK_NO_TEMPERATURE=1 leaves temperature out; without router headers the provider is 'direct'", async () => {
  const d = tmpProject({});
  const s = standIn([{ message: { role: "assistant", content: "ok" } }]);
  try {
    const r = await withEnv({ SYOK_NO_TEMPERATURE: "1", SYOK_MAX_TOKENS: undefined }, () => runAgent({ root: d, task: "t", base: s.local, key: "k", model: "gpt-x", fetchImpl: fetch, noSummary: true }));
    expect(r.stopped).toBe("answered"); expect("temperature" in chats(s.seen)[0]).toBe(false);
    expect(r.usage.by).toEqual({ "direct / gpt-x": { steps: 1, input: 100, output: 20 } });
  } finally { s.stop(); }
});

test("SYOK_MAX_TOKENS: sent as max_tokens when it is a positive whole number, never otherwise", async () => {
  const d = tmpProject({});
  const s = standIn([{ message: { role: "assistant", content: "ok" } }]);
  try {
    await withEnv({ SYOK_NO_TEMPERATURE: undefined, SYOK_MAX_TOKENS: "8192" }, () => runAgent({ root: d, task: "t", base: "https://api.anthropic.com", key: "k", model: "claude-sonnet-5", fetchImpl: s.anthropicFetch, noSummary: true }));
    await withEnv({ SYOK_NO_TEMPERATURE: undefined, SYOK_MAX_TOKENS: "lots" }, () => runAgent({ root: d, task: "t", base: "https://api.anthropic.com", key: "k", model: "claude-sonnet-5", fetchImpl: s.anthropicFetch, noSummary: true }));
    await withEnv(CLEAN, () => runAgent({ root: d, task: "t", base: s.local, key: "k", model: "syok-coder", fetchImpl: fetch, noSummary: true }));
    const sent = chats(s.seen);
    expect(sent[0].max_tokens).toBe(8192); expect("temperature" in sent[0]).toBe(false);
    expect("max_tokens" in sent[1]).toBe(false);
    expect("max_tokens" in sent[2]).toBe(false); expect(sent[2].temperature).toBe(0.2);
  } finally { s.stop(); }
});

test("syok doctor: no temperature for api.anthropic.com, temperature 0 kept for a Syok address", async () => {
  const d = tmpProject({});
  const s = standIn([{ message: { role: "assistant", content: "OK" } }]);
  const models = (inner: typeof fetch) => (async (u: any, o: any) => (String(u).endsWith("/v1/models") ? Response.json({ data: [{ id: "claude-sonnet-5" }] }) : inner(u, o))) as typeof fetch;
  try {
    const a = await withEnv(CLEAN, () => doctor({ base: "https://api.anthropic.com", key: "sk-ant-test-not-real", model: "claude-sonnet-5", root: d, has: () => true, platform: "linux", fetchImpl: models(s.anthropicFetch) }));
    expect(a.lines.find((l) => l.name === "AI answer")?.level).toBe("ok");
    const b = await withEnv(CLEAN, () => doctor({ base: s.local, key: "syk_a1B2c3D4e5F6g7H8i9J0k1L2", root: d, has: () => true, platform: "linux", fetchImpl: models(fetch) }));
    expect(b.lines.find((l) => l.name === "AI answer")?.level).toBe("ok");
    const sent = chats(s.seen); expect(sent.length).toBe(2);
    expect("temperature" in sent[0]).toBe(false); expect(sent[0].max_tokens).toBe(16);
    expect(sent[1].temperature).toBe(0);
  } finally { s.stop(); }
});

test("web_search with Anthropic as the address: the Syok search is not tried, the fallback answers, and a 404 elsewhere falls back silently", async () => {
  const seen: string[] = [];
  const ddg = '<div class="result results_links"><a class="result__a" href="https://example.org/page">Example page</a><a class="result__snippet">snip</a></div>';
  const f = (async (u: any, o: any) => {
    const url = String(u); seen.push(url);
    if (url.endsWith("/v1/search/run")) return Response.json({ type: "error", error: { type: "not_found_error" } }, { status: 404 });
    if (url.startsWith("https://html.duckduckgo.com/")) { expect(JSON.stringify(o)).not.toContain("sk-ant-test-not-real"); return new Response(ddg, { headers: { "content-type": "text/html" } }); }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  const state: any = {};
  const r = await webSearch({ query: "bun test" }, { f, base: "https://api.anthropic.com/v1", key: "sk-ant-test-not-real", state });
  expect(r).toContain("(from DuckDuckGo)"); expect(r).toContain("Example page"); expect(r).not.toContain("Error");
  expect(seen.some((u) => u.includes("anthropic.com"))).toBe(false);
  // A router address that answers 404 for search: remembered for the session, no error shown, the fallback answers.
  const state2: any = {}; seen.length = 0;
  const r2 = await webSearch({ query: "bun test" }, { f, base: "https://router.example", key: "syk_k", state: state2 });
  expect(r2).toContain("(from DuckDuckGo)"); expect(r2).not.toMatch(/404|Error/); expect(state2.routerOff).toBe(true);
  seen.length = 0; await webSearch({ query: "bun again" }, { f, base: "https://router.example", key: "syk_k", state: state2 });
  expect(seen.some((u) => u.endsWith("/v1/search/run"))).toBe(false);
});
