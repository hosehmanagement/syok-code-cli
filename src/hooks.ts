// Hooks: your own commands that run around the AI's actions. Configure in .syok/settings.json:
//   { "hooks": { "PreToolUse": [{ "match": "edit_file|write_file", "command": "./check.sh" }],
//                "PostToolUse": [{ "match": "edit_file", "command": "npx prettier --write ." }],
//                "Stop": [{ "command": "npm test" }] } }
// The command gets the event as JSON on its input. Exit code 2 blocks (PreToolUse) or sends the message back to the AI (Stop).
//
// Hooks that came with a Claude Code plugin ("claude" holds their matcher) are run the way Claude Code runs them
// (https://code.claude.com/docs/en/hooks): they match Claude's tool names (Bash, Edit, Write, Read...), get Claude's JSON
// (hook_event_name, tool_name, tool_input with file_path, old_string, ...), get CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and
// CLAUDE_PROJECT_DIR, and may answer with Claude's JSON (decision, permissionDecision, additionalContext, continue).
// A hook can only stop or add to what the AI does; it never lifts a permission ("allow" is ignored: Syok Code still asks).
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spawnCommand, killTree, cleanEnv } from "./shell.ts";
import { pluginDataDir, pluginDir, pluginEnv } from "./plugins.ts";
import { claudePaths } from "./skills.ts";
export interface Hook {
  match?: string; command: string; timeout_sec?: number;
  /** A Claude Code hook: its matcher, over Claude's tool names ("*" = every tool). */
  claude?: string;
  /** Claude's "async": run it in the background; nothing waits for it and its answer is not read. */
  async?: boolean;
  /** The plugin it came with and that plugin's folder. */
  plugin?: string; pluginRoot?: string;
}
export interface HookResult {
  block: boolean; message: string;
  /** Extra text for the AI (Claude's additionalContext, or plain output of UserPromptSubmit and SessionStart hooks). */
  context?: string;
  /** Something to show the user only. */
  notice?: string;
}
export interface HookInfo { tool?: string; args?: any; result?: string; prompt?: string; source?: string; sessionId?: string; touched?: string[] }

/** Syok's tool names as Claude Code calls the same tools. */
export const CLAUDE_TOOL: Record<string, string> = {
  run_command: "Bash", bg_start: "Bash", job_start: "Bash", pty_start: "Bash", write_file: "Write", edit_file: "Edit", read_file: "Read", list_files: "LS",
  find_files: "Glob", search: "Grep", find_symbol: "Grep", outline: "Grep", web_fetch: "WebFetch", web_search: "WebSearch", delegate: "Task", parallel_edit: "Task", skill: "Skill",
};
export const claudeToolName = (t: string) => CLAUDE_TOOL[t] || t;
/** Claude's matcher rules: "", "*" = all; only letters, digits, _ - , | and spaces = exact names; anything else = a regular expression. */
export function claudeMatches(matcher: string | undefined, toolName: string): boolean {
  const m = (matcher || "").trim();
  if (!m || m === "*") return true;
  if (/^[\w\s,|-]+$/.test(m)) return m.split(/[|,]/).map((x) => x.trim()).filter(Boolean).includes(toolName);
  try { return new RegExp(m).test(toolName); } catch { return false; }
}
/** The tool call as Claude Code would describe it. */
export function claudeInput(tool: string, a: any, root: string): Record<string, unknown> {
  const abs = (p: unknown) => { const s = String(p ?? "."); return isAbsolute(s) ? s : resolve(root, s); };
  a = a || {};
  switch (tool) {
    case "run_command": return { command: String(a.command ?? ""), ...(a.timeout_sec ? { timeout: Number(a.timeout_sec) * 1000 } : {}) };
    case "bg_start": case "job_start": case "pty_start": return { command: String(a.command ?? ""), run_in_background: true };
    case "write_file": return { file_path: abs(a.path), content: String(a.content ?? "") };
    case "edit_file": return { file_path: abs(a.path), old_string: String(a.old_text ?? ""), new_string: String(a.new_text ?? ""), replace_all: !!a.replace_all };
    case "read_file": return { file_path: abs(a.path), ...(a.start_line ? { offset: Number(a.start_line) } : {}), ...(a.start_line && a.end_line ? { limit: Number(a.end_line) - Number(a.start_line) + 1 } : {}) };
    case "list_files": return { path: abs(a.path) };
    case "find_files": return { pattern: String(a.pattern ?? "") };
    case "search": return { pattern: String(a.pattern ?? ""), ...(a.path ? { path: abs(a.path) } : {}), ...(a.glob ? { glob: String(a.glob) } : {}) };
    case "web_fetch": return { url: String(a.url ?? ""), prompt: "" };
    case "web_search": return { query: String(a.query ?? "") };
    default: return a;
  }
}
export { pluginDataDir };

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const CONTEXT_EVENTS = new Set(["UserPromptSubmit", "SessionStart"]);

export async function runHooks(hooks: Hook[] | undefined, event: string, payload: any, root: string, toolName = "", info: HookInfo = {}): Promise<HookResult> {
  const out: string[] = [], ctx: string[] = [], notes: string[] = []; let block = false;
  const tool = info.tool ?? payload?.tool ?? toolName;
  for (const h of hooks || []) {
    if (h.claude !== undefined) {
      if (TOOL_EVENTS.has(event)) { if (!tool || !claudeMatches(h.claude, claudeToolName(tool))) continue; }
      else if (event === "SessionStart" && !claudeMatches(h.claude, info.source || "startup")) continue;
      if (h.async) { void runClaude(h, event, root, tool, info.args ?? payload?.args, info.result ?? payload?.result, info).catch(() => {}); continue; }
      const r = await runClaude(h, event, root, tool, info.args ?? payload?.args, info.result ?? payload?.result, info);
      if (r.block) { block = true; out.push(r.message || "A hook blocked this."); } else if (r.message) out.push(r.message);
      if (r.context) ctx.push(r.context); if (r.notice) notes.push(r.notice);
      continue;
    }
    if (h.match && toolName && !new RegExp("^(" + h.match + ")$").test(toolName)) continue;
    if (h.match && !toolName) continue;
    const r = await one(h.command, { event, ...payload }, root, cleanEnv(), (h.timeout_sec || 30) * 1000);
    if (r.code === 2) { block = true; out.push(r.text || "A hook blocked this."); } else if (r.text) out.push(r.text);
  }
  return { block, message: out.join("\n").slice(0, 4000), ...(ctx.length ? { context: ctx.join("\n").slice(0, 8000) } : {}), ...(notes.length ? { notice: notes.join("\n").slice(0, 2000) } : {}) };
}

async function runClaude(h: Hook, event: string, root: string, tool: string, args: any, result: string | undefined, info: HookInfo): Promise<HookResult> {
  const plugin = h.plugin || (h.pluginRoot ? basename(h.pluginRoot) : "plugin");
  const data = pluginDataDir(plugin); try { mkdirSync(data, { recursive: true }); } catch {}
  const vars: Record<string, string> = { CLAUDE_PROJECT_DIR: root, CLAUDE_PLUGIN_ROOT: h.pluginRoot || root, CLAUDE_PLUGIN_DATA: data };
  let command = h.command;
  for (const [k, v] of Object.entries(vars)) command = command.split("${" + k + "}").join(v);
  command = claudePaths(command, (p) => pluginDir(p, root)); // hooks that name ~/.claude/plugins/... directly
  const input: Record<string, unknown> = { session_id: info.sessionId || "syok", transcript_path: "", cwd: root, permission_mode: "default", hook_event_name: event };
  if (TOOL_EVENTS.has(event)) { input.tool_name = claudeToolName(tool); input.tool_input = claudeInput(tool, args, root); input.tool_use_id = "syok-" + Date.now(); }
  if (event === "PostToolUse") input.tool_response = { output: String(result ?? "").slice(0, 20000) };
  if (event === "UserPromptSubmit") input.prompt = info.prompt ?? "";
  if (event === "SessionStart") input.source = info.source || "startup";
  if (event === "Stop") { input.stop_hook_active = false; }
  const timeout = (h.timeout_sec || (event === "UserPromptSubmit" ? 30 : 600)) * 1000;
  const r = await one(command, input, root, { ...pluginEnv(root, cleanEnv()), ...vars, SYOK_PLUGIN_ROOT: vars.CLAUDE_PLUGIN_ROOT }, timeout, true);
  const label = plugin + " hook";
  if (r.code === 2) return { block: true, message: r.err.trim() || r.out.trim() || `The ${label} said no.` };
  let j: any = null;
  const t = r.out.trim();
  if (t.startsWith("{")) { try { j = JSON.parse(t); } catch { j = null; } }
  if (j && typeof j === "object") {
    const hs = j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? j.hookSpecificOutput : {};
    const context = [hs.additionalContext, j.additionalContext].filter((x) => typeof x === "string" && x.trim()).join("\n");
    const notice = typeof j.systemMessage === "string" ? j.systemMessage : "";
    if (j.continue === false) return { block: true, message: String(j.stopReason || `The ${label} stopped this.`), context, notice };
    if (j.decision === "block") return { block: true, message: String(j.reason || `The ${label} said no.`), context, notice };
    // permissionDecision belongs in hookSpecificOutput; some hooks put it (and "reason") at the top level. Both mean no.
    const pd = hs.permissionDecision ?? j.permissionDecision;
    if (pd === "deny") return { block: true, message: String(hs.permissionDecisionReason || j.permissionDecisionReason || j.reason || `The ${label} said no.`), context, notice };
    return { block: false, message: "", context, notice: [notice, hs.updatedInput ? `(${label} asked to change the tool's input; Syok Code does not let hooks rewrite commands, so it ran unchanged)` : ""].filter(Boolean).join("\n") };
  }
  if (r.code !== 0) return { block: false, message: "", notice: `${label} failed (exit ${r.code}): ${(r.err || r.out).trim().slice(0, 500)}` };
  // Plain output: context for the AI on UserPromptSubmit and SessionStart; otherwise only for the user to see.
  return CONTEXT_EVENTS.has(event) ? { block: false, message: "", ...(t ? { context: t } : {}) } : { block: false, message: "", ...(t ? { notice: t.slice(0, 1000) } : {}) };
}

function one(command: string, payload: any, cwd: string, env: NodeJS.ProcessEnv, ms: number, raw = false): Promise<{ code: number; text: string; out: string; err: string }> {
  return new Promise((res) => {
    const ch = spawnCommand(command, cwd, env, ["pipe", "pipe", "pipe"]);
    let o = "", e = "", done = false;
    ch.stdout!.on("data", (d) => (o += d)); ch.stderr!.on("data", (d) => (e += d));
    ch.stdin!.on("error", () => {}); ch.stdin!.end(JSON.stringify(payload));
    const t = setTimeout(() => { if (!done) { killTree(ch); res({ code: 1, text: "hook timed out", out: o, err: "hook timed out" }); done = true; } }, ms);
    ch.on("close", (code) => { if (done) return; done = true; clearTimeout(t); const c = code ?? 1; res({ code: c, text: raw ? "" : ((c === 2 ? e || o : o) || "").trim(), out: o, err: e }); });
    ch.on("error", (er) => { if (done) return; done = true; clearTimeout(t); res({ code: 1, text: "hook failed: " + er.message, out: "", err: "hook failed: " + er.message }); });
  });
}
