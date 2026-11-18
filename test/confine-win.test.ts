// Confinement on Windows itself: write protection through integrity levels. The plan and the command lines are checked
// everywhere; the real thing is checked on Windows (the "windows" job runs it for real).
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { planWindows, prepareWindows, winSpawn, undoWindows, markedFolders, type WinPlan } from "../src/confine-win.ts";
import { planConfine, setConfine, describeConfine, confineHint } from "../src/confine.ts";
import { spawnCommand, pickShell, realEnv, type Shell } from "../src/shell.ts";
import { call } from "./helpers.ts";

const H = "C:\\Users\\me";
test("the plan: where things go, and what is refused", () => {
  const c = planWindows({ root: "D:\\work\\proj", home: H }) as WinPlan;
  expect(c.kind).toBe("windows-low"); expect(c.root).toBe("D:\\work\\proj"); expect(c.low.cmd).toBe("C:\\Users\\me\\.syok\\low\\cmd.exe");
  expect(c.low.tmp).toBe("C:\\Users\\me\\AppData\\LocalLow\\SyokCode\\tmp"); expect(c.low.env.TEMP).toBe(c.low.tmp); expect(c.low.env.TMP).toBe(c.low.tmp);
  expect(c.low.env.npm_config_cache).toBe("C:\\Users\\me\\AppData\\LocalLow\\SyokCode\\npm-cache"); expect(c.low.env.BUN_INSTALL_CACHE_DIR).toContain("bun-cache"); expect(c.low.env.PIP_CACHE_DIR).toContain("pip-cache");
  expect((planWindows({ root: "D:\\work\\proj", home: H, network: false }) as any).problem).toContain("not available on Windows itself");
  expect((planWindows({ root: "C:\\Users\\me", home: H }) as any).problem).toContain("needs a project folder"); expect((planWindows({ root: "c:\\users\\ME\\", home: H }) as any).problem).toContain("needs a project folder");
  expect((planWindows({ root: "D:\\", home: H }) as any).problem).toContain("needs a project folder");
  expect((planWindows({ root: "D:\\50% done", home: H }) as any).problem).toContain("special meaning"); expect((planWindows({ root: "D:\\a&b", home: H }) as any).problem).toContain("special meaning");
  expect((planWindows({ root: "D:\\ok", home: "C:\\Users\\R&D" }) as any).problem).toContain("special meaning");
  expect((planWindows({ root: "D:\\my project (v2)", home: "C:\\Users\\Jim Lau" }) as any).kind).toBe("windows-low"); // spaces and brackets are fine
  expect((planConfine({ root: "D:\\work\\proj", home: H, platform: "win32" }) as any).low.cmd).toBe(c.low.cmd);
  expect(describeConfine(c as any)).toContain("can still READ other files"); expect(describeConfine(c as any)).toContain("syok confine undo"); expect(confineHint(c as any)).toContain("Access is denied");
});

test("the command line for each shell: nothing of the AI's command is handed to the Command Prompt except in Command Prompt itself", () => {
  const c = planWindows({ root: "D:\\work\\proj", home: H }) as WinPlan; const files: Record<string, string> = {}; const w = (p: string, t: string) => { files[p] = t; };
  const nasty = `echo "a & b" | findstr %PATH% ^ > out.txt; $x = 'q"q'`;
  const cmd = winSpawn(c, { kind: "cmd", exe: "C:\\Windows\\System32\\cmd.exe" } as Shell, nasty, "", w);
  expect(cmd.exe).toBe(c.low.cmd); expect(cmd.args).toEqual(["/d", "/s", "/c", nasty]); expect(Object.keys(files).length).toBe(0);
  const ps = winSpawn(c, { kind: "powershell", exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" } as Shell, nasty, "\nexit 0", w);
  const psFile = Object.keys(files)[0]; expect(psFile).toMatch(/LocalLow\\SyokCode\\tmp\\cmd-[0-9a-f]{16}\.ps1$/); expect(files[psFile]).toBe("\ufeff" + nasty + "\nexit 0");
  expect(ps.exe).toBe(c.low.cmd); expect(ps.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(ps.args[3]).toBe(`""C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "Invoke-Expression ([IO.File]::ReadAllText('${psFile}'))""`);
  expect(ps.args[3]).not.toContain("findstr"); expect(ps.args[3]).not.toContain("%PATH%");
  const sh = winSpawn(c, { kind: "bash", exe: "C:\\Program Files\\Git\\bin\\bash.exe" } as Shell, nasty, "", w);
  const shFile = Object.keys(files)[1]; expect(shFile).toMatch(/cmd-[0-9a-f]{16}\.sh$/); expect(files[shFile]).toBe(nasty + "\n");
  expect(sh.args[3]).toBe(`""C:\\Program Files\\Git\\bin\\bash.exe" -l "${shFile}""`); expect(sh.args[3]).not.toContain("findstr");
  const apostrophe = winSpawn(planWindows({ root: "D:\\p", home: "C:\\Users\\O'Brien" }) as WinPlan, { kind: "powershell", exe: "ps.exe" } as Shell, "x", "", w);
  expect(apostrophe.args[3]).toContain("O''Brien"); // a quote in the folder name cannot end the text early
});

// ---- the real thing, on Windows ----
const win = process.platform === "win32";
let base = "", proj = "", outside = "", plan: WinPlan | null = null, problem = "";
beforeAll(() => {
  if (!win) return;
  base = mkdtempSync(join(homedir(), "syok-confine-win-test-")); proj = join(base, "proj"); outside = join(base, "outside"); mkdirSync(join(proj, "sub"), { recursive: true }); mkdirSync(outside, { recursive: true });
  writeFileSync(join(proj, "existing.txt"), "old"); writeFileSync(join(proj, "sub", "deep.txt"), "deep"); writeFileSync(join(outside, "keep.txt"), "keep me");
  const p = planWindows({ root: proj, home: homedir() }); if ("problem" in p) { problem = p.problem; return; }
  problem = prepareWindows(p); plan = p;
});
afterAll(() => { setConfine(null); if (win && base) { try { undoWindows(proj, homedir()); } catch {} try { rmSync(base, { recursive: true, force: true }); } catch {} } });
const shells = (): Shell[] => { const out: Shell[] = []; for (const k of ["cmd", "powershell", "bash"]) { try { const s = pickShell({ ...realEnv(), env: { ...process.env, SYOK_SHELL: k } }); if (s.kind === k) out.push(s); } catch {} } return out; };
function run(command: string, sh: Shell, confined = true): Promise<{ code: number | null; out: string }> {
  setConfine(confined ? (plan as any) : null);
  return new Promise((res) => { const p = spawnCommand(command, proj, { ...process.env } as any, ["ignore", "pipe", "pipe"], sh); let out = ""; p.stdout!.on("data", (d) => (out += d)); p.stderr!.on("data", (d) => (out += d)); p.on("close", (code) => res({ code, out })); p.on("error", (e) => res({ code: -1, out: String(e) })); });
}
const onWin = (name: string, fn: () => Promise<void>, ms = 120000) => test.skipIf(!win)(name, fn, ms);

onWin("real: it can be set up on this computer, and the folder is remembered as marked", async () => {
  expect(problem).toBe(""); expect(existsSync(plan!.low.cmd)).toBe(true); expect(markedFolders(homedir()).map((x) => x.toLowerCase())).toContain(proj.toLowerCase());
  expect(shells().map((s) => s.kind)).toContain("cmd"); expect(shells().map((s) => s.kind)).toContain("powershell");
});

onWin("real: in every shell, a confined command works in the project and cannot change anything outside it", async () => {
  for (const sh of shells()) {
    const k = sh.kind; const P = k === "bash" ? proj.replace(/\\/g, "/") : proj, O = k === "bash" ? outside.replace(/\\/g, "/") : outside;
    const write = (dir: string, name: string) => k === "powershell" ? `Set-Content -Path '${dir}\\${name}' -Value 'made-by-${k}'` : k === "bash" ? `echo made-by-${k} > '${dir}/${name}'` : `echo made-by-${k}> "${dir}\\${name}"`;
    const a = await run(write(P, `in-${k}.txt`), sh); expect(readFileSync(join(proj, `in-${k}.txt`), "utf8").trim()).toBe(`made-by-${k}`); expect(a.code).toBe(0);
    const b = await run(write(O, `escape-${k}.txt`), sh); expect(existsSync(join(outside, `escape-${k}.txt`))).toBe(false); expect(b.code).not.toBe(0); expect(b.out).toMatch(/denied/i);
    const del = k === "powershell" ? `Remove-Item -Force '${O}\\keep.txt'` : k === "bash" ? `rm -f '${O}/keep.txt'` : `del /f /q "${O}\\keep.txt"`;
    await run(del, sh); expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep me");
    const change = k === "powershell" ? `Add-Content -Path '${O}\\keep.txt' -Value 'x'` : k === "bash" ? `echo x >> '${O}/keep.txt'` : `echo x>> "${O}\\keep.txt"`;
    await run(change, sh); expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep me");
    const edit = k === "powershell" ? `Set-Content -Path '${P}\\existing.txt' -Value 'new-${k}'` : k === "bash" ? `echo new-${k} > '${P}/existing.txt'` : `echo new-${k}> "${P}\\existing.txt"`;
    await run(edit, sh); expect(readFileSync(join(proj, "existing.txt"), "utf8").trim()).toBe(`new-${k}`); // a file that was there before the folder was marked
    // the same write outside succeeds when NOT confined: the refusal above really came from the confinement
    const free = await run(write(O, `free-${k}.txt`), sh, false); expect(free.code).toBe(0); expect(existsSync(join(outside, `free-${k}.txt`))).toBe(true);
  }
});

onWin("real: the command arrives exactly as written (quotes, &, |, %, $), its output and its exit code come back", async () => {
  for (const sh of shells()) {
    if (sh.kind === "cmd") { const r = await run(`echo one^&two & echo %SYOK_CONFINED% & exit /b 7`, sh); expect(r.out).toContain("one&two"); expect(r.out).toContain("1"); expect(r.code).toBe(7); continue; }
    if (sh.kind === "powershell") {
      const r = await run(`$x = 'a & b | c % d "q"'; Write-Output $x; Write-Output ("conf=" + $env:SYOK_CONFINED); Write-Output ("tmp=" + $env:TEMP); cmd /c exit 5`, sh);
      expect(r.out).toContain(`a & b | c % d "q"`); expect(r.out).toContain("conf=1"); expect(r.out).toMatch(/tmp=.*LocalLow\\SyokCode\\tmp/); expect(r.code).toBe(5);
      const bad = await run(`Get-Item 'C:\\no\\such\\thing-at-all'`, sh); expect(bad.code).toBe(1); const good = await run(`Write-Output fine`, sh); expect(good.code).toBe(0); expect(good.out).toContain("fine");
      continue;
    }
    const r = await run(`x='a & b | c % d "q" $HOME'; echo "$x"; echo "conf=$SYOK_CONFINED"; (exit 9)`, sh); expect(r.out).toContain(`a & b | c % d "q" $HOME`); expect(r.out).toContain("conf=1"); expect(r.code).toBe(9);
  }
  expect(readdirSync(plan!.low.tmp).filter((f) => /^cmd-/.test(f))).toEqual([]); // the small hand-over files are removed afterwards
});

onWin("real: programs started by a confined command are held too (node), and installs still work (npm)", async () => {
  const sh = shells().find((s) => s.kind === "powershell")!;
  const r = await run(`node -e "const fs=require('fs');fs.writeFileSync('node-in.txt','x');try{fs.writeFileSync(String.raw\`${outside}\\node-escape.txt\`,'x');console.log('WROTE-OUTSIDE')}catch(e){console.log('blocked:'+e.code)}"`, sh);
  expect(r.out).toContain("blocked:EPERM"); expect(existsSync(join(proj, "node-in.txt"))).toBe(true); expect(existsSync(join(outside, "node-escape.txt"))).toBe(false);
  writeFileSync(join(proj, "package.json"), '{"name":"p","version":"1.0.0"}');
  const n = await run(`npm install is-number --no-audit --no-fund --loglevel=error; node -e "console.log('n=' + require('is-number')(5))"`, sh); expect(n.out).toContain("n=true");
});

onWin("real: undo removes the mark, and then a low-level command cannot write in the project any more", async () => {
  const u = undoWindows(proj, homedir()); expect(u.ok).toBe(true); expect(markedFolders(homedir()).map((x) => x.toLowerCase())).not.toContain(proj.toLowerCase());
  const sh = shells().find((s) => s.kind === "cmd")!; const r = await run(`echo x> "${proj}\\after-undo.txt"`, sh); expect(existsSync(join(proj, "after-undo.txt"))).toBe(false); expect(r.out).toMatch(/denied/i);
  expect(prepareWindows(plan!)).toBe(""); // and it can be switched on again
});

onWin("real, whole program: syok --confine on Windows holds the AI's command; without the flag Windows is not confined by default", async () => {
  const fakeHome = join(base, "home"); mkdirSync(fakeHome, { recursive: true });
  const mainJs = join(import.meta.dir, "..", "src", "main.ts"); const cmds: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { const b: any = await req.json(); const n = b.messages.filter((m: any) => m.role === "tool").length;
    const cmd = `Set-Content -Path 'whole-in.txt' -Value 'in'; Set-Content -Path '${outside}\\whole-escape.txt' -Value 'out'`; if (n === 0) cmds.push(cmd);
    return Response.json({ choices: [{ message: n === 0 ? call("run_command", { command: cmd }) : call("finish", { summary: "done" }) }], usage: { total_tokens: 2 } }); } });
  const go = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((res) => { const p = spawn("bun", [mainJs, ...args, "--mode", "auto", "--no-checks", "--no-stream", "-p", "go", "--cwd", proj], { cwd: proj, env: { ...process.env, SYOK_SHELL: "powershell", SYOK_BASE_URL: `http://127.0.0.1:${server.port}`, SYOK_API_KEY: "syk_test" } as any, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => res({ code, out, err })); });
  try {
    const r = await go(["--confine"]); expect(r.err).toContain("Confined with Windows write protection"); expect(r.code).toBe(0);
    expect(existsSync(join(proj, "whole-in.txt"))).toBe(true); expect(existsSync(join(outside, "whole-escape.txt"))).toBe(false);
    const plain = await go([]); expect(plain.err).not.toContain("Confined"); expect(plain.err).not.toContain("NOT confined"); expect(existsSync(join(outside, "whole-escape.txt"))).toBe(true);
    const net = await go(["--confine-no-network"]); expect(net.code).toBe(2); expect(net.err).toContain("not available on Windows itself");
  } finally { server.stop(true); }
});
