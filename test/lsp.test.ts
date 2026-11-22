// Language helpers: real language servers (TypeScript's and Python's, from this repository's dev dependencies) answering
// about small real projects, plus a broken stand-in for the failure cases.
import { test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, utimesSync, mkdtempSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { tmpProject, call } from "./helpers.ts";
import { LspSet, LspClient, lspTool, detectLangs, findServer, describeLangs, lspAvailable, resetLspCache, LANGS, langOf, uriKey, applyTextEdits, badName } from "../src/lsp.ts";
import { makeCtx, toolDefs, runTool, undoAll, sessionDiff, READONLY } from "../src/tools.ts";
import { takeCheckpoint, rewindTo, type Checkpoint } from "../src/checkpoint.ts";
import { planConfine, probeConfine, setConfine } from "../src/confine.ts";
import { DEFAULT } from "../src/profiles.ts";

// On Windows the starter file is .exe (bun) or .cmd (npm), whichever the package manager made.
const bin = (n: string) => { const b = join(import.meta.dir, "..", "node_modules", ".bin", n); return process.platform === "win32" ? [".exe", ".cmd"].map((e) => b + e).find((p) => existsSync(p)) || b + ".cmd" : b; };
const TS = { typescript: { command: bin("typescript-language-server"), args: ["--stdio"] } }, PY = { python: { command: bin("pyright-langserver"), args: ["--stdio"] } };
const sets: LspSet[] = []; afterAll(() => { for (const s of sets) s.stopAll(); setConfine(null); });
const tsProject = () => tmpProject({
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler", noEmit: true }, include: ["src"] }),
  "src/a.ts": "export function greet(name: string): string { return \"hi \" + name; }\nexport class Box {\n  value = 1;\n  greet() { return 2; }\n}\n",
  "src/b.ts": "import { greet, Box } from \"./a\";\nconst x: number = greet(\"y\");\nexport const n = new Box().greet();\nexport { x };\n",
});

test("TypeScript, for real: definition, the right uses only, the type, the compiler's errors, and what a file defines", async () => {
  const d = tsProject(); const set = new LspSet(d, TS); sets.push(set);
  const def = await lspTool(set, d, { action: "definition", path: "src/b.ts", line: 2, symbol: "greet" });
  expect(def).toContain("Defined at:"); expect(def).toContain("src/a.ts:1"); expect(def).toContain("export function greet");
  // "greet" is also a method of Box. A text search finds both; the helper knows they are different things.
  const refs = await lspTool(set, d, { action: "references", path: "src/a.ts", line: 1, symbol: "greet" });
  expect(refs).toContain("src/a.ts:1"); expect(refs).toContain("src/b.ts:1"); expect(refs).toContain("src/b.ts:2"); expect(refs).not.toContain("src/a.ts:4"); expect(refs).not.toContain("src/b.ts:3"); expect(refs).toMatch(/^3 place\(s\)/);
  const method = await lspTool(set, d, { action: "references", path: "src/a.ts", line: 4, symbol: "greet" });
  expect(method).toContain("src/a.ts:4"); expect(method).toContain("src/b.ts:3"); expect(method).not.toContain("src/b.ts:2");
  const hover = await lspTool(set, d, { action: "hover", path: "src/b.ts", line: 2, symbol: "greet" }); expect(hover).toContain("greet(name: string): string"); // its real type, read through the import
  const diag = await lspTool(set, d, { action: "diagnostics", path: "src/b.ts" });
  expect(diag).toContain("1 error(s)"); expect(diag).toContain("src/b.ts:2  error: Type 'string' is not assignable to type 'number'"); expect(diag).toContain("[2322]");
  expect(await lspTool(set, d, { action: "diagnostics", path: "src/a.ts" })).toContain("reports no problems");
  const syms = await lspTool(set, d, { action: "symbols", path: "src/a.ts" }); expect(syms).toMatch(/1: function greet/); expect(syms).toMatch(/2: class Box/); expect(syms).toMatch(/4: method greet/);
  const ws = await lspTool(set, d, { action: "symbols", query: "Box" }); expect(ws).toContain("class Box"); expect(ws).toContain("src/a.ts:2");
}, 120000);

test("TypeScript, for real: after a file changes on the disk, the answers follow (no stale errors)", async () => {
  const d = tsProject(); const set = new LspSet(d, TS); sets.push(set);
  expect(await lspTool(set, d, { action: "diagnostics", path: "src/b.ts" })).toContain("1 error(s)");
  const f = join(d, "src", "b.ts"); writeFileSync(f, "import { greet, Box } from \"./a\";\nconst x: string = greet(\"y\");\nexport const n = new Box().greet();\nexport { x };\n"); const later = new Date(Date.now() + 5000); utimesSync(f, later, later);
  expect(await lspTool(set, d, { action: "diagnostics", path: "src/b.ts" }, [f])).toContain("reports no problems");
  // and a change in the OTHER file is seen from this one
  const a = join(d, "src", "a.ts"); writeFileSync(a, "export function greet(name: string): number { return name.length; }\nexport class Box {\n  value = 1;\n  greet() { return 2; }\n}\n"); utimesSync(a, later, later);
  const again = await lspTool(set, d, { action: "diagnostics", path: "src/b.ts" }, [a]); expect(again).toContain("Type 'number' is not assignable to type 'string'");
}, 120000);

test("Python, for real: definition across files and a type error", async () => {
  const d = tmpProject({ "m.py": "def area(w: int, h: int) -> int:\n    return w * h\n", "n.py": "from m import area\n\nx: str = area(1, 2)\nprint(x)\n" });
  const set = new LspSet(d, PY); sets.push(set);
  const def = await lspTool(set, d, { action: "definition", path: "n.py", line: 3, symbol: "area" }); expect(def).toContain("m.py:1"); expect(def).toContain("def area");
  const diag = await lspTool(set, d, { action: "diagnostics", path: "n.py" }); expect(diag).toContain("n.py:3  error:"); expect(diag).toMatch(/"int" is not assignable to (declared )?type "str"|Type "int" is not assignable/);
  const refs = await lspTool(set, d, { action: "references", path: "m.py", line: 1, symbol: "area" }); expect(refs).toContain("n.py:1"); expect(refs).toContain("n.py:3");
}, 120000);

test("questions that cannot be answered say why, in words the AI can act on", async () => {
  const d = tsProject(); const set = new LspSet(d, TS); sets.push(set);
  expect(await lspTool(set, d, { action: "explode" })).toContain("action must be one of");
  expect(await lspTool(set, d, { action: "definition" })).toContain("give the file");
  expect(await lspTool(set, d, { action: "definition", path: "../outside.ts", line: 1 })).toContain("outside the project");
  expect(await lspTool(set, d, { action: "definition", path: "src/none.ts", line: 1 })).toContain("does not exist");
  expect(await lspTool(set, d, { action: "definition", path: "src/b.ts", line: 2, symbol: "nothere" })).toContain("is not on line 2");
  expect(await lspTool(set, d, { action: "definition", path: "src/b.ts", symbol: "Box" })).toContain("src/a.ts:2"); // no line given: the first line with that name is used
  expect(await lspTool(set, d, { action: "hover", path: "src/b.ts" })).toContain("give \"line\"");
  writeFileSync(join(d, "notes.txt"), "x"); const none = new LspSet(d, TS);
  await expect(lspTool(none, d, { action: "diagnostics", path: "notes.txt" })).rejects.toThrow("no language helper for .txt files");
  const noPy = new LspSet(d, { python: false } as any); writeFileSync(join(d, "s.py"), "x = 1\n");
  await expect(lspTool(noPy, d, { action: "diagnostics", path: "s.py" })).rejects.toThrow(/no Python helper is installed.*npm install -g pyright/);
});

test("a helper that dies, or never answers, is reported and does not hang; the next question starts a fresh one", async () => {
  const d = tmpProject({ "x.ts": "export const a = 1;\n" });
  const dies = join(d, "dies.js"); writeFileSync(dies, "console.error('cannot load my parts'); process.exit(3);");
  const set = new LspSet(d, { typescript: { command: process.execPath, args: [dies] } } as any); sets.push(set);
  await expect(lspTool(set, d, { action: "symbols", path: "x.ts" })).rejects.toThrow(/helper stopped \(code 3\): cannot load my parts/);
  const silent = join(d, "silent.js"); writeFileSync(silent, "setInterval(() => {}, 1000);");
  const c = new LspClient(LANGS[0], d, process.execPath, [silent]); (c as any).proc = (await import("node:child_process")).spawn(process.execPath, [silent], { stdio: ["pipe", "pipe", "pipe"] });
  await expect(c.request("anything", {}, 300)).rejects.toThrow("did not answer in time"); (c as any).proc.kill();
  const good = new LspSet(d, TS); sets.push(good); expect(await lspTool(good, d, { action: "symbols", path: "x.ts" })).toContain("a");
}, 60000);

test("which languages a project uses, which helpers are found, and the line that installs a missing one", () => {
  resetLspCache();
  const d = tmpProject({ "a.ts": "", "b.ts": "", "c.py": "", "main.go": "", "node_modules/x/index.js": "", "README.md": "" });
  expect(detectLangs(d).map((x) => [x.lang.id, x.files])).toEqual([["typescript", 2], ["python", 1], ["go", 1]]); // node_modules is not counted
  expect(langOf("x.TSX")!.id).toBe("typescript"); expect(langOf("x.txt")).toBeUndefined();
  expect(findServer(LANGS[0], d, false)).toBeNull(); expect(findServer(LANGS[0], d, { typescript: false })).toBeNull();
  expect(findServer(LANGS[0], d, { typescript: { command: "definitely-not-a-program-xyz" } })).toBeNull();
  expect(findServer(LANGS[0], d, TS)!.from).toBe("your settings");
  const text = describeLangs(d, { ...TS, python: false, go: { command: "definitely-not-a-program-xyz" } } as any);
  expect(text).toMatch(/TypeScript and JavaScript \(2 files\): ready, using .*typescript-language-server/); expect(text).toContain("Python (1 file): no helper found. Install one with:  npm install -g pyright"); expect(text).toContain("never downloads a helper by itself");
  expect(describeLangs(d, false)).toContain("switched off in the settings"); expect(describeLangs(tmpProject({ "a.txt": "" }), undefined)).toContain("No code in a language");
  // a helper inside the project's own node_modules is found without any setting
  const local = tmpProject({ "a.ts": "", ["node_modules/.bin/typescript-language-server" + (process.platform === "win32" ? ".cmd" : "")]: "" });
  expect(findServer(LANGS[0], local, undefined)!.from).toBe("this project");
});

test("the tool is offered to the AI only when a helper can really be started, and works through the tool runner", async () => {
  resetLspCache(); const d = tsProject();
  const has = (settings: any) => toolDefs(makeCtx(d, "auto", async () => true, settings, DEFAULT)).some((t: any) => t.function.name === "lsp");
  expect(has({ lsp: TS })).toBe(true); expect(has({ lsp: false })).toBe(false); expect(has({ lsp: { typescript: false } })).toBe(false);
  expect(lspAvailable(tmpProject({ "a.txt": "" }), TS as any)).toBe(false);
  const plan = makeCtx(d, "plan", async () => true, { lsp: TS } as any, DEFAULT); expect(toolDefs(plan).some((t: any) => t.function.name === "lsp")).toBe(true); // read-only, so it is there in planning mode too
  const ctx = makeCtx(d, "auto", async () => true, { lsp: TS } as any, DEFAULT);
  try { const out = await runTool(ctx, "lsp", { action: "definition", path: "src/b.ts", line: 2, symbol: "greet" }); expect(out).toContain("src/a.ts:1"); expect(await runTool(makeCtx(d, "auto", async () => true, { lsp: false } as any, DEFAULT), "lsp", { action: "symbols", path: "src/a.ts" })).toContain("switched off"); }
  finally { ctx.lsp?.stopAll(); }
}, 60000);

test("whole program: syok lang lists the project's languages (needs no key)", () => {
  const d = tmpProject({ "a.py": "x = 1\n", ".syok/settings.json": JSON.stringify({ lsp: PY }) }); const env: any = { ...process.env, HOME: d, USERPROFILE: d }; delete env.SYOK_BASE_URL; delete env.SYOK_API_KEY;
  const r = spawnSync("bun", [join(import.meta.dir, "..", "src", "main.ts"), "lang"], { cwd: d, env, encoding: "utf8" });
  expect(r.status).toBe(0); expect(r.stdout).toMatch(/Python \(1 file\): ready, using .*pyright-langserver/);
  const h = spawnSync("bun", [join(import.meta.dir, "..", "src", "main.ts"), "--help"], { cwd: d, env, encoding: "utf8" }); expect(h.stdout).toContain("syok lang");
});

// A helper reads the project (and may load code from it), so under confinement it runs confined like the AI's commands.
test("under confinement the helper still works, and runs inside the confinement", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const base = realpathSync(mkdtempSync(join(homedir(), ".syok-lsp-confine-"))); const d = join(base, "proj"); mkdirSync(join(d, "src"), { recursive: true });
  try {
    writeFileSync(join(d, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] })); writeFileSync(join(d, "src", "a.ts"), "export function greet(name: string): string { return name; }\nconst bad: number = greet(\"x\");\nexport { bad };\n");
    const plan = planConfine({ root: d }); const why = "problem" in plan ? plan.problem : probeConfine(plan);
    if (why) { if (process.env.SYOK_REQUIRE_CONFINE === "1") throw new Error("confinement is required for this run but is not working: " + why); console.log("  (skipped: " + why.split("\n")[0] + ")"); return; }
    setConfine(plan as any); const set = new LspSet(d, TS); sets.push(set);
    expect(await lspTool(set, d, { action: "diagnostics", path: "src/a.ts" })).toContain("Type 'string' is not assignable to type 'number'");
    const c = await set.forFile(join(d, "src", "a.ts")); expect((c.proc as any).spawnfile).toMatch(/bwrap|sandbox-exec/);
    set.stopAll();
  } finally { setConfine(null); rmSync(base, { recursive: true, force: true }); }
}, 120000);

test("a file is recognised however a helper spells its address (Windows drive letters and escaped colons)", () => {
  expect(uriKey("file:///C:/Users/Me/proj/src/a.ts")).toBe(uriKey("file:///c%3A/Users/Me/proj/src/a.ts"));
  expect(uriKey("file:///c:/users/me/proj/src/A.ts")).toBe(uriKey("file:///C:/Users/Me/proj/src/a.ts"));
  expect(uriKey("file:///C:/Users/Me/proj/src/a.ts")).not.toBe(uriKey("file:///C:/Users/Me/proj/src/b.ts"));
  if (process.platform !== "win32") { expect(uriKey("file:///home/me/Proj/a.ts")).toBe("/home/me/Proj/a.ts"); expect(uriKey("file:///home/me/Proj/a.ts")).not.toBe(uriKey("file:///home/me/proj/a.ts")); } // letter case matters where the disk says it does
  expect(uriKey("file:///home/me/my%20proj/a.ts")).toContain("my proj");
});

// ---- rename: the helper finds every real use; the change goes through the same path as edit_file ----
const renameProject = () => tmpProject({
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler", noEmit: true }, include: ["src"] }),
  "src/a.ts": "export function greet(name: string): string { return \"hi \" + name; }\nexport class Box {\n  value = 1;\n  greet() { return 2; }\n}\n",
  "src/b.ts": "import { greet, Box } from \"./a\";\nexport const x: string = greet(\"y\");\nexport const n = new Box().greet();\n",
  "src/c.ts": "import { greet } from \"./a\";\nexport function twice(s: string) { return greet(s) + greet(s); }\n",
});
const readF = (d: string, p: string) => readFileSync(join(d, p), "utf8");

test("TypeScript rename, for real: across 3 files, the method with the same name left alone; /undo, checkpoints and ask mode work", async () => {
  const d = renameProject(); const asked: Array<[string, string]> = [];
  const ctx = makeCtx(d, "ask", async (q: string, p?: string) => { asked.push([q, p || ""]); return true; }, { lsp: TS } as any, DEFAULT);
  const cps: Checkpoint[] = []; takeCheckpoint(ctx, cps, "before", 0);
  try {
    // asked from a USE in another file, not from the definition: still renamed everywhere
    const out = await runTool(ctx, "lsp", { action: "rename", path: "src/c.ts", line: 2, symbol: "greet", new_name: "welcome" });
    expect(out).toContain('Renamed "greet" to "welcome": 6 changes in 3 files'); expect(out).toContain("src/a.ts: 1 change\n"); expect(out).toContain("src/b.ts: 2 changes"); expect(out).toContain("src/c.ts: 3 changes");
    expect(readF(d, "src/a.ts")).toContain("export function welcome(name: string)"); expect(readF(d, "src/a.ts")).toContain("  greet() { return 2; }"); // the method keeps its name
    expect(readF(d, "src/b.ts")).toBe("import { welcome, Box } from \"./a\";\nexport const x: string = welcome(\"y\");\nexport const n = new Box().greet();\n");
    expect(readF(d, "src/c.ts")).toBe("import { welcome } from \"./a\";\nexport function twice(s: string) { return welcome(s) + welcome(s); }\n");
    // ask mode: ONE question for the whole rename, showing the diff of every file
    expect(asked.length).toBe(1); expect(asked[0][0]).toBe("edit 3 files (rename \"greet\" to \"welcome\")");
    for (const f of ["src/a.ts", "src/b.ts", "src/c.ts"]) expect(asked[0][1]).toContain(f);
    expect(asked[0][1]).toContain("+import { welcome } from \"./a\";");
    expect([...ctx.touched].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]); expect(sessionDiff(ctx)).toContain("-export function greet");
    // the helper sees the new names straight away: no errors, and the new name has all its uses
    expect(await runTool(ctx, "lsp", { action: "diagnostics", path: "src/c.ts" })).toContain("reports no problems");
    expect(await runTool(ctx, "lsp", { action: "references", path: "src/a.ts", line: 1, symbol: "welcome" })).toMatch(/^5 place\(s\)/);
    // a checkpoint taken before puts everything back
    const r = rewindTo(ctx, cps, 1)!; expect(r.restored.sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]); expect(readF(d, "src/c.ts")).toContain("return greet(s) + greet(s)");
    // and so does /undo, after a second rename (this time at the definition, by line and column)
    const again = await runTool(ctx, "lsp", { action: "rename", path: "src/a.ts", line: 1, column: 17, new_name: "hello" }); expect(again).toContain("6 changes in 3 files");
    expect(readF(d, "src/b.ts")).toContain("hello(\"y\")"); expect(undoAll(ctx).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]); expect(readF(d, "src/b.ts")).toContain("greet(\"y\")");
  } finally { ctx.lsp?.stopAll(); }
}, 120000);

test("rename refuses: bad new names, a refused approval, keywords, library names, planning mode and read-only helpers", async () => {
  const d = renameProject(); const names = ["src/a.ts", "src/b.ts", "src/c.ts"]; const before = names.map((f) => readF(d, f)); const same = () => expect(names.map((f) => readF(d, f))).toEqual(before);
  const no = makeCtx(d, "ask", async () => false, { lsp: TS } as any, DEFAULT);
  try {
    for (const bad of ["two words", "9lives", "a.b", "", "class", "x-y"]) { const o = await runTool(no, "lsp", { action: "rename", path: "src/a.ts", line: 1, symbol: "greet", new_name: bad }); expect(o).toMatch(/^Error: .*(not a valid name|reserved word|give the new name)/); expect(o).toContain("Nothing was changed"); }
    expect(await runTool(no, "lsp", { action: "rename", path: "src/a.ts", line: 1, symbol: "greet", new_name: "greet" })).toContain("already \"greet\"");
    expect(await runTool(no, "lsp", { action: "rename", path: "src/a.ts", line: 1, symbol: "greet", new_name: "welcome" })).toContain("did not allow"); same(); expect(no.touched.size).toBe(0);
    // the helper cannot rename a keyword: said plainly
    const kw = await runTool(no, "lsp", { action: "rename", path: "src/a.ts", line: 1, symbol: "return", new_name: "x" }); expect(kw).toMatch(/^Error: the TypeScript and JavaScript helper cannot rename/); expect(kw).toContain("Nothing was changed");
    // a name defined outside the project (the standard library's Array.map) is not renamed
    writeFileSync(join(d, "src", "d.ts"), "export const s = [1].map((v) => v);\n");
    const lib = await runTool(no, "lsp", { action: "rename", path: "src/d.ts", line: 1, symbol: "map", new_name: "mapped" }); expect(lib).toMatch(/^Error: .*(outside the project|cannot rename)/); expect(lib).toContain("Nothing was changed"); expect(readF(d, "src/d.ts")).toContain(".map(");
    expect(await runTool(no, "lsp", { action: "rename", path: "../x.ts", line: 1, new_name: "y" })).toContain("outside the project");
    // planning mode, read-only helpers and preview get only the list
    const plan = makeCtx(d, "plan", async () => true, { lsp: TS } as any, DEFAULT); plan.lsp = no.lsp;
    const p = await runTool(plan, "lsp", { action: "rename", path: "src/a.ts", line: 1, symbol: "greet", new_name: "welcome" }); expect(p).toContain("would make 6 changes in 3 files"); expect(p).toContain("src/c.ts: 3 changes"); expect(p).toContain("planning mode"); same();
    const ro = makeCtx(d, "auto", async () => true, { lsp: TS } as any, DEFAULT); ro.lsp = no.lsp; ro.allowed = READONLY; ro.depth = 1;
    expect(await runTool(ro, "lsp", { action: "rename", path: "src/a.ts", line: 1, symbol: "greet", new_name: "welcome" })).toContain("this helper may not change files"); same();
    const pv = makeCtx(d, "auto", async () => true, { lsp: TS } as any, DEFAULT); pv.lsp = no.lsp;
    expect(await runTool(pv, "lsp", { action: "rename", path: "src/a.ts", line: 1, symbol: "greet", new_name: "welcome", preview: true })).toContain("preview only"); same();
  } finally { no.lsp?.stopAll(); }
}, 120000);

test("rename refuses when it would change a protected file (the same rules as edit_file)", async () => {
  const d = tmpProject({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ["src/a.ts", "src/.env.ts"] }),
    "src/a.ts": "export const token = 1;\n", "src/.env.ts": "import { token } from \"./a\";\nexport const t = token;\n",
  });
  const ctx = makeCtx(d, "auto", async () => true, { lsp: TS } as any, DEFAULT);
  try {
    const out = await runTool(ctx, "lsp", { action: "rename", path: "src/a.ts", line: 1, symbol: "token", new_name: "tok" });
    expect(out).toContain("src/.env.ts is protected and cannot be changed"); expect(out).toContain("Nothing was changed");
    expect(readF(d, "src/a.ts")).toBe("export const token = 1;\n"); expect(ctx.touched.size).toBe(0);
  } finally { ctx.lsp?.stopAll(); }
}, 120000);

test("Python rename, for real: across 3 files", async () => {
  const d = tmpProject({ "m.py": "def area(w: int, h: int) -> int:\n    return w * h\n", "n.py": "from m import area\n\nx: int = area(1, 2)\n", "o.py": "import m\nfrom m import area\n\nprint(area(3, 4), m.area(5, 6))\n" });
  const ctx = makeCtx(d, "auto", async () => true, { lsp: PY } as any, DEFAULT);
  try {
    const out = await runTool(ctx, "lsp", { action: "rename", path: "m.py", line: 1, symbol: "area", new_name: "surface" });
    expect(out).toContain('Renamed "area" to "surface"'); expect(out).toContain("in 3 files"); expect(out).toContain("m.py: 1 change\n"); expect(out).toContain("n.py: 2 changes"); expect(out).toContain("o.py: 3 changes");
    expect(readF(d, "m.py")).toBe("def surface(w: int, h: int) -> int:\n    return w * h\n"); expect(readF(d, "n.py")).toBe("from m import surface\n\nx: int = surface(1, 2)\n");
    expect(readF(d, "o.py")).toBe("import m\nfrom m import surface\n\nprint(surface(3, 4), m.surface(5, 6))\n");
    expect(await runTool(ctx, "lsp", { action: "rename", path: "m.py", line: 1, symbol: "surface", new_name: "lambda" })).toContain("reserved word");
  } finally { ctx.lsp?.stopAll(); }
}, 120000);

test("rename edits are applied exactly (several on one line, Windows line ends) and overlapping ones are refused", () => {
  const e = (l: number, s: number, en: number, t: string) => ({ range: { start: { line: l, character: s }, end: { line: l, character: en } }, newText: t });
  expect(applyTextEdits("ab ab\r\nab\r\n", [e(0, 0, 2, "xyz"), e(0, 3, 5, "xyz"), e(1, 0, 2, "q")])).toBe("xyz xyz\r\nq\r\n");
  expect(applyTextEdits("héllo wörld\n", [e(0, 6, 11, "earth")])).toBe("héllo earth\n");
  expect(() => applyTextEdits("abcdef", [e(0, 0, 3, "x"), e(0, 2, 4, "y")])).toThrow("overlap");
  expect(badName("typescript", "$ok_1")).toBe(""); expect(badName("python", "$no")).toContain("not a valid name"); expect(badName("python", "café")).toBe(""); expect(badName("typescript", "enum")).toContain("reserved");
});
