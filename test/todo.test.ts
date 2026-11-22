import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runAgent, makeCtx } from "../src/agent.ts";
import { toolDefs, runTool, READONLY } from "../src/tools.ts";
import { applyTodo, renderTodos, TODO_MAX_ITEMS, TODO_MAX_TEXT, type TodoItem } from "../src/todo.ts";
import { summarizeHistory } from "../src/compactor.ts";
import { saveSession, loadSession } from "../src/session.ts";
import { DEFAULT } from "../src/profiles.ts";
import { tmpProject, fakeAI, call } from "./helpers.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
const three: TodoItem[] = [{ id: "1", text: "read the parser", status: "done" }, { id: "2", text: "fix the bug", status: "in_progress" }, { id: "3", text: "run the tests", status: "pending" }];
const names = (c: any) => toolDefs(c).map((t: any) => t.function.name);

test("todo set: replaces the list, renders it, and enforces the rules", () => {
  const r = applyTodo(undefined, { action: "set", items: three });
  expect(r.changed).toBe(true); expect(r.items).toEqual(three);
  expect(r.out).toBe("Todo list (1/3 done):\n[x] 1. read the parser\n[>] 2. fix the bug  (in progress)\n[ ] 3. run the tests");
  // a missing status means pending; a missing id is numbered
  expect(applyTodo(undefined, { action: "set", items: [{ text: "a" }, { text: "b" }] }).items).toEqual([{ id: "1", text: "a", status: "pending" }, { id: "2", text: "b", status: "pending" }]);
  const bad = (items: any) => { const x = applyTodo(three, { action: "set", items }); expect(x.changed).toBe(false); expect(x.items).toBeUndefined(); return x.out; };
  expect(bad([])).toMatch(/^Error: not saved: the list is empty/);
  expect(bad(undefined)).toMatch(/^Error: 'set' needs items/);
  expect(bad([{ id: "a", text: "x", status: "in_progress" }, { id: "b", text: "y", status: "in_progress" }])).toMatch(/at most one may be in_progress/);
  expect(bad(Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => ({ id: String(i), text: "t" })))).toMatch(new RegExp(`at most ${TODO_MAX_ITEMS} are allowed`));
  expect(bad([{ id: "a", text: "x".repeat(TODO_MAX_TEXT + 1) }])).toMatch(new RegExp(`at most ${TODO_MAX_TEXT} are allowed`));
  expect(bad([{ id: "a", text: "x" }, { id: "a", text: "y" }])).toMatch(/used twice/);
  expect(bad([{ id: "a", text: "   " }])).toMatch(/has no text/);
  expect(bad([{ id: "a", text: "x", status: "started" }])).toMatch(/use pending, in_progress or done/);
  // exactly the limits are fine
  expect(applyTodo(undefined, { action: "set", items: Array.from({ length: TODO_MAX_ITEMS }, (_, i) => ({ id: String(i), text: "x".repeat(TODO_MAX_TEXT) })) }).changed).toBe(true);
});

test("todo update and list: one item at a time, the one-in-progress rule holds, a bad update changes nothing", () => {
  let r = applyTodo(three, { action: "update", id: "2", status: "done" });
  expect(r.changed).toBe(true); expect(r.items!.map((i) => i.status)).toEqual(["done", "done", "pending"]);
  expect(three[1].status).toBe("in_progress"); // the old list is not changed in place
  r = applyTodo(r.items, { action: "update", id: "3", text: "run  the\nwhole suite", status: "in_progress" });
  expect(r.items![2]).toEqual({ id: "3", text: "run the whole suite", status: "in_progress" });
  const two = applyTodo(three, { action: "update", id: "3", status: "in_progress" });
  expect(two.changed).toBe(false); expect(two.out).toMatch(/at most one may be in_progress/);
  expect(applyTodo(three, { action: "update", id: "9", status: "done" }).out).toMatch(/no item "9".*Ids: 1, 2, 3/);
  expect(applyTodo(three, { action: "update", status: "done" }).out).toMatch(/needs the id/);
  expect(applyTodo(three, { action: "update", id: "1" }).out).toMatch(/needs a new status or a new text/);
  expect(applyTodo(three, { action: "update", id: "1", text: "" }).out).toMatch(/has no text/);
  expect(applyTodo(three, { action: "list" })).toEqual({ changed: false, out: renderTodos(three) });
  expect(applyTodo(undefined, { action: "list" }).out).toMatch(/empty/);
  expect(applyTodo(three, { action: "remove" }).out).toMatch(/unknown action/);
});

test("the todo tool works through the tool runner for the main agent only; explorers and workers do not get it", async () => {
  const c = makeCtx(tmpProject({}), "auto", async () => true, {}, DEFAULT);
  expect(names(c)).toContain("todo");
  expect(await runTool(c, "todo", { action: "set", items: three })).toContain("Todo list (1/3 done)");
  expect(c.todos).toEqual(three); expect(c.todoChanged).toBe(true);
  expect(await runTool(c, "todo", { action: "set", items: [] })).toMatch(/^Error/); expect(c.todos).toEqual(three);
  const explorer = { ...c, depth: 1, allowed: READONLY }; expect(names(explorer)).not.toContain("todo");
  expect(await runTool(explorer, "todo", { action: "list" })).toMatch(/not available to this helper/);
  const worker = { ...c, depth: 1, allowed: undefined }; expect(names(worker)).not.toContain("todo");
  expect(await runTool(worker, "todo", { action: "list" })).toMatch(/only the main agent/);
});

test("in a real run the explorer is not offered the todo tool, and the main agent's checklist is shown when it changes", async () => {
  const d = tmpProject({ "a.txt": "a\n" }); const logs: string[] = [];
  const ai = fakeAI([call("todo", { action: "set", items: [{ id: "1", text: "look around", status: "in_progress" }] }), call("delegate", { task: "find a.txt", role: "explorer" }), call("finish", { summary: "found" }), call("todo", { action: "update", id: "1", status: "done" }), call("finish", { summary: "all done" })]);
  const r = await runAgent({ root: d, task: "t", base: "http://x", key: "k", mode: "auto", fetchImpl: ai.f, log: (s) => logs.push(s) });
  const toolNames = (i: number) => ai.seen[i].tools.map((t: any) => t.function.name);
  expect(toolNames(0)).toContain("todo");
  expect(String(ai.seen[2].messages[0].content)).toContain("read-only research helper"); // this request is the explorer's
  expect(toolNames(2)).not.toContain("todo");
  expect(logs).toContain("Todo list (0/1 done):\n[>] 1. look around  (in progress)");
  expect(logs).toContain("Todo list (1/1 done):\n[x] 1. look around");
  expect(r.summary).toBe("all done"); expect(r.todos).toEqual([{ id: "1", text: "look around", status: "done" }]);
});

test("finishing with open items is sent back once with the open list; the second finish is accepted and says what was left open", async () => {
  const d = tmpProject({}); const logs: string[] = [];
  const ai = fakeAI([call("todo", { action: "set", items: three }), call("finish", { summary: "first try" }), call("finish", { summary: "second try" }), call("finish", { summary: "never reached" })]);
  const r = await runAgent({ root: d, task: "t", base: "http://x", key: "k", mode: "auto", fetchImpl: ai.f, log: (s) => logs.push(s) });
  expect(ai.seen.length).toBe(3); expect(r.stopped).toBe("finished");
  const nudges = ai.seen[2].messages.filter((m: any) => m.role === "user" && /todo list still has open items/.test(m.content));
  expect(nudges.length).toBe(1);
  expect(nudges[0].content).toContain("[>] 2. fix the bug"); expect(nudges[0].content).toContain("[ ] 3. run the tests"); expect(nudges[0].content).not.toContain("read the parser");
  expect(r.summary).toBe("second try\n(Todo items left open: 2. fix the bug; 3. run the tests)");
  expect(logs.filter((l) => l.startsWith("[todo check]")).length).toBe(1);
  // with everything done there is no nudge, and plan mode never nudges
  const ok = fakeAI([call("todo", { action: "set", items: [{ id: "1", text: "x", status: "done" }] }), call("finish", { summary: "done" })]);
  expect((await runAgent({ root: d, task: "t", base: "http://x", key: "k", mode: "auto", fetchImpl: ok.f })).summary).toBe("done"); expect(ok.seen.length).toBe(2);
  const plan = fakeAI([call("todo", { action: "set", items: three }), call("finish", { summary: "1. plan" })]);
  expect((await runAgent({ root: d, task: "t", base: "http://x", key: "k", mode: "plan", fetchImpl: plan.f })).summary).toBe("1. plan"); expect(plan.seen.length).toBe(2);
});

test("compaction: the todo list survives word for word and comes right after the summary", async () => {
  const msgs: any[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 10; i++) msgs.push({ role: "user", content: "q" + i }, { role: "assistant", content: "a" + i });
  const r = await summarizeHistory(msgs, async () => "SUMMARY TEXT", { todos: three });
  const at = r.messages.findIndex((m) => String(m.content).includes("SUMMARY TEXT"));
  expect(at).toBe(1);
  expect(r.messages[at + 1].role).toBe("assistant");
  expect(r.messages[at + 2].role).toBe("user");
  expect(String(r.messages[at + 2].content)).toContain(renderTodos(three));
  expect(r.messages[at + 3].role).toBe("assistant");
  expect(r.messages[at + 4]).toEqual(msgs[msgs.length - 6]); // then the kept tail, unchanged
  // no list, no extra message (as before)
  const plain = await summarizeHistory(msgs, async () => "SUMMARY TEXT");
  expect(plain.messages.length).toBe(r.messages.length - 2);
  expect(JSON.stringify(plain.messages)).not.toContain("todo list");
});

test("automatic compaction in a run puts the list the AI made back after the summary", async () => {
  const d = tmpProject({});
  const history: any[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) history.push({ role: "user", content: "q" + i + "y".repeat(300) }, { role: "assistant", content: "a" + i + "y".repeat(300) });
  const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), text: "step " + (i + 1) + " " + "z".repeat(280), status: i === 0 ? "in_progress" : "pending" }));
  const ai = fakeAI([call("todo", { action: "set", items }), { role: "assistant", content: "SHORT SUMMARY" }, call("todo", { action: "set", items: items.map((x) => ({ ...x, status: "done" })) }), call("finish", { summary: "done" })]);
  const r = await runAgent({ root: d, task: "go on", history, base: "http://x", key: "k", model: "m", mode: "auto", fetchImpl: ai.f, profile: { ...DEFAULT, compactAtChars: 4000 } });
  expect(String(ai.seen[1].messages[0].content)).toContain("Summarize this coding-assistant conversation");
  const after = ai.seen[2].messages;
  const s = after.findIndex((m: any) => String(m.content).includes("SHORT SUMMARY"));
  const t = after.findIndex((m: any) => String(m.content).startsWith("[Your todo list"));
  expect(s).toBe(1); expect(t).toBe(s + 2);
  expect(after[t].content).toContain("[>] 1. step 1"); expect(after[t].content).toContain("[ ] 10. step 10");
  expect(r.summary).toBe("done");
});

test("sessions keep the todo list; a broken saved list is dropped, not trusted", () => {
  const d = tmpProject({});
  saveSession(d, { id: "20260101000000-aaaa", model: "m", mode: "ask", messages: [{ role: "user", content: "Task:\nx" }], todos: three });
  expect(loadSession(d, "last")!.todos).toEqual(three);
  saveSession(d, { id: "20260101000000-aaaa", model: "m", mode: "ask", messages: [{ role: "user", content: "Task:\nx" }], todos: [] });
  expect(loadSession(d, "last")!.todos).toBeUndefined();
  saveSession(d, { id: "20260101000000-aaaa", model: "m", mode: "ask", messages: [{ role: "user", content: "Task:\nx" }], todos: [{ id: "a", text: "x", status: "in_progress" }, { id: "b", text: "y", status: "in_progress" }] as any });
  expect(loadSession(d, "last")!.todos).toBeUndefined();
});

test("cli: --json includes the final todo list, and --continue / --resume bring the list back", async () => {
  const d = tmpProject({});
  const bodies: any[] = [];
  const replies = [
    { name: "todo", args: { action: "set", items: [{ id: "1", text: "first", status: "done" }, { id: "2", text: "second", status: "pending" }] } },
    { name: "finish", args: { summary: "try 1" } },
    { name: "finish", args: { summary: "try 2" } },
    { name: "todo", args: { action: "list" } },
    { name: "finish", args: { summary: "continued" } },
    { name: "finish", args: { summary: "continued again" } },
    { name: "todo", args: { action: "update", id: "2", status: "done" } },
    { name: "finish", args: { summary: "resumed" } },
  ];
  const srv = Bun.serve({ port: 0, async fetch(req) {
    bodies.push(await req.json()); const r = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return Response.json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c" + bodies.length, type: "function", function: { name: r.name, arguments: JSON.stringify(r.args) } }] } }], usage: { total_tokens: 5 } });
  } });
  try {
    const env = { ...process.env, SYOK_BASE_URL: "http://localhost:" + srv.port, SYOK_API_KEY: "syk_test" };
    const go = async (args: string[]) => {
      const p = Bun.spawn([process.execPath, MAIN, ...args, "--cwd", d, "--json", "--no-stream", "--mode", "auto", "--no-confine"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text(); await p.exited;
      return JSON.parse(out.trim().split("\n").pop()!);
    };
    const o1 = await go(["-p", "two things"]);
    expect(o1.summary).toBe("try 2\n(Todo items left open: 2. second)");
    expect(o1.todos).toEqual([{ id: "1", text: "first", status: "done" }, { id: "2", text: "second", status: "pending" }]);
    const saved = JSON.parse(readFileSync(join(d, ".syok", "sessions", readdirSync(join(d, ".syok", "sessions"))[0]), "utf8"));
    expect(saved.todos).toEqual(o1.todos);
    const o2 = await go(["-p", "go on", "--continue"]);
    expect(bodies[3].messages.at(-1).content).toBe("go on");
    expect(bodies[4].messages.at(-1).content).toBe("Todo list (1/2 done):\n[x] 1. first\n[ ] 2. second"); // the list tool read the restored list
    expect(o2.todos).toEqual(o1.todos); expect(o2.summary).toBe("continued again\n(Todo items left open: 2. second)");
    const o3 = await go(["-p", "finish it", "--resume", o1.session]);
    expect(o3.summary).toBe("resumed");
    expect(o3.todos).toEqual([{ id: "1", text: "first", status: "done" }, { id: "2", text: "second", status: "done" }]);
  } finally { srv.stop(true); }
});
