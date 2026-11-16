import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { quickCheck, quickLine, projectCheck, worthChecking, hasProgram } from "../src/checks.ts";
import { makeCtx, runTool } from "../src/tools.ts";
import { runAgent, describeUsage, estimateCost, addUsage, emptyUsage, mergeUsage, SYSTEM } from "../src/agent.ts";
import { checkCommand } from "../src/perm.ts";
import { DEFAULT } from "../src/profiles.ts";
import { tmpProject, fakeAI, call } from "./helpers.ts";

const qc = async (name: string, text: string) => { const d = tmpProject({ [name]: text }); return quickCheck(join(d, name), name, d); };

test("syntax check: JavaScript and TypeScript, in-process, with the line of the problem", async () => {
  expect(await qc("a.js", "const a = 1;\nexport default a;\n")).toEqual({ tool: "JavaScript syntax", ok: true, problems: "" });
  expect(await qc("a.ts", "interface P { n: number }\nexport const f = (p: P): number => p.n;\n")).toMatchObject({ tool: "TypeScript syntax", ok: true });
  expect(await qc("a.tsx", "export const A = (p: { n: number }) => <div>{p.n}</div>;\n")).toMatchObject({ ok: true });
  expect(await qc("a.jsx", "export const A = () => <b>x</b>;\n")).toMatchObject({ ok: true });
  const bad = (await qc("src.ts", "const a = 1;\nconst b: number = ;\nexport {};\n"))!;
  expect(bad.ok).toBe(false); expect(bad.tool).toBe("TypeScript syntax"); expect(bad.problems).toMatch(/^src\.ts:2: /);
  expect((await qc("b.js", "const x = ;\n"))!.ok).toBe(false);
  // Type errors are not syntax errors: this check stays quiet about them (that is the project check's job).
  expect((await qc("t.ts", "const n: number = 'text';\n"))!.ok).toBe(true);
});

test("syntax check: JSON, and config files that may contain comments are left alone", async () => {
  expect(await qc("data.json", '{"a": [1, 2]}')).toMatchObject({ tool: "JSON syntax", ok: true });
  const bad = (await qc("data.json", '{"a": 1,}'))!; expect(bad.ok).toBe(false); expect(bad.problems.length).toBeGreaterThan(3);
  for (const n of ["tsconfig.json", "tsconfig.build.json", ".vscode/settings.json", "x.jsonc", ".devcontainer/devcontainer.json"]) expect(await qc(n, '{ // comment\n "a": 1 }')).toBeNull();
});

test.if(hasProgram("python3"))("syntax check: Python, without leaving __pycache__ behind", async () => {
  const d = tmpProject({ "ok.py": "def f(x):\n    return x + 1\n", "bad.py": "def f(x):\n    return x +\n" });
  expect(await quickCheck(join(d, "ok.py"), "ok.py", d)).toEqual({ tool: "Python syntax", ok: true, problems: "" });
  const bad = (await quickCheck(join(d, "bad.py"), "bad.py", d))!;
  expect(bad.ok).toBe(false); expect(bad.problems).toMatch(/^bad\.py:2: SyntaxError: /);
  expect(readdirSync(d).sort()).toEqual(["bad.py", "ok.py"]);
});

test.if(hasProgram("bash"))("syntax check: shell scripts", async () => {
  expect(await qc("a.sh", "#!/bin/bash\nif [ -f x ]; then echo yes; fi\n")).toMatchObject({ tool: "bash -n", ok: true });
  const bad = (await qc("b.sh", "if [ -f x ]; then echo yes\n"))!;
  expect(bad.ok).toBe(false); expect(bad.problems).toContain("b.sh"); expect(bad.problems).not.toContain("/tmp");
});

test("syntax check: unknown file types and missing tools give no result, and the wording is clear", async () => {
  expect(await qc("notes.md", "# hi")).toBeNull(); expect(await qc("Makefile", "all:\n\techo")).toBeNull(); expect(await qc("a.xyz", "??")).toBeNull();
  expect(quickLine(null)).toBe("");
  expect(quickLine({ tool: "T", ok: true, problems: "" })).toBe("\nSyntax check (T): OK.");
  expect(quickLine({ tool: "T", ok: false, problems: "a.js:2: oops" })).toBe("\nSyntax check (T) FAILED. Fix this before doing anything else:\na.js:2: oops");
});

test("edit tools report the syntax check; a broken edit is still saved (so it can be fixed) and can be switched off", async () => {
  const d = tmpProject({ "a.js": "const a = 1;\n" });
  const c = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  expect(await runTool(c, "write_file", { path: "new.ts", content: "export const x: number = 1;\n" })).toBe("Wrote new.ts (2 lines).\nSyntax check (TypeScript syntax): OK.");
  const r = await runTool(c, "edit_file", { path: "a.js", old_text: "const a = 1;", new_text: "const a = (1;" });
  expect(r).toStartWith("Edited a.js.\nSyntax check (JavaScript syntax) FAILED. Fix this before doing anything else:\na.js:1: ");
  expect(readFileSync(join(d, "a.js"), "utf8")).toBe("const a = (1;\n");
  expect(await runTool(c, "write_file", { path: "README.md", content: "# hi\n" })).toBe("Wrote README.md (2 lines).");
  const off = makeCtx(d, "auto", async () => true, { checks: false }, DEFAULT);
  expect(await runTool(off, "write_file", { path: "b.js", content: "const (" })).toBe("Wrote b.js (1 lines).");
});

test("project check: which command is chosen", () => {
  const pkg = (scripts: any, extra: Record<string, string> = {}) => tmpProject({ "package.json": JSON.stringify({ scripts }), ...extra });
  expect(projectCheck(pkg({ lint: "eslint .", typecheck: "tsc --noEmit", test: "x" }))).toEqual({ command: "npm run typecheck", source: 'the "typecheck" script in package.json' });
  expect(projectCheck(pkg({ lint: "eslint ." }, { "bun.lock": "" }))).toEqual({ command: "bun run lint", source: 'the "lint" script in package.json' });
  expect(projectCheck(pkg({ check: "x", lint: "y" }))!.command).toBe("npm run check");
  expect(projectCheck(pkg({ test: "jest", build: "x" }))).toBeNull(); // tests and builds are not started automatically
  expect(projectCheck(pkg({ typecheck: "  " }))).toBeNull();
  expect(projectCheck(tmpProject({ "package.json": "{not json" }))).toBeNull();
  expect(projectCheck(tmpProject({ "main.py": "x=1" }))).toBeNull();
  const d = pkg({ typecheck: "tsc" });
  expect(projectCheck(d, { check_command: " make verify " })).toEqual({ command: "make verify", source: "check_command in .syok/settings.json" });
  expect(projectCheck(d, { checks: false, check_command: "make verify" })).toBeNull();
  // Every command the automatic choice can produce is on the always-allowed list, so it never needs a question.
  for (const cmd of ["npm run typecheck", "pnpm run type-check", "yarn run check", "bun run lint", "cargo check", "go vet ./..."]) expect(checkCommand(cmd), cmd).toBe("safe");
  expect(worthChecking(["README.md", "docs/a.txt", "logo.png", "CHANGELOG"])).toBe(false); expect(worthChecking(["README.md", "src/a.ts"])).toBe(true); expect(worthChecking([])).toBe(false);
});

const proj = (check: string) => tmpProject({ "package.json": JSON.stringify({ scripts: { typecheck: check } }), "a.js": "module.exports = 1;\n", "verify.js": "const s = require('fs').readFileSync('a.js','utf8'); if (!s.includes('= 2')) { console.error('a.js: expected the value 2, found something else'); process.exit(1); } console.log('all good');" });

test.if(hasProgram("npm"))("before finishing, a failing project check goes back to the AI; after the fix it passes and the run ends", async () => {
  const d = proj("node verify.js");
  const ai = fakeAI([
    call("edit_file", { path: "a.js", old_text: "= 1;", new_text: "= 3;" }), call("finish", { summary: "first try" }),
    call("edit_file", { path: "a.js", old_text: "= 3;", new_text: "= 2;" }), call("finish", { summary: "fixed" }),
  ]);
  const logs: string[] = [];
  const r = await runAgent({ root: d, task: "set it to 2", base: "http://x", key: "k", mode: "auto", fetchImpl: ai.f, log: (s) => logs.push(s) });
  expect(r.summary).toBe("fixed"); expect(r.stopped).toBe("finished"); expect(r.check).toEqual({ command: "npm run typecheck", passed: true });
  const sentBack = ai.seen[2].messages.at(-1);
  expect(sentBack.role).toBe("user"); expect(sentBack.content).toContain("The project's check fails after your changes."); expect(sentBack.content).toContain("Command: npm run typecheck"); expect(sentBack.content).toContain("Exit code: 1"); expect(sentBack.content).toContain("a.js: expected the value 2");
  expect(logs.join("\n")).toMatch(/project check failed, exit code 1.*\(1\/2\)/); expect(logs.join("\n")).toContain("(project check passed)");
  expect(ai.seen.length).toBe(4);
}, 60000);

test.if(hasProgram("npm"))("a check that keeps failing is tried twice, then the run ends and says the check is still failing", async () => {
  const d = proj("node -e \"console.error('always broken'); process.exit(2)\"");
  const ai = fakeAI([call("edit_file", { path: "a.js", old_text: "= 1;", new_text: "= 2;" }), call("finish", { summary: "one" }), call("finish", { summary: "two" }), call("finish", { summary: "three" })]);
  const r = await runAgent({ root: d, task: "x", base: "http://x", key: "k", mode: "auto", fetchImpl: ai.f });
  expect(r.summary).toBe("three"); expect(r.check).toEqual({ command: "npm run typecheck", passed: false }); expect(ai.seen.length).toBe(4);
}, 60000);

test.if(hasProgram("npm"))("no project check when nothing changed, only text files changed, in plan mode, for helpers, or when switched off", async () => {
  const marker = (d: string) => existsSync(join(d, "ran.txt"));
  const mk = () => tmpProject({ "package.json": JSON.stringify({ scripts: { typecheck: "node -e \"require('fs').writeFileSync('ran.txt','1')\"" } }), "a.js": "module.exports = 1;\n" });
  let d = mk(); let r = await runAgent({ root: d, task: "x", base: "http://x", key: "k", mode: "auto", fetchImpl: fakeAI([call("read_file", { path: "a.js" }), call("finish", { summary: "nothing" })]).f });
  expect(marker(d)).toBe(false); expect(r.check).toBeUndefined();
  d = mk(); await runAgent({ root: d, task: "x", base: "http://x", key: "k", mode: "auto", fetchImpl: fakeAI([call("write_file", { path: "NOTES.md", content: "hi" }), call("finish", { summary: "docs" })]).f });
  expect(marker(d)).toBe(false);
  d = mk(); await runAgent({ root: d, task: "x", base: "http://x", key: "k", mode: "auto", settings: { checks: false }, fetchImpl: fakeAI([call("write_file", { path: "b.js", content: "1" }), call("finish", { summary: "off" })]).f });
  expect(marker(d)).toBe(false);
  d = mk(); r = await runAgent({ root: d, task: "x", base: "http://x", key: "k", mode: "auto", fetchImpl: fakeAI([call("write_file", { path: "b.js", content: "1" }), call("finish", { summary: "on" })]).f });
  expect(marker(d)).toBe(true); expect(r.check).toEqual({ command: "npm run typecheck", passed: true });
}, 60000);

test("a custom check command that is not on the allowed list is asked about in ask mode, and a refusal ends quietly", async () => {
  const d = tmpProject({ "a.js": "module.exports = 1;\n" });
  const asked: string[] = [];
  const r = await runAgent({ root: d, task: "x", base: "http://x", key: "k", mode: "accept-edits", ask: async (what, detail) => { asked.push(what + ": " + detail); return false; }, settings: { check_command: "node -e \"process.exit(1)\"" }, fetchImpl: fakeAI([call("write_file", { path: "b.js", content: "1" }), call("finish", { summary: "done" })]).f });
  expect(asked).toEqual(['run command: node -e "process.exit(1)"']); expect(r.summary).toBe("done"); expect(r.check).toEqual({ command: 'node -e "process.exit(1)"', passed: null });
});

test("usage: tokens in and out, who answered, provider switches, and cost only when prices are given", async () => {
  const u = emptyUsage();
  addUsage(u, { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 }, { provider: "groq", model: "llama-4", attempts: "1", details: "" });
  addUsage(u, { prompt_tokens: 2000, completion_tokens: 500, total_tokens: 2500 }, { provider: "groq", model: "llama-4", attempts: "1", details: "" });
  addUsage(u, { prompt_tokens: 3000, completion_tokens: 1000 }, { provider: "gemini", model: "flash", attempts: "2", details: "" });
  addUsage(u, undefined, undefined);
  expect(u).toMatchObject({ input: 6200, output: 1800, total: 8000, steps: 4 });
  expect(describeUsage(u)).toBe("4 AI calls, 6.2k tokens in, 1.8k out; answered by groq / llama-4 (2 steps), gemini / flash (1 step)");
  expect(estimateCost(u)).toBeNull(); expect(estimateCost(u, { "gpt-5": { in: 1, out: 2 } })).toBeNull();
  expect(estimateCost(u, { flash: { in: 1, out: 4 }, groq: { in: 0, out: 0 } })).toBeCloseTo(0.007, 6);
  expect(describeUsage(u, { flash: { in: 1, out: 4 } })).toEndWith("; about $0.0070 at your listed prices");
  const total = emptyUsage(); mergeUsage(total, u); mergeUsage(total, u); expect(total.total).toBe(16000); expect(total.by["groq / llama-4"].steps).toBe(4);
  expect(describeUsage(emptyUsage())).toBe("Nothing used yet.");
  expect(SYSTEM).toContain("automatic syntax check");
});

test("a run reports its usage and says when Syok switched provider", async () => {
  const d = tmpProject({});
  const replies = [{ m: call("list_files", {}), p: "groq" }, { m: call("finish", { summary: "ok" }), p: "gemini" }]; let i = 0;
  const f = (async () => { const x = replies[i++]; return new Response(JSON.stringify({ choices: [{ message: x.m }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { headers: { "content-type": "application/json", "x-syok-provider": x.p, "x-syok-model": "m1", "x-syok-attempts": x.p === "gemini" ? "2" : "1" } }); }) as unknown as typeof fetch;
  const logs: string[] = [];
  const r = await runAgent({ root: d, task: "x", base: "http://x", key: "k", mode: "auto", fetchImpl: f, log: (s) => logs.push(s) });
  expect(r.usage).toEqual({ input: 200, output: 40, total: 240, steps: 2, by: { "groq / m1": { steps: 1, input: 100, output: 20 }, "gemini / m1": { steps: 1, input: 100, output: 20 } } });
  expect(logs).toContain("(switched provider: groq -> gemini, after 2 attempts)");
});

// ---- sandbox: the AI's edits are copied into the sandbox, so sandbox commands see them ----
import { sandboxPut, sandboxExec } from "../src/sandbox.ts";
import { syncSandbox, undoAll } from "../src/tools.ts";

function fakeRouter(o: { putStatus?: number } = {}) {
  const calls: Array<{ path: string; body: any; auth: string }> = [];
  const f = (async (u: any, init: any) => {
    const path = String(u).replace(/^https:\/\/me\.example\/v1\/code\/sandbox\//, ""); const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, auth: init.headers.authorization });
    if (path === "put") return o.putStatus && o.putStatus !== 200 ? Response.json({ error: "forbidden" }, { status: o.putStatus }) : Response.json({ written: body.path, bytes: body.content.length });
    if (path === "exec") return Response.json({ exitCode: 0, output: "ran" });
    return Response.json({}, { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, cfg: { base: "https://me.example/v1/", key: "syk_k", f } };
}

test("with --sandbox every edit is copied into the sandbox, and an undo is copied too", async () => {
  const d = tmpProject({ "src/a.js": "const a = 1;\n" });
  const r = fakeRouter(); const c = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  c.sandbox = (cmd, secs) => sandboxExec(r.cfg, cmd, secs); c.sandboxPut = (rel, content) => sandboxPut(r.cfg, rel, content);
  expect(await runTool(c, "edit_file", { path: "src/a.js", old_text: "= 1;", new_text: "= 2;" })).toBe("Edited src/a.js.\nSyntax check (JavaScript syntax): OK.\n(also written in the sandbox)");
  expect(await runTool(c, "write_file", { path: "docs/new.md", content: "# new\n" })).toBe("Wrote docs/new.md (2 lines).\n(also written in the sandbox)");
  expect(r.calls).toEqual([
    { path: "put", body: { path: "src/a.js", content: "const a = 2;\n" }, auth: "Bearer syk_k" },
    { path: "put", body: { path: "docs/new.md", content: "# new\n" }, auth: "Bearer syk_k" },
  ]);
  expect(await runTool(c, "run_command", { command: "node src/a.js" })).toContain("ran");
  expect(r.calls[2]).toMatchObject({ path: "exec", body: { cmd: "node src/a.js", command: "node src/a.js" } });
  // Undo restores the old file here and in the sandbox, and removes the new file in both places.
  const restored = undoAll(c); const notes = await syncSandbox(c, restored);
  expect(restored.sort()).toEqual(["docs/new.md", "src/a.js"]); expect(notes.sort()).toEqual(["(also removed in the sandbox)", "(also written in the sandbox)"]);
  const after = r.calls.slice(3);
  expect(after.find((x) => x.path === "put")!.body).toEqual({ path: "src/a.js", content: "const a = 1;\n" });
  expect(after.find((x) => x.path === "exec")!.body.cmd).toBe("rm -f -- 'docs/new.md'");
});

test("when the edit cannot be copied into the sandbox the AI is told plainly; without --sandbox nothing is sent", async () => {
  const d = tmpProject({ "a.js": "const a = 1;\n" });
  const old = fakeRouter({ putStatus: 401 }); const c = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  c.sandboxPut = (rel, content) => sandboxPut(old.cfg, rel, content);
  const out = await runTool(c, "edit_file", { path: "a.js", old_text: "= 1;", new_text: "= 2;" });
  expect(out).toContain("WARNING: this edit is NOT in the sandbox: your Syok version cannot copy edits into the sandbox yet"); expect(out).toContain("old a.js");
  const broken = fakeRouter({ putStatus: 409 }); c.sandboxPut = (rel, content) => sandboxPut(broken.cfg, rel, content);
  expect(await runTool(c, "edit_file", { path: "a.js", old_text: "= 2;", new_text: "= 3;" })).toContain("WARNING: this edit is NOT in the sandbox (HTTP 409");
  c.sandboxPut = async () => { throw new Error("network down"); };
  expect(await runTool(c, "edit_file", { path: "a.js", old_text: "= 3;", new_text: "= 4;" })).toContain("WARNING: this edit is NOT in the sandbox (network down).");
  expect(readFileSync(join(d, "a.js"), "utf8")).toBe("const a = 4;\n"); // the local edit always happens
  const plain = fakeRouter(); const c2 = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  expect(await runTool(c2, "edit_file", { path: "a.js", old_text: "= 4;", new_text: "= 5;" })).toBe("Edited a.js.\nSyntax check (JavaScript syntax): OK.");
  expect(plain.calls.length).toBe(0);
});

test("with --sandbox the project check runs in the sandbox, not on this computer", async () => {
  const d = tmpProject({ "package.json": JSON.stringify({ scripts: { typecheck: "node -e \"require('fs').writeFileSync('ran-locally.txt','1')\"" } }), "a.js": "module.exports = 1;\n" });
  const sent: string[] = []; let fail = true;
  const c = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  c.sandbox = async (cmd) => { sent.push(cmd); if (fail) { fail = false; return "type error in a.js\n[exit code 2]"; } return "ok\n[exit code 0]"; };
  c.sandboxPut = async () => "(also written in the sandbox)";
  const ai = fakeAI([call("write_file", { path: "b.js", content: "1" }), call("finish", { summary: "one" }), call("finish", { summary: "two" })]);
  const r = await runAgent({ root: d, task: "x", base: "http://x", key: "k", mode: "auto", ctx: c, fetchImpl: ai.f });
  expect(sent).toEqual(["npm run typecheck", "npm run typecheck"]); expect(existsSync(join(d, "ran-locally.txt"))).toBe(false);
  expect(ai.seen[2].messages.at(-1).content).toContain("type error in a.js"); expect(r.check).toEqual({ command: "npm run typecheck", passed: true }); expect(r.summary).toBe("two");
});
