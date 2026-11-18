// Parallel editing: several workers change the project at the same time, each in its own copy, and the results are joined.
//
// How it is kept safe:
//  - Each copy is a git worktree made from a snapshot of the project exactly as it is now, uncommitted work included.
//    The snapshot is made with a private index, so your own staging area, branch and commits are never touched.
//  - The copies live inside the project's .git folder: your searches and "git status" do not see them, and a confined
//    command can still reach them (confinement hides the ordinary temporary folder).
//  - A worker's result is taken as one patch against the snapshot. Patches are put into your real folder one after
//    another. A patch that does not fit cleanly on top of the earlier ones is not applied at all, never half: the main
//    AI is told, gets the patch, and redoes that part on top.
//  - Every file a patch changes is recorded first, so /undo and /rewind put it back like any other edit.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx } from "./tools.ts";

export interface ParallelTask { name: string; task: string }
export interface WorkerRun { summary: string; steps: number; stopped: string }
export interface WorkerOutcome { name: string; task: string; status: "applied" | "no-changes" | "conflict" | "failed"; files: string[]; summary: string; steps: number; detail?: string; patch?: string }
export interface ParallelResult { ok: boolean; problem?: string; outcomes: WorkerOutcome[] }
export interface ParallelOpts {
  ctx: Ctx; tasks: ParallelTask[]; limit: number;
  /** Runs one worker in its own copy of the project. */
  runWorker: (root: string, t: ParallelTask) => Promise<WorkerRun>;
  log?: (s: string) => void;
}

export const DEFAULT_WORKERS = 2, MAX_WORKERS = 8;
/** How many workers may edit at once: 0 means the feature is off. */
export function workerLimit(s: { parallel_workers?: unknown }): number {
  const v = s.parallel_workers; if (v === undefined || v === null) return DEFAULT_WORKERS;
  if (v === false) return 0; if (v === true) return DEFAULT_WORKERS;
  const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(MAX_WORKERS, n)) : DEFAULT_WORKERS;
}
export const isGitProject = (root: string) => existsSync(join(root, ".git"));

const IDENT = { GIT_AUTHOR_NAME: "Syok Code", GIT_AUTHOR_EMAIL: "syok-code@localhost", GIT_COMMITTER_NAME: "Syok Code", GIT_COMMITTER_EMAIL: "syok-code@localhost" };
function git(cwd: string, args: string[], o: { env?: Record<string, string>; input?: string | Buffer } = {}): { code: number; out: string; err: string; buf: Buffer } {
  const r = spawnSync("git", ["-c", "core.quotepath=off", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "advice.detachedHead=false", ...args], { cwd, env: { ...process.env, ...IDENT, GIT_TERMINAL_PROMPT: "0", ...(o.env || {}) }, input: o.input, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const buf = (r.stdout as Buffer) || Buffer.alloc(0);
  return { code: r.error ? 127 : r.status ?? 1, out: buf.toString("utf8"), err: r.error ? String(r.error.message) : String(r.stderr || ""), buf };
}
const must = (r: { code: number; out: string; err: string }, what: string): string => { if (r.code !== 0) throw new Error(`${what}: ${(r.err || r.out).trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`); return r.out.trim(); };

/** Names safe for a folder: letters, digits and dashes; made unique. */
export function cleanNames(tasks: Array<{ name?: unknown; task?: unknown }>): ParallelTask[] {
  const seen = new Set<string>(); const out: ParallelTask[] = [];
  tasks.forEach((t, i) => {
    let n = String(t?.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || `worker-${i + 1}`;
    let k = n, j = 2; while (seen.has(k)) k = `${n}-${j++}`; seen.add(k);
    out.push({ name: k, task: String(t?.task ?? "").trim() });
  });
  return out;
}
/** What is wrong with a request, in words for the AI, or "" when it can run. */
export function requestProblem(ctx: Ctx, raw: unknown): string {
  if (ctx.depth > 0) return "Error: helpers cannot start parallel workers.";
  if (ctx.mode === "plan") return "Error: parallel workers change files, and this is planning mode.";
  if (workerLimit(ctx.settings) < 1) return "Error: parallel workers are switched off in the settings (parallel_workers is 0). Do the tasks one after another yourself.";
  if (!isGitProject(ctx.root)) return "Error: parallel workers need the project to be a git repository (each worker gets its own copy through git). This folder is not one. Do the tasks one after another yourself, or use delegate with role worker.";
  if (!Array.isArray(raw) || raw.length < 2) return "Error: give at least two tasks: [{\"name\":\"short-name\",\"task\":\"complete instructions\"}, ...]. For a single change use delegate with role worker, or do it yourself.";
  if (raw.length > MAX_WORKERS) return `Error: at most ${MAX_WORKERS} tasks at once.`;
  if (raw.some((t: any) => !t || typeof t.task !== "string" || t.task.trim().length < 10)) return "Error: every task needs complete instructions in \"task\" (the worker starts with an empty memory and sees nothing of this conversation).";
  return "";
}

const active = new Set<{ root: string; dir: string }>();
// Syok Code's own records (saved chats, saved jobs). A copy may write some while it works; they are never part of a worker's result.
const OWN = [":(exclude).syok/sessions", ":(exclude).syok/jobs"];
const DEPS = ["node_modules", ".venv", "venv"]; // big folders git ignores; a copy gets a link to the real one so tests can run
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } }
function removeRun(root: string, dir: string) {
  try { for (const n of existsSync(dir) ? readdirSync(dir) : []) { const p = join(dir, n); if (existsSync(join(p, ".git"))) git(root, ["worktree", "remove", "--force", p]); } } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  git(root, ["worktree", "prune"]);
}
/** Removes the copies of a run that is still open. Called when the program is stopped in the middle. */
export function cleanupParallel(): void { for (const a of [...active]) { removeRun(a.root, a.dir); active.delete(a); } }
/** Copies left behind by a run whose program is gone (a crash, a closed window). */
function removeStale(root: string, base: string) {
  if (!existsSync(base)) return;
  for (const n of readdirSync(base)) { const pid = Number(n.split("-")[0]); if (!pid || !alive(pid)) removeRun(root, join(base, n)); }
}

/** A commit of the project exactly as it is now (uncommitted and untracked work included; ignored files not). Nothing of yours changes. */
export function snapshotProject(root: string, gitDir: string, scratch: string): string {
  const idx = join(scratch, "index"); const real = must(git(root, ["rev-parse", "--git-path", "index"]), "git");
  const realAbs = resolve(root, real); if (existsSync(realAbs)) copyFileSync(realAbs, idx);
  const env = { GIT_INDEX_FILE: idx };
  must(git(root, ["add", "-A", "--", "."], { env }), "Could not take a snapshot of the project");
  const tree = must(git(root, ["write-tree"], { env }), "Could not take a snapshot of the project");
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const parents = head.code === 0 && head.out.trim() ? ["-p", head.out.trim()] : [];
  void gitDir;
  return must(git(root, ["commit-tree", tree, ...parents, "-m", "Syok Code: snapshot for parallel workers"]), "Could not take a snapshot of the project");
}
function makeCopy(root: string, dir: string, snap: string): string[] {
  must(git(root, ["worktree", "add", "--detach", "--force", dir, snap]), "Could not make a copy of the project");
  const linked: string[] = [];
  for (const d of DEPS) {
    const src = join(root, d), dst = join(dir, d);
    try { if (existsSync(src) && lstatSync(src).isDirectory() && !existsSync(dst)) { symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir"); linked.push(d); } } catch {}
  }
  return linked;
}
/** The worker's whole result as one patch against the snapshot, and the files in it. */
function collect(dir: string, snap: string, linked: string[]): { patch: Buffer; files: string[] } {
  must(git(dir, ["add", "-A", "--", "."]), "Could not read a worker's result");
  if (linked.length) git(dir, ["rm", "--cached", "-q", "-r", "--ignore-unmatch", "--", ...linked]);
  const tree = must(git(dir, ["write-tree"]), "Could not read a worker's result");
  const names = git(dir, ["diff", "--no-renames", "--name-only", "-z", snap, tree, "--", ".", ...OWN]);
  const files = names.out.split("\0").filter(Boolean);
  if (!files.length) return { patch: Buffer.alloc(0), files };
  const d = git(dir, ["diff", "--no-renames", "--binary", "--full-index", "--no-color", "--no-ext-diff", snap, tree, "--", ".", ...OWN]);
  if (d.code !== 0) throw new Error("Could not read a worker's result: " + d.err.slice(0, 300));
  return { patch: d.buf, files };
}
function remember(ctx: Ctx, rel: string) {
  if (ctx.snapshots.has(rel)) return; const abs = join(ctx.root, rel);
  let cur: string | null = null; try { if (existsSync(abs) && lstatSync(abs).isFile()) cur = readFileSync(abs, "utf8"); } catch {}
  ctx.snapshots.set(rel, cur);
}
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + "\n...[cut]");

export async function runParallel(o: ParallelOpts): Promise<ParallelResult> {
  const { ctx } = o; const root = ctx.root; const log = o.log || (() => {});
  const gd = git(root, ["rev-parse", "--absolute-git-dir"]);
  if (gd.code !== 0) return { ok: false, problem: gd.code === 127 ? "The git program was not found on this computer." : "This folder is not a git repository.", outcomes: [] };
  const gitDir = gd.out.trim(); const base = join(gitDir, "syok-parallel");
  removeStale(root, base);
  const dir = join(base, `${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true }); const run = { root, dir }; active.add(run);
  const outcomes: WorkerOutcome[] = o.tasks.map((t) => ({ name: t.name, task: t.task, status: "failed" as const, files: [], summary: "", steps: 0 }));
  try {
    let snap: string;
    try { snap = snapshotProject(root, gitDir, dir); } catch (e: any) { return { ok: false, problem: String(e?.message || e), outcomes: [] }; }
    const results: Array<{ patch: Buffer; files: string[] } | null> = o.tasks.map(() => null);
    // The workers, at most `limit` at a time.
    let next = 0; const limit = Math.max(1, Math.min(o.limit, o.tasks.length));
    const one = async () => {
      while (next < o.tasks.length) {
        const i = next++; const t = o.tasks[i]; const copy = join(dir, t.name);
        try {
          const linked = makeCopy(root, copy, snap);
          log(`[${t.name}] started in its own copy`);
          const r = await o.runWorker(copy, t);
          outcomes[i].summary = r.summary; outcomes[i].steps = r.steps;
          results[i] = collect(copy, snap, linked);
          log(`[${t.name}] done (${r.steps} steps, ${results[i]!.files.length} file${results[i]!.files.length === 1 ? "" : "s"} changed)`);
        } catch (e: any) { outcomes[i].status = "failed"; outcomes[i].detail = String(e?.message || e).slice(0, 500); log(`[${t.name}] failed: ${outcomes[i].detail}`); }
      }
    };
    await Promise.all(Array.from({ length: limit }, one));
    // Joining, in the order the tasks were given. All or nothing per worker.
    for (let i = 0; i < o.tasks.length; i++) {
      const r = results[i]; const out = outcomes[i]; if (!r) continue;
      out.files = r.files;
      if (!r.files.length) { out.status = "no-changes"; continue; }
      const pf = join(dir, `${o.tasks[i].name}.patch`); writeFileSync(pf, r.patch);
      const chk = git(root, ["apply", "--check", "--whitespace=nowarn", pf]);
      if (chk.code !== 0) {
        out.status = "conflict"; out.detail = chk.err.trim().split("\n").filter((l) => /^error:/.test(l)).map((l) => l.replace(/^error:\s*/, "")).slice(0, 8).join("; ").slice(0, 600) || chk.err.trim().slice(0, 300);
        out.patch = clip(r.patch.toString("utf8"), 6000); log(`[${o.tasks[i].name}] NOT joined: it overlaps with an earlier worker's change`); continue;
      }
      for (const f of r.files) remember(ctx, f);
      const ap = git(root, ["apply", "--whitespace=nowarn", pf]);
      if (ap.code !== 0) { out.status = "conflict"; out.detail = ap.err.trim().slice(0, 400); out.patch = clip(r.patch.toString("utf8"), 6000); continue; }
      for (const f of r.files) ctx.touched.add(f);
      out.status = "applied";
    }
    return { ok: true, outcomes };
  } finally { removeRun(root, dir); active.delete(run); }
}

/** The result in words for the main AI. */
export function describeParallel(r: ParallelResult): string {
  if (!r.ok) return "Error: parallel workers could not start: " + r.problem + " Do the tasks one after another yourself.";
  const L: string[] = []; const applied = r.outcomes.filter((x) => x.status === "applied"), conflicts = r.outcomes.filter((x) => x.status === "conflict"), failed = r.outcomes.filter((x) => x.status === "failed");
  L.push(`${r.outcomes.length} workers ran in separate copies. Joined into the project: ${applied.length}. Not joined: ${conflicts.length}. Failed: ${failed.length}. No changes: ${r.outcomes.length - applied.length - conflicts.length - failed.length}.`);
  for (const x of r.outcomes) {
    L.push("");
    if (x.status === "applied") L.push(`[${x.name}] JOINED (${x.steps} steps). Files: ${x.files.join(", ")}`);
    else if (x.status === "no-changes") L.push(`[${x.name}] made no changes (${x.steps} steps).`);
    else if (x.status === "failed") L.push(`[${x.name}] FAILED: ${x.detail}. Nothing of it is in the project. Its task: ${clip(x.task, 300)}`);
    else L.push(`[${x.name}] NOT JOINED: its change overlaps with a change joined before it (${x.detail}). Nothing of it is in the project. Redo this part yourself now, on top of the current files. Its task: ${clip(x.task, 300)}`);
    if (x.summary) L.push("Its report: " + clip(x.summary, 1200));
    if (x.status === "conflict" && x.patch) L.push("Its change, for reference (do not apply blindly; the files have moved on):\n" + x.patch);
  }
  if (applied.length) L.push("\nThe workers ran only their own checks, each in its own copy. Now check the joined result: run the project's tests yourself.");
  return L.join("\n");
}
