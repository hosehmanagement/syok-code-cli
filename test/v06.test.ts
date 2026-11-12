import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpProject, fakeAI, call } from "./helpers.ts";
import { runAgent, makeCtx, loadInstructions } from "../src/agent.ts";
import { runTool } from "../src/tools.ts";
import { DEFAULT } from "../src/profiles.ts";
import { saveSession, loadSession, listSessions, titleOf } from "../src/session.ts";
import { takeCheckpoint, rewindTo, type Checkpoint } from "../src/checkpoint.ts";
import { loadCommands, renderCommand, parseFront } from "../src/commands.ts";
import { addPlugin, listPlugins, pluginSettings, removePlugin } from "../src/plugins.ts";
import { loadSkills } from "../src/skills.ts";
import { extractImages } from "../src/image.ts";
import { summarizeHistory, cutPoint } from "../src/compactor.ts";
import { reviewTask, openPr, slug } from "../src/pr.ts";
import { allowCommand, allowEdit, MODES } from "../src/perm.ts";
import { sandboxExec } from "../src/sandbox.ts";

const home = () => mkdtempSync(join(tmpdir(), "syok-home-"));
const MAIN = join(import.meta.dir, "../src/main.ts");

test("sessions: saved, listed newest first, loaded by last / number / id start", async () => {
  const d = tmpProject({});
  const a = saveSession(d, { id: "20260101000000-aaaa", model: "m", mode: "ask", messages: [{ role: "system", content: "s" }, { role: "user", content: "Task:\nfix the bug" }] });
  await new Promise((r) => setTimeout(r, 8));
  saveSession(d, { id: "20260102000000-bbbb", model: "m2", mode: "auto", messages: [{ role: "user", content: [{ type: "text", text: "second chat" }] }] });
  expect(listSessions(d).map((x) => x.id)).toEqual(["20260102000000-bbbb", "20260101000000-aaaa"]);
  expect(a.title).toBe("fix the bug");
  expect(loadSession(d)!.id).toBe("20260102000000-bbbb");
  expect(loadSession(d, "2")!.id).toBe("20260101000000-aaaa");
  expect(loadSession(d, "20260101")!.model).toBe("m");
  expect(loadSession(d, "nope")).toBeNull();
  expect(loadSession(tmpProject({}))).toBeNull();
  expect(titleOf([{ role: "user", content: [{ type: "text", text: "x" }] }])).toBe("x");
});

test("checkpoints: rewind restores edited files and removes files made later", async () => {
  const d = tmpProject({ "a.txt": "one" });
  const ctx = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  const cps: Checkpoint[] = [];
  takeCheckpoint(ctx, cps, "start", 0);
  await runTool(ctx, "write_file", { path: "a.txt", content: "two" });
  takeCheckpoint(ctx, cps, "after a", 4);
  await runTool(ctx, "write_file", { path: "a.txt", content: "three" });
  await runTool(ctx, "write_file", { path: "b.txt", content: "new" });
  const r = rewindTo(ctx, cps, 2)!;
  expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("two");
  expect(existsSync(join(d, "b.txt"))).toBe(false);
  expect(r.msgLen).toBe(4);
  expect(cps.length).toBe(1);
  rewindTo(ctx, cps, 1);
  expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("one");
  expect(rewindTo(ctx, cps, 9)).toBeNull();
});

test("custom commands: files become /name, arguments are filled in, project beats home", () => {
  const d = tmpProject({ ".syok/commands/review.md": "---\ndescription: Review a file\n---\nReview $ARGUMENTS carefully.", ".syok/commands/plain.md": "Just do it", ".claude/commands/ship.md": "Ship it" });
  const h = tmpProject({ ".syok/commands/review.md": "home version", ".syok/commands/mine.md": "mine" });
  const m = loadCommands(d, h);
  expect([...m.keys()].sort()).toEqual(["mine", "plain", "review", "ship"]);
  expect(m.get("review")!.description).toBe("Review a file");
  expect(renderCommand(m.get("review")!, "src/a.ts")).toBe("Review src/a.ts carefully.");
  expect(renderCommand(m.get("plain")!, "x")).toContain("Arguments: x");
  expect(parseFront("no front").body).toBe("no front");
});

test("plugins: added from a folder; skills, commands and hooks appear; removable", async () => {
  const d = tmpProject({}); const h = home();
  const src = tmpProject({ "plugin.json": JSON.stringify({ name: "My Kit", description: "demo" }), "skills/greet/SKILL.md": "---\nname: greet\ndescription: say hi\n---\nSay hi.", "commands/hello.md": "Say hello to $ARGUMENTS", "settings.json": JSON.stringify({ hooks: { Stop: [{ command: "echo done" }] }, mcpServers: { tools: { command: "node" } } }) });
  const r = await addPlugin(d, src);
  expect(r.ok).toBe(true); expect(r.name).toBe("my-kit"); expect(r.message).toContain("WARNING");
  expect(listPlugins(d, h).map((p) => p.name)).toEqual(["my-kit"]);
  expect(loadSkills(d, h).has("greet")).toBe(true);
  expect(loadCommands(d, h).has("hello")).toBe(true);
  const s = pluginSettings(d, { hooks: { Stop: [{ command: "mine" }] } }, h);
  expect(s.hooks!.Stop.length).toBe(2);
  expect(Object.keys(s.mcpServers!)).toEqual(["my-kit-tools"]);
  expect(removePlugin(d, "my-kit")).toBe(true);
  expect(listPlugins(d, h)).toEqual([]);
  expect((await addPlugin(d, tmpProject({ "x.txt": "1" }))).ok).toBe(false);
  expect((await addPlugin(d, "not a thing")).ok).toBe(false);
});

test("plugins: added from GitHub (fake download)", async () => {
  const w = tmpProject({ "kit-main/skills/x/SKILL.md": "---\nname: x\ndescription: d\n---\nbody", "kit-main/commands/c.md": "hi" });
  const tgz = join(w, "k.tgz"); spawnSync("tar", ["-czf", tgz, "-C", w, "kit-main"]);
  const f = (async (u: any) => { expect(String(u)).toBe("https://codeload.github.com/acme/kit/tar.gz/HEAD"); return new Response(readFileSync(tgz)); }) as any;
  const d = tmpProject({});
  const r = await addPlugin(d, "https://github.com/acme/kit", f);
  expect(r.ok).toBe(true); expect(r.name).toBe("kit");
  expect(existsSync(join(d, ".syok/plugins/kit/commands/c.md"))).toBe(true);
  expect((await addPlugin(d, "acme/none", (async () => new Response("no", { status: 404 })) as any)).ok).toBe(false);
});

test("images: @file.png is attached; outside, missing and non-image names are left alone", () => {
  const d = tmpProject({ "shot.png": "PNGDATA", "notes.txt": "x" });
  const r = extractImages(d, "what is wrong in @shot.png and @notes.txt and @gone.png and @../out.png ?");
  expect(r.images.length).toBe(1);
  expect(r.images[0].startsWith("data:image/png;base64,")).toBe(true);
  expect(r.text).toContain("[image: shot.png]");
  expect(r.text).toContain("@notes.txt");
  expect(r.notes.length).toBe(2);
});

test("summarize: the old middle becomes one summary and the kept part starts at a user message", async () => {
  const msgs: any[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 6; i++) { msgs.push({ role: "user", content: "q" + i }, call("read_file", { path: "a" + i }), { role: "tool", tool_call_id: "x", name: "read_file", content: "data" + i }, { role: "assistant", content: "a" + i }); }
  let seen = "";
  const r = await summarizeHistory(msgs, async (p) => { seen = p; return "SUMMARY TEXT"; }, { keepTail: 6, focus: "the parser" });
  expect(r.removed).toBeGreaterThan(0);
  expect(r.messages[0].content).toBe("sys");
  expect(r.messages[1].content).toContain("SUMMARY TEXT");
  expect(r.messages[2].role).toBe("assistant");
  expect(r.messages[3].role).toBe("user");
  expect(seen).toContain("the parser"); expect(seen).toContain("q0");
  expect((await summarizeHistory(msgs.slice(0, 4), async () => "x")).removed).toBe(0);
  expect(cutPoint(msgs, 6)).toBeGreaterThan(1);
});

test("pull requests: review reads the PR through gh; opening one branches, commits, pushes, creates", async () => {
  const calls: string[] = [];
  const run = ((c: string, a: string[]) => {
    calls.push(c + " " + a.join(" "));
    if (a[0] === "pr" && a[1] === "view") return { code: 0, out: '{"title":"T"}' };
    if (a[0] === "pr" && a[1] === "diff") return { code: 0, out: "diff --git a/x b/x" };
    if (a[0] === "status") return { code: 0, out: " M a.txt" };
    if (a[0] === "branch") return { code: 0, out: "main" };
    if (a[0] === "pr" && a[1] === "create") return { code: 0, out: "https://github.com/o/r/pull/7" };
    return { code: 0, out: "" };
  }) as any;
  const t = reviewTask("7", run, ".");
  expect(t.task).toContain("diff --git"); expect(t.task).toContain("Review this pull request");
  expect(reviewTask("7", (() => ({ code: 1, out: "nope" })) as any, ".").error).toContain("Could not read");
  expect((await openPr("Fix it", run, ".", async () => false)).ok).toBe(false);
  calls.length = 0;
  const ok = await openPr("Fix the bug!", run, ".", async () => true);
  expect(ok.ok).toBe(true); expect(ok.url).toBe("https://github.com/o/r/pull/7");
  const all = calls.join("\n");
  expect(all).toContain("checkout -b syok/fix-the-bug");
  expect(all).toContain("push -u origin syok/fix-the-bug");
  expect(all).toContain(":(exclude).env");
  expect(all).not.toContain("--force");
  expect(slug("Hello, World!!")).toBe("hello-world");
});

test("plan mode: edits and non-read commands are refused, read-only commands run", async () => {
  expect(MODES).toEqual(["ask", "accept-edits", "plan", "auto"]);
  expect(await allowEdit("plan", async () => true, "a.ts", "")).toBe(false);
  expect((await allowCommand("plan", async () => true, "git status", {})).ok).toBe(true);
  const w = await allowCommand("plan", async () => true, "npm install foo", {});
  expect(w.ok).toBe(false); expect(w.why).toContain("Plan mode");
  expect((await allowCommand("plan", async () => true, "sudo ls", {})).ok).toBe(false);
});

test("plan mode in a run: the task carries the plan note and a write is refused", async () => {
  const d = tmpProject({ "a.txt": "keep" });
  const { f, seen } = fakeAI([call("write_file", { path: "a.txt", content: "changed" }), call("finish", { summary: "1. edit a.txt" })]);
  const r = await runAgent({ root: d, task: "change it", base: "http://x", key: "k", model: "m", mode: "plan", fetchImpl: f });
  expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("keep");
  expect(String(seen[0].messages.at(-1).content)).toContain("PLAN MODE");
  expect(r.summary).toContain("edit a.txt");
  expect(r.touched.length).toBe(0);
});

test("instructions: personal and project files are merged, duplicates once", () => {
  const d = tmpProject({ "AGENTS.md": "Use tabs.", "CLAUDE.md": "Use tabs.", ".claude/CLAUDE.md": "Run bun test." });
  const h = tmpProject({ ".syok/SYOK.md": "Be brief." });
  const t = loadInstructions(d, h);
  expect(t).toContain("Be brief."); expect(t).toContain("Run bun test.");
  expect(t.split("Use tabs.").length - 1).toBe(1);
});

test("images are sent as image parts with the first message", async () => {
  const d = tmpProject({});
  const { f, seen } = fakeAI([call("finish", { summary: "ok" })]);
  await runAgent({ root: d, task: "look", images: ["data:image/png;base64,AAAA"], base: "http://x", key: "k", model: "m", fetchImpl: f });
  const u = seen[0].messages.at(-1).content;
  expect(Array.isArray(u)).toBe(true);
  expect(u[1].image_url.url).toContain("base64,AAAA");
});

test("a very long chat is summarized once, then the run goes on", async () => {
  const d = tmpProject({});
  const big = "x".repeat(900);
  const history: any[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) history.push({ role: "user", content: "q" + i + big }, { role: "assistant", content: "a" + i + big });
  const { f, seen } = fakeAI([{ role: "assistant", content: "SHORT SUMMARY" }, call("finish", { summary: "done" })]);
  const r = await runAgent({ root: d, task: "go on", history, base: "http://x", key: "k", model: "m", fetchImpl: f, profile: { ...DEFAULT, compactAtChars: 2000 } });
  expect(String(seen[0].messages[0].content)).toContain("Summarize this coding-assistant conversation");
  expect(seen[0].tools).toBeUndefined();
  expect(JSON.stringify(seen[1].messages)).toContain("SHORT SUMMARY");
  expect(r.summary).toBe("done");
});

test("sandbox: commands go to the Daytona call, and blocked commands never get there", async () => {
  const f = (async (_u: any, o: any) => new Response(JSON.stringify({ output: "hi " + JSON.parse(o.body).command, exitCode: 0 }), { status: 200 })) as any;
  expect(await sandboxExec({ base: "http://x/v1", key: "k", f }, "echo a", 30)).toBe("hi echo a\n[exit code 0]");
  expect(await sandboxExec({ base: "http://x", key: "k", f: (async () => new Response('{"error":"no sandbox"}', { status: 404 })) as any }, "ls", 30)).toContain("syok sandbox start");
  const ctx = makeCtx(tmpProject({}), "auto", async () => true, {}, DEFAULT);
  const sent: string[] = []; ctx.sandbox = async (c) => { sent.push(c); return "SB:" + c; };
  expect(await runTool(ctx, "run_command", { command: "echo hi" })).toBe("SB:echo hi");
  expect(await runTool(ctx, "run_command", { command: "sudo rm -rf /" })).toContain("Not run");
  expect(sent).toEqual(["echo hi"]);
});

test("cli: sessions, commands and plugin list work without an AI key", () => {
  const d = tmpProject({ ".syok/commands/hi.md": "Say hi" });
  const run = (...a: string[]) => spawnSync(process.execPath, [MAIN, ...a, "--cwd", d], { encoding: "utf8", env: { ...process.env, SYOK_API_KEY: "", SYOK_BASE_URL: "" } });
  expect(run("commands").stdout).toContain("/hi");
  expect(run("sessions").stdout).toContain("No saved chats");
  expect(run("plugin", "list").stdout).toContain("No plugins");
});

test("cli: a -p run is saved, --continue picks it up, a piped task works", async () => {
  const d = tmpProject({});
  const bodies: any[] = [];
  const srv = Bun.serve({ port: 0, async fetch(req) {
    bodies.push(await req.json());
    return Response.json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "done " + bodies.length }) } }] } }], usage: { total_tokens: 5 } });
  } });
  const env = { ...process.env, SYOK_BASE_URL: "http://localhost:" + srv.port, SYOK_API_KEY: "syk_test" };
  const go = async (args: string[], stdin?: string) => {
    const p = Bun.spawn([process.execPath, MAIN, ...args, "--cwd", d, "--json", "--no-stream"], { env, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text(); await p.exited;
    return JSON.parse(out.trim().split("\n").pop()!);
  };
  const o1 = await go(["-p", "first job"]);
  expect(o1.summary).toBe("done 1"); expect(typeof o1.session).toBe("string");
  await go(["-p", "second job", "--continue"]);
  expect(JSON.stringify(bodies[1].messages)).toContain("first job");
  expect(JSON.stringify(bodies[1].messages)).toContain("second job");
  await go(["-p", "-"], "piped task");
  expect(JSON.stringify(bodies[2].messages)).toContain("piped task");
  srv.stop(true);
});
