import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpProject, call } from "./helpers.ts";
import { makeLine, recordCall, readUsage, groupBy, costOf, describeHistory, usageLogOn, setUsageContext, usageDir } from "../src/usage.ts";

const main = join(import.meta.dir, "..", "src", "main.ts");

test("one line per call: token counts and who answered, never the text", () => {
  setUsageContext({ session: "s1", project: "/work/shop", on: true });
  const l = makeLine({ prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 30 } }, { provider: "claude", model: "claude-sonnet-5" }, "syok-coder", new Date("2026-11-19T02:00:00Z"));
  expect(l).toEqual({ v: 1, ts: "2026-11-19T02:00:00.000Z", session: "s1", project: "/work/shop", client: "syok-code", requested: "syok-coder", provider: "claude", model: "claude-sonnet-5", input: 1200, output: 80, cache_read: 1000, reasoning: 30, total: 1280 });
  // Anthropic-style cache field, and missing or broken numbers become 0 rather than NaN
  expect(makeLine({ prompt_tokens: "7", completion_tokens: -3, cache_read_input_tokens: 5 }, undefined, "x").cache_read).toBe(5);
  expect(makeLine({ prompt_tokens: "7", completion_tokens: -3 }, undefined, "x")).toMatchObject({ input: 7, output: 0, total: 7, provider: "", model: "" });
});

test("writing: one file per month, appended; nothing written when switched off, empty, or inside the test runner by default", () => {
  const dir = tmpProject({}); const env = { SYOK_USAGE_DIR: dir, NODE_ENV: "test" };
  setUsageContext({ session: "a", project: "/p", on: true });
  recordCall({ prompt_tokens: 10, completion_tokens: 2 }, { provider: "gemini", model: "g" }, "m", { dir, env, now: new Date("2026-10-31T23:00:00Z") });
  recordCall({ prompt_tokens: 20, completion_tokens: 4 }, { provider: "gemini", model: "g" }, "m", { dir, env, now: new Date("2026-11-01T01:00:00Z") });
  recordCall({ prompt_tokens: 30, completion_tokens: 6 }, { provider: "grok", model: "x" }, "m", { dir, env, now: new Date("2026-11-02T01:00:00Z") });
  expect(readdirSync(dir).sort()).toEqual(["2026-10.jsonl", "2026-11.jsonl"]);
  expect(readFileSync(join(dir, "2026-11.jsonl"), "utf8").trim().split("\n").length).toBe(2);
  expect(recordCall({ prompt_tokens: 0, completion_tokens: 0 }, null, "m", { dir, env })).toBeNull(); // an empty reply is not a call worth a line
  expect(recordCall(undefined, null, "m", { dir, env })).toBeNull();
  expect(recordCall({ prompt_tokens: 5 }, null, "m", { dir, env: { ...env, SYOK_USAGE_LOG: "0" } })).toBeNull();
  setUsageContext({ on: false }); expect(recordCall({ prompt_tokens: 5 }, null, "m", { dir, env })).toBeNull(); setUsageContext({ on: true });
  expect(usageLogOn({ NODE_ENV: "test" })).toBe(false); // the test runner never writes into the real home folder
  expect(usageLogOn({})).toBe(true);
  expect(usageDir("/h", {})).toBe(join("/h", ".syok", "usage")); expect(usageDir("/h", { SYOK_USAGE_DIR: "/x" })).toBe("/x");
  expect(readFileSync(join(dir, "2026-11.jsonl"), "utf8").trim().split("\n").length).toBe(2);
});

test("a folder that cannot be written does not stop the work", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return; // root and Windows ignore the read-only bit
  const base = tmpProject({}); const dir = join(base, "ro"); mkdirSync(dir); chmodSync(dir, 0o500);
  try { expect(recordCall({ prompt_tokens: 5 }, null, "m", { dir, env: { SYOK_USAGE_DIR: dir } })).toBeNull(); } finally { chmodSync(dir, 0o700); }
});

test("reading: the time window, broken lines skipped, older months not opened", () => {
  const dir = tmpProject({
    "2026-09.jsonl": JSON.stringify({ v: 1, ts: "2026-09-01T00:00:00Z", input: 999, output: 0, total: 999 }) + "\n",
    "2026-11.jsonl": [
      JSON.stringify({ v: 1, ts: "2026-11-02T00:00:00.000Z", session: "a", project: "/p/shop", provider: "claude", model: "s", requested: "syok-coder", input: 100, output: 10, cache_read: 50, total: 110 }),
      "{not json", "", JSON.stringify({ v: 2, ts: "2026-11-03T00:00:00.000Z", input: 5 }),
      JSON.stringify({ v: 1, ts: "2026-11-18T00:00:00.000Z", session: "b", project: "/p/blog", provider: "", model: "", requested: "syok-fast", input: 40, output: 4, cache_read: 0, total: 44 }),
      JSON.stringify({ v: 1, ts: "2026-11-18T05:00:00.000Z", session: "b", project: "/p/blog", provider: "claude", model: "s", requested: "syok-coder", input: 60, output: 6, cache_read: 0, total: 66 }),
    ].join("\n") + "\n",
    "notes.txt": "ignored",
  });
  const now = new Date("2026-11-19T00:00:00Z");
  expect(readUsage({ dir, days: 30, now }).length).toBe(3);
  expect(readUsage({ dir, days: 7, now }).length).toBe(2);
  expect(readUsage({ dir, days: 0, now }).length).toBe(4);
  expect(readUsage({ dir: join(dir, "missing") })).toEqual([]);
  const lines = readUsage({ dir, days: 30, now });
  expect(groupBy(lines, "day").map((g) => g.key)).toEqual(["2026-11-18", "2026-11-02"]); // newest first
  expect(groupBy(lines, "day")[0]).toMatchObject({ calls: 2, input: 100, output: 10, sessions: 1 });
  const m = groupBy(lines, "model"); expect(m[0]).toMatchObject({ key: "claude / s", calls: 2, input: 160 }); expect(m[1].key).toBe("syok-fast"); // no route: the asked-for model
  expect(new Set(groupBy(lines, "project").map((g) => g.key))).toEqual(new Set(["/p/shop", "/p/blog"]));
  expect(costOf(lines, undefined)).toBeNull();
  expect(costOf(lines, { claude: { in: 3, out: 15 } })).toBeCloseTo((160 * 3 + 16 * 15) / 1e6, 10);
  const text = describeHistory(lines, { days: 30, dir, prices: undefined });
  expect(text).toContain("3 AI calls in 2 chats"); expect(text).toContain("200 tokens in (50 of them from cache)"); expect(text).toContain("By day:"); expect(text).toContain("2026-11-18");
  expect(text).toContain("By provider and model"); expect(text).toContain("By project:"); expect(text).toContain("shop"); expect(text).not.toContain("/p/shop");
  expect(text).toContain('under "prices"');
  expect(describeHistory(lines, { days: 30, dir, by: "model", prices: { claude: { in: 3, out: 15 } } })).not.toContain("By day:");
  expect(describeHistory([], { days: 7, dir })).toContain("No AI use recorded for the last 7 days");
});

const go = (args: string[], cwd: string, env: Record<string, string>) => new Promise<{ code: number | null; out: string; err: string }>((res) => { const e: any = { ...process.env, ...env }; const p = spawn("bun", [main, ...args], { cwd, env: e, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => res({ code, out, err })); });

test("whole program: a real task leaves lines that syok usage then adds up; the text of the chat is not in them", async () => {
  const home = tmpProject({}); const proj = tmpProject({ "a.txt": "hello" }); const dir = join(home, "usage-here"); let n = 0;
  const ai = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    n++; const msg = n === 1 ? call("read_file", { path: "a.txt" }) : call("finish", { summary: "done" });
    return Response.json({ choices: [{ message: msg }], usage: { prompt_tokens: 1000 * n, completion_tokens: 10 * n, total_tokens: 1010 * n } }, { headers: { "x-syok-provider": n === 1 ? "gemini" : "claude", "x-syok-model": n === 1 ? "gemini-3-flash" : "claude-sonnet-5" } });
  } });
  try {
    const env = { HOME: home, USERPROFILE: home, SYOK_USAGE_DIR: dir, SYOK_BASE_URL: `http://127.0.0.1:${ai.port}`, SYOK_API_KEY: "syk_test" };
    const r = await go(["--no-confine", "--no-stream", "--no-checks", "--mode", "auto", "-p", "read a.txt SECRET-WORDS-123"], proj, env);
    expect(r.code).toBe(0);
    const files = readdirSync(dir); expect(files.length).toBe(1);
    const raw = readFileSync(join(dir, files[0]), "utf8"); const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(2); expect(new Set(lines.map((l) => l.session)).size).toBe(1); expect(lines[0].session).toMatch(/^\d{14}-/);
    expect(lines[0]).toMatchObject({ provider: "gemini", model: "gemini-3-flash", input: 1000, output: 10, requested: "syok-coder", client: "syok-code" });
    expect(lines[0].project.endsWith(proj.split(/[\\/]/).pop()!)).toBe(true);
    expect(raw).not.toContain("SECRET-WORDS-123"); expect(raw).not.toContain("hello");
    // the session saved in the project and the lines share the chat id
    const saved = readdirSync(join(proj, ".syok", "sessions"))[0]; expect(saved.replace(/\.json$/, "")).toBe(lines[0].session);
    const u = await go(["usage", "--json"], proj, env); const j = JSON.parse(u.out);
    expect(j.calls).toBe(2); expect(j.by_model.map((g: any) => g.key)).toEqual(["claude / claude-sonnet-5", "gemini / gemini-3-flash"]);
    const t = await go(["usage"], proj, env); expect(t.out).toContain("2 AI calls in 1 chat,"); expect(t.out).toContain("3.0k tokens in");
    expect((await go(["usage", "--by", "weekday"], proj, env)).code).toBe(2);
    // switched off in personal settings: nothing more is written
    mkdirSync(join(home, ".syok"), { recursive: true }); writeFileSync(join(home, ".syok", "config.json"), JSON.stringify({ usage_log: false }));
    n = 0; await go(["--no-confine", "--no-stream", "--no-checks", "--mode", "auto", "-p", "again"], proj, env);
    expect(readFileSync(join(dir, files[0]), "utf8").trim().split("\n").length).toBe(2);
  } finally { ai.stop(true); }
}, 90000);
