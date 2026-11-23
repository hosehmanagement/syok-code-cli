#!/usr/bin/env bun
// The same-model lane "Claude Code vs Syok Code on one model" for the SWE-bench pilot (.github/workflows/bench-pilot.yml).
// Pure helpers (each has a unit test in test/bench-swebench.test.ts), plus a small command that checks the workflow's inputs:
//   bun bench/swebench/lane.ts check        reads IN_* and the secrets by NAME from the environment; exit 0 = go, 1 = refused
// Lanes: gold, noop (no AI), syok (Syok Code through the Syok router, as before), syok-direct (Syok Code straight to
// Anthropic: SYOK_BASE_URL=https://api.anthropic.com, SYOK_API_KEY=<the ANTHROPIC_API_KEY secret>), claude (Claude Code).
import { canonical } from "../lib/bench.ts";

export const LANES = ["gold", "noop", "syok", "syok-direct", "claude"] as const;
export type LaneName = (typeof LANES)[number];
/** Lanes that call a paid model, and the repository secrets (by name) each one needs. */
export const LANE_SECRETS: Record<LaneName, string[]> = { gold: [], noop: [], syok: ["SYOK_BASE_URL", "SYOK_API_KEY"], "syok-direct": ["ANTHROPIC_API_KEY"], claude: ["ANTHROPIC_API_KEY"] };
/** The lanes where every answer must come from ONE pinned model (the fair test: same model, different harness). */
export const SAME_MODEL_LANES: LaneName[] = ["syok-direct", "claude"];
/** The workflow's "tool" input: one lane or a comma list of lanes. The workflow uses this exact pattern too. */
export const TOOL_INPUT_RE = /^(gold|noop|syok|syok-direct|claude)(,(gold|noop|syok|syok-direct|claude))*$/;
/** The adapter (bench/adapters) each lane runs. syok-direct is Syok Code with a different address and key. */
export const adapterOf = (lane: string): string => (lane === "syok-direct" ? "syok" : lane);
/** The address syok-direct gives Syok Code (Syok Code adds /v1/chat/completions: src/agent.ts chatUrl). */
export const ANTHROPIC_BASE = "https://api.anthropic.com";

// ---------- same-model check ----------
/** The model part of a name a tool reported: Syok Code says "<provider> / <model>", Claude Code says "<model>". */
export function modelPart(name: string): string {
  const i = name.lastIndexOf(" / ");
  return canonical(i >= 0 ? name.slice(i + 3) : name);
}
/** Did only the expected model answer? Exact name, or the same name with a date snapshot suffix (claude-sonnet-5-20260101).
 *  A plain prefix is NOT enough: claude-sonnet-5-5 is a different model from claude-sonnet-5.
 *  ok = null when the tool reported no model at all (then it is "not confirmed", never assumed). */
export function sameModel(seen: string[], expected: string): { ok: boolean | null; others: string[] } {
  const exp = canonical(expected);
  if (!seen.length) return { ok: null, others: [] };
  const dated = new RegExp("^" + exp.replace(/[^a-z0-9-]/g, (c) => "\\" + c) + "-\\d{8}$");
  const others = seen.filter((s) => { const m = modelPart(s); return !(m === exp || dated.test(m)); });
  return { ok: others.length === 0, others };
}

// ---------- running a tool as a non-root user inside the container ----------
// Claude Code refuses --dangerously-skip-permissions as root on Linux ("--dangerously-skip-permissions cannot be used with
// root/sudo privileges for security reasons"; docs: code.claude.com/docs/en/permission-modes and /sandbox-environments, which
// say to run the container as a non-root user). SWE-bench's docker exec runs as root, so the tool runs as this user instead.
export const BENCH_USER = "syokbench";
export const BENCH_HOME = "/home/syokbench";
const SAFE_NAME = /^[a-z_][a-z0-9_-]{0,30}$/;
const SAFE_DIR = /^\/[A-Za-z0-9._\/-]+$/;
function checkUser(user: string, home?: string, dir?: string) {
  if (!SAFE_NAME.test(user)) throw new Error(`user name not allowed: ${user}`);
  if (home !== undefined && !SAFE_DIR.test(home)) throw new Error(`home folder not allowed: ${home}`);
  if (dir !== undefined && !SAFE_DIR.test(dir)) throw new Error(`folder not allowed: ${dir}`);
}
/** Create the user (once) with the image's own shell setup copied from root (SWE-bench images activate their conda
 *  environment in /root/.bashrc, so the user gets the same Python the tests use). */
export function createUserCommand(user = BENCH_USER, home = BENCH_HOME): string {
  checkUser(user, home);
  return `command -v runuser >/dev/null && command -v useradd >/dev/null || { echo "this image has no runuser/useradd"; exit 1; }; ` +
    `id -u ${user} >/dev/null 2>&1 || useradd -m -d ${home} -s /bin/bash ${user}; ` +
    `for f in .bashrc .profile; do [ -f /root/$f ] && cp /root/$f ${home}/$f; done; chown -R ${user}: ${home}`;
}
/** Run one shell command line as the user: HOME is the user's, PATH and every other variable (the login key passed in by
 *  name) stay as they are. stdin is closed so a run never waits for input. */
export function runAsCommand(line: string, user = BENCH_USER, home = BENCH_HOME): string {
  checkUser(user, home);
  return `runuser -u ${user} -- env HOME=${home} PATH="$PATH" sh -c ${shq(line)} </dev/null`;
}
const OWNER_FILE = "/tmp/syok-testbed-owner.txt";
/** Before the tool runs: remember who owns the project folder, then give it to the user. */
export function giveFolderCommand(dir: string, user = BENCH_USER): string {
  checkUser(user, undefined, dir);
  return `stat -c '%u:%g' ${dir} > ${OWNER_FILE} && test -s ${OWNER_FILE} && chown -R ${user}: ${dir}`;
}
/** After the tool stops: give the folder back to its owner, so the patch is taken (and graded) exactly as before. */
export function takeBackFolderCommand(dir: string): string {
  checkUser(BENCH_USER, undefined, dir);
  return `test -s ${OWNER_FILE} && chown -R "$(cat ${OWNER_FILE})" ${dir}`;
}
const shq = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";

// ---------- the workflow's input check ----------
export interface LaneInputs { tool: string; n: string; ids: string; model: string; cap: string; per: string; steps: string; timeout: string; runs: string }
export interface LanePlan { ok: boolean; errors: string[]; lanes: LaneName[]; paid: LaneName[]; runs: number; instances: number; totalWorstCase: number; sharePerRun: number }
/** Checks every input, refuses a paid lane whose secret is missing (names only; values are never read beyond "set or not"),
 *  and plans the money: worst case = instances x cost_per_instance x runs x paid lanes, which must be within max_spend.
 *  Each paid run then gets an equal share of max_spend as its own cap (so all runs together stay within max_spend). */
export function checkLaneInputs(i: LaneInputs, env: Record<string, string | undefined>): LanePlan {
  const errors: string[] = [];
  if (!TOOL_INPUT_RE.test(i.tool)) errors.push("tool must be gold, noop, syok, syok-direct or claude (comma list allowed)");
  if (!/^[A-Za-z0-9_.,-]*$/.test(i.ids)) errors.push("ids: letters, digits, _ . - and commas only");
  if (!/^[A-Za-z0-9_./:-]*$/.test(i.model)) errors.push("model: letters, digits, _ . / : - only");
  for (const [k, v] of [["n", i.n], ["max_steps", i.steps], ["timeout_sec", i.timeout], ["runs", i.runs]]) if (!/^[0-9]+$/.test(v)) errors.push(`${k} must be a whole number`);
  for (const [k, v] of [["max_spend_usd", i.cap], ["cost_per_instance_usd", i.per]]) if (!/^[0-9]+(\.[0-9]+)?$/.test(v)) errors.push(`${k} must be a number`);
  const runs = Number(i.runs);
  if (/^[0-9]+$/.test(i.runs) && (runs < 1 || runs > 5)) errors.push("runs must be 1 to 5");
  const lanes = (TOOL_INPUT_RE.test(i.tool) ? [...new Set(i.tool.split(","))] : []) as LaneName[];
  const paid = lanes.filter((l) => LANE_SECRETS[l].length);
  for (const l of paid) {
    const missing = LANE_SECRETS[l].filter((n) => !env[n]);
    if (missing.length) errors.push(`the ${l} lane needs the repository secret${missing.length > 1 ? "s" : ""} ${missing.join(" and ")} ` +
      `(GitHub: Settings > Secrets and variables > Actions > New repository secret). ${missing.length > 1 ? "They are" : "It is"} not set, so nothing was started and nothing was spent.`);
  }
  const instances = i.ids ? i.ids.split(",").filter(Boolean).length : Number(i.n) || 0;
  const per = Number(i.per) || 0, cap = Number(i.cap) || 0;
  const totalWorstCase = instances * per * (Number.isFinite(runs) ? runs : 0) * paid.length;
  const sharePerRun = paid.length && runs > 0 ? cap / (runs * paid.length) : cap;
  if (!errors.length && paid.length && totalWorstCase > cap + 1e-9)
    errors.push(`the plan's worst case is $${totalWorstCase.toFixed(2)} (${instances} instance(s) x $${per} x ${runs} run(s) x ${paid.length} paid lane(s)), more than max_spend_usd $${cap}. Raise max_spend_usd or lower n, runs or cost_per_instance_usd.`);
  return { ok: errors.length === 0, errors, lanes, paid, runs, instances, totalWorstCase, sharePerRun };
}

/** The workflow's job list: one job per lane and run. The no-AI lanes (gold, noop) give the same answer every time, so they run once. */
export function laneMatrix(lanes: LaneName[], runs: number): Array<{ lane: LaneName; run: number }> {
  const out: Array<{ lane: LaneName; run: number }> = [];
  for (const lane of lanes) for (let r = 1; r <= (LANE_SECRETS[lane].length ? runs : 1); r++) out.push({ lane, run: r });
  return out;
}

if (import.meta.main) {
  if (process.argv[2] !== "check") { console.error("usage: bun bench/swebench/lane.ts check   (reads IN_TOOL, IN_N, IN_IDS, IN_MODEL, IN_CAP, IN_PER, IN_STEPS, IN_TIMEOUT, IN_RUNS)"); process.exit(2); }
  const e = process.env;
  const p = checkLaneInputs({ tool: e.IN_TOOL || "", n: e.IN_N || "", ids: e.IN_IDS || "", model: e.IN_MODEL || "", cap: e.IN_CAP || "", per: e.IN_PER || "", steps: e.IN_STEPS || "", timeout: e.IN_TIMEOUT || "", runs: e.IN_RUNS || "1" }, e);
  if (!p.ok) { for (const m of p.errors) console.error("Refused: " + m); process.exit(1); }
  console.log(`Inputs OK. Lanes: ${p.lanes.join(", ")}; runs per lane: ${p.runs}; paid lanes: ${p.paid.join(", ") || "none"}.` +
    (p.paid.length ? ` Worst case $${p.totalWorstCase.toFixed(2)} of max_spend; each paid run may spend at most $${p.sharePerRun.toFixed(4)}.` : ""));
  // For the next jobs (GitHub Actions reads this file; outside Actions it is not set and nothing is written).
  const m = laneMatrix(p.lanes, p.runs);
  console.log("Jobs: " + m.map((j) => `${j.lane} run ${j.run}`).join(", "));
  if (e.GITHUB_OUTPUT) require("node:fs").appendFileSync(e.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: m })}\nspend_cap=${p.sharePerRun.toFixed(6)}\n`);
}
