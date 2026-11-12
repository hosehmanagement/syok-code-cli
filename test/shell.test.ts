import { test, expect } from "bun:test";
import { pickShell, shellArgs, spawnCommand, killTree, shellHint, currentShell, type ShellEnv } from "../src/shell.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const win = (o: { files?: string[]; which?: Record<string, string>; env?: Record<string, string> } = {}): ShellEnv => ({
  platform: "win32",
  env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", ...(o.env || {}) },
  exists: (p) => (o.files || []).includes(p),
  which: (n) => (o.which || {})[n] || "",
});
const GITBASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

test("Windows: Git Bash is used when it is installed", () => {
  const s = pickShell(win({ files: [GITBASH, POWERSHELL] }));
  expect(s.kind).toBe("bash"); expect(s.exe).toBe(GITBASH); expect(s.label).toBe("Git Bash");
});
test("Windows: the WSL launcher in System32 is not mistaken for Git Bash", () => {
  const s = pickShell(win({ files: [POWERSHELL], which: { bash: "C:\\Windows\\System32\\bash.exe" } }));
  expect(s.kind).toBe("powershell"); expect(s.exe).toBe(POWERSHELL);
});
test("Windows: bash found on PATH (not WSL) counts as Git Bash", () => {
  const s = pickShell(win({ which: { bash: "D:\\tools\\git\\usr\\bin\\bash.exe" } }));
  expect(s.kind).toBe("bash"); expect(s.exe).toBe("D:\\tools\\git\\usr\\bin\\bash.exe");
});
test("Windows without Git: PowerShell 7 is preferred, then Windows PowerShell, then cmd", () => {
  expect(pickShell(win({ files: [POWERSHELL], which: { pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" } })).exe).toContain("pwsh.exe");
  expect(pickShell(win({ files: [POWERSHELL] })).kind).toBe("powershell");
  const c = pickShell(win());
  expect(c.kind).toBe("cmd"); expect(c.exe).toBe("C:\\Windows\\System32\\cmd.exe");
});
test("SYOK_SHELL forces a choice when it exists, and falls back when it does not", () => {
  expect(pickShell(win({ files: [GITBASH, POWERSHELL], env: { SYOK_SHELL: "powershell" } })).kind).toBe("powershell");
  expect(pickShell(win({ files: [GITBASH], env: { SYOK_SHELL: "cmd" } })).kind).toBe("cmd");
  expect(pickShell(win({ files: [GITBASH], env: { SYOK_SHELL: "powershell" } })).kind).toBe("bash");
});
test("Linux and Mac use bash; sh only if bash is missing", () => {
  const lin = (which: string, ex = false): ShellEnv => ({ platform: "linux", env: {}, exists: (p) => ex && p === "/bin/bash", which: () => which });
  expect(pickShell(lin("/usr/bin/bash")).exe).toBe("bash");
  expect(pickShell(lin("", true)).kind).toBe("bash");
  expect(pickShell(lin("")).exe).toBe("sh");
});
test("each shell gets the right arguments", () => {
  expect(shellArgs({ kind: "bash", exe: "bash", label: "", hint: "" }, "ls")).toEqual(["-lc", "ls"]);
  expect(shellArgs({ kind: "powershell", exe: "p", label: "", hint: "" }, "dir")).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "dir"]);
  expect(shellArgs({ kind: "cmd", exe: "c", label: "", hint: "" }, "dir")).toEqual(["/d", "/s", "/c", "dir"]);
});
test("the hint tells the AI which shell it has", () => {
  expect(shellHint(pickShell(win())).toLowerCase()).toContain("command prompt");
  expect(shellHint(pickShell(win({ files: [POWERSHELL] })))).toContain("PowerShell");
  expect(shellHint(pickShell(win({ files: [GITBASH] })))).toContain("bash");
});

// These run a real command in the real shell of the machine running the tests (Linux, Mac or Windows).
// The commands use small script files, not node -e "...": Windows PowerShell strips the inner double quotes.
const dir = mkdtempSync(join(tmpdir(), "syok-sh-"));
writeFileSync(join(dir, "five.js"), "console.log(2+3)"); writeFileSync(join(dir, "exit3.js"), "process.exit(3)"); writeFileSync(join(dir, "long.js"), "setTimeout(()=>{},60000)");
const run = (cmd: string, secs = 20) => new Promise<{ out: string; code: number | null }>((res) => {
  const p = spawnCommand(cmd, dir, process.env, ["ignore", "pipe", "pipe"]);
  let out = ""; p.stdout!.on("data", (d) => (out += d)); p.stderr!.on("data", (d) => (out += d));
  const t = setTimeout(() => { killTree(p); }, secs * 1000);
  p.on("close", (code) => { clearTimeout(t); res({ out: out.trim(), code }); });
});
test("real shell: prints output", async () => {
  const r = await run("node five.js");
  expect(r.out).toContain("5"); expect(r.code).toBe(0);
});
test("real shell: passes the exit code back", async () => {
  expect((await run("node exit3.js")).code).toBe(3);
});
test("real shell: stops a command that runs too long", async () => {
  const t0 = Date.now();
  const p = spawnCommand("node long.js", dir, process.env, ["ignore", "pipe", "pipe"]);
  await new Promise((r) => setTimeout(r, 600));
  killTree(p);
  await new Promise((r) => p.on("close", r));
  expect(Date.now() - t0).toBeLessThan(15_000);
});
test("current shell has a label", () => { expect(currentShell().label.length).toBeGreaterThan(0); });
