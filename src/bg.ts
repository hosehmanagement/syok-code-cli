// Background jobs: long-running commands (dev servers, watchers) the AI can start, read and stop.
import { spawn, type ChildProcess } from "node:child_process";
interface Job { id: number; cmd: string; proc: ChildProcess; out: string; code: number | null; started: number }
export class Bg {
  jobs = new Map<number, Job>(); n = 0;
  start(cmd: string, cwd: string): number {
    const env = { ...process.env }; delete env.SYOK_API_KEY; delete env.GITHUB_TOKEN;
    const proc = spawn("bash", ["-lc", cmd], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const j: Job = { id: ++this.n, cmd, proc, out: "", code: null, started: Date.now() };
    const add = (d: Buffer) => { j.out += d.toString(); if (j.out.length > 200_000) j.out = j.out.slice(-100_000); };
    proc.stdout!.on("data", add); proc.stderr!.on("data", add);
    proc.on("close", (c) => { j.code = c ?? -1; }); proc.on("error", (e) => { j.out += "\n" + e.message; j.code = -1; });
    this.jobs.set(j.id, j); return j.id;
  }
  output(id: number, tail = 4000): string {
    const j = this.jobs.get(id); if (!j) return `Error: no background job ${id}.`;
    return (j.out.slice(-tail) || "(no output yet)") + (j.code === null ? "\n[still running]" : `\n[finished, exit code ${j.code}]`);
  }
  stop(id: number): string {
    const j = this.jobs.get(id); if (!j) return `Error: no background job ${id}.`;
    if (j.code === null) { try { process.kill(-j.proc.pid!, "SIGKILL"); } catch { try { j.proc.kill("SIGKILL"); } catch {} } j.code = -9; }
    return `Stopped job ${id}.`;
  }
  list(): string { return [...this.jobs.values()].map((j) => `${j.id}: ${j.cmd.slice(0, 80)} (${j.code === null ? "running" : "exit " + j.code})`).join("\n") || "No background jobs."; }
  stopAll() { for (const id of this.jobs.keys()) this.stop(id); }
}
