// Custom named helpers: reading the files (Syok's own, Claude Code's, Copilot's), and what a helper may do when it runs.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseTools, parseAgent, loadAgents, describeAgents, agentsHint } from "../src/agents.ts";
import { runAgent } from "../src/agent.ts";
import { makeCtx, toolDefs } from "../src/tools.ts";
import { DEFAULT } from "../src/profiles.ts";
import { tmpProject, call } from "./helpers.ts";

const base = "http://x";
const sorted = (s: Set<string>) => [...s].sort();

test("the tools line: Syok names, Claude Code names and Copilot names all work; unknown names are reported, never guessed", () => {
  expect(sorted(parseTools("read, search").allowed)).toEqual(["find_files", "find_symbol", "finish", "list_files", "outline", "read_file", "search"]);
  expect(sorted(parseTools("Read, Grep, Glob, LS").allowed)).toEqual(["find_files", "find_symbol", "finish", "list_files", "outline", "read_file", "search"]);
  expect(sorted(parseTools("['read', 'edit']").allowed)).toEqual(["edit_file", "find_files", "find_symbol", "finish", "list_files", "outline", "read_file", "search", "write_file"]);
  expect(sorted(parseTools("- Read - Bash(git diff:*) - WebFetch").allowed)).toEqual(["bg_output", "bg_start", "bg_stop", "find_files", "find_symbol", "finish", "job_output", "job_start", "job_stop", "list_files", "outline", "read_file", "run_command", "search", "web_fetch"]);
  expect(sorted(parseTools("read_file, run_command").allowed)).toEqual(["finish", "read_file", "run_command"]);
  const u = parseTools("Read, mcp__github__create_issue, Frobnicate, Task, delegate");
  expect(u.unknown).toEqual(["mcp__github__create_issue", "Frobnicate"]); expect(u.allowed.has("delegate")).toBe(false); expect(sorted(u.allowed)).toEqual(["find_files", "find_symbol", "finish", "list_files", "outline", "read_file", "search"]);
});

test("a helper file: name, description, instructions, and whether it is read-only", () => {
  const a = parseAgent("---\nname: Code Reviewer\ndescription: Reviews changes\n  for bugs\ntools: Read, Grep\nmodel: sonnet\n---\nYou review code.\n", "x", "project", "/f")!;
  expect(a.name).toBe("code-reviewer"); expect(a.description).toBe("Reviews changes for bugs"); expect(a.prompt).toBe("You review code."); expect(a.readOnly).toBe(true);
  const b = parseAgent("---\ndescription: fixes\n---\nFix things.", "fixer", "project", "/f")!; expect(b.name).toBe("fixer"); expect(b.allowed).toBeUndefined(); expect(b.readOnly).toBe(false);
  const c = parseAgent("---\ntools: read, edit, shell\nreadonly: true\n---\nLook only.", "looker", "p", "/f")!; expect(c.readOnly).toBe(true); expect(sorted(c.allowed!)).toEqual(["find_files", "find_symbol", "finish", "list_files", "outline", "read_file", "search"]);
  const w = parseAgent("---\ntools: read, web\n---\nResearch.", "res", "p", "/f")!; expect(w.readOnly).toBe(true); expect(w.allowed!.has("web_search")).toBe(true);
  const e = parseAgent("---\ntools: read, edit\n---\nEdit.", "ed", "p", "/f")!; expect(e.readOnly).toBe(false);
  expect(parseAgent("---\nname: x\n---\n", "x", "p", "/f")).toBeNull();        // no instructions
  expect(parseAgent("just text", "explorer", "p", "/f")).toBeNull();           // the built-in roles cannot be replaced
  expect(parseAgent("just text", "worker", "p", "/f")).toBeNull();
  expect(parseAgent("no front matter at all", "plain", "p", "/f")!.prompt).toBe("no front matter at all");
});

test("files are found in all five places; the project wins over the home folder and Syok's file over another tool's", () => {
  const d = tmpProject({
    ".syok/agents/reviewer.md": "---\ndescription: syok one\ntools: read\n---\nSyok reviewer.",
    ".claude/agents/reviewer.md": "---\ndescription: claude one\n---\nClaude reviewer.",
    ".claude/agents/tester.md": "---\nname: tester\ndescription: Runs the tests\ntools: Read, Bash\n---\nRun tests.",
    ".github/agents/docs.agent.md": "---\ndescription: Writes docs\ntools: ['read', 'edit']\n---\nWrite docs.",
    ".github/agents/README.md": "not an agent",
    ".syok/agents/notes.txt": "ignored",
  });
  const home = tmpProject({ ".syok/agents/tester.md": "---\ndescription: home tester\n---\nHome.", ".claude/agents/planner.md": "---\ndescription: Plans\ntools: Read\n---\nPlan." });
  const list = loadAgents(d, home);
  expect(list.map((a) => a.name)).toEqual(["reviewer", "tester", "docs", "planner"]);
  expect(list[0].description).toBe("syok one"); expect(list[1].description).toBe("Runs the tests"); expect(list[1].from).toBe("project (Claude Code file)"); expect(list[2].from).toBe("project (Copilot file)"); expect(list[3].from).toBe("home folder (Claude Code file)");
  const text = describeAgents(list); expect(text).toContain("reviewer  [read-only]  syok one"); expect(text).toContain("docs  [limited tools: "); expect(describeAgents([])).toContain(".syok/agents/<name>.md");
  expect(agentsHint(list)).toContain("'tester' (may change things: Runs the tests)"); expect(agentsHint([])).toBe("");
  expect(loadAgents(tmpProject({}), tmpProject({}))).toEqual([]);
});

test("the AI is told which helpers exist, only at the top level, and settings can switch them off", () => {
  const d = tmpProject({ ".syok/agents/reviewer.md": "---\ndescription: Reviews changes\ntools: read\n---\nReview." });
  const c = makeCtx(d, "auto", async () => true, {}, DEFAULT); c.agents = loadAgents(d, tmpProject({}));
  const del = toolDefs(c).find((t: any) => t.function.name === "delegate"); expect(del.function.description).toContain("'reviewer' (read-only: Reviews changes)");
  const off = makeCtx(d, "auto", async () => true, { agents: false }, DEFAULT); expect(off.agents).toEqual([]);
  expect(toolDefs(off).find((t: any) => t.function.name === "delegate").function.description).not.toContain("reviewer");
});

function scripted(d: string, childMark: string, parentCalls: any[], child: (req: any, n: number) => any) {
  const childReqs: any[] = []; let peak = 0, active = 0;
  const f = (async (_u: any, o: any) => {
    const req = JSON.parse(o.body); const isChild = String(req.messages[0].content).includes(childMark);
    const n = req.messages.filter((m: any) => m.role === "tool").length;
    let msg: any;
    if (isChild) { childReqs.push(req); active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 150)); active--; msg = child(req, n); }
    else msg = n === 0 ? { role: "assistant", content: "", tool_calls: parentCalls.map((c) => c.tool_calls[0]) } : call("finish", { summary: "parent done" });
    return new Response(JSON.stringify({ choices: [{ message: msg }], usage: { total_tokens: 1 } }));
  }) as any;
  return { f, childReqs, peak: () => peak };
}

test("a read-only helper gets its own instructions, only its tools, cannot edit even if it tries, and two of them run at the same time", async () => {
  const d = tmpProject({ "a.txt": "x", ".syok/agents/reviewer.md": "---\ndescription: Reviews\ntools: read, search\n---\nYou are the REVIEWER-MARK helper." });
  const s = scripted(d, "REVIEWER-MARK", [call("delegate", { task: "review a.txt", role: "reviewer" }), call("delegate", { task: "review again", role: "reviewer" })],
    (_req, n) => n === 0 ? call("edit_file", { path: "a.txt", old_text: "x", new_text: "HACKED" }) : n === 1 ? call("run_command", { command: "echo hi > b.txt" }) : call("finish", { summary: "reviewed" }));
  const ctx = makeCtx(d, "auto", async () => true, {}, DEFAULT); ctx.agents = loadAgents(d, tmpProject({}));
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: s.f, ctx, profile: { ...DEFAULT, nudgeTests: false } });
  expect(r.summary).toBe("parent done"); expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("x"); expect(r.touched).toEqual([]);
  const names = s.childReqs[0].tools.map((t: any) => t.function.name).sort(); expect(names).toEqual(["find_files", "find_symbol", "finish", "list_files", "outline", "read_file", "search"]);
  expect(String(s.childReqs[0].messages[0].content)).toContain('You are "reviewer"'); expect(String(s.childReqs[0].messages[0].content)).toContain("You cannot change anything.");
  const blocked = s.childReqs.flatMap((q) => q.messages).filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
  expect(blocked.some((t) => t.includes("edit_file is not available to this helper"))).toBe(true); expect(blocked.some((t) => t.includes("run_command is not available to this helper"))).toBe(true);
  expect(s.peak()).toBe(2);
  expect(r.messages.filter((m) => m.role === "tool").map((m) => String(m.content)).filter((t) => t.includes("(reviewer finished")).length).toBe(2);
});

test("a helper that may edit does edit, one at a time, with the parent's undo; a file made for Claude Code works unchanged", async () => {
  const d = tmpProject({ "a.txt": "old", ".claude/agents/fixer.md": "---\nname: fixer\ndescription: Fixes one thing\ntools: Read, Edit\n---\nYou are the FIXER-MARK helper." });
  const s = scripted(d, "FIXER-MARK", [call("delegate", { task: "change old to new", role: "fixer" }), call("delegate", { task: "second", role: "fixer" })],
    (req, n) => n === 0 && String(req.messages[1].content).includes("change old") ? call("edit_file", { path: "a.txt", old_text: "old", new_text: "new" }) : call("finish", { summary: "fixed" }));
  const ctx = makeCtx(d, "auto", async () => true, {}, DEFAULT); ctx.agents = loadAgents(d, tmpProject({}));
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: s.f, ctx, profile: { ...DEFAULT, nudgeTests: false } });
  expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("new"); expect(r.touched).toEqual(["a.txt"]); expect(s.peak()).toBe(1);
  const names = s.childReqs[0].tools.map((t: any) => t.function.name); expect(names).toContain("edit_file"); expect(names).not.toContain("run_command"); expect(names).not.toContain("delegate");
});

test("a helper cannot widen permissions: in ask mode its edit still needs a yes, and a no is respected", async () => {
  const d = tmpProject({ "a.txt": "old", ".syok/agents/fixer.md": "---\ndescription: Fixes\n---\nYou are the FIXER-MARK helper." });
  const asked: string[] = [];
  const s = scripted(d, "FIXER-MARK", [call("delegate", { task: "change it", role: "fixer" })], (_req, n) => n === 0 ? call("edit_file", { path: "a.txt", old_text: "old", new_text: "new" }) : call("finish", { summary: "could not" }));
  const ask = async (what: string) => { asked.push(what); return false; };
  const ctx = makeCtx(d, "ask", ask, {}, DEFAULT); ctx.agents = loadAgents(d, tmpProject({}));
  await runAgent({ root: d, task: "t", base, key: "k", mode: "ask", ask, fetchImpl: s.f, ctx, profile: { ...DEFAULT, nudgeTests: false } });
  expect(asked.length).toBe(1); expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("old");
});

test("a name that is not a helper is answered with the list, and nothing runs", async () => {
  const d = tmpProject({ ".syok/agents/reviewer.md": "---\ntools: read\n---\nYou are the REVIEWER-MARK helper." });
  const s = scripted(d, "REVIEWER-MARK", [call("delegate", { task: "x", role: "hacker" })], () => call("finish", { summary: "should not run" }));
  const ctx = makeCtx(d, "auto", async () => true, {}, DEFAULT); ctx.agents = loadAgents(d, tmpProject({}));
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: s.f, ctx });
  expect(s.childReqs.length).toBe(0);
  expect(r.messages.filter((m) => m.role === "tool").map((m) => String(m.content))[0]).toBe('Error: there is no helper called "hacker". Use explorer, worker or one of: reviewer.');
});

test("syok agents lists them without a key", () => {
  const d = tmpProject({ ".syok/agents/reviewer.md": "---\ndescription: Reviews changes\ntools: read, Frobnicate\n---\nReview." });
  const r = spawnSync("bun", [join(import.meta.dir, "..", "src", "main.ts"), "agents", "--cwd", d], { encoding: "utf8", env: { ...process.env, HOME: d, USERPROFILE: d } });
  expect(r.status).toBe(0); expect(r.stdout).toContain("reviewer  [read-only]  Reviews changes"); expect(r.stdout).toContain("not understood in its tools line (left out): Frobnicate");
});
