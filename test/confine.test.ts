// --confine: the plan and its words (every system), then the REAL thing on Linux (bubblewrap) and Mac (sandbox-exec).
// With SYOK_REQUIRE_CONFINE=1 (set in CI) a missing or non-working tool is a failure, not a skip.
import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { planConfine, confineArgv, macProfile, probeConfine, setConfine, getConfine, confineHint, describeConfine, type Confine } from "../src/confine.ts";
import { spawnCommand, killTree, cleanEnv } from "../src/shell.ts";
import { makeCtx, runTool } from "../src/tools.ts";
import { startJob, jobLog } from "../src/jobs.ts";
import { DEFAULT } from "../src/profiles.ts";

const all = () => true;
test("the plan: Windows is refused, the home folder is refused, key folders are hidden, caches stay writable", () => {
  expect((planConfine({ root: "C:\\p", platform: "win32" }) as any).problem).toContain("not available on Windows");
  expect((planConfine({ root: "/home/me", home: "/home/me", platform: "linux", exists: all, real: (p) => p }) as any).problem).toContain("needs a project folder");
  expect((planConfine({ root: "/", home: "/home/me", platform: "linux", exists: all, real: (p) => p }) as any).problem).toContain("needs a project folder");
  const have = new Set(["/home/me/.ssh", "/home/me/.netrc", "/home/me/.npm", "/home/me/.syok/config.json", "/home/me/p/.git/hooks", "/home/me/p/.syok/settings.json"]);
  const c = planConfine({ root: "/home/me/p", home: "/home/me", platform: "linux", exists: (p) => have.has(p), real: (p) => p }) as Confine;
  expect(c).toEqual({ kind: "bwrap", root: "/home/me/p", network: true, home: "/home/me", write: ["/home/me/.npm"], hide: ["/home/me/.ssh", "/home/me/.syok/config.json", "/home/me/.netrc"], lock: ["/home/me/p/.git/hooks", "/home/me/p/.syok/settings.json"] });
  const m = planConfine({ root: "/Users/me/p", home: "/Users/me", platform: "darwin", network: false, exists: () => false, real: (p) => p, tmp: "/var/folders/x/T" }) as Confine;
  expect(m.kind).toBe("sandbox-exec"); expect(m.network).toBe(false); expect(m.write).toEqual(["/var/folders/x/T", "/private/tmp", "/private/var/tmp"]);
  // a project that IS a key folder, or contains one, is not hidden from itself
  const inside = planConfine({ root: "/home/me/.ssh/proj", home: "/home/me", platform: "linux", exists: all, real: (p) => p }) as Confine; expect(inside.hide).not.toContain("/home/me/.ssh");
});

test("the words for bubblewrap: whole disk read-only, project writable, key folders emptied, key files blanked, network cut only when asked", () => {
  const c: Confine = { kind: "bwrap", root: "/w/p", network: true, home: "/h", write: ["/h/.npm"], hide: ["/h/.ssh", "/h/.netrc"], lock: ["/w/p/.git/hooks"] };
  const w = confineArgv(c, "bash", ["-lc", "echo hi"], "/w/p/sub", (p) => p === "/h/.ssh" || p === "/var/tmp");
  expect(w.exe).toBe("bwrap");
  expect(w.args).toEqual(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--bind", "/w/p", "/w/p", "--bind", "/h/.npm", "/h/.npm", "--ro-bind", "/w/p/.git/hooks", "/w/p/.git/hooks", "--tmpfs", "/h/.ssh", "--ro-bind", "/dev/null", "/h/.netrc", "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--chdir", "/w/p/sub", "--", "bash", "-lc", "echo hi"]);
  expect(confineArgv({ ...c, network: false }, "bash", [], "/w/p", () => false).args).toContain("--unshare-net");
  // the command is never mixed into bwrap's own options
  const evil = confineArgv(c, "bash", ["-lc", "--bind / /"], "/w/p", () => false); expect(evil.args.indexOf("--")).toBeLessThan(evil.args.indexOf("--bind / /"));
});

test("the Mac rule file: writes denied except the project and temp, key folders unreadable, quotes in paths cannot break out", () => {
  const p = macProfile({ kind: "sandbox-exec", root: '/Users/me/my "proj"', network: false, home: "/Users/me", write: ["/private/tmp"], hide: ["/Users/me/.ssh"], lock: ['/Users/me/my "proj"/.git/hooks'] });
  const lines = p.split("\n");
  expect(lines[0]).toBe("(version 1)"); expect(lines[2]).toBe("(deny file-write*)");
  expect(lines[3]).toBe('(allow file-write* (subpath "/Users/me/my \\"proj\\"") (subpath "/private/tmp"))');
  expect(p).toContain('(deny file-write* (subpath "/Users/me/my \\"proj\\"/.git/hooks"))'); expect(p).toContain('(deny file-read* file-write* (subpath "/Users/me/.ssh"))'); expect(lines.at(-1)).toBe("(deny network*)");
  expect(lines.indexOf("(deny file-write*)")).toBeLessThan(lines.findIndex((l) => l.startsWith("(allow file-write* (subpath")));
  expect(macProfile({ kind: "sandbox-exec", root: "/p", network: true, home: "/h", write: [], hide: [], lock: [] })).not.toContain("network");
  const w = confineArgv({ kind: "sandbox-exec", root: "/p", network: true, home: "/h", write: [], hide: [], lock: [] }, "bash", ["-lc", "x"], "/p"); expect(w.exe).toBe("sandbox-exec"); expect(w.args[0]).toBe("-p"); expect(w.args.slice(2)).toEqual(["bash", "-lc", "x"]);
});

test("when the tool is missing or blocked, the reason and the fix are said; it is never treated as working", () => {
  const c: Confine = { kind: "bwrap", root: "/p", network: true, home: "/h", write: [], hide: [], lock: [] };
  expect(probeConfine(c, () => ({ status: 0, stderr: "" }))).toBe("");
  expect(probeConfine(c, () => ({ status: null, stderr: "", error: { code: "ENOENT" } }))).toContain("sudo apt install bubblewrap");
  expect(probeConfine(c, () => ({ status: 1, stderr: "bwrap: setting up uid map: Permission denied" }))).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
  expect(probeConfine(c, () => ({ status: 1, stderr: "something odd" }))).toBe("--confine could not start on this computer: something odd");
  expect(probeConfine({ ...c, kind: "sandbox-exec" }, () => ({ status: null, stderr: "", error: { code: "ENOENT" } }))).toContain("sandbox-exec, which was not found");
  expect(confineHint(c)).toContain("Confinement is ON"); expect(confineHint({ ...c, network: false })).toContain("NO network"); expect(describeConfine(c)).toContain("network on");
});

// ---- the real thing ----
const supported = process.platform === "linux" || process.platform === "darwin";
let base = "", proj = "", fakeHome = "", outside = "", plan: Confine | null = null, why = "";
beforeAll(() => {
  if (!supported) { why = "not Linux or Mac"; return; }
  // Under the real home folder, not the temp folder: the temp folder is writable (Mac) or replaced (Linux) inside the confinement.
  base = realpathSync(mkdtempSync(join(homedir(), ".syok-confine-test-")));
  proj = join(base, "proj"); fakeHome = join(base, "home"); outside = join(base, "outside");
  for (const d of [proj, join(proj, ".git", "hooks"), join(proj, ".syok"), outside, join(fakeHome, ".ssh"), join(fakeHome, ".aws"), join(fakeHome, ".npm")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(fakeHome, ".ssh", "id_rsa"), "TOP-SECRET-SSH-KEY"); writeFileSync(join(fakeHome, ".netrc"), "TOP-SECRET-NETRC"); writeFileSync(join(fakeHome, ".aws", "credentials"), "TOP-SECRET-AWS");
  writeFileSync(join(fakeHome, "notes.txt"), "plain notes"); writeFileSync(join(outside, "keep.txt"), "keep me"); writeFileSync(join(proj, ".syok", "settings.json"), "{}"); writeFileSync(join(proj, ".git", "hooks", "pre-commit.sample"), "sample");
  const p = planConfine({ root: proj, home: fakeHome });
  if ("problem" in p) { why = p.problem; return; }
  why = probeConfine(p); if (!why) plan = p;
});
afterAll(() => { setConfine(null); if (base) rmSync(base, { recursive: true, force: true }); });
afterEach(() => setConfine(null));
const real = (name: string, fn: () => Promise<void> | void, ms = 30000) => test(name, async () => {
  if (!plan) { if (process.env.SYOK_REQUIRE_CONFINE === "1") throw new Error("confinement is required for this run but is not working: " + why); console.log("  (skipped: " + why + ")"); return; }
  await fn();
}, ms);
function run(cmd: string, c: Confine | null = plan, secs = 20): Promise<{ code: number | null; out: string }> {
  setConfine(c);
  return new Promise((res) => { const ch = spawnCommand(cmd, proj, cleanEnv(), ["ignore", "pipe", "pipe"]); let out = ""; ch.stdout!.on("data", (d) => (out += d)); ch.stderr!.on("data", (d) => (out += d)); const t = setTimeout(() => killTree(ch), secs * 1000); ch.on("close", (code) => { clearTimeout(t); res({ code, out }); }); });
}
const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

real("inside the project: writing, reading and running programs work, and the files are really on the disk", async () => {
  const r = await run("echo hello > made.txt && cat made.txt && mkdir -p sub/deep && echo x > sub/deep/f && ls /usr/bin | head -1 && cat /etc/hosts > /dev/null && echo done-ok");
  expect(r.out).toContain("hello"); expect(r.out).toContain("done-ok"); expect(r.code).toBe(0);
  expect(readFileSync(join(proj, "made.txt"), "utf8")).toBe("hello\n"); expect(existsSync(join(proj, "sub", "deep", "f"))).toBe(true);
});
real("outside the project: creating, changing and deleting are all refused, and the disk is unchanged", async () => {
  const a = await run(`echo pwned > ${sq(join(outside, "new.txt"))}; echo "code=$?"`); expect(a.out).toMatch(/code=[1-9]/); expect(existsSync(join(outside, "new.txt"))).toBe(false);
  const b = await run(`echo changed >> ${sq(join(outside, "keep.txt"))}; rm -rf ${sq(outside)}; echo "code=$?"`); expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep me");
  const c = await run(`echo x > ${sq(join(fakeHome, "notes.txt"))}; echo "code=$?"`); expect(c.out).toMatch(/code=[1-9]/); expect(readFileSync(join(fakeHome, "notes.txt"), "utf8")).toBe("plain notes");
  const d = await run(`cat ${sq(join(fakeHome, "notes.txt"))}`); expect(d.out).toContain("plain notes"); // ordinary files outside can still be read
  const e = await run(`touch ${sq(join(homedir(), ".syok-confine-escape-" + process.pid))}; echo "code=$?"`); expect(existsSync(join(homedir(), ".syok-confine-escape-" + process.pid))).toBe(false);
});
real("a link inside the project that points outside does not open a way out", async () => {
  symlinkSync(outside, join(proj, "way-out"));
  const r = await run(`echo pwned > way-out/via-link.txt; echo "code=$?"`); expect(r.out).toMatch(/code=[1-9]/); expect(existsSync(join(outside, "via-link.txt"))).toBe(false);
});
real("key folders and key files cannot be read at all", async () => {
  const r = await run(`cat ${sq(join(fakeHome, ".ssh", "id_rsa"))}; cat ${sq(join(fakeHome, ".netrc"))}; cat ${sq(join(fakeHome, ".aws", "credentials"))}; ls -la ${sq(join(fakeHome, ".ssh"))}; echo end`);
  expect(r.out).toContain("end"); expect(r.out).not.toContain("TOP-SECRET"); expect(r.out).not.toContain("id_rsa\n");
  const un = await run(`cat ${sq(join(fakeHome, ".ssh", "id_rsa"))}`, null); expect(un.out).toContain("TOP-SECRET-SSH-KEY"); // the same command without confinement does read it: the test has teeth
});
real("download caches stay writable; git hooks and the Syok settings can be read but not changed", async () => {
  const a = await run(`echo cached > ${sq(join(fakeHome, ".npm", "c.txt"))} && echo cache-ok`); expect(a.out).toContain("cache-ok"); expect(existsSync(join(fakeHome, ".npm", "c.txt"))).toBe(true);
  const b = await run(`cat .git/hooks/pre-commit.sample; echo evil > .git/hooks/pre-commit; echo "code=$?"; echo '{"allow":["rm"]}' > .syok/settings.json; echo "code2=$?"`);
  expect(b.out).toContain("sample"); expect(b.out).toMatch(/code=[1-9]/); expect(b.out).toMatch(/code2=[1-9]/);
  expect(existsSync(join(proj, ".git", "hooks", "pre-commit"))).toBe(false); expect(readFileSync(join(proj, ".syok", "settings.json"), "utf8")).toBe("{}");
});
real("the temporary folder works inside, for programs that need scratch space", async () => {
  const r = await run('f=$(mktemp) && echo scratch > "$f" && cat "$f" && rm "$f" && echo tmp-ok'); expect(r.out).toContain("scratch"); expect(r.out).toContain("tmp-ok");
});
real("network: on by default, and really cut with the no-network kind", async () => {
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("net-ok") });
  try {
    const cmd = `exec 3<>/dev/tcp/127.0.0.1/${srv.port} && printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3 && cat <&3`;
    const on = await run(cmd); expect(on.out).toContain("net-ok");
    const off = await run(cmd + '; echo "code=$?"', { ...plan!, network: false }); expect(off.out).not.toContain("net-ok"); expect(off.out).toMatch(/code=[1-9]/);
  } finally { srv.stop(true); }
});
real("a confined command that hangs is stopped completely", async () => {
  const mark = "syokconfinesleep" + process.pid;
  const t0 = Date.now(); const r = await run(`bash -c 'exec -a ${mark} sleep 300' & sleep 300`, plan, 2); expect(Date.now() - t0).toBeLessThan(15000);
  await new Promise((x) => setTimeout(x, 1500));
  const ps = Bun.spawnSync(["sh", "-c", `ps ax -o command | grep ${mark} | grep -v grep | wc -l`]); expect(ps.stdout.toString().trim()).toBe("0");
});
real("the AI's run_command tool goes through the confinement, and so does a saved job", async () => {
  setConfine(plan);
  const c = makeCtx(proj, "auto", async () => true, { agents: false }, DEFAULT);
  const out = await runTool(c, "run_command", { command: `echo tool > from-tool.txt; echo pwned > ${sq(join(outside, "tool.txt"))}; echo "code=$?"` });
  expect(out).toMatch(/code=[1-9]/); expect(existsSync(join(proj, "from-tool.txt"))).toBe(true); expect(existsSync(join(outside, "tool.txt"))).toBe(false);
  const before = process.env.SYOK_ENTRY; process.env.SYOK_ENTRY = join(import.meta.dir, "..", "src", "main.ts");
  try {
    const id = startJob(proj, `echo job > from-job.txt; echo pwned > ${sq(join(outside, "job.txt"))}; echo "jobcode=$?"`, 0);
    const t0 = Date.now(); let log = ""; while (Date.now() - t0 < 20000) { log = jobLog(proj, id, 4000); if (/finished|exit code|jobcode=/.test(log) && !/still running/.test(log)) break; await new Promise((x) => setTimeout(x, 300)); }
    expect(log).toMatch(/jobcode=[1-9]/); expect(existsSync(join(proj, "from-job.txt"))).toBe(true); expect(existsSync(join(outside, "job.txt"))).toBe(false);
  } finally { if (before === undefined) delete process.env.SYOK_ENTRY; else process.env.SYOK_ENTRY = before; }
}, 60000);
real("the whole program: syok --confine says what is confined, and refuses to start when the project is the home folder", async () => {
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const ai = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { const b: any = await req.json(); const n = b.messages.filter((m: any) => m.role === "tool").length; const msg = n === 0 ? { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: `echo cli > from-cli.txt; echo pwned > ${sq(join(outside, "cli.txt"))}; echo "code=$?"` }) } }] } : { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "finish", arguments: JSON.stringify({ summary: "done" }) } }] }; return Response.json({ choices: [{ message: msg }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); } });
  const go = (args: string[], cwd: string) => new Promise<{ code: number | null; out: string; err: string }>((res) => { const p = Bun.spawn(["bun", main, ...args], { cwd, env: { ...process.env, HOME: fakeHome, SYOK_BASE_URL: `http://127.0.0.1:${ai.port}`, SYOK_API_KEY: "syk_test" }, stdout: "pipe", stderr: "pipe" }); Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([out, err, code]) => res({ code, out, err })); });
  try {
    const r = await go(["--confine", "--mode", "auto", "--no-checks", "-p", "do it", "--cwd", proj], proj);
    expect(r.err).toContain("Confined with"); expect(r.code).toBe(0); expect(existsSync(join(proj, "from-cli.txt"))).toBe(true); expect(existsSync(join(outside, "cli.txt"))).toBe(false);
    const h = await go(["--confine", "-p", "x", "--cwd", fakeHome], fakeHome); expect(h.code).toBe(2); expect(h.err).toContain("needs a project folder"); expect(existsSync(join(outside, "cli.txt"))).toBe(false);
  } finally { ai.stop(true); }
}, 60000);
test("confinement is off unless switched on", () => { expect(getConfine()).toBeNull(); });
