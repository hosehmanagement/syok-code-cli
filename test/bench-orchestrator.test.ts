// The comparison orchestrator (bench/run.ts), tested with the fake tool: no AI, no money.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadScenario, materialize } from "../bench/lib/scenario.ts";
import { runOne, markdown, canonical, parsePin, laneOf, laneProblems, otherModels, costOf, estimateSpend } from "../bench/lib/bench.ts";
import { fake } from "../bench/adapters/fake.ts";
import { claude } from "../bench/adapters/claude.ts";
import { codex } from "../bench/adapters/codex.ts";
import { cursor } from "../bench/adapters/cursor.ts";
import { syok } from "../bench/adapters/syok.ts";
import { noUsage } from "../bench/adapters/types.ts";
import { tmpDir } from "./helpers.ts";

const ROOT = resolve(import.meta.dir, "..");
const put = (base: string, files: Record<string, string>) => { for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(base, p)), { recursive: true }); writeFileSync(join(base, p), c); } };
const T = (body: string) => `const test = require('node:test'); const assert = require('node:assert');\n${body}\n`;
const BUG = "function add(a, b) { return a - b; }\nmodule.exports = { add };\n";
const FIX = "function add(a, b) { return a + b; }\nmodule.exports = { add };\n";
/** A tiny scenario: add() is wrong; test/visible.test.js is protected; other.js has its own test that passes before. */
function scenario(extra: Record<string, any> = {}, overlays: Record<string, Record<string, string>> = {}) {
  const d = tmpDir("bench-sc-");
  put(join(d, "repo"), {
    "package.json": '{"type":"commonjs"}', "lib/add.js": BUG,
    "lib/other.js": "module.exports = { two: () => 2 };\n",
    "test/visible.test.js": T("const { add } = require('../lib/add');\ntest('adds', () => assert.strictEqual(add(2, 3), 5));"),
    "test/other.test.js": T("const { two } = require('../lib/other');\ntest('two', () => assert.strictEqual(two(), 2));"),
  });
  put(join(d, "grader"), { "test/hidden.test.js": T("const { add } = require('../lib/add');\ntest('more', () => assert.strictEqual(add(-1, 1), 0));") });
  put(join(d, "solution"), { "lib/add.js": FIX });
  for (const [name, files] of Object.entries(overlays)) put(join(d, "fake", name), files);
  writeFileSync(join(d, "scenario.json"), JSON.stringify({
    id: "tiny", source: { type: "dir", path: "repo" }, prompt: "Fix add().", limits: { timeSec: 60, maxSteps: 5, maxCostUsd: 0.5 },
    tests: [{ name: "visible", command: "node --test test/visible.test.js" }, { name: "other", command: "node --test test/other.test.js" }],
    protected: ["test/visible.test.js", "test/other.test.js"], grader: { command: "node --test", files: "grader" }, ...extra,
  }));
  return d;
}
const logDir = () => tmpDir("bench-logs-");
const go = (dir: string, how: string, more: Partial<Parameters<typeof runOne>[1]> = {}) => { process.env.BENCH_FAKE = how; return runOne(loadScenario(dir), { adapter: fake, toolName: "syok", pin: parsePin("claude-x"), runNo: 1, prices: {}, logDir: logDir(), ...more }); };
afterEach(() => { delete process.env.BENCH_FAKE; delete process.env.BENCH_FAKE_SLEEP; delete process.env.BENCH_FAKE_MODEL; });

test("a correct fix passes clean; tokens come from the tool's own JSON; nobody had to help", async () => {
  const r = await go(scenario(), "solve");
  expect(r.error).toBeUndefined();
  expect(r.passed).toBe(true); expect(r.clean).toBe(true);
  expect(r.regressions).toEqual([]); expect(r.testsWeakened).toEqual([]);
  expect(r.tokens).toEqual({ input: 1000, output: 200, total: 1200 });
  expect(r.cost).toEqual({ usd: null, source: "unknown" });
  expect(r.humanInterventions).toBe(0);
  expect(readFileSync(r.files.patch, "utf8")).toContain("+function add(a, b) { return a + b; }");
}, 60000);

test("doing nothing fails the grader", async () => {
  const r = await go(scenario(), "noop");
  expect(r.passed).toBe(false); expect(r.clean).toBe(false); expect(r.patchBytes).toBe(0);
}, 60000);

test("a fix that also edits a protected test passes but is NOT clean, and the edited file is named", async () => {
  const d = scenario({}, { tamper: { "lib/add.js": FIX, "test/visible.test.js": T("test('adds', () => {});") } });
  const r = await go(d, "tamper");
  expect(r.testsWeakened).toEqual(["test/visible.test.js"]);
  expect(r.passed).toBe(true); expect(r.clean).toBe(false);
}, 60000);

test("weakening the tests instead of fixing the code does not pass: grading uses the original tests", async () => {
  const d = scenario({ grader: { command: "node --test test/visible.test.js" } }, { cheat: { "test/visible.test.js": T("test('adds', () => {});") } });
  const r = await go(d, "cheat");
  expect(r.testsWeakened).toEqual(["test/visible.test.js"]);
  expect(r.passed).toBe(false);
}, 60000);

test("deleting a protected test is caught too", async () => {
  const d = scenario();
  const sc = loadScenario(d);
  // a "tool" that deletes the protected file and fixes the code
  const del = { ...fake, command: (c: any) => ({ cmd: ["bash", "-c", `rm test/other.test.js && cp ${JSON.stringify(join(d, "solution", "lib", "add.js"))} lib/add.js`], enforced: [] as any }) };
  const r = await runOne(sc, { adapter: del, toolName: "syok", pin: parsePin("m"), runNo: 1, prices: {}, logDir: logDir() });
  expect(r.testsWeakened).toEqual(["test/other.test.js"]);
  expect(r.regressions).toEqual([]); // the original file is put back before the tests run
}, 60000);

test("breaking code that used to work is counted as a regression", async () => {
  const d = scenario({ grader: { command: "node --test test/visible.test.js test/hidden.test.js", files: "grader" } }, { regress: { "lib/add.js": FIX, "lib/other.js": "module.exports = { two: () => 3 };\n" } });
  const r = await go(d, "regress");
  expect(r.passed).toBe(true);
  expect(r.regressions).toEqual(["other"]);
  expect(r.clean).toBe(false);
}, 60000);

test("the hard time limit kills the tool and everything it started", async () => {
  const d = scenario({ limits: { timeSec: 2 } });
  const marker = String(600 + Math.floor(Math.random() * 300));
  process.env.BENCH_FAKE_SLEEP = marker;
  const t0 = Date.now();
  const r = await go(d, "hang");
  expect(r.timedOut).toBe(true);
  expect(Date.now() - t0).toBeLessThan(40000);
  expect(r.passed).toBe(false);
  await Bun.sleep(300);
  const left = spawnSync("pgrep", ["-f", `^sleep ${marker}$`], { encoding: "utf8" });
  expect(left.stdout.trim()).toBe(""); // the grandchild died with the group
}, 60000);

test("a tool that reports another model is marked", async () => {
  process.env.BENCH_FAKE_MODEL = "gpt-9";
  const r = await go(scenario(), "solve");
  expect(r.otherModels).toEqual(["fake / gpt-9"]);
});

test("results table: one row per run, the per-tool summary, and unknown instead of guesses", async () => {
  const a = await go(scenario(), "solve");
  const b = await go(scenario(), "noop", { toolName: "claude" });
  const md = markdown([a, b], { started: "x", lane: "claude" });
  expect(md).toContain("| Scenario | Tool | Model | Run | Passed | Regressions | Tests weakened | Tokens | Cost | Time (s) | Human help | Notes |");
  expect(md).toContain("| tiny | syok | claude-x | 1 | yes | 0 | 0 | 1200 | unknown |");
  expect(md).toContain("| tiny | claude | claude-x | 1 | no |");
  expect(md).toContain("| syok | 1/1 | 1/1 |");
  expect(md).toContain("| claude | 0/1 | 0/1 |");
  expect(md).toContain("Lane: **claude**");
}, 60000);

test("scenario files are checked: a pinned commit must be a full hash, protected paths stay inside the project", () => {
  const d = scenario({ source: { type: "git", url: "https://example.invalid/x.git", commit: "main" } });
  expect(() => loadScenario(d)).toThrow(/full 40-character commit/);
  const e = scenario({ protected: ["../etc/passwd"] });
  expect(() => loadScenario(e)).toThrow(/relative to the project/);
});

test("a git source is cloned and checked out at exactly the pinned commit", async () => {
  const origin = tmpDir("bench-origin-");
  const g = (...a: string[]) => spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd: origin, encoding: "utf8" });
  g("init", "-q"); writeFileSync(join(origin, "f.txt"), "one\n"); g("add", "-A"); g("commit", "-qm", "1");
  const first = g("rev-parse", "HEAD").stdout.trim();
  writeFileSync(join(origin, "f.txt"), "two\n"); g("commit", "-qam", "2");
  const d = scenario({ source: { type: "git", url: origin, commit: first } });
  const work = tmpDir("bench-w-");
  const base = await materialize(loadScenario(d), join(work, "p"));
  expect(base).toBe(first);
  expect(readFileSync(join(work, "p", "f.txt"), "utf8")).toBe("one\n");
}, 60000);

test("the three sample scenarios are valid (fail before the fix, pass after, existing tests pass)", () => {
  const r = spawnSync("bun", ["bench/run.ts", "--check"], { cwd: ROOT, encoding: "utf8" });
  expect(r.stdout).toContain("all 3 scenarios are valid");
  expect(r.status).toBe(0);
}, 120000);

test("--dry-run runs the whole pipeline with the fake tool and writes JSON and Markdown", () => {
  const out = tmpDir("bench-out-");
  const r = spawnSync("bun", ["bench/run.ts", "--dry-run", "--tools", "syok,codex", "--only", "py-parse-duration", "--out", out], { cwd: ROOT, encoding: "utf8" });
  expect(r.status).toBe(0);
  const run = readdirSync(out).find((d) => d.endsWith("-dry-run"))!;
  const j = JSON.parse(readFileSync(join(out, run, "results.json"), "utf8"));
  expect(j.rows.length).toBe(2);
  expect(j.rows.every((x: any) => x.passed && x.clean)).toBe(true);
  expect(readFileSync(join(out, run, "results.md"), "utf8")).toContain("**Dry run:**");
}, 120000);

// ---------- the fair-test lane ----------
test("model names are compared in one spelling", () => {
  expect(canonical("anthropic/Claude_Sonnet.4-5")).toBe("claude-sonnet-4-5");
  expect(parsePin("sonnet-4.5=claude-sonnet-4-5")).toEqual({ pass: "sonnet-4.5", canonical: "claude-sonnet-4-5" });
  expect(laneOf("claude-opus-4-5")).toBe("claude"); expect(laneOf("gpt-5")).toBe("gpt"); expect(laneOf("gemini-3")).toBe(null);
});
test("the lane refuses tools on different models, a model from the other lane, and a tool with no model", () => {
  expect(laneProblems("claude", { syok: parsePin("claude-a"), claude: parsePin("claude-a") })).toEqual([]);
  expect(laneProblems("claude", { syok: parsePin("claude-a"), claude: parsePin("claude-b") }).join(" ")).toContain("different models");
  expect(laneProblems("claude", { syok: parsePin("claude-a"), codex: parsePin("gpt-5") }).join(" ")).toContain("codex is pinned to \"gpt-5\", which is not a claude model");
  expect(laneProblems("gpt", { codex: undefined }).join(" ")).toContain("codex has no pinned model");
  expect(laneProblems("claude", { syok: parsePin("claude-a"), cursor: parsePin("ca=claude-a") })).toEqual([]);
});
test("bench/run.ts --lane prints why it refuses and spends nothing", () => {
  const r = spawnSync("bun", ["bench/run.ts", "--tools", "syok,codex", "--lane", "claude", "--model-syok", "claude-a", "--model-codex", "gpt-5"], { cwd: ROOT, encoding: "utf8" });
  expect(r.status).toBe(3);
  expect(r.stderr).toContain("Refusing to compare in the claude lane");
  expect(r.stderr).toContain("same model with a different harness");
});
test("a plan above --max-spend needs --yes", () => {
  const r = spawnSync("bun", ["bench/run.ts", "--tools", "syok,claude", "--model", "claude-a", "--runs", "3", "--max-spend", "1"], { cwd: ROOT, encoding: "utf8" });
  expect(r.status).toBe(4);
  expect(r.stderr).toContain("Add --yes");
  expect(estimateSpend([loadScenario(join(ROOT, "bench/scenarios/py-parse-duration"))], 2, 3)).toBe(6);
});
test("other models seen in a tool's output are found", () => {
  expect(otherModels(["claude-sonnet-4-5-20250929", "claude-haiku-4-5"], parsePin("claude-sonnet-4-5"))).toEqual(["claude-haiku-4-5"]);
});
test("cost: the tool's own number first, then bench/prices.json, else unknown", () => {
  const u = { ...noUsage(), inputTokens: 1_000_000, outputTokens: 100_000 };
  expect(costOf(u, parsePin("m-1"), { "m-1": { in: 2, out: 10 } })).toEqual({ usd: 3, source: "prices" });
  expect(costOf({ ...u, costUsd: 0.5 }, parsePin("m-1"), {})).toEqual({ usd: 0.5, source: "tool" });
  expect(costOf(u, parsePin("m-1"), {})).toEqual({ usd: null, source: "unknown" });
});

// ---------- adapters: exact commands and output parsing ----------
const ctx = { prompt: "do it", cwd: "/p", model: "M", limits: { timeSec: 60, maxSteps: 7, maxCostUsd: 1.5 } };
test("claude: documented headless flags, limits passed on, and cost/tokens read from its JSON", () => {
  const c = claude.command(ctx);
  expect(c.cmd).toEqual(["claude", "-p", "do it", "--output-format", "json", "--model", "M", "--dangerously-skip-permissions", "--no-session-persistence", "--max-turns", "7", "--max-budget-usd", "1.5"]);
  expect(c.enforced).toEqual(["steps", "cost"]);
  const u = claude.parse('{"type":"result","is_error":false,"num_turns":4,"total_cost_usd":0.12,"usage":{"input_tokens":10,"output_tokens":5},"modelUsage":{"claude-x":{"inputTokens":100,"outputTokens":20,"cacheReadInputTokens":50,"cacheCreationInputTokens":0,"costUSD":0.12}}}', "");
  expect(u).toMatchObject({ costUsd: 0.12, inputTokens: 150, outputTokens: 20, totalTokens: 170, steps: 4, ok: true, modelsSeen: ["claude-x"] });
  expect(claude.parse('{"usage":{"input_tokens":10,"output_tokens":5}}', "")).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null });
});
test("codex: exec with --json, the model pinned, and the LAST turn.completed total (not a sum)", () => {
  expect(codex.command(ctx).cmd).toEqual(["codex", "exec", "--json", "-m", "M", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-C", "/p", "do it"]);
  const out = ['{"type":"thread.started","thread_id":"t"}', '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"reasoning_output_tokens":3}}', '{"type":"turn.completed","usage":{"input_tokens":250,"cached_input_tokens":90,"output_tokens":30,"reasoning_output_tokens":5}}'].join("\n");
  expect(codex.parse(out, "")).toMatchObject({ inputTokens: 250, outputTokens: 30, totalTokens: 280, costUsd: null, ok: true });
  expect(codex.parse('{"type":"turn.failed","error":{"message":"x"}}', "").ok).toBe(false);
});
test("cursor: print mode with --force and --trust; no documented usage, so tokens stay unknown", () => {
  const c = cursor.command({ ...ctx, inContainer: true });
  expect(c.cmd).toEqual(["agent", "-p", "do it", "--output-format", "json", "--model", "M", "--force", "--trust", "--workspace", "/p"]);
  expect(c.enforced).toEqual([]);
  expect(cursor.parse('{"type":"result","subtype":"success","is_error":false,"duration_ms":5,"result":"ok"}', "")).toMatchObject({ inputTokens: null, totalTokens: null, costUsd: null, ok: true });
  expect(cursor.unverified.length).toBeGreaterThan(0);
});
test("syok: its own --json flags and usage field", () => {
  const c = syok.command(ctx);
  expect(c.cmd.slice(-12)).toEqual(["-p", "do it", "--json", "--mode", "auto", "--no-stream", "--model", "M", "--cwd", "/p", "--max-steps", "7"]);
  expect(syok.parse('log\n{"steps":2,"tokens":30,"stopped":"finished","usage":{"input":20,"output":10,"total":30,"steps":2,"by":{"anthropic / claude-x":{}}}}', "")).toMatchObject({ inputTokens: 20, outputTokens: 10, totalTokens: 30, steps: 2, ok: true, modelsSeen: ["anthropic / claude-x"] });
});
test("CI runs the bench self-check", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  expect(ci).toContain("bun bench/run.ts --check");
  expect(existsSync(join(ROOT, "bench/README.md"))).toBe(true);
});
