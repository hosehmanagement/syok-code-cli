// syok doctor: every check, with a stand-in Syok server. The key must never appear in the output.
import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctor, describeDoctor, addressProblem, keyShape } from "../src/doctor.ts";
import { tmpProject } from "./helpers.ts";

const KEY = "syk_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
type Mode = "good" | "badkey" | "notsyok" | "noai" | "empty" | "down500";
function server(mode: Mode) {
  const seen: { path: string; auth: string | null; body?: any }[] = [];
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const u = new URL(req.url); const auth = req.headers.get("authorization"); let body: any; if (req.method === "POST") body = await req.json();
    seen.push({ path: u.pathname, auth, body });
    if (mode === "down500") return new Response("oops", { status: 500 });
    if (mode === "badkey" || auth !== "Bearer " + KEY) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    if (u.pathname === "/v1/models") return mode === "notsyok" ? new Response("<html>hello</html>") : Response.json({ data: [{ id: "syok-coder" }, { id: "syok-auto" }] });
    if (u.pathname === "/v1/chat/completions") {
      if (mode === "noai") return new Response(JSON.stringify({ error: { message: "All of your provider keys are at their limit" } }), { status: 429 });
      return Response.json({ choices: [{ message: { role: "assistant", content: mode === "empty" ? "" : "OK" } }] }, { headers: { "x-syok-provider": "groq", "x-syok-model": "llama-x" } });
    }
    return new Response("not found", { status: 404 });
  } });
  return { base: `http://127.0.0.1:${s.port}`, seen, stop: () => s.stop(true) };
}
const all = () => true, none = () => false;
const by = (r: { lines: any[] }, name: string) => r.lines.find((l) => l.name === name);

test("address and key are judged by shape, and the key is never echoed", () => {
  expect(addressProblem("")).toContain("no address"); expect(addressProblem("syok.example")).toContain("not a web address");
  expect(addressProblem("http://example.com")).toContain("https://"); expect(addressProblem("https://u:p@example.com")).toContain("name or password");
  expect(addressProblem("https://example.com")).toBe(""); expect(addressProblem("http://127.0.0.1:8787")).toBe(""); expect(addressProblem("http://localhost:1")).toBe("");
  expect(keyShape("")).toEqual({ ok: false, text: "no key is set" });
  const good = keyShape(KEY); expect(good.ok).toBe(true); expect(good.text).toBe("28 characters, starts with syk_"); expect(good.text).not.toContain(KEY.slice(4));
  const bad = keyShape("sk-abc"); expect(bad.ok).toBe(false); expect(bad.text).toContain("does NOT start with syk_");
  expect(keyShape(KEY + "\n").ok).toBe(false); expect(keyShape(KEY + "\n").text).toContain("space or line break");
});

test("all good: every line OK, a real question was asked with the key, and the provider is named", async () => {
  const s = server("good"); const d = tmpProject({ ".syok/settings.json": "{}" }); mkdirSync(join(d, ".git"));
  try {
    const r = await doctor({ base: s.base + "/", key: KEY, root: d, has: all, platform: "linux" });
    expect(r.ok).toBe(true); expect(r.lines.every((l) => l.level === "ok")).toBe(true);
    expect(by(r, "Reach Syok").detail).toContain("2 models listed");
    expect(by(r, "AI answer").detail).toContain('"OK"'); expect(by(r, "AI answer").detail).toContain("answered by groq (llama-x) for model syok-coder");
    expect(s.seen.map((x) => x.path)).toEqual(["/v1/models", "/v1/chat/completions"]); expect(s.seen.every((x) => x.auth === "Bearer " + KEY)).toBe(true);
    expect(s.seen[1].body.model).toBe("syok-coder");
    const text = describeDoctor(r); expect(text).toContain("Everything is fine."); expect(text).not.toContain(KEY); expect(JSON.stringify(r)).not.toContain(KEY);
    expect(by(r, "bubblewrap").level).toBe("ok"); expect(by(r, "sandbox-exec")).toBeUndefined();
  } finally { s.stop(); }
});

test("each thing that can be wrong is named, with what to do", async () => {
  const d = tmpProject({});
  // nothing set
  let r = await doctor({ base: "", key: "", root: d, has: none, platform: "win32" });
  expect(r.ok).toBe(false); expect(by(r, "Syok address").level).toBe("fail"); expect(by(r, "Syok key").level).toBe("fail"); expect(by(r, "Syok key").fix).toContain("SYOK_API_KEY");
  expect(by(r, "Reach Syok").level).toBe("warn"); expect(by(r, "git").level).toBe("warn"); expect(by(r, "bubblewrap")).toBeUndefined();
  expect(describeDoctor(r)).toContain("2 problems to fix.");
  // refused key
  let s = server("badkey"); try { r = await doctor({ base: s.base, key: KEY, root: d, has: all }); expect(r.ok).toBe(false); expect(by(r, "Reach Syok").detail).toContain("refused the key (401)"); expect(by(r, "AI answer")).toBeUndefined(); expect(s.seen.length).toBe(1); } finally { s.stop(); }
  // an address that is not Syok
  s = server("notsyok"); try { r = await doctor({ base: s.base, key: KEY, root: d, has: all }); expect(by(r, "Reach Syok").detail).toContain("not like Syok"); expect(r.ok).toBe(false); } finally { s.stop(); }
  s = server("down500"); try { r = await doctor({ base: s.base, key: KEY, root: d, has: all }); expect(by(r, "Reach Syok").detail).toContain("error 500"); } finally { s.stop(); }
  // Syok reached, but no AI answers
  s = server("noai"); try { r = await doctor({ base: s.base, key: KEY, root: d, has: all }); expect(by(r, "Reach Syok").level).toBe("ok"); expect(by(r, "AI answer").level).toBe("fail"); expect(by(r, "AI answer").detail).toContain("error 429"); expect(by(r, "AI answer").detail).toContain("provider keys are at their limit"); } finally { s.stop(); }
  s = server("empty"); try { r = await doctor({ base: s.base, key: KEY, root: d, has: all }); expect(by(r, "AI answer").detail).toBe("the answer was empty"); expect(r.ok).toBe(false); } finally { s.stop(); }
  // nothing listening
  r = await doctor({ base: "http://127.0.0.1:9", key: KEY, root: d, has: all }); expect(by(r, "Reach Syok").level).toBe("fail"); expect(by(r, "Reach Syok").fix).toContain("internet");
  // a server that never answers
  const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise(() => {}) });
  try { r = await doctor({ base: `http://127.0.0.1:${slow.port}`, key: KEY, root: d, has: all, timeoutMs: 300 }); expect(by(r, "Reach Syok").detail).toContain("no answer within"); } finally { slow.stop(true); }
});

test("a key with the wrong start is a note, not a stop; a broken settings file is a problem; Mac names its own confinement tool", async () => {
  const s = server("good"); const d = tmpProject({ ".syok/settings.json": "{ not json" });
  try {
    const r = await doctor({ base: s.base, key: KEY, root: d, has: (p) => p !== "gh", platform: "darwin" });
    expect(by(r, "Project settings").level).toBe("fail"); expect(r.ok).toBe(false);
    expect(by(r, "gh (GitHub program)").level).toBe("warn"); expect(by(r, "sandbox-exec").level).toBe("ok"); expect(by(r, "bubblewrap")).toBeUndefined();
    expect(by(r, "Project folder").level).toBe("warn");
  } finally { s.stop(); }
  const r2 = await doctor({ base: "https://example.invalid", key: "sk-wrongkind", root: tmpProject({ ".syok/settings.json": "[1]" }), has: all, fetchImpl: (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as any });
  expect(by(r2, "Syok key").level).toBe("warn"); expect(by(r2, "Reach Syok").detail).toContain("ENOTFOUND"); expect(by(r2, "Project settings").detail).toContain("not a settings object");
});

test("version check: same checksum is up to date, a different one points to syok update, an unreachable site is only a note", async () => {
  const d = tmpProject({}); const self = join(d, "syok.js"); writeFileSync(self, "console.log(1)");
  const { sha256 } = await import("../src/update.ts"); const mine = sha256("console.log(1)");
  const site = (sum: string | null) => (async (url: any) => String(url).endsWith(".sha256") ? (sum === null ? new Response("no", { status: 404 }) : new Response(sum + "  syok.js\n")) : new Response("x", { status: 404 })) as any;
  let r = await doctor({ base: "", key: "", root: d, has: all, self, fetchImpl: site(mine) }); expect(by(r, "Version").detail).toBe("up to date");
  r = await doctor({ base: "", key: "", root: d, has: all, self, fetchImpl: site("f".repeat(64)) }); expect(by(r, "Version").fix).toBe("Run: syok update"); expect(by(r, "Version").level).toBe("warn");
  r = await doctor({ base: "", key: "", root: d, has: all, self, fetchImpl: site(null) }); expect(by(r, "Version").detail).toContain("could not check");
  r = await doctor({ base: "", key: "", root: d, has: all, self: join(d, "main.ts") }); expect(by(r, "Version")).toBeUndefined();
});

test("the real command: exit code 0 when fine, 1 with a problem, works with no key at all, --json is JSON, key never printed", async () => {
  const s = server("good"); const d = tmpProject({}); const main = join(import.meta.dir, "..", "src", "main.ts");
  // not spawnSync: the stand-in server lives in this process and must be able to answer while the command runs
  const run = (args: string[], env: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => { const p = spawn("bun", [main, ...args, "--cwd", d], { env: { PATH: process.env.PATH || "", HOME: d, USERPROFILE: d, ...env }, stdio: ["ignore", "pipe", "pipe"] }); let o = "", e = ""; p.stdout.on("data", (x) => (o += x)); p.stderr.on("data", (x) => (e += x)); p.on("exit", (c) => res({ status: c, stdout: o, stderr: e })); });
  try {
    const good = { SYOK_BASE_URL: s.base, SYOK_API_KEY: KEY };
    const a = await run(["doctor"], good); expect(a.stdout).toContain("OK    AI answer"); expect(a.status).toBe(0); expect(a.stdout + a.stderr).not.toContain(KEY);
    const b = await run(["doctor"], {}); expect(b.status).toBe(1); expect(b.stdout).toContain("FAIL  Syok address: no address is set"); expect(b.stdout).toContain("SYOK_BASE_URL");
    const c = await run(["doctor", "--json"], good); const j = JSON.parse(c.stdout); expect(j.ok).toBe(true); expect(Array.isArray(j.lines)).toBe(true); expect(c.stdout).not.toContain(KEY);
    const e = await run(["-p", "x"], {}); expect(e.status).toBe(2); expect(e.stderr).toContain("syok doctor");
  } finally { s.stop(); }
}, 60000);
