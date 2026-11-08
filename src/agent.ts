import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, makeCtx, runTool, undoAll, type Ctx } from "./tools.ts";
import { pickProfile, type Profile } from "./profiles.ts";
import type { Mode, Asker, Settings } from "./perm.ts";

export const SYSTEM = `You are Syok Code, a careful senior software engineer working in the user's project folder on their own computer. You act only through the tools.
Rules:
1. Explore first (list_files, search, find_files, read_file). Never guess file contents.
2. Make the smallest change that fully solves the task. Match the existing style. Do not reformat unrelated code.
3. Use edit_file for changes to existing files (old_text must be exact and unique). Use write_file only for new files.
4. After changing code, run the project's tests or build with run_command and fix failures you caused. If there are no tests, run a quick check or say so.
5. Never write secrets, tokens or keys into files. Do not touch .git, .env or .github/workflows.
6. If a tool says it was blocked or the user said no, do not try to get around it; explain and continue another way or finish.
7. When finished, call finish with a short plain summary of what you changed and what you checked. If the task is impossible or unsafe, call finish and explain why.`;

export interface Msg { role: string; content?: any; tool_calls?: any[]; tool_call_id?: string; name?: string }
export interface Result { summary: string; steps: number; tokens: number; touched: string[]; stopped: string; messages: Msg[]; ranTests: boolean }
export interface Opts {
  root: string; task: string; base: string; key: string; model?: string; mode?: Mode; ask?: Asker; settings?: Settings;
  profile?: Profile; fetchImpl?: typeof fetch; log?: (s: string) => void; ctx?: Ctx; history?: Msg[]; signal?: AbortSignal;
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
async function chat(base: string, key: string, body: any, f: typeof fetch, signal?: AbortSignal) {
  let last = "";
  for (let a = 0; a < 4; a++) {
    try {
      const r = await f(base.replace(/\/+$/, "") + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify(body), signal });
      if (r.ok) return await r.json() as any;
      last = `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`;
      if (![408, 409, 425, 429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e: any) { if (signal?.aborted) throw e; last = e.message || String(e); }
    await new Promise((ok) => setTimeout(ok, 700 * (a + 1) ** 2));
  }
  throw new Error("The AI service failed: " + last);
}
export async function runAgent(o: Opts): Promise<Result> {
  const model = o.model || "syok-auto";
  const profile = o.profile || pickProfile(model);
  const ask: Asker = o.ask || (async () => false);
  const ctx = o.ctx || makeCtx(o.root, o.mode || "ask", ask, o.settings || {}, profile);
  const log = o.log || (() => {});
  const messages: Msg[] = o.history ? [...o.history] : [{ role: "system", content: SYSTEM + loadInstructions(ctx.root) + (profile.systemExtra ? "\n" + profile.systemExtra : "") }];
  messages.push({ role: "user", content: o.history ? o.task : `Task:\n${o.task}\n\nThe project is in the current folder.` });
  const f = o.fetchImpl || fetch;
  let steps = 0, tokens = 0, summary = "", stopped = "", nudged = false, repeats = 0, lastSig = "";
  while (steps < profile.maxSteps) {
    steps++;
    if (compact(messages, profile)) log("(older tool output shortened to save room)");
    const res = await chat(o.base, o.key, { model, messages, tools: TOOLS, tool_choice: "auto", temperature: profile.temperature }, f, o.signal);
    tokens += res.usage?.total_tokens || 0;
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new Error("The AI service returned no message.");
    messages.push({ role: "assistant", content: msg.content ?? "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.content) log(String(msg.content));
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      if (profile.nudgeTests && !nudged && ctx.touched.size && !ctx.ran.tests) { nudged = true; messages.push({ role: "user", content: "You changed files but have not run any tests or checks. Run them now, or call finish and say why you could not." }); continue; }
      summary = String(msg.content || "(no summary)"); stopped = "answered"; break;
    }
    let finished = false;
    for (const tc of calls) {
      const name = tc.function?.name; let args: any = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { messages.push({ role: "tool", tool_call_id: tc.id, name, content: "Error: the tool arguments were not valid JSON. Send the call again with valid JSON." }); continue; }
      if (name === "finish") { summary = String(args.summary || ""); stopped = "finished"; finished = true; messages.push({ role: "tool", tool_call_id: tc.id, name, content: "ok" }); break; }
      const sig = name + JSON.stringify(args); repeats = sig === lastSig ? repeats + 1 : 0; lastSig = sig;
      let out: string;
      if (repeats >= 5) { stopped = "stuck"; summary = "Stopped: the AI kept repeating the same step."; finished = true; out = "stopped"; }
      else if (repeats >= 2) out = "You have made this exact call several times with the same result. Try a different approach.";
      else { log(`> ${name} ${JSON.stringify(args).slice(0, 140)}`); out = await runTool(ctx, name, args); }
      messages.push({ role: "tool", tool_call_id: tc.id, name, content: out });
      if (finished) break;
    }
    if (finished) break;
  }
  if (!stopped) { stopped = "max_steps"; summary = `Stopped after ${profile.maxSteps} steps without finishing.`; }
  return { summary, steps, tokens, touched: [...ctx.touched], stopped, messages, ranTests: ctx.ran.tests };
}
export { makeCtx, undoAll };
