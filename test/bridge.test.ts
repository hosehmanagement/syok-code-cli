import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authOk, loadState, rotate, stateFile, publicUrl, insideRoot, makeHandler, makePublic, pair, serve, validCode, tail, OUT_CAP } from "../src/bridge.ts";

const tmp = (p = "syok-br-") => mkdtempSync(join(tmpdir(), p));
const SECRET = "a".repeat(64);
const mk = (root = tmp(), env: Record<string, string | undefined> = { CODESPACE_NAME: "happy-cs-abc" }) => makeHandler({ secret: () => SECRET, root, env });
const req = (path: string, init: RequestInit = {}, secret: string | null = SECRET) =>
  new Request("http://bridge" + path, { ...init, headers: { ...(secret ? { Authorization: "Bearer " + secret } : {}), "Content-Type": "application/json", ...(init.headers as object) } });
const exec = (h: ReturnType<typeof mk>, body: unknown) => h(req("/exec", { method: "POST", body: JSON.stringify(body) }));
// Small script files instead of node -e "...": the same command works in bash, PowerShell and cmd.
const withScripts = () => { const d = tmp(); writeFileSync(join(d, "long.js"), "setTimeout(()=>{},60000)"); writeFileSync(join(d, "big.js"), "console.log('x'.repeat(50000))"); return d; };

test("the secret is checked exactly, in constant time", () => {
  expect(authOk("Bearer " + SECRET, SECRET)).toBe(true);
  expect(authOk("Bearer " + "b".repeat(64), SECRET)).toBe(false);
  expect(authOk("Bearer short", SECRET)).toBe(false);
  expect(authOk(SECRET, SECRET)).toBe(false);
  expect(authOk(null, SECRET)).toBe(false);
  expect(authOk("Bearer ", SECRET)).toBe(false);
});

test("the secret is made once, kept across restarts, and can be replaced", () => {
  const h = tmp();
  const a = loadState(h);
  expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(loadState(h).secret).toBe(a.secret);
  expect(existsSync(stateFile(h))).toBe(true);
  const b = rotate(h);
  expect(b.secret).not.toBe(a.secret);
  expect(loadState(h).secret).toBe(b.secret);
});

test("a damaged secret file is replaced, not trusted", () => {
  const h = tmp(); loadState(h);
  writeFileSync(stateFile(h), '{"secret":"weak"}');
  expect(loadState(h).secret).toMatch(/^[0-9a-f]{64}$/);
});

test("the public address of a Codespace port", () => {
  expect(publicUrl({ CODESPACE_NAME: "happy-cs-abc" })).toBe("https://happy-cs-abc-8787.app.github.dev");
  expect(publicUrl({ CODESPACE_NAME: "x", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "preview.app.github.dev" }, 9000)).toBe("https://x-9000.preview.app.github.dev");
  expect(publicUrl({ SYOK_BRIDGE_URL: "https://my.box/" })).toBe("https://my.box");
  expect(publicUrl({})).toBe("");
});

test("commands cannot leave the project folder", () => {
  const r = tmp();
  expect(insideRoot(r, undefined)).toBe(r);
  expect(insideRoot(r, "src")).toBe(join(r, "src"));
  expect(insideRoot(r, "../elsewhere")).toBeNull();
  expect(insideRoot(r, "src/../../x")).toBeNull();
  expect(insideRoot(r, process.platform === "win32" ? "C:\\Windows" : "/etc")).toBeNull();
  expect(insideRoot(r, 5)).toBe(r);
});

test("no secret or the wrong secret: refused, nothing is revealed", async () => {
  const h = mk();
  const a = await h(req("/ping", {}, null)); expect(a.status).toBe(401); expect(await a.text()).toBe("no");
  expect((await h(req("/ping", {}, "b".repeat(64)))).status).toBe(401);
  expect((await h(req("/nothing", {}, "bad"))).status).toBe(401);
  expect((await h(req("/exec", { method: "POST", body: '{"command":"echo hi"}' }, "bad"))).status).toBe(401);
});

test("ping tells who answered", async () => {
  const j = await (await mk()(req("/ping"))).json() as any;
  expect(j.ok).toBe(true); expect(j.name).toBe("happy-cs-abc"); expect(j.version).toMatch(/^\d+\.\d+\.\d+$/); expect(String(j.shell).length).toBeGreaterThan(0);
});

test("unknown addresses and wrong methods are not found", async () => {
  const h = mk();
  expect((await h(req("/nothing"))).status).toBe(404);
  expect((await h(req("/exec"))).status).toBe(404);
});

test("exec runs a command and gives back the output and the exit code", async () => {
  const h = mk();
  const ok = await (await exec(h, { command: "echo hello-bridge" })).json() as any;
  expect(ok.exitCode).toBe(0); expect(ok.output).toContain("hello-bridge"); expect(ok.timedOut).toBe(false);
  const bad = await (await exec(h, { command: "exit 3" })).json() as any;
  expect(bad.exitCode).toBe(3);
});

test("exec runs in the folder asked for, inside the root", async () => {
  const root = tmp(); const sub = join(root, "sub"); await Bun.write(join(sub, "marker.txt"), "x");
  await Bun.write(join(sub, "list.js"), "console.log(require('fs').readdirSync('.').join(' '))");
  const h = mk(root);
  const j = await (await exec(h, { command: "node list.js", cwd: "sub" })).json() as any;
  expect(j.output).toContain("marker.txt");
  const out = await exec(h, { command: "echo hi", cwd: "../.." });
  expect(out.status).toBe(400); expect(((await out.json()) as any).error).toBe("bad_folder");
});

test("bad requests get clear errors", async () => {
  const h = mk();
  expect(((await (await exec(h, {})).json()) as any).error).toBe("no_command");
  expect(((await (await exec(h, { command: "x".repeat(4001) })).json()) as any).error).toBe("command_too_long");
  const r = await h(req("/exec", { method: "POST", body: "not json" })); expect(r.status).toBe(400);
  const big = await h(req("/exec", { method: "POST", body: JSON.stringify({ command: "echo", pad: "y".repeat(100_001) }) })); expect(big.status).toBe(413);
});

test("a command that runs too long is stopped and says so", async () => {
  const d = withScripts(); const h = mk(d);
  const t0 = Date.now();
  const j = await (await exec(h, { command: "node long.js", timeout: 1 })).json() as any;
  expect(j.timedOut).toBe(true); expect(j.exitCode).toBe(124); expect(j.output).toContain("Timed out");
  expect(Date.now() - t0).toBeLessThan(15_000);
});

test("long output is cut to the last part", async () => {
  const d = withScripts(); const h = mk(d);
  const j = await (await exec(h, { command: "node big.js" })).json() as any;
  expect(j.output.length).toBeLessThan(OUT_CAP + 200); expect(j.output).toContain("cut");
  expect(tail("abc", 10)).toBe("abc");
});

test("only two commands run at once; the third is told to wait", async () => {
  const d = withScripts(); const h = mk(d);
  const a = exec(h, { command: "node long.js", timeout: 3 }), b = exec(h, { command: "node long.js", timeout: 3 });
  await new Promise((r) => setTimeout(r, 400));
  const c = await exec(h, { command: "echo hi" });
  expect(c.status).toBe(429);
  await Promise.all([a, b]);
  expect((await exec(h, { command: "echo again" })).status).toBe(200);
});

test("a real server answers on a real port", async () => {
  const s = serve({ secret: () => SECRET, root: tmp(), port: 0 });
  try {
    const ok = await fetch(`http://127.0.0.1:${s.port}/ping`, { headers: { Authorization: "Bearer " + SECRET } });
    expect(ok.status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${s.port}/ping`)).status).toBe(401);
  } finally { s.stop(true); }
});

test("pairing codes: only a sensible shape is accepted", () => {
  expect(validCode("ABCD-1234")).toBe(true); expect(validCode("abc")).toBe(false); expect(validCode("A B C D E F")).toBe(false); expect(validCode("x".repeat(30))).toBe(false);
});

test("pairing sends the address and the secret once, and remembers it", async () => {
  const h = tmp(); let got: any = null, url = "";
  const f = (async (u: any, init: any) => { url = String(u); got = JSON.parse(init.body); return new Response("{}", { status: 200 }); }) as any;
  const r = await pair("abcd-1234", "https://syok.example/", { home: h, env: { CODESPACE_NAME: "happy-cs-abc" }, fetchImpl: f });
  expect(r.ok).toBe(true);
  expect(url).toBe("https://syok.example/v1/codespace/register");
  expect(got.code).toBe("ABCD-1234"); expect(got.url).toBe("https://happy-cs-abc-8787.app.github.dev"); expect(got.name).toBe("happy-cs-abc");
  expect(got.secret).toBe(loadState(h).secret);
  expect(loadState(h).pairedAt).toBeGreaterThan(0);
});

test("pairing failures say what to do and do not mark it paired", async () => {
  const h = tmp(); const env = { CODESPACE_NAME: "c" };
  let called = 0;
  const mkf = (status: number) => (async () => { called++; return new Response("{}", { status }); }) as any;
  expect((await pair("bad", "https://s", { home: h, env, fetchImpl: mkf(200) })).message).toContain("pairing code");
  expect(called).toBe(0);
  expect((await pair("ABCD-1234", "", { home: h, env, fetchImpl: mkf(200) })).message).toContain("SYOK_BASE_URL");
  expect((await pair("ABCD-1234", "https://s", { home: h, env: {}, fetchImpl: mkf(200) })).message).toContain("Codespace");
  expect((await pair("ABCD-1234", "https://s", { home: h, env, fetchImpl: mkf(404) })).message).toContain("expired");
  expect((await pair("ABCD-1234", "https://s", { home: h, env, fetchImpl: mkf(429) })).message).toContain("Too many");
  expect((await pair("ABCD-1234", "https://s", { home: h, env, fetchImpl: mkf(500) })).ok).toBe(false);
  const boom = (async () => { throw new Error("offline"); }) as any;
  expect((await pair("ABCD-1234", "https://s", { home: h, env, fetchImpl: boom })).message).toContain("offline");
  expect(loadState(h).pairedAt).toBeUndefined();
});

test("making the port public: not in a Codespace, success, and failure", () => {
  expect(makePublic(8787, {})).toContain("nothing to change");
  const seen: string[][] = [];
  const okRun = ((_c: string, a: string[]) => { seen.push(a); return { status: 0, stderr: "" }; }) as any;
  expect(makePublic(8787, { CODESPACE_NAME: "cs1" }, okRun)).toContain("public");
  expect(seen[0]).toEqual(["codespace", "ports", "visibility", "8787:public", "-c", "cs1"]);
  const failRun = (() => ({ status: 1, stderr: "denied by policy" })) as any;
  const m = makePublic(8787, { CODESPACE_NAME: "cs1" }, failRun);
  expect(m).toContain("could not"); expect(m).toContain("denied by policy"); expect(m).toContain("Port Visibility");
  const noGh = (() => ({ status: null, error: new Error("ENOENT"), stderr: "" })) as any;
  expect(makePublic(8787, { CODESPACE_NAME: "cs1" }, noGh)).toContain("could not");
});

test("the secret file is not world readable", () => {
  if (process.platform === "win32") return;
  const h = tmp(); loadState(h);
  const mode = require("node:fs").statSync(stateFile(h)).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(readFileSync(stateFile(h), "utf8")).toContain("secret");
});
