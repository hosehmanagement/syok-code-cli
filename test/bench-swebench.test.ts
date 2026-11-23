// The SWE-bench adapter (bench/swebench/): dataset reading, the fixed random choice, the official prediction format, the
// quick grade, and the execution backends: Docker and Modal with fakes, and Docker for real when Docker is running.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { officialImage, normalize, readDataset, select, predictionLine, promptFor, type Instance } from "../bench/swebench/dataset.ts";
import { grade, parsePytest, parseDjango, parseSympy, testSection } from "../bench/swebench/grade.ts";
import { dockerBackend, modalBackend, MERGE, type Backend, type Sandbox } from "../bench/swebench/backends.ts";
import { solveInstance, quickGrade, instanceCost, outcomeOf, resultsTable, diffCommand, imageChangesCommand } from "../bench/swebench/run.ts";
import type { Adapter } from "../bench/adapters/types.ts";
import { syok } from "../bench/adapters/syok.ts";
import { scrub } from "../bench/swebench/scrub.ts";
import { pilotSummary, officialStatus } from "../bench/swebench/summary.ts";
import { noUsage } from "../bench/adapters/types.ts";
import { tmpDir } from "./helpers.ts";

const ROOT = resolve(import.meta.dir, "..");
const row = (o: any = {}) => ({ instance_id: "owner__repo-1", repo: "owner/repo", base_commit: "a".repeat(40), problem_statement: "It breaks.", FAIL_TO_PASS: '["t.py::test_a"]', PASS_TO_PASS: '["t.py::test_b"]', ...o });

test("the official image name, exactly as the harness builds it (checked against the dataset's own image field)", () => {
  expect(officialImage("astropy__astropy-12907")).toBe("swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest");
  expect(officialImage("psf__requests-1142")).toBe("swebench/sweb.eval.x86_64.psf_1776_requests-1142:latest");
  expect(officialImage("Foo__Bar-1", { arch: "arm64", tag: "v2" })).toBe("swebench/sweb.eval.arm64.foo_1776_bar-1:v2");
});
test("both dataset formats: lists as JSON text (princeton-nlp) or real lists with image and eval_script (SWE-bench/)", () => {
  const a = normalize(row());
  expect(a.FAIL_TO_PASS).toEqual(["t.py::test_a"]); expect(a.image).toBe("swebench/sweb.eval.x86_64.owner_1776_repo-1:latest"); expect(a.imageFromRow).toBe(false);
  const b = normalize(row({ FAIL_TO_PASS: ["x"], PASS_TO_PASS: [], image: "img:1", eval_script: "#!/bin/bash", log_parser: "parse_log_pytest" }));
  expect(b.image).toBe("img:1"); expect(b.imageFromRow).toBe(true); expect(b.eval_script).toBe("#!/bin/bash");
  expect(() => normalize({ instance_id: "x" })).toThrow(/repo is missing/);
  expect(() => normalize(row({ FAIL_TO_PASS: "nope" }))).toThrow(/FAIL_TO_PASS/);
  const d = tmpDir("sb-"); writeFileSync(join(d, "a.jsonl"), JSON.stringify(row()) + "\n" + JSON.stringify(row({ instance_id: "b__c-2" })) + "\n");
  expect(readDataset(join(d, "a.jsonl")).map((x) => x.instance_id)).toEqual(["owner__repo-1", "b__c-2"]);
  writeFileSync(join(d, "a.json"), JSON.stringify([row()]));
  expect(readDataset(join(d, "a.json")).length).toBe(1);
});
test("--n with a seed picks the same instances whatever order the file is in; --ids keeps the given order", () => {
  const all = Array.from({ length: 30 }, (_, i) => normalize(row({ instance_id: `r__r-${i}` })));
  const a = select(all, { n: 5, seed: 7 }).map((x) => x.instance_id);
  const b = select([...all].reverse(), { n: 5, seed: 7 }).map((x) => x.instance_id);
  expect(a).toEqual(b); expect(a.length).toBe(5);
  expect(select(all, { n: 5, seed: 8 }).map((x) => x.instance_id)).not.toEqual(a);
  expect(select(all, { ids: ["r__r-3", "r__r-1"] }).map((x) => x.instance_id)).toEqual(["r__r-3", "r__r-1"]);
  expect(() => select(all, { ids: ["nope"] })).toThrow(/Not in the dataset: nope/);
});
test("predictions.jsonl lines have exactly the three fields the official harness reads", () => {
  const j = JSON.parse(predictionLine("a__b-1", "syok__m", "diff --git a/x b/x\n"));
  expect(Object.keys(j)).toEqual(["instance_id", "model_name_or_path", "model_patch"]);
  expect(j).toEqual({ instance_id: "a__b-1", model_name_or_path: "syok__m", model_patch: "diff --git a/x b/x\n" });
  expect(promptFor(normalize(row()))).toContain("<issue>\nIt breaks.\n</issue>");
});

// ---------- quick grade ----------
const LOG = `noise before\n+ : '>>>>> Start Test Output'\nPASSED t.py::test_a\nFAILED t.py::test_b - AssertionError: x\nXFAIL t.py::test_c\n+ : '>>>>> End Test Output'\nPASSED t.py::outside`;
test("pytest -rA results are read only between the eval script's markers, with the harness's pass rule", () => {
  expect(testSection(LOG)).not.toContain("outside");
  expect(parsePytest(testSection(LOG))).toEqual({ "t.py::test_a": "PASSED", "t.py::test_b": "FAILED", "t.py::test_c": "XFAIL" });
  const g = grade(LOG, ["t.py::test_a", "t.py::test_c"], ["t.py::test_b"]);
  expect(g.resolved).toBe(false); expect(g.failToPass.passed).toBe(2); expect(g.passToPass.failing).toEqual(["t.py::test_b"]);
  expect(grade(LOG, ["t.py::test_a"], []).resolved).toBe(true);
  expect(grade(LOG, ["t.py::missing"], []).resolved).toBe(false); // a test that did not run counts as failed
  expect(grade(LOG, [], []).resolved).toBe(false);
});
test("django and sympy output", () => {
  expect(parseDjango("test_a (m.T) ... ok\ntest_b (m.T) ... FAIL\ntest_c (m.T) ... skipped 'x'\ntest_d (m.T) ... some output\nok")).toEqual({ "test_a (m.T)": "PASSED", "test_b (m.T)": "FAILED", "test_c (m.T)": "SKIPPED", "test_d (m.T)": "PASSED" });
  expect(parseSympy("test_one ok\ntest_two F\ntest_three E")).toEqual({ test_one: "PASSED", test_two: "FAILED", test_three: "ERROR" });
  expect(grade("test_a (m.T) ... ok", ["test_a (m.T)"], [], "parse_log_django").resolved).toBe(true);
});

// ---------- backends with fakes ----------
test("Docker backend: pulls a missing image, keeps the container waiting, passes logins by NAME only, kills on timeout, removes the container", async () => {
  const calls: string[][] = [];
  const fakeDocker = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "image") return { code: 1, stdout: "", stderr: "no such image", timedOut: false, ms: 1 };
    if (args[0] === "exec") return { code: 0, stdout: "out", stderr: "", timedOut: false, ms: 1 };
    return { code: 0, stdout: "", stderr: "", timedOut: false, ms: 1 };
  };
  process.env.SB_SECRET_TEST = "s3cret-value";
  const be = dockerBackend(fakeDocker as any);
  expect(await be.problem()).toBe(null);
  const box = await be.start("img:1", { timeoutSec: 100, platform: "linux/amd64" });
  const r = await box.exec("echo hi", { cwd: "/testbed", timeoutSec: 30, env: ["SB_SECRET_TEST"] });
  await box.upload("/tmp/a", "/tmp/b"); await box.stop();
  expect(r).toEqual({ code: 0, out: "out", timedOut: false });
  expect(calls.find((c) => c[0] === "pull")).toEqual(["pull", "--platform", "linux/amd64", "img:1"]);
  const runC = calls.find((c) => c[0] === "run")!;
  expect(runC).toEqual(["run", "-d", "--name", box.id, "--platform", "linux/amd64", "--entrypoint", "sleep", "img:1", "700"]);
  const ex = calls.find((c) => c[0] === "exec")!;
  expect(ex).toEqual(["exec", "-w", "/testbed", "-e", "SB_SECRET_TEST", box.id, "timeout", "-s", "KILL", "30", "sh", "-c", MERGE + "echo hi"]);
  expect(JSON.stringify(calls)).not.toContain("s3cret-value");
  expect(calls.find((c) => c[0] === "cp")![2]).toMatch(/^syok-bench-.*:\/tmp\/b$/);
  expect(calls.at(-1)!.slice(0, 2)).toEqual(["rm", "-f"]);
  delete process.env.SB_SECRET_TEST;
});
test("Docker backend says plainly when Docker is not running", async () => {
  const be = dockerBackend((async () => ({ code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon", timedOut: false, ms: 1 })) as any);
  expect(await be.problem()).toContain("Docker is not running");
});
test("Modal backend uses Syok Code's own Modal provider (src/remote-modal.ts API) and switches the sandbox off", async () => {
  const seen: any = { exec: [] as string[], terminated: false, image: "" };
  const provider: any = {
    name: "Modal", problem: async () => null, close: () => {}, attach: async () => { throw new Error("no"); },
    create: async (o: any) => { seen.image = o.image; return { id: "sb-1", upload: async () => {}, download: async () => {}, exec: async (cmd: string, x: any) => { seen.exec.push(cmd); x.onOut?.("hello"); return 0; }, terminate: async () => { seen.terminated = true; } }; },
  };
  process.env.SB_MODAL_KEY = "k'1";
  const be = modalBackend(provider);
  const box = await be.start("img:2", { timeoutSec: 50 });
  const r = await box.exec("echo hi", { cwd: "/testbed", timeoutSec: 20, env: ["SB_MODAL_KEY"] });
  await box.stop();
  expect(seen.image).toBe("img:2"); expect(r.out).toBe("hello"); expect(r.code).toBe(0); expect(seen.terminated).toBe(true);
  expect(seen.exec[0]).toBe(`export SB_MODAL_KEY='k'\\''1'; timeout -s KILL 20 sh -c 'exec 2>&1; echo hi'`);
  delete process.env.SB_MODAL_KEY;
});

// A backend whose "container" is a folder on this computer standing in for /testbed. It runs the real git commands.
function localBackend(): { be: Backend; dirs: string[] } {
  const dirs: string[] = [];
  const be: Backend = {
    name: "local", problem: async () => null,
    async start() {
      const d = tmpDir("sb-testbed-"); dirs.push(d);
      // A fixed committer date too, so every "image" has the same base commit (otherwise two starts a second apart differ).
      const g = (...a: string[]) => spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", ...a], { cwd: d, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
      g("init", "-q"); writeFileSync(join(d, "app.py"), "v = 1\n"); g("add", "-A"); g("commit", "-qm", "base", "--date", "2026-01-01T00:00:00Z");
      mkdirSync(join(d, "build")); writeFileSync(join(d, "build", "junk.py"), "built\n"); // untracked output already in the image
      const tmp = join(d, ".tmp"); mkdirSync(tmp); writeFileSync(join(d, ".git", "info", "exclude"), ".tmp/\n");
      const map = (s: string) => s.replace(/\/tmp\//g, tmp + "/").replace(/\/testbed/g, d);
      const box: Sandbox = {
        id: d,
        async exec(command, x) { const r = spawnSync("sh", ["-c", MERGE + map(command)], { cwd: x.cwd ? map(x.cwd) : d, encoding: "utf8", timeout: x.timeoutSec * 1000 }); return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), timedOut: !!r.error }; },
        async upload(local, remote) { cpSync(local, map(remote)); },
        async stop() {},
      };
      return box;
    },
  };
  return { be, dirs };
}
const head = (d: string) => spawnSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).stdout.trim();

test("solveInstance: the patch holds the tool's edits and new files, NOT the untracked build output already in the image", async () => {
  const { be, dirs } = localBackend();
  const probe = await be.start("x", { timeoutSec: 10 }); const base = head(probe.id);
  const tool: Adapter = { name: "fake", label: "edit tool", docs: [], unverified: [], containerInstall: [], async check() { return { installed: true, loggedIn: true, version: "", detail: "" }; },
    command: () => ({ cmd: ["sh", "-c", "printf 'v = 2\\n' > app.py && printf 'new\\n' > added.py && echo '{\"usage\":{\"input\":5,\"output\":2,\"total\":7}}'"], enforced: [] }),
    parse: (out) => ({ ...noUsage(), totalTokens: out.includes('"total":7') ? 7 : null }) };
  const x: Instance = normalize(row({ base_commit: base }));
  const logDir = tmpDir("sb-logs-");
  const { patch, report } = await solveInstance(x, { backend: be, tool: "fake", adapter: tool, model: "m", timeoutSec: 60, doGrade: false, skipInstall: true, logDir });
  expect(report.error).toBeUndefined();
  expect(report.headMatchesBase).toBe(true);
  expect(report.tokens.total).toBe(7);
  expect(patch).toContain("diff --git a/app.py b/app.py"); expect(patch).toContain("+v = 2");
  expect(patch).toContain("diff --git a/added.py b/added.py");
  expect(patch).not.toContain("junk.py");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
test("solveInstance passes --max-steps to the tool and records which models answered, provider switches and cost (unknown without prices)", async () => {
  const { be, dirs } = localBackend();
  const probe = await be.start("x", { timeoutSec: 10 }); const base = head(probe.id);
  let seenSteps: number | undefined;
  const out = '(switched provider: groq -> mistral)\n{"summary":"done","steps":3,"stopped":"finished","usage":{"input":100,"output":20,"total":120,"steps":3,"by":{"groq / gpt-oss-120b":{"steps":1,"input":40,"output":5},"mistral / codestral-latest":{"steps":2,"input":60,"output":15}}}}';
  const tool: Adapter = { ...syok, containerInstall: [], command: (c) => { seenSteps = c.limits.maxSteps; return { cmd: ["sh", "-c", "printf 'v = 2\\n' > app.py; cat <<'EOF'\n" + out + "\nEOF"], enforced: ["steps"] }; } };
  const x: Instance = normalize(row({ base_commit: base }));
  const o = { backend: be, tool: "syok", adapter: tool, model: "syok-coder", timeoutSec: 60, maxSteps: 7, doGrade: false, skipInstall: true, logDir: tmpDir("sb-logs-") };
  const { report } = await solveInstance(x, o);
  expect(report.error).toBeUndefined();
  expect(seenSteps).toBe(7);
  expect(report.modelsSeen).toEqual(["groq / gpt-oss-120b", "mistral / codestral-latest"]);
  expect(report.byModel!["mistral / codestral-latest"]).toEqual({ steps: 2, input: 60, output: 15 });
  expect(report.switches).toEqual(["(switched provider: groq -> mistral)"]);
  expect(report.tokens).toEqual({ input: 100, output: 20, total: 120 });
  expect(report.costUsd).toBeNull(); expect(report.costSource).toBe("unknown");
  const priced = await solveInstance(x, { ...o, prices: { "gpt-oss": { in: 1, out: 2 }, codestral: { in: 10, out: 20 } } });
  expect(priced.report.costSource).toBe("prices");
  expect(priced.report.costUsd).toBeCloseTo((40 * 1 + 5 * 2 + 60 * 10 + 15 * 20) / 1e6, 12);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
test("an image that already changed a tracked file (like the sphinx images' tox.ini): noop gives an EMPTY patch, and a tool's patch holds only its own change", async () => {
  const { be: inner, dirs } = localBackend();
  // The image's own setup edits a tracked file and leaves a modified, committed-nowhere line in it.
  const be: Backend = { ...inner, async start(i, o) { const b = await inner.start(i, o); writeFileSync(join(b.id, "app.py"), "v = 1\n# setup edit\n"); return b; } };
  const probe = await inner.start("x", { timeoutSec: 10 }); const base = head(probe.id);
  const x: Instance = normalize(row({ base_commit: base }));
  const logDir = tmpDir("sb-logs-");
  const noop = await solveInstance(x, { backend: be, tool: "noop", model: "noop", timeoutSec: 60, doGrade: false, logDir });
  expect(noop.report.error).toBeUndefined();
  expect(noop.report.imageChangedFiles).toBe(1);
  expect(noop.patch).toBe(""); expect(noop.report.patchBytes).toBe(0);
  const tool: Adapter = { name: "fake", label: "edit tool", docs: [], unverified: [], containerInstall: [], async check() { return { installed: true, loggedIn: true, version: "", detail: "" }; },
    command: () => ({ cmd: ["sh", "-c", "printf 'v = 2\\n# setup edit\\n' > app.py && printf 'new\\n' > added.py && git -c user.email=a@b -c user.name=a commit -qam 'tool committed anyway'"], enforced: [] }), parse: () => noUsage() };
  const ed = await solveInstance(x, { backend: be, tool: "fake", adapter: tool, model: "m", timeoutSec: 60, doGrade: false, skipInstall: true, logDir });
  expect(ed.report.error).toBeUndefined();
  expect(ed.patch).toContain("-v = 1"); expect(ed.patch).toContain("+v = 2");
  expect(ed.patch).not.toContain("+# setup edit"); // the image's own edit is in both snapshots, so not in the patch
  expect(ed.patch).toContain("diff --git a/added.py b/added.py");
  expect(ed.patch).not.toContain("junk.py");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
test("Syok Code's own .syok/ folder (saved chats) never reaches the patch or predictions.jsonl; the code change does", async () => {
  const { be, dirs } = localBackend();
  const probe = await be.start("x", { timeoutSec: 10 }); const base = head(probe.id);
  expect(syok.patchExclude).toEqual([".syok/"]);
  const tool: Adapter = { ...syok, containerInstall: [], command: () => ({ cmd: ["sh", "-c", "mkdir -p .syok/sessions && echo '{\"messages\":[\"the whole chat\"]}' > .syok/sessions/20261123-abcd.json && printf 'v = 2\\n' > app.py && echo '{\"stopped\":\"finished\",\"usage\":{\"input\":1,\"output\":1,\"total\":2}}'"], enforced: [] }) };
  const x: Instance = normalize(row({ base_commit: base }));
  const { patch, report } = await solveInstance(x, { backend: be, tool: "syok", adapter: tool, model: "syok-coder", timeoutSec: 60, doGrade: false, skipInstall: true, logDir: tmpDir("sb-logs-") });
  expect(report.error).toBeUndefined();
  expect(patch).toContain("diff --git a/app.py b/app.py"); expect(patch).toContain("+v = 2");
  expect(patch).not.toContain(".syok"); expect(patch).not.toContain("the whole chat");
  const line = predictionLine(x.instance_id, "syok__syok-coder", patch);
  expect(line).not.toContain(".syok"); expect(JSON.parse(line).model_patch).toBe(patch);
  // Without the exclude list the same run would have carried the chat file: the exclusion is what keeps it out.
  const plain = await solveInstance(x, { backend: be, tool: "syok", adapter: { ...tool, patchExclude: undefined }, model: "syok-coder", timeoutSec: 60, doGrade: false, skipInstall: true, logDir: tmpDir("sb-logs-") });
  expect(plain.patch).toContain("diff --git a/.syok/sessions/20261123-abcd.json");
  expect(() => diffCommand(["../x"])).toThrow(/not allowed/); expect(() => diffCommand(["a'; rm -rf /"])).toThrow(/not allowed/);
  expect(diffCommand([".syok/"])).toContain("-- . ':(exclude).syok'");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
test("imageChangedFiles counts what differs from the dataset's BASE commit, even when the image's HEAD is a later commit", async () => {
  const { be: inner, dirs } = localBackend();
  const probe = await inner.start("x", { timeoutSec: 10 }); const base = head(probe.id);
  // The image's setup committed an edit on top of the base commit (HEAD != base): a HEAD-based count would say 0.
  const be: Backend = { ...inner, async start(i, o) { const b = await inner.start(i, o); writeFileSync(join(b.id, "app.py"), "v = 1\n# setup\n"); spawnSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qam", "setup"], { cwd: b.id }); return b; } };
  const x: Instance = normalize(row({ base_commit: base }));
  const r = await solveInstance(x, { backend: be, tool: "noop", model: "noop", timeoutSec: 60, doGrade: false, logDir: tmpDir("sb-logs-") });
  expect(r.report.headMatchesBase).toBe(false);
  expect(r.report.imageChangedFiles).toBe(1);
  expect(r.patch).toBe("");
  expect(imageChangesCommand("not a sha; rm -rf /")).toBe("git diff --name-only HEAD 2>/dev/null | wc -l");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
test("scrub: every secret value is replaced byte for byte in every file, nothing is left, short or empty values are ignored", () => {
  const d = tmpDir("sb-scrub-");
  mkdirSync(join(d, "run", "logs"), { recursive: true });
  const key = "sk-syok-SECRET-1234567890", host = "syok-ai-router-personal-abc123.example.workers.dev";
  writeFileSync(join(d, "run", "logs", "a.tool.txt"), `error: could not reach https://${host}/v1 with ${key}\nagain ${host}\n`);
  writeFileSync(join(d, "run", "bin.dat"), Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from(key), Buffer.from([0])]));
  writeFileSync(join(d, "run", "clean.txt"), "nothing here");
  const r = scrub(d, [key, `https://${host}/v1`, host, "abc123", "", "ab"]);
  expect(r.left).toEqual([]); expect(r.changed).toBe(2);
  const t = readFileSync(join(d, "run", "logs", "a.tool.txt"), "utf8");
  expect(t).not.toContain(key); expect(t).not.toContain(host); expect(t).not.toContain("abc123"); expect(t).toContain("<hidden>");
  expect(readFileSync(join(d, "run", "bin.dat"))).toEqual(Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from("<hidden>"), Buffer.from([0])]));
  expect(readFileSync(join(d, "run", "clean.txt"), "utf8")).toBe("nothing here");
  expect(scrub(join(d, "missing"), [key])).toEqual({ changed: 0, left: [] });
  // The CLI: values by variable NAME, exit 0 when clean, nothing secret printed.
  writeFileSync(join(d, "run", "again.txt"), key);
  const c = spawnSync("bun", ["bench/swebench/scrub.ts", d, "SB_TEST_KEY", "SB_TEST_EMPTY"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SB_TEST_KEY: key, SB_TEST_EMPTY: "" } });
  expect(c.status).toBe(0); expect(c.stdout + c.stderr).not.toContain(key);
  expect(readFileSync(join(d, "run", "again.txt"), "utf8")).toBe("<hidden>");
  rmSync(d, { recursive: true, force: true });
});
test("summary: per-instance OFFICIAL harness result next to the quick grade, with disagreements marked", () => {
  const d = tmpDir("sb-sum-"); const run = join(d, "2026-gold"); mkdirSync(run);
  writeFileSync(join(run, "results.json"), JSON.stringify({ reports: [{ instance_id: "a__a-1", outcome: "wrong-patch" }, { instance_id: "b__b-2", outcome: "resolved" }, { instance_id: "c__c-3", outcome: "no-patch" }] }));
  writeFileSync(join(run, "results.md"), "### table\n");
  writeFileSync(join(run, "gold.pilot-2026-gold.json"), JSON.stringify({ submitted_instances: 3, completed_instances: 2, resolved_instances: 2, empty_patch_instances: 1, error_instances: 0, resolved_ids: ["a__a-1", "b__b-2"], unresolved_ids: [], empty_patch_ids: ["c__c-3"], error_ids: [] }));
  const s = pilotSummary(d);
  expect(s).toContain("**Official SWE-bench harness: 2/3 resolved**");
  expect(s).toContain("| a__a-1 | resolved | wrong-patch | **no** (report the official one) |");
  expect(s).toContain("| b__b-2 | resolved | resolved | yes |");
  expect(s).toContain("| c__c-3 | empty patch | no-patch | yes |");
  expect(officialStatus(null, "x")).toBe("not graded");
  rmSync(d, { recursive: true, force: true });
});
test("instanceCost: the tool's own number first; one unpriced model makes the run unknown (never guessed)", () => {
  expect(instanceCost({ costUsd: 0.5 }, {})).toEqual({ usd: 0.5, source: "tool" });
  expect(instanceCost({ costUsd: null, byModel: { "a / m1": { input: 1e6, output: 0 } } }, {})).toEqual({ usd: null, source: "unknown" });
  expect(instanceCost({ costUsd: null, byModel: { "a / m1": { input: 1e6, output: 0 }, "b / m2": { input: 1, output: 1 } } }, { m1: { in: 3 } })).toEqual({ usd: null, source: "unknown" });
  expect(instanceCost({ costUsd: null, byModel: { "a / m1": { input: 1e6, output: 1e6 } } }, { m1: { in: 3, out: 5 } })).toEqual({ usd: 8, source: "prices" });
});
test("outcomeOf and the results table: resolved only when the quick grade says so, and the table is labelled quick-grade, not official", () => {
  const base: any = { instance_id: "a__b-1", image: "i", tool: "syok", model: "syok-coder", headMatchesBase: true, toolExit: 0, toolTimedOut: false, toolSeconds: 12, tokens: { input: 10, output: 2, total: 12 }, costUsd: null, costSource: "unknown", patchBytes: 50 };
  const g = (resolved: boolean, applied = true) => ({ resolved, applied, note: "n", parser: "pytest", failToPass: { passed: resolved ? 1 : 0, total: 1, failing: [] }, passToPass: { passed: 2, total: 2, failing: [] } });
  expect(outcomeOf({ ...base, quickGrade: g(true) })).toBe("resolved");
  expect(outcomeOf({ ...base, quickGrade: g(false) })).toBe("wrong-patch");
  expect(outcomeOf({ ...base, quickGrade: g(false, false) })).toBe("did-not-apply");
  expect(outcomeOf({ ...base, patchBytes: 0, quickGrade: { skipped: "empty patch" } })).toBe("no-patch");
  expect(outcomeOf({ ...base, toolTimedOut: true, quickGrade: g(false) })).toBe("timeout");
  expect(outcomeOf({ ...base, error: "boom", quickGrade: { skipped: "x" } })).toBe("error");
  const reps = [{ ...base, quickGrade: g(true), outcome: "resolved", byModel: { "groq / m": { steps: 3, input: 10, output: 2 } } }, { ...base, instance_id: "a__b-2", quickGrade: g(false), outcome: "wrong-patch" }];
  const md = resultsTable({ tool: "syok", model: "syok-coder", backend: "docker", gradedBy: "quick", maxSpendUsd: 5, spentUsd: null }, reps);
  expect(md).toContain("**1/2 resolved: quick-grade, not official.**");
  expect(md).toContain("| a__b-1 | resolved | 50 | 1/1 | 2/2 | 12 | 10 / 2 | unknown | groq / m (3 steps) |");
  expect(md).toContain("Money used: unknown");
});
test("Syok adapter: SYOK_BENCH_BUNDLE puts this checkout's build into the container instead of the published one", () => {
  const old = process.env.SYOK_BENCH_BUNDLE;
  try {
    delete process.env.SYOK_BENCH_BUNDLE;
    expect(syok.containerUpload!.map((u) => u.remote)).toEqual(["/tmp/syok-install.sh"]);
    expect(syok.containerInstall![0]).not.toContain("syok-bundle.js");
    process.env.SYOK_BENCH_BUNDLE = "/x/syok.js";
    expect(syok.containerUpload!.map((u) => u.remote)).toEqual(["/tmp/syok-install.sh", "/tmp/syok-bundle.js"]);
    expect(syok.containerInstall![0]).toContain("cp /tmp/syok-bundle.js /opt/syok/syok.js");
  } finally { if (old === undefined) delete process.env.SYOK_BENCH_BUNDLE; else process.env.SYOK_BENCH_BUNDLE = old; }
});
test("gold pseudo-tool + quick grade: the reference patch is applied in a fresh container and eval_script decides", async () => {
  const { be, dirs } = localBackend();
  const probe = await be.start("x", { timeoutSec: 10 }); const base = head(probe.id);
  const gold = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-v = 1\n+v = 2\n";
  const evalScript = "#!/bin/bash\nset -uxo pipefail\ncd /testbed\n: '>>>>> Start Test Output'\nif grep -q 'v = 2' app.py; then echo 'PASSED t.py::test_a'; else echo 'FAILED t.py::test_a'; fi\necho 'PASSED t.py::test_b'\n: '>>>>> End Test Output'\n";
  const x = normalize(row({ base_commit: base, patch: gold, eval_script: evalScript, FAIL_TO_PASS: ["t.py::test_a"], PASS_TO_PASS: ["t.py::test_b"] }));
  const o = { backend: be, tool: "gold", model: "gold", timeoutSec: 60, doGrade: true, logDir: tmpDir("sb-logs-") };
  const { patch, report } = await solveInstance(x, o);
  expect(report.error).toBeUndefined(); expect(patch).toContain("+v = 2");
  const g: any = await quickGrade(x, patch, o);
  expect(g.applied).toBe(true); expect(g.resolved).toBe(true); expect(g.failToPass).toMatchObject({ passed: 1, total: 1 });
  const bad: any = await quickGrade(x, "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-v = 1\n+v = 3\n", o);
  expect(bad.resolved).toBe(false); expect(bad.failToPass.failing).toEqual(["t.py::test_a"]);
  expect(await quickGrade(normalize(row()), patch, o)).toEqual({ skipped: expect.stringContaining("no eval_script") });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// ---------- the real thing: Docker, when it is running (it is on GitHub's Linux machines) ----------
const dockerUp = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8" }).status === 0;
test.skipIf(!dockerUp)("REAL Docker: build a tiny instance image, run the CLI with the gold pseudo-tool, write predictions.jsonl, quick-grade it", async () => {
  const d = tmpDir("sb-docker-");
  const tag = "syok-bench-test-instance:" + Date.now();
  writeFileSync(join(d, "Dockerfile"), [
    // A small public image that already has git, bash and coreutils (nothing is installed: containers may have no network).
    "FROM buildpack-deps:bookworm-scm",
    "RUN mkdir /testbed && cd /testbed && git init -q && printf 'v = 1\\n' > app.py && git add app.py && git -c user.email=a@b -c user.name=a commit -qm base && mkdir build && echo built > build/junk.py",
  ].join("\n") + "\n");
  const b = spawnSync("docker", ["build", "-q", "-t", tag, d], { encoding: "utf8", timeout: 600000 });
  expect(b.status).toBe(0);
  try {
    const base = spawnSync("docker", ["run", "--rm", "--entrypoint", "git", tag, "-C", "/testbed", "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    const gold = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-v = 1\n+v = 2\n";
    const evalScript = "#!/bin/bash\nset -uxo pipefail\ncd /testbed\n: '>>>>> Start Test Output'\nif grep -q 'v = 2' app.py; then echo 'PASSED t.py::test_a'; else echo 'FAILED t.py::test_a'; fi\necho 'PASSED t.py::test_b'\n: '>>>>> End Test Output'\n";
    writeFileSync(join(d, "ds.jsonl"), JSON.stringify(row({ instance_id: "local__test-1", base_commit: base, image: tag, patch: gold, eval_script: evalScript, FAIL_TO_PASS: ["t.py::test_a"], PASS_TO_PASS: ["t.py::test_b"] })) + "\n");
    const out = join(d, "out");
    const r = spawnSync("bun", ["bench/swebench/run.ts", "--dataset", join(d, "ds.jsonl"), "--tool", "gold", "--grade", "--out", out, "--timeout", "120"], { cwd: ROOT, encoding: "utf8", timeout: 600000 });
    expect(r.stdout).toContain("quick grade: RESOLVED (FAIL_TO_PASS 1/1, PASS_TO_PASS 1/1)");
    const run = readdirSync(out)[0];
    const pred = readFileSync(join(out, run, "predictions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(pred).toEqual([{ instance_id: "local__test-1", model_name_or_path: "gold", model_patch: expect.stringContaining("+v = 2") }]);
    expect(pred[0].model_patch).not.toContain("junk.py");
    const rep = JSON.parse(readFileSync(join(out, run, "report.json"), "utf8"));
    expect(rep.gradedBy).toContain("NOT the official harness");
    expect(rep.reports[0].headMatchesBase).toBe(true);
    expect(spawnSync("docker", ["ps", "-a", "--filter", "name=syok-bench-", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim()).toBe("");
  } finally { spawnSync("docker", ["rmi", "-f", tag]); }
}, 900000);
