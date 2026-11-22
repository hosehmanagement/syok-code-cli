// A scenario is a folder bench/scenarios/<id>/ with scenario.json. See bench/README.md for every field.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { run, sh } from "./proc.ts";
import type { Limits } from "../adapters/types.ts";

export type Source =
  | { type: "git"; url: string; commit: string }
  | { type: "tarball"; path: string; strip?: number }
  | { type: "dir"; path: string };
export interface Scenario {
  id: string;
  title: string;
  dir: string;                  // the scenario folder (absolute)
  source: Source;
  prompt: string;
  limits: Limits;
  setup?: string;               // run once after checkout, before the baseline (e.g. "npm ci")
  grader: { command: string; files?: string; timeSec?: number };
  tests: Array<{ name: string; command: string; timeSec?: number }>;
  protected: string[];
}
export const DEFAULT_RUN_CAP_USD = 2;

export function loadScenario(dir: string): Scenario {
  const abs = resolve(dir), f = join(abs, "scenario.json");
  if (!existsSync(f)) throw new Error(`${abs} has no scenario.json`);
  let j: any; try { j = JSON.parse(readFileSync(f, "utf8")); } catch (e: any) { throw new Error(`${f} is not valid JSON: ${e.message}`); }
  const bad = (m: string) => { throw new Error(`${f}: ${m}`); };
  const s = j.source || {};
  if (s.type === "git") {
    if (!s.url) bad("source.url is missing");
    if (!/^[0-9a-f]{40}$/.test(s.commit || "")) bad("source.commit must be a full 40-character commit hash (a pinned commit, not a branch or tag)");
  } else if (s.type === "tarball" || s.type === "dir") { if (!s.path) bad("source.path is missing"); }
  else bad('source.type must be "git", "tarball" or "dir"');
  const prompt = j.promptFile ? readFileSync(join(abs, j.promptFile), "utf8") : j.prompt;
  if (!prompt || typeof prompt !== "string") bad("prompt (or promptFile) is missing");
  const limits = j.limits || {};
  if (!(limits.timeSec > 0)) bad("limits.timeSec must be a positive number of seconds");
  if (!j.grader?.command) bad("grader.command is missing");
  const tests = Array.isArray(j.tests) ? j.tests : [];
  for (const t of tests) if (!t.name || !t.command) bad("every entry of tests needs a name and a command");
  const prot = Array.isArray(j.protected) ? j.protected : [];
  for (const p of prot) if (typeof p !== "string" || isAbsolute(p) || p.split(/[\\/]/).includes("..")) bad(`protected path "${p}" must be relative to the project`);
  return { id: j.id || abs.split(/[\\/]/).pop()!, title: j.title || j.id || "", dir: abs, source: s, prompt, limits: { timeSec: limits.timeSec, maxSteps: limits.maxSteps, maxCostUsd: limits.maxCostUsd }, setup: j.setup, grader: j.grader, tests, protected: prot };
}
/** All scenario folders under a parent folder, or one scenario folder. */
export function findScenarios(path: string, only: string[] = []): Scenario[] {
  const abs = resolve(path);
  if (existsSync(join(abs, "scenario.json"))) return [loadScenario(abs)];
  const ids = readdirSync(abs).filter((d) => existsSync(join(abs, d, "scenario.json")) && (!only.length || only.includes(d))).sort();
  return ids.map((d) => loadScenario(join(abs, d)));
}

const G = ["-c", "user.email=bench@localhost", "-c", "user.name=bench", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
export const git = (cwd: string, args: string[], timeoutMs = 120000) => run(["git", ...G, ...args], { cwd, timeoutMs });
async function must(p: Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>, what: string) {
  const r = await p; if (r.code !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout).trim().slice(-600)}`); return r.stdout.trim();
}
/** Put the scenario's project in `work` (an empty folder) as a git repository, run setup, and return the base commit. */
export async function materialize(sc: Scenario, work: string): Promise<string> {
  mkdirSync(work, { recursive: true });
  const s = sc.source;
  if (s.type === "git") {
    await must(git(work, ["clone", "--quiet", s.url, "."], 600000), `git clone ${s.url}`);
    await must(git(work, ["checkout", "--quiet", "--detach", s.commit]), `git checkout ${s.commit}`);
    const head = await must(git(work, ["rev-parse", "HEAD"]), "git rev-parse");
    if (head !== s.commit) throw new Error(`checked out ${head}, expected ${s.commit}`);
  } else {
    const src = resolve(sc.dir, s.path);
    if (!existsSync(src)) throw new Error(`${sc.id}: ${src} does not exist`);
    if (s.type === "tarball") await must(run(["tar", "-xzf", src, "-C", work, ...(s.strip ? [`--strip-components=${s.strip}`] : [])], { cwd: work, timeoutMs: 300000 }), "tar");
    else { if (!statSync(src).isDirectory()) throw new Error(`${src} is not a folder`); cpSync(src, work, { recursive: true }); }
    await must(git(work, ["init", "-q"]), "git init");
    await must(git(work, ["add", "-A"]), "git add");
    await must(git(work, ["commit", "-qm", "scenario start", "--date", "2026-01-01T00:00:00Z"]), "git commit");
  }
  if (sc.setup) {
    const r = await sh(sc.setup, { cwd: work, timeoutMs: 1800000 });
    if (r.code !== 0) throw new Error(`${sc.id}: setup "${sc.setup}" failed: ${(r.stderr || r.stdout).trim().slice(-600)}`);
    // Whatever setup produced that git would see becomes part of the base, so the diff shows only the tool's changes.
    const st = await git(work, ["status", "--porcelain"]);
    if (st.stdout.trim()) { await must(git(work, ["add", "-A"]), "git add"); await must(git(work, ["commit", "-qm", "bench setup"]), "git commit"); }
  }
  return must(git(work, ["rev-parse", "HEAD"]), "git rev-parse");
}
/** Run each existing test command; true = passed. */
export async function runTests(sc: Scenario, work: string): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const t of sc.tests) { const r = await sh(t.command, { cwd: work, timeoutMs: (t.timeSec ?? 300) * 1000 }); out[t.name] = r.code === 0 && !r.timedOut; }
  return out;
}
/** Protected test files the tool changed or deleted (compared with the base commit, so commits by the tool count too). */
export async function changedProtected(sc: Scenario, work: string, base: string): Promise<string[]> {
  if (!sc.protected.length) return [];
  const r = await git(work, ["diff", "--name-only", base, "--", ...sc.protected]);
  return r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}
/** Put protected files back exactly as they were, so grading and the test run use the original tests. */
export async function restoreProtected(sc: Scenario, work: string, base: string): Promise<void> {
  if (sc.protected.length) await git(work, ["checkout", base, "--", ...sc.protected]);
}
/** Everything the tool changed, as a patch against the base commit (new files included). */
export async function capturePatch(work: string, base: string): Promise<string> {
  await git(work, ["add", "-A"]);
  return (await git(work, ["diff", "--cached", "--binary", base])).stdout;
}
export function overlay(from: string, work: string) { if (existsSync(from)) cpSync(from, work, { recursive: true }); }
