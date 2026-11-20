// "syok doctor": a one-command health check. Every line says what was checked, the result, and what to do when it is wrong.
// It never prints the key: only whether one is set, how long it is, and whether it has the usual start.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chatUrl } from "./agent.ts";
import { hasProgram } from "./checks.ts";
import { SITE, sha256 } from "./update.ts";

export type Level = "ok" | "warn" | "fail";
export interface Line { level: Level; name: string; detail: string; fix?: string }
export interface DoctorOpts {
  base: string; key: string; root: string; model?: string; self?: string;
  fetchImpl?: typeof fetch; has?: (program: string) => boolean; platform?: string; site?: string; timeoutMs?: number;
  /** How doctor waits before its one retry when Syok says it is busy (tests pass a quick one). */
  sleep?: (ms: number) => Promise<void>;
}
const modelsUrl = (base: string) => chatUrl(base).replace(/\/chat\/completions$/, "/models");
/** Where a beginner finds the address and the key in Syok (kept in one place so every message says the same). */
export const WHERE_ADDRESS = "In Syok open Work, then API Keys, and copy the Base URL under \"Connection details\"";
export const WHERE_KEY = "In Syok open Work, then API Keys, and press Create key (it is shown once)";
/** What is wrong with the address, or "" when it looks right. */
export function addressProblem(base: string): string {
  const b = base.trim(); if (!b) return "no address is set";
  let u: URL; try { u = new URL(b); } catch { return "it is not a web address (it should look like https://your-address)"; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) return "it must start with https:// (http:// is only allowed for this computer itself)";
  if (u.username || u.password) return "it must not contain a name or password";
  if (/^(www\.)?syok-ai\.com$/i.test(u.hostname)) return "that is the Syok website, not your Syok address. " + WHERE_ADDRESS;
  return "";
}
/** The key's shape in words, without the key. */
export function keyShape(key: string): { ok: boolean; text: string } {
  const k = key.trim(); if (!k) return { ok: false, text: "no key is set" };
  const spaces = k !== key || /\s/.test(k);
  const start = k.startsWith("syk_");
  return { ok: start && !spaces, text: `${k.length} characters, ${start ? "starts with syk_" : "does NOT start with syk_ (developer keys do)"}${spaces ? ", has a space or line break in it" : ""}` };
}
async function timed(f: typeof fetch, url: string, init: RequestInit, ms: number): Promise<{ res?: Response; err?: string; took: number }> {
  const t0 = Date.now(); const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const res = await f(url, { ...init, signal: ac.signal }); return { res, took: Date.now() - t0 }; }
  catch (e: any) { return { err: ac.signal.aborted ? `no answer within ${Math.round(ms / 1000)} seconds` : String(e?.message || e), took: Date.now() - t0 }; }
  finally { clearTimeout(t); }
}
/** Syok (or a provider behind it) said "too many requests" or "busy for a moment". */
const BUSY = new Set([429, 503]);
/** How long to wait before the retry: the Retry-After the server asked for, between 1 and 15 seconds; 5 seconds if it gave none. */
export function retryWait(res: Response): number {
  const h = res.headers.get("retry-after") || ""; const n = Number(h);
  if (h && Number.isFinite(n)) return Math.min(15000, Math.max(1000, n * 1000));
  const d = h ? Date.parse(h) : NaN; if (Number.isFinite(d)) return Math.min(15000, Math.max(1000, d - Date.now()));
  return 5000;
}
/** One request; when Syok answers "busy", wait as it asks and try exactly once more. */
async function timedRetry(f: typeof fetch, url: string, init: RequestInit, ms: number, sleep: (ms: number) => Promise<void>): Promise<{ res?: Response; err?: string; took: number; retried: boolean }> {
  const first = await timed(f, url, init, ms);
  if (!first.res || !BUSY.has(first.res.status)) return { ...first, retried: false };
  try { await first.res.body?.cancel(); } catch {}
  await sleep(retryWait(first.res));
  return { ...(await timed(f, url, init, ms)), retried: true };
}
/** The reason a server gave with its answer, short and on one line ("" if none). */
async function reason(res: Response): Promise<string> { try { return (await res.text()).replace(/\s+/g, " ").trim().slice(0, 200); } catch { return ""; } }
const BUSY_FIX = "This is not a problem with your address or key: Syok answered, but it or your providers are busy right now. Wait a minute and run syok doctor again. If it keeps happening, open Syok and check which provider keys have reached their limits.";
const SETUP = "Run: syok setup   (it asks for both). Or set SYOK_BASE_URL and SYOK_API_KEY, or put {\"base\":\"...\",\"key\":\"...\"} in the file .syok/config.json in your home folder.";

export async function doctor(o: DoctorOpts): Promise<{ ok: boolean; lines: Line[] }> {
  const f = o.fetchImpl || fetch, has = o.has || hasProgram, platform = o.platform || process.platform, ms = o.timeoutMs || 30000;
  const sleep = o.sleep || ((n: number) => new Promise<void>((r) => setTimeout(r, n)));
  const lines: Line[] = []; const add = (level: Level, name: string, detail: string, fix?: string) => lines.push({ level, name, detail, ...(fix ? { fix } : {}) });

  const ap = addressProblem(o.base); const ks = keyShape(o.key);
  if (ap) add("fail", "Syok address", ap, SETUP); else add("ok", "Syok address", new URL(o.base.trim()).origin);
  if (!o.key.trim()) add("fail", "Syok key", ks.text, SETUP);
  else if (!ks.ok) add("warn", "Syok key", ks.text, "Copy the key again in full. " + WHERE_KEY + ".");
  else add("ok", "Syok key", ks.text);

  let reached = false;
  if (!ap && o.key.trim()) {
    const auth = { authorization: "Bearer " + o.key.trim() };
    const m = await timedRetry(f, modelsUrl(o.base), { headers: auth }, ms, sleep);
    if (m.err) add("fail", "Reach Syok", m.err, "Check the address and your internet connection.");
    else if (BUSY.has(m.res!.status)) { const t = await reason(m.res!); add("fail", "Reach Syok", `Syok answered "busy" (error ${m.res!.status}${t ? ": " + t : ""}), also when asked again a few seconds later`, BUSY_FIX); }
    else if (m.res!.status === 401 || m.res!.status === 403) add("fail", "Reach Syok", `Syok answered, and refused the key (${m.res!.status})`, "Make a new key and save it with syok setup. " + WHERE_KEY + ".");
    else if (!m.res!.ok) add("fail", "Reach Syok", `the address answered with error ${m.res!.status}`, "Check the address. " + WHERE_ADDRESS + ", and save it with syok setup.");
    else {
      let n = -1; try { const j: any = await m.res!.json(); if (Array.isArray(j?.data)) n = j.data.length; } catch {}
      if (n < 0) add("fail", "Reach Syok", "the address answered, but not like Syok does (it may be a web page, not your Syok address)", WHERE_ADDRESS + ", and save it with syok setup.");
      else { reached = true; add("ok", "Reach Syok", `answered in ${m.took} ms, key accepted, ${n} model${n === 1 ? "" : "s"} listed`); }
    }
    if (reached) {
      const model = o.model || "syok-coder";
      const c = await timedRetry(f, chatUrl(o.base), { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 16, temperature: 0 }) }, Math.max(ms, 60000), sleep);
      if (c.err) add("fail", "AI answer", c.err, "Syok was reached but no AI answered. Check in Syok that at least one provider key is working.");
      else if (BUSY.has(c.res!.status)) { const t = await reason(c.res!); add("fail", "AI answer", `Syok answered "busy" (error ${c.res!.status}${t ? ": " + t : ""}), also when asked again a few seconds later`, BUSY_FIX); }
      else if (!c.res!.ok) { let t = ""; try { t = (await c.res!.text()).replace(/\s+/g, " ").slice(0, 200); } catch {} add("fail", "AI answer", `error ${c.res!.status}${t ? ": " + t : ""}`, "Open Syok and check your provider keys and their limits."); }
      else {
        let text = ""; try { const j: any = await c.res!.json(); text = String(j?.choices?.[0]?.message?.content || "").trim(); } catch {}
        const prov = c.res!.headers.get("x-syok-provider") || "", pm = c.res!.headers.get("x-syok-model") || "";
        if (!text) add("fail", "AI answer", "the answer was empty", "Try again; if it stays empty, check your provider keys in Syok.");
        else add("ok", "AI answer", `"${text.slice(0, 40)}" in ${c.took} ms${prov ? `, answered by ${prov}${pm ? " (" + pm + ")" : ""}` : ""} for model ${model}`);
      }
    }
  } else add("warn", "Reach Syok", "not tried, because the address or key is missing");

  if (has("git")) add("ok", "git", "found"); else add("warn", "git", "not found", "Install git: checkpoints of your work, /diff and \"syok pr\" need it.");
  if (has("gh")) add("ok", "gh (GitHub program)", "found"); else add("warn", "gh (GitHub program)", "not found", "Only needed for \"syok pr\", \"syok review\" and /cloud. Install it from https://cli.github.com");
  if (platform === "linux") { if (has("bwrap")) add("ok", "bubblewrap", "found (confinement is on by default and needs it)"); else add("warn", "bubblewrap", "not found", "Confinement is on by default, and on Linux it needs this program. Until it is installed, the AI's commands run unconfined. Install it with your package manager (the package is called bubblewrap)."); }
  if (platform === "win32") add("ok", "--confine", "on Windows itself it gives write protection (commands can change files only in the project; they can still read other files). Switch it on with --confine or in syok setup. For the full kind, run Syok Code inside WSL (Windows' own Linux): run \"wsl --install\" once, open Ubuntu, install Syok Code there with the Linux install line, and work on your project from there.");
  if (platform === "darwin") { if (has("sandbox-exec")) add("ok", "sandbox-exec", "found (confinement is on by default and needs it)"); else add("warn", "sandbox-exec", "not found", "Confinement is on by default and needs it. Until then the AI's commands run unconfined."); }

  const sf = join(o.root, ".syok", "settings.json");
  if (existsSync(sf)) { try { const j = JSON.parse(readFileSync(sf, "utf8")); if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("it is not a settings object"); add("ok", "Project settings", ".syok/settings.json reads fine"); } catch (e: any) { add("fail", "Project settings", ".syok/settings.json cannot be read: " + String(e?.message || e).slice(0, 120), "Fix or remove the file. Until then your settings are ignored."); } }
  else add("ok", "Project settings", "none (defaults are used)");
  if (existsSync(join(o.root, ".git"))) add("ok", "Project folder", "a git project"); else add("warn", "Project folder", "not a git project", "It still works. With git you can see and undo every change (run: git init).");

  if (o.self && /\.js$/i.test(o.self) && existsSync(o.self)) {
    const site = (o.site || process.env.SYOK_SITE || SITE).replace(/\/+$/, "");
    const u = await timed(f, site + "/syok.js.sha256", {}, 10000);
    if (u.err || !u.res!.ok) add("warn", "Version", "could not check for a newer version");
    else { const sum = (await u.res!.text()).trim().split(/\s+/)[0].toLowerCase(); let mine = ""; try { mine = sha256(readFileSync(o.self)); } catch {} if (!/^[0-9a-f]{64}$/.test(sum)) add("warn", "Version", "could not check for a newer version"); else if (sum === mine) add("ok", "Version", "up to date"); else add("warn", "Version", "a different version is published", "Run: syok update"); }
  }
  return { ok: !lines.some((l) => l.level === "fail"), lines };
}
export function describeDoctor(r: { ok: boolean; lines: Line[] }): string {
  const mark = { ok: "OK  ", warn: "NOTE", fail: "FAIL" } as const;
  const out = r.lines.map((l) => `${mark[l.level]}  ${l.name}: ${l.detail}${l.fix ? "\n        " + l.fix : ""}`);
  const fails = r.lines.filter((l) => l.level === "fail").length, warns = r.lines.filter((l) => l.level === "warn").length;
  out.push("", fails ? `${fails} problem${fails === 1 ? "" : "s"} to fix.` : warns ? `Ready to use. ${warns} note${warns === 1 ? "" : "s"} above, none of them stops you.` : "Everything is fine.");
  return out.join("\n");
}
