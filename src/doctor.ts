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
}
const modelsUrl = (base: string) => chatUrl(base).replace(/\/chat\/completions$/, "/models");
/** What is wrong with the address, or "" when it looks right. */
export function addressProblem(base: string): string {
  const b = base.trim(); if (!b) return "no address is set";
  let u: URL; try { u = new URL(b); } catch { return "it is not a web address (it should look like https://your-address)"; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) return "it must start with https:// (http:// is only allowed for this computer itself)";
  if (u.username || u.password) return "it must not contain a name or password";
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
const SETUP = "Run: syok setup   (it asks for both). Or set SYOK_BASE_URL and SYOK_API_KEY, or put {\"base\":\"...\",\"key\":\"...\"} in the file .syok/config.json in your home folder.";

export async function doctor(o: DoctorOpts): Promise<{ ok: boolean; lines: Line[] }> {
  const f = o.fetchImpl || fetch, has = o.has || hasProgram, platform = o.platform || process.platform, ms = o.timeoutMs || 30000;
  const lines: Line[] = []; const add = (level: Level, name: string, detail: string, fix?: string) => lines.push({ level, name, detail, ...(fix ? { fix } : {}) });

  const ap = addressProblem(o.base); const ks = keyShape(o.key);
  if (ap) add("fail", "Syok address", ap, SETUP); else add("ok", "Syok address", new URL(o.base.trim()).origin);
  if (!o.key.trim()) add("fail", "Syok key", ks.text, SETUP);
  else if (!ks.ok) add("warn", "Syok key", ks.text, "Copy the key again from Syok, Developer API. It is shown once, in full.");
  else add("ok", "Syok key", ks.text);

  let reached = false;
  if (!ap && o.key.trim()) {
    const auth = { authorization: "Bearer " + o.key.trim() };
    const m = await timed(f, modelsUrl(o.base), { headers: auth }, ms);
    if (m.err) add("fail", "Reach Syok", m.err, "Check the address and your internet connection.");
    else if (m.res!.status === 401 || m.res!.status === 403) add("fail", "Reach Syok", `Syok answered, and refused the key (${m.res!.status})`, "Make a new developer key in Syok, Developer API, and set it as SYOK_API_KEY.");
    else if (!m.res!.ok) add("fail", "Reach Syok", `the address answered with error ${m.res!.status}`, "Check that the address is your Syok address, with nothing after it.");
    else {
      let n = -1; try { const j: any = await m.res!.json(); if (Array.isArray(j?.data)) n = j.data.length; } catch {}
      if (n < 0) add("fail", "Reach Syok", "the address answered, but not like Syok does", "Check that the address is your Syok address.");
      else { reached = true; add("ok", "Reach Syok", `answered in ${m.took} ms, key accepted, ${n} model${n === 1 ? "" : "s"} listed`); }
    }
    if (reached) {
      const model = o.model || "syok-coder";
      const c = await timed(f, chatUrl(o.base), { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word OK." }], max_tokens: 16, temperature: 0 }) }, Math.max(ms, 60000));
      if (c.err) add("fail", "AI answer", c.err, "Syok was reached but no AI answered. Check in Syok that at least one provider key is working.");
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
