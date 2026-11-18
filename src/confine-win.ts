// Confinement on Windows itself (not WSL): write protection through Windows' "integrity levels".
//
// How it works: Windows runs a program at LOW integrity when its program file is marked Low. A low program, and everything
// it starts, cannot change files, folders or registry settings that are not themselves marked Low. So:
//   - Syok Code keeps a private copy of the Command Prompt (cmd.exe) marked Low, and starts every command through it.
//   - The project folder is marked Low, so the commands can work in it. Their temporary folder and the download caches of
//     npm, bun and pip are moved to a folder that is Low already.
// What it does NOT do, and says so: a low program can still READ your files, and the network stays on. On Linux, Mac and
// WSL the confinement also hides key folders; on Windows it only stops changes.
// The mark on the project folder stays until "syok confine undo" removes it.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import type { Shell } from "./shell.ts";
const { join, resolve, parse } = win32;

export interface WinLow { cmd: string; dir: string; tmp: string; env: Record<string, string> }
export interface WinPlan { kind: "windows-low"; root: string; network: true; home: string; write: string[]; hide: string[]; lock: string[]; low: WinLow }
type Run = (exe: string, args: string[], o?: { cwd?: string; verbatim?: boolean }) => { status: number | null; stdout: string; stderr: string; error?: any };
const realRun: Run = (exe, args, o) => { const r = spawnSync(exe, args, { encoding: "utf8", timeout: 60000, windowsHide: true, cwd: o?.cwd, windowsVerbatimArguments: !!o?.verbatim }); return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || ""), error: r.error }; };

/** Characters the Command Prompt gives a meaning to. A path with one of them cannot be passed through it safely. */
const RISKY = /[%"^&<>|!]/;

/** Works out the plan. Changes nothing on the computer. */
export function planWindows(o: { root: string; network?: boolean; home: string; env?: Record<string, string | undefined> }): WinPlan | { problem: string } {
  if (o.network === false) return { problem: "Switching the network off for the AI's commands is not available on Windows itself. Use --confine without it, or run Syok Code inside WSL (Windows' own Linux), where --confine-no-network works." };
  const root = resolve(o.root), home = resolve(o.home);
  const same = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
  if (same(root, parse(root).root) || same(root, home)) return { problem: "--confine needs a project folder: it will not treat your whole home folder or the whole disk as the project." };
  const dir = join(home, "AppData", "LocalLow", "SyokCode"), bin = join(home, ".syok", "low");
  for (const p of [root, dir, bin]) if (RISKY.test(p)) return { problem: `--confine cannot be used here: the folder name ${p} contains a character the Command Prompt gives a special meaning to (one of % " ^ & < > | !).` };
  const tmp = join(dir, "tmp");
  return { kind: "windows-low", root, network: true, home, write: [dir], hide: [], lock: [], low: { cmd: join(bin, "cmd.exe"), dir, tmp, env: { TEMP: tmp, TMP: tmp, npm_config_cache: join(dir, "npm-cache"), BUN_INSTALL_CACHE_DIR: join(dir, "bun-cache"), PIP_CACHE_DIR: join(dir, "pip-cache"), npm_config_update_notifier: "false" } } };
}

const marksFile = (home: string) => join(home, ".syok", "low", "marked-folders.json");
export function markedFolders(home: string): string[] { try { const j = JSON.parse(readFileSync(marksFile(home), "utf8")); return Array.isArray(j) ? j.filter((x) => typeof x === "string") : []; } catch { return []; } }
function saveMarks(home: string, list: string[]) { try { mkdirSync(join(home, ".syok", "low"), { recursive: true }); writeFileSync(marksFile(home), JSON.stringify([...new Set(list)], null, 2) + "\n"); } catch {} }

/** Makes the plan real: the low copy of the Command Prompt, the work folders, the mark on the project. Then tries it.
 *  Returns "" when commands are really held, else what is wrong in plain words. */
export function prepareWindows(c: WinPlan, run: Run = realRun, env: Record<string, string | undefined> = process.env): string {
  try {
    const sys = env.ComSpec || env.COMSPEC || join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "cmd.exe");
    if (!existsSync(sys)) return "--confine could not be set up: the Command Prompt (cmd.exe) was not found on this computer.";
    const bin = parse(c.low.cmd).dir; mkdirSync(bin, { recursive: true });
    for (const d of [c.low.dir, c.low.tmp, ...Object.entries(c.low.env).filter(([k]) => /cache/i.test(k)).map(([, v]) => v)]) mkdirSync(d, { recursive: true });
    // The copy is refreshed when Windows has updated its own Command Prompt.
    let fresh = false; try { const a = statSync(sys), b = statSync(c.low.cmd); fresh = a.size === b.size && b.mtimeMs >= a.mtimeMs; } catch {}
    if (!fresh) {
      copyFileSync(sys, c.low.cmd);
      const sysDir = parse(sys).dir; // its messages live in language folders next to it (en-US\cmd.exe.mui and so on)
      try { for (const lang of readdirSync(sysDir)) { if (!/^[a-z]{2,3}(-[A-Za-z0-9]+)+$/.test(lang)) continue; const mui = join(sysDir, lang, "cmd.exe.mui"); if (existsSync(mui)) { mkdirSync(join(bin, lang), { recursive: true }); copyFileSync(mui, join(bin, lang, "cmd.exe.mui")); } } } catch {}
    }
    const a = run("icacls", [c.low.cmd, "/setintegritylevel", "Low"]);
    if (a.status !== 0) return "--confine could not be set up: Windows refused to mark Syok Code's private copy of the Command Prompt (" + (a.stderr || a.stdout).trim().split("\n").pop()!.slice(0, 200) + ").";
    const b = run("icacls", [c.root, "/setintegritylevel", "(OI)(CI)Low"]);
    if (b.status !== 0) return "--confine could not be set up: Windows refused to mark the project folder so that confined commands may write in it (" + (b.stderr || b.stdout).trim().split("\n").pop()!.slice(0, 200) + "). This happens on disks that are not NTFS (USB sticks, some network drives) and in folders you do not own.";
    saveMarks(c.home, [...markedFolders(c.home), c.root]);
    // Try it for real: a confined command must be able to write in the project and must NOT be able to write next to the low copy.
    const inside = join(c.root, `.syok-confine-test-${randomBytes(4).toString("hex")}`), outside = join(bin, `outside-test-${randomBytes(4).toString("hex")}`);
    run(c.low.cmd, ["/d", "/c", `echo ok> "${inside}"`], { verbatim: true }); run(c.low.cmd, ["/d", "/c", `echo ok> "${outside}"`], { verbatim: true });
    const wroteInside = existsSync(inside), wroteOutside = existsSync(outside);
    for (const f of [inside, outside]) { try { unlinkSync(f); } catch {} }
    if (wroteOutside) return "--confine does not work on this computer: a command started at the low level could still write outside the project, so Syok Code will not pretend it is confined. (This happens on disks that cannot hold Windows' integrity marks.)";
    if (!wroteInside) return "--confine could not be set up: a confined command could not write in the project folder.";
    return "";
  } catch (e: any) { return "--confine could not be set up: " + String(e?.message || e).slice(0, 300); }
}

/** Removes the mark from a project folder, so that only ordinary programs may write in it again. */
export function undoWindows(root: string, home: string, run: Run = realRun): { ok: boolean; message: string } {
  const r = run("icacls", [resolve(root), "/setintegritylevel", "(OI)(CI)Medium"]);
  if (r.status !== 0) return { ok: false, message: "Windows refused to change the mark on " + resolve(root) + ": " + (r.stderr || r.stdout).trim().split("\n").pop()!.slice(0, 200) };
  saveMarks(home, markedFolders(home).filter((p) => p.toLowerCase() !== resolve(root).toLowerCase()));
  return { ok: true, message: "The mark is removed from " + resolve(root) + ". Low-level programs can no longer write in it. (--confine will mark it again the next time you use it here.)" };
}

export interface WinSpawn { exe: string; args: string[]; verbatim: true; env: Record<string, string>; cleanup: () => void }
/** How to start one command line at the low level, in the shell the user has. Bash and PowerShell commands are handed over
 *  in a small file, so that nothing in the command has to survive the Command Prompt's own quoting rules. */
export function winSpawn(c: WinPlan, sh: Shell, command: string, psTail = "", write: (path: string, text: string) => void = (p, t) => writeFileSync(p, t)): WinSpawn {
  const none = () => {};
  if (sh.kind === "cmd") return { exe: c.low.cmd, args: ["/d", "/s", "/c", command], verbatim: true, env: c.low.env, cleanup: none };
  const id = randomBytes(8).toString("hex");
  if (sh.kind === "powershell") {
    const file = join(c.low.tmp, `cmd-${id}.ps1`); write(file, "\ufeff" + command + psTail);
    const inner = `Invoke-Expression ([IO.File]::ReadAllText('${file.replace(/'/g, "''")}'))`;
    return { exe: c.low.cmd, args: ["/d", "/s", "/c", `""${sh.exe}" -NoLogo -NoProfile -NonInteractive -Command "${inner}""`], verbatim: true, env: c.low.env, cleanup: () => { try { unlinkSync(file); } catch {} } };
  }
  const file = join(c.low.tmp, `cmd-${id}.sh`); write(file, command + "\n");
  return { exe: c.low.cmd, args: ["/d", "/s", "/c", `""${sh.exe}" -l "${file}""`], verbatim: true, env: c.low.env, cleanup: () => { try { unlinkSync(file); } catch {} } };
}
