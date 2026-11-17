// --confine: the commands the AI runs are held inside the project folder by the operating system itself.
//   They may READ the computer (so tools work) but may WRITE only in the project folder, the temporary folder and a few
//   download caches. Folders that hold keys (.ssh, .aws, the Syok and GitHub settings...) cannot even be read.
// Linux uses bubblewrap (bwrap); Mac uses sandbox-exec. Windows has no such tool built in, so --confine is refused there.
// If the tool is missing or does not work on this computer, Syok Code stops and says so. It never runs unconfined silently.
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { posix } from "node:path";
const { join, resolve } = posix; // confinement exists on Linux and Mac only, so its paths are always of that kind

export interface Confine { kind: "bwrap" | "sandbox-exec"; root: string; network: boolean; home: string; write: string[]; hide: string[]; lock: string[] }
export interface ConfineOpts { root: string; network?: boolean; platform?: string; home?: string; exists?: (p: string) => boolean; isDir?: (p: string) => boolean; real?: (p: string) => string; tmp?: string }

// Download caches a build may fill. Only the cache folders themselves, never a folder whose programs are on the PATH.
const CACHES = [".npm", ".cache", ".bun/install/cache", ".cargo/registry", ".cargo/git", "go/pkg/mod", ".pnpm-store", ".local/share/pnpm/store", ".gradle/caches", ".m2/repository", "Library/Caches"];
// Places that hold keys and logins: not readable from inside.
const SECRETS = [".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".config/gh", ".config/gcloud", ".config/jcode", ".syok/config.json", ".modal.toml", ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".config/git/credentials", ".claude.json", ".codex/auth.json"];
// Inside the project, files that would run later OUTSIDE the confinement: readable, not writable.
const LOCKED = [".git/hooks", ".syok/settings.json", ".syok/agents", ".syok/commands"];

export function planConfine(o: ConfineOpts): Confine | { problem: string } {
  const platform = o.platform || process.platform, home = o.home || homedir();
  const exists = o.exists || existsSync, real = o.real || ((p: string) => { try { return realpathSync(p); } catch { return p; } });
  if (platform === "win32") return { problem: "--confine is not available on Windows: Windows has no built-in tool for it. Two ways that work: run Syok Code inside WSL (Windows' own Linux: \"wsl --install\", then install Syok Code in Ubuntu), where --confine works; or use --sandbox (a remote sandbox)." };
  if (platform !== "linux" && platform !== "darwin") return { problem: "--confine works on Linux and Mac only." };
  const root = real(resolve(o.root));
  if (root === "/" || root === real(home)) return { problem: "--confine needs a project folder: it will not treat your whole home folder or the whole disk as the project." };
  // Almost every install or build wants these two cache folders. They are made if missing, so that they can be left writable.
  if (!o.exists) for (const p of [".npm", ".cache"]) { try { mkdirSync(join(home, p), { recursive: true }); } catch {} }
  const inHome = (p: string) => real(join(home, p));
  const write = [...CACHES.map(inHome).filter((p) => exists(p))];
  if (platform === "darwin") write.push(real(o.tmp || tmpdir()), "/private/tmp", "/private/var/tmp");
  const hide = SECRETS.map(inHome).filter((p) => exists(p) && !(p + "/").startsWith(root + "/") && !(root + "/").startsWith(p + "/"));
  const lock = LOCKED.map((p) => join(root, p)).filter((p) => exists(p));
  return { kind: platform === "linux" ? "bwrap" : "sandbox-exec", root, network: o.network !== false, home: real(home), write: [...new Set(write)], hide, lock };
}

const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
/** The Mac rule file. Later rules win, so the denials come last. */
export function macProfile(c: Confine): string {
  return [
    "(version 1)", "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${q(c.root)})${c.write.map((w) => " (subpath " + q(w) + ")").join("")})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/(u)?random$"))',
    ...c.lock.map((l) => `(deny file-write* (subpath ${q(l)}))`),
    ...c.hide.map((h) => `(deny file-read* file-write* (subpath ${q(h)}))`),
    ...(c.network ? [] : ["(deny network*)"]),
  ].join("\n");
}
/** The program and words that start a shell command inside the confinement. */
export function confineArgv(c: Confine, exe: string, args: string[], cwd: string, isDir: (p: string) => boolean = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } }): { exe: string; args: string[] } {
  if (c.kind === "sandbox-exec") return { exe: "sandbox-exec", args: ["-p", macProfile(c), exe, ...args] };
  const a = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  if (isDir("/var/tmp")) a.push("--tmpfs", "/var/tmp");
  a.push("--bind", c.root, c.root);
  for (const w of c.write) a.push("--bind", w, w);
  for (const l of c.lock) a.push("--ro-bind", l, l);
  for (const h of c.hide) { if (isDir(h)) a.push("--tmpfs", h); else a.push("--ro-bind", "/dev/null", h); }
  if (!c.network) a.push("--unshare-net");
  a.push("--unshare-pid", "--unshare-ipc", "--die-with-parent", "--chdir", cwd, "--", exe, ...args);
  return { exe: "bwrap", args: a };
}
/** Try it once for real. Returns "" when it works, else what is wrong and what to do. */
export function probeConfine(c: Confine, run: (exe: string, args: string[]) => { status: number | null; stderr: string; error?: any } = (exe, args) => { const r = spawnSync(exe, args, { encoding: "utf8", timeout: 20000 }); return { status: r.status, stderr: r.stderr || "", error: r.error }; }): string {
  const w = confineArgv(c, "/bin/sh", ["-c", "exit 0"], c.root);
  const r = run(w.exe, w.args);
  if (r.status === 0) return "";
  if (r.error && (r.error as any).code === "ENOENT") return c.kind === "bwrap" ? "--confine needs the program bubblewrap, which is not installed. Install it (Ubuntu/Debian: sudo apt install bubblewrap; Fedora: sudo dnf install bubblewrap), then try again." : "--confine needs sandbox-exec, which was not found on this Mac.";
  const err = (r.stderr || "").trim().split("\n").slice(-2).join(" ").slice(0, 300);
  if (c.kind === "bwrap" && /uid map|user namespace|Operation not permitted|Permission denied|setting up/i.test(err)) return "--confine could not start: this Linux does not let ordinary programs create a confined space (" + err + "). On Ubuntu 24.04 and newer, allow it with: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   Inside Docker, the container must allow user namespaces.";
  return "--confine could not start on this computer" + (err ? ": " + err : ".");
}
export function confineHint(c: Confine): string {
  return `\nConfinement is ON: your commands can read the computer but can write only inside the project folder and the temporary folder${c.network ? "" : ", and they have NO network"}. Folders that hold keys cannot be read. .git/hooks and the Syok settings are read-only. A "Read-only file system" or "Operation not permitted" error outside the project comes from this: do not try to get around it; work inside the project or tell the user.`;
}
export function describeConfine(c: Confine): string {
  return `Confined with ${c.kind === "bwrap" ? "bubblewrap" : "sandbox-exec"}: commands may write only in ${c.root} and the temporary folder${c.write.length ? " (plus " + c.write.length + " download cache" + (c.write.length === 1 ? "" : "s") + ")" : ""}; ${c.hide.length} key folder${c.hide.length === 1 ? "" : "s"}/file${c.hide.length === 1 ? "" : "s"} hidden; network ${c.network ? "on" : "OFF"}.`;
}

/** Why keys need confinement and not only a clean environment: without it, a command can still read the keys of this program
 *  and of the terminal that started it from the operating system's list of running programs (on Linux, /proc). Inside the
 *  confinement a command sees only its own programs. */
export const KEYS_NOTE = "Without --confine, keys are removed from the environment of the commands the AI runs, but a command could still find them by looking at other running programs on this computer. With --confine it cannot.";

// The confinement in force for this process. Everything that starts a command goes through shell.ts, which asks here.
let active: Confine | null = null;
export function setConfine(c: Confine | null) { active = c; }
export function getConfine(): Confine | null { return active; }
