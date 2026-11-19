// "syok login": sign in through the browser. No key is typed, pasted or shown.
//
// 1. This program makes a key pair and a random secret, and asks Syok's sign-in service for a short code,
//    sending only its PUBLIC key, this computer's name and a fingerprint (SHA-256) of the secret.
// 2. The person opens the link where they are signed in to Syok, checks the code, and presses Allow.
//    Their browser makes a key for this computer and sends it back locked with our public key.
// 3. We collect the locked box with the secret, unlock it here, and save the address and key like syok setup does.
// The sign-in service never sees the key in plain words; the code works once and expires after 10 minutes.
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { readConfig, writeConfig } from "./setup.ts";
import { addressProblem, keyShape } from "./doctor.ts";

export const LOGIN_SERVICE = "https://syok-ai-router.hosehmanagement.workers.dev";
const enc = new TextEncoder(), dec = new TextDecoder();
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
async function sha256Hex(text: string): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)))); }

/** The AES key both sides derive: SHA-256 of the ECDH secret and a fixed label (the same in app/clilogin.js). */
export async function boxKey(myPrivate: CryptoKey, theirPublicJwk: { x: string; y: string }): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: theirPublicJwk.x, y: theirPublicJwk.y, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub } as any, myPrivate, 256));
  const raw = await crypto.subtle.digest("SHA-256", new Uint8Array([...bits, ...enc.encode("syok-cli-login")]));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface LoginOpts {
  say: (text: string) => void;
  home: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Opens the link in a browser; returns false when there is none to open. */
  open?: (url: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Stop waiting after this long (default: the code's own 10 minutes). */
  maxWaitMs?: number;
  name?: string;
  /** Save the result into ~/.syok/config.json (default true). setup saves it itself at the end. */
  save?: boolean;
}
export interface LoginResult { ok: boolean; base?: string; key?: string; keyName?: string; message: string }

/** Opens a link where a browser can be reached: $BROWSER (set by Codespaces and many remote setups), else the system's own opener. */
export function openBrowser(url: string, env: Record<string, string | undefined> = process.env, platform = process.platform): boolean {
  try {
    const run = (cmd: string, args: string[]) => { const p = spawn(cmd, args, { stdio: "ignore", detached: true }); p.on("error", () => {}); p.unref(); return true; };
    if (env.BROWSER) return run(env.BROWSER, [url]);
    if (platform === "darwin") return run("open", [url]);
    if (platform === "win32") return run("cmd", ["/c", "start", "", url]);
    if (env.DISPLAY || env.WAYLAND_DISPLAY) return run("xdg-open", [url]);
  } catch {}
  return false;
}

export async function login(o: LoginOpts): Promise<LoginResult> {
  const env = o.env ?? process.env, f = o.fetchImpl ?? fetch, say = o.say;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const service = (env.SYOK_LOGIN_URL || LOGIN_SERVICE).replace(/\/+$/, "");
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const name = (o.name || env.CODESPACE_NAME && `Codespace ${env.CODESPACE_NAME}` || hostname() || "this computer").slice(0, 60);
  let start: any;
  try {
    const r = await f(service + "/v1/cli-login/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pub: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, name, device: await sha256Hex(secret) }) });
    start = await r.json().catch(() => ({}));
    if (!r.ok || !start.code) return { ok: false, message: `Syok's sign-in service said no (${r.status}${start?.error ? ": " + start.error : ""}). Try again in a minute, or run syok setup to type the address and key yourself.` };
  } catch (e: any) {
    return { ok: false, message: `Could not reach Syok's sign-in service (${String(e?.message || e)}). Check the internet connection, or run syok setup to type the address and key yourself.` };
  }
  const url = String(start.url || `https://syok-ai.com/app/?cli_login=${start.code}`);
  say(`To sign in, open this link where you are signed in to Syok (this or any other device):\n\n  ${url}\n\nIt shows the code ${start.code} and the name "${name}". Check that both match, then press Allow.`);
  const opened = (o.open ?? ((u: string) => openBrowser(u, env)))(url);
  say(opened ? "(Your browser should open it now. If it does not, open the link yourself.)" : "(Copy the link into a browser, or type it on your phone.)");
  say(`Waiting for you to press Allow… The code expires in ${Math.round((start.expiresIn || 600) / 60)} minutes. Ctrl+C stops.`);
  const interval = Math.max(1, Number(start.interval) || 3) * 1000;
  const until = Date.now() + Math.min(o.maxWaitMs ?? Infinity, (Number(start.expiresIn) || 600) * 1000);
  let fails = 0;
  while (Date.now() < until) {
    await sleep(interval);
    let p: any;
    try { const r = await f(service + "/v1/cli-login/poll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) }); p = await r.json(); fails = 0; }
    catch { if (++fails >= 10) return { ok: false, message: "Lost the connection to Syok's sign-in service. Run syok login again." }; continue; }
    if (p.status === "pending") continue;
    if (p.status === "denied") return { ok: false, message: "Sign-in was refused in the browser (Deny was pressed). Nothing was saved." };
    if (p.status !== "approved") return { ok: false, message: "The sign-in code expired. Run syok login again." };
    let got: { base?: string; key?: string; keyName?: string };
    try {
      const aes = await boxKey(kp.privateKey, p.box.epk);
      got = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64u(p.box.iv) }, aes, fromB64u(p.box.ct))));
    } catch { return { ok: false, message: "The answer from the browser could not be unlocked here. Nothing was saved. Run syok login again." }; }
    const base = String(got.base || "").trim(), key = String(got.key || "").trim();
    const ap = addressProblem(base), ks = keyShape(key);
    if (ap || !ks.ok) return { ok: false, message: `The browser sent something unusable (${ap || ks.text}). Nothing was saved.` };
    if (o.save !== false) writeConfig(o.home, { ...readConfig(o.home), base: base.replace(/\/+$/, ""), key });
    return { ok: true, base, key, keyName: got.keyName, message: `Signed in. Syok Code will use ${got.keyName ? `the key "${got.keyName}"` : "a key made for this computer"}${o.save !== false ? ", saved in .syok/config.json in your home folder (only you can read it)" : ""}. You can see or revoke it in Syok, Work, API Keys.` };
  }
  return { ok: false, message: "Stopped waiting: the code has expired. Run syok login again." };
}
