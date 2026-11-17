"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../lib.js");

test("finding the program: setting first, then the installer's place, then PATH", () => {
  const none = () => false;
  assert.deepEqual(lib.findSyok("/opt/syok", { platform: "linux", exists: (p) => p === "/opt/syok" }), { program: "/opt/syok", first: [], found: true, from: "setting" });
  assert.deepEqual(lib.findSyok(" /missing ", { platform: "linux", exists: none }), { program: "/missing", first: [], found: false, from: "setting" });
  assert.deepEqual(lib.findSyok("", { platform: "linux", home: "/home/me", exists: (p) => p === "/home/me/.syok/bin/syok" }), { program: "/home/me/.syok/bin/syok", first: [], found: true, from: "installer" });
  assert.deepEqual(lib.findSyok("", { platform: "darwin", home: "/Users/me", exists: none }), { program: "syok", first: [], found: false, from: "path" });
  assert.deepEqual(lib.findSyok(undefined, { platform: "win32", home: "C:\\u", exists: none }), { program: "syok.cmd", first: [], found: false, from: "path" });
});

test("on Windows the installed program is started as bun.exe + syok.js, never through the .cmd file", () => {
  const files = new Set(["C:\\Users\\me\\.syok\\bin\\syok.cmd", "C:\\Users\\me\\.syok\\bin\\bun.exe", "C:\\Users\\me\\.syok\\syok.js"]);
  const o = { platform: "win32", home: "C:\\Users\\me", exists: (p) => files.has(p) };
  assert.deepEqual(lib.findSyok("", o), { program: "C:\\Users\\me\\.syok\\bin\\bun.exe", first: ["C:\\Users\\me\\.syok\\syok.js"], found: true, from: "installer" });
  assert.deepEqual(lib.findSyok("C:\\Users\\me\\.syok\\bin\\syok.cmd", o), { program: "C:\\Users\\me\\.syok\\bin\\bun.exe", first: ["C:\\Users\\me\\.syok\\syok.js"], found: true, from: "setting" });
  // a .cmd file without bun.exe next to it is used as it is (the task still never passes through it: it travels in a file)
  files.delete("C:\\Users\\me\\.syok\\bin\\bun.exe");
  assert.deepEqual(lib.findSyok("", o), { program: "C:\\Users\\me\\.syok\\bin\\syok.cmd", first: [], found: true, from: "installer" });
  // the same file names on Linux are left alone
  assert.deepEqual(lib.findSyok("/x/syok.cmd", { platform: "linux", exists: () => true }), { program: "/x/syok.cmd", first: [], found: true, from: "setting" });
});

test("the words given to syok never contain the task: it travels in a private file", () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  assert.deepEqual(lib.buildArgs({}), []);
  assert.deepEqual(lib.buildArgs({ mode: "ask" }), []);
  assert.deepEqual(lib.buildArgs({ mode: "auto", model: " gpt-5 ", extra: ["--no-web", "", 5, "--general"], taskFile: "/t/task.txt" }), ["--mode", "auto", "--model", "gpt-5", "--no-web", "--general", "--task-file", "/t/task.txt", "--stay"]);
  assert.throws(() => lib.buildArgs({ mode: "yolo" }), /Unknown mode/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syok-libtest-"));
  const nasty = "say \"hi\"; rm -rf ~ && echo $HOME `id` 'x' | cat %PATH%\nsecond line";
  const m = lib.writeTask("  " + nasty + "  ", { tmp });
  assert.equal(fs.readFileSync(m.file, "utf8"), nasty); assert.equal(path.dirname(m.file), m.dir); assert.ok(path.basename(m.dir).startsWith("syok-task-"));
  if (process.platform !== "win32") { assert.equal(fs.statSync(m.file).mode & 0o777, 0o600); assert.equal(fs.statSync(m.dir).mode & 0o777, 0o700); }
  assert.notEqual(lib.writeTask("x", { tmp }).dir, m.dir);
  assert.throws(() => lib.writeTask("   ", { tmp }), /empty/); assert.throws(() => lib.writeTask(undefined, { tmp }), /empty/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a question about selected code says where the code is, and very long selections are cut", () => {
  const t = lib.selectionTask(" explain this ", { text: "const a = 1;", file: "src/a.ts", startLine: 3, endLine: 3 });
  assert.equal(t, "explain this\n\nThis is about src/a.ts, lines 3-3:\n```\nconst a = 1;\n```");
  const long = lib.selectionTask("why", { text: "x".repeat(20000), file: "big.js", startLine: 1, endLine: 900 });
  assert.ok(long.length < 12300); assert.ok(long.includes("the rest of the selection was left out"));
  assert.throws(() => lib.selectionTask("", { text: "x", file: "a", startLine: 1, endLine: 1 }), /question is empty/);
  assert.throws(() => lib.selectionTask("q", { text: "  ", file: "a", startLine: 1, endLine: 1 }), /No code is selected/);
});

test("fixing problems: errors and warnings are listed, hints are not, and no problems means no task", () => {
  const t = lib.problemsTask("src/a.ts", [
    { severity: 0, line: 4, message: "Type 'string' is not\n assignable to type 'number'.", source: "ts", code: 2322 },
    { severity: 1, line: 9, message: "'x' is declared but never used.", source: "eslint" },
    { severity: 2, line: 1, message: "info only" }, { severity: 3, line: 2, message: "hint only" },
  ]);
  assert.equal(t, "Fix these problems that the editor reports in src/a.ts. Change as little as possible, and run the project's check afterwards.\n- line 4 [ts 2322]: Type 'string' is not assignable to type 'number'.\n- line 9 [eslint]: 'x' is declared but never used.");
  assert.equal(lib.problemsTask("a.ts", [{ severity: 3, line: 1, message: "hint" }]), null);
  assert.equal(lib.problemsTask("a.ts", []), null);
  assert.equal(lib.problemsTask("a.ts", Array.from({ length: 100 }, (_, i) => ({ severity: 0, line: i + 1, message: "e" }))).split("\n").length, 41);
});

test("the install line matches the computer", () => {
  assert.equal(lib.installLine("win32"), "irm https://syok-ai.com/syok-code/install.ps1 | iex");
  assert.equal(lib.installLine("linux"), "curl -fsSL https://syok-ai.com/syok-code/install.sh | sh");
  assert.equal(lib.installLine("darwin"), lib.installLine("linux"));
});

test("the manifest lists every command the code registers, and nothing else", () => {
  const pkg = require("../package.json"); const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "extension.js"), "utf8");
  const declared = pkg.contributes.commands.map((c) => c.command).sort();
  const registered = [...src.matchAll(/reg\("([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(registered, declared);
  for (const m of [...pkg.contributes.menus["editor/context"], ...pkg.contributes.keybindings]) assert.ok(declared.includes(m.command), m.command);
  assert.deepEqual(pkg.contributes.configuration.properties["syokCode.mode"].enum, lib.MODES);
});
