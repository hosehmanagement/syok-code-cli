// "syok login": browser sign-in. A stand-in sign-in service plays the server and the person's browser
// (it locks {address, key} for the command line's public key exactly as app/clilogin.js does).
import { test, expect } from "bun:test";
import { readFileSync, statSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpProject } from "./helpers.ts";
import { login, boxKey } from "../src/login.ts";
import { runSetup, configFile, type SetupIO } from "../src/setup.ts";

const KEY = "syk_logintest_0123456789abcdef";
const BASE = "https://syok-ai-router-personal-test.me.workers.dev/v1";
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256Hex(t: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, "0")).join(""); }

/** The browser's part: lock a JSON value for the command line's public key. */
async function lockFor(pub: { x: string; y: string }, value: object) {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const epk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await boxKey(kp.privateKey, pub), new TextEncoder().encode(JSON.stringify(value))));
  return { epk: { kty: "EC", crv: "P-256", x: epk.x, y: epk.y }, iv: b64u(iv), ct: b64u(ct) };
}

/** A stand-in sign-in service. `answer` decides what happens after a few polls: approve, deny or never. */
function service(answer: "approve" | "deny" | "never" | "garbage" | "bad-key", seen: { start?: any; polls: number; bodies: string[] }) {
  let dev = ""; let pub: any = null;
  return Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url); const text = await req.text(); seen.bodies.push(text); const b = JSON.parse(text || "{}");
    if (u.pathname === "/v1/cli-login/start") { seen.start = b; dev = b.device; pub = b.pub; return Response.json({ code: "ABCD-EFGH", expiresIn: 600, interval: 1, url: "https://syok-ai.com/app/?cli_login=ABCD-EFGH" }); }
    if (u.pathname === "/v1/cli-login/poll") {
      seen.polls++;
      if ((await sha256Hex(b.secret)) !== dev) return Response.json({ status: "expired" });
      if (seen.polls < 2 || answer === "never") return Response.json({ status: "pending" });
      if (answer === "deny") return Response.json({ status: "denied" });
      if (answer === "garbage") return Response.json({ status: "approved", box: { epk: pub, iv: "AAAAAAAAAAAAAAAA", ct: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
      return Response.json({ status: "approved", box: await lockFor(pub, answer === "bad-key" ? { base: "https://syok-ai.com", key: KEY } : { base: BASE, key: KEY, keyName: "Syok Code - test-box" }) });
    }
    return new Response("no", { status: 404 });
  } });
}
const fast = async () => {};

test("signing in: the address and key arrive locked, are saved for the owner only, and never appear in anything sent or shown", async () => {
  const seen = { polls: 0, bodies: [] as string[] }; const s = service("approve", seen); const home = tmpProject({}); const said: string[] = []; const opened: string[] = [];
  try {
    const r = await login({ say: (t) => said.push(t), home, env: { SYOK_LOGIN_URL: `http://127.0.0.1:${s.port}` }, sleep: fast, open: (u) => { opened.push(u); return true; }, name: "test-box" });
    expect(r.ok).toBe(true); expect(r.base).toBe(BASE); expect(r.message).toContain('the key "Syok Code - test-box"');
    const cfg = JSON.parse(readFileSync(configFile(home), "utf8")); expect(cfg).toMatchObject({ base: BASE, key: KEY });
    if (process.platform !== "win32") expect(statSync(configFile(home)).mode & 0o777).toBe(0o600);
    expect(opened).toEqual(["https://syok-ai.com/app/?cli_login=ABCD-EFGH"]);
    const shown = said.join("\n") + r.message; expect(shown).toContain("ABCD-EFGH"); expect(shown).toContain('"test-box"'); expect(shown).not.toContain(KEY);
    // what went over the wire: the public key, a name, a fingerprint of the secret, then the secret itself only to collect
    expect(Object.keys(seen.start).sort()).toEqual(["device", "name", "pub"]); expect(seen.start.pub.d).toBeUndefined(); expect(seen.start.device).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.bodies.join("")).not.toContain(KEY);
  } finally { s.stop(true); }
});

test("deny, the code running out, a box that does not unlock, an unusable answer and no service: nothing is saved", async () => {
  for (const [answer, words] of [["deny", "refused in the browser"], ["never", "expired"], ["garbage", "could not be unlocked"], ["bad-key", "something unusable"]] as const) {
    const seen = { polls: 0, bodies: [] as string[] }; const s = service(answer, seen); const home = tmpProject({});
    try {
      const r = await login({ say: () => {}, home, env: { SYOK_LOGIN_URL: `http://127.0.0.1:${s.port}` }, sleep: fast, open: () => false, maxWaitMs: answer === "never" ? 50 : undefined });
      expect(r.ok).toBe(false); expect(r.message).toContain(words); expect(existsSync(configFile(home))).toBe(false);
    } finally { s.stop(true); }
  }
  const r = await login({ say: () => {}, home: tmpProject({}), env: { SYOK_LOGIN_URL: "http://127.0.0.1:9" }, sleep: fast, open: () => false });
  expect(r.ok).toBe(false); expect(r.message).toContain("Could not reach Syok's sign-in service"); expect(r.message).toContain("syok setup");
});

function scripted(answers: string[]) {
  const shown: string[] = []; let i = 0;
  const io: SetupIO = { async ask(q) { shown.push(q); return i < answers.length ? answers[i++] : ""; }, say: (t) => { shown.push(t); }, ended: () => i >= answers.length };
  return { io, text: () => shown.join("\n") };
}
test("setup: Enter at the address signs in through the browser and skips the key question", async () => {
  const seen = { polls: 0, bodies: [] as string[] }; const s = service("approve", seen); const home = tmpProject({});
  try {
    const sc = scripted(["", "", "", "", "", "", "", "", ""]);
    const r = await runSetup({ home, root: home, io: sc.io, platform: "linux", env: {}, probe: () => "", login: (say) => login({ say, home, env: { SYOK_LOGIN_URL: `http://127.0.0.1:${s.port}` }, sleep: fast, open: () => false, save: false }) });
    expect(r.saved).toBe(true); expect(r.config).toMatchObject({ base: BASE, key: KEY });
    const t = sc.text(); expect(t).toContain("press Enter to sign in through your browser"); expect(t).toContain("made for this computer by the browser sign-in");
    expect(t).not.toMatch(/^Key/m); expect(t).not.toContain(KEY);
  } finally { s.stop(true); }
});

test("whole program: syok login, then syok logout", async () => {
  const seen = { polls: 0, bodies: [] as string[] }; const s = service("approve", seen); const home = tmpProject({});
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const go = (args: string[]) => new Promise<{ code: number | null; out: string }>((res) => { const p = spawn("bun", [main, ...args], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, SYOK_LOGIN_URL: `http://127.0.0.1:${s.port}`, BROWSER: "true", SYOK_BASE_URL: "", SYOK_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d)); p.on("close", (code) => res({ code, out })); });
  try {
    const r = await go(["login"]);
    expect(r.code).toBe(0); expect(r.out).toContain("ABCD-EFGH"); expect(r.out).toContain("Signed in."); expect(r.out).not.toContain(KEY);
    expect(JSON.parse(readFileSync(configFile(home), "utf8"))).toMatchObject({ base: BASE, key: KEY });
    const o = await go(["logout"]); expect(o.code).toBe(0); expect(o.out).toContain("Signed out");
    const c = JSON.parse(readFileSync(configFile(home), "utf8")); expect(c.key).toBeUndefined(); expect(c.base).toBeUndefined();
    expect((await go(["logout"])).out).toContain("Not signed in");
  } finally { s.stop(true); }
}, 60000);
