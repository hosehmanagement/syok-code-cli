// Persistent jobs: long scripts that keep running after Syok Code exits.
// Each job lives in <project>/.syok/jobs/<id>/ : meta.json, out.log (everything it printed), child.pid, code (exit code, written when it ends).
// A small runner (this same program, started as "__jobrun") starts the command, sends its output to out.log and writes the exit code.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, openSync, closeSync, statSync, readSync } from "node:fs";
import { join } from "node:path";
import { spawnCommand, cleanEnv } from "./shell.ts";
import { getConfine, setConfine } from "./confine.ts";

export interface JobMeta { id: number; cmd: string; cwd: string; started: number; runner: number; maxSec: number }
export interface JobInfo extends JobMeta { state: "running" | "finished" | "lost"; code: number | null }

export const jobsDir = (root: string) => join(root, ".syok", "jobs");
const dirOf = (root: string, id: number) => join(jobsDir(root), String(id));
const num = (p: string): number | null => { try { const n = parseInt(readFileSync(p, "utf8").trim(), 10); return Number.isFinite(n) ? n : null; } catch { return null; } };

export function alive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}
function killPid(pid: number | null) {
  if (!pid) return;
  if (process.platform === "win32") { try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }); } catch {} return; }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

/** Start a command that survives this program exiting. maxSec 0 = no time limit. */
/** How to start this same program again. A compiled program (no Bun installed) is its own file, so it needs no script path. */
export function selfArgs(argv1: string, entry?: string): string[] {
  if (entry) return [entry];
  return /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(argv1) ? [] : [argv1];
}

export function startJob(root: string, cmd: string, maxSec = 0): number {
  mkdirSync(jobsDir(root), { recursive: true });
  const ids = readdirSync(jobsDir(root)).map((n) => parseInt(n, 10)).filter(Number.isFinite);
  const id = (ids.length ? Math.max(...ids) : 0) + 1;
  const dir = dirOf(root, id); mkdirSync(dir, { recursive: true });
  const meta: JobMeta = { id, cmd, cwd: root, started: Date.now(), runner: 0, maxSec };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "out.log"), "");
  // The runner is this same program started again. SYOK_ENTRY names the program file when it is not the one that is running (tests, embedding).
  // A saved job keeps the confinement it was started under: the runner is told through its environment.
  const conf = getConfine();
  const runner = spawn(process.execPath, [...selfArgs(process.argv[1] || "", process.env.SYOK_ENTRY), "__jobrun", dir], { detached: process.platform !== "win32", stdio: "ignore", windowsHide: true, env: { ...process.env, SYOK_CONFINE_PLAN: conf ? JSON.stringify(conf) : "" } });
  runner.unref();
  meta.runner = runner.pid || 0;
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  return id;
}

/** The runner process: run the command, log its output, write the exit code. */
export async function runJobRunner(dir: string): Promise<number> {
  const meta: JobMeta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  if (process.env.SYOK_CONFINE_PLAN) { try { setConfine(JSON.parse(process.env.SYOK_CONFINE_PLAN)); } catch { writeFileSync(join(dir, "out.log"), "Could not start: the confinement of this job could not be read, so it was not run.\n", { flag: "a" }); writeFileSync(join(dir, "code"), "126"); return 126; } }
  const env = cleanEnv(); delete env.SYOK_CONFINE_PLAN;
  const fd = openSync(join(dir, "out.log"), "a");
  return await new Promise<number>((done) => {
    let finished = false;
    const end = (code: number) => { if (finished) return; finished = true; try { closeSync(fd); } catch {} writeFileSync(join(dir, "code"), String(code)); done(code); };
    let child;
    try { child = spawnCommand(meta.cmd, meta.cwd, env, ["ignore", fd as any, fd as any]); }
    catch (e: any) { writeFileSync(join(dir, "out.log"), "Could not start: " + e.message + "\n", { flag: "a" }); return end(127); }
    if (child.pid) writeFileSync(join(dir, "child.pid"), String(child.pid));
    let timer: any = null;
    if (meta.maxSec > 0) timer = setTimeout(() => { killPid(child.pid || null); try { writeFileSync(join(dir, "out.log"), `\n[stopped after ${meta.maxSec} seconds]\n`, { flag: "a" }); } catch {} end(124); }, meta.maxSec * 1000);
    child.on("error", (e) => { try { writeFileSync(join(dir, "out.log"), "\n" + e.message + "\n", { flag: "a" }); } catch {} if (timer) clearTimeout(timer); end(127); });
    child.on("close", (c) => { if (timer) clearTimeout(timer); end(c ?? 1); });
  });
}

export function jobInfo(root: string, id: number): JobInfo | null {
  const dir = dirOf(root, id);
  let meta: JobMeta; try { meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return null; }
  const code = num(join(dir, "code"));
  if (code !== null) return { ...meta, state: "finished", code };
  return { ...meta, state: alive(meta.runner) ? "running" : "lost", code: null };
}
export function listJobs(root: string): JobInfo[] {
  if (!existsSync(jobsDir(root))) return [];
  return readdirSync(jobsDir(root)).map((n) => parseInt(n, 10)).filter(Number.isFinite).sort((a, b) => a - b).map((i) => jobInfo(root, i)).filter(Boolean) as JobInfo[];
}
export function describeJobs(root: string): string {
  const js = listJobs(root);
  if (!js.length) return "No saved jobs. The AI starts one with job_start; they keep running after Syok Code exits and are listed here.";
  return js.map((j) => `  ${j.id}: ${j.cmd.slice(0, 70)}  (${j.state === "finished" ? "finished, exit code " + j.code : j.state === "running" ? "running since " + new Date(j.started).toISOString().slice(0, 19).replace("T", " ") : "stopped without an exit code"})`).join("\n");
}
export function jobLog(root: string, id: number, tail = 4000): string {
  const j = jobInfo(root, id); if (!j) return `Error: no saved job ${id}.`;
  const p = join(dirOf(root, id), "out.log");
  let text = "";
  try {
    const size = statSync(p).size, len = Math.min(size, Math.max(200, tail));
    const buf = Buffer.alloc(len); const fd = openSync(p, "r"); try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    text = buf.toString("utf8");
  } catch {}
  const state = j.state === "running" ? "[still running]" : j.state === "finished" ? `[finished, exit code ${j.code}]` : "[stopped without an exit code (killed or the computer restarted)]";
  return (text || "(no output yet)") + "\n" + state;
}
export function stopJob(root: string, id: number): string {
  const j = jobInfo(root, id); if (!j) return `Error: no saved job ${id}.`;
  if (j.state !== "running") return `Job ${id} is not running.`;
  const dir = dirOf(root, id);
  killPid(num(join(dir, "child.pid"))); killPid(j.runner);
  if (!existsSync(join(dir, "code"))) writeFileSync(join(dir, "code"), "-9");
  return `Stopped job ${id}.`;
}
