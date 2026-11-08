import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/agent.ts";
import { unifiedDiff, colorize } from "../src/diff.ts";
import { makeCtx, runTool, sessionDiff, toolDefs } from "../src/tools.ts";
import { runHooks } from "../src/hooks.ts";
import { startMcp } from "../src/mcp.ts";
import { Bg } from "../src/bg.ts";
import { DEFAULT } from "../src/profiles.ts";
import { tmpProject, fakeAI, call } from "./helpers.ts";

const base = "http://fake";
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const sse = (chunks: string[]) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(x)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const data = (o: any) => "data: " + JSON.stringify(o) + "\n\n";

test("diff: shows only changed lines with context", () => {
  const a = Array.from({ length: 20 }, (_, i) => "line" + i).join("\n"), b = a.replace("line10", "LINE10");
  const d = unifiedDiff(a, b, "f.txt");
  expect(d).toContain("-line10"); expect(d).toContain("+LINE10"); expect(d).toContain(" line9"); expect(d).not.toContain("line3\n");
  expect(unifiedDiff("same", "same")).toBe("");
  expect(colorize(d)).toContain("\x1b[32m+LINE10");
  expect(unifiedDiff("a\n".repeat(2000), "b\n".repeat(2000))).toContain("too big");
});
test("ask mode shows a real diff in the approval prompt, and /diff data lists session changes", async () => {
  const d = tmpProject({ "a.txt": "one\ntwo\nthree" });
  let seen = ""; const c = makeCtx(d, "ask", async (_w, detail) => { seen = detail; return true; }, {}, DEFAULT);
  await runTool(c, "edit_file", { path: "a.txt", old_text: "two", new_text: "TWO" });
  expect(seen).toContain("-two"); expect(seen).toContain("+TWO");
  expect(sessionDiff(c)).toContain("+TWO");
  await runTool(c, "write_file", { path: "n.txt", content: "new" });
  expect(sessionDiff(c)).toContain("+new");
});
test("streaming: tokens arrive as they are written; lines split across chunks; tool call assembled", async () => {
  const d = tmpProject({ "a.txt": "x" });
  const replies = [
    () => sse([data({ choices: [{ delta: { content: "Let me " } }] }).slice(0, 30), data({ choices: [{ delta: { content: "Let me " } }] }).slice(30) + data({ choices: [{ delta: { content: "look." } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "read_file", arguments: '{"pa' } }] } }] }), data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
      data({ choices: [], usage: { total_tokens: 42 } }), "data: [DONE]\n\n"]),
    () => sse([data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t2", function: { name: "finish", arguments: '{"summary":"done"}' } }] } }] }), "data: [DONE]\n\n"]),
  ];
  let i = 0, bodies: any[] = [];
  const f = (async (_u: any, o: any) => { bodies.push(JSON.parse(o.body)); return replies[i++](); }) as any;
  let text = "";
  const r = await runAgent({ root: d, task: "t", base, key: "k", fetchImpl: f, onToken: (s) => (text += s) });
  expect(text).toContain("Let me look."); expect(bodies[0].stream).toBe(true); expect(r.stopped).toBe("finished"); expect(r.summary).toBe("done"); expect(r.tokens).toBe(42);
  expect(bodies[1].messages.some((m: any) => m.role === "tool" && /1  x/.test(m.content))).toBe(true);
});
test("streaming asked for but server answers plain JSON: still works", async () => {
  const d = tmpProject({});
  const ai = fakeAI([{ role: "assistant", content: "hi there" }]);
  let text = ""; const r = await runAgent({ root: d, task: "t", base, key: "k", fetchImpl: ai.f, onToken: (s) => (text += s), log: (s) => (text += s) });
  expect(r.summary).toBe("hi there"); expect(text).toContain("hi there");
});
test("hooks: exit code 2 blocks a tool; the message is passed to the AI", async () => {
  const d = tmpProject({ "a.txt": "x" });
  const ai = fakeAI([call("write_file", { path: "b.txt", content: "no" }), call("finish", { summary: "ok" })]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: ai.f, settings: { hooks: { PreToolUse: [{ match: "write_file", command: "echo 'no new files here' >&2; exit 2" }] } } });
  expect(existsSync(join(d, "b.txt"))).toBe(false);
  expect(r.messages.some((m) => m.role === "tool" && /Blocked by a hook: no new files here/.test(String(m.content)))).toBe(true);
});
test("hooks: the event arrives as JSON on input; PostToolUse output is shown to the AI; match filters by tool", async () => {
  const d = tmpProject({ "a.txt": "x" });
  const h = await runHooks([{ match: "edit_file", command: "cat > seen.json" }], "PreToolUse", { tool: "edit_file", args: { path: "a.txt" } }, d, "edit_file");
  expect(h.block).toBe(false); expect(JSON.parse(readFileSync(join(d, "seen.json"), "utf8")).tool).toBe("edit_file");
  const skip = await runHooks([{ match: "edit_file", command: "exit 2" }], "PreToolUse", {}, d, "read_file");
  expect(skip.block).toBe(false);
  const ai = fakeAI([call("write_file", { path: "c.txt", content: "v" }), call("finish", { summary: "ok" })]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: ai.f, settings: { hooks: { PostToolUse: [{ match: "write_file", command: "echo formatted" }] } } });
  expect(r.messages.some((m) => m.role === "tool" && /\[hook\] formatted/.test(String(m.content)))).toBe(true);
});
test("hooks: a Stop hook can send the AI back to work once, then lets it finish", async () => {
  const d = tmpProject({});
  const ai = fakeAI([call("finish", { summary: "first" }), call("finish", { summary: "second" })]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", fetchImpl: ai.f, settings: { hooks: { Stop: [{ command: "test -f gate || { touch gate; echo 'tests are red' >&2; exit 2; }" }] } } });
  expect(r.summary).toBe("second"); expect(r.steps).toBe(2);
  expect(ai.seen[1].messages.some((m: any) => m.role === "user" && /tests are red/.test(m.content))).toBe(true);
});
test("hooks: a hanging hook is stopped by its timeout", async () => {
  const d = tmpProject({});
  const t0 = Date.now(); const h = await runHooks([{ command: "sleep 30", timeout_sec: 1 }], "Stop", {}, d);
  expect(Date.now() - t0).toBeLessThan(5000); expect(h.block).toBe(false);
});
test("subagents: two explorers run side by side, are read-only, and report back", async () => {
  const d = tmpProject({ "a.txt": "alpha", "b.txt": "beta" });
  const log: any[] = []; let active = 0, peak = 0;
  const f = (async (_u: any, o: any) => {
    const req = JSON.parse(o.body); const isChild = String(req.messages[0].content).includes("read-only research helper");
    log.push({ isChild, tools: req.tools.map((t: any) => t.function.name) });
    let msg: any;
    if (isChild) {
      active++; peak = Math.max(peak, active); await sleep(250); active--;
      const answered = req.messages.some((m: any) => m.role === "tool");
      msg = answered ? call("finish", { summary: "found: " + req.messages[1].content.match(/[ab]\.txt/)[0] }) : call("read_file", { path: req.messages[1].content.match(/[ab]\.txt/)[0] });
    } else {
      const got = req.messages.filter((m: any) => m.role === "tool").length;
      msg = got === 0 ? { role: "assistant", content: "", tool_calls: [call("delegate", { task: "look at a.txt" }).tool_calls![0], call("delegate", { task: "look at b.txt", role: "explorer" }).tool_calls![0]] } : call("finish", { summary: "all done" });
    }
    return new Response(JSON.stringify({ choices: [{ message: msg }], usage: { total_tokens: 1 } }));
  }) as any;
  const t0 = Date.now();
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: f });
  expect(r.summary).toBe("all done"); expect(peak).toBe(2);
  const tools = r.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  expect(tools.some((t) => t.includes("found: a.txt"))).toBe(true); expect(tools.some((t) => t.includes("found: b.txt"))).toBe(true);
  const child = log.find((l) => l.isChild);
  expect(child.tools).not.toContain("edit_file"); expect(child.tools).not.toContain("delegate"); expect(child.tools).not.toContain("run_command");
  expect(Date.now() - t0).toBeLessThan(1200);
});
test("subagents: a worker can edit (shared undo) but cannot delegate further", async () => {
  const d = tmpProject({ "a.txt": "old" });
  const f = (async (_u: any, o: any) => {
    const req = JSON.parse(o.body); const isChild = String(req.messages[0].content).includes("focused helper");
    const tools = req.messages.filter((m: any) => m.role === "tool").length;
    const msg = isChild ? (tools === 0 ? call("edit_file", { path: "a.txt", old_text: "old", new_text: "new" }) : call("finish", { summary: "edited" }))
      : (tools === 0 ? call("delegate", { task: "change old to new", role: "worker" }) : call("finish", { summary: "parent done" }));
    if (isChild) expect(req.tools.map((t: any) => t.function.name)).not.toContain("delegate");
    return new Response(JSON.stringify({ choices: [{ message: msg }], usage: { total_tokens: 1 } }));
  }) as any;
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: f, profile: { ...DEFAULT, nudgeTests: false } });
  expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("new"); expect(r.touched).toEqual(["a.txt"]); expect(r.summary).toBe("parent done");
});
test("read-only helpers are blocked from edits even if they try", async () => {
  const d = tmpProject({ "a.txt": "x" });
  const c = makeCtx(d, "auto", async () => true, {}, DEFAULT); c.allowed = new Set(["read_file"]);
  expect(await runTool(c, "write_file", { path: "a.txt", content: "y" })).toMatch(/not available/);
  expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("x");
});
test("local tool plug-ins (MCP): tools are listed, called, and need approval outside auto mode", async () => {
  const d = tmpProject({});
  const settings = { mcpServers: { fake: { command: "node", args: [join(import.meta.dir, "fake-mcp.cjs")] } } };
  const ai = fakeAI([call("mcp__fake__echo", { text: "hi" }), call("finish", { summary: "ok" })]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: ai.f, settings });
  expect(ai.seen[0].tools.map((t: any) => t.function.name)).toContain("mcp__fake__echo");
  expect(r.messages.some((m) => m.role === "tool" && m.content === "echo:hi")).toBe(true);
  const ai2 = fakeAI([call("mcp__fake__echo", { text: "no" }), call("finish", { summary: "ok" })]);
  const r2 = await runAgent({ root: d, task: "t", base, key: "k", mode: "ask", ask: async () => false, fetchImpl: ai2.f, settings });
  expect(r2.messages.some((m) => m.role === "tool" && /did not allow/.test(String(m.content)))).toBe(true);
}, 20000);
test("MCP: a server that cannot start is skipped with a message", async () => {
  const msgs: string[] = [];
  const out = await startMcp({ bad: { command: "definitely-not-a-program-xyz" } }, tmpProject({}), (s) => msgs.push(s));
  expect(out.length).toBe(0); expect(msgs.join(" ")).toMatch(/could not start/);
}, 20000);
test("background jobs: start, read output, stop", async () => {
  const d = tmpProject({});
  const c = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  const started = await runTool(c, "bg_start", { command: "node -e \"setInterval(()=>console.log('tick'),100)\"" });
  expect(started).toMatch(/Started background job 1/);
  await sleep(500);
  const out = await runTool(c, "bg_output", { id: 1 });
  expect(out).toContain("tick"); expect(out).toContain("[still running]");
  expect(await runTool(c, "bg_output", {})).toContain("running");
  expect(await runTool(c, "bg_stop", { id: 1 })).toMatch(/Stopped/);
  expect(await runTool(c, "bg_output", { id: 1 })).toMatch(/finished/);
  expect(await runTool(c, "bg_output", { id: 9 })).toMatch(/no background job/);
  c.bg.stopAll();
});
test("background jobs obey the same permission rules as commands, and die with the session", async () => {
  const d = tmpProject({});
  const c = makeCtx(d, "ask", async () => false, {}, DEFAULT);
  expect(await runTool(c, "bg_start", { command: "node -e \"setInterval(()=>{},100)\"" })).toMatch(/Not run/);
  expect(await runTool(c, "bg_start", { command: "sudo reboot" })).toMatch(/blocked/);
  const bg = new Bg(); const id = bg.start("sleep 60", d); bg.stopAll(); await sleep(200);
  expect(bg.output(id)).toMatch(/finished/);
});
test("tool list: main agent has delegate and bg tools; helpers do not get delegate", () => {
  const c = makeCtx(tmpProject({}), "auto", async () => true, {}, DEFAULT);
  const names = toolDefs(c).map((t: any) => t.function.name);
  for (const n of ["delegate", "bg_start", "bg_output", "bg_stop"]) expect(names).toContain(n);
  c.depth = 1; expect(toolDefs(c).map((t: any) => t.function.name)).not.toContain("delegate");
});
