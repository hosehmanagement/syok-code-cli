// The user's own GitHub Codespace as a place to run jobs, driven through GitHub's command-line tool (gh):
//   gh codespace ssh -c <name> -- <command>      run a command there
//   gh codespace cp -e -c <name> <from> <to>      copy a file (remote paths are written remote:/path)
// A Codespace is a computer the user keeps, so a run gets its own folder there and nothing is switched off afterwards.
import { spawn } from "node:child_process";
import type { Box, BoxOptions, Provider } from "./remote.ts";

export interface GhResult { code: number; out: string; err: string }
export type GhRun = (args: string[], o?: { onOut?: (s: string) => void; onErr?: (s: string) => void; timeoutMs?: number }) => Promise<GhResult>;
/** Start gh and collect (and optionally stream) what it prints. Code 127 = gh is not installed, 124 = time limit. */
export const realGh: GhRun = (args, o = {}) => new Promise((res) => {
  let out = "", err = "", done = false;
  let ch;
  try { ch = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); } catch (e: any) { return res({ code: 127, out: "", err: String(e?.message || e) }); }
  ch.stdout!.on("data", (d) => { const s = String(d); if (out.length < 400_000) out += s; o.onOut?.(s); });
  ch.stderr!.on("data", (d) => { const s = String(d); if (err.length < 400_000) err += s; o.onErr?.(s); });
  const t = o.timeoutMs ? setTimeout(() => { if (!done) { done = true; try { ch.kill("SIGKILL"); } catch {} res({ code: 124, out, err: err + "\n[stopped: time limit reached]" }); } }, o.timeoutMs) : null;
  ch.on("error", (e: any) => { if (done) return; done = true; if (t) clearTimeout(t); res({ code: e?.code === "ENOENT" ? 127 : 1, out, err: err + String(e?.message || e) }); });
  ch.on("close", (code) => { if (done) return; done = true; if (t) clearTimeout(t); res({ code: code ?? 1, out, err }); });
});

const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WORK_OK = /^\/tmp\/syok-runs\/[a-z0-9]{6,24}$/;
export const CODESPACE_SETUP = [
  "To run jobs on your GitHub Codespace, this computer needs GitHub's command-line tool, signed in. One-time setup:",
  "  1. Install it from https://cli.github.com",
  "  2. Sign in:  gh auth login",
  "  3. Allow Codespaces:  gh auth refresh -h github.com -s codespace",
  "Then run the command again.",
].join("\n");

/** Stop every process that is working inside this run's folder (found by its current folder, so this command never stops itself), then remove the folder. */
export function cleanupLine(work: string): string {
  return `for p in /proc/[0-9]*; do d=$(readlink "$p/cwd" 2>/dev/null) || continue; case "$d" in ${q(work)}|${q(work)}/*) kill -KILL "\${p#/proc/}" 2>/dev/null ;; esac; done; rm -rf -- ${q(work)} ${q(work + ".tmp-project.tgz")} ${q(work + ".tmp-out.tgz")}; true`;
}
export interface CodespaceInfo { name: string; state: string; repository: string }
export function parseCodespaces(json: string): CodespaceInfo[] {
  let a: any; try { a = JSON.parse(json); } catch { return []; }
  return Array.isArray(a) ? a.map((x) => ({ name: String(x?.name || ""), state: String(x?.state || ""), repository: String(x?.repository || "") })).filter((x) => NAME_OK.test(x.name)) : [];
}

export function codespaceProvider(o: { name?: string; gh?: GhRun; id?: () => string } = {}): Provider {
  const gh = o.gh || realGh;
  let chosen = o.name || "";
  const newId = o.id || (() => Math.random().toString(36).slice(2, 12).padEnd(8, "0"));
  const box = (name: string, work: string): Box => ({
    id: name + ":" + work, work,
    exec: async (command, x) => {
      // The whole command line is one word for ssh, so the Codespace's shell reads it exactly once.
      const line = (x.cwd ? "cd " + q(x.cwd) + " && " : "") + command;
      const r = await gh(["codespace", "ssh", "-c", name, "--", line], { onOut: x.onOut, onErr: x.onErr, timeoutMs: x.timeoutMs });
      return r.code;
    },
    upload: async (local, remote) => { const r = await gh(["codespace", "cp", "-e", "-c", name, local, "remote:" + remote], { timeoutMs: 600_000 }); if (r.code !== 0) throw new Error("could not copy the file to the Codespace: " + (r.err || r.out).trim().slice(0, 300)); },
    download: async (remote, local) => { const r = await gh(["codespace", "cp", "-e", "-c", name, "remote:" + remote, local], { timeoutMs: 600_000 }); if (r.code !== 0) throw new Error("could not copy the file from the Codespace: " + (r.err || r.out).trim().slice(0, 300)); },
    // The Codespace is the user's: only this run's own folder is removed.
    terminate: async () => { if (!WORK_OK.test(work)) return; await gh(["codespace", "ssh", "-c", name, "--", cleanupLine(work)], { timeoutMs: 60_000 }); },
  });
  return {
    name: "Codespace",
    unsupported: ["gpu", "image", "cpu", "memory"],
    problem: async () => {
      const v = await gh(["--version"], { timeoutMs: 15_000 });
      if (v.code !== 0) return CODESPACE_SETUP;
      if (chosen && !NAME_OK.test(chosen)) return "That is not a Codespace name. See your Codespaces with: gh codespace list";
      const l = await gh(["codespace", "list", "--json", "name,state,repository"], { timeoutMs: 60_000 });
      if (l.code !== 0) return /scope|codespace|auth|login|401|403/i.test(l.err + l.out) ? CODESPACE_SETUP + "\n(GitHub said: " + (l.err || l.out).trim().slice(0, 200) + ")" : "Could not list your Codespaces: " + (l.err || l.out).trim().slice(0, 300);
      const all = parseCodespaces(l.out);
      if (chosen) return all.some((c) => c.name === chosen) ? null : `You have no Codespace named "${chosen}". Yours: ${all.map((c) => c.name).join(", ") || "none"}`;
      if (!all.length) return "You have no Codespace yet. Create one at https://github.com/codespaces (or: gh codespace create), then run this again.";
      if (all.length > 1) return "You have more than one Codespace. Say which one with --codespace <name>:\n" + all.map((c) => `  ${c.name}   (${c.repository}, ${c.state})`).join("\n");
      chosen = all[0].name; return null;
    },
    create: async (_o: BoxOptions) => {
      if (!NAME_OK.test(chosen)) throw new Error("No Codespace was chosen.");
      const b = box(chosen, "/tmp/syok-runs/" + newId());
      const ok = await b.exec("mkdir -p " + q(b.work!) + " && echo syok-ready", {});
      if (ok !== 0) throw new Error(`Could not reach the Codespace "${chosen}" (gh codespace ssh failed). It needs an SSH server: the default Codespace image has one; a custom one needs the "sshd" dev container feature.`);
      return b;
    },
    attach: async (id: string) => {
      const i = id.indexOf(":"); const name = id.slice(0, i), work = id.slice(i + 1);
      if (i < 1 || !NAME_OK.test(name) || !WORK_OK.test(work)) throw new Error("This run's record does not name a Codespace folder.");
      const b = box(name, work);
      if ((await b.exec("test -d " + q(work), {})) !== 0) throw new Error("its folder is no longer on the Codespace (the Codespace was rebuilt or the run was already cleaned up)");
      return b;
    },
    close: () => {},
    notes: {
      start: (b) => `Using your Codespace ${chosen} (time limit ${Math.round(b.timeoutMs / 60_000)} minutes). It uses your own GitHub Codespaces allowance while it is on.`,
      end: (b, secs) => `Finished after ${secs} seconds; this run's folder on the Codespace was removed. The Codespace itself stays on until GitHub stops it after its idle time. Stop it now with: gh codespace stop -c ${b.id.split(":")[0]}`,
      detached: (n, timeoutMin) => `Started as remote run ${n} on your Codespace (time limit ${timeoutMin} minutes).\nIMPORTANT: GitHub stops a Codespace after its idle time when nobody is connected (30 minutes unless you changed it), and that stops this job too.\n  syok remote logs ${n}      see its output\n  syok remote stop ${n}      bring back results and remove the run's folder`,
      stopped: (n, _b, code) => `Remote run ${n}: stopped and its folder on the Codespace removed${code === null ? "" : " (the command had finished with exit code " + code + ")"}. The Codespace itself was left as it is.`,
    },
  };
}
