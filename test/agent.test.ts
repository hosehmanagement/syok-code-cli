import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, compact, loadInstructions, chatUrl } from "../src/agent.ts";
import { DEFAULT, pickProfile } from "../src/profiles.ts";
import { tmpProject, fakeAI, call } from "./helpers.ts";

const base = "http://fake";
test("full loop: read, edit, run tests, finish", async () => {
  const d = tmpProject({ "add.js": "exports.add = (a,b)=>a-b;\n", "test.js": "const {add}=require('./add');process.exit(add(1,2)===3?0:1)" });
  const ai = fakeAI([call("read_file", { path: "add.js" }), call("edit_file", { path: "add.js", old_text: "a-b", new_text: "a+b" }), call("run_command", { command: "node test.js" }), call("finish", { summary: "fixed add" })]);
  const r = await runAgent({ root: d, task: "fix add", base, key: "k", mode: "auto", fetchImpl: ai.f });
  expect(r.stopped).toBe("finished"); expect(r.summary).toBe("fixed add"); expect(r.touched).toEqual(["add.js"]); expect(r.ranTests).toBe(true); expect(r.steps).toBe(4);
  expect(readFileSync(join(d, "add.js"), "utf8")).toContain("a+b");
});
test("sends tools, model and a bearer key", async () => {
  const d = tmpProject({});
  let hdr = ""; const ai = fakeAI([{ role: "assistant", content: "hello" }]);
  const f = (async (u: any, o: any) => { hdr = o.headers.authorization; return ai.f(u, o); }) as any;
  const r = await runAgent({ root: d, task: "hi", base: "http://x/", key: "KEY", model: "m1", fetchImpl: f });
  expect(hdr).toBe("Bearer KEY"); expect(ai.seen[0].model).toBe("m1"); expect(ai.seen[0].tools.length).toBeGreaterThan(5); expect(r.stopped).toBe("answered");
});
test("nudges once to run tests after edits", async () => {
  const d = tmpProject({ "a.txt": "x" });
  const ai = fakeAI([call("write_file", { path: "a.txt", content: "y" }), { role: "assistant", content: "done" }, call("finish", { summary: "ok" })]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: ai.f });
  expect(ai.seen[2].messages.some((m: any) => m.role === "user" && /not run any tests/.test(m.content))).toBe(true);
  expect(r.stopped).toBe("finished");
});
test("bad JSON arguments are reported back, not crashed", async () => {
  const d = tmpProject({});
  const bad = { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "list_files", arguments: "{oops" } }] };
  const ai = fakeAI([bad, call("finish", { summary: "ok" })]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", fetchImpl: ai.f });
  expect(r.stopped).toBe("finished");
  expect(ai.seen[1].messages.some((m: any) => m.role === "tool" && /not valid JSON/.test(m.content))).toBe(true);
});
test("loop guard: repeated identical calls get a warning, then a stop", async () => {
  const d = tmpProject({ "a.txt": "x" });
  const same = call("read_file", { path: "a.txt" });
  const ai = fakeAI([same]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", fetchImpl: ai.f });
  expect(r.stopped).toBe("stuck");
  expect(r.messages.some((m) => m.role === "tool" && /different approach/.test(String(m.content)))).toBe(true);
});
test("stops at the step limit", async () => {
  const d = tmpProject({ "a.txt": "x" });
  let n = 0; const ai = fakeAI([() => call("search", { pattern: "q" + n++ })]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", fetchImpl: ai.f, profile: { ...DEFAULT, maxSteps: 4 } });
  expect(r.stopped).toBe("max_steps"); expect(r.steps).toBe(4);
});
test("retries a temporary server error", async () => {
  const d = tmpProject({});
  const ai = fakeAI([{ __status: 503 }, { role: "assistant", content: "ok" }]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", fetchImpl: ai.f });
  expect(r.stopped).toBe("answered"); expect(ai.seen.length).toBe(2);
}, 10000);
test("gives a clear error when the AI service keeps failing", async () => {
  const d = tmpProject({});
  const ai = fakeAI([{ __status: 401 }]);
  await expect(runAgent({ root: d, task: "t", base, key: "k", fetchImpl: ai.f })).rejects.toThrow(/HTTP 401/);
});
test("compaction shortens old tool output but keeps recent", () => {
  const p = { ...DEFAULT, compactAtChars: 1000, keepRecent: 2 };
  const m: any[] = [{ role: "system", content: "s" }];
  for (let i = 0; i < 6; i++) m.push({ role: "tool", content: "X".repeat(600) + i });
  expect(compact(m, p)).toBe(4);
  expect(m[1].content).toContain("[old output shortened]"); expect(m[6].content.length).toBeGreaterThan(500);
  expect(compact(m, p)).toBe(0);
});
test("project instructions are added to the system prompt", async () => {
  const d = tmpProject({ "AGENTS.md": "Always use tabs." });
  expect(loadInstructions(d)).toContain("Always use tabs.");
  const ai = fakeAI([{ role: "assistant", content: "ok" }]);
  await runAgent({ root: d, task: "t", base, key: "k", fetchImpl: ai.f });
  expect(ai.seen[0].messages[0].content).toContain("Always use tabs.");
});
test("profiles pick by model name", () => {
  expect(pickProfile("gpt-5").name).toBe("default");
  expect(pickProfile("qwen3-coder-30b").name).toBe("open-model");
  expect(pickProfile("some-7b-instruct").name).toBe("small-context");
  expect(pickProfile("x", "mine", { mine: { maxSteps: 3 } }).maxSteps).toBe(3);
});
test("multi-turn history keeps earlier messages", async () => {
  const d = tmpProject({});
  const ai = fakeAI([{ role: "assistant", content: "first" }, { role: "assistant", content: "second" }]);
  const r1 = await runAgent({ root: d, task: "one", base, key: "k", fetchImpl: ai.f });
  await runAgent({ root: d, task: "two", base, key: "k", fetchImpl: ai.f, history: r1.messages });
  expect(ai.seen[1].messages.map((m: any) => m.content).join("|")).toContain("one");
});
test("your address works with or without /v1 and a trailing slash", () => {
  for (const b of ["https://p.example", "https://p.example/", "https://p.example/v1", "https://p.example/v1/", " https://p.example/v1 "]) expect(chatUrl(b)).toBe("https://p.example/v1/chat/completions");
});
test("a daily-limit reply stops at once instead of retrying", async () => {
  let n = 0; const f = (async () => { n++; return new Response('{"error":{"code":"daily_limit_reached","message":"This key reached its daily limit (500 requests)."}}', { status: 429 }); }) as any;
  await expect(runAgent({ root: tmpProject({}), task: "t", base, key: "k", fetchImpl: f })).rejects.toThrow(/daily limit/);
  expect(n).toBe(1);
});
