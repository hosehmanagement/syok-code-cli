// The Codespace provider against a stand-in for GitHub's command-line tool that really runs the commands and copies the files
// on this machine (so quoting, folders, streaming and cleanup are exercised for real). What it cannot prove is that the real
// "gh codespace ssh/cp" accept the same words: that is the job of the live workflow (codespace-live.yml).
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { codespaceProvider, parseCodespaces, cleanupLine, CODESPACE_SETUP, type GhRun } from "../src/remote-codespace.ts";
import { remoteRun, remoteLogs, remoteStop, describeRuns, readRun } from "../src/remote.ts";
import { remoteCommand } from "../src/remote-cli.ts";
import { tmpProject } from "./helpers.ts";

const linux = process.platform === "linux";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(f: () => boolean | Promise<boolean>, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(150); } return false; }
const io = () => { const s = { log: [] as string[], out: "", err: "" }; return { s, io: { log: (x: string) => s.log.push(x), out: (x: string) => (s.out += x), err: (x: string) => (s.err += x) } }; };

function fakeGh(o: { list?: any[]; listFail?: string; noGh?: boolean; sshFail?: boolean } = {}) {
  const calls: string[][] = [];
  const gh: GhRun = (args, x = {}) => new Promise((res) => {
    calls.push(args);
    if (o.noGh) return res({ code: 127, out: "", err: "spawn gh ENOENT" });
    if (args[0] === "--version") return res({ code: 0, out: "gh version 2.60.0", err: "" });
    if (args[0] === "codespace" && args[1] === "list") return res(o.listFail ? { code: 1, out: "", err: o.listFail } : { code: 0, out: JSON.stringify(o.list ?? [{ name: "my-space-abc123", state: "Available", repository: "me/app" }]), err: "" });
    if (args[0] === "codespace" && args[1] === "ssh") {
      if (o.sshFail) return res({ code: 255, out: "", err: "error connecting to codespace" });
      if (args[2] !== "-c" || args[4] !== "--" || args.length !== 6) return res({ code: 2, out: "", err: "bad ssh arguments: " + JSON.stringify(args) });
      const p = spawn("sh", ["-c", args[5]], { cwd: "/", detached: true }); let out = "", err = "";
      p.stdout.on("data", (d) => { out += d; x.onOut?.(String(d)); }); p.stderr.on("data", (d) => { err += d; x.onErr?.(String(d)); });
      const t = x.timeoutMs ? setTimeout(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch {} }, x.timeoutMs) : null;
      p.on("close", (c, sig) => { if (t) clearTimeout(t); res({ code: sig ? 124 : c ?? 1, out, err }); });
      return;
    }
    if (args[0] === "codespace" && args[1] === "cp") {
      if (args[2] !== "-e" || args[3] !== "-c" || args.length !== 7) return res({ code: 2, out: "", err: "bad cp arguments" });
      const strip = (s: string) => s.replace(/^remote:/, "");
      if (args[5].startsWith("remote:") === args[6].startsWith("remote:")) return res({ code: 2, out: "", err: "exactly one side must be remote" });
      try { copyFileSync(strip(args[5]), strip(args[6])); return res({ code: 0, out: "", err: "" }); } catch (e: any) { return res({ code: 1, out: "", err: String(e.message) }); }
    }
    res({ code: 2, out: "", err: "unknown gh command" });
  });
  return { gh, calls };
}

test("setup problems are explained before anything runs: no gh, not signed in, none, several, wrong name", async () => {
  expect(await codespaceProvider({ gh: fakeGh({ noGh: true }).gh }).problem()).toBe(CODESPACE_SETUP);
  expect(await codespaceProvider({ gh: fakeGh({ listFail: "error: missing required scope 'codespace'" }).gh }).problem()).toContain("gh auth refresh -h github.com -s codespace");
  expect(await codespaceProvider({ gh: fakeGh({ listFail: "boom" }).gh }).problem()).toBe("Could not list your Codespaces: boom");
  expect(await codespaceProvider({ gh: fakeGh({ list: [] }).gh }).problem()).toMatch(/no Codespace yet/);
  const two = [{ name: "one-aaa", state: "Available", repository: "me/a" }, { name: "two-bbb", state: "Shutdown", repository: "me/b" }];
  const several = await codespaceProvider({ gh: fakeGh({ list: two }).gh }).problem();
  expect(several).toContain("--codespace <name>"); expect(several).toContain("one-aaa   (me/a, Available)"); expect(several).toContain("two-bbb   (me/b, Shutdown)");
  expect(await codespaceProvider({ name: "two-bbb", gh: fakeGh({ list: two }).gh }).problem()).toBeNull();
  expect(await codespaceProvider({ name: "nope", gh: fakeGh({ list: two }).gh }).problem()).toBe('You have no Codespace named "nope". Yours: one-aaa, two-bbb');
  expect(await codespaceProvider({ name: "bad name; rm -rf /", gh: fakeGh().gh }).problem()).toMatch(/not a Codespace name/);
  expect(await codespaceProvider({ gh: fakeGh().gh }).problem()).toBeNull();
  expect(parseCodespaces("not json")).toEqual([]); expect(parseCodespaces('[{"name":"ok-1"},{"name":"bad name"},{}]').map((c) => c.name)).toEqual(["ok-1"]);
});

test.if(linux)("a run on the Codespace: files arrive in a folder of their own, output streams, results come home, the folder is removed", async () => {
  const d = tmpProject({ "job.sh": "echo start; cat data/in.txt; echo warn >&2; mkdir -p results; echo made > results/out.txt; pwd; if [ -f .env ]; then echo env-present; else echo env-absent; fi", "data/in.txt": "IN-9\n", ".env": "S=1" });
  const g = fakeGh(); const p = codespaceProvider({ gh: g.gh, id: () => "testrun001" }); const x = io();
  const r = await remoteRun(p, { root: d, command: "sh job.sh && echo 'it''s done'", out: "results", timeoutMin: 5 }, x.io);
  expect(r.exitCode).toBe(0); expect(x.s.out).toBe("start\nIN-9\n/tmp/syok-runs/testrun001\nenv-absent\nits done\n"); expect(x.s.err).toBe("warn\n");
  expect(readFileSync(join(d, "results/out.txt"), "utf8")).toBe("made\n");
  expect(existsSync("/tmp/syok-runs/testrun001")).toBe(false); expect(readdirSync("/tmp/syok-runs").filter((f) => f.startsWith("testrun001"))).toEqual([]);
  expect(x.s.log[0]).toBe("Using your Codespace my-space-abc123 (time limit 5 minutes). It uses your own GitHub Codespaces allowance while it is on.");
  expect(x.s.log.at(-1)).toMatch(/Finished after \d+ seconds; this run's folder on the Codespace was removed\. The Codespace itself stays on .* gh codespace stop -c my-space-abc123/);
  // Every call went to the chosen Codespace, with the command line as one word.
  for (const c of g.calls.filter((c) => c[1] === "ssh")) { expect(c.slice(0, 5)).toEqual(["codespace", "ssh", "-c", "my-space-abc123", "--"]); expect(c.length).toBe(6); }
  expect(g.calls.filter((c) => c[1] === "cp").map((c) => [c[5].startsWith("remote:"), c[6].startsWith("remote:")])).toEqual([[false, true], [true, false]]);
});

test("options a Codespace cannot honour are refused; an unreachable Codespace is explained", async () => {
  const d = tmpProject({ "a.txt": "1" });
  const g = fakeGh();
  await expect(remoteRun(codespaceProvider({ gh: g.gh }), { root: d, command: "echo hi", gpu: "T4", image: "python:3.12" }, io().io)).rejects.toThrow("--gpu and --image cannot be used with Codespace");
  expect(g.calls.length).toBe(0);
  await expect(remoteRun(codespaceProvider({ gh: fakeGh({ sshFail: true }).gh }), { root: d, command: "echo hi" }, io().io)).rejects.toThrow(/Could not reach the Codespace "my-space-abc123".*sshd/);
});

test.if(linux)("a failing command keeps its exit code, and a command over its time limit is stopped", async () => {
  const d = tmpProject({ "a.txt": "1" });
  expect((await remoteRun(codespaceProvider({ gh: fakeGh().gh }), { root: d, command: "exit 6" }, io().io)).exitCode).toBe(6);
  const p = codespaceProvider({ gh: fakeGh().gh, id: () => "timelimit1" }); expect(await p.problem()).toBeNull();
  const b = await p.create({ image: "", timeoutMs: 60000 });
  const t0 = Date.now(); let out = "";
  expect(await b.exec("echo begun; while true; do echo x >> still-running.txt; sleep 0.1; done", { cwd: b.work, timeoutMs: 600, onOut: (s) => (out += s) })).toBe(124);
  expect(Date.now() - t0).toBeLessThan(5000); expect(out).toBe("begun\n");
  await b.terminate(); await sleep(400); expect(existsSync("/tmp/syok-runs/timelimit1")).toBe(false);
});

test.if(linux)("detached run on the Codespace: survives, logs later, stop kills what is still running and removes the folder", async () => {
  const d = tmpProject({ "tick.sh": "i=0; mkdir -p results; while [ $i -lt 4 ]; do i=$((i+1)); echo tick $i; echo $i > results/last.txt; sleep 0.3; done; exit 3", "forever.sh": "while true; do echo alive >> alive.txt; sleep 0.2; done" });
  const g = fakeGh(); let n = 0; const p = codespaceProvider({ gh: g.gh, id: () => "detached0" + ++n });
  const x = io(); const r = await remoteRun(p, { root: d, command: "sh tick.sh", detach: true, out: "results", timeoutMin: 10 }, x.io);
  expect(r.detached).toBe(1); expect(readRun(d, 1)).toMatchObject({ provider: "Codespace", boxId: "my-space-abc123:/tmp/syok-runs/detached01" });
  expect(x.s.log.join("\n")).toContain("IMPORTANT: GitHub stops a Codespace after its idle time");
  expect(existsSync("/tmp/syok-runs/detached01/tick.sh")).toBe(true);
  expect(await waitFor(async () => (await remoteLogs(p, d, 1, io().io)).finished)).toBe(true);
  const l = io(); expect(await remoteLogs(p, d, 1, l.io, { tail: 1 })).toEqual({ finished: true, exitCode: 3 }); expect(l.s.out).toBe("tick 4\n");
  const st = io(); expect(await remoteStop(p, d, 1, st.io)).toEqual({ exitCode: 3, downloaded: 1 });
  expect(readFileSync(join(d, "results/last.txt"), "utf8")).toBe("4\n"); expect(existsSync("/tmp/syok-runs/detached01")).toBe(false);
  expect(st.s.log.at(-1)).toBe("Remote run 1: stopped and its folder on the Codespace removed (the command had finished with exit code 3). The Codespace itself was left as it is.");
  expect(describeRuns(d)).toMatch(/\[Codespace\] stopped, exit code 3/);
  // A job that never ends: stop must really kill it (it writes into its folder; after stop nothing may write any more).
  await remoteRun(p, { root: d, command: "sh forever.sh", detach: true }, io().io);
  expect(await waitFor(() => existsSync("/tmp/syok-runs/detached02/alive.txt"))).toBe(true);
  expect((await remoteStop(p, d, 2, io().io)).exitCode).toBe(null);
  await sleep(700); expect(existsSync("/tmp/syok-runs/detached02")).toBe(false); // gone and not re-created by a surviving process
  await expect(remoteLogs(p, d, 2, io().io)).rejects.toThrow(/was stopped/);
});

test("cleanup never reaches outside the run's own folder", () => {
  const line = cleanupLine("/tmp/syok-runs/abcdef12");
  expect(line).toContain("rm -rf -- '/tmp/syok-runs/abcdef12' '/tmp/syok-runs/abcdef12.tmp-project.tgz' '/tmp/syok-runs/abcdef12.tmp-out.tgz'");
  expect(line).toContain("'/tmp/syok-runs/abcdef12'|'/tmp/syok-runs/abcdef12'/*)");
});

test.if(linux)("command line: codespace is offered only when switched on, and logs/stop go to the cloud the run was started on", async () => {
  const d = tmpProject({ "a.txt": "1" }); let errS = "", outS = ""; const lines: string[] = [];
  const old = process.env.SYOK_EXPERIMENTAL; delete process.env.SYOK_EXPERIMENTAL;
  try {
    expect(await remoteCommand(["run", "--on", "codespace", "--cwd", d, "--", "echo hi"], { err: (s) => (errS += s), out: () => {}, log: () => {} })).toBe(2);
    expect(errS).toContain('"codespace" is not a place Syok Code can run jobs yet. Available: modal');
  } finally { if (old !== undefined) process.env.SYOK_EXPERIMENTAL = old; }
  const g = fakeGh(); const cs = codespaceProvider({ gh: g.gh, id: () => "clirun0001" }); const asked: string[] = [];
  const deps = { provider: (n: string) => { asked.push(n); return n === "codespace" ? cs : null; }, out: (s: string) => (outS += s), err: (s: string) => (errS += s), log: (s: string) => lines.push(s), onSignal: () => {} };
  expect(await remoteCommand(["run", "--on", "codespace", "--detach", "--cwd", d, "--", "echo from-cs; sleep 3"], deps)).toBe(0);
  expect(await waitFor(async () => { outS = ""; await remoteCommand(["remote", "logs", "1", "--cwd", d], deps); return outS.includes("from-cs"); })).toBe(true);
  expect(await remoteCommand(["remote", "stop", "1", "--cwd", d], deps)).toBe(0);
  expect(asked.every((n) => n === "codespace")).toBe(true); expect(existsSync("/tmp/syok-runs/clirun0001")).toBe(false);
});
