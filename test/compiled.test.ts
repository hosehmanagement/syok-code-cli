// The compiled program (no Bun installed on the user's machine) must work by itself, including saved jobs.
import { test, expect, beforeAll } from "bun:test";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfArgs, jobInfo, jobLog } from "../src/jobs.ts";
import { tmpProject, call } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(f: () => boolean, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(100); } return false; }
const exe = join(mkdtempSync(join(tmpdir(), "syok-bin-")), process.platform === "win32" ? "syok.exe" : "syok");

beforeAll(() => {
  const r = spawnSync("bun", ["build", "--compile", join(import.meta.dir, "..", "src", "main.ts"), "--outfile", exe], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("compile failed: " + r.stderr);
}, 120000);

test("how the program restarts itself: script under Bun, compiled program, test override", () => {
  expect(selfArgs("/home/me/syok.js", undefined)).toEqual(["/home/me/syok.js"]);
  expect(selfArgs("/$bunfs/root/syok", undefined)).toEqual([]);
  expect(selfArgs("B:\\~BUN\\root\\syok.exe", undefined)).toEqual([]);
  expect(selfArgs("B:/~BUN/root/syok.exe", undefined)).toEqual([]);
  expect(selfArgs("/$bunfs/root/syok", "/x/main.ts")).toEqual(["/x/main.ts"]);
});

test("compiled program runs without Bun on the path: help, version, jobs", () => {
  const env = { PATH: "/nonexistent", HOME: tmpdir(), SYOK_API_KEY: "", SYOK_BASE_URL: "" } as any;
  const d = tmpProject({});
  const help = spawnSync(exe, ["--help"], { encoding: "utf8", env });
  expect(help.status).toBe(0); expect(help.stdout).toContain("syok");
  const jobs = spawnSync(exe, ["jobs", "--cwd", d], { encoding: "utf8", env });
  expect(jobs.status).toBe(0); expect(jobs.stdout).toContain("No saved jobs");
});

test("compiled program: the AI starts a saved job, it outlives the program, and stop really stops it", async () => {
  const d = tmpProject({ "tick.js": "let n=0; setInterval(()=>{ console.log('tick '+(++n)); },100);" });
  const script = [call("job_start", { command: "node tick.js" }), call("finish", { summary: "started" })];
  let i = 0;
  const server = Bun.serve({ port: 0, fetch: async () => new Response(JSON.stringify({ choices: [{ message: script[Math.min(i++, script.length - 1)] }], usage: { total_tokens: 1 } }), { headers: { "content-type": "application/json" } }) });
  try {
    const env = { ...process.env, SYOK_BASE_URL: `http://127.0.0.1:${server.port}`, SYOK_API_KEY: "syk_test", SYOK_ENTRY: "", HOME: d, USERPROFILE: d };
    const p = spawn(exe, ["--mode", "auto", "--no-stream", "--cwd", d, "-p", "start the ticker as a saved job"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; p.stdout.on("data", (b) => (out += b)); p.stderr.on("data", (b) => (out += b));
    const code = await new Promise<number>((r) => p.on("exit", (c) => r(c ?? -1)));
    expect(out + " [exit " + code + "]").toContain("[exit 0]");
    // The program has exited; the job must still be alive and writing.
    expect(await waitFor(() => jobLog(d, 1).includes("tick 3"))).toBe(true);
    expect(jobInfo(d, 1)!.state).toBe("running");
    const before = jobLog(d, 1, 100000).length; await sleep(500);
    expect(jobLog(d, 1, 100000).length).toBeGreaterThan(before);
    expect(spawnSync(exe, ["logs", "1", "--cwd", d], { encoding: "utf8" }).stdout).toContain("tick 1");
    expect(spawnSync(exe, ["stop", "1", "--cwd", d], { encoding: "utf8" }).stdout).toContain("Stopped");
    expect(await waitFor(() => jobInfo(d, 1)!.state === "finished")).toBe(true);
    const after = jobLog(d, 1, 100000).length; await sleep(500);
    expect(jobLog(d, 1, 100000).length).toBe(after);
  } finally { server.stop(true); }
}, 60000);
