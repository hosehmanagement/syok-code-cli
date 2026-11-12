// Syok bridge: lets the Syok website run commands inside THIS machine (made for a GitHub Codespace you own).
//   syok bridge          start the small command server (port 8787). A Codespace made from the Syok template does this by itself.
//   syok pair <code>     link this machine to your Syok account with the one-time code shown in Syok (Code, then Connect).
//   syok unpair          make a new secret, so the old link stops working.
// Only a caller that knows the secret can run commands. The secret is made here, stays here (mode 600) and is sent once to your own
// Syok account when you pair. Nothing leaves this machine except the output of the commands Syok asks for.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { currentShell, killTree, spawnCommand } from "./shell.ts";

export const VERSION = "0.5.0";
export const DEFAULT_PORT = 8787;
export const EXEC_DEFAULT_S = 90, EXEC_MAX_S = 300, OUT_CAP = 12_000, BODY_MAX = 100_000, CMD_MAX = 4000, MAX_BUSY = 2;

export interface BridgeState { secret: string; pairedAt?: number }
export const stateFile = (home = homedir()) => join(home, ".syok", "bridge.json");
const newSecret = () => randomBytes(32).toString("hex");

function save(home: string, s: BridgeState) {
  const f = stateFile(home);
  mkdirSync(join(home, ".syok"), { recursive: true });
  writeFileSync(f, JSON.stringify(s), { mode: 0o600 });
  try { chmodSync(f, 0o600); } catch { /* windows */ }
}
/** The secret lives in ~/.syok/bridge.json. Made on first use, kept across restarts (a stopped Codespace keeps its disk). */
export function loadState(home = homedir()): BridgeState {
  try {
    const j = JSON.parse(readFileSync(stateFile(home), "utf8"));
    if (typeof j.secret === "string" && /^[0-9a-f]{64}$/.test(j.secret)) return j;
  } catch { /* first run */ }
  const s: BridgeState = { secret: newSecret() };
  save(home, s);
  return s;
}
export function rotate(home = homedir()): BridgeState { const s: BridgeState = { secret: newSecret() }; save(home, s); return s; }
export function markPaired(home = homedir()): void { const s = loadState(home); save(home, { ...s, pairedAt: Date.now() }); }

/** "Bearer <secret>" checked in constant time. */
export function authOk(header: string | null | undefined, secret: string): boolean {
  const m = /^Bearer (.+)$/.exec(String(header ?? ""));
  if (!m) return false;
  const a = createHash("sha256").update(m[1]!).digest(), b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
export const tail = (s: string, cap = OUT_CAP): string => (s.length <= cap ? s : "... (cut; showing the last " + cap + " characters)\n" + s.slice(-cap));

/** The address Syok calls. A Codespace's forwarded port: https://<codespace>-<port>.app.github.dev */
export function publicUrl(env: Record<string, string | undefined>, port = DEFAULT_PORT): string {
  if (env.SYOK_BRIDGE_URL) return env.SYOK_BRIDGE_URL.replace(/\/+$/, "");
  const n = env.CODESPACE_NAME, d = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || "app.github.dev";
  return n ? `https://${n}-${port}.${d}` : "";
}
/** A working folder inside the root, or null when the request tries to leave it. */
export function insideRoot(root: string, cwd: unknown): string | null {
  const r = resolve(root);
  const c = resolve(r, typeof cwd === "string" && cwd ? cwd : ".");
  return c === r || c.startsWith(r + sep) ? c : null;
}

export interface ExecResult { exitCode: number; output: string; timedOut: boolean }
export function runExec(command: string, cwd: string, timeoutS: number, env: NodeJS.ProcessEnv = process.env): Promise<ExecResult> {
  return new Promise((res) => {
    const p = spawnCommand(command, cwd, env, ["ignore", "pipe", "pipe"]);
    let out = "", timedOut = false;
    const add = (d: unknown) => { out += String(d); if (out.length > 400_000) out = out.slice(-200_000); };
    p.stdout!.on("data", add); p.stderr!.on("data", add);
    const t = setTimeout(() => { timedOut = true; killTree(p); }, timeoutS * 1000);
    p.on("error", (e) => { clearTimeout(t); res({ exitCode: 127, output: String(e.message), timedOut: false }); });
    p.on("close", (code) => { clearTimeout(t); res({ exitCode: timedOut ? 124 : (code ?? 1), output: tail(out) + (timedOut ? "\nTimed out after " + timeoutS + " seconds." : ""), timedOut }); });
  });
}

export interface HandlerOpts { secret: () => string; root: string; env?: Record<string, string | undefined> }
const J = (o: unknown, status = 200) => Response.json(o, { status });
/** The whole server: GET /ping and POST /exec, both only with the secret. */
export function makeHandler(o: HandlerOpts): (req: Request) => Promise<Response> {
  let busy = 0;
  const env = o.env ?? process.env;
  return async (req) => {
    if (!authOk(req.headers.get("authorization"), o.secret())) return new Response("no", { status: 401 });
    const url = new URL(req.url);
    if (url.pathname === "/ping" && req.method === "GET") return J({ ok: true, name: env.CODESPACE_NAME || "", version: VERSION, shell: currentShell().label, root: o.root });
    if (url.pathname === "/exec" && req.method === "POST") {
      const raw = await req.text();
      if (raw.length > BODY_MAX) return J({ error: "too_big" }, 413);
      let b: { command?: unknown; cwd?: unknown; timeout?: unknown };
      try { b = JSON.parse(raw); } catch { return J({ error: "bad_json" }, 400); }
      const command = typeof b.command === "string" ? b.command.trim() : "";
      if (!command) return J({ error: "no_command" }, 400);
      if (command.length > CMD_MAX) return J({ error: "command_too_long" }, 400);
      const cwd = insideRoot(o.root, b.cwd);
      if (!cwd) return J({ error: "bad_folder" }, 400);
      const t = Math.min(EXEC_MAX_S, Math.max(1, Math.floor(Number(b.timeout) || EXEC_DEFAULT_S)));
      if (busy >= MAX_BUSY) return J({ error: "busy" }, 429);
      busy++;
      try { return J(await runExec(command, cwd, t, process.env)); } finally { busy--; }
    }
    return J({ error: "not_found" }, 404);
  };
}
export function serve(o: HandlerOpts & { port?: number }) {
  return Bun.serve({ port: o.port ?? DEFAULT_PORT, hostname: "0.0.0.0", fetch: makeHandler(o) });
}

/** Inside a Codespace the forwarded port starts private; Syok needs it reachable, so the bridge asks GitHub to make it public. */
export function makePublic(port: number, env: Record<string, string | undefined> = process.env, run: typeof spawnSync = spawnSync): string {
  const name = env.CODESPACE_NAME;
  if (!name) return "not in a Codespace, nothing to change";
  const r = run("gh", ["codespace", "ports", "visibility", `${port}:public`, "-c", name], { encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) return "could not make the port public (" + String(r.error?.message || r.stderr || "gh failed").trim().slice(0, 160) + "). In the Ports tab, right-click port " + port + " and choose Port Visibility, then Public.";
  return "port " + port + " is public (only callers with the secret can use it)";
}

export const validCode = (c: string) => /^[A-Za-z0-9-]{6,24}$/.test(c);
export async function pair(code: string, base: string, o: { home?: string; env?: Record<string, string | undefined>; port?: number; fetchImpl?: typeof fetch } = {}): Promise<{ ok: boolean; message: string }> {
  const env = o.env ?? process.env, f = o.fetchImpl ?? fetch;
  if (!validCode(code)) return { ok: false, message: "That does not look like a pairing code. Copy the code shown in Syok (Code, then Connect, then Codespace)." };
  if (!base) return { ok: false, message: "Missing SYOK_BASE_URL (your Syok address). Run: syok --help" };
  const url = publicUrl(env, o.port ?? DEFAULT_PORT);
  if (!url) return { ok: false, message: "Pairing is for a GitHub Codespace (CODESPACE_NAME is not set here). To try it somewhere else, set SYOK_BRIDGE_URL to this machine's public address." };
  const st = loadState(o.home);
  let r: Response;
  try {
    r = await f(base.replace(/\/+$/, "") + "/v1/codespace/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code.toUpperCase(), url, secret: st.secret, name: env.CODESPACE_NAME || "" }) });
  } catch (e: any) { return { ok: false, message: "Could not reach Syok: " + (e?.message || e) }; }
  if (r.status === 404 || r.status === 410) return { ok: false, message: "Syok does not know that code, or it has expired (codes last 10 minutes and work once). Make a new one in Syok." };
  if (r.status === 429) return { ok: false, message: "Too many tries. Wait a minute and try again." };
  if (!r.ok) return { ok: false, message: "Syok refused the pairing (" + r.status + ")." };
  markPaired(o.home);
  return { ok: true, message: "Paired. Syok can now run commands in this Codespace. Keep it running; Syok can also start and stop it if you allow that in Syok." };
}

/** syok bridge | syok bridge status | syok pair <code> | syok unpair. Returns an exit code, or never returns while serving. */
export async function bridgeCommand(argv: string[], d: { base: string; cwd?: string; port?: number }): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const port = Number(flag("--port") || d.port || DEFAULT_PORT);
  if (cmd === "pair") {
    const r = await pair(rest.find((x) => !x.startsWith("--")) || "", d.base, { port });
    console.log(r.message); return r.ok ? 0 : 2;
  }
  if (cmd === "unpair") {
    rotate();
    console.log("Made a new secret. The old link no longer works. Also press Unlink in Syok, then pair again with a new code.");
    return 0;
  }
  const st = loadState();
  if (rest[0] === "status") {
    console.log(`Syok bridge ${VERSION}. Address: ${publicUrl(process.env, port) || "(not in a Codespace)"}. Paired: ${st.pairedAt ? "yes, " + new Date(st.pairedAt).toISOString() : "no"}.`);
    return 0;
  }
  const root = resolve(flag("--cwd") || process.env.SYOK_WORKDIR || d.cwd || process.cwd());
  if (!existsSync(root)) { console.error("That folder does not exist: " + root); return 2; }
  serve({ secret: () => loadState().secret, root, port });
  console.log(`Syok bridge ${VERSION} is listening on port ${port} (folder: ${root}, shell: ${currentShell().label}).`);
  console.log("Visibility: " + makePublic(port));
  console.log(st.pairedAt ? "Paired with Syok." : "Not paired yet. In Syok open Code, then Connect, then Codespace, and run: syok pair <code>");
  return await new Promise<number>(() => { /* serve until the machine stops */ });
}
