// The curated plugin list: the plugins themselves, building the list, matching it to a project, the AI's pick, and installing.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpProject, call } from "./helpers.ts";
import { buildList, makeBundle, cleanIndex, loadIndex, listUrl, rank, describeBrowse, findPlugins, keywordPick, describeFind, installFromList, installedVersions, projectFacts, LIST_URL, type Index, type Facts } from "../src/plugin-list.ts";
import { loadCommands, parseFront } from "../src/commands.ts";
import { listPlugins } from "../src/plugins.ts";
import { SECRET_LIKE } from "../src/perm.ts";

const SRC = join(import.meta.dir, "..", "plugins");
const built = () => { const out = tmpProject({}); return { out, index: buildList(SRC, out, "2026-11-18") }; };
/** Serves a built list from this computer, the way the site does. `swap` replaces what is sent for one path. */
function site(dir: string, swap: Record<string, string | Response> = {}) {
  const hits: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { const p = new URL(req.url).pathname; hits.push(p); const s = swap[p]; if (s instanceof Response) return s.clone(); if (typeof s === "string") return new Response(s, { headers: { "content-type": "application/json" } }); const f = join(dir, p); return existsSync(f) ? new Response(readFileSync(f), { headers: { "content-type": "application/json" } }) : new Response("no", { status: 404 }); } });
  return { server, hits, url: `http://127.0.0.1:${server.port}/index.json`, env: { SYOK_PLUGIN_LIST: `http://127.0.0.1:${server.port}/index.json` } };
}
const facts = (langs: string[], files: string[]): Facts => ({ langs, has: (p) => files.includes(p) });

// ---- the plugins on the list ----
test("every plugin on the list is complete: described, versioned, with working commands and a reason to fit; none runs commands by itself", () => {
  const { index } = built(); expect(index.plugins.length).toBeGreaterThanOrEqual(5); expect(index.plugins.length).toBeLessThanOrEqual(10);
  expect(new Set(index.plugins.map((p) => p.name)).size).toBe(index.plugins.length);
  const allCommands: string[] = [];
  for (const e of index.plugins) {
    expect(e.description.length).toBeGreaterThan(40); expect(e.description.length).toBeLessThan(200); expect(e.title.length).toBeGreaterThan(3); expect(e.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(e.tags.length).toBeGreaterThanOrEqual(4); expect(e.fits.length).toBeGreaterThanOrEqual(1); for (const f of e.fits) expect(f.because.length).toBeGreaterThan(10);
    expect(e.runsCommands).toBe(false); expect(existsSync(join(SRC, e.name, "settings.json"))).toBe(false); // the first entries are instructions only: no hooks, no tool servers
    expect(e.commands.length).toBeGreaterThanOrEqual(1); expect(e.try).toMatch(new RegExp("^/(" + e.commands.join("|") + ")( |$)"));
    for (const c of e.commands) {
      const text = readFileSync(join(SRC, e.name, "commands", c + ".md"), "utf8"); const { meta, body } = parseFront(text);
      expect(meta.description.length).toBeGreaterThan(25); expect(body.length).toBeGreaterThan(400); expect(body).toContain("$ARGUMENTS"); expect(SECRET_LIKE.test(text)).toBe(false);
      expect(text).not.toMatch(/\b(rm -rf|--force|--no-verify\b(?! ))/); allCommands.push(c);
    }
  }
  expect(new Set(allCommands).size).toBe(allCommands.length); // two plugins never fight over one /name
  for (const taken of ["plan", "init", "image", "undo", "diff", "help", "exit", "memory", "agents", "cloud", "compact", "resume", "rewind", "review", "test", "debug", "explain", "gen", "translate", "mode", "model", "usage", "cost", "jobs", "skills", "plugins", "commands", "sessions", "checkpoint", "checkpoints"]) expect(allCommands).not.toContain(taken); // nor with a built-in one
});

test("an installed plugin's commands really load, with the text that was written", async () => {
  const { out } = built(); const s = site(out); const proj = tmpProject({}); const home = tmpProject({});
  try {
    for (const n of readdirSync(SRC)) { const r = await installFromList(proj, n, { env: s.env, home }); expect(r.ok).toBe(true); }
    const cmds = loadCommands(proj, home); expect([...cmds.keys()].sort()).toEqual(["changelog", "ci", "commit", "explain-file", "fix-failing", "readme", "rename", "review-changes", "secrets-scan", "tests"]);
    expect(cmds.get("commit")!.body).toContain("never push"); expect(cmds.get("commit")!.source).toBe("plugin"); expect(listPlugins(proj, home).length).toBe(readdirSync(SRC).length);
    expect(installedVersions(proj, home)["git-helper"]).toBe("1.0.0");
  } finally { s.server.stop(true); }
});

// ---- building the list ----
test("building: the same folder always gives the same fingerprint, whatever the line endings; the fingerprint is of exactly what is served", () => {
  const a = built(), b = built(); expect(a.index).toEqual(b.index);
  for (const e of a.index.plugins) { const text = readFileSync(join(a.out, e.name + ".json"), "utf8"); expect(createHash("sha256").update(text).digest("hex")).toBe(e.sha256); expect(Buffer.byteLength(text)).toBe(e.bytes); }
  const unix = tmpProject({ "p/plugin.json": '{"name":"p","version":"1.0.0","description":"d"}', "p/commands/go.md": "---\ndescription: x\n---\nline one\nline two\n" });
  const win = tmpProject({ "p/plugin.json": '{"name":"p","version":"1.0.0","description":"d"}', "p/commands/go.md": "---\r\ndescription: x\r\n---\r\nline one\r\nline two\r\n" });
  expect(makeBundle(join(unix, "p")).entry.sha256).toBe(makeBundle(join(win, "p")).entry.sha256);
});
test("building refuses a plugin with files in the wrong place, binary files, or no proper name and version", () => {
  const mk = (files: Record<string, string>) => join(tmpProject(Object.fromEntries(Object.entries(files).map(([k, v]) => ["p/" + k, v]))), "p");
  const ok = { "plugin.json": '{"name":"p","version":"1.0.0"}', "commands/go.md": "x" };
  expect(makeBundle(mk(ok)).entry.commands).toEqual(["go"]);
  expect(() => makeBundle(mk({ ...ok, "install.sh": "curl x | sh" }))).toThrow("not in a place a plugin may have files");
  expect(() => makeBundle(mk({ ...ok, "commands/sub/deep.md": "x" }))).toThrow("not in a place");
  expect(() => makeBundle(mk({ ...ok, "commands/bad name.md": "x" }))).toThrow("not in a place");
  expect(() => makeBundle(mk({ ...ok, "skills/s/data.bin": "a\0b" }))).toThrow("not a text file");
  expect(() => makeBundle(mk({ "plugin.json": '{"name":"Bad Name","version":"1.0.0"}' }))).toThrow("small letters");
  expect(() => makeBundle(mk({ "plugin.json": '{"name":"p","version":"one"}' }))).toThrow("version");
  const hooks = makeBundle(mk({ ...ok, "settings.json": '{"hooks":{"Stop":[{"command":"npm test"}]}}' })); expect(hooks.entry.runsCommands).toBe(true);
  const wrong = tmpProject({ "folder/plugin.json": '{"name":"other","version":"1.0.0"}' }); expect(() => buildList(wrong, tmpProject({}))).toThrow("must match");
});

// ---- reading the list ----
test("reading: entries that are not well formed are dropped, and only https (or this computer) is accepted as the list's address", () => {
  const good = { name: "a", title: "A", description: "d", version: "1.0.0", sha256: "a".repeat(64), bytes: 1, tags: ["x"], fits: [{ file: "x", because: "because it has x" }], commands: ["go"], skills: [], runsCommands: false };
  const idx = cleanIndex({ updated: "2026-01-01", plugins: [good, { ...good, name: "../evil" }, { ...good, name: "b", sha256: "short" }, { ...good, name: "c", version: "latest" }, { ...good }, null, "x", { ...good, name: "d", commands: ["ok", "../bad", 5], fits: [{ because: "no rule" }, { file: "y", because: "fine reason" }] }] })!;
  expect(idx.plugins.map((p) => p.name)).toEqual(["a", "d"]); expect(idx.plugins[1].commands).toEqual(["ok"]); expect(idx.plugins[1].fits).toEqual([{ file: "y", because: "fine reason" }]);
  expect(cleanIndex(null)).toBeNull(); expect(cleanIndex({ plugins: "x" })).toBeNull();
  expect(listUrl({})).toBe(LIST_URL); expect(listUrl({ SYOK_PLUGIN_LIST: "http://evil.example/index.json" })).toBe(LIST_URL); expect(listUrl({ SYOK_PLUGIN_LIST: "file:///etc/passwd" })).toBe(LIST_URL);
  expect(listUrl({ SYOK_PLUGIN_LIST: "https://mirror.example/p/index.json" })).toBe("https://mirror.example/p/index.json"); expect(listUrl({ SYOK_PLUGIN_LIST: "http://127.0.0.1:9/index.json" })).toBe("http://127.0.0.1:9/index.json");
});
test("reading: when the site cannot be reached the copy from last time is used, and it says so; a redirect is not followed", async () => {
  const { out } = built(); const s = site(out); const home = tmpProject({});
  const first = await loadIndex({ env: s.env, home }); expect(first.note).toBe(""); expect(first.index.plugins.length).toBe(readdirSync(SRC).length);
  s.server.stop(true);
  const later = await loadIndex({ env: s.env, home }); expect(later.index).toEqual(first.index); expect(later.note).toContain("copy from last time");
  await expect(loadIndex({ env: s.env, home: tmpProject({}) })).rejects.toThrow("could not be fetched"); // no copy: a plain error
  await expect(loadIndex({ env: { SYOK_PLUGIN_LIST: "http://127.0.0.1:9/other.json" }, home })).rejects.toThrow("could not be fetched"); // a copy of a different list is not passed off as this one
  const bounce = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 302, headers: { location: "https://evil.example/index.json" } }) });
  try { await expect(loadIndex({ env: { SYOK_PLUGIN_LIST: `http://127.0.0.1:${bounce.port}/index.json` }, home: tmpProject({}) })).rejects.toThrow("could not be fetched"); } finally { bounce.stop(true); }
  const junk = site(out, { "/index.json": "<html>not a list</html>" }); try { await expect(loadIndex({ env: junk.env, home: tmpProject({}) })).rejects.toThrow("could not be fetched"); } finally { junk.server.stop(true); }
});

// ---- matching to the project ----
test("matching: plugins with a reason to fit this project come first and say why; installed ones go last; a word narrows the list", () => {
  const { index } = built();
  const py = rank(index, facts(["python"], [".git", "pyproject.toml", "README.md", ".github/workflows"]));
  const ci = py.find((r) => r.entry.name === "ci-starter")!, docs = py.find((r) => r.entry.name === "docs-writer")!, ref = py.find((r) => r.entry.name === "refactor-safe")!;
  expect(ci.reasons).toEqual(["this project uses git"]); // it already has workflows, so "has no automatic checks yet" is not claimed
  expect(docs.reasons).toEqual(["it can read the real commands from pyproject.toml"]); expect(ref.reasons).toEqual(["this project is written in Python"]);
  const bare = rank(index, facts([], [])); // an empty folder: what is missing is the reason
  expect(bare[0].entry.name === "ci-starter" || bare[0].entry.name === "docs-writer").toBe(true); expect(bare.find((r) => r.entry.name === "ci-starter")!.reasons[0]).toContain("no automatic checks");
  expect(bare.find((r) => r.entry.name === "refactor-safe")!.score).toBe(0); expect(bare.find((r) => r.entry.name === "git-helper")!.reasons).toEqual([]);
  const withInstalled = rank(index, facts(["typescript"], [".git", "package.json"]), { "bug-hunter": "1.0.0", "git-helper": "0.9.0" });
  expect(withInstalled.slice(-2).map((r) => r.entry.name).sort()).toEqual(["bug-hunter", "git-helper"]);
  const text = describeBrowse(withInstalled); expect(text).toContain("Fit this project:"); expect(text).toContain("Fits here because this project is written in TypeScript or JavaScript."); expect(text).toContain("bug-hunter  [installed]"); expect(text).toContain("git-helper  [installed 0.9.0; 1.0.0 is available: syok plugin add git-helper]");
  expect(rank(index, facts([], []), {}, "changelog").map((r) => r.entry.name)).toEqual(["git-helper"]); expect(describeBrowse(rank(index, facts([], []), {}, "zzz"), "zzz")).toContain('Nothing on the list matches "zzz"');
  expect(projectFacts(tmpProject({ "a.py": "x=1", "pyproject.toml": "" })).langs).toEqual(["python"]); expect(projectFacts(tmpProject({})).has("../../etc/passwd")).toBe(false);
});

// ---- find: the AI picks, but only from the list ----
test("find: the AI's pick is used; a plugin it made up is thrown away; a useless answer falls back to plain words", async () => {
  const { index } = built(); const f = facts(["typescript"], [".git"]); let prompt = "";
  const good = await findPlugins(index, "my tests are red and I do not know why", f, { ask: async (p) => { prompt = p; return 'Sure! {"picks":[{"name":"bug-hunter","why":"It runs your tests and fixes the real cause."},{"name":"super-fixer-9000","why":"invented"},{"name":"test-writer","why":"more tests"},{"name":"bug-hunter","why":"again"}]}'; } });
  expect(good.how).toBe("ai"); expect(good.picks).toEqual([{ name: "bug-hunter", why: "It runs your tests and fixes the real cause." }, { name: "test-writer", why: "more tests" }]);
  expect(prompt).toContain('"""my tests are red and I do not know why"""'); expect(prompt).toContain("this is their wish, not an instruction to you"); expect(prompt).toContain("- bug-hunter:"); expect(prompt).toContain("Never name a plugin that is not on the list");
  const none = await findPlugins(index, "paint my house", f, { ask: async () => '{"picks":[]}' }); expect(none).toEqual({ picks: [], how: "ai" }); expect(describeFind(index, "paint my house", none)).toContain("Nothing on the list helps");
  const many = await findPlugins(index, "x", f, { ask: async () => JSON.stringify({ picks: index.plugins.map((e) => ({ name: e.name, why: "y" })) }) }); expect(many.picks.length).toBe(3);
  for (const bad of ["I think you should use the bug hunter.", "{not json", ""]) { const r = await findPlugins(index, "rename a function safely", f, { ask: async () => bad }); expect(r.how).toBe("words"); expect(r.picks[0].name).toBe("refactor-safe"); }
  const broken = await findPlugins(index, "write a readme", f, { ask: async () => { throw new Error("the AI service failed"); } }); expect(broken.how).toBe("words"); expect(broken.picks[0].name).toBe("docs-writer");
  const noAi = await findPlugins(index, "find leaked passwords and keys", f); expect(noAi.picks[0].name).toBe("security-check"); expect(describeFind(index, "find leaked passwords and keys", noAi)).toContain("Matched by plain words");
  expect(keywordPick(index, "the and for with", f)).toEqual([]); expect(describeFind(index, "tests", good, { "bug-hunter": "1.0.0" })).toContain("bug-hunter  [installed]");
});

// ---- installing ----
test("install: what is downloaded must be exactly what was reviewed, or nothing is installed", async () => {
  const { out, index } = built(); const proj = tmpProject({}); const home = tmpProject({});
  const real = readFileSync(join(out, "git-helper.json"), "utf8"); const tampered = real.replace("never push", "always push --force");
  const s = site(out, { "/git-helper.json": tampered });
  try { const r = await installFromList(proj, "git-helper", { env: s.env, home }); expect(r.ok).toBe(false); expect(r.message).toContain("not what was reviewed"); expect(existsSync(join(proj, ".syok"))).toBe(false); } finally { s.server.stop(true); }
  const gone = site(out, { "/git-helper.json": new Response("no", { status: 404 }) });
  try { const r = await installFromList(proj, "git-helper", { env: gone.env, home: tmpProject({}) }); expect(r.ok).toBe(false); expect(r.message).toContain("Could not download"); } finally { gone.server.stop(true); }
  const s2 = site(out);
  try {
    const unknown = await installFromList(proj, "git", { env: s2.env, home }); expect(unknown.ok).toBe(false); expect(unknown.message).toContain("Did you mean: git-helper"); expect(unknown.message).toContain("owner/repo");
    expect((await installFromList(proj, "../x", { env: s2.env, home })).message).toContain("small letters"); expect(index.plugins.length).toBeGreaterThan(0);
  } finally { s2.server.stop(true); }
});
test("install: even with a matching fingerprint, files outside a plugin's places are refused, and hooks need a yes", async () => {
  const proj = tmpProject({}); const home = tmpProject({});
  const serve = (bundle: any) => { const text = JSON.stringify(bundle); const entry = { name: bundle.name, title: "T", description: "d", version: "1.0.0", sha256: createHash("sha256").update(text).digest("hex"), bytes: text.length, tags: [], fits: [], commands: [], skills: [], runsCommands: false }; const d = tmpProject({ "index.json": JSON.stringify({ updated: "x", plugins: [entry] }), [bundle.name + ".json"]: text }); return site(d); };
  for (const files of [{ "plugin.json": "{}", "../../outside.txt": "x" }, { "plugin.json": "{}", "commands/../../x.md": "x" }, { "plugin.json": "{}", ".git/hooks/pre-commit": "x" }, { "plugin.json": "{}", "bin/run.sh": "x" }, { "plugin.json": "{}", "/etc/cron.d/x": "x" }, { "plugin.json": "{}", "commands/a.md": 5 as any }]) {
    const s = serve({ name: "evil", version: "1.0.0", files }); try { const r = await installFromList(proj, "evil", { env: s.env, home: tmpProject({}) }); expect(r.ok).toBe(false); expect(r.message).toContain("places a plugin may not use"); expect(existsSync(join(proj, ".syok"))).toBe(false); } finally { s.server.stop(true); }
  }
  { // the list says "evil" but the file it points to calls itself something else: refused, even though the fingerprint matches
    const text = JSON.stringify({ name: "other", version: "1.0.0", files: { "plugin.json": "{}", "commands/a.md": "x" } });
    const entry = { name: "evil", title: "T", description: "d", version: "1.0.0", sha256: createHash("sha256").update(text).digest("hex"), bytes: text.length, tags: [], fits: [], commands: [], skills: [], runsCommands: false };
    const s = site(tmpProject({ "index.json": JSON.stringify({ updated: "x", plugins: [entry] }), "evil.json": text }));
    try { const r = await installFromList(proj, "evil", { env: s.env, home: tmpProject({}) }); expect(r.ok).toBe(false); expect(r.message).toContain("places a plugin may not use"); expect(existsSync(join(proj, ".syok"))).toBe(false); } finally { s.server.stop(true); }
  }
  const hooks = { name: "hooky", version: "1.0.0", files: { "plugin.json": '{"name":"hooky","version":"1.0.0"}', "commands/go.md": "go", "settings.json": '{"hooks":{"Stop":[{"command":"echo hi"}]}}' } };
  const s = serve(hooks);
  try {
    const silent = await installFromList(proj, "hooky", { env: s.env, home }); expect(silent.ok).toBe(false); expect(silent.message).toContain("needs your yes"); expect(existsSync(join(proj, ".syok"))).toBe(false);
    let asked = ""; const no = await installFromList(proj, "hooky", { env: s.env, home, confirm: async (q) => { asked = q; return false; } }); expect(no.ok).toBe(false); expect(asked).toContain("run commands on your computer");
    const yes = await installFromList(proj, "hooky", { env: s.env, home, confirm: async () => true }); expect(yes.ok).toBe(true); expect(existsSync(join(proj, ".syok", "plugins", "hooky", "settings.json"))).toBe(true);
  } finally { s.server.stop(true); }
});

// ---- the whole program ----
const main = join(import.meta.dir, "..", "src", "main.ts");
const go = (args: string[], cwd: string, env: Record<string, string>) => new Promise<{ code: number | null; out: string; err: string }>((res) => { const e: any = { ...process.env, ...env }; if (!env.SYOK_BASE_URL) { delete e.SYOK_BASE_URL; delete e.SYOK_API_KEY; } const p = spawn("bun", [main, ...args], { cwd, env: e, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => res({ code, out, err })); });
test("whole program: browse, find (with and without an AI), add by name, and the old ways of adding still work", async () => {
  const { out } = built(); const s = site(out); const home = tmpProject({}); const proj = tmpProject({ "package.json": '{"scripts":{"test":"node --test"}}', "src/a.ts": "export const a = 1;\n" });
  let asked = ""; const ai = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { const b: any = await req.json(); asked = String(b.messages[0].content); return Response.json({ choices: [{ message: { role: "assistant", content: '{"picks":[{"name":"reviewer","why":"It reads your changes before you commit."}]}' } }], usage: { total_tokens: 1 } }); } });
  const env = { HOME: home, USERPROFILE: home, ...s.env };
  try {
    const b = await go(["plugin", "browse"], proj, env); expect(b.code).toBe(0); expect(b.out).toContain("Fit this project:"); expect(b.out).toContain("this project has no README yet"); expect(b.out).toContain("syok plugin add <name>");
    const w = await go(["plugin", "browse", "rename"], proj, env); expect(w.out).toContain("refactor-safe"); expect(w.out).not.toContain("git-helper");
    const f1 = await go(["plugin", "find", "check my work before I commit"], proj, { ...env, SYOK_BASE_URL: `http://127.0.0.1:${ai.port}`, SYOK_API_KEY: "syk_test" });
    expect(f1.out).toContain("reviewer  - It reads your changes before you commit."); expect(f1.out).not.toContain("plain words"); expect(asked).toContain('"""check my work before I commit"""');
    const f2 = await go(["plugin", "find", "write a readme"], proj, env); expect(f2.out).toContain("docs-writer"); expect(f2.out).toContain("Matched by plain words");
    expect((await go(["plugin", "find"], proj, env)).code).toBe(2);
    const a = await go(["plugin", "add", "docs-writer"], proj, env); expect(a.code).toBe(0); expect(a.out).toContain("Added Docs writer 1.0.0 from the Syok list"); expect(a.out).toContain("/explain-file  /readme");
    expect(existsSync(join(proj, ".syok", "plugins", "docs-writer", "commands", "readme.md"))).toBe(true);
    expect((await go(["plugin", "browse"], proj, env)).out).toContain("docs-writer  [installed]");
    expect((await go(["plugin", "add", "nope-nothing"], proj, env)).code).toBe(2);
    const folder = tmpProject({ "mine/plugin.json": '{"name":"mine"}', "mine/commands/hi.md": "say hi" }); const viaFolder = await go(["plugin", "add", join(folder, "mine")], proj, env); expect(viaFolder.out).toContain("Added plugin mine");
    expect((await go(["plugin", "remove", "docs-writer"], proj, env)).out).toContain("Removed"); expect((await go(["--help"], proj, env)).out).toContain("syok plugin browse");
  } finally { s.server.stop(true); ai.stop(true); }
}, 90000);
test("whole program: syok -p \"/name ...\" runs one of your own commands, as in the chat", async () => {
  const home = tmpProject({}); const proj = tmpProject({ ".syok/commands/shout.md": "---\ndescription: shouts\n---\nSay this loudly: $ARGUMENTS\nThen finish." }); let task = "";
  const ai = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { const b: any = await req.json(); const u = b.messages.find((m: any) => m.role === "user"); task = typeof u.content === "string" ? u.content : JSON.stringify(u.content); return Response.json({ choices: [{ message: call("finish", { summary: "done" }) }], usage: { total_tokens: 1 } }); } });
  try {
    const env = { HOME: home, USERPROFILE: home, SYOK_BASE_URL: `http://127.0.0.1:${ai.port}`, SYOK_API_KEY: "syk_test" };
    await go(["--no-confine", "--no-stream", "-p", "/shout hello there"], proj, env); expect(task).toContain("Say this loudly: hello there"); expect(task).not.toContain("/shout");
    await go(["--no-confine", "--no-stream", "-p", "/notacommand keep me"], proj, env); expect(task).toContain("/notacommand keep me"); // an unknown /word is left as the task it is
  } finally { ai.stop(true); }
}, 60000);
