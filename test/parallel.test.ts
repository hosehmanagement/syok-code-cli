// Parallel editing: workers in separate copies, joined afterwards. Real git, real files; the workers are scripted.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpProject, call } from "./helpers.ts";
import { runParallel, describeParallel, requestProblem, cleanNames, workerLimit, cleanupParallel, type ParallelTask } from "../src/parallel.ts";
import { makeCtx, toolDefs, undoAll } from "../src/tools.ts";
import { runAgent } from "../src/agent.ts";
import { DEFAULT } from "../src/profiles.ts";

const G = (cwd: string, ...a: string[]) => { const r = spawnSync("git", ["-c", "core.autocrlf=false", ...a], { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
function repo(files: Record<string, string>, commit = true) {
  const d = tmpProject(files); G(d, "init", "-q", "-b", "main"); G(d, "config", "user.email", "t@example.com"); G(d, "config", "user.name", "T"); G(d, "config", "commit.gpgsign", "false");
  if (commit) { G(d, "add", "-A"); G(d, "commit", "-q", "-m", "first"); }
  return d;
}
const status = (d: string) => spawnSync("git", ["status", "--porcelain"], { cwd: d, encoding: "utf8" }).stdout.replace(/\n$/, "");
const ctxOf = (d: string, mode: any = "auto", settings: any = {}) => makeCtx(d, mode, async () => true, settings, DEFAULT);
const T = (...names: string[]): ParallelTask[] => names.map((n) => ({ name: n, task: "do the " + n + " part of the work" }));
const read = (d: string, f: string) => readFileSync(join(d, f), "utf8");
/** Nothing of a run may stay behind: no extra worktree, no copy folder. */
function expectClean(d: string) {
  expect(G(d, "worktree", "list").split("\n").length).toBe(1);
  const base = join(d, ".git", "syok-parallel"); expect(existsSync(base) ? readdirSync(base) : []).toEqual([]);
}
const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

test("two workers change different files: both are joined, as ordinary uncommitted edits; nothing of yours in git moves", async () => {
  const d = repo({ "a.txt": "a1\n", "b.txt": "b1\n", "c.txt": "c1\n" }); const head = G(d, "rev-parse", "HEAD"); const ctx = ctxOf(d);
  const roots: string[] = [];
  const r = await runParallel({ ctx, tasks: T("one", "two"), limit: 2, runWorker: async (root, t) => {
    roots.push(root); expect(root).not.toBe(d); expect(read(root, "c.txt")).toBe("c1\n");
    writeFileSync(join(root, t.name === "one" ? "a.txt" : "b.txt"), t.name + " was here\n"); return { summary: t.name + " done", steps: 3, stopped: "finished" };
  } });
  expect(r.ok).toBe(true); expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "applied"]); expect(r.outcomes.map((x) => x.files)).toEqual([["a.txt"], ["b.txt"]]);
  expect(read(d, "a.txt")).toBe("one was here\n"); expect(read(d, "b.txt")).toBe("two was here\n"); expect(read(d, "c.txt")).toBe("c1\n");
  expect(G(d, "rev-parse", "HEAD")).toBe(head); expect(G(d, "branch", "--show-current")).toBe("main");
  expect(G(d, "diff", "--cached", "--name-only")).toBe(""); expect(status(d).split("\n").sort()).toEqual([" M a.txt", " M b.txt"]);
  expect(new Set(roots).size).toBe(2); expectClean(d);
  expect([...ctx.touched].sort()).toEqual(["a.txt", "b.txt"]);
  expect(undoAll(ctx).sort()).toEqual(["a.txt", "b.txt"]); expect(read(d, "a.txt")).toBe("a1\n"); expect(read(d, "b.txt")).toBe("b1\n"); // /undo takes it all back
  const text = describeParallel(r); expect(text).toContain("[one] JOINED"); expect(text).toContain("Its report: two done"); expect(text).toContain("run the project's tests yourself");
});

test("the copies start from the project as it is NOW: uncommitted, staged and brand-new files included, and your staging stays as it was", async () => {
  const d = repo({ "a.txt": "a1\n", "b.txt": "b1\n", ".gitignore": "secret.env\n" });
  writeFileSync(join(d, "a.txt"), "a2 not committed\n"); writeFileSync(join(d, "b.txt"), "b2 staged\n"); G(d, "add", "b.txt");
  writeFileSync(join(d, "new.txt"), "brand new\n"); writeFileSync(join(d, "secret.env"), "KEY=1\n");
  const before = status(d);
  const seen: Record<string, any> = {};
  const r = await runParallel({ ctx: ctxOf(d), tasks: T("one", "two"), limit: 2, runWorker: async (root, t) => {
    seen[t.name] = { a: read(root, "a.txt"), b: read(root, "b.txt"), n: read(root, "new.txt"), ignored: existsSync(join(root, "secret.env")) };
    if (t.name === "one") writeFileSync(join(root, "new.txt"), "brand new, improved\n"); return { summary: "", steps: 1, stopped: "finished" };
  } });
  for (const k of ["one", "two"]) expect(seen[k]).toEqual({ a: "a2 not committed\n", b: "b2 staged\n", n: "brand new\n", ignored: false }); // ignored files are not copied
  expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "no-changes"]);
  expect(read(d, "new.txt")).toBe("brand new, improved\n"); expect(read(d, "a.txt")).toBe("a2 not committed\n"); expect(read(d, "secret.env")).toBe("KEY=1\n");
  expect(status(d)).toBe(before); expect(G(d, "diff", "--cached", "--name-only")).toBe("b.txt"); expectClean(d);
});

test("two workers change the same lines: the first is joined, the second is not joined AT ALL, and its change is handed back", async () => {
  const d = repo({ "shared.txt": LINES, "extra.txt": "e1\n" }); const ctx = ctxOf(d);
  const r = await runParallel({ ctx, tasks: T("first", "second"), limit: 2, runWorker: async (root, t) => {
    writeFileSync(join(root, "shared.txt"), LINES.replace("line 20\n", `line 20 by ${t.name}\n`));
    if (t.name === "second") writeFileSync(join(root, "extra.txt"), "e2 by second\n");
    return { summary: "changed line 20", steps: 2, stopped: "finished" };
  } });
  expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "conflict"]);
  expect(read(d, "shared.txt")).toContain("line 20 by first"); expect(read(d, "shared.txt")).not.toContain("by second");
  expect(read(d, "extra.txt")).toBe("e1\n"); // the part of "second" that would have fitted is not applied either: all or nothing
  expect([...ctx.touched]).toEqual(["shared.txt"]);
  const c = r.outcomes[1]; expect(c.detail).toContain("shared.txt"); expect(c.patch).toContain("+line 20 by second"); expect(c.patch).toContain("+e2 by second");
  const text = describeParallel(r); expect(text).toContain("[second] NOT JOINED"); expect(text).toContain("Redo this part yourself"); expect(text).toContain("Joined into the project: 1. Not joined: 1.");
  expectClean(d);
});

test("the same file, far apart: both are joined", async () => {
  const d = repo({ "shared.txt": LINES });
  const r = await runParallel({ ctx: ctxOf(d), tasks: T("top", "bottom"), limit: 2, runWorker: async (root, t) => {
    writeFileSync(join(root, "shared.txt"), t.name === "top" ? LINES.replace("line 3\n", "line 3 TOP\n") : LINES.replace("line 37\n", "line 37 BOTTOM\n")); return { summary: "", steps: 1, stopped: "finished" };
  } });
  expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "applied"]);
  expect(read(d, "shared.txt")).toBe(LINES.replace("line 3\n", "line 3 TOP\n").replace("line 37\n", "line 37 BOTTOM\n"));
});

test("new files, deleted files, folders and a binary file all travel; undo takes them back", async () => {
  const bin = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 7]);
  const d = repo({ "gone.txt": "bye\n", "keep.txt": "k\n" }); writeFileSync(join(d, "pic.bin"), Buffer.from([9, 9, 0, 9])); G(d, "add", "-A"); G(d, "commit", "-q", "-m", "bin");
  const ctx = ctxOf(d);
  const r = await runParallel({ ctx, tasks: T("maker", "remover"), limit: 2, runWorker: async (root, t) => {
    if (t.name === "maker") { mkdirSync(join(root, "deep", "er"), { recursive: true }); writeFileSync(join(root, "deep", "er", "new file.txt"), "hello\n"); writeFileSync(join(root, "pic.bin"), bin); }
    else unlinkSync(join(root, "gone.txt"));
    return { summary: "", steps: 1, stopped: "finished" };
  } });
  expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "applied"]);
  expect(read(d, "deep/er/new file.txt")).toBe("hello\n"); expect(readFileSync(join(d, "pic.bin")).equals(bin)).toBe(true); expect(existsSync(join(d, "gone.txt"))).toBe(false);
  expect(r.outcomes[0].files.sort()).toEqual(["deep/er/new file.txt", "pic.bin"]);
  undoAll(ctx); expect(read(d, "gone.txt")).toBe("bye\n"); expect(existsSync(join(d, "deep", "er", "new file.txt"))).toBe(false);
});

test("a worker that breaks does not stop the others, and leaves nothing behind", async () => {
  const d = repo({ "a.txt": "a\n", "b.txt": "b\n" });
  const r = await runParallel({ ctx: ctxOf(d), tasks: T("good", "bad", "idle"), limit: 3, runWorker: async (root, t) => {
    if (t.name === "bad") { writeFileSync(join(root, "b.txt"), "half done\n"); throw new Error("the AI service failed: boom"); }
    if (t.name === "good") writeFileSync(join(root, "a.txt"), "good\n"); return { summary: "", steps: 1, stopped: "finished" };
  } });
  expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "failed", "no-changes"]);
  expect(read(d, "a.txt")).toBe("good\n"); expect(read(d, "b.txt")).toBe("b\n"); expect(r.outcomes[1].detail).toContain("boom");
  expect(describeParallel(r)).toContain("[bad] FAILED"); expectClean(d);
});

test("never more workers at once than the limit, and they really do run at the same time", async () => {
  const d = repo({ "a.txt": "a\n" }); let now = 0, most = 0; const order: string[] = [];
  const r = await runParallel({ ctx: ctxOf(d), tasks: T("w1", "w2", "w3", "w4", "w5"), limit: 2, runWorker: async (root, t) => {
    now++; most = Math.max(most, now); order.push(t.name); await new Promise((ok) => setTimeout(ok, 150)); writeFileSync(join(root, t.name + ".txt"), t.name); now--; return { summary: "", steps: 1, stopped: "finished" };
  } });
  expect(most).toBe(2); expect(order.length).toBe(5); expect(r.outcomes.every((x) => x.status === "applied")).toBe(true);
  for (const n of ["w1", "w2", "w3", "w4", "w5"]) expect(read(d, n + ".txt")).toBe(n);
  expectClean(d);
});

test("ignored dependency folders are linked into each copy, never copied into the result, and stay untouched", async () => {
  const d = repo({ ".gitignore": "node_modules/\n.venv/\n", "a.txt": "a\n", "node_modules/pkg/index.js": "module.exports = 42;\n", ".venv/marker": "v\n" });
  let sawPkg = "";
  const r = await runParallel({ ctx: ctxOf(d), tasks: T("one", "two"), limit: 2, runWorker: async (root, t) => {
    if (t.name === "one") { sawPkg = read(root, "node_modules/pkg/index.js"); expect(existsSync(join(root, ".venv", "marker"))).toBe(true); writeFileSync(join(root, "a.txt"), "changed\n"); }
    return { summary: "", steps: 1, stopped: "finished" };
  } });
  expect(sawPkg).toBe("module.exports = 42;\n"); expect(r.outcomes[0].files).toEqual(["a.txt"]); expect(r.outcomes[1].status).toBe("no-changes");
  expect(read(d, "node_modules/pkg/index.js")).toBe("module.exports = 42;\n"); expect(read(d, ".venv/marker")).toBe("v\n"); // removing the copies did not follow the links
  expect(status(d)).toBe(" M a.txt"); expectClean(d);
});

test("a worker that commits or stages in its copy is still collected, and your branch gets no commit", async () => {
  const d = repo({ "a.txt": "a\n", "b.txt": "b\n" }); const head = G(d, "rev-parse", "HEAD"); const count = G(d, "rev-list", "--count", "--all");
  const r = await runParallel({ ctx: ctxOf(d), tasks: T("committer", "stager"), limit: 2, runWorker: async (root, t) => {
    if (t.name === "committer") { writeFileSync(join(root, "a.txt"), "committed there\n"); G(root, "add", "-A"); G(root, "-c", "user.email=w@x", "-c", "user.name=W", "commit", "-q", "-m", "worker commit"); }
    else { writeFileSync(join(root, "b.txt"), "staged there\n"); G(root, "add", "b.txt"); }
    return { summary: "", steps: 1, stopped: "finished" };
  } });
  expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "applied"]); expect(read(d, "a.txt")).toBe("committed there\n"); expect(read(d, "b.txt")).toBe("staged there\n");
  expect(G(d, "rev-parse", "HEAD")).toBe(head); expect(G(d, "rev-list", "--count", "--all")).toBe(count); expect(G(d, "diff", "--cached", "--name-only")).toBe(""); expectClean(d);
});

test("a repository with no commit yet works too", async () => {
  const d = repo({ "a.txt": "a\n" }, false);
  const r = await runParallel({ ctx: ctxOf(d), tasks: T("one", "two"), limit: 2, runWorker: async (root, t) => { expect(read(root, "a.txt")).toBe("a\n"); writeFileSync(join(root, t.name + ".txt"), "x\n"); return { summary: "", steps: 1, stopped: "finished" }; } });
  expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "applied"]); expect(read(d, "one.txt")).toBe("x\n"); expect(read(d, "two.txt")).toBe("x\n"); expectClean(d);
});

test("copies left by a program that is gone are cleared at the next run; a stop in the middle clears its own", async () => {
  const d = repo({ "a.txt": "a\n" });
  const stale = join(d, ".git", "syok-parallel", "999999999-old"); mkdirSync(stale, { recursive: true });
  const snap = G(d, "rev-parse", "HEAD"); G(d, "worktree", "add", "--detach", "-q", join(stale, "w"), snap); expect(G(d, "worktree", "list").split("\n").length).toBe(2);
  let midway = 0;
  await runParallel({ ctx: ctxOf(d), tasks: T("one", "two"), limit: 2, runWorker: async () => { midway = G(d, "worktree", "list").split("\n").length; return { summary: "", steps: 1, stopped: "finished" }; } });
  expect(existsSync(stale)).toBe(false); expect(midway).toBeLessThanOrEqual(3); expectClean(d);
  // stopped in the middle (Ctrl+C): cleanupParallel is what the program calls
  let release!: () => void; const gate = new Promise<void>((ok) => (release = ok)); let started = 0;
  const p = runParallel({ ctx: ctxOf(d), tasks: T("one", "two"), limit: 2, runWorker: async () => { started++; await gate; return { summary: "", steps: 1, stopped: "finished" }; } });
  while (started < 2) await new Promise((ok) => setTimeout(ok, 20));
  expect(G(d, "worktree", "list").split("\n").length).toBe(3); cleanupParallel(); expectClean(d);
  release(); await p.catch(() => {}); expectClean(d); expect(read(d, "a.txt")).toBe("a\n");
});

test("requests that cannot run are answered in words, and nothing starts", () => {
  const d = repo({ "a.txt": "a\n" }); const plain = tmpProject({ "a.txt": "a\n" }); const two = [{ name: "a", task: "change the first thing fully" }, { name: "b", task: "change the second thing fully" }];
  expect(requestProblem(ctxOf(d), two)).toBe("");
  expect(requestProblem(ctxOf(plain), two)).toContain("git repository");
  expect(requestProblem(ctxOf(d, "plan"), two)).toContain("planning mode");
  expect(requestProblem(ctxOf(d, "auto", { parallel_workers: 0 }), two)).toContain("switched off");
  expect(requestProblem({ ...ctxOf(d), depth: 1 }, two)).toContain("helpers cannot");
  expect(requestProblem(ctxOf(d), [two[0]])).toContain("at least two"); expect(requestProblem(ctxOf(d), "x")).toContain("at least two");
  expect(requestProblem(ctxOf(d), [{ name: "a", task: "short" }, two[1]])).toContain("complete instructions");
  expect(requestProblem(ctxOf(d), Array.from({ length: 9 }, () => two[0]))).toContain("at most 8");
});

test("names become safe folder names and stay unique; the limit is read strictly", () => {
  expect(cleanNames([{ name: "API & Docs!", task: "t" }, { name: "../../etc", task: "t" }, { name: "", task: "t" }, { name: "api   docs", task: "t" }]).map((x) => x.name)).toEqual(["api-docs", "etc", "worker-3", "api-docs-2"]);
  expect(workerLimit({})).toBe(2); expect(workerLimit({ parallel_workers: 5 })).toBe(5); expect(workerLimit({ parallel_workers: 99 })).toBe(8);
  expect(workerLimit({ parallel_workers: 0 })).toBe(0); expect(workerLimit({ parallel_workers: false })).toBe(0); expect(workerLimit({ parallel_workers: -3 })).toBe(0);
  expect(workerLimit({ parallel_workers: true })).toBe(2); expect(workerLimit({ parallel_workers: "abc" })).toBe(2); expect(workerLimit({ parallel_workers: 2.9 })).toBe(2);
});

test("the tool is offered only where it can work", () => {
  const d = repo({ "a.txt": "a\n" }); const plain = tmpProject({ "a.txt": "a\n" }); const has = (c: any) => toolDefs(c).some((t: any) => t.function.name === "parallel_edit");
  expect(has(ctxOf(d))).toBe(true); expect(has(ctxOf(plain))).toBe(false); expect(has(ctxOf(d, "plan"))).toBe(false);
  expect(has(ctxOf(d, "auto", { parallel_workers: 0 }))).toBe(false); expect(has({ ...ctxOf(d), depth: 1 })).toBe(false);
});

// ---- with the agent loop: a scripted AI plays the main AI and both workers at the same time ----
const base = "http://x";
function scriptedAI(o: { tasks: any[]; worker: (task: string, toolsSoFar: number) => any }) {
  const seen = { workerTools: [] as string[][], main: 0, results: [] as string[], most: 0, now: 0 };
  const f = (async (_u: any, init: any) => {
    const req = JSON.parse(init.body); const sys = String(req.messages[0].content); const isWorker = sys.includes("your own separate copy");
    const tools = req.messages.filter((m: any) => m.role === "tool"); let msg: any;
    if (isWorker) { seen.now++; seen.most = Math.max(seen.most, seen.now); await new Promise((ok) => setTimeout(ok, 60)); seen.now--; seen.workerTools.push(req.tools.map((t: any) => t.function.name)); const task = String(req.messages[1].content); msg = o.worker(task, tools.length); }
    else { seen.main++; if (tools.length === 0) msg = call("parallel_edit", { tasks: o.tasks }); else { seen.results.push(String(tools[tools.length - 1].content)); msg = call("finish", { summary: "all joined" }); } }
    return new Response(JSON.stringify({ choices: [{ message: msg }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  }) as any;
  return { f, seen };
}
const TWO = [{ name: "alpha", task: "In alpha.txt replace the word old with ALPHA. Nothing else." }, { name: "beta", task: "In beta.txt replace the word old with BETA. Nothing else." }];
const editWorker = (task: string, n: number) => { const which = task.includes("alpha.txt") ? "alpha" : "beta"; return n === 0 ? call("edit_file", { path: which + ".txt", old_text: "old", new_text: which.toUpperCase() }) : call("finish", { summary: which + " edited" }); };

test("agent: the main AI starts two workers, they run at the same time, and their edits land in the project", async () => {
  const d = repo({ "alpha.txt": "old\n", "beta.txt": "old\n" }); const ai = scriptedAI({ tasks: TWO, worker: editWorker }); const logs: string[] = [];
  const r = await runAgent({ root: d, task: "update both", base, key: "k", mode: "auto", fetchImpl: ai.f, log: (s) => logs.push(s), profile: { ...DEFAULT, nudgeTests: false }, settings: { checks: false } });
  expect(read(d, "alpha.txt")).toBe("ALPHA\n"); expect(read(d, "beta.txt")).toBe("BETA\n"); expect(r.summary).toBe("all joined"); expect(r.touched.sort()).toEqual(["alpha.txt", "beta.txt"]);
  expect(ai.seen.most).toBe(2); // both workers were waiting on the AI at the same moment
  expect(ai.seen.results[0]).toContain("[alpha] JOINED"); expect(ai.seen.results[0]).toContain("[beta] JOINED"); expect(ai.seen.results[0]).toContain("Its report: beta edited");
  for (const t of ai.seen.workerTools) { expect(t).not.toContain("parallel_edit"); expect(t).not.toContain("delegate"); expect(t).toContain("edit_file"); } // workers cannot start workers
  expect(r.usage.steps).toBe(2 + 4); expect(r.usage.total).toBe(6 * 7); // the main AI's two calls and two calls per worker are all counted
  expect(logs.some((l) => l.includes("[alpha]"))).toBe(true); expectClean(d);
});

test("agent: in ask mode you are asked once before the workers start, and saying no starts nothing", async () => {
  const d = repo({ "alpha.txt": "old\n", "beta.txt": "old\n" }); const ai = scriptedAI({ tasks: TWO, worker: editWorker }); const asked: string[] = [];
  const r = await runAgent({ root: d, task: "update both", base, key: "k", mode: "ask", ask: async (what, detail) => { asked.push(what + "\n" + detail); return false; }, fetchImpl: ai.f, profile: { ...DEFAULT, nudgeTests: false }, settings: { checks: false } });
  expect(asked.length).toBe(1); expect(asked[0]).toContain("2 workers editing at the same time"); expect(asked[0]).toContain("[alpha]"); expect(asked[0]).toContain("uses your Syok key at the same time");
  expect(ai.seen.results[0]).toContain("declined parallel workers"); expect(ai.seen.workerTools.length).toBe(0);
  expect(read(d, "alpha.txt")).toBe("old\n"); expect(r.touched).toEqual([]); expectClean(d);
});

test("agent: the workers' own questions reach you one at a time, each marked with the worker's name", async () => {
  const d = repo({ "alpha.txt": "old\n", "beta.txt": "old\n" }); const ai = scriptedAI({ tasks: TWO, worker: editWorker }); const asked: string[] = []; let open = 0, mostOpen = 0;
  await runAgent({ root: d, task: "update both", base, key: "k", mode: "ask", ask: async (what) => { open++; mostOpen = Math.max(mostOpen, open); asked.push(what); await new Promise((ok) => setTimeout(ok, 80)); open--; return true; }, fetchImpl: ai.f, profile: { ...DEFAULT, nudgeTests: false }, settings: { checks: false } });
  expect(asked[0]).toContain("2 workers editing"); const fromWorkers = asked.slice(1);
  expect(fromWorkers.length).toBe(2); expect(fromWorkers.some((a) => a.startsWith("[worker alpha] "))).toBe(true); expect(fromWorkers.some((a) => a.startsWith("[worker beta] "))).toBe(true);
  expect(mostOpen).toBe(1); expect(read(d, "alpha.txt")).toBe("ALPHA\n"); expect(read(d, "beta.txt")).toBe("BETA\n");
});

test("agent: a worker's commands run inside its own copy, not in your folder", async () => {
  const d = repo({ "alpha.txt": "old\n", "beta.txt": "old\n" }); const where: Record<string, string> = {};
  const ai = scriptedAI({ tasks: TWO, worker: (task, n) => { const which = task.includes("alpha.txt") ? "alpha" : "beta"; return n === 0 ? call("run_command", { command: `pwd > where-${which}.txt && echo made-by-command > made-${which}.txt` }) : call("finish", { summary: "ran" }); } });
  await runAgent({ root: d, task: "run both", base, key: "k", mode: "auto", fetchImpl: ai.f, profile: { ...DEFAULT, nudgeTests: false }, settings: { checks: false } });
  for (const w of ["alpha", "beta"]) { where[w] = read(d, `where-${w}.txt`).trim(); expect(where[w]).toContain("syok-parallel"); expect(where[w].endsWith(w)).toBe(true); expect(read(d, `made-${w}.txt`).trim()).toBe("made-by-command"); }
  expect(where.alpha).not.toBe(where.beta); expectClean(d);
});

test("agent: outside a git project the tool is not offered, and a call to it is answered with the reason", async () => {
  const d = tmpProject({ "alpha.txt": "old\n" }); let offered = true; let answer = "";
  const f = (async (_u: any, init: any) => { const req = JSON.parse(init.body); const tools = req.messages.filter((m: any) => m.role === "tool"); offered = req.tools.some((t: any) => t.function.name === "parallel_edit"); if (tools.length) answer = String(tools[0].content);
    return new Response(JSON.stringify({ choices: [{ message: tools.length ? call("finish", { summary: "ok" }) : call("parallel_edit", { tasks: TWO }) }], usage: { total_tokens: 1 } })); }) as any;
  await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: f, profile: { ...DEFAULT, nudgeTests: false } });
  expect(offered).toBe(false); expect(answer).toContain("git repository"); expect(read(d, "alpha.txt")).toBe("old\n");
});

test("files with Windows line endings are joined byte for byte", async () => {
  const d = repo({ "w.txt": "one\r\ntwo\r\nthree\r\n", "u.txt": "x\n" });
  const r = await runParallel({ ctx: ctxOf(d), tasks: T("crlf", "other"), limit: 2, runWorker: async (root, t) => {
    if (t.name === "crlf") { expect(read(root, "w.txt")).toBe("one\r\ntwo\r\nthree\r\n"); writeFileSync(join(root, "w.txt"), "one\r\nTWO\r\nthree\r\n"); } else writeFileSync(join(root, "u.txt"), "y\n");
    return { summary: "", steps: 1, stopped: "finished" };
  } });
  expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "applied"]); expect(read(d, "w.txt")).toBe("one\r\nTWO\r\nthree\r\n"); expect(read(d, "u.txt")).toBe("y\n");
});

// ---- the whole program ----
import { planConfine, probeConfine } from "../src/confine.ts";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
const main = join(import.meta.dir, "..", "src", "main.ts");
/** A stand-in Syok that plays the main AI and the workers. Each worker runs one shell command, then finishes. */
function standIn(tasks: any[], workerCommand: (which: string) => string) {
  let workers = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const b: any = await req.json(); const sys = String(b.messages[0].content); const tools = b.messages.filter((m: any) => m.role === "tool").length; let msg: any;
    if (sys.includes("your own separate copy")) { workers++; const which = String(b.messages[1].content).includes("alpha") ? "alpha" : "beta"; msg = tools === 0 ? call("run_command", { command: workerCommand(which) }) : call("finish", { summary: which + " ran" }); }
    else msg = tools === 0 ? call("parallel_edit", { tasks }) : call("finish", { summary: "joined" });
    return Response.json({ choices: [{ message: msg }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } });
  return { server, url: `http://127.0.0.1:${server.port}`, workers: () => workers };
}
const go = (args: string[], cwd: string, env: Record<string, string>) => new Promise<{ code: number | null; out: string; err: string }>((res) => { const p = Bun.spawn(["bun", main, ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" }); Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]).then(([out, err, code]) => res({ code, out, err })); });
const ALPHA_BETA = [{ name: "alpha", task: "Run the command for alpha and change nothing else at all." }, { name: "beta", task: "Run the command for beta and change nothing else at all." }];

test("whole program: syok -p with two workers; --workers 0 switches the tool off", async () => {
  const d = repo({ "a.txt": "a\n" }); const home = tmpProject({}); const s = standIn(ALPHA_BETA, (w) => `echo ${w} > made-${w}.txt`);
  const env = { HOME: home, USERPROFILE: home, SYOK_BASE_URL: s.url, SYOK_API_KEY: "syk_test" };
  try {
    const r = await go(["--mode", "auto", "--no-checks", "--no-stream", "-p", "do both", "--cwd", d], d, env);
    expect(r.code).toBe(0); expect(read(d, "made-alpha.txt").trim()).toBe("alpha"); expect(read(d, "made-beta.txt").trim()).toBe("beta");
    expect(r.out).toContain("[alpha] started in its own copy"); expect(r.out).toContain("[beta] started in its own copy"); expect(r.out).toContain("made-alpha.txt"); expectClean(d);
    const before = s.workers(); const off = await go(["--mode", "auto", "--no-checks", "--no-stream", "--workers", "0", "-p", "do both", "--cwd", d], d, env);
    expect(off.code).toBe(0); expect(s.workers()).toBe(before); expect(off.out).not.toContain("started in its own copy");
    const h = await go(["--help"], d, env); expect(h.out).toContain("--workers <n>");
  } finally { s.server.stop(true); }
}, 90000);

// Under confinement the ordinary temporary folder is hidden from the AI's commands, which is why the copies live inside the project's .git folder.
// This proves a confined worker can work in its copy, use git there, and still cannot write outside the project.
test("whole program, confined: workers run in their copies, git works there, and nothing escapes the project", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return; // the Linux and Mac kind; the Windows kind has its own tests in confine-win.test.ts
  const baseDir = mkdtempSync(join(realpathSync(process.platform === "darwin" ? homedir() : tmpdir()), ".syok-par-confine-"));
  try {
    const d = join(baseDir, "proj"), outside = join(baseDir, "outside"), home = join(baseDir, "home"); for (const x of [d, outside, home]) mkdirSync(x, { recursive: true });
    writeFileSync(join(d, "a.txt"), "a\n"); G(d, "init", "-q", "-b", "main"); G(d, "config", "user.email", "t@example.com"); G(d, "config", "user.name", "T"); G(d, "add", "-A"); G(d, "commit", "-q", "-m", "first");
    const plan = planConfine({ root: d, home }); const why = "problem" in plan ? plan.problem : probeConfine(plan);
    if (why) { if (process.env.SYOK_REQUIRE_CONFINE === "1") throw new Error("confinement is required for this run but is not working: " + why); console.log("  (skipped: " + why.split("\n")[0] + ")"); return; }
    const s = standIn(ALPHA_BETA, (w) => `pwd > where-${w}.txt; echo in-copy > made-${w}.txt; git status --porcelain > gitsees-${w}.txt 2>&1; echo escaped > '${outside}/esc-${w}.txt'; echo "code=$?"`);
    try {
      const r = await go(["--confine", "--mode", "auto", "--no-checks", "--no-stream", "-p", "do both", "--cwd", d], d, { HOME: home, USERPROFILE: home, SYOK_BASE_URL: s.url, SYOK_API_KEY: "syk_test" });
      expect(r.err).toContain("Confined with"); expect(r.code).toBe(0);
      for (const w of ["alpha", "beta"]) {
        expect(read(d, `made-${w}.txt`).trim()).toBe("in-copy"); expect(read(d, `where-${w}.txt`).trim()).toContain(join(".git", "syok-parallel"));
        expect(read(d, `gitsees-${w}.txt`)).toContain(`made-${w}.txt`); expect(read(d, `gitsees-${w}.txt`)).not.toMatch(/fatal|error/i); // git worked inside the copy
        expect(existsSync(join(outside, `esc-${w}.txt`))).toBe(false);
      }
      expectClean(d);
    } finally { s.server.stop(true); }
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
}, 120000);

test("Syok Code's own records in a copy (saved chats, saved jobs) are never part of a worker's result; other .syok files are", async () => {
  const d = repo({ "a.txt": "a\n", ".syok/sessions/old.json": "{\"chat\":1}\n", ".syok/agents/helper.md": "v1\n" });
  const r = await runParallel({ ctx: ctxOf(d), tasks: T("one", "two"), limit: 2, runWorker: async (root, t) => {
    mkdirSync(join(root, ".syok", "sessions"), { recursive: true }); mkdirSync(join(root, ".syok", "jobs", "1"), { recursive: true });
    writeFileSync(join(root, ".syok", "sessions", t.name + ".json"), "{}"); writeFileSync(join(root, ".syok", "jobs", "1", "log.txt"), "job"); unlinkSync(join(root, ".syok", "sessions", "old.json"));
    if (t.name === "one") writeFileSync(join(root, ".syok", "agents", "helper.md"), "v2\n"); return { summary: "", steps: 1, stopped: "finished" };
  } });
  expect(r.outcomes.map((x) => x.status)).toEqual(["applied", "no-changes"]); expect(r.outcomes[0].files).toEqual([".syok/agents/helper.md"]);
  expect(read(d, ".syok/agents/helper.md")).toBe("v2\n"); expect(read(d, ".syok/sessions/old.json")).toBe("{\"chat\":1}\n");
  expect(existsSync(join(d, ".syok", "sessions", "one.json"))).toBe(false); expect(existsSync(join(d, ".syok", "jobs"))).toBe(false);
});
