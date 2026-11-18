// Browser sign-in for hosted tool servers, against a stand-in server that plays the tool server and its sign-in service.
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { tmpProject } from "./helpers.ts";
import { login, logout, passFor, readStore, authFile, parseChallenge, resourceMetaUrls, issuerMetaUrls, canonical, unsafeUrl, describeLogins, discover, CLIENT_DOC, CALLBACK_PORTS } from "../src/mcp-auth.ts";
import { HttpMcp, startMcp } from "../src/mcp.ts";

interface Opt { issuerInMeta?: string; noS256?: boolean; noRegistration?: boolean; clientDocs?: boolean; issInAnswer?: string | false; promiseIss?: boolean; tamperState?: boolean; denyUser?: boolean; refuseToken?: boolean; expiresIn?: number; noRefresh?: boolean; noHeaderHint?: boolean; prmResource?: string; path?: string; needClient?: string; offline?: boolean; httpEndpoints?: boolean }
function standIn(o: Opt = {}) {
  const log = { registered: [] as any[], authorize: [] as URLSearchParams[], token: [] as URLSearchParams[], mcpAuth: [] as string[], refreshes: 0 };
  const codes = new Map<string, { challenge: string; client: string; redirect: string; resource: string }>(); const live = new Set<string>(); const refreshTokens = new Set<string>(); let n = 0;
  const path = o.path ?? "/mcp";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url); const origin = u.origin; const issuer = origin;
    if (u.pathname === "/.well-known/oauth-protected-resource" + path || (o.noHeaderHint && u.pathname === "/.well-known/oauth-protected-resource")) return Response.json({ resource: o.prmResource ?? origin + path, authorization_servers: [issuer], scopes_supported: ["tools"] });
    if (u.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: o.issuerInMeta ?? issuer, authorization_endpoint: (o.httpEndpoints ? "http://evil.example" : origin) + "/authorize", token_endpoint: origin + "/token", ...(o.noRegistration ? {} : { registration_endpoint: origin + "/register" }), code_challenge_methods_supported: o.noS256 ? ["plain"] : ["S256"], ...(o.clientDocs ? { client_id_metadata_document_supported: true } : {}), ...(o.promiseIss ? { authorization_response_iss_parameter_supported: true } : {}), ...(o.offline ? { scopes_supported: ["tools", "offline_access"] } : {}) });
    if (u.pathname === "/register" && req.method === "POST") { const b = await req.json(); log.registered.push(b); return Response.json({ client_id: "client-" + ++n, ...b }, { status: 201 }); }
    if (u.pathname === "/authorize") {
      log.authorize.push(u.searchParams); const q = u.searchParams; const back = new URL(q.get("redirect_uri")!);
      if (o.needClient && q.get("client_id") !== o.needClient) return new Response("unknown client", { status: 400 });
      if (o.denyUser) { back.searchParams.set("error", "access_denied"); back.searchParams.set("error_description", "The user said no"); }
      else { const code = "code-" + ++n; codes.set(code, { challenge: q.get("code_challenge")!, client: q.get("client_id")!, redirect: q.get("redirect_uri")!, resource: q.get("resource")! }); back.searchParams.set("code", code); }
      back.searchParams.set("state", o.tamperState ? "someone-elses-state" : q.get("state")!);
      if (o.issInAnswer !== false) back.searchParams.set("iss", o.issInAnswer ?? issuer);
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (u.pathname === "/token" && req.method === "POST") {
      const f = new URLSearchParams(await req.text()); log.token.push(f);
      if (o.refuseToken) return Response.json({ error: "invalid_grant", error_description: "no pass for you" }, { status: 400 });
      const issue = () => { const at = "at-" + ++n; live.add(at); const rt = o.noRefresh ? undefined : "rt-" + ++n; if (rt) refreshTokens.add(rt); return Response.json({ access_token: at, token_type: "Bearer", ...(o.expiresIn !== undefined ? { expires_in: o.expiresIn } : {}), ...(rt ? { refresh_token: rt } : {}), scope: "tools" }); };
      if (f.get("grant_type") === "authorization_code") {
        const c = codes.get(f.get("code") || ""); codes.delete(f.get("code") || "");
        const okVerifier = c && createHash("sha256").update(f.get("code_verifier") || "").digest("base64url") === c.challenge;
        if (!c || !okVerifier || c.client !== f.get("client_id") || c.redirect !== f.get("redirect_uri") || c.resource !== f.get("resource")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        return issue();
      }
      if (f.get("grant_type") === "refresh_token") { log.refreshes++; const rt = f.get("refresh_token") || ""; if (!refreshTokens.has(rt) || f.get("resource") !== origin + path) return Response.json({ error: "invalid_grant" }, { status: 400 }); refreshTokens.delete(rt); return issue(); }
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (u.pathname === path && req.method === "POST") {
      const a = req.headers.get("authorization") || ""; log.mcpAuth.push(a); const tok = a.replace(/^Bearer /, "");
      if (!live.has(tok)) return new Response("sign in first", { status: 401, headers: o.noHeaderHint ? {} : { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${path}", scope="tools"` } });
      const b: any = await req.json(); if (b.id == null) return new Response(null, { status: 202 });
      const result = b.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "standin", version: "1" } } : b.method === "tools/list" ? { tools: [{ name: "stock", description: "stock level", inputSchema: { type: "object", properties: {} } }] } : { content: [{ type: "text", text: "4217 units" }] };
      return Response.json({ jsonrpc: "2.0", id: b.id, result });
    }
    return new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  return { server, url, mcp: url + path, log, expire: (t: string) => live.delete(t), liveTokens: live };
}
/** Plays the person at the browser: opens the address and follows the service's redirect back to this computer. */
const browser = async (url: string) => { const r = await fetch(url, { redirect: "manual" }); const loc = r.headers.get("location"); if (loc) await fetch(loc).then((x) => x.text()); };
const deps = (home: string, extra: any = {}) => ({ home, openUrl: browser, ports: [0], waitMs: 5000, ...extra });

test("the whole sign-in: found, approved, pass kept for the owner alone, and never printed", async () => {
  const s = standIn(); const home = tmpProject({}); const said: string[] = [];
  try {
    const r = await login("stock", { url: s.mcp }, deps(home, { log: (t: string) => said.push(t) }));
    expect(r.ok).toBe(true); expect(r.message).toContain("Signed in to stock");
    const saved = readStore(home)[s.mcp]; expect(saved.issuer).toBe(s.url); expect(saved.how).toBe("registered"); expect(saved.tokens!.access_token).toMatch(/^at-/); expect(saved.tokens!.refresh_token).toMatch(/^rt-/);
    if (process.platform !== "win32") expect(statSync(authFile(home)).mode & 0o777).toBe(0o600);
    const all = said.join("\n") + r.message; expect(all).not.toContain(saved.tokens!.access_token); expect(all).not.toContain(saved.tokens!.refresh_token!);
    expect(all).toContain("If the browser does not open, open this address yourself"); expect(all).toContain(s.url + "/authorize?");
    // what the sign-in service was asked, as the standard requires
    const q = s.log.authorize[0]; expect(q.get("response_type")).toBe("code"); expect(q.get("code_challenge_method")).toBe("S256"); expect(q.get("code_challenge")!.length).toBeGreaterThan(40);
    expect(q.get("resource")).toBe(s.mcp); expect(q.get("scope")).toBe("tools"); expect(q.get("state")!.length).toBeGreaterThan(20); expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const t = s.log.token[0]; expect(t.get("resource")).toBe(s.mcp); expect(t.get("code_verifier")!.length).toBeGreaterThan(40); expect(t.get("client_id")).toBe(saved.client_id);
    const reg = s.log.registered[0]; expect(reg.application_type).toBe("native"); expect(reg.token_endpoint_auth_method).toBe("none"); expect(reg.grant_types).toEqual(["authorization_code", "refresh_token"]); expect(reg.redirect_uris).toContain(q.get("redirect_uri"));
  } finally { s.server.stop(true); }
});

test("after signing in, the tool server works; before it, the message says exactly what to run", async () => {
  const s = standIn(); const home = tmpProject({}); const logs: string[] = [];
  try {
    const before = await startMcp({ "my stock": { url: s.mcp } }, home, (l) => logs.push(l), fetch, home);
    expect(before.length).toBe(0); expect(logs[0]).toContain("it wants a sign-in. Run: syok mcp login my stock");
    expect((await login("my stock", { url: s.mcp }, deps(home))).ok).toBe(true);
    const after = await startMcp({ "my stock": { url: s.mcp } }, home, (l) => logs.push(l), fetch, home);
    expect(after.length).toBe(1); expect(await after[0].call("stock", {})).toContain("4217");
    expect(s.log.mcpAuth.at(-1)).toMatch(/^Bearer at-/);
    expect(logs.join("\n")).not.toContain(readStore(home)[s.mcp].tokens!.access_token);
  } finally { s.server.stop(true); }
});

test("a pass that ran out is renewed quietly, once, and the new one is kept", async () => {
  const s = standIn(); const home = tmpProject({});
  try {
    await login("stock", { url: s.mcp }, deps(home)); const first = readStore(home)[s.mcp].tokens!;
    const c = new HttpMcp("stock", { url: s.mcp }); c.home = home; await c.start();
    s.expire(first.access_token); // the server stops accepting it in the middle of a chat
    expect(await c.call("stock", {})).toContain("4217"); expect(s.log.refreshes).toBe(1);
    const second = readStore(home)[s.mcp].tokens!; expect(second.access_token).not.toBe(first.access_token); expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(s.log.token.at(-1)!.get("resource")).toBe(s.mcp);
    // the renewing pass is refused too: no loop, a clear instruction, and the dead pass is forgotten
    s.expire(second.access_token); s.liveTokens.clear(); const st = readStore(home); st[s.mcp].tokens!.refresh_token = "rt-stolen-or-old"; (await import("../src/mcp-auth.ts")).writeStore(home, st);
    await expect(c.call("stock", {})).rejects.toThrow("syok mcp login stock"); expect(readStore(home)[s.mcp].tokens).toBeUndefined();
  } finally { s.server.stop(true); }
});

test("a pass about to run out is renewed before use; one with no end date is used as it is", async () => {
  const s = standIn({ expiresIn: 30 }); const home = tmpProject({});
  try {
    await login("stock", { url: s.mcp }, deps(home)); const first = readStore(home)[s.mcp].tokens!.access_token;
    const p = await passFor(s.mcp, { home }); expect(p).not.toBe(first); expect(s.log.refreshes).toBe(1);
  } finally { s.server.stop(true); }
  const s2 = standIn(); const home2 = tmpProject({});
  try { await login("stock", { url: s2.mcp }, deps(home2)); const t = readStore(home2)[s2.mcp].tokens!.access_token; expect(await passFor(s2.mcp, { home: home2 })).toBe(t); expect(s2.log.refreshes).toBe(0); expect(await passFor("http://127.0.0.1:9/other", { home: home2 })).toBe(""); }
  finally { s2.server.stop(true); }
});

test("a key written in the settings always wins: the pass is not sent, and a refusal is not turned into a sign-in", async () => {
  const s = standIn(); const home = tmpProject({});
  try {
    await login("stock", { url: s.mcp }, deps(home));
    const c = new HttpMcp("stock", { url: s.mcp, headers: { Authorization: "Bearer my-own-key" } }); c.home = home;
    await expect(c.start()).rejects.toThrow("refused the key (401)"); expect(s.log.mcpAuth.at(-1)).toBe("Bearer my-own-key");
  } finally { s.server.stop(true); }
});

test("the pass is only ever sent to the server it was issued for", async () => {
  const a = standIn(), b = standIn(); const home = tmpProject({});
  try {
    await login("a", { url: a.mcp }, deps(home));
    const c = new HttpMcp("b", { url: b.mcp }); c.home = home; await expect(c.start()).rejects.toThrow("syok mcp login b");
    expect(b.log.mcpAuth.every((h) => h === "")).toBe(true);
  } finally { a.server.stop(true); b.server.stop(true); }
});

const refused: Array<[string, Opt, RegExp]> = [
  ["the sign-in service names itself differently than announced", { issuerInMeta: "https://honest.example" }, /names a different service than was announced/],
  ["the sign-in service lacks the required protection (PKCE S256)", { noS256: true }, /PKCE with S256/],
  ["the answer carries someone else's state", { tamperState: true }, /does not belong to this sign-in attempt/],
  ["the answer names a different sender", { issInAnswer: "https://attacker.example" }, /different sign-in service than the one announced/],
  ["the service promises to name itself in the answer and does not", { issInAnswer: false, promiseIss: true }, /did not say who it is/],
  ["the person says no in the browser", { denyUser: true }, /was not approved: The user said no/],
  ["the service refuses to hand over a pass", { refuseToken: true }, /did not hand over a pass \(400: no pass for you\)/],
  ["the server's description is for a different address", { prmResource: "https://other.example/mcp" }, /is for a different address/],
  ["the sign-in page is on plain http somewhere else", { httpEndpoints: true }, /authorization endpoint is refused: it does not start with https/],
  ["the service accepts neither unknown apps nor Syok Code's public description", { noRegistration: true }, /does not accept apps it does not know.*"oauth": \{ "client_id"/],
];
for (const [what, opt, want] of refused) test("refused, and nothing is saved, when " + what, async () => {
  const s = standIn(opt); const home = tmpProject({});
  try { const r = await login("stock", { url: s.mcp }, deps(home)); expect(r.ok).toBe(false); expect(r.message).toMatch(want); expect(existsSync(authFile(home))).toBe(false); expect(s.liveTokens.size).toBe(0); }
  finally { s.server.stop(true); }
});

test("a service that keeps quiet about who it is in the answer is accepted when it never promised to say", async () => {
  const s = standIn({ issInAnswer: false }); const home = tmpProject({});
  try { expect((await login("stock", { url: s.mcp }, deps(home))).ok).toBe(true); } finally { s.server.stop(true); }
});

test("which identity is used: yours if you gave one, Syok Code's public description if the service reads those, otherwise a registration that is reused", async () => {
  const given = standIn({ noRegistration: true, needClient: "my-registered-app" }); const home = tmpProject({});
  try { const r = await login("stock", { url: given.mcp, oauth: { client_id: "my-registered-app", client_secret: "shh-secret" } }, deps(home)); expect(r.ok).toBe(true); expect(given.log.token[0].get("client_secret")).toBe("shh-secret");
    const saved = readStore(home)[given.mcp]; expect(saved.how).toBe("given"); expect(JSON.stringify(saved)).not.toContain("shh-secret"); } finally { given.server.stop(true); } // your app's secret stays in your settings, not in the pass file
  const docs = standIn({ clientDocs: true, needClient: CLIENT_DOC }); const home2 = tmpProject({});
  try { expect((await login("stock", { url: docs.mcp }, deps(home2))).ok).toBe(true); expect(docs.log.registered.length).toBe(0); expect(readStore(home2)[docs.mcp].client_id).toBe(CLIENT_DOC); } finally { docs.server.stop(true); }
  const reg = standIn(); const home3 = tmpProject({});
  try { await login("stock", { url: reg.mcp }, deps(home3)); const id = readStore(home3)[reg.mcp].client_id; await login("stock", { url: reg.mcp }, deps(home3)); expect(reg.log.registered.length).toBe(1); expect(readStore(home3)[reg.mcp].client_id).toBe(id); } finally { reg.server.stop(true); }
});

test("a longer-lasting sign-in is asked for only when the service offers it", async () => {
  const s = standIn({ offline: true }); const home = tmpProject({});
  try { await login("stock", { url: s.mcp }, deps(home)); expect(s.log.authorize[0].get("scope")).toBe("tools offline_access"); } finally { s.server.stop(true); }
});

test("a server that gives no hint in its refusal is still found through the standard addresses", async () => {
  const s = standIn({ noHeaderHint: true }); const home = tmpProject({});
  try { const d = await discover(s.mcp); expect(d.issuer).toBe(s.url); expect((await login("stock", { url: s.mcp }, deps(home))).ok).toBe(true); } finally { s.server.stop(true); }
});

test("no answer from the browser: it stops waiting and says so; a server without sign-in says so too", async () => {
  const s = standIn(); const home = tmpProject({});
  try { const r = await login("stock", { url: s.mcp }, { home, openUrl: () => {}, ports: [0], waitMs: 300 }); expect(r.ok).toBe(false); expect(r.message).toContain("no answer came back from the browser in time"); }
  finally { s.server.stop(true); }
  const open = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ jsonrpc: "2.0", id: 1, result: {} }) });
  try { const r = await login("open", { url: `http://127.0.0.1:${open.port}/mcp` }, deps(home)); expect(r.ok).toBe(false); expect(r.message).toContain("answers without a sign-in"); } finally { open.stop(true); }
  expect((await login("local", {}, deps(home))).message).toContain("not a hosted tool server");
});

test("signing out forgets the pass; the list shows the state and nothing secret", async () => {
  const s = standIn(); const home = tmpProject({});
  try {
    const servers = { stock: { url: s.mcp }, keyed: { url: "https://k.example/mcp", headers: { Authorization: "Bearer x" } }, local: { command: "node" } as any };
    expect(describeLogins(servers, home)).toMatch(/stock\s+127\.0\.0\.1:\d+\s+not signed in/);
    await login("stock", { url: s.mcp }, deps(home)); const tok = readStore(home)[s.mcp].tokens!.access_token;
    const listed = describeLogins(servers, home); expect(listed).toMatch(/stock\s+127\.0\.0\.1:\d+\s+signed in/); expect(listed).toMatch(/keyed\s+k\.example\s+uses the key from its settings/); expect(listed).not.toContain("local "); expect(listed).not.toContain(tok);
    expect(logout("stock", { url: s.mcp }, home)).toContain("forgotten"); expect(readStore(home)[s.mcp]).toBeUndefined(); expect(logout("stock", { url: s.mcp }, home)).toContain("were not signed in");
    expect(describeLogins({}, home)).toContain("No hosted tool servers");
  } finally { s.server.stop(true); }
});

test("the small parts: reading the refusal header, the standard addresses, and which addresses are refused", () => {
  expect(parseChallenge('Bearer resource_metadata="https://m.example/.well-known/oauth-protected-resource", scope="files:read files:write", error=insufficient_scope')).toEqual({ resource_metadata: "https://m.example/.well-known/oauth-protected-resource", scope: "files:read files:write", error: "insufficient_scope" });
  expect(parseChallenge(null)).toEqual({}); expect(parseChallenge("Basic realm=x")).toEqual({ realm: "x" });
  expect(resourceMetaUrls("https://example.com/public/mcp")).toEqual(["https://example.com/.well-known/oauth-protected-resource/public/mcp", "https://example.com/.well-known/oauth-protected-resource"]);
  expect(resourceMetaUrls("https://example.com", "https://example.com/meta")).toEqual(["https://example.com/meta", "https://example.com/.well-known/oauth-protected-resource"]);
  expect(issuerMetaUrls("https://auth.example.com/tenant1")).toEqual(["https://auth.example.com/.well-known/oauth-authorization-server/tenant1", "https://auth.example.com/.well-known/openid-configuration/tenant1", "https://auth.example.com/tenant1/.well-known/openid-configuration"]);
  expect(issuerMetaUrls("https://auth.example.com")).toEqual(["https://auth.example.com/.well-known/oauth-authorization-server", "https://auth.example.com/.well-known/openid-configuration"]);
  expect(canonical("https://MCP.example.com/")).toBe("https://mcp.example.com"); expect(canonical("https://mcp.example.com/server/mcp/#frag")).toBe("https://mcp.example.com/server/mcp"); expect(canonical("https://mcp.example.com:8443/mcp?x=1")).toBe("https://mcp.example.com:8443/mcp");
  expect(unsafeUrl("https://a.example/x")).toBe(""); expect(unsafeUrl("http://127.0.0.1:5/x")).toBe(""); expect(unsafeUrl("http://localhost/x")).toBe("");
  expect(unsafeUrl("http://a.example/x")).toContain("https"); expect(unsafeUrl("https://u:p@a.example")).toContain("password"); expect(unsafeUrl("file:///etc/passwd")).toContain("https"); expect(unsafeUrl(undefined)).toContain("missing"); expect(unsafeUrl("nonsense")).toContain("not a web address");
  expect(CALLBACK_PORTS.length).toBe(3);
});

test("Syok Code's public description of itself matches what the program sends", () => {
  const doc = JSON.parse(readFileSync(new URL("../install/oauth-client.json", import.meta.url), "utf8"));
  expect(doc.client_id).toBe(CLIENT_DOC); expect(doc.client_name).toBe("Syok Code"); expect(doc.token_endpoint_auth_method).toBe("none");
  expect(doc.redirect_uris.sort()).toEqual(CALLBACK_PORTS.flatMap((p) => [`http://127.0.0.1:${p}/callback`, `http://localhost:${p}/callback`]).sort());
});

// ---- the whole program ----
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
const main = join(import.meta.dir, "..", "src", "main.ts");
function syok(args: string[], cwd: string, home: string, onOut?: (text: string) => void): Promise<{ code: number | null; out: string; err: string }> {
  const env: any = { ...process.env, HOME: home, USERPROFILE: home }; delete env.SYOK_BASE_URL; delete env.SYOK_API_KEY;
  return new Promise((res) => { const p = spawn("bun", [main, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; onOut?.(out); }); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => res({ code, out, err })); });
}
test("whole program: syok mcp login, list, logout (needs no Syok key)", async () => {
  const s = standIn(); const home = tmpProject({}); const proj = tmpProject({});
  mkdirSync(join(proj, ".syok"), { recursive: true }); writeFileSync(join(proj, ".syok", "settings.json"), JSON.stringify({ mcpServers: { stock: { url: s.mcp } } }));
  try {
    const list0 = await syok(["mcp"], proj, home); expect(list0.code).toBe(0); expect(list0.out).toMatch(/stock\s+\S+\s+not signed in/);
    let opened = false;
    const r = await syok(["mcp", "login", "stock", "--no-browser"], proj, home, (text) => { const m = /^\s+(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)$/m.exec(text); if (m && !opened && text.includes("Waiting for you")) { opened = true; browser(m[1]); } });
    expect(r.out).toContain("Signed in to stock"); expect(r.code).toBe(0);
    const tok = readStore(home)[s.mcp].tokens!.access_token; expect(r.out + r.err).not.toContain(tok);
    expect(new URL(s.log.authorize[0].get("redirect_uri")!).port).toBe(String(CALLBACK_PORTS[0])); // the real fixed address is used
    const list1 = await syok(["mcp"], proj, home); expect(list1.out).toMatch(/stock\s+\S+\s+signed in/); expect(list1.out).not.toContain(tok);
    const out = await syok(["mcp", "logout", "stock"], proj, home); expect(out.out).toContain("forgotten"); expect(readStore(home)[s.mcp]).toBeUndefined();
    const bad = await syok(["mcp", "login", "nope"], proj, home); expect(bad.code).toBe(2); expect(bad.err).toContain("no tool server named nope");
    const help = await syok(["--help"], proj, home); expect(help.out).toContain("syok mcp login <name>");
  } finally { s.server.stop(true); }
}, 60000);
