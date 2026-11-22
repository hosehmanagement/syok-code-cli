// Interactive terminals: programs that wait for typed input (python -m pdb, gdb, a REPL, npm init, installers that ask
// questions, ssh prompts). Each session runs in a real pseudo-terminal from Bun (Bun.spawn's "terminal" option), so the
// program sees a real terminal. The AI starts one, types into it, reads what came back and stops it.
// Bun's pseudo-terminals exist on Linux and Mac only. On Windows every call says so plainly.
// Safety (see tools.ts): the start command passes the same checks as run_command, runs through the same confinement and
// without keys in its environment; what the AI types is checked too, and plain interactive shells are refused.
import { cleanEnv, currentShell, shellArgs, SECRET_ENV } from "./shell.ts";
import { getConfine, confineArgv } from "./confine.ts";
import { pluginEnv } from "./plugins.ts";
import { DENY, SECRET_LIKE, type Settings } from "./perm.ts";

export interface PtyOpts {
  /** Most sessions running at the same time (default 3). */ maxSessions?: number;
  /** Unread output kept per session, in characters (default 200 000). Older output is dropped with a note. */ bufCap?: number;
  /** A session nobody typed into or read for this long is stopped (default 10 minutes). */ idleMs?: number;
  /** A session is always stopped after this long (default 60 minutes). */ lifeMs?: number;
  /** Tests: pretend this platform. */ platform?: string;
}
interface Session {
  id: number; cmd: string; proc: any; term: any; raw: string; dropped: number; code: number | null; started: number; last: number;
  dec: TextDecoder; lastData: number; lastSend: number; line: string; idle?: ReturnType<typeof setTimeout>; life?: ReturnType<typeof setTimeout>; why?: string;
}

export const PTY_UNSUPPORTED = "Interactive terminals are not supported here: Bun's pseudo-terminals work on Linux and Mac only, not on Windows. Use run_command with the answers given up front instead (for example flags such as --yes, or input from a file: program < answers.txt), or run Syok Code inside WSL.";
export function ptySupported(platform: string = process.platform): boolean {
  return platform !== "win32" && typeof (globalThis as any).Bun?.spawn === "function";
}

// ---- Keys ----
const KEYS: Record<string, string> = {
  enter: "\r", return: "\r", tab: "\t", "shift-tab": "\x1b[Z", esc: "\x1b", escape: "\x1b", space: " ", backspace: "\x7f", bs: "\x7f",
  delete: "\x1b[3~", del: "\x1b[3~", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F",
  pageup: "\x1b[5~", pgup: "\x1b[5~", pagedown: "\x1b[6~", pgdn: "\x1b[6~",
};
/** Turn key names (<Enter>, <Ctrl-C>, <Up>, <Tab>...) into what a keyboard sends. Unknown <words> are typed as they are. */
export function keys(text: string): string {
  return text.replace(/<([A-Za-z][A-Za-z0-9-]{0,15})>/g, (whole, name: string) => {
    const k = name.toLowerCase();
    const ctrl = /^(ctrl|c)-([a-z@\[\\\]^_])$/.exec(k);
    if (ctrl) { const ch = ctrl[2]; return String.fromCharCode(ch >= "a" && ch <= "z" ? ch.charCodeAt(0) - 96 : ({ "@": 0, "[": 27, "\\": 28, "]": 29, "^": 30, "_": 31 } as any)[ch]); }
    return KEYS[k] ?? whole;
  });
}

// ---- Output ----
// Escape sequences: CSI (colours, cursor moves), OSC (window titles, links), and the short two-character kinds.
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()*+][0-~]|\x1b[ -\/]*[0-~]|\x9b[0-?]*[ -\/]*[@-~]/g;
/** Plain text from terminal output: escape codes removed, line ends tidied, a line redrawn with \r kept as its last version, backspaces applied. */
export function stripAnsi(s: string): string {
  let t = s.replace(ANSI, "").replace(/\r+\n/g, "\n");
  t = t.split("\n").map((line) => {
    if (line.includes("\r")) { const parts = line.split("\r").filter((p) => p !== ""); line = parts.length ? parts[parts.length - 1] : ""; }
    if (line.includes("\b")) { const out: string[] = []; for (const ch of line) { if (ch === "\b") out.pop(); else out.push(ch); } line = out.join(""); }
    return line;
  }).join("\n");
  return t.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
const INCOMPLETE = /^(?:\x1b|\x1b\[[0-?]*[ -\/]*|\x1b\][^\x07\x1b]*\x1b?|\x1b[PX^_][^\x1b]*\x1b?|\x1b[()*+]|\x1b[ -\/]+)$/;
/** Split off an escape sequence cut in half at the end of what arrived so far, so it is cleaned once it is complete. */
export function holdBack(raw: string): [string, string] {
  const i = raw.lastIndexOf("\x1b");
  if (i < 0 || raw.length - i > 256) return [raw, ""];
  const tail = raw.slice(i);
  return INCOMPLETE.test(tail) ? [raw.slice(0, i), tail] : [raw, ""];
}

// ---- Safety ----
const SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "ash", "yash", "nu", "nushell", "elvish", "xonsh", "pwsh", "powershell", "cmd", "git-bash"]);
// Programs whose whole job is to open a shell (or a terminal that holds one).
const SHELL_OPENERS = new Set(["script", "tmux", "screen", "su", "login", "runuser", "doas", "sudo", "byobu", "zellij", "machinectl"]);
// Programs that start the program named after them.
const WRAPPERS = new Set(["env", "exec", "command", "builtin", "nohup", "nice", "ionice", "time", "timeout", "stdbuf", "setsid", "chroot", "unshare", "nsenter", "xargs", "flatpak-spawn", "docker", "podman", "kubectl", "oc", "lxc", "toolbox", "distrobox", "bwrap", "firejail", "proot", "winpty", "start", "watch", "strace", "ltrace", "gdbserver", "rlwrap", "unbuffer", "expect", "caffeinate", "systemd-run", "wsl", "nix-shell", "devbox", "poetry", "pipenv", "conda", "uv", "npx", "bunx", "busybox", "toybox"]);
const base = (w: string) => w.replace(/^["']|["']$/g, "").split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase();
function words(s: string): string[] {
  const out: string[] = []; const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g; let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] !== undefined ? m[2] : m[3]);
  return out;
}
const isShellWord = (w: string) => SHELLS.has(base(w)) || /^\$\{?SHELL\}?$/.test(w) || /^\$\{?(COMSPEC|ComSpec)\}?$/.test(w);
/** Does this shell, with these words after it, sit waiting for typed commands? (No -c, no script file: yes.) */
function shellIsBare(rest: string[], depth: number): string | null {
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === "-c" || w === "/c" || w === "/C" || w === "/k" || w === "/K" || w === "-Command" || w === "-command" || /^-[a-z]*c$/.test(w)) {
      if (/^\/k$/i.test(w) || w === "-NoExit") return "a shell kept open";
      return depth < 3 ? bareShell(rest.slice(i + 1).join(" "), depth + 1) : null; // the command it runs is checked the same way
    }
    if (w === "-s" || w === "-" || /^-[a-z]*s$/.test(w) || /^-[a-z]*i$/.test(w) || w === "--interactive" || w === "-NoExit") return "an interactive shell";
    if (w === "-File" || w === "-file" || (!w.startsWith("-") && !w.startsWith("/"))) return null; // runs a script, then ends
  }
  return "an interactive shell";
}
/** Why this command would open a plain shell that waits for typed commands, or null when it does not. */
export function bareShell(cmd: string, depth = 0): string | null {
  for (const part of String(cmd).split(/&&|\|\||[;|\n&]|\$\(|`|\(|\)/)) {
    let w = words(part.trim());
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1); // NAME=value in front
    if (!w.length) continue;
    const prog = base(w[0]);
    if (isShellWord(w[0])) { const why = shellIsBare(w.slice(1), depth); if (why) return why; continue; }
    if (SHELL_OPENERS.has(prog)) return `"${prog}" (it opens a shell)`;
    if (WRAPPERS.has(prog)) {
      const k = w.findIndex((x, i) => i > 0 && isShellWord(x));
      if (k > 0) { const why = shellIsBare(w.slice(k + 1), depth); if (why) return why; }
      if (w.slice(1).some((x) => SHELL_OPENERS.has(base(x)))) return "a program that opens a shell";
    }
    if (["poetry", "pipenv", "devbox", "hatch", "pdm", "pixi"].includes(prog) && base(w[1] || "") === "shell") return `"${prog} shell" (it opens a shell)`;
    if ((prog === "nix-shell" || (prog === "nix" && w[1] === "develop")) && !w.some((x) => x === "--run" || x === "--command" || x === "-c")) return `"${w.slice(0, prog === "nix" ? 2 : 1).join(" ")}" without --run (it opens a shell)`;
    // python -c "import pty; pty.spawn('/bin/bash')" and the like
    if (/\bpty\.spawn\s*\(|\bos\.exec[lv]p?e?\s*\(\s*['"][^'"]*\b(ba|z|fi|da|k)?sh\b/.test(part)) return "a program that opens a shell";
  }
  return null;
}
/** What is wrong with typing this into a terminal, or "" when it may be typed. */
export function typedProblem(text: string, s: Settings = {}, env: NodeJS.ProcessEnv = process.env): string {
  const plain = keys(text).replace(/[\x00-\x1f\x7f]+/g, "\n");
  if (SECRET_LIKE.test(plain)) return "that looks like a secret key or token. Never type keys into a terminal; ask the user to type it themselves.";
  for (const k of SECRET_ENV) { const v = env[k]; if (v && v.length >= 8 && plain.includes(v)) return "that contains one of Syok Code's own keys."; }
  for (const line of plain.split("\n")) {
    const l = line.trim(); if (!l) continue;
    if (DENY.some((r) => r.test(l)) || (s.deny || []).some((p) => l.includes(p))) return "that is a command blocked by Syok Code's safety rules (typing it into a terminal does not get around them).";
    const sh = bareShell(l.replace(/^(!+\s*|shell\s+|system\s+|sh\s+-c\s+)/i, "")) || bareShell(l); if (sh) return `that would open ${sh} inside the terminal, where typed commands would skip Syok Code's checks.`;
  }
  return "";
}

/** The line typed so far and not yet sent with Enter, after these keys: so a command typed a few letters at a time is
 *  checked as the whole line it becomes. Enter, Ctrl-C, Ctrl-U and Ctrl-D start a new line; Backspace removes a letter. */
export function nextLine(line: string, data: string): string {
  let l = line;
  for (const ch of data.replace(ANSI, "")) {
    if (ch === "\r" || ch === "\n" || ch === "\x03" || ch === "\x15" || ch === "\x04") l = "";
    else if (ch === "\x7f" || ch === "\b") l = l.slice(0, -1);
    else if (ch >= " " || ch === "\t") l += ch;
  }
  return l.slice(-4000);
}

// ---- Sessions ----
const live = new Set<Pty>();
let exitHook = false;
function onExit() { for (const p of live) p.stopAll(); }

export class Pty {
  sessions = new Map<number, Session>(); n = 0; o: Required<Omit<PtyOpts, "platform">> & { platform: string };
  constructor(o: PtyOpts = {}) {
    this.o = { maxSessions: o.maxSessions ?? 3, bufCap: o.bufCap ?? 200_000, idleMs: o.idleMs ?? 10 * 60_000, lifeMs: o.lifeMs ?? 60 * 60_000, platform: o.platform ?? process.platform };
  }
  running(): number { let k = 0; for (const s of this.sessions.values()) if (s.code === null) k++; return k; }
  /** Start a command in a new pseudo-terminal. Returns the session id, or an error message. The command must already be approved. */
  start(cmd: string, cwd: string, cols = 120, rows = 30): number | string {
    if (!ptySupported(this.o.platform)) return PTY_UNSUPPORTED;
    if (this.running() >= this.o.maxSessions) return `Error: ${this.o.maxSessions} terminals are already running (the most at once). Stop one with pty_stop first.`;
    cols = Math.max(20, Math.min(500, Math.floor(cols) || 120)); rows = Math.max(5, Math.min(200, Math.floor(rows) || 30));
    const sh = currentShell(), c = getConfine();
    const env: Record<string, string> = { ...(pluginEnv(cwd, cleanEnv()) as any), TERM: "xterm-256color", COLUMNS: String(cols), LINES: String(rows), PYTHON_BASIC_REPL: "1" };
    let argv: string[];
    if (c && c.kind !== "windows-low") {
      // Inside bubblewrap the command is a child of bubblewrap's own processes, which share its process group. "set -m" puts the
      // command in a process group of its own that owns the terminal, so Ctrl-C reaches the program and not bubblewrap.
      const line = c.kind === "bwrap" ? "set -m\n" + cmd + "\nexit $?" : cmd;
      const w = confineArgv(c, sh.exe, shellArgs(sh, line), cwd); argv = [w.exe, ...w.args]; env.SYOK_CONFINED = "1";
    } else argv = [sh.exe, ...shellArgs(sh, cmd)];
    const s: Session = { id: ++this.n, cmd, proc: null, term: null, raw: "", dropped: 0, code: null, started: Date.now(), last: Date.now(), dec: new TextDecoder(), lastData: Date.now(), lastSend: 0, line: "" };
    try {
      s.proc = (globalThis as any).Bun.spawn(argv, {
        cwd, env,
        terminal: { cols, rows, data: (_t: any, d: Uint8Array) => this.add(s, s.dec.decode(d, { stream: true })) },
      });
      s.term = s.proc.terminal;
      if (!s.term) { try { s.proc.kill(9); } catch {} return PTY_UNSUPPORTED; }
    } catch (e: any) { return "Error: the terminal could not be started: " + (e?.message || e); }
    s.proc.exited.then((code: number) => {
      s.code = typeof code === "number" ? code : s.proc.signalCode ? 128 + (signalNo(s.proc.signalCode)) : -1;
      this.clearTimers(s);
      setTimeout(() => { try { s.term.close(); } catch {} }, 200);
    }, () => { s.code = -1; });
    s.idle = this.timer(() => this.kill(s, `stopped: nothing was typed or read for ${Math.round(this.o.idleMs / 60000)} minutes`), this.o.idleMs);
    s.life = this.timer(() => this.kill(s, `stopped: it reached the time limit of ${Math.round(this.o.lifeMs / 60000)} minutes`), this.o.lifeMs);
    this.sessions.set(s.id, s); live.add(this);
    if (!exitHook) { exitHook = true; process.on("exit", onExit); }
    return s.id;
  }
  private timer(f: () => void, ms: number) { const t = setTimeout(f, ms); (t as any).unref?.(); return t; }
  private clearTimers(s: Session) { if (s.idle) clearTimeout(s.idle); if (s.life) clearTimeout(s.life); }
  private touch(s: Session) {
    s.last = Date.now();
    if (s.code === null) { if (s.idle) clearTimeout(s.idle); s.idle = this.timer(() => this.kill(s, `stopped: nothing was typed or read for ${Math.round(this.o.idleMs / 60000)} minutes`), this.o.idleMs); }
  }
  private add(s: Session, d: string) {
    if (!d) return;
    s.raw += d; s.lastData = Date.now();
    if (s.raw.length > this.o.bufCap) { const cut = s.raw.length - Math.floor(this.o.bufCap * 0.75); s.dropped += cut; s.raw = s.raw.slice(cut); }
  }
  private kill(s: Session, why: string) {
    if (s.code !== null) return;
    s.why = why;
    const pid = s.proc?.pid;
    // The program leads its own session and process group in the terminal: stop the whole group.
    try { if (pid) process.kill(-pid, "SIGHUP"); } catch {}
    try { if (pid) process.kill(-pid, "SIGKILL"); } catch { try { s.proc.kill(9); } catch {} }
    try { s.term?.close(); } catch {}
    this.clearTimers(s);
  }
  /** Type into a session. enter = press Enter after the text. The text must already be checked (typedProblem). */
  send(id: number, text: string, o: { enter?: boolean } = {}): string {
    const s = this.sessions.get(id); if (!s) return `Error: no terminal ${id}.`;
    if (s.code !== null) return `Error: terminal ${id} has ended (${this.state(s)}). Read the rest with pty_read, or start a new one.`;
    const data = keys(text) + (o.enter ? "\r" : "");
    if (!data) return "Error: nothing to type.";
    try { s.term.write(data); } catch (e: any) { return "Error: could not type into the terminal: " + (e?.message || e); }
    this.touch(s); s.lastSend = Date.now(); s.line = nextLine(s.line, data);
    return `Typed ${data.length} character${data.length === 1 ? "" : "s"} into terminal ${id}.`;
  }
  /** What has been typed on the current line and not yet sent with Enter. */
  line(id: number): string { return this.sessions.get(id)?.line ?? ""; }
  private state(s: Session): string { return s.code === null ? "still running" : (s.why ? s.why + ", " : "") + `exited with code ${s.code}`; }
  /** New output since the last read, as plain text. Waits up to wait_ms for output to arrive and settle. */
  async read(id: number, o: { wait_ms?: number; max_chars?: number } = {}): Promise<string> {
    const s = this.sessions.get(id); if (!s) return `Error: no terminal ${id}.`;
    const wait = Math.max(0, Math.min(60_000, o.wait_ms ?? 1500)), max = Math.max(200, Math.min(50_000, o.max_chars ?? 4000));
    const t0 = Date.now(), settle = 300;
    while (Date.now() - t0 < wait) {
      if (s.code !== null && Date.now() - s.lastData > 100) break;
      if (s.raw.length && s.lastData > s.lastSend && Date.now() - s.lastData >= settle) break; // the answer to what was typed came, and has stopped for a moment
      await new Promise((r) => setTimeout(r, 50));
    }
    this.touch(s);
    const ended = s.code !== null;
    const [ready, rest] = ended ? [s.raw, ""] : holdBack(s.raw);
    s.raw = rest;
    let text = stripAnsi(ready);
    const notes: string[] = [];
    if (s.dropped) { notes.push(`[older output dropped: ${s.dropped} characters were not read in time]`); s.dropped = 0; }
    if (text.length > max) { notes.push(`[${text.length - max} earlier characters not shown]`); text = text.slice(-max); }
    return [...notes, text || "(no new output)", `[${this.state(s)}]`].join("\n");
  }
  stop(id: number): string {
    const s = this.sessions.get(id); if (!s) return `Error: no terminal ${id}.`;
    const was = s.code === null; this.kill(s, "stopped by pty_stop");
    this.sessions.delete(id);
    return was ? `Stopped terminal ${id}.` : `Terminal ${id} had already ended (exit code ${s.code}); removed.`;
  }
  list(): string { return [...this.sessions.values()].map((s) => `${s.id}: ${s.cmd.slice(0, 80)} (${this.state(s)})`).join("\n") || "No terminals."; }
  stopAll() { for (const s of this.sessions.values()) this.kill(s, "stopped because Syok Code finished"); this.sessions.clear(); live.delete(this); }
}
function signalNo(name: string): number { return ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[name] || 0; }
