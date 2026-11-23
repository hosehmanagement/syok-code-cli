// The same-model lane "Claude Code vs Syok Code on claude-sonnet-5" (bench/swebench/lane.ts, the Claude Code adapter in a
// container, the per-lane summary, the scrub of the Anthropic key). Fakes everywhere, plus real Docker when it is running.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  TOOL_INPUT_RE, LANE_SECRETS, adapterOf, sameModel, modelPart, checkLaneInputs, laneMatrix,
  createUserCommand, runAsCommand, giveFolderCommand, takeBackFolderCommand, BENCH_USER, BENCH_HOME,
} from "../bench/swebench/lane.ts";
import { claude, claudeVersionSpec } from "../bench/adapters/claude.ts";
import { syok } from "../bench/adapters/syok.ts";
import { noUsage, type Adapter } from "../bench/adapters/types.ts";
import { solveInstance, instanceCost, resultsTable } from "../bench/swebench/run.ts";
import { dockerBackend, type Backend, type Sandbox } from "../bench/swebench/backends.ts";
import { normalize } from "../bench/swebench/dataset.ts";
import { runRow, laneTable, costLabel, pilotSummary } from "../bench/swebench/summary.ts";
import { loadPrices } from "../bench/lib/bench.ts";
import { tmpDir } from "./helpers.ts";

const ROOT = resolve(import.meta.dir, "..");
const row = (o: any = {}) => ({ instance_id: "owner__repo-1", repo: "owner/repo", base_commit: "a".repeat(40), problem_statement: "It breaks.", FAIL_TO_PASS: '["t.py::test_a"]', PASS_TO_PASS: '["t.py::test_b"]', ...o });
const inputs = (o: any = {}) => ({ tool: "claude,syok-direct", n: "5", ids: "", model: "", cap: "30", per: "1", steps: "40", timeout: "1200", runs: "3", ...o });
const allSecrets = { SYOK_BASE_URL: "https://x", SYOK_API_KEY: "k", ANTHROPIC_API_KEY: "a" };

// ---------- the workflow's input check ----------
test("tool input: the five lanes, alone or as a comma list; nothing else", () => {
  for (const ok of ["gold", "noop", "syok", "syok-direct", "claude", "claude,syok-direct", "gold,noop,syok,syok-direct,claude"]) expect(TOOL_INPUT_RE.test(ok)).toBe(true);
  for (const bad of ["", "codex", "cursor", "claude,", ",claude", "claude syok", "syok-direct;rm -rf /", "Claude", "syok-directx", "claude,,syok"]) expect(TOOL_INPUT_RE.test(bad)).toBe(false);
  expect(adapterOf("syok-direct")).toBe("syok"); expect(adapterOf("claude")).toBe("claude"); expect(adapterOf("syok")).toBe("syok");
  expect(LANE_SECRETS["syok-direct"]).toEqual(["ANTHROPIC_API_KEY"]); expect(LANE_SECRETS.claude).toEqual(["ANTHROPIC_API_KEY"]);
  expect(LANE_SECRETS.syok).toEqual(["SYOK_BASE_URL", "SYOK_API_KEY"]); expect(LANE_SECRETS.gold).toEqual([]);
  // The workflow's own description of the lanes matches the code.
  const wf = readFileSync(join(ROOT, ".github/workflows/bench-pilot.yml"), "utf8");
  expect(wf).toContain("run: bun bench/swebench/lane.ts check");
  expect(wf).toContain('description: "gold, noop, syok, syok-direct, claude (comma list allowed)"');
});
test("input check: a paid lane whose secret is missing is refused with a clear message, before anything runs", () => {
  const p = checkLaneInputs(inputs(), { SYOK_BASE_URL: "https://x", SYOK_API_KEY: "k" });
  expect(p.ok).toBe(false);
  expect(p.errors.join(" ")).toContain("the claude lane needs the repository secret ANTHROPIC_API_KEY");
  expect(p.errors.join(" ")).toContain("the syok-direct lane needs the repository secret ANTHROPIC_API_KEY");
  expect(p.errors.join(" ")).toContain("nothing was started");
  const s = checkLaneInputs(inputs({ tool: "syok" }), { ANTHROPIC_API_KEY: "a" });
  expect(s.ok).toBe(false); expect(s.errors.join(" ")).toContain("SYOK_BASE_URL and SYOK_API_KEY");
  // No AI, no secret needed.
  expect(checkLaneInputs(inputs({ tool: "gold,noop" }), {}).ok).toBe(true);
});
test("input check: the money plan is instances x cost per instance x runs x paid lanes, within max_spend; each paid run gets an equal share", () => {
  const ok = checkLaneInputs(inputs(), allSecrets);
  expect(ok).toMatchObject({ ok: true, lanes: ["claude", "syok-direct"], paid: ["claude", "syok-direct"], runs: 3, instances: 5, totalWorstCase: 30 });
  expect(ok.sharePerRun).toBeCloseTo(5, 10);
  const over = checkLaneInputs(inputs({ cap: "29.99" }), allSecrets);
  expect(over.ok).toBe(false); expect(over.errors[0]).toContain("worst case is $30.00 (5 instance(s) x $1 x 3 run(s) x 2 paid lane(s))");
  // ids override n
  expect(checkLaneInputs(inputs({ ids: "a__a-1,b__b-2", cap: "12" }), allSecrets)).toMatchObject({ ok: true, instances: 2, totalWorstCase: 12 });
  // one lane, one run: the same rule as before (n x cost <= cap), the whole cap for that run
  expect(checkLaneInputs(inputs({ tool: "syok", runs: "1", cap: "5" }), allSecrets)).toMatchObject({ ok: true, totalWorstCase: 5, sharePerRun: 5 });
  for (const bad of [{ runs: "0" }, { runs: "6" }, { runs: "two" }, { n: "-1" }, { cap: "1e3" }, { per: "" }, { ids: "a;b" }, { model: "m $(x)" }, { steps: "4.5" }, { timeout: "" }])
    expect(checkLaneInputs(inputs(bad), allSecrets).ok).toBe(false);
});
test("input check command: refuses with exit 1 and prints no secret; on success writes the job list for the workflow", () => {
  const d = tmpDir("lane-out-");
  const env = (o: any) => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, IN_TOOL: "claude", IN_N: "2", IN_IDS: "", IN_MODEL: "", IN_CAP: "6", IN_PER: "1", IN_STEPS: "40", IN_TIMEOUT: "1200", IN_RUNS: "3", ...o });
  const no = spawnSync("bun", ["bench/swebench/lane.ts", "check"], { cwd: ROOT, encoding: "utf8", env: env({ SYOK_API_KEY: "sk-syok-should-not-print" }) });
  expect(no.status).toBe(1); expect(no.stderr).toContain("Refused: the claude lane needs the repository secret ANTHROPIC_API_KEY");
  expect(no.stdout + no.stderr).not.toContain("sk-syok-should-not-print");
  const out = join(d, "gh-output");
  const yes = spawnSync("bun", ["bench/swebench/lane.ts", "check"], { cwd: ROOT, encoding: "utf8", env: env({ ANTHROPIC_API_KEY: "sk-ant-should-not-print", GITHUB_OUTPUT: out }) });
  expect(yes.status).toBe(0); expect(yes.stdout + yes.stderr).not.toContain("sk-ant-should-not-print");
  const o = readFileSync(out, "utf8");
  expect(o).toContain('matrix={"include":[{"lane":"claude","run":1},{"lane":"claude","run":2},{"lane":"claude","run":3}]}');
  expect(o).toContain("spend_cap=2.000000");
  rmSync(d, { recursive: true, force: true });
});
test("job list: every paid lane once per run; gold and noop (no AI, same answer every time) once", () => {
  expect(laneMatrix(["gold", "claude", "syok-direct"], 2)).toEqual([{ lane: "gold", run: 1 }, { lane: "claude", run: 1 }, { lane: "claude", run: 2 }, { lane: "syok-direct", run: 1 }, { lane: "syok-direct", run: 2 }]);
  expect(laneMatrix(["syok"], 1)).toEqual([{ lane: "syok", run: 1 }]);
});

// ---------- same-model check ----------
test("same model: exact name or a dated snapshot only; claude-sonnet-5-5 or a Haiku answer is ANOTHER model; nothing named = not confirmed", () => {
  expect(modelPart("anthropic / claude-sonnet-5")).toBe("claude-sonnet-5"); expect(modelPart("claude-sonnet-5")).toBe("claude-sonnet-5");
  expect(sameModel(["claude-sonnet-5"], "claude-sonnet-5")).toEqual({ ok: true, others: [] });
  expect(sameModel(["claude-sonnet-5-20260115", "Anthropic / Claude-Sonnet-5"], "claude-sonnet-5")).toEqual({ ok: true, others: [] });
  expect(sameModel(["claude-sonnet-5", "claude-sonnet-5-5"], "claude-sonnet-5")).toEqual({ ok: false, others: ["claude-sonnet-5-5"] });
  expect(sameModel(["claude-haiku-4-5-20251001", "claude-sonnet-5"], "claude-sonnet-5")).toEqual({ ok: false, others: ["claude-haiku-4-5-20251001"] });
  expect(sameModel(["groq / gpt-oss-120b"], "claude-sonnet-5")).toEqual({ ok: false, others: ["groq / gpt-oss-120b"] });
  expect(sameModel(["claude-sonnet-5-2026"], "claude-sonnet-5").ok).toBe(false); // not a full date
  expect(sameModel([], "claude-sonnet-5")).toEqual({ ok: null, others: [] });
});

// ---------- running as a non-root user ----------
test("run-as commands: the user is created once with root's shell setup, the folder is given and given back, the key stays a NAME", () => {
  const c = createUserCommand();
  expect(c).toContain(`id -u ${BENCH_USER} >/dev/null 2>&1 || useradd -m -d ${BENCH_HOME} -s /bin/bash ${BENCH_USER}`);
  expect(c).toContain(`for f in .bashrc .profile; do [ -f /root/$f ] && cp /root/$f ${BENCH_HOME}/$f; done`);
  expect(c).toContain("command -v runuser");
  expect(runAsCommand("echo 'hi' && x")).toBe(`runuser -u ${BENCH_USER} -- env HOME=${BENCH_HOME} PATH="$PATH" sh -c 'echo '\\''hi'\\'' && x' </dev/null`);
  expect(giveFolderCommand("/testbed")).toBe(`stat -c '%u:%g' /testbed > /tmp/syok-testbed-owner.txt && test -s /tmp/syok-testbed-owner.txt && chown -R ${BENCH_USER}: /testbed`);
  expect(takeBackFolderCommand("/testbed")).toBe(`test -s /tmp/syok-testbed-owner.txt && chown -R "$(cat /tmp/syok-testbed-owner.txt)" /testbed`);
  expect(() => runAsCommand("x", "root; rm -rf /")).toThrow(/not allowed/);
  expect(() => createUserCommand("ok", "/home/x y")).toThrow(/not allowed/);
  expect(() => giveFolderCommand("/testbed; rm -rf /")).toThrow(/not allowed/);
  expect(() => takeBackFolderCommand("relative")).toThrow(/not allowed/);
});

// ---------- the Claude Code adapter in a container ----------
const cctx = { prompt: "fix it", cwd: "/testbed", model: "claude-sonnet-5", limits: { timeSec: 1200, maxSteps: 40 }, inContainer: true, noWeb: true };
test("Claude Code in a container: its own user's install, bare mode, no web, the turn cap, and every model pinned to the one model", () => {
  const c = claude.command(cctx);
  expect(c.cmd).toEqual([`${BENCH_HOME}/.local/bin/claude`, "-p", "fix it", "--output-format", "json", "--model", "claude-sonnet-5", "--dangerously-skip-permissions", "--no-session-persistence",
    "--bare", "--disallowedTools", "WebSearch", "WebFetch", "--max-turns", "40"]);
  expect(c.env).toEqual({ ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-sonnet-5", CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5", DISABLE_AUTOUPDATER: "1" });
  expect(c.enforced).toEqual(["steps"]);
  expect(claude.runAs).toEqual({ user: BENCH_USER, home: BENCH_HOME });
  expect(claude.authEnv).toEqual(["ANTHROPIC_API_KEY"]);
  expect(claude.unverified).toEqual([]); expect(claude.containerUnverified).toBeUndefined();
  const old = process.env.CLAUDE_BENCH_VERSION;
  try {
    delete process.env.CLAUDE_BENCH_VERSION;
    expect(claude.containerInstall).toEqual([createUserCommand(), runAsCommand(`curl -fsSL https://claude.ai/install.sh | bash -s stable && test -x ${BENCH_HOME}/.local/bin/claude`)]);
    process.env.CLAUDE_BENCH_VERSION = "2.1.330";
    expect(claude.containerInstall![1]).toContain("bash -s 2.1.330");
    process.env.CLAUDE_BENCH_VERSION = "2.1.330; curl evil";
    expect(() => claude.containerInstall).toThrow(/CLAUDE_BENCH_VERSION/);
  } finally { if (old === undefined) delete process.env.CLAUDE_BENCH_VERSION; else process.env.CLAUDE_BENCH_VERSION = old; }
  expect(claudeVersionSpec({ CLAUDE_BENCH_VERSION: "latest" })).toBe("latest");
  // On your own computer: no bare mode (a subscription login keeps working), no web limit unless asked.
  expect(claude.command({ ...cctx, inContainer: false, noWeb: false }).cmd.slice(0, 1)).toEqual(["claude"]);
  expect(claude.command({ ...cctx, inContainer: false, noWeb: false }).cmd).not.toContain("--bare");
});
test("Claude Code result: cache reads are counted inside the input tokens and also shown on their own", () => {
  // The shape Claude Code 2.1.330 printed (trimmed).
  const out = '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.0002589,"usage":{"input_tokens":100,"cache_creation_input_tokens":3,"cache_read_input_tokens":7,"output_tokens":5},"modelUsage":{"claude-sonnet-5":{"inputTokens":100,"outputTokens":5,"cacheReadInputTokens":7,"cacheCreationInputTokens":3,"costUSD":0.0002589}}}';
  expect(claude.parse(out, "")).toMatchObject({ inputTokens: 110, outputTokens: 5, cacheReadTokens: 7, costUsd: 0.0002589, steps: 3, modelsSeen: ["claude-sonnet-5"], ok: true });
  expect(claude.parse('{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"output_tokens":5}}', "")).toMatchObject({ inputTokens: 14, cacheReadTokens: 4 });
  expect(claude.parse("no json", "").cacheReadTokens).toBeUndefined();
});
test("Syok Code gets --no-web in the fair lane, and only there", () => {
  expect(syok.command({ ...cctx }).cmd).toContain("--no-web");
  expect(syok.command({ ...cctx, noWeb: false }).cmd).not.toContain("--no-web");
});

// ---------- solveInstance with a run-as tool (a fake container that records every command) ----------
function recordingBackend(toolOut: string): { be: Backend; cmds: Array<{ c: string; env?: string[] }> } {
  const cmds: Array<{ c: string; env?: string[] }> = [];
  const be: Backend = {
    name: "rec", problem: async () => null,
    async start() {
      const box: Sandbox = {
        id: "rec",
        async exec(c, x) {
          cmds.push({ c, env: x.env });
          if (c.startsWith("git rev-parse")) return { code: 0, out: "a".repeat(40), timedOut: false };
          if (c.includes("--version")) return { code: 0, out: "2.1.330 (Claude Code)", timedOut: false };
          if (c.includes("--output-format")) return { code: 0, out: toolOut, timedOut: false };
          if (c.includes("git diff --binary")) return { code: 0, out: "diff --git a/app.py b/app.py\n", timedOut: false };
          return { code: 0, out: "0", timedOut: false };
        },
        async upload() {}, async stop() {},
      };
      return box;
    },
  };
  return { be, cmds };
}
test("solveInstance: a run-as tool gets /testbed only while it runs, then the patch is taken as root; same-model and cache reads recorded", async () => {
  const out = '{"is_error":false,"num_turns":2,"total_cost_usd":0.5,"modelUsage":{"claude-sonnet-5":{"inputTokens":10,"outputTokens":2,"cacheReadInputTokens":90,"cacheCreationInputTokens":0}}}';
  const { be, cmds } = recordingBackend(out);
  const x = normalize(row());
  const { patch, report } = await solveInstance(x, { backend: be, tool: "claude", adapter: claude, model: "claude-sonnet-5", timeoutSec: 60, maxSteps: 40, doGrade: false, logDir: tmpDir("lane-logs-"), noWeb: true, sameModelCheck: true });
  expect(report.error).toBeUndefined();
  expect(patch).toContain("diff --git a/app.py");
  const i = (s: string) => cmds.findIndex((c) => c.c.includes(s));
  const install = i("useradd"), ver = i("--version"), give = i("chown -R syokbench: /testbed"), tool = i("--output-format"), back = i('chown -R "$(cat /tmp/syok-testbed-owner.txt)" /testbed'), diff = i("git diff --binary");
  for (const k of [install, ver, give, tool, back, diff]) expect(k).toBeGreaterThanOrEqual(0);
  expect(install < give && give < tool && tool < back && back < diff && ver < tool).toBe(true);
  const t = cmds[tool];
  expect(t.c.startsWith("runuser -u syokbench -- env HOME=/home/syokbench")).toBe(true); expect(t.c.endsWith("</dev/null")).toBe(true);
  expect(t.c).toContain(`export ANTHROPIC_DEFAULT_HAIKU_MODEL='\\''claude-sonnet-5'\\''; `); // quoted once for export, once for runuser's sh -c
  expect(t.env).toEqual(["ANTHROPIC_API_KEY"]); // passed by NAME; no value anywhere in the command
  expect(report).toMatchObject({ toolVersion: "2.1.330 (Claude Code)", sameModel: true, otherModels: [], cacheReadTokens: 90, costUsd: 0.5, costSource: "tool", steps: 2 });
  expect(report.tokens).toEqual({ input: 100, output: 2, total: 102 });
});
test("solveInstance: another model in the answers is marked; a tool with no run-as user is run exactly as before", async () => {
  const { be, cmds } = recordingBackend('{"modelUsage":{"claude-sonnet-5":{"inputTokens":1,"outputTokens":1},"claude-haiku-4-5":{"inputTokens":1,"outputTokens":1}}}');
  const { report } = await solveInstance(normalize(row()), { backend: be, tool: "claude", adapter: claude, model: "claude-sonnet-5", timeoutSec: 60, doGrade: false, skipInstall: true, logDir: tmpDir("lane-logs-"), sameModelCheck: true });
  expect(report.sameModel).toBe(false); expect(report.otherModels).toEqual(["claude-haiku-4-5"]);
  const plain: Adapter = { name: "fake", label: "plain", docs: [], unverified: [], async check() { return { installed: true, loggedIn: true, version: "", detail: "" }; },
    command: () => ({ cmd: ["tool", "--output-format", "x"], enforced: [] }), parse: () => noUsage() };
  const r2 = recordingBackend("{}");
  const res = await solveInstance(normalize(row()), { backend: r2.be, tool: "fake", adapter: plain, model: "m", timeoutSec: 60, doGrade: false, skipInstall: true, logDir: tmpDir("lane-logs-") });
  expect(res.report.sameModel).toBeUndefined();
  expect(r2.cmds.find((c) => c.c.includes("--output-format"))!.c).toBe("'tool' '--output-format' 'x'");
  expect(r2.cmds.some((c) => c.c.includes("chown") || c.c.includes("runuser"))).toBe(false);
  expect(cmds.length).toBeGreaterThan(0);
});

// ---------- cost and tables ----------
test("prices: claude-sonnet-5 is $2 in / $10 out per million (cache prices written down, not used); Syok Code direct is priced from them", () => {
  const p = loadPrices(join(ROOT, "bench/prices.json"));
  expect(p["claude-sonnet-5"]).toMatchObject({ in: 2, out: 10, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2 });
  expect(instanceCost({ costUsd: null, byModel: { "anthropic / claude-sonnet-5": { input: 1e6, output: 1e5 } } }, p)).toEqual({ usd: 3, source: "prices" });
  // Syok Code named no model (no route headers from Anthropic): priced as the pinned model, and labelled so.
  expect(instanceCost({ costUsd: null, byModel: {}, inputTokens: 5e5, outputTokens: 1e5 }, p, "claude-sonnet-5")).toEqual({ usd: 2, source: "prices-assumed" });
  expect(instanceCost({ costUsd: null, byModel: {}, inputTokens: 5e5, outputTokens: 1e5 }, p)).toEqual({ usd: null, source: "unknown" });
  expect(instanceCost({ costUsd: null, inputTokens: null, outputTokens: 1 }, p, "claude-sonnet-5")).toEqual({ usd: null, source: "unknown" });
});
test("results table: cache reads shown inside the input, another model marked loudly, an unnamed model marked not confirmed", () => {
  const base: any = { instance_id: "a__b-1", image: "i", tool: "claude", model: "claude-sonnet-5", headMatchesBase: true, toolExit: 0, toolTimedOut: false, toolSeconds: 30, tokens: { input: 100, output: 2, total: 102 }, cacheReadTokens: 90, costUsd: 0.5, costSource: "tool", patchBytes: 9, quickGrade: { skipped: "x" }, outcome: "not-graded", modelsSeen: ["claude-sonnet-5"], sameModel: true, otherModels: [] };
  const md = resultsTable({ tool: "claude", model: "claude-sonnet-5", backend: "docker", gradedBy: "q", spentUsd: 0.5, label: "claude run 2" }, [base, { ...base, instance_id: "a__b-2", sameModel: false, otherModels: ["claude-haiku-4-5"], modelsSeen: ["claude-sonnet-5", "claude-haiku-4-5"] }, { ...base, instance_id: "a__b-3", sameModel: null, modelsSeen: [], cacheReadTokens: undefined, costSource: "prices-assumed" }]);
  expect(md).toContain("[claude run 2]");
  expect(md).toContain("| 100 / 2 (cache reads 90 of the input) | $0.5000 | claude-sonnet-5 |");
  expect(md).toContain("**OTHER MODEL ANSWERED: claude-haiku-4-5**");
  expect(md).toContain("| 100 / 2 | $0.5000 (est., model not reported) | not reported (model not confirmed: the tool named none) |");
});
test("per-lane table: one row per run, an 'all runs' row, official result first, Claude Code's cost labelled as its own estimate", () => {
  const rep = (id: string, o: any = {}) => ({ instance_id: id, outcome: "resolved", steps: 10, tokens: { input: 1000, output: 100 }, toolSeconds: 60, costUsd: 0.25, costSource: "tool", modelsSeen: ["claude-sonnet-5"], sameModel: true, cacheReadTokens: 800, toolVersion: "2.1.330 (Claude Code)", ...o });
  const c1 = runRow({ lane: "claude", run: 1, tool: "claude", model: "claude-sonnet-5", reports: [rep("a__a-1"), rep("b__b-2", { outcome: "wrong-patch" })] }, { resolved_ids: ["a__a-1"], unresolved_ids: ["b__b-2"] });
  const c2 = runRow({ lane: "claude", run: 2, tool: "claude", model: "claude-sonnet-5", reports: [rep("a__a-1"), rep("b__b-2", { sameModel: false, modelsSeen: ["claude-sonnet-5", "claude-haiku-4-5"] })] }, null);
  const s1 = runRow({ lane: "syok-direct", run: 1, tool: "syok-direct", model: "claude-sonnet-5", reports: [rep("a__a-1", { costUsd: 0.3, costSource: "prices", cacheReadTokens: undefined, modelsSeen: ["anthropic / claude-sonnet-5"], toolVersion: undefined }), rep("b__b-2", { steps: null, costUsd: 0.1, costSource: "prices-assumed", cacheReadTokens: undefined, modelsSeen: [], sameModel: null, toolVersion: undefined })] }, { resolved_ids: [], unresolved_ids: ["a__a-1", "b__b-2"] });
  expect(c1).toMatchObject({ official: { resolved: 1, submitted: 2 }, quick: { resolved: 1, total: 2 }, steps: 20, tokensIn: 2000, tokensOut: 200, cacheReads: 1600, wallSec: 120, costUsd: 0.5 });
  expect(s1.steps).toBeNull(); expect(s1.cacheReads).toBeNull(); expect(s1.notConfirmedInstances).toBe(1);
  const md = laneTable([c2, s1, c1]);
  expect(md).toContain("| claude | 1 | 1/2 | 1/2 | 20 | 2000 / 200 | 1600 | claude-sonnet-5 | yes | 2.1.330 (Claude Code) | 120 | $0.5000 (Claude Code estimate) |");
  expect(md).toContain("| claude | 2 | not graded | 2/2 | 20 | 2000 / 200 | 1600 | claude-haiku-4-5, claude-sonnet-5 | **NO: another model answered in 1 instance(s)** |");
  expect(md).toContain("| claude | **all 2 runs** | not graded | 3/4 | 40 | 4000 / 400 | 3200 |");
  expect(md).toContain("| syok-direct | 1 | 0/2 | 2/2 | unknown | 2000 / 200 | - | anthropic / claude-sonnet-5 | not confirmed in 1 instance(s) (no model named) | - | 120 | $0.4000 (computed from bench/prices.json; the tool did not name the model for some instances) |");
  expect(md.indexOf("| claude | 1 |")).toBeLessThan(md.indexOf("| claude | 2 |"));
  expect(md).toContain("no prompt caching");
  expect(costLabel("syok-direct", ["prices"])).toBe("computed from bench/prices.json");
  expect(costLabel("claude", ["tool", "unknown"])).toBe("unknown for some instances");
  expect(costLabel("gold", ["none"])).toBe("no AI");
});
test("pilot summary: run folders labelled lane + run give the per-lane table, then each run's own table", () => {
  const d = tmpDir("lane-sum-");
  for (const [name, lane, run] of [["2026-claude-run1", "claude", 1], ["2026-syok-direct-run1", "syok-direct", 1]] as const) {
    mkdirSync(join(d, name));
    writeFileSync(join(d, name, "results.json"), JSON.stringify({ tool: lane, lane, run, model: "claude-sonnet-5", reports: [{ instance_id: "a__a-1", outcome: "resolved", tokens: { input: 1, output: 1 }, steps: 1, toolSeconds: 1, costUsd: 0.1, costSource: lane === "claude" ? "tool" : "prices", modelsSeen: ["claude-sonnet-5"], sameModel: true }] }));
    writeFileSync(join(d, name, "results.md"), `### ${name}\n`);
    writeFileSync(join(d, name, `x.pilot-${name}.json`), JSON.stringify({ resolved_ids: ["a__a-1"] }));
  }
  const s = pilotSummary(d);
  expect(s).toContain("## Per tool");
  expect(s).toContain("| claude | 1 | 1/1 | 1/1 |"); expect(s).toContain("| syok-direct | 1 | 1/1 | 1/1 |");
  expect(s).toContain("### 2026-claude-run1"); expect(s).toContain("**Official SWE-bench harness: 1/1 resolved**");
  rmSync(d, { recursive: true, force: true });
});

// ---------- scrub: the Anthropic key ----------
test("scrub removes the Anthropic key by its variable NAME (as bench-pilot.yml passes it) from every file, and prints nothing secret", () => {
  const d = tmpDir("lane-scrub-");
  const key = "sk-ant-api03-FAKEFAKEFAKE-1234567890";
  mkdirSync(join(d, "run", "logs"), { recursive: true });
  writeFileSync(join(d, "run", "logs", "x.tool.txt"), `error: 401 for key ${key}\n`);
  writeFileSync(join(d, "run", "results.json"), JSON.stringify({ note: key }));
  const c = spawnSync("bun", ["bench/swebench/scrub.ts", d, "SYOK_API_KEY", "SYOK_BASE_URL", "SYOK_HOST", "SYOK_ACCT", "ANTHROPIC_API_KEY"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ANTHROPIC_API_KEY: key } });
  expect(c.status).toBe(0); expect(c.stdout + c.stderr).not.toContain(key);
  expect(readFileSync(join(d, "run", "logs", "x.tool.txt"), "utf8")).toBe("error: 401 for key <hidden>\n");
  expect(readFileSync(join(d, "run", "results.json"), "utf8")).not.toContain(key);
  // The workflow's scrub step names the Anthropic key too, and gives the step its value.
  const wf = readFileSync(join(ROOT, ".github/workflows/bench-pilot.yml"), "utf8");
  expect(wf).toContain('bun bench/swebench/scrub.ts "$RUNNER_TEMP/pilot" SYOK_API_KEY SYOK_BASE_URL SYOK_HOST SYOK_ACCT ANTHROPIC_API_KEY');
  rmSync(d, { recursive: true, force: true });
});

// ---------- the real thing: Docker (it is running on GitHub's Linux machines) ----------
const dockerUp = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
test.skipIf(!dockerUp)("REAL Docker: a run-as tool works as a non-root user in /testbed, and the root-side patch still works afterwards", async () => {
  const d = tmpDir("lane-docker-");
  const tag = "syok-bench-runas-test:" + Date.now();
  writeFileSync(join(d, "Dockerfile"), [
    "FROM buildpack-deps:bookworm-scm",
    "RUN mkdir /testbed && cd /testbed && git init -q && printf 'v = 1\\n' > app.py && git add app.py && git -c user.email=a@b -c user.name=a commit -qm base",
  ].join("\n") + "\n");
  expect(spawnSync("docker", ["build", "-q", "-t", tag, d], { encoding: "utf8", timeout: 600000 }).status).toBe(0);
  try {
    const base = spawnSync("docker", ["run", "--rm", "--entrypoint", "git", tag, "-C", "/testbed", "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    process.env.SB_RUNAS_KEY = "value-passed-by-name";
    // The tool records who it ran as and whether the key arrived, edits a file and commits (as Claude Code may).
    const tool: Adapter = { name: "fake", label: "run-as tool", docs: [], unverified: [], authEnv: ["SB_RUNAS_KEY"], runAs: { user: BENCH_USER, home: BENCH_HOME }, containerInstall: [createUserCommand()],
      async check() { return { installed: true, loggedIn: true, version: "", detail: "" }; },
      command: () => ({ cmd: ["sh", "-c", "printf 'uid=%s home=%s key=%s\\n' \"$(id -u)\" \"$HOME\" \"${SB_RUNAS_KEY:+set}\" > who.txt && printf 'v = 2\\n' > app.py && git -c user.email=a@b -c user.name=a commit -qam tool && echo '{}'"], enforced: [] }),
      parse: () => noUsage() };
    const x = normalize(row({ instance_id: "local__runas-1", base_commit: base, image: tag }));
    const { patch, report } = await solveInstance(x, { backend: dockerBackend(), tool: "fake", adapter: tool, model: "m", timeoutSec: 120, doGrade: false, logDir: tmpDir("lane-logs-") });
    expect(report.error).toBeUndefined();
    expect(patch).toContain("+v = 2");
    expect(patch).toMatch(new RegExp(`\\+uid=[1-9][0-9]* home=${BENCH_HOME} key=set`)); // not root (uid 0), the user's home, the key by name
    expect(patch).not.toContain("value-passed-by-name");
  } finally { delete process.env.SB_RUNAS_KEY; spawnSync("docker", ["rmi", "-f", tag]); rmSync(d, { recursive: true, force: true }); }
}, 900000);
