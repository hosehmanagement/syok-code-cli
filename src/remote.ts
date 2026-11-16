// "syok run --on <where> -- <command>": send a heavy job to a rented cloud computer, stream its output back, bring results home.
// This file is the part that does not depend on any one cloud. A provider (src/remote-modal.ts) only has to hand over a "box":
// a remote computer that can receive a file, run a command and give a file back.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, lstatSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve, sep, relative } from "node:path";
import { tmpdir } from "node:os";
import { isProtected, DENY } from "./perm.ts";

export interface Box {
  id: string;
  /** Copy one local file to the remote computer. */
  upload(localFile: string, remotePath: string): Promise<void>;
  /** Copy one remote file to this computer. */
  download(remotePath: string, localFile: string): Promise<void>;
  /** Run a shell command line there. Output arrives as it is produced. Resolves with the exit code. */
  exec(command: string, o: { cwd?: string; onOut?: (s: string) => void; onErr?: (s: string) => void; timeoutMs?: number }): Promise<number>;
  /** Switch the remote computer off (stops the billing), or for a computer the user keeps, clean up this run's folder. */
  terminate(): Promise<void>;
  /** The folder on the remote computer where the project is placed. Default /work. */
  work?: string;
}
export interface BoxOptions { image: string; gpu?: string; cpu?: number; memoryMiB?: number; timeoutMs: number }
export interface Provider {
  name: string;
  /** Returns a sentence for the user when this provider cannot be used yet (for example no account token), else null. */
  problem(): Promise<string | null>;
  create(o: BoxOptions): Promise<Box>;
  attach(id: string): Promise<Box>;
  /** Close network connections so the program can exit. */
  close(): void;
  /** Options this provider cannot honour (the run is refused with a clear message instead of ignoring them). */
  unsupported?: Array<"gpu" | "image" | "cpu" | "memory">;
  /** Wording for a provider that is not a rented, switched-off-afterwards computer (for example the user's own Codespace). */
  notes?: { start(o: BoxOptions): string; end(box: Box, seconds: number): string; detached?(n: number, timeoutMin: number): string; stopped?(n: number, box: Box, code: number | null): string };
}

export const WORK = "/work";
const workOf = (b: Box) => b.work || WORK;
const runDirOf = (b: Box) => workOf(b) + "/.syok-run"; // where a detached run keeps its log and exit code
const tmpOf = (b: Box, name: string) => (b.work ? b.work + ".tmp-" + name : "/tmp/syok-" + name);
export const MAX_UPLOAD = 200 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".syok", ".pytest_cache", ".mypy_cache", ".next", ".turbo", ".cache", "target"]);
const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

// ---------- choosing what to send ----------
export interface Picked { files: string[]; bytes: number; skippedSecrets: string[]; skippedBig: string[] }
/** The project's files, without dependency folders, without git history and never with secret files (.env, keys). */
export function pickFiles(root: string, o: { maxFile?: number; limit?: number } = {}): Picked {
  const out: Picked = { files: [], bytes: 0, skippedSecrets: [], skippedBig: [] };
  const maxFile = o.maxFile ?? 100 * 1024 * 1024, limit = o.limit ?? 20000;
  const tracked = gitFiles(root);
  const consider = (rel: string) => {
    if (out.files.length >= limit) return;
    const abs = join(root, rel); let st;
    try { st = lstatSync(abs); } catch { return; }
    if (!st.isFile()) return; // folders are walked; links and special files are not sent
    const unix = rel.split(sep).join("/");
    if (isProtected(unix) && !/(^|\/)\.github\/workflows\//.test(unix)) { out.skippedSecrets.push(unix); return; }
    if (st.size > maxFile) { out.skippedBig.push(unix); return; }
    out.files.push(unix); out.bytes += st.size;
  };
  if (tracked) { for (const f of tracked) if (!f.split("/").some((p) => p === ".git" || p === ".syok")) consider(f.split("/").join(sep)); }
  else {
    const walk = (dir: string) => {
      let names: string[]; try { names = readdirSync(dir).sort(); } catch { return; }
      for (const n of names) {
        const abs = join(dir, n); let st; try { st = lstatSync(abs); } catch { continue; }
        if (st.isDirectory()) { if (!SKIP_DIRS.has(n)) walk(abs); } else consider(relative(root, abs));
      }
    };
    walk(root);
  }
  return out;
}
/** In a git project: tracked files plus new files that .gitignore does not hide. Null when this is not a git project. */
function gitFiles(root: string): string[] | null {
  if (!existsSync(join(root, ".git"))) return null;
  const r = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.split("\0").filter(Boolean);
}
/** Pack the chosen files into one .tgz with the system's tar program (present on Mac, Linux and Windows 10+). */
export function packFiles(root: string, files: string[], outFile: string): void {
  const list = outFile + ".list";
  writeFileSync(list, files.join("\n") + (files.length ? "\n" : ""));
  const r = spawnSync("tar", ["-czf", outFile, "-C", root, "-T", list], { encoding: "utf8", windowsHide: true });
  try { rmSync(list, { force: true }); } catch {}
  if (r.error) throw new Error("the 'tar' program is needed to pack the project, and it could not be started (" + r.error.message + ")");
  if (r.status !== 0) throw new Error("could not pack the project: " + String(r.stderr || "").trim().slice(0, 300));
}

// ---------- options ----------
export interface RunOptions { root: string; command: string; image?: string; gpu?: string; cpu?: number; memoryMiB?: number; timeoutMin?: number; upload?: boolean; out?: string; detach?: boolean }
export function defaultImage(root: string): string {
  if (existsSync(join(root, "package.json")) && !existsSync(join(root, "requirements.txt")) && !existsSync(join(root, "pyproject.toml"))) return "node:22-slim";
  return "python:3.12-slim";
}
/** Problems with what the user asked for, in plain words (empty = fine). Nothing is rented when this returns something. */
export function optionProblems(o: RunOptions): string[] {
  const p: string[] = [];
  if (!o.command.trim()) p.push('Give the command to run after "--", for example: syok run --on modal -- python train.py');
  if (DENY.some((r) => r.test(o.command))) p.push("That command is blocked by Syok Code's safety rules.");
  if (o.timeoutMin !== undefined && !(o.timeoutMin >= 1 && o.timeoutMin <= 1440)) p.push("--timeout is in minutes, from 1 to 1440 (24 hours).");
  if (o.image !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,199}$/.test(o.image)) p.push("--image must be a container image name such as python:3.12-slim.");
  if (o.gpu !== undefined && !/^[A-Za-z0-9-]{1,20}(:\d)?$/.test(o.gpu)) p.push("--gpu must be a GPU name such as T4, L4, A10 or A100 (optionally with a count, like T4:2).");
  if (o.out !== undefined) {
    const abs = resolve(o.root, o.out);
    if (!o.out || o.out.startsWith("/") || /^[A-Za-z]:/.test(o.out) || o.out.split(/[\\/]/).includes("..") || (abs !== o.root && !abs.startsWith(o.root + sep)) || abs === o.root) p.push("--out must be a folder inside the project, for example: --out results");
  }
  return p;
}

// ---------- the run ----------
export interface RunResult { exitCode: number; boxId: string; seconds: number; detached?: number; downloaded?: number; note?: string }
export interface RunIO { log: (s: string) => void; out: (s: string) => void; err: (s: string) => void; onBox?: (b: Box) => void }

async function prepare(box: Box, o: RunOptions, io: RunIO): Promise<void> {
  const mk = await box.exec("mkdir -p " + q(workOf(box)), {});
  if (mk !== 0) throw new Error("could not create the work folder on the remote computer");
  if (o.upload === false) return;
  const picked = pickFiles(o.root);
  if (picked.skippedSecrets.length) io.log(`Not sent (secret files stay on your computer): ${picked.skippedSecrets.slice(0, 8).join(", ")}${picked.skippedSecrets.length > 8 ? " and " + (picked.skippedSecrets.length - 8) + " more" : ""}`);
  if (picked.skippedBig.length) io.log(`Not sent (larger than 100 MB each): ${picked.skippedBig.slice(0, 5).join(", ")}`);
  if (picked.bytes > MAX_UPLOAD) throw new Error(`the project is ${(picked.bytes / 1048576).toFixed(0)} MB, more than the 200 MB that can be sent. Add big folders to .gitignore, or use --no-upload and fetch the data inside your command.`);
  if (!picked.files.length) { io.log("No project files to send."); return; }
  const tmp = mkdtempSync(join(tmpdir(), "syok-run-")); const tgz = join(tmp, "project.tgz");
  try {
    packFiles(o.root, picked.files, tgz);
    io.log(`Sending ${picked.files.length} files (${(statSync(tgz).size / 1048576).toFixed(1)} MB packed)...`);
    const remoteTgz = tmpOf(box, "project.tgz");
    await box.upload(tgz, remoteTgz);
    const ex = await box.exec("tar -xzf " + q(remoteTgz) + " -C " + q(workOf(box)) + " && rm -f " + q(remoteTgz), { onErr: io.err });
    if (ex !== 0) throw new Error("could not unpack the project on the remote computer (the image needs the tar and gzip programs)");
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
}

/** Bring one remote folder (inside the work folder) back into the same folder of the project. Returns the number of files. */
export async function fetchOut(box: Box, root: string, out: string, io: Pick<RunIO, "log" | "err">): Promise<number> {
  const rel = out.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const remoteOut = tmpOf(box, "out.tgz");
  const has = await box.exec("test -d " + q(workOf(box) + "/" + rel), {});
  if (has !== 0) { io.log(`Nothing to bring back: the command did not create the folder "${rel}".`); return 0; }
  const pack = await box.exec("tar -czf " + q(remoteOut) + " -C " + q(workOf(box)) + " " + q(rel), { onErr: io.err });
  if (pack !== 0) throw new Error("could not pack the results on the remote computer");
  const tmp = mkdtempSync(join(tmpdir(), "syok-out-")); const tgz = join(tmp, "out.tgz");
  try {
    await box.download(remoteOut, tgz);
    // Look before unpacking: refuse anything that would land outside the chosen folder, and never overwrite secret files.
    const names = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (names.status !== 0) throw new Error("the results archive could not be read");
    const list = names.stdout.split("\n").filter(Boolean);
    const bad = list.find((n) => n.startsWith("/") || n.split("/").includes("..") || !(n === rel || n === rel + "/" || n.startsWith(rel + "/")) || isProtected(n));
    if (bad) throw new Error(`the results contain a path that is not allowed (${bad.slice(0, 120)}), so nothing was unpacked`);
    mkdirSync(root, { recursive: true });
    const ex = spawnSync("tar", ["-xzf", tgz, "-C", root, "--no-same-owner"], { encoding: "utf8", windowsHide: true });
    if (ex.status !== 0) throw new Error("could not unpack the results: " + String(ex.stderr || "").trim().slice(0, 200));
    const n = list.filter((x) => !x.endsWith("/")).length;
    io.log(`Brought back ${n} file${n === 1 ? "" : "s"} into ${rel}/`);
    return n;
  } finally { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
}

/** Run the user's command line in bash when the image has it, else in plain sh. */
const shellLine = (cmd: string) => `if command -v bash >/dev/null 2>&1; then exec bash -lc ${q(cmd)}; else exec sh -c ${q(cmd)}; fi`;

/** One line that starts the command in its own session (so it survives when this connection closes), logging to a file and saving its exit code. */
export function detachLine(cmd: string, work: string = WORK, maxSeconds = 0): string {
  const dir = work + "/.syok-run";
  // A time limit kept by the remote computer itself (exit code 124), for computers that are not switched off by their cloud.
  const limited = maxSeconds > 0 ? `if command -v timeout >/dev/null 2>&1; then timeout -k 10 ${Math.floor(maxSeconds)} sh -c ${q(shellLine(cmd))}; else sh -c ${q(shellLine(cmd))}; fi` : `sh -c ${q(shellLine(cmd))}`;
  const inner = `(${limited}) > ${q(dir + "/log")} 2>&1; echo $? > ${q(dir + "/code")}`;
  return `mkdir -p ${q(dir)} && cd ${q(work)} && rm -f ${q(dir + "/code")} && if command -v setsid >/dev/null 2>&1; then setsid nohup sh -c ${q(inner)} > /dev/null 2>&1 < /dev/null & else nohup sh -c ${q(inner)} > /dev/null 2>&1 < /dev/null & fi; echo started`;
}

export async function remoteRun(p: Provider, o: RunOptions, io: RunIO): Promise<RunResult> {
  const problems = optionProblems(o);
  if (problems.length) throw new Error(problems.join("\n"));
  const given: Record<string, unknown> = { gpu: o.gpu, image: o.image, cpu: o.cpu, memory: o.memoryMiB };
  const no = (p.unsupported || []).filter((k) => given[k] !== undefined);
  if (no.length) throw new Error(`${no.map((k) => "--" + k).join(" and ")} cannot be used with ${p.name}: its size and software are whatever that computer already has.`);
  const why = await p.problem(); if (why) throw new Error(why);
  const timeoutMin = o.timeoutMin ?? 60, image = o.image || defaultImage(o.root), t0 = Date.now();
  const boxOpts: BoxOptions = { image, gpu: o.gpu, cpu: o.cpu, memoryMiB: o.memoryMiB, timeoutMs: timeoutMin * 60_000 };
  io.log(p.notes ? p.notes.start(boxOpts) : `Renting a computer on ${p.name} (image ${image}${o.gpu ? ", GPU " + o.gpu : ""}, switched off after at most ${timeoutMin} minutes). ${p.name} bills your own account while it is on.`);
  const box = await p.create(boxOpts);
  io.onBox?.(box);
  let keep = false;
  try {
    await prepare(box, o, io);
    if (o.detach) {
      // Start the command so that it keeps going after this program leaves: its output goes to a log file, its exit code to another.
      const start = detachLine(o.command, workOf(box), p.notes ? timeoutMin * 60 : 0);
      const ex = await box.exec(start, { onErr: io.err });
      if (ex !== 0) throw new Error("could not start the command on the remote computer");
      const n = saveRun(o.root, { provider: p.name, boxId: box.id, command: o.command, started: Date.now(), timeoutMin, image, gpu: o.gpu, out: o.out });
      keep = true;
      io.log(p.notes?.detached ? p.notes.detached(n, timeoutMin) : `Started as remote run ${n}. It keeps running (and billing) until it finishes and you stop it, or ${timeoutMin} minutes pass.\n  syok remote logs ${n}      see its output\n  syok remote stop ${n}      bring back results${o.out ? ` (${o.out}/)` : ""} and switch the computer off`);
      return { exitCode: 0, boxId: box.id, seconds: Math.round((Date.now() - t0) / 1000), detached: n };
    }
    io.log("Running: " + o.command + "\n");
    const exitCode = await box.exec(shellLine(o.command), { cwd: workOf(box), onOut: io.out, onErr: io.err, timeoutMs: timeoutMin * 60_000 });
    let downloaded: number | undefined, note: string | undefined;
    if (o.out) { try { downloaded = await fetchOut(box, o.root, o.out, io); } catch (e: any) { note = "The results could not be brought back: " + (e?.message || e); io.err(note + "\n"); } }
    return { exitCode, boxId: box.id, seconds: Math.round((Date.now() - t0) / 1000), downloaded, note };
  } finally {
    if (!keep) { try { await box.terminate(); const secs = Math.round((Date.now() - t0) / 1000); io.log("\n" + (p.notes ? p.notes.end(box, secs) : `Remote computer switched off after ${secs} seconds.`)); } catch (e: any) { io.err(`\nWARNING: the remote computer (${box.id}) may still be on and billing: ${e?.message || e}. Switch it off in your ${p.name} dashboard.\n`); } }
  }
}

// ---------- detached runs: a small record per run in <project>/.syok/remote ----------
export interface RunRecord { provider: string; boxId: string; command: string; started: number; timeoutMin: number; image: string; gpu?: string; out?: string; stopped?: number; exitCode?: number | null }
const recDir = (root: string) => join(root, ".syok", "remote");
export function saveRun(root: string, r: RunRecord): number {
  const d = recDir(root); mkdirSync(d, { recursive: true });
  const n = Math.max(0, ...readdirSync(d).map((f) => +(/^(\d+)\.json$/.exec(f)?.[1] ?? 0))) + 1;
  writeFileSync(join(d, n + ".json"), JSON.stringify(r, null, 2));
  return n;
}
export function readRun(root: string, n: number): RunRecord | null { try { return JSON.parse(readFileSync(join(recDir(root), n + ".json"), "utf8")); } catch { return null; } }
function writeRun(root: string, n: number, r: RunRecord) { writeFileSync(join(recDir(root), n + ".json"), JSON.stringify(r, null, 2)); }
export function listRuns(root: string): Array<{ n: number; r: RunRecord }> {
  let names: string[]; try { names = readdirSync(recDir(root)); } catch { return []; }
  return names.map((f) => +(/^(\d+)\.json$/.exec(f)?.[1] ?? 0)).filter(Boolean).sort((a, b) => a - b).map((n) => ({ n, r: readRun(root, n)! })).filter((x) => x.r);
}
export function describeRuns(root: string, now = Date.now()): string {
  const runs = listRuns(root);
  if (!runs.length) return "No remote runs. Start one with: syok run --on modal --detach -- <command>";
  return runs.map(({ n, r }) => {
    const mins = Math.round(((r.stopped ?? now) - r.started) / 60_000);
    const state = r.stopped ? `stopped${r.exitCode === null || r.exitCode === undefined ? "" : ", exit code " + r.exitCode}` : now - r.started > r.timeoutMin * 60_000 ? `time limit reached (${r.timeoutMin} min), switched off by ${r.provider}` : `on for ${mins} min of at most ${r.timeoutMin} (billing)`;
    return `  ${n}: ${r.command.slice(0, 70)}  [${r.provider}${r.gpu ? " " + r.gpu : ""}] ${state}`;
  }).join("\n");
}
/** The state of a detached run: its exit code when it has finished, else null. */
async function runState(box: Box): Promise<number | null> {
  let code = ""; const ex = await box.exec(`cat ${q(runDirOf(box) + "/code")} 2>/dev/null`, { onOut: (s) => (code += s) });
  return ex === 0 && /^\d+\s*$/.test(code) ? +code : null;
}
export async function remoteLogs(p: Provider, root: string, n: number, io: RunIO, o: { tail?: number } = {}): Promise<{ finished: boolean; exitCode: number | null }> {
  const r = readRun(root, n); if (!r) throw new Error(`There is no remote run ${n}. See: syok remote`);
  if (r.stopped) throw new Error(`Remote run ${n} was stopped and its computer is gone, so its log is no longer there.`);
  const box = await attachOr(p, r, n);
  const tail = Math.max(1, Math.min(100000, Math.floor(o.tail || 200)));
  await box.exec(`tail -n ${tail} ${q(runDirOf(box) + "/log")} 2>/dev/null`, { onOut: io.out, onErr: io.err });
  const code = await runState(box);
  io.log(code === null ? `\n[still running; syok remote stop ${n} switches the computer off]` : `\n[finished, exit code ${code}; the computer is still on until you run: syok remote stop ${n}]`);
  return { finished: code !== null, exitCode: code };
}
export async function remoteStop(p: Provider, root: string, n: number, io: RunIO): Promise<{ exitCode: number | null; downloaded?: number }> {
  const r = readRun(root, n); if (!r) throw new Error(`There is no remote run ${n}. See: syok remote`);
  if (r.stopped) { io.log(`Remote run ${n} was already stopped.`); return { exitCode: r.exitCode ?? null }; }
  let box: Box;
  try { box = await attachOr(p, r, n); }
  catch (e: any) { writeRun(root, n, { ...r, stopped: Date.now(), exitCode: null }); io.log(`Remote run ${n}: its computer could not be reached (${e?.message || e}). It has most likely been switched off already (time limit). Marked as stopped.`); return { exitCode: null }; }
  let code: number | null = null, downloaded: number | undefined;
  try {
    code = await runState(box);
    if (code === null) io.log("The command was still running; it is being stopped.");
    if (r.out) { try { downloaded = await fetchOut(box, root, r.out, io); } catch (e: any) { io.err("The results could not be brought back: " + (e?.message || e) + "\n"); } }
  } finally {
    await box.terminate();
    writeRun(root, n, { ...r, stopped: Date.now(), exitCode: code });
    io.log(p.notes?.stopped ? p.notes.stopped(n, box, code) : `Remote run ${n}: computer switched off${code === null ? "" : " (the command had finished with exit code " + code + ")"}.`);
  }
  return { exitCode: code, downloaded };
}
async function attachOr(p: Provider, r: RunRecord, n: number): Promise<Box> {
  if (r.provider !== p.name) throw new Error(`Remote run ${n} was started on ${r.provider}, not ${p.name}.`);
  const why = await p.problem(); if (why) throw new Error(why);
  return p.attach(r.boxId);
}
