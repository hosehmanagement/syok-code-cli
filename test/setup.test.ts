// "syok setup": the questions, what is saved, who wins afterwards, and that the key is never shown.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpProject } from "./helpers.ts";
import { cleanDefaults, applyDefaults, runSetup, describeDefaults, readConfig, resetDefaults, configFile, type SetupIO } from "../src/setup.ts";

const KEY = "syk_setuptest_0123456789abcdef";
/** Scripted answers; records everything that was shown. After the script ends it answers like a closed input. */
function scripted(answers: string[]) {
  const shown: string[] = []; const asked: Array<{ q: string; secret: boolean }> = []; let i = 0;
  const io: SetupIO = { async ask(q, o = {}) { asked.push({ q, secret: !!o.secret }); shown.push(q); return i < answers.length ? answers[i++] : ""; }, say: (t) => { shown.push(t); }, ended: () => i >= answers.length };
  return { io, shown, asked, text: () => shown.join("\n") };
}

test("only choices this program understands are kept", () => {
  expect(cleanDefaults({ mode: "auto", model: "syok-auto", web: false, confine: "no-network", checks: false, parallel_workers: 2, memory: true })).toEqual({ mode: "auto", model: "syok-auto", web: false, confine: "no-network", checks: false, parallel_workers: 2, memory: true });
  expect(cleanDefaults({ mode: "yolo", model: "a b; rm -rf", web: "no", confine: "maybe", checks: 0, extra: 1 })).toEqual({});
  expect(cleanDefaults(null)).toEqual({}); expect(cleanDefaults([1])).toEqual({}); expect(cleanDefaults("x")).toEqual({});
});

test("a project's settings win over personal choices, but cannot loosen confinement or switch web back on", () => {
  expect(applyDefaults({}, { web: false, confine: true, checks: false, parallel_workers: 2, memory: true })).toEqual({ web: false, confine: true, checks: false, parallel_workers: 2 }); // memory "on" is the default already; only "off" is carried over
  expect(applyDefaults({ checks: true, parallel_workers: 2, memory: true }, { checks: false, parallel_workers: 2, memory: true }).checks).toBe(true);
  expect(applyDefaults({ checks: false, parallel_workers: 2, memory: true }, { checks: true, parallel_workers: 2, memory: true }).checks).toBe(false);
  expect(applyDefaults({ confine: false }, { confine: true }).confine).toBe(true);
  expect(applyDefaults({ confine: true }, { confine: "no-network" }).confine).toBe("no-network");
  expect(applyDefaults({ confine: "no-network" }, { confine: true }).confine).toBe("no-network");
  expect(applyDefaults({ confine: true }, { confine: false }).confine).toBe(true);
  expect(applyDefaults({ web: true }, { web: false }).web).toBe(false);
  expect(applyDefaults({ web: false }, { web: true }).web).toBe(false);
  expect(applyDefaults({ allow: ["npm run"] }, {})).toEqual({ allow: ["npm run"] });
});

test("answering everything: saved as chosen, readable by the owner alone, and the key is never shown", async () => {
  const home = tmpProject({}); const s = scripted(["https://my.syok.example/", KEY, "2", "2", "n", "2", "n"]);
  const r = await runSetup({ home, root: home, io: s.io, platform: "linux", env: {}, probe: () => "" });
  expect(r.saved).toBe(true);
  const saved = JSON.parse(readFileSync(configFile(home), "utf8"));
  expect(saved).toEqual({ defaults: { mode: "accept-edits", model: "syok-auto", web: false, confine: "no-network", checks: false, parallel_workers: 2, memory: true }, base: "https://my.syok.example", key: KEY });
  if (process.platform !== "win32") expect(statSync(configFile(home)).mode & 0o777).toBe(0o600);
  expect(s.text()).not.toContain(KEY); expect(s.text()).not.toContain(KEY.slice(4, 14));
  expect(s.asked.filter((a) => a.secret).length).toBe(1); expect(s.asked.find((a) => a.secret)!.q).toMatch(/^Key/);
  expect(s.text()).toContain("it works"); expect(s.text()).toContain("starts with syk_");
  expect(describeDefaults(saved, {}, home)).not.toContain(KEY);
});

test("pressing Enter every time keeps what was there, including things setup does not know about", async () => {
  const home = tmpProject({ ".syok/config.json": JSON.stringify({ base: "https://old.example", key: KEY, other: { keep: 1 }, defaults: { mode: "plan", model: "my-own/model", web: false, confine: true, checks: false, parallel_workers: 2, memory: true } }) });
  const s = scripted(["", "", "", "", "", "", ""]);
  await runSetup({ home, root: home, io: s.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home)).toEqual({ base: "https://old.example", key: KEY, other: { keep: 1 }, defaults: { mode: "plan", model: "my-own/model", web: false, confine: true, checks: false, parallel_workers: 2, memory: true } });
  expect(s.text()).toContain("my-own/model: the one you saved"); expect(s.text()).not.toContain(KEY);
});

test("first time, Enter everywhere: the safe choices", async () => {
  const home = tmpProject({}); const s = scripted(["https://a.example", KEY]);
  await runSetup({ home, root: home, io: s.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).defaults).toEqual({ mode: "ask", model: "syok-coder", web: true, confine: true, checks: true, parallel_workers: 2, memory: true }); // confinement is on unless you say otherwise
});

test("a wrong address is asked again and never saved", async () => {
  const home = tmpProject({}); const s = scripted(["http://not-safe.example", "ftp://x", "https://user:pw@x.example"]);
  const r = await runSetup({ home, root: home, io: s.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).base).toBeUndefined(); expect(s.text()).toContain("must start with https://");
  expect(r.notes.join(" ")).toMatch(/address was not changed/); expect(r.notes.join(" ")).toMatch(/No key was given/);
  const s2 = scripted(["nonsense", "https://good.example", KEY]);
  await runSetup({ home, root: home, io: s2.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).base).toBe("https://good.example");
});

test("auto as the everyday default needs a second yes", async () => {
  const home = tmpProject({}); const no = scripted(["https://a.example", KEY, "4", ""]);
  await runSetup({ home, root: home, io: no.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).defaults!.mode).toBe("ask"); expect(no.text()).toContain("with no question to you");
  const yes = scripted(["", "", "4", "y"]);
  await runSetup({ home, root: home, io: yes.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).defaults!.mode).toBe("auto");
  const again = scripted(["", "", ""]); // already auto: Enter keeps it without asking twice
  await runSetup({ home, root: home, io: again.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).defaults!.mode).toBe("auto"); expect(again.text()).not.toContain("Make auto your everyday default");
});

test("confinement that this computer cannot do: nothing is saved for it, the reason is shown, and choosing off is saved", async () => {
  const home = tmpProject({}); const s = scripted(["https://a.example", KEY, "", "", "", "1"]);
  const r = await runSetup({ home, root: home, io: s.io, platform: "linux", env: {}, probe: () => "bubblewrap is not installed.\nInstall it with: sudo apt install bubblewrap" });
  expect("confine" in readConfig(home).defaults!).toBe(false); // not saved as on: a saved "on" that cannot work would stop every run
  expect(s.text()).toContain("bubblewrap is not installed"); expect(s.text()).toContain("carries on unconfined until it is fixed"); expect(r.notes.join(" ")).toMatch(/cannot work on this computer yet/);
  expect(s.text()).toContain("Confinement           on (the default on Linux and Mac)");
  const off = scripted(["", "", "", "", "", "3"]); let probed = false;
  await runSetup({ home, root: home, io: off.io, platform: "linux", env: {}, probe: () => { probed = true; return ""; } });
  expect(readConfig(home).defaults!.confine).toBe(false); expect(probed).toBe(false); expect(off.text()).toContain("Confinement           off");
});

test("the probe is told whether the network stays", async () => {
  const seen: boolean[] = [];
  for (const pickN of ["1", "2"]) { const home = tmpProject({}); await runSetup({ home, root: home, io: scripted(["https://a.example", KEY, "", "", "", pickN]).io, platform: "darwin", env: {}, probe: (n) => { seen.push(n); return ""; } }); }
  expect(seen).toEqual([true, false]);
});

test("on Windows the question explains write protection, is off unless you say yes, and is tried before it is saved", async () => {
  const home = tmpProject({}); let probed = 0;
  const no = scripted(["https://a.example", KEY, "", "", "", ""]);
  await runSetup({ home, root: home, io: no.io, platform: "win32", env: {}, probe: () => { probed++; return ""; } });
  expect(probed).toBe(0); expect(no.text()).toContain("write protection"); expect(no.text()).toContain("can still read your other files"); expect(no.text()).toContain("syok confine undo"); expect(no.text()).toContain("WSL");
  expect(readConfig(home).defaults).toEqual({ mode: "ask", model: "syok-coder", web: true, confine: false, checks: true, parallel_workers: 2, memory: true });
  const yes = scripted(["", "", "", "", "", "y"]);
  await runSetup({ home, root: home, io: yes.io, platform: "win32", env: {}, probe: () => { probed++; return ""; } });
  expect(probed).toBe(1); expect(readConfig(home).defaults!.confine).toBe(true); expect(yes.text()).toContain("it works");
  const cannot = scripted(["", "", "", "", "", "y"]);
  await runSetup({ home, root: home, io: cannot.io, platform: "win32", env: {}, probe: () => "Windows refused to mark the project folder" });
  expect(readConfig(home).defaults!.confine).toBe(false); expect(cannot.text()).toContain("Windows refused to mark the project folder");
});

test("a number that is not on the list, and an answer that is not y or n, are asked again", async () => {
  const home = tmpProject({}); const s = scripted(["https://a.example", KEY, "9", "abc", "3", "", "maybe", "n"]);
  await runSetup({ home, root: home, io: s.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).defaults!.mode).toBe("plan"); expect(readConfig(home).defaults!.web).toBe(false);
  expect(s.text()).toContain("Please type a number from 1 to 4."); expect(s.text()).toContain("Please answer y or n.");
});

test("environment values are pointed out, because they win over the file", async () => {
  const home = tmpProject({}); const s = scripted(["https://a.example", KEY]);
  await runSetup({ home, root: home, io: s.io, platform: "linux", env: { SYOK_BASE_URL: "https://env.example", SYOK_API_KEY: "syk_env" }, probe: () => "" });
  expect(s.text()).toContain("SYOK_BASE_URL is set on this computer"); expect(s.text()).toContain("SYOK_API_KEY is set on this computer");
  expect(s.text()).not.toContain("syk_env");
});

test("the @syok job is offered only where it applies, and written only on a yes", async () => {
  const home = tmpProject({}); let wrote = 0; const add = () => { wrote++; return { ok: true, message: "Wrote the file." }; };
  const no = scripted(["https://a.example", KEY, "", "", "", "", "", "", "", ""]);
  await runSetup({ home, root: home, io: no.io, platform: "linux", env: {}, probe: () => "", canAddJob: true, addJob: add });
  expect(wrote).toBe(0); expect(no.text()).toContain("@syok job");
  const yes = scripted(["", "", "", "", "", "", "", "", "", "y"]);
  await runSetup({ home, root: home, io: yes.io, platform: "linux", env: {}, probe: () => "", canAddJob: true, addJob: add });
  expect(wrote).toBe(1); expect(yes.text()).toContain("Wrote the file.");
  const off = scripted(["", "", "", "", "", "", "", "", "", "y"]);
  await runSetup({ home, root: home, io: off.io, platform: "linux", env: {}, probe: () => "", canAddJob: false, addJob: add });
  expect(wrote).toBe(1); expect(off.text()).not.toContain("@syok job");
});

test("the VS Code add-on is mentioned only when VS Code is there", async () => {
  const home = tmpProject({});
  const a = await runSetup({ home, root: home, io: scripted([]).io, platform: "linux", env: {}, hasProgram: (n) => n === "code" });
  const b = await runSetup({ home, root: home, io: scripted([]).io, platform: "linux", env: {}, hasProgram: () => false });
  expect(a.notes.join(" ")).toContain("syok-code.vsix"); expect(b.notes.join(" ")).not.toContain("vsix");
});

test("forgetting the choices keeps the address and the key", () => {
  const home = tmpProject({ ".syok/config.json": JSON.stringify({ base: "https://a.example", key: KEY, defaults: { mode: "auto" } }) });
  expect(resetDefaults(home)).toBe(true); expect(readConfig(home)).toEqual({ base: "https://a.example", key: KEY });
  expect(resetDefaults(home)).toBe(false); expect(resetDefaults(tmpProject({}))).toBe(false);
});

// ---- the whole program ----
const main = join(import.meta.dir, "..", "src", "main.ts");
function standIn(key: string) {
  const seen: Array<{ path: string; model?: string }> = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url); if (req.headers.get("authorization") !== "Bearer " + key) return new Response("no", { status: 401 });
    if (u.pathname === "/v1/models") { seen.push({ path: u.pathname }); return Response.json({ data: [{ id: "syok-coder" }, { id: "syok-auto" }] }); }
    if (u.pathname === "/v1/chat/completions") { const b: any = await req.json(); seen.push({ path: u.pathname, model: b.model }); return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: { total_tokens: 3 } }); }
    return new Response("?", { status: 404 });
  } });
  return { server, seen, url: `http://127.0.0.1:${server.port}` };
}
function runMain(args: string[], home: string, input: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, ...env }; if (!("SYOK_BASE_URL" in env)) delete e.SYOK_BASE_URL; if (!("SYOK_API_KEY" in env)) delete e.SYOK_API_KEY;
  return new Promise((res) => { const p = spawn("bun", [main, ...args], { cwd: home, env: e as any, stdio: ["pipe", "pipe", "pipe"] }); let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => res({ code, out, err })); p.stdin.end(input); });
}

test("whole program: setup with piped answers saves, checks for real, and never prints the key", async () => {
  const s = standIn(KEY); const home = tmpProject({});
  try {
    const r = await runMain(["setup"], home, [s.url, KEY, "1", "2", "y", "3", "y"].join("\n") + "\n");
    expect(r.err).toBe(""); expect(r.out).toContain("Saved."); expect(r.out).toContain("Ready. Start with: syok"); expect(r.code).toBe(0);
    expect(r.out).not.toContain(KEY);
    expect(readConfig(home)).toEqual({ defaults: { mode: "ask", model: "syok-auto", web: true, confine: false, checks: true, parallel_workers: 2, memory: true }, base: s.url, key: KEY });
    expect(s.seen.map((x) => x.path)).toEqual(["/v1/models", "/v1/chat/completions"]); expect(s.seen[1].model).toBe("syok-auto"); // the check used the model that was chosen

    const show = await runMain(["setup", "--show"], home, "");
    expect(show.code).toBe(0); expect(show.out).toContain("syok-auto"); expect(show.out).toContain(s.url); expect(show.out).not.toContain(KEY);

    const doc = await runMain(["doctor"], home, ""); // the health check now uses the saved model too
    expect(doc.out).toContain("for model syok-auto");

    const reset = await runMain(["setup", "--reset"], home, "");
    expect(reset.out).toContain("forgotten"); expect(readConfig(home)).toEqual({ base: s.url, key: KEY });
  } finally { s.server.stop(true); }
}, 60000);

test("whole program: a key that Syok refuses is saved but reported, with a failing exit code", async () => {
  const s = standIn("syk_the_right_one"); const home = tmpProject({});
  try {
    const r = await runMain(["setup"], home, [s.url, KEY].join("\n") + "\n");
    expect(r.code).toBe(1); expect(r.out).toContain("refused the key"); expect(r.out).toContain("something above needs fixing"); expect(r.out).not.toContain(KEY);
  } finally { s.server.stop(true); }
}, 60000);

test("whole program: with nothing set up, the message points to syok setup", () => {
  const home = tmpProject({}); const env: any = { ...process.env, HOME: home, USERPROFILE: home }; delete env.SYOK_BASE_URL; delete env.SYOK_API_KEY;
  const r = spawnSync("bun", [main, "-p", "hi"], { cwd: home, env, encoding: "utf8" });
  expect(r.status).toBe(2); expect(r.stderr).toContain("syok setup");
  const h = spawnSync("bun", [main, "--help"], { cwd: home, env, encoding: "utf8" });
  expect(h.stdout).toContain("syok setup"); expect(h.stdout).toContain("--no-confine");
});

test("whole program: a saved mode and model are used, and a flag still wins", () => {
  const home = tmpProject({ ".syok/config.json": JSON.stringify({ defaults: { mode: "not-a-mode" } }) });
  const env: any = { ...process.env, HOME: home, USERPROFILE: home, SYOK_BASE_URL: "http://127.0.0.1:9", SYOK_API_KEY: "syk_test" };
  const bad = spawnSync("bun", [main, "-p", "hi", "--mode", "nope"], { cwd: home, env, encoding: "utf8" });
  expect(bad.status).toBe(2); expect(bad.stderr).toContain("Unknown mode"); // the flag is read; the broken saved value was ignored, not fatal
});

// On a real terminal the key must not be echoed while it is typed. "script" gives the program a terminal (Linux form of the command).
test.skipIf(process.platform !== "linux" || spawnSync("script", ["--version"]).status !== 0)("real terminal: the key is not echoed while typed", async () => {
  const s = standIn(KEY); const home = tmpProject({});
  try {
    const e: any = { ...process.env, HOME: home, USERPROFILE: home, TERM: "dumb" }; delete e.SYOK_BASE_URL; delete e.SYOK_API_KEY;
    const out = await new Promise<string>((res) => { const p = spawn("script", ["-qec", `bun ${JSON.stringify(main)} setup`, "/dev/null"], { cwd: home, env: e, stdio: ["pipe", "pipe", "pipe"] }); let o = "";
      p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d)); p.on("close", () => res(o));
      const lines = [s.url, KEY, "", "", "", "", "", "", ""]; let i = 0; const t = setInterval(() => { if (i < lines.length) p.stdin.write(lines[i++] + "\r"); else { clearInterval(t); } }, 400); });
    expect(out).toContain("Saved."); expect(out).toContain(s.url); // ordinary answers are echoed, so the terminal really was one
    expect(out).not.toContain(KEY); expect(out).not.toContain(KEY.slice(0, 12));
    expect(readConfig(home).key).toBe(KEY);
  } finally { s.server.stop(true); }
}, 60000);

test("whole program: saved choices are really used in a task; a flag wins; a project cannot loosen confinement", async () => {
  const s = standIn(KEY); const bodies: any[] = [];
  const rec = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { const b: any = await req.json().catch(() => ({})); bodies.push(b); return Response.json({ choices: [{ message: { role: "assistant", content: "done" } }], usage: { total_tokens: 3 } }); } });
  const url = `http://127.0.0.1:${rec.port}`;
  try {
    const home = tmpProject({ ".syok/config.json": JSON.stringify({ base: url, key: KEY, defaults: { model: "syok-auto", web: false } }) });
    const a = await runMain(["-p", "say done", "--json", "--no-stream"], home, "");
    expect(a.code).toBe(0); expect(bodies[0].model).toBe("syok-auto");
    const names = (bodies[0].tools || []).map((t: any) => t.function.name); expect(names.length).toBeGreaterThan(3); expect(names).not.toContain("web_search"); expect(names).not.toContain("web_fetch");

    bodies.length = 0; // a project file saying "web": true does not switch it back on; the --model flag wins over the saved model
    mkdirSync(join(home, ".syok"), { recursive: true }); writeFileSync(join(home, ".syok", "settings.json"), JSON.stringify({ web: true, confine: false }));
    const b = await runMain(["-p", "say done", "--json", "--no-stream", "--model", "syok-coder"], home, "");
    expect(b.code).toBe(0); expect(bodies[0].model).toBe("syok-coder"); expect((bodies[0].tools || []).map((t: any) => t.function.name)).not.toContain("web_search");

    // Confinement saved as a personal choice: the project's "confine": false is not obeyed. Either it is confined, or the run stops and says how to go on.
    writeFileSync(join(home, ".syok", "config.json"), JSON.stringify({ base: url, key: KEY, defaults: { confine: true } }));
    bodies.length = 0; const c = await runMain(["-p", "say done", "--no-stream"], home, "");
    if (c.code === 0) expect(c.err).toMatch(/confined/i); else { expect(c.code).toBe(2); expect(c.err).toContain("add --no-confine"); expect(bodies.length).toBe(0); }
    bodies.length = 0; const d = await runMain(["-p", "say done", "--no-stream", "--no-confine"], home, "");
    expect(d.code).toBe(0); expect(d.err).not.toMatch(/confined/i); expect(bodies.length).toBe(1);
  } finally { s.server.stop(true); rec.stop(true); }
}, 120000);

test("the eighth question: how many workers; a wrong number is asked again; a project can lower your number, never raise it", async () => {
  const home = tmpProject({}); const s = scripted(["https://a.example", KEY, "", "", "", "", "", "12", "x", "4"]);
  await runSetup({ home, root: home, io: s.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).defaults!.parallel_workers).toBe(4); expect(s.text()).toContain("Please type a whole number from 0 to 8."); expect(s.text()).toContain("up to 4 at once");
  const off = scripted(["", "", "", "", "", "", "", "0"]);
  await runSetup({ home, root: home, io: off.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).defaults!.parallel_workers).toBe(0); expect(off.text()).toContain("Parallel workers      off");
  expect(applyDefaults({}, { parallel_workers: 4 }).parallel_workers).toBe(4);
  expect(applyDefaults({ parallel_workers: 8 }, { parallel_workers: 3 }).parallel_workers).toBe(3);
  expect(applyDefaults({ parallel_workers: 1 }, { parallel_workers: 3 }).parallel_workers).toBe(1);
  expect(applyDefaults({ parallel_workers: 6 }, { parallel_workers: 0 }).parallel_workers).toBe(0);
  expect(applyDefaults({ parallel_workers: 6 }, {}).parallel_workers).toBe(6);
  expect(cleanDefaults({ parallel_workers: 9 })).toEqual({}); expect(cleanDefaults({ parallel_workers: 2.5 })).toEqual({}); expect(cleanDefaults({ parallel_workers: "3" })).toEqual({});
});

test("the ninth question: memory on or off; saying off cannot be undone by a project", async () => {
  const home = tmpProject({}); const s = scripted(["https://a.example", KEY, "", "", "", "", "", "", "n"]);
  await runSetup({ home, root: home, io: s.io, platform: "linux", env: {}, probe: () => "" });
  expect(readConfig(home).defaults!.memory).toBe(false); expect(s.text()).toContain("9 of 9. Memory across chats"); expect(s.text()).toContain("Memory across chats   off"); expect(s.text()).toContain("Keys and passwords are never saved");
  expect(applyDefaults({ memory: true }, { memory: false }).memory).toBe(false); expect(applyDefaults({}, { memory: false }).memory).toBe(false);
  expect(applyDefaults({ memory: false }, { memory: true }).memory).toBe(false); expect(applyDefaults({}, { memory: true }).memory).toBeUndefined();
  expect(cleanDefaults({ memory: "yes" })).toEqual({});
});
