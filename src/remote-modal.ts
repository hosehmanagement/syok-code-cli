// Modal (modal.com) as a place to run heavy jobs: one "Sandbox" per run, billed per second to the user's own Modal account.
// Uses Modal's official JavaScript SDK. It is loaded only when a remote run is asked for, so normal starts stay fast.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Box, BoxOptions, Provider } from "./remote.ts";

const APP = "syok-code-run";
async function pump(stream: ReadableStream<string> | undefined, on?: (s: string) => void): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; if (value && on) on(value); } } finally { try { reader.releaseLock(); } catch {} }
}
function box(sb: any): Box {
  return {
    id: String(sb.sandboxId),
    upload: (local, remote) => sb.filesystem.copyFromLocal(local, remote),
    download: (remote, local) => sb.filesystem.copyToLocal(remote, local),
    exec: async (command, o) => {
      const p = await sb.exec(["sh", "-c", command], { ...(o.cwd ? { workdir: o.cwd } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
      const [code] = await Promise.all([p.wait(), pump(p.stdout, o.onOut), pump(p.stderr, o.onErr)]);
      return Number(code);
    },
    terminate: async () => { await sb.terminate(); },
  };
}
/** What the two token values look like, without showing them: used to explain a refused token. */
export function tokenShape(env: Record<string, string | undefined> = process.env): string {
  const one = (name: string, prefix: string) => { const raw = env[name] ?? "", v = raw.trim(); return !v ? `${name} is empty` : `${name} ${v.startsWith(prefix) ? "starts with " + prefix : "does NOT start with " + prefix + " (it should)"}, ${v.length} characters${raw !== v ? ", had spaces or a line break around it" : ""}${/\s/.test(v) ? ", contains a space or line break inside" : ""}`; };
  return one("MODAL_TOKEN_ID", "ak-") + "; " + one("MODAL_TOKEN_SECRET", "as-");
}
export function modalHasToken(env: Record<string, string | undefined> = process.env, home = homedir()): boolean {
  return !!(env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET) || existsSync(env.MODAL_CONFIG_PATH || join(home, ".modal.toml"));
}
export const MODAL_SETUP = [
  "Modal is not connected on this computer yet. One-time setup:",
  "  1. Create a free account at https://modal.com (the Starter plan includes monthly free credit).",
  "  2. In Modal open Settings, then API Tokens, then New Token. You get a token ID (starts with ak-) and a token secret (starts with as-).",
  "  3. Set them in this terminal, then run the command again:",
  "       Mac/Linux:   export MODAL_TOKEN_ID=ak-...   and   export MODAL_TOKEN_SECRET=as-...",
  '       Windows:     $env:MODAL_TOKEN_ID="ak-..."   and   $env:MODAL_TOKEN_SECRET="as-..."',
  "Your token stays on your computer: it goes straight to Modal, never to Syok.",
].join("\n");

/** Modal's error messages in plain words. */
export function friendly(e: any): Error {
  const m = String(e?.message || e);
  if (/UNAUTHENTICATED|Token not found|invalid token|PERMISSION_DENIED/i.test(m)) return new Error("Modal did not accept your token. Check MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (Modal, Settings, API Tokens), then try again.\n(What was sent: " + tokenShape() + ")\n(Modal said: " + m.slice(0, 200) + ")");
  if (/RESOURCE_EXHAUSTED|billing|payment|spending limit|credit/i.test(m)) return new Error("Modal refused to start the computer: your account's credit or spending limit may be used up. Check Modal, Settings, Usage and Billing.\n(Modal said: " + m.slice(0, 200) + ")");
  if (/image|registry|manifest|pull/i.test(m) && /not found|failed|unauthorized|denied/i.test(m)) return new Error("Modal could not get that container image. Check the --image name.\n(Modal said: " + m.slice(0, 200) + ")");
  return e instanceof Error ? e : new Error(m);
}
export function modalProvider(load: () => Promise<any> = () => import("modal")): Provider {
  let client: any = null;
  // Tokens pasted with a stray space or line break are a common mistake, so they are trimmed before use.
  const tok = () => { const id = (process.env.MODAL_TOKEN_ID || "").trim(), secret = (process.env.MODAL_TOKEN_SECRET || "").trim(); return id && secret ? { tokenId: id, tokenSecret: secret } : {}; };
  const get = async () => (client ||= new (await load()).ModalClient(tok()));
  return {
    name: "Modal",
    problem: async () => (modalHasToken() ? null : MODAL_SETUP),
    create: async (o: BoxOptions) => {
      try { return await create(o); } catch (e) { throw friendly(e); }
    },
    attach: async (id: string) => { try { return box(await (await get()).sandboxes.fromId(id)); } catch (e) { throw friendly(e); } },
    close: () => { try { client?.close(); } catch {} client = null; },
  };
  async function create(o: BoxOptions): Promise<Box> {
      const c = await get();
      const app = await c.apps.fromName(APP, { createIfMissing: true });
      const image = c.images.fromRegistry(o.image);
      const sb = await c.sandboxes.create(app, image, { timeoutMs: o.timeoutMs, ...(o.gpu ? { gpu: o.gpu } : {}), ...(o.cpu ? { cpu: o.cpu } : {}), ...(o.memoryMiB ? { memoryMiB: o.memoryMiB } : {}) });
      try { await sb.setTags({ made_by: "syok-code" }); } catch {}
      return box(sb);
  }
}
