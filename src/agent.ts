import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolDefs, makeCtx, runTool, undoAll, READONLY, type Ctx } from "./tools.ts";
import { runHooks } from "./hooks.ts";
import { startMcp } from "./mcp.ts";
import { langContext } from "./langs.ts";
import { pickProfile, type Profile } from "./profiles.ts";
import type { Mode, Asker, Settings } from "./perm.ts";

export const SYSTEM = `You are Syok Code, a careful senior software engineer working in the user's project folder on their own computer. You act only through the tools. You are specialised for programming: writing code from plain-language descriptions in any language, debugging, translating code between languages, explaining code and writing tests. If asked for something unrelated to programming, say briefly that you only help with code and stop.
Rules:
1. Explore first (list_files, search, find_files, read_file). Never guess file contents.
2. Make the smallest change that fully solves the task. Match the existing style. Do not reformat unrelated code.
3. Use edit_file for changes to existing files (old_text must be exact and unique). Use write_file only for new files.
4. After changing code, run the project's tests or build with run_command and fix failures you caused. If there are no tests, run a quick check or say so.
5. Never write secrets, tokens or keys into files. Do not touch .git, .env or .github/workflows.
6. If a tool says it was blocked or the user said no, do not try to get around it; explain and continue another way or finish.
7. For big searches or reading many files, use delegate with role explorer so your own memory stays small; several explorers can run at once. Use a worker only for one self-contained change.
8. Use bg_start for servers or watchers that keep running; never start them with run_command.
9. When finished, call finish with a short plain summary of what you changed and what you checked. If the task is impossible or unsafe, call finish and explain why.`;

export interface Msg { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string; name?: string }
export interface Result { summary: string; steps: number; tokens: number; touched: string[]; stopped: string; messages: Msg[]; ranTests: boolean }
export interface Opts {
  root: string; task: string; base: string; key: string; model?: string; mode?: Mode; ask?: Asker; settings?: Settings;
  profile?: Profile; fetchImpl?: typeof fetch; log?: (s: string) => void; ctx?: Ctx; history?: Msg[]; signal?: AbortSignal;
  onToken?: (s: string) => void; system?: string;
}
export function loadInstructions(root: string): string {
  for (const f of ["SYOK.md", "AGENTS.md", "CLAUDE.md"]) {
    const p = join(root, f);
    if (existsSync(p)) return `\n\nProject instructions (${f}):\n` + readFileSync(p, "utf8").slice(0, 8000);
  }
  return "";
}
const size = (m: Msg[]) => m.reduce((n, x) => n + (typeof x.content === "string" ? x.content.length : 0) + (x.tool_calls ? JSON.stringify(x.tool_calls).length : 0), 0);
/** Shorten old tool results when the chat gets long. Newest keepRecent results stay whole. */
export function compact(messages: Msg[], p: Profile): number {
  if (size(messages) <= p.compactAtChars) return 0;
  const idx = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  let n = 0;
  for (const i of idx.slice(0, Math.max(0, idx.length - p.keepRecent))) {
    const c = messages[i].content as string;
    if (typeof c === "string" && c.length > 240 && !c.startsWith("[old output")) { messages[i].content = `[old output shortened] ${c.slice(0, 160).replace(/\s+/g, " ")} ...`; n++; }
  }
  return n;
}
const EXPLORER = `You are a read-only research helper for Syok Code. Answer the question you were given using list_files, read_file, search and find_files. Change nothing. When done call finish with a compact answer: exact file paths with line numbers and the facts needed, no padding.`;
const WORKER = `You are a focused helper for Syok Code. Do only the sub-task you were given, with the smallest change, then run the relevant check and call finish with the files you changed and the result.`;
async function readSSE(body: ReadableStream<Uint8Array>, on: (s: string) => void) {
  const rd = body.getReader(), dec = new TextDecoder();
  let buf = "", content = "", usage: any, streamed = false; const calls: any[] = [];
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const d = line.slice(5).trim(); if (!d || d === "[DONE]") return;
    let j: any; try { j = JSON.parse(d); } catch { return; }
    if (j.usage) usage = j.usage;
    const dl = j.choices?.[0]?.delta; if (!dl) return;
    if (typeof dl.content === "string" && dl.content) { content += dl.content; streamed = true; on(dl.content); }
    for (const t of dl.tool_calls || []) {
      const i = t.index ?? 0; const c = (calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (t.id) c.id = t.id; if (t.function?.name && !c.function.name) c.function.name = t.function.name;
      if (t.function?.arguments) c.function.arguments += t.function.arguments;
    }
  };
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i).replace(/\r$/, "")); buf = buf.slice(i + 1); }
  }
  if (buf.trim()) handle(buf.trim());
  const tc = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || "call_" + i }));
  return { choices: [{ message: { role: "assistant", content, ...(tc.length ? { tool_calls: tc } : {}) } }], usage, __streamed: streamed } as any;
}
/** Shrinks a long HTML error page (for example Cloudflare's) to its title and error code so messages stay readable. */
export const briefBody = (raw: string): string => {
  if (!/^\s*<(!doctype|html)/i.test(raw)) return raw.slice(0, 300);
  const title = (raw.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
  const code = raw.match(/Error code:?\s*(\d{3,4})/i)?.[1] || raw.match(/\bError (1\d{3})\b/)?.[1] || "";
  const text = raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return ("[web page] " + (title || text.slice(0, 120)) + (code ? " (error code " + code + ")" : "") + " | " + text.slice(0, 160)).slice(0, 300);
};

/** Your Syok address, with or without a trailing slash or /v1 (the Developer API page shows it with /v1). */
export const chatUrl = (base: string) => base.trim().replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/chat/completions";
async function chat(base: string, key: string, body: any, f: typeof fetch, signal?: AbortSignal, onToken?: (s: string) => void) {
  let last = "";
  for (let a = 0; a < 6; a++) {
    let emitted = false; let wait = [700, 2800, 6000, 12000, 20000][a] ?? 0;
    try {
      const payload = onToken ? { ...body, stream: true, stream_options: { include_usage: true } } : body;
      const r = await f(chatUrl(base), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify(payload), signal });
      if (r.ok) {
        if (onToken && r.body && (r.headers.get("content-type") || "").includes("text/event-stream")) return await readSSE(r.body, (s) => { emitted = true; onToken(s); });
        return await r.json() as any;
      }
      const bodyText = briefBody(await r.text());
      last = `HTTP ${r.status} from ${chatUrl(base).replace(/^(https?:\/\/[^/]+).*/, "$1")}: ${bodyText}`;
      if (/daily_limit_reached/.test(bodyText)) { last = "This Syok key reached its daily limit (it resets at midnight UTC; you can raise the limit in Syok > Developer API). " + last; break; }
      if (![408, 409, 425, 429, 500, 502, 503, 504].includes(r.status)) break;
      const ra = Number(r.headers.get("retry-after")); if (ra > 0) wait = Math.min(30000, Math.max(wait, ra * 1000));
    } catch (e: any) { if (signal?.aborted) throw e; if (emitted) throw new Error("The connection dropped while the answer was streaming: " + (e.message || e)); last = e.message || String(e); }
    if (a < 5) await new Promise((ok) => setTimeout(ok, wait));
  }
  throw new Error("The AI service failed: " + last);
}
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + "\n...[cut]");
export async function runAgent(o: Opts): Promise<Result> {
  const model = o.model || "syok-coder";
  const profile = o.profile || pickProfile(model);
  const ask: Asker = o.ask || (async () => false);
  const settings = o.settings || {};
  const ownsCtx = !o.ctx;
  const ctx = o.ctx || makeCtx(o.root, o.mode || "ask", ask, settings, profile);
  const log = o.log || (() => {});
  if (ownsCtx && settings.mcpServers) ctx.mcp = await startMcp(settings.mcpServers, ctx.root, log);
  try { return await loop(o, ctx, model, profile, log); }
  finally { if (ownsCtx) { ctx.bg.stopAll(); ctx.mcp.forEach((m) => m.stop()); } }
}
async function loop(o: Opts, ctx: Ctx, model: string, profile: Profile, log: (s: string) => void): Promise<Result> {
  const hooks = ctx.settings.hooks || {};
  const messages: Msg[] = o.history ? [...o.history] : [{ role: "system", content: (o.system || SYSTEM) + loadInstructions(ctx.root) + (ctx.depth === 0 ? langContext(ctx.root) : "") + (profile.systemExtra ? "\n" + profile.systemExtra : "") }];
  messages.push({ role: "user", content: o.history ? o.task : `Task:\n${o.task}\n\nThe project is in the current folder.` });
  const f = o.fetchImpl || fetch;
  let steps = 0, tokens = 0, summary = "", stopped = "", nudged = false, repeats = 0, lastSig = "", stopTries = 0;
  const sub = async (task: string, role: string): Promise<string> => {
    const explorer = role !== "worker";
    const child: Ctx = { ...ctx, depth: ctx.depth + 1, allowed: explorer ? READONLY : undefined };
    const r = await runAgent({ root: ctx.root, task, base: o.base, key: o.key, model, mode: ctx.mode, ask: ctx.ask, settings: ctx.settings, profile: { ...profile, maxSteps: Math.min(profile.maxSteps, 20) }, fetchImpl: f, log: (s) => log("  [" + role + "] " + s), ctx: child, system: explorer ? EXPLORER : WORKER, signal: o.signal });
    tokens += r.tokens;
    return clip(`(${role} finished in ${r.steps} steps, ${r.stopped})\n${r.summary}`, 6000);
  };
  const stopGate = async (): Promise<boolean> => {
    if (ctx.depth > 0 || !hooks.Stop?.length || stopTries >= 2) return false;
    const h = await runHooks(hooks.Stop, "Stop", { cwd: ctx.root, touched: [...ctx.touched] }, ctx.root);
    if (!h.block) { if (h.message) log("[hook] " + h.message); return false; }
    stopTries++; messages.push({ role: "user", content: "A Stop hook says the work is not done yet:\n" + h.message + "\nFix this, then finish again." }); log("[hook blocked finishing] " + h.message); return true;
  };
  while (steps < profile.maxSteps) {
    steps++;
    if (compact(messages, profile)) log("(older tool output shortened to save room)");
    const res = await chat(o.base, o.key, { model, messages, tools: toolDefs(ctx), tool_choice: "auto", temperature: profile.temperature }, f, o.signal, o.onToken);
    tokens += res.usage?.total_tokens || 0;
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error("The AI service returned no message.");
    messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (res.__streamed) o.onToken?.("\n"); else if (msg.content) log(String(msg.content));
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      if (profile.nudgeTests && !nudged && ctx.touched.size && !ctx.ran.tests) { nudged = true; messages.push({ role: "user", content: "You changed files but have not run any tests or checks. Run them now, or call finish and say why you could not." }); continue; }
      if (await stopGate()) continue;
      summary = String(msg.content || "(no summary)"); stopped = "answered"; break;
    }
    // explorers in the same message run side by side (up to 4); everything else runs in order
    const parsed = calls.map((tc: any) => { let args: any = null; try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {} return args; });
    const early = new Map<number, Promise<string>>();
    if (ctx.depth === 0) calls.forEach((tc: any, i: number) => { const a = parsed[i]; if (tc.function?.name === "delegate" && a && (a.role || "explorer") === "explorer" && early.size < 4) early.set(i, sub(String(a.task || ""), "explorer").catch((e) => "Error: " + e.message)); });
    let finished = false;
    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i]; const name = tc.function?.name; const args = parsed[i];
      if (args === null) { messages.push({ role: "tool", tool_call_id: tc.id, name, content: "Error: the tool arguments were not valid JSON. Send the call again with valid JSON." }); continue; }
      if (name === "finish") {
        messages.push({ role: "tool", tool_call_id: tc.id, name, content: "ok" });
        if (await stopGate()) { for (let j = i + 1; j < calls.length; j++) messages.push({ role: "tool", tool_call_id: calls[j].id, name: calls[j].function?.name, content: "skipped" }); break; }
        summary = String(args.summary || ""); stopped = "finished"; finished = true; break;
      }
      const sig = name + JSON.stringify(args); repeats = sig === lastSig ? repeats + 1 : 0; lastSig = sig;
      let out: string;
      if (repeats >= 5) { stopped = "stuck"; summary = "Stopped: the AI kept repeating the same step."; finished = true; out = "stopped"; }
      else if (repeats >= 2) out = "You have made this exact call several times with the same result. Try a different approach.";
      else if (name === "delegate") {
        if (ctx.depth > 0) out = "Error: helpers cannot delegate further.";
        else { log(`> delegate ${JSON.stringify(args).slice(0, 140)}`); out = await (early.get(i) ?? sub(String(args.task || ""), args.role === "worker" ? "worker" : "explorer").catch((e) => "Error: " + e.message)); }
      } else {
        log(`> ${name} ${JSON.stringify(args).slice(0, 140)}`);
        const pre = await runHooks(hooks.PreToolUse, "PreToolUse", { tool: name, args, cwd: ctx.root }, ctx.root, name);
        if (pre.block) out = "Blocked by a hook: " + (pre.message || "no reason given");
        else {
          out = await runTool(ctx, name, args);
          const post = await runHooks(hooks.PostToolUse, "PostToolUse", { tool: name, args, result: out.slice(0, 2000), cwd: ctx.root }, ctx.root, name);
          if (post.message) out += "\n[hook] " + post.message;
        }
      }
      messages.push({ role: "tool", tool_call_id: tc.id, name, content: out });
      if (finished) break;
    }
    // any explorers we started but never reached must still finish before we move on
    await Promise.allSettled([...early.values()]);
    if (finished) break;
  }
  if (!stopped) { stopped = "max_steps"; summary = `Stopped after ${profile.maxSteps} steps without finishing.`; }
  return { summary, steps, tokens, touched: [...ctx.touched], stopped, messages, ranTests: ctx.ran.tests };
}
export { makeCtx, undoAll };
