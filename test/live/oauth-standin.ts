// A stand-in for a hosted tool server that wants a browser sign-in, together with its sign-in service (OAuth 2.1).
// Used by the tests (imported) and by the live checks (run as a program: PORT, LOG and NUMBER come from the environment).
// The "sign-in page" approves at once and sends the browser straight back, which is what a person clicking Approve does.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

export interface Opt { port?: number; number?: string; issuerInMeta?: string; noS256?: boolean; noRegistration?: boolean; clientDocs?: boolean; issInAnswer?: string | false; promiseIss?: boolean; tamperState?: boolean; denyUser?: boolean; refuseToken?: boolean; expiresIn?: number; noRefresh?: boolean; noHeaderHint?: boolean; prmResource?: string; path?: string; needClient?: string; offline?: boolean; httpEndpoints?: boolean }
export function standIn(o: Opt = {}) {
  const log = { registered: [] as any[], authorize: [] as URLSearchParams[], token: [] as URLSearchParams[], mcpAuth: [] as string[], refreshes: 0 };
  const codes = new Map<string, { challenge: string; client: string; redirect: string; resource: string }>(); const live = new Set<string>(); const refreshTokens = new Set<string>(); let n = 0;
  const path = o.path ?? "/mcp";
  const server = Bun.serve({ port: o.port ?? 0, hostname: "127.0.0.1", async fetch(req) {
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
      const result = b.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "standin", version: "1" } } : b.method === "tools/list" ? { tools: [{ name: "stock", description: "stock level", inputSchema: { type: "object", properties: {} } }] } : { content: [{ type: "text", text: (o.number ?? "4217") + " units" }] };
      return Response.json({ jsonrpc: "2.0", id: b.id, result });
    }
    return new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}`;
  return { server, url, mcp: url + path, log, expire: (t: string) => live.delete(t), liveTokens: live };
}

if (import.meta.main) {
  const s = standIn({ port: Number(process.env.OAUTH_STANDIN_PORT || 8793), number: process.env.OAUTH_STANDIN_NUMBER || "5309" });
  const file = process.env.OAUTH_STANDIN_LOG;
  if (file) setInterval(() => { if (!s.log.mcpAuth.length) return; try { appendFileSync(file, s.log.mcpAuth.splice(0).map((a) => (a.startsWith("Bearer at-") ? "call with a pass" : a ? "call with something else" : "call without a pass")).join("\n") + "\n"); } catch {} }, 300);
  console.log("oauth stand-in on " + s.url);
}
