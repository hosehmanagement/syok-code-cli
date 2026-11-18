// Signing in to a hosted tool server through the browser (OAuth 2.1, as the tool-server standard describes it).
//
//   syok mcp login <name>     find the server's sign-in service, open the browser, wait for you to approve, keep the pass
//   syok mcp logout <name>    forget the pass
//   syok mcp                  list the hosted servers and whether you are signed in
//
// What this file is careful about:
//  - The pass (token) is kept in ~/.syok/mcp-auth.json, readable by you alone, and is never printed.
//  - It is only ever sent to the server it was issued for.
//  - Every address the server hands us must be https (http only for this computer), and the sign-in service must
//    name itself exactly as it was announced; a mismatch stops the sign-in.
//  - The answer that comes back to this computer is tied to this one attempt (state + PKCE), and its sender is checked.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** Syok Code's public description of itself, for sign-in services that read one (Client ID Metadata Document). */
export const CLIENT_DOC = "https://syok-ai.com/syok-code/oauth-client.json";
/** The addresses on this computer the browser may come back to. They are listed in the public description, so they are fixed. */
export const CALLBACK_PORTS = [41753, 41754, 41755];
const CALLBACK_PATH = "/callback";

export interface Tokens { access_token: string; refresh_token?: string; expires_at?: number; scope?: string }
export interface Saved { issuer: string; client_id: string; client_secret?: string; how: "given" | "document" | "registered"; tokens?: Tokens; scope?: string }
export type Store = Record<string, Saved>;
export interface AuthDeps { fetchImpl?: typeof fetch; home?: string; openUrl?: (url: string) => void | Promise<void>; log?: (s: string) => void; now?: () => number; ports?: number[]; waitMs?: number; env?: Record<string, string | undefined> }

export const authFile = (home = homedir()) => join(home, ".syok", "mcp-auth.json");
export function readStore(home = homedir()): Store { try { const j = JSON.parse(readFileSync(authFile(home), "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; } }
export function writeStore(home: string, s: Store): void {
  const dir = join(home, ".syok"); mkdirSync(dir, { recursive: true }); const tmp = join(dir, `mcp-auth.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 }); try { chmodSync(tmp, 0o600); } catch {} renameSync(tmp, authFile(home));
}
/** The server's address in its plain form: no fragment, no trailing slash. This is what a pass is issued for. */
export function canonical(url: string): string { const u = new URL(url); u.hash = ""; u.search = ""; let s = u.toString(); if (u.pathname === "/") s = s.replace(/\/$/, ""); else s = s.replace(/\/+$/, ""); return s; }
const isLocal = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
/** An address the server gave us must be https; plain http is accepted only for this computer. Returns the reason it is refused, or "". */
export function unsafeUrl(url: unknown): string {
  if (typeof url !== "string" || !url) return "it is missing";
  let u: URL; try { u = new URL(url); } catch { return "it is not a web address"; }
  if (u.username || u.password) return "it carries a name or password";
  if (u.protocol === "https:") return "";
  if (u.protocol === "http:" && isLocal(u.hostname)) return "";
  return "it does not start with https://";
}

/** Reads `Bearer key="value", key2=value2` from a WWW-Authenticate header. */
export function parseChallenge(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}; if (!header) return out;
  const m = /\bBearer\b(.*)$/is.exec(header); const rest = m ? m[1] : header;
  for (const p of rest.matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, "$1") : p[3];
  return out;
}
/** Where to look for the server's own description of who signs people in for it, in the order the standard gives. */
export function resourceMetaUrls(server: string, fromHeader?: string): string[] {
  const u = new URL(server); const out: string[] = []; if (fromHeader) out.push(fromHeader);
  const path = u.pathname.replace(/\/+$/, "");
  if (path) out.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  out.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(out)];
}
/** Where a sign-in service describes itself, in the order the standard gives. */
export function issuerMetaUrls(issuer: string): string[] {
  const u = new URL(issuer); const path = u.pathname.replace(/\/+$/, "");
  if (path) return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`];
  return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
}

async function getJson(f: typeof fetch, url: string): Promise<any | null> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 15000);
  try { const r = await f(url, { redirect: "error", signal: ac.signal, headers: { accept: "application/json" } }); if (!r.ok) { try { await r.body?.cancel(); } catch {} return null; } const text = (await r.text()).slice(0, 200_000); try { return JSON.parse(text); } catch { return null; } }
  catch { return null; } finally { clearTimeout(t); }
}
async function postForm(f: typeof fetch, url: string, form: Record<string, string>): Promise<{ status: number; json: any }> {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
  try { const r = await f(url, { method: "POST", redirect: "error", signal: ac.signal, headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form).toString() }); const text = (await r.text()).slice(0, 200_000); let json: any = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json }; }
  finally { clearTimeout(t); }
}

export interface Discovery { resource: string; issuer: string; meta: any; scope?: string }
/** Finds out who signs people in for this server, and checks every answer on the way. Throws with a reason in plain words. */
export async function discover(server: string, f: typeof fetch = fetch): Promise<Discovery> {
  const resource = canonical(server);
  // 1. Ask the server without a pass. A server that wants a sign-in answers 401 and may say where its description is.
  let challenge: Record<string, string> = {};
  try {
    const r = await f(server, { method: "POST", redirect: "error", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "syok-code", version: "0.1.0" } } }) });
    try { await r.body?.cancel(); } catch {}
    if (r.status !== 401) { if (r.ok) throw new Error("this server answers without a sign-in, so there is nothing to sign in to"); }
    challenge = parseChallenge(r.headers.get("www-authenticate"));
  } catch (e: any) { if (/nothing to sign in to/.test(e?.message || "")) throw e; throw new Error("the server could not be reached: " + String(e?.message || e).slice(0, 200)); }
  // 2. The server's description: which sign-in service it trusts.
  let prm: any = null;
  for (const url of resourceMetaUrls(server, challenge.resource_metadata)) { const bad = unsafeUrl(url); if (bad) continue; if (new URL(url).origin !== new URL(server).origin) continue; prm = await getJson(f, url); if (prm) break; }
  if (!prm) throw new Error("the server does not say which sign-in service it uses (no protected-resource description found). It may want a key instead: put one in \"headers\" for this server");
  if (typeof prm.resource === "string") { const pr = canonical(prm.resource); if (!(resource === pr || resource.startsWith(pr + "/"))) throw new Error(`the server's description is for a different address (${pr}), so it is not trusted`); }
  const servers: string[] = Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((x: any) => typeof x === "string") : [];
  if (!servers.length) throw new Error("the server's description names no sign-in service");
  // 3. The sign-in service's own description. It must name itself exactly as it was announced.
  let why = "";
  for (const issuer of servers) {
    const bad = unsafeUrl(issuer); if (bad) { why = `the sign-in service address is refused: ${bad}`; continue; }
    for (const url of issuerMetaUrls(issuer)) {
      const meta = await getJson(f, url); if (!meta) continue;
      if (meta.issuer !== issuer) { why = `a sign-in service description at ${new URL(url).host} names a different service than was announced, so it is not trusted`; continue; }
      for (const k of ["authorization_endpoint", "token_endpoint"]) { const b = unsafeUrl(meta[k]); if (b) throw new Error(`the sign-in service's ${k.replace("_", " ")} is refused: ${b}`); }
      if (meta.registration_endpoint !== undefined && unsafeUrl(meta.registration_endpoint)) delete meta.registration_endpoint;
      const methods = meta.code_challenge_methods_supported;
      if (!Array.isArray(methods) || !methods.includes("S256")) throw new Error("the sign-in service does not offer the protection Syok Code requires (PKCE with S256), so the sign-in is refused");
      const scope = challenge.scope || (Array.isArray(prm.scopes_supported) && prm.scopes_supported.length ? prm.scopes_supported.join(" ") : undefined);
      return { resource, issuer, meta, scope };
    }
  }
  throw new Error(why || "the sign-in service did not describe itself (no authorization-server description found)");
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const pkce = () => { const verifier = b64url(randomBytes(48)); return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) }; };

/** Which identity Syok Code uses with this sign-in service: one you gave, its public description, or one registered now. */
export async function chooseClient(d: Discovery, given: { client_id?: string; client_secret?: string } | undefined, saved: Saved | undefined, redirectUris: string[], f: typeof fetch): Promise<Pick<Saved, "client_id" | "client_secret" | "how">> {
  if (given?.client_id) return { client_id: given.client_id, client_secret: given.client_secret, how: "given" };
  if (d.meta.client_id_metadata_document_supported === true) return { client_id: CLIENT_DOC, how: "document" };
  if (saved && saved.how === "registered" && saved.issuer === d.issuer && saved.client_id) return { client_id: saved.client_id, client_secret: saved.client_secret, how: "registered" };
  if (typeof d.meta.registration_endpoint === "string") {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await f(d.meta.registration_endpoint, { method: "POST", redirect: "error", signal: ac.signal, headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_name: "Syok Code", client_uri: "https://syok-ai.com/syok-code/", application_type: "native", redirect_uris: redirectUris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
      const j: any = await r.json().catch(() => null);
      if (!r.ok || !j || typeof j.client_id !== "string") throw new Error(`the sign-in service refused to register Syok Code (${r.status}${j?.error ? ": " + String(j.error_description || j.error).slice(0, 200) : ""})`);
      return { client_id: j.client_id, client_secret: typeof j.client_secret === "string" ? j.client_secret : undefined, how: "registered" };
    } finally { clearTimeout(t); }
  }
  throw new Error("this sign-in service does not accept apps it does not know. Register an app with the service yourself and put its id in the settings for this server: \"oauth\": { \"client_id\": \"...\" }");
}

interface Callback { port: number; redirect: string; wait: Promise<URLSearchParams>; close: () => void }
/** Listens on this computer only, for the one answer the browser brings back. */
async function listen(ports: number[], waitMs: number): Promise<Callback> {
  for (const port of ports) {
    try {
      let done!: (p: URLSearchParams) => void, fail!: (e: Error) => void; const wait = new Promise<URLSearchParams>((a, b) => { done = a; fail = b; });
      const server = createServer((req, res) => {
        const u = new URL(req.url || "/", "http://127.0.0.1"); if (u.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end("<!doctype html><meta charset=utf-8><title>Syok Code</title><body style=\"font-family:system-ui;margin:3em\"><h2>Syok Code</h2><p>" + (u.searchParams.get("error") ? "The sign-in was not completed. Go back to the terminal for details." : "You are signed in. You can close this window and go back to the terminal.") + "</p>");
        done(u.searchParams);
      });
      await new Promise<void>((ok, no) => { server.once("error", no); server.listen(port, "127.0.0.1", () => ok()); });
      const timer = setTimeout(() => fail(new Error("no answer came back from the browser in time")), waitMs);
      const close = () => { clearTimeout(timer); try { server.close(); (server as any).closeAllConnections?.(); } catch {} };
      wait.catch(() => {});
      const actual = Number((server.address() as any)?.port) || port;
      return { port: actual, redirect: `http://127.0.0.1:${actual}${CALLBACK_PATH}`, wait, close };
    } catch { /* that port is busy: try the next one */ }
  }
  throw new Error(`could not listen for the browser's answer: ports ${ports.join(", ")} on this computer are all in use`);
}
function openBrowser(url: string) {
  try {
    const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
    const p = spawn(cmd, args as string[], { stdio: "ignore", detached: true }); p.on("error", () => {}); p.unref();
  } catch {}
}
function keep(t: any, now: number, before?: Tokens): Tokens {
  const out: Tokens = { access_token: String(t.access_token) };
  const rt = typeof t.refresh_token === "string" ? t.refresh_token : before?.refresh_token; if (rt) out.refresh_token = rt;
  if (Number.isFinite(Number(t.expires_in)) && Number(t.expires_in) > 0) out.expires_at = now + Math.floor(Number(t.expires_in)) * 1000;
  const sc = typeof t.scope === "string" ? t.scope : before?.scope; if (sc) out.scope = sc;
  return out;
}

export interface LoginResult { ok: boolean; message: string }
/** The whole sign-in for one server. */
export async function login(name: string, cfg: { url?: string; oauth?: { client_id?: string; client_secret?: string; scope?: string } }, deps: AuthDeps = {}): Promise<LoginResult> {
  const f = deps.fetchImpl || fetch, home = deps.home || homedir(), log = deps.log || (() => {}), now = deps.now || Date.now;
  if (!cfg?.url) return { ok: false, message: `${name} is not a hosted tool server (it has no "url"), so there is nothing to sign in to.` };
  let cb: Callback | null = null;
  try {
    const d = await discover(cfg.url, f); const store = readStore(home); const key = d.resource;
    cb = await listen(deps.ports || CALLBACK_PORTS, deps.waitMs ?? 300_000);
    const all = [...new Set([cb.port, ...(deps.ports || CALLBACK_PORTS)])].filter(Boolean).flatMap((p) => [`http://127.0.0.1:${p}${CALLBACK_PATH}`, `http://localhost:${p}${CALLBACK_PATH}`]);
    const client = await chooseClient(d, cfg.oauth, store[key], all, f);
    const { verifier, challenge } = pkce(); const state = b64url(randomBytes(24));
    let scope = cfg.oauth?.scope || d.scope || "";
    if (Array.isArray(d.meta.scopes_supported) && d.meta.scopes_supported.includes("offline_access") && !scope.split(/\s+/).includes("offline_access")) scope = (scope + " offline_access").trim();
    const au = new URL(d.meta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: cb.redirect, code_challenge: challenge, code_challenge_method: "S256", state, resource: d.resource, ...(scope ? { scope } : {}) })) au.searchParams.set(k, v);
    log(`Sign in to ${name} (${new URL(cfg.url).host}) in your browser. The sign-in service is ${new URL(d.issuer).host}.`);
    log("If the browser does not open, open this address yourself:\n\n  " + au.toString() + "\n");
    log("Waiting for you to approve in the browser...");
    await (deps.openUrl ? deps.openUrl(au.toString()) : openBrowser(au.toString()));
    const back = await cb.wait;
    // The answer must belong to this attempt and come from the service that was announced.
    if (back.get("state") !== state) return { ok: false, message: "The answer from the browser does not belong to this sign-in attempt, so it was thrown away. Nothing was saved. Try again." };
    const iss = back.get("iss");
    if (iss !== null && iss !== d.issuer) return { ok: false, message: "The answer came from a different sign-in service than the one announced, so it was thrown away. Nothing was saved." };
    if (iss === null && d.meta.authorization_response_iss_parameter_supported === true) return { ok: false, message: "The sign-in service did not say who it is in its answer, although it promises to. The answer was thrown away. Nothing was saved." };
    if (back.get("error")) return { ok: false, message: `The sign-in was not approved: ${String(back.get("error_description") || back.get("error")).slice(0, 200)}. Nothing was saved.` };
    const code = back.get("code"); if (!code) return { ok: false, message: "The browser came back without a sign-in code. Nothing was saved." };
    const tr = await postForm(f, d.meta.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: cb.redirect, client_id: client.client_id, code_verifier: verifier, resource: d.resource, ...(client.client_secret ? { client_secret: client.client_secret } : {}) });
    if (tr.status !== 200 || !tr.json || typeof tr.json.access_token !== "string") return { ok: false, message: `The sign-in service did not hand over a pass (${tr.status}${tr.json?.error ? ": " + String(tr.json.error_description || tr.json.error).slice(0, 200) : ""}). Nothing was saved.` };
    if (tr.json.token_type && String(tr.json.token_type).toLowerCase() !== "bearer") return { ok: false, message: "The sign-in service handed over a kind of pass Syok Code cannot use. Nothing was saved." };
    const fresh = readStore(home);
    fresh[key] = { issuer: d.issuer, client_id: client.client_id, ...(client.client_secret && client.how === "registered" ? { client_secret: client.client_secret } : {}), how: client.how, tokens: keep(tr.json, now()), ...(scope ? { scope } : {}) };
    writeStore(home, fresh);
    return { ok: true, message: `Signed in to ${name}. The pass is kept in ${authFile(home)} (readable by you alone) and is used automatically from now on.` };
  } catch (e: any) { return { ok: false, message: `Could not sign in to ${name}: ${String(e?.message || e).slice(0, 500)}.` }; }
  finally { cb?.close(); }
}
export function logout(name: string, cfg: { url?: string }, home = homedir()): string {
  if (!cfg?.url) return `${name} is not a hosted tool server.`;
  const s = readStore(home); const k = canonical(cfg.url); if (!s[k]) return `You were not signed in to ${name}.`;
  delete s[k]; writeStore(home, s); return `Signed out of ${name}: the pass is forgotten on this computer.`;
}

/** The pass to send to this server right now, renewing it first when it is about to run out. "" when there is none. */
export async function passFor(server: string, deps: AuthDeps & { clientSecret?: string; force?: boolean } = {}): Promise<string> {
  const home = deps.home || homedir(), now = (deps.now || Date.now)(); let key: string; try { key = canonical(server); } catch { return ""; }
  const s = readStore(home); const e = s[key]; if (!e?.tokens?.access_token) return "";
  const stale = deps.force || (e.tokens.expires_at !== undefined && e.tokens.expires_at - now < 60_000);
  if (!stale) return e.tokens.access_token;
  if (!e.tokens.refresh_token) return deps.force ? "" : e.tokens.access_token;
  try {
    const d = await discover(server, deps.fetchImpl || fetch).catch(() => null);
    if (!d || d.issuer !== e.issuer) return ""; // the server now trusts a different sign-in service: the old pass and identity are not reused
    const secret = e.client_secret || deps.clientSecret;
    const tr = await postForm(deps.fetchImpl || fetch, d.meta.token_endpoint, { grant_type: "refresh_token", refresh_token: e.tokens.refresh_token, client_id: e.client_id, resource: key, ...(secret ? { client_secret: secret } : {}) });
    if (tr.status !== 200 || typeof tr.json?.access_token !== "string") { if (tr.status === 400 || tr.status === 401) { const again = readStore(home); if (again[key]) { delete again[key].tokens; writeStore(home, again); } } return ""; }
    const again = readStore(home); if (!again[key]) return ""; again[key].tokens = keep(tr.json, now, e.tokens); writeStore(home, again);
    return again[key].tokens!.access_token;
  } catch { return ""; }
}
/** One line per hosted server: signed in or not. Nothing secret is shown. */
export function describeLogins(servers: Record<string, { url?: string; headers?: Record<string, string> }> | undefined, home = homedir(), now = Date.now()): string {
  const hosted = Object.entries(servers || {}).filter(([, c]) => c?.url); if (!hosted.length) return "No hosted tool servers are set up. Add one under \"mcp\" in .syok/settings.json with a \"url\".";
  const s = readStore(home); const L = ["Hosted tool servers:"];
  for (const [name, c] of hosted) {
    let k = ""; try { k = canonical(c.url!); } catch {}
    const e = s[k]; const hasKey = Object.keys(c.headers || {}).some((h) => h.toLowerCase() === "authorization");
    const state = hasKey ? "uses the key from its settings" : e?.tokens ? `signed in${e.tokens.expires_at && e.tokens.expires_at < now && !e.tokens.refresh_token ? ", but the pass has run out: sign in again" : ""}` : "not signed in";
    L.push(`  ${name}  ${(() => { try { return new URL(c.url!).host; } catch { return c.url; } })()}  ${state}`);
  }
  L.push("Sign in: syok mcp login <name>     Sign out: syok mcp logout <name>");
  return L.join("\n");
}
export const hasLogin = (server: string, home = homedir()) => { try { return !!readStore(home)[canonical(server)]?.tokens; } catch { return false; } };
void existsSync;
