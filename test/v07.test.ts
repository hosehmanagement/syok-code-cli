import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { makeCtx, runTool, commandTimeout } from "../src/tools.ts";
import { runAgent, SYSTEM, SYSTEM_GENERAL } from "../src/agent.ts";
import { startJob, jobInfo, jobLog, stopJob, listJobs, describeJobs } from "../src/jobs.ts";
import { DEFAULT } from "../src/profiles.ts";
import { tmpProject, fakeAI, call } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(f: () => boolean, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(100); } return false; }
const MAIN = join(import.meta.dir, "..", "src", "main.ts");
process.env.SYOK_ENTRY = MAIN; // job runners are started from the real program file

test("a saved job logs its output and records the exit code", async () => {
  const d = tmpProject({ "w.js": "console.log('hello job'); console.error('oops'); process.exit(3);" });
  const id = startJob(d, "node w.js");
  expect(await waitFor(() => jobInfo(d, id)?.state === "finished")).toBe(true);
  const j = jobInfo(d, id)!; expect(j.code).toBe(3);
  const log = jobLog(d, id);
  expect(log).toContain("hello job"); expect(log).toContain("oops"); expect(log).toContain("exit code 3");
  expect(describeJobs(d)).toContain("finished, exit code 3");
});

test("a saved job keeps running after the program that started it exits", async () => {
  const d = tmpProject({ "tick.js": "let n=0; setInterval(()=>{ console.log('tick '+(++n)); },100);" });
  // Start the job from a separate program that exits right away.
  const starter = join(d, "starter.ts");
  writeFileSync(starter, `import { startJob } from ${JSON.stringify(join(import.meta.dir, "..", "src", "jobs.ts"))}; console.log(startJob(${JSON.stringify(d)}, "node tick.js"));`);
  const r = spawnSync("bun", [starter], { encoding: "utf8" });
  expect(r.status).toBe(0);
  const id = +r.stdout.trim();
  // The starter is gone now, and the job must still be running and still writing.
  expect(await waitFor(() => jobLog(d, id).includes("tick 2"))).toBe(true);
  expect(jobInfo(d, id)!.state).toBe("running");
  const before = jobLog(d, id, 100000).length; await sleep(500);
  expect(jobLog(d, id, 100000).length).toBeGreaterThan(before);
  expect(stopJob(d, id)).toMatch(/Stopped/);
  expect(await waitFor(() => jobInfo(d, id)!.state === "finished")).toBe(true);
  const after = jobLog(d, id, 100000).length; await sleep(500);
  expect(jobLog(d, id, 100000).length).toBe(after); // really dead, not just marked
  expect(stopJob(d, id)).toMatch(/not running/);
});

test("max time stops a saved job (exit code 124)", async () => {
  const d = tmpProject({ "s.js": "setInterval(()=>{},1000);" });
  const id = startJob(d, "node s.js", 1);
  expect(await waitFor(() => jobInfo(d, id)?.state === "finished", 10000)).toBe(true);
  expect(jobInfo(d, id)!.code).toBe(124); expect(jobLog(d, id)).toContain("stopped after 1 seconds");
});

test("job tools: start, read, stop, list; same safety rules as commands", async () => {
  const d = tmpProject({ "t.js": "console.log('started'); setInterval(()=>{},1000);" });
  const c = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  const started = await runTool(c, "job_start", { command: "node t.js" });
  expect(started).toContain("Started saved job 1"); expect(started).toContain("started");
  expect(await runTool(c, "job_output", {})).toContain("running");
  expect(await runTool(c, "job_output", { id: 1 })).toContain("[still running]");
  expect(await runTool(c, "job_stop", { id: 1 })).toMatch(/Stopped/);
  expect(await runTool(c, "job_output", { id: 9 })).toMatch(/no saved job/);
  expect(listJobs(d).length).toBe(1);
  const denied = makeCtx(d, "ask", async () => false, {}, DEFAULT);
  expect(await runTool(denied, "job_start", { command: "node t.js" })).toMatch(/Not run/);
  expect(await runTool(c, "job_start", { command: "sudo reboot" })).toMatch(/blocked/);
});

test("exiting the program does not stop saved jobs (stopAll only touches session jobs)", async () => {
  const d = tmpProject({ "t.js": "setInterval(()=>{},1000);" });
  const c = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  await runTool(c, "job_start", { command: "node t.js" });
  c.bg.stopAll();
  expect(jobInfo(d, 1)!.state).toBe("running");
  stopJob(d, 1);
});

test("command line: syok jobs / logs / stop work without an API key", async () => {
  const d = tmpProject({ "t.js": "console.log('cli-visible'); setInterval(()=>{},1000);" });
  const id = startJob(d, "node t.js");
  expect(await waitFor(() => jobLog(d, id).includes("cli-visible"))).toBe(true);
  const env = { ...process.env, SYOK_API_KEY: "", SYOK_BASE_URL: "" };
  const run = (...a: string[]) => spawnSync("bun", [MAIN, ...a, "--cwd", d], { encoding: "utf8", env, cwd: join(import.meta.dir, "..") });
  expect(run("jobs").stdout).toContain("running");
  expect(run("logs", String(id)).stdout).toContain("cli-visible");
  expect(run("stop", String(id)).stdout).toContain("Stopped");
  expect(run("logs").status).toBe(2);
  expect(await waitFor(() => jobInfo(d, id)!.state === "finished")).toBe(true);
});

test("command timeout: default, request, settings and the hard ceiling", () => {
  delete process.env.SYOK_MAX_TIMEOUT;
  expect(commandTimeout({})).toBe(120);
  expect(commandTimeout({}, 30)).toBe(30);
  expect(commandTimeout({}, 5000)).toBe(600); // old cap stays the default
  expect(commandTimeout({ max_timeout_sec: 3600 }, 1800)).toBe(1800);
  expect(commandTimeout({ max_timeout_sec: 3600 }, 99999)).toBe(3600);
  expect(commandTimeout({ timeout_sec: 300 })).toBe(300);
  expect(commandTimeout({ max_timeout_sec: 10 ** 9 }, 10 ** 9)).toBe(86400);
  expect(commandTimeout({}, 1)).toBe(5);
  process.env.SYOK_MAX_TIMEOUT = "900"; expect(commandTimeout({}, 5000)).toBe(900); delete process.env.SYOK_MAX_TIMEOUT;
});

test("run_command really honours a raised limit (command longer than 1 s ends by itself)", async () => {
  const d = tmpProject({});
  const c = makeCtx(d, "auto", async () => true, { max_timeout_sec: 60 }, DEFAULT);
  const r = await runTool(c, "run_command", { command: "node -e \"setTimeout(()=>console.log('done late'),1500)\"", timeout_sec: 30 });
  expect(r).toContain("done late"); expect(r).toContain("[exit code 0]");
});

test("general mode removes the programming-only rule; the default keeps it", async () => {
  expect(SYSTEM).toContain("only help with code");
  expect(SYSTEM_GENERAL).not.toContain("only help with code");
  expect(SYSTEM_GENERAL).toContain("any task that can be done in a terminal");
  expect(SYSTEM_GENERAL).toContain("job_start");
  for (const general of [false, true]) {
    const d = tmpProject({});
    const ai = fakeAI([call("finish", { summary: "ok" })]);
    await runAgent({ root: d, task: "rename my photos by date", base: "http://x", key: "k", mode: "auto", settings: { general }, fetchImpl: ai.f });
    const sys = ai.seen[0].messages[0].content as string;
    expect(sys.includes("only help with code")).toBe(!general);
    expect(ai.seen[0].tools.map((t: any) => t.function.name)).toEqual(expect.arrayContaining(["job_start", "job_output", "job_stop"]));
  }
});
