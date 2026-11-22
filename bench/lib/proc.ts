// Running a command with a hard time limit. On timeout the WHOLE process group is killed (the tool and every
// command it started), so a hung agent cannot keep running or keep spending money after the limit.
import { spawn, spawnSync } from "node:child_process";

export interface RunResult { code: number | null; timedOut: boolean; stdout: string; stderr: string; ms: number }
export interface RunOpts { cwd: string; timeoutMs: number; env?: Record<string, string | undefined>; stdin?: string; maxBytes?: number }

const MAX = 8 * 1024 * 1024;
export function run(cmd: string[], o: RunOpts): Promise<RunResult> {
  const t0 = Date.now(), maxBytes = o.maxBytes ?? MAX;
  return new Promise((resolve) => {
    let out = "", err = "", timedOut = false, done = false;
    let p;
    try {
      p = spawn(cmd[0], cmd.slice(1), { cwd: o.cwd, env: { ...process.env, ...(o.env || {}) } as any, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e: any) { resolve({ code: 127, timedOut: false, stdout: "", stderr: String(e?.message || e), ms: 0 }); return; }
    const kill = () => {
      if (p.pid === undefined) return;
      if (process.platform === "win32") { spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true }); return; }
      try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    p.stdout.on("data", (d: Buffer) => { if (out.length < maxBytes) out += d.toString(); });
    p.stderr.on("data", (d: Buffer) => { if (err.length < maxBytes) err += d.toString(); });
    p.on("error", (e: any) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: 127, timedOut, stdout: out, stderr: err + String(e?.message || e), ms: Date.now() - t0 }); });
    p.on("close", (code: number | null) => {
      if (done) return; done = true; clearTimeout(timer);
      if (!timedOut) kill(); // anything the tool left running in the background is stopped too
      resolve({ code, timedOut, stdout: out, stderr: err, ms: Date.now() - t0 });
    });
    if (o.stdin !== undefined) p.stdin.end(o.stdin); else p.stdin.end();
  });
}
/** A shell command line (bash -lc on Mac/Linux). */
export const sh = (command: string, o: RunOpts) => run(process.platform === "win32" ? ["cmd", "/c", command] : ["bash", "-c", command], o);
/** Is a program on PATH? */
export function onPath(bin: string): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8", windowsHide: true });
  return r.status === 0 && !!r.stdout.trim();
}
export const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
