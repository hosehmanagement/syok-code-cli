// Language helpers: real language servers (TypeScript's and Python's, from this repository's dev dependencies) answering
// about small real projects, plus a broken stand-in for the failure cases.
import { test, expect, afterAll } from "bun:test";
import { existsSync, writeFileSync, utimesSync, mkdtempSync, realpathSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { tmpProject, call } from "./helpers.ts";
import { LspSet, LspClient, lspTool, detectLangs, findServer, describeLangs, lspAvailable, resetLspCache, LANGS, langOf, uriKey } from "../src/lsp.ts";
import { makeCtx, toolDefs, runTool } from "../src/tools.ts";
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
