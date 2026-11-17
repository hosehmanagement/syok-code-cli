// Which shell runs the AI's commands, on every system.
// Linux and Mac: bash. Windows: Git Bash if installed, else PowerShell, else the old Command Prompt.
// Everything that starts a command (run_command, background jobs, hooks) goes through here, so Windows works without WSL.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { getConfine, confineArgv } from "./confine.ts";

export type ShellKind = "bash" | "powershell" | "cmd";
export interface Shell { kind: ShellKind; exe: string; label: string; hint: string }
export interface ShellEnv {
  platform: string;
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  which: (name: string) => string;
}

const HINTS: Record<ShellKind, string> = {
  bash: "Commands run in bash. Use normal bash syntax (&&, |, quotes).",
  powershell: "Commands run in Windows PowerShell, not bash. Use PowerShell syntax: separate steps with ; (older PowerShell has no &&), use Get-ChildItem instead of ls -la when in doubt, $env:NAME for variables, and double quotes for paths with spaces. Do not use bash-only tools such as sed, awk or grep unless you checked they exist.",
  cmd: "Commands run in the old Windows Command Prompt (cmd.exe), not bash. Use cmd syntax: dir, type, && to chain, %NAME% for variables. Do not use bash-only tools such as ls, grep or sed.",
};

/** The real machine. Tests pass a fake one. */
export function realEnv(): ShellEnv {
  return {
    platform: process.platform,
    env: process.env,
    exists: (p) => { try { return existsSync(p); } catch { return false; } },
    which: (name) => {
      try {
        const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
        return r.status === 0 ? (r.stdout || "").split(/\r?\n/)[0].trim() : "";
      } catch { return ""; }
    },
  };
}

const mk = (kind: ShellKind, exe: string, label: string): Shell => ({ kind, exe, label, hint: HINTS[kind] });
// C:\Windows\System32\bash.exe is the WSL launcher, not Git Bash: it runs inside Linux and cannot see Windows paths the same way.
const isWslLauncher = (p: string) => /[\\/]windows[\\/]system32[\\/]bash\.exe$/i.test(p.replace(/\//g, "\\"));

/** Pick the shell. Set SYOK_SHELL=bash|powershell|cmd to force one. */
export function pickShell(e: ShellEnv = realEnv()): Shell {
  const forced = (e.env.SYOK_SHELL || "").trim().toLowerCase();
  if (e.platform !== "win32") {
    if (forced === "sh") return { kind: "bash", exe: "sh", label: "sh", hint: HINTS.bash };
    const bash = e.which("bash") || (e.exists("/bin/bash") ? "/bin/bash" : "");
    return bash ? mk("bash", "bash", "bash") : { kind: "bash", exe: "sh", label: "sh (bash was not found)", hint: HINTS.bash };
  }
  const pf = e.env.ProgramFiles, pf86 = e.env["ProgramFiles(x86)"], local = e.env.LOCALAPPDATA, sysroot = e.env.SystemRoot || "C:\\Windows";
  const gitBash = () => {
    const c = [pf && pf + "\\Git\\bin\\bash.exe", pf86 && pf86 + "\\Git\\bin\\bash.exe", local && local + "\\Programs\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\bin\\bash.exe"].filter(Boolean) as string[];
    for (const p of c) if (e.exists(p)) return p;
    const w = e.which("bash");
    return w && !isWslLauncher(w) ? w : "";
  };
  const ps = () => {
    const pwsh = e.which("pwsh");
    if (pwsh) return pwsh;
    const p = sysroot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    return e.exists(p) ? p : e.which("powershell");
  };
  const cmd = () => e.env.ComSpec || e.env.COMSPEC || sysroot + "\\System32\\cmd.exe";
  if (forced === "powershell" || forced === "pwsh") { const p = ps(); if (p) return mk("powershell", p, "PowerShell"); }
  if (forced === "cmd") return mk("cmd", cmd(), "Command Prompt");
  if (forced === "bash") { const b = gitBash(); if (b) return mk("bash", b, "Git Bash"); }
  const g = gitBash(); if (g) return mk("bash", g, "Git Bash");
  const p = ps(); if (p) return mk("powershell", p, "PowerShell");
  return mk("cmd", cmd(), "Command Prompt");
}

let cached: Shell | null = null;
export function currentShell(): Shell { return (cached ||= pickShell()); }
export function resetShellCache() { cached = null; }

/** The arguments that make this shell run one command line. */
export function shellArgs(sh: Shell, command: string): string[] {
  if (sh.kind === "bash") return ["-lc", command];
  // PowerShell -Command reports 1 for any failure; the lines after the command pass the real exit code of a program through.
  if (sh.kind === "powershell") return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command + "\n$__ok = $?; $__c = $LASTEXITCODE; if (-not $__ok) { if ($__c) { exit $__c } else { exit 1 } }; exit 0"];
  return ["/d", "/s", "/c", command];
}

/** Start a command line in the right shell. Same options everywhere: own process group (so it can be stopped), hidden window on Windows. */
export function spawnCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, stdio: Array<"ignore" | "pipe" | number>, sh: Shell = currentShell()): ChildProcess {
  const win = process.platform === "win32";
  const c = getConfine();
  if (c) { // --confine: the operating system holds this command inside the project folder
    const w = confineArgv(c, sh.exe, shellArgs(sh, command), cwd);
    return spawn(w.exe, w.args, { cwd, env: { ...env, SYOK_CONFINED: "1" }, detached: true, stdio });
  }
  return spawn(sh.exe, shellArgs(sh, command), { cwd, env, detached: !win, windowsHide: true, windowsVerbatimArguments: win && sh.kind === "cmd", stdio });
}

/** Stop a command and everything it started. */
export function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }); } catch {}
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch {} }
}

/** One line for the AI's instructions so it writes commands for the shell it really has. */
export function shellHint(sh: Shell = currentShell()): string {
  return `\nShell: ${sh.label}. ${sh.hint}`;
}

/** Environment for anything the AI starts (commands, hooks, jobs, checks): the same as ours, without keys and tokens. */
export const SECRET_ENV = ["SYOK_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "EXA_API_KEY", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_CACHE_URL", "ACTIONS_RESULTS_URL"];
export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }; for (const k of SECRET_ENV) delete env[k];
  return env;
}
