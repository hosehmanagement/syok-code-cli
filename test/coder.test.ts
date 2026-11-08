import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { LANGS, langOf, langOfFile, checkCmd, detectProject, langContext } from "../src/langs.ts";
import { buildTask } from "../src/tasks.ts";
import { runAgent, SYSTEM } from "../src/agent.ts";
import { tmpProject, fakeAI } from "./helpers.ts";

test("knows 30+ languages, with aliases and file extensions", () => {
  expect(LANGS.length).toBeGreaterThanOrEqual(30);
  expect(new Set(LANGS.map((l) => l.id)).size).toBe(LANGS.length);
  expect(langOf("golang")?.id).toBe("go"); expect(langOf("C++")?.id).toBe("cpp"); expect(langOf("c#")?.id).toBe("csharp"); expect(langOf("py")?.id).toBe("python"); expect(langOf(".rs")?.id).toBe("rust");
  expect(langOfFile("src/app.tsx")?.id).toBe("typescript"); expect(langOfFile("run.sh")?.id).toBe("bash"); expect(langOfFile("README")).toBeUndefined(); expect(langOf("klingon")).toBeUndefined();
  for (const l of LANGS) { expect(l.hint.length).toBeGreaterThan(10); if (l.check && l.id !== "csharp") expect(l.check.includes("{f}") || l.id === "csharp").toBe(true); }
});
test("check commands fill in the file name", () => {
  expect(checkCmd(langOf("python")!, "a.py")).toBe("python3 -m py_compile a.py");
  expect(checkCmd(langOf("sql")!, "q.sql")).toBeUndefined();
});
test("real check commands catch real mistakes (python, node, bash)", () => {
  const d = tmpProject({ "ok.py": "print(1)\n", "bad.py": "def f(:\n", "ok.js": "let a=1;\n", "bad.js": "let = ;\n", "ok.sh": "echo hi\n", "bad.sh": "if then\n" });
  const run = (l: string, f: string) => spawnSync("bash", ["-lc", checkCmd(langOf(l)!, f)!], { cwd: d }).status;
  for (const [l, g, b] of [["python", "ok.py", "bad.py"], ["javascript", "ok.js", "bad.js"], ["bash", "ok.sh", "bad.sh"]]) { expect(run(l, g)).toBe(0); expect(run(l, b)).not.toBe(0); }
});
test("detects project languages from marker files", () => {
  expect(detectProject(tmpProject({ "go.mod": "module x" })).map((l) => l.id)).toEqual(["go"]);
  expect(detectProject(tmpProject({ "package.json": "{}", "tsconfig.json": "{}" })).map((l) => l.id)).toEqual(["typescript"]);
  expect(detectProject(tmpProject({ "Cargo.toml": "", "pyproject.toml": "" })).map((l) => l.id).sort()).toEqual(["python", "rust"]);
  expect(detectProject(tmpProject({ "App.csproj": "" })).map((l) => l.id)).toEqual(["csharp"]);
  expect(langContext(tmpProject({}))).toBe(""); expect(langContext(tmpProject({ "go.mod": "" }))).toContain("Go:");
});
test("gen: builds a self-checking brief; rejects empty and unknown language", () => {
  const b = buildTask("gen", { text: "check if a string is a palindrome", lang: "python" });
  expect(b.error).toBeUndefined(); expect(b.task).toContain("palindrome"); expect(b.task).toContain("main.py"); expect(b.task).toContain("python3 -m py_compile main.py"); expect(b.readOnly).toBe(false);
  expect(buildTask("gen", { text: "" }).error).toMatch(/Say what you want/);
  expect(buildTask("gen", { text: "x", lang: "klingon" }).error).toMatch(/Supported:/);
  expect(buildTask("gen", { text: "x", lang: "rust", out: "src/lib.rs" }).task).toContain("src/lib.rs");
});
test("translate: from the file extension to the target, new file beside the original, original untouched", () => {
  const b = buildTask("translate", { file: "lib/utils.py", to: "go" });
  expect(b.task).toContain("from Python to Go"); expect(b.task).toContain("lib/utils.go"); expect(b.task).toContain("Do not change or delete the original"); expect(b.task).toContain("integer sizes");
  expect(buildTask("translate", { file: "a.py" }).error).toMatch(/Usage/); expect(buildTask("translate", { file: "a.py", to: "nope" }).error).toMatch(/Supported/);
  expect(buildTask("translate", { file: "a.js", to: "typescript", out: "b.ts" }).task).toContain("b.ts");
});
test("debug, explain and test modes", () => {
  expect(buildTask("debug", {}).task).toContain("running its tests"); expect(buildTask("debug", { text: "login fails" }).task).toContain("login fails");
  expect(buildTask("debug", {}).task).toContain("Never delete or weaken a test");
  const e = buildTask("explain", { file: "a.go" }); expect(e.readOnly).toBe(true); expect(buildTask("explain", {}).error).toMatch(/Usage/);
  const t = buildTask("test", { file: "calc.rs" }); expect(t.task).toContain("Rust"); expect(t.task).toContain("cargo test"); expect(buildTask("test", {}).error).toMatch(/Usage/);
});
test("the AI is told it is a programming specialist, and project language notes reach it", async () => {
  expect(SYSTEM).toContain("specialised for programming");
  const d = tmpProject({ "go.mod": "module x" });
  const ai = fakeAI([{ role: "assistant", content: "ok" }]);
  await runAgent({ root: d, task: "t", base: "http://f", key: "k", fetchImpl: ai.f });
  expect(ai.seen[0].messages[0].content).toContain("Go:");
});
test("command line: modes validate input and explain is read-only (compiled path via bun)", async () => {
  const main = join(import.meta.dir, "../src/main.ts");
  const env = { ...process.env, SYOK_BASE_URL: "http://127.0.0.1:1", SYOK_API_KEY: "k" };
  const r = spawnSync("bun", [main, "translate", "a.py"], { env, encoding: "utf8" });
  expect(r.status).toBe(2); expect(r.stderr).toMatch(/Usage: syok translate/);
  const g = spawnSync("bun", [main, "gen", "x", "--lang", "klingon"], { env, encoding: "utf8" });
  expect(g.status).toBe(2); expect(g.stderr).toMatch(/Supported:/);
});
