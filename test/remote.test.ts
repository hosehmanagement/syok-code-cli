// Remote runs, tested end to end against a stand-in "cloud": a folder on this machine that behaves like the remote computer
// (real tar, real shell, real files). The Modal adapter itself is covered by test/remote-modal.test.ts and the live workflow.
import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickFiles, optionProblems, defaultImage, remoteRun, remoteLogs, remoteStop, describeRuns, listRuns, readRun, detachLine, type Provider, type Box, type BoxOptions } from "../src/remote.ts";
import { remoteCommand, parseRunArgs, joinCommand } from "../src/remote-cli.ts";
import { modalHasToken, MODAL_SETUP } from "../src/remote-modal.ts";
import { tmpProject } from "./helpers.ts";

const unix = process.platform !== "win32";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(f: () => boolean | Promise<boolean>, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(100); } return false; }

/** A pretend cloud. Every "remote computer" is a folder; /work and /tmp/syok-* inside commands are pointed into it. */
function fakeCloud(o: { problem?: string | null; failCreate?: string } = {}) {
  const boxes = new Map<string, { dir: string; on: boolean; opts?: BoxOptions; procs: Set<any> }>();
  const log: string[] = [];
  const make = (id: string): Box => {
    const b = boxes.get(id)!; const map = (s: string) => s.split("/work").join(b.dir + "/work").split("/tmp/syok-").join(b.dir + "/tmp-syok-");
    const alive = () => { if (!b.on) throw new Error("sandbox " + id + " is not running"); };
    return {
      id,
      upload: async (local, remote) => { alive(); log.push("upload " + remote); copyFileSync(local, map(remote)); },
      download: async (remote, local) => { alive(); log.push("download " + remote); copyFileSync(map(remote), local); },
      exec: (command, x) => new Promise<number>((res, rej) => {
        try { alive(); } catch (e) { return rej(e); }
        const p = spawn("sh", ["-c", map(command)], { cwd: x.cwd ? map(x.cwd) : b.dir, detached: true });
        b.procs.add(p);
        p.stdout.on("data", (d) => x.onOut?.(String(d))); p.stderr.on("data", (d) => x.onErr?.(String(d)));
        p.on("exit", (c) => { b.procs.delete(p); res(c ?? 137); });
      }),
      terminate: async () => { log.push("terminate " + id); b.on = false; spawnSync("pkill", ["-f", b.dir]); for (const p of b.procs) { try { process.kill(-p.pid, "SIGKILL"); } catch {} } },
    };
  };
  const p: Provider = {
    name: "FakeCloud",
    problem: async () => o.problem ?? null,
    create: async (opts) => { if (o.failCreate) throw new Error(o.failCreate); const id = "sb-" + (boxes.size + 1); boxes.set(id, { dir: mkdtempSync(join(tmpdir(), "fakebox-")), on: true, opts, procs: new Set() }); log.push("create " + id); return make(id); },
    attach: async (id) => { const b = boxes.get(id); if (!b || !b.on) throw new Error("sandbox " + id + " not found"); return make(id); },
    close: () => { log.push("close"); },
  };
  return { p, boxes, log };
}
const io = () => { const s = { log: [] as string[], out: "", err: "" }; return { s, io: { log: (x: string) => s.log.push(x), out: (x: string) => (s.out += x), err: (x: string) => (s.err += x) } }; };

test("what gets sent: project files only, never secrets, dependency folders, git history or links", () => {
  const d = tmpProject({ "train.py": "print(1)", "data/a.csv": "1,2", ".env": "KEY=1", ".env.local": "K=2", "certs/server.pem": "x", "node_modules/x/index.js": "x", ".venv/lib.py": "x", ".syok/jobs/1/out.log": "x", "big.bin": "x".repeat(2000), ".github/workflows/ci.yml": "on: push" });
  if (unix) symlinkSync("/etc/passwd", join(d, "link-out"));
  const p = pickFiles(d, { maxFile: 1000 });
  expect(p.files.sort()).toEqual([".github/workflows/ci.yml", "data/a.csv", "train.py"]);
  expect(p.skippedSecrets.sort()).toEqual([".env", ".env.local", "certs/server.pem"]);
  expect(p.skippedBig).toEqual(["big.bin"]);
  expect(p.bytes).toBe(8 + 3 + 8);
});

test.if(unix)("in a git project, .gitignore is respected and new unignored files are included", () => {
  const d = tmpProject({ "a.py": "1", "out/model.bin": "big", ".gitignore": "out/\n", "new.txt": "n", ".env": "S=1" });
  const g = (...a: string[]) => spawnSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  g("init", "-q"); g("add", "a.py", ".gitignore"); g("commit", "-qm", "x");
  const p = pickFiles(d);
  expect(p.files.sort()).toEqual([".gitignore", "a.py", "new.txt"]); expect(p.skippedSecrets).toEqual([".env"]);
});

test("options are checked before anything is rented", () => {
  const root = tmpProject({});
  const bad = (o: any, why: RegExp) => expect(optionProblems({ root, command: "echo hi", ...o }).join("|")).toMatch(why);
  expect(optionProblems({ root, command: "python train.py", gpu: "T4", image: "ghcr.io/org/img:1.2@sha256:abc", timeoutMin: 1440, out: "results/run1" })).toEqual([]);
  bad({ command: "  " }, /after "--"/); bad({ command: "sudo rm -rf /" }, /blocked/);
  bad({ timeoutMin: 0 }, /1 to 1440/); bad({ timeoutMin: 2000 }, /1 to 1440/);
  bad({ image: "bad image;rm" }, /--image/); bad({ gpu: "T4; curl x" }, /--gpu/);
  for (const out of ["../x", "/etc", "a/../../b", "C:\\x", ".", ""]) bad({ out }, /--out/);
  expect(defaultImage(tmpProject({ "package.json": "{}" }))).toBe("node:22-slim");
  expect(defaultImage(tmpProject({ "package.json": "{}", "requirements.txt": "x" }))).toBe("python:3.12-slim");
  expect(defaultImage(tmpProject({}))).toBe("python:3.12-slim");
});

test("command line words: options before --, the command after it, quoted again when needed", () => {
  const a = parseRunArgs(["--on", "modal", "--gpu", "T4", "--detach", "--", "python", "train.py", "--epochs", "3", "two words", "it's"]);
  expect(a.flags).toEqual({ "--on": "modal", "--gpu": "T4" }); expect(a.bools.has("--detach")).toBe(true);
  expect(a.command).toBe("python train.py --epochs 3 'two words' 'it'\\''s'");
  expect(joinCommand(["python train.py && echo done"])).toBe("python train.py && echo done"); // one already-quoted line is kept as typed
  expect(parseRunArgs(["--on"]).error).toMatch(/needs a value/); expect(parseRunArgs(["--bogus", "--", "x"]).error).toMatch(/Unknown option/);
});

test.if(unix)("a run: files arrive, the command runs there, output streams back, results come home, the computer is switched off", async () => {
  const d = tmpProject({ "job.sh": "echo start; cat data/in.txt; echo warn >&2; mkdir -p results/sub; echo trained > results/model.txt; echo x > results/sub/m.txt; echo secret-should-stay > /dev/null; exit 0", "data/in.txt": "INPUT-123\n", ".env": "TOKEN=abc" });
  const c = fakeCloud(); const x = io();
  const r = await remoteRun(c.p, { root: d, command: "sh job.sh && echo $((6*7))", out: "results", gpu: "T4", timeoutMin: 5 }, x.io);
  expect(r.exitCode).toBe(0); expect(x.s.out).toBe("start\nINPUT-123\n42\n"); expect(x.s.err).toBe("warn\n");
  expect(readFileSync(join(d, "results/model.txt"), "utf8")).toBe("trained\n"); expect(readFileSync(join(d, "results/sub/m.txt"), "utf8")).toBe("x\n"); expect(r.downloaded).toBe(2);
  const b = [...c.boxes.values()][0];
  expect(b.opts).toEqual({ image: "python:3.12-slim", gpu: "T4", cpu: undefined, memoryMiB: undefined, timeoutMs: 300000 });
  expect(existsSync(join(b.dir, "work/.env"))).toBe(false); // the secret file never left this computer
  expect(b.on).toBe(false); expect(c.log.at(-1)).toBe("terminate sb-1");
  expect(x.s.log.join("\n")).toMatch(/Not sent \(secret files stay on your computer\): \.env/); expect(x.s.log.join("\n")).toMatch(/bills your own account/); expect(x.s.log.join("\n")).toMatch(/switched off after \d+ seconds/);
});

test.if(unix)("a failing command gives its exit code, and the computer is still switched off; so it is when sending fails", async () => {
  const d = tmpProject({ "a.txt": "1" });
  const c = fakeCloud(); const x = io();
  const r = await remoteRun(c.p, { root: d, command: "echo before; exit 7", out: "nothing-made" }, x.io);
  expect(r.exitCode).toBe(7); expect(x.s.out).toBe("before\n"); expect([...c.boxes.values()][0].on).toBe(false);
  expect(x.s.log.join("\n")).toMatch(/did not create the folder "nothing-made"/);
  // The remote side cannot unpack (no work folder is writable): the run fails, and the computer is not left on.
  const c2 = fakeCloud(); const orig = c2.p.create;
  c2.p.create = async (o) => { const b = await orig(o); return { ...b, upload: async () => { throw new Error("network broke"); } }; };
  await expect(remoteRun(c2.p, { root: d, command: "echo hi" }, io().io)).rejects.toThrow(/network broke/);
  expect([...c2.boxes.values()][0].on).toBe(false);
});

test("nothing is rented when the cloud account is not set up, the options are wrong or the project is too big", async () => {
  const d = tmpProject({ "a.txt": "1" });
  const c = fakeCloud({ problem: "Connect your account first." });
  await expect(remoteRun(c.p, { root: d, command: "echo hi" }, io().io)).rejects.toThrow("Connect your account first.");
  const c2 = fakeCloud();
  await expect(remoteRun(c2.p, { root: d, command: "echo hi", out: "../escape" }, io().io)).rejects.toThrow(/--out/);
  expect(c.boxes.size + c2.boxes.size).toBe(0);
  expect(MODAL_SETUP).toMatch(/MODAL_TOKEN_ID/); expect(MODAL_SETUP).toMatch(/never to Syok/);
  expect(modalHasToken({ MODAL_TOKEN_ID: "ak-1", MODAL_TOKEN_SECRET: "as-1" }, "/nonexistent")).toBe(true);
  expect(modalHasToken({ MODAL_TOKEN_ID: "ak-1" }, "/nonexistent")).toBe(false); expect(modalHasToken({}, "/nonexistent")).toBe(false);
});

test.if(unix)("results that try to land outside the chosen folder, or to overwrite a secret file, are refused", async () => {
  const d = tmpProject({ "a.txt": "1", ".env": "REAL=1" });
  const c = fakeCloud(); const x = io();
  // The remote "results" folder contains an .env file: unpacking it would overwrite a local secret file.
  const r = await remoteRun(c.p, { root: d, command: "mkdir -p results && echo HACK=1 > results/.env && echo ok > results/fine.txt", out: "results" }, x.io);
  expect(r.note).toMatch(/not allowed/); expect(existsSync(join(d, "results/fine.txt"))).toBe(false); expect(readFileSync(join(d, ".env"), "utf8")).toBe("REAL=1");
});

test.if(unix)("detached run: keeps going after the program leaves, logs can be read later, stop brings results back and switches it off", async () => {
  const d = tmpProject({ "tick.sh": "i=0; mkdir -p results; while [ $i -lt 4 ]; do i=$((i+1)); echo tick $i; echo $i > results/last.txt; sleep 0.3; done; exit 3" });
  const c = fakeCloud(); const x = io();
  const r = await remoteRun(c.p, { root: d, command: "sh tick.sh", detach: true, out: "results", timeoutMin: 30 }, x.io);
  expect(r.detached).toBe(1); const b = [...c.boxes.values()][0]; expect(b.on).toBe(true); expect(c.log).not.toContain("terminate sb-1");
  expect(readRun(d, 1)).toMatchObject({ provider: "FakeCloud", boxId: "sb-1", command: "sh tick.sh", timeoutMin: 30, out: "results" });
  expect(describeRuns(d)).toMatch(/1: sh tick\.sh  \[FakeCloud\] on for 0 min of at most 30 \(billing\)/);
  const l1 = io(); const s1 = await remoteLogs(c.p, d, 1, l1.io);
  expect(s1.finished).toBe(false); expect(l1.s.log.join("")).toMatch(/still running/);
  expect(await waitFor(async () => { const l = io(); return (await remoteLogs(c.p, d, 1, l.io)).finished; })).toBe(true);
  const l2 = io(); const s2 = await remoteLogs(c.p, d, 1, l2.io, { tail: 2 });
  expect(s2).toEqual({ finished: true, exitCode: 3 }); expect(l2.s.out).toBe("tick 3\ntick 4\n"); expect(l2.s.log.join("")).toMatch(/still on until you run: syok remote stop 1/);
  const st = io(); const stopped = await remoteStop(c.p, d, 1, st.io);
  expect(stopped).toEqual({ exitCode: 3, downloaded: 1 }); expect(readFileSync(join(d, "results/last.txt"), "utf8")).toBe("4\n"); expect(b.on).toBe(false);
  expect(readRun(d, 1)!.exitCode).toBe(3); expect(describeRuns(d)).toMatch(/stopped, exit code 3/);
  expect((await remoteStop(c.p, d, 1, io().io)).exitCode).toBe(3); // stopping twice is harmless
  await expect(remoteLogs(c.p, d, 1, io().io)).rejects.toThrow(/was stopped/);
  await expect(remoteLogs(c.p, d, 9, io().io)).rejects.toThrow(/no remote run 9/);
});

test.if(unix)("stopping a detached run that is still working kills it; a computer that is already gone is marked stopped", async () => {
  const d = tmpProject({ "a.txt": "1" });
  const c = fakeCloud();
  await remoteRun(c.p, { root: d, command: "while true; do echo alive; sleep 0.2; done", detach: true }, io().io);
  const st = io(); expect((await remoteStop(c.p, d, 1, st.io)).exitCode).toBe(null);
  expect(st.s.log.join("\n")).toMatch(/still running; it is being stopped/); expect([...c.boxes.values()][0].on).toBe(false);
  await remoteRun(c.p, { root: d, command: "sleep 30", detach: true }, io().io);
  [...c.boxes.values()][1].on = false; // the cloud switched it off by itself (time limit)
  const gone = io(); expect((await remoteStop(c.p, d, 2, gone.io)).exitCode).toBe(null);
  expect(gone.s.log.join("\n")).toMatch(/could not be reached/); expect(listRuns(d).every((x) => x.r.stopped)).toBe(true);
  expect(detachLine("echo 'a b'")).toContain("setsid nohup");
});

test.if(unix)("command line: syok run / syok remote give the right exit codes and messages", async () => {
  const d = tmpProject({ "a.txt": "1" });
  const c = fakeCloud(); const lines: string[] = []; let outS = "", errS = "";
  const deps = { provider: (n: string) => (n === "modal" ? c.p : null), out: (s: string) => (outS += s), err: (s: string) => (errS += s), log: (s: string) => lines.push(s), onSignal: () => {} };
  expect(await remoteCommand(["run", "--on", "modal", "--cwd", d, "--", "echo", "hello world"], deps)).toBe(0); expect(outS).toBe("hello world\n"); expect(lines.join("\n")).toMatch(/Exit code 0\./);
  expect(await remoteCommand(["run", "--on", "modal", "--cwd", d, "--", "exit 5"], deps)).toBe(5);
  errS = ""; expect(await remoteCommand(["run", "--cwd", d, "--", "echo x"], deps)).toBe(2); expect(errS).toMatch(/Say where to run it/);
  errS = ""; expect(await remoteCommand(["run", "--on", "mars", "--cwd", d, "--", "echo x"], deps)).toBe(2); expect(errS).toMatch(/Available: modal/);
  errS = ""; expect(await remoteCommand(["run", "--on", "modal", "--cwd", d, "echo", "x"], deps)).toBe(2); expect(errS).toMatch(/Put the command after "--"/);
  errS = ""; expect(await remoteCommand(["run", "--on", "modal", "--timeout", "abc", "--cwd", d, "--", "echo x"], deps)).toBe(2); expect(errS).toMatch(/--timeout must be a number/);
  errS = ""; expect(await remoteCommand(["run", "--on", "modal", "--cwd", d, "--"], deps)).toBe(1); expect(errS).toMatch(/after "--"/);
  const before = c.boxes.size;
  lines.length = 0; expect(await remoteCommand(["remote", "--cwd", d], deps)).toBe(0); expect(lines.join("\n")).toMatch(/No remote runs/);
  expect(await remoteCommand(["run", "--on", "modal", "--detach", "--cwd", d, "--", "echo bg; sleep 5"], deps)).toBe(0); expect(c.boxes.size).toBe(before + 1);
  outS = ""; expect(await waitFor(async () => { outS = ""; await remoteCommand(["remote", "logs", "1", "--cwd", d], deps); return outS.includes("bg"); })).toBe(true);
  expect(await remoteCommand(["remote", "stop", "1", "--cwd", d], deps)).toBe(0); expect([...c.boxes.values()].every((b) => !b.on)).toBe(true);
  errS = ""; expect(await remoteCommand(["remote", "logs", "--cwd", d], deps)).toBe(2); expect(await remoteCommand(["remote", "stop", "7", "--cwd", d], deps)).toBe(1);
  expect(c.log.filter((x) => x === "close").length).toBeGreaterThanOrEqual(5); // connections are always closed so the program can exit
});

test.if(unix)("Ctrl+C during a run switches the rented computer off", async () => {
  const d = tmpProject({ "a.txt": "1" });
  const c = fakeCloud(); let stop: () => Promise<void> = async () => {}; let outS = "";
  const run = remoteCommand(["run", "--on", "modal", "--cwd", d, "--", "echo going; sleep 30"], { provider: () => c.p, out: (s) => (outS += s), err: () => {}, log: () => {}, onSignal: (s) => { stop = s; } });
  expect(await waitFor(() => outS.includes("going"))).toBe(true);
  await stop();
  expect(await run).not.toBe(0); expect([...c.boxes.values()][0].on).toBe(false);
});
