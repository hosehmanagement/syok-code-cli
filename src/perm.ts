// Permission rules: what the agent may do without asking.
export type Mode = "ask" | "accept-edits" | "plan" | "auto";
export const MODES: Mode[] = ["ask", "accept-edits", "plan", "auto"];
export const PROTECTED = [/(^|\/)\.git\//, /(^|\/)\.github\/workflows\//i,/(^|\/)\.env($|\.)/, /(^|\/)(id_rsa|id_ed25519)/, /\.(pem|key|p12|pfx)$/i];
export const SECRET_LIKE = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|syk_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
// Commands that are never run, in any mode.
export const DENY = [
  /\bsudo\b/, /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\*)(\s|$)/i, /\bmkfs\b/, /\bdd\s+if=/, /:\(\)\s*\{/,
  /\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba|z)?sh\b/, /\bgit\s+push\b[^;&|]*(--force|-f\b)/, /\bchmod\s+-R\s+777\s+\//,
  />\s*\/dev\/(sd|nvme)/, /\b(shutdown|reboot|halt)\b/, /\bgit\s+remote\s+(add|set-url)\b/,
  // Windows (PowerShell and Command Prompt)
  /\bRemove-Item\b[^;&|\n]*-Recurse[^;&|\n]*([A-Za-z]:\\?(\s|$|['"])|\\\*|~|\$env:(USERPROFILE|HOMEPATH|SystemRoot|windir)|\$HOME)/i,
  /\bRemove-Item\b[^;&|\n]*\s[A-Za-z]:\\?(\s|$)[^;&|\n]*-Recurse/i,
  /\b(rd|rmdir)\s+\/s\b[^;&|\n]*\b[A-Za-z]:\\?(\s|$)/i, /\bdel\s+(\/[a-z]\s+)*[A-Za-z]:\\/i,
  /\bFormat-Volume\b/i, /\bformat\s+[A-Za-z]:/i, /\b(Stop-Computer|Restart-Computer)\b/i, /\bSet-ExecutionPolicy\b/i,
  /\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod|curl|wget)\b[^|;\n]*\|\s*(iex|Invoke-Expression)\b/i,
  /\b(iex|Invoke-Expression)\b[^;\n]*\b(DownloadString|iwr|irm|Invoke-WebRequest)\b/i,
  /\breg\s+(add|delete)\s+"?HK(LM|EY_LOCAL_MACHINE)/i, /\bnet\s+user\b/i, /\bbcdedit\b/i,
];
// Read-only Windows commands (PowerShell and Command Prompt).
export const SAFE_WIN = [/^(Get-ChildItem|Get-Content|Get-Location|Get-Item|Select-String|Test-Path|Write-Output|Write-Host|dir|type|where)\b/i];
// Commands treated as safe (tests, builds, read-only inspection): run without asking in every mode.
export const SAFE = [
  /^(ls|pwd|cat|head|tail|wc|echo|grep|rg|find|git (status|diff|log|show|branch)|which|node -v|python3? --version)\b/,
  /^(npm|pnpm|yarn|bun) (test|run (test|build|lint|check|typecheck|type-check))\b/, /^(npx |bunx )?(tsc|eslint|prettier --check)\b/,
  /^(pytest|python3? -m (pytest|unittest)|go (test|vet)|cargo (test|build|check)|node --test|make (test|check|build))\b/,
];
export interface Settings { allow?: string[]; deny?: string[];
  /** Hold the AI's commands inside the project folder (Linux, Mac): true, or "no-network" to cut the network too. */
  confine?: boolean | "no-network";
  /** Memory across chats (short notes the AI saves and reads back; kept in ~/.syok/memory on this computer): false switches it off. */
  memory?: boolean;
  /** Language helpers (exact definitions, uses and compiler errors): false switches them off; or name your own per language,
   *  for example { "python": { "command": "pylsp" } }. Syok Code never downloads one by itself. See "syok lang". */
  lsp?: false | Record<string, { command: string; args?: string[] } | false>;
  /** Parallel editing: how many workers may change the project at the same time, each in its own copy (default 2, at most 8). 0 or false switches it off. */
  parallel_workers?: number | boolean;
  /** The usage history in ~/.syok/usage (token counts per AI call, never the text): false switches it off. */
  usage_log?: boolean;
  /** Skills the AI may open by itself (it is shown their names and descriptions): false switches that off; /<skill> still works. */
  skills?: boolean;
  /** Custom helpers (.syok/agents and the files of other tools): false switches them off. */
  agents?: boolean;
  /** run_command: default seconds (120) and the most the AI may ask for (600). Hard ceiling 24 hours. */
  timeout_sec?: number; max_timeout_sec?: number;
  /** Web tools (web_search, web_fetch): false switches them off. allow_hosts: sites that may be read without asking (sub-domains included). */
  web?: boolean; allow_hosts?: string[];
  /** Checks after edits: false switches off the syntax check after each edit and the project check before finishing. check_command: your own project check (for example "npm run typecheck"). */
  checks?: boolean; check_command?: string;
  /** Optional prices in US dollars per million tokens, by a piece of the model or provider name, to show an estimated cost: { "gpt-5": { "in": 1.25, "out": 10 } } */
  prices?: Record<string, { in?: number; out?: number }>;
  /** General terminal mode: not only programming. */
  general?: boolean; hooks?: Record<string, Array<{ match?: string; command: string; timeout_sec?: number }>>; mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }> }
export type Asker = (what: string, detail: string) => Promise<boolean>;
export function isProtected(rel: string): boolean { return PROTECTED.some((r) => r.test(rel.replace(/\\/g, "/"))); }
// Workflow files (.github/workflows/*.yml|yaml) are protected unless YOU allow them: allow_workflow_edits in your own
// ~/.syok/config.json (syok setup), or --allow-workflow-edits for one run. A project's .syok/settings.json cannot do it.
export const WORKFLOW_FILE = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i;
export const WORKFLOW_WARNING = "WARNING: this file controls what runs in your GitHub Actions and can read your repository secrets.";
export interface WorkflowEdits { /** allow_workflow_edits: true in your own ~/.syok/config.json */ config?: boolean; /** --allow-workflow-edits on the command line for this run */ flag?: boolean; /** the cloud @syok job (GitHub Actions): never */ cloud?: boolean }
/** null when rel is not a workflow file; otherwise whether the edit may happen and whether the user must be asked. */
export function workflowRule(mode: Mode, w: WorkflowEdits | undefined, rel: string): { ok: false; why: string } | { ok: true; ask: boolean } | null {
  if (!WORKFLOW_FILE.test(rel.replace(/\\/g, "/"))) return null;
  if (w?.cloud) return { ok: false, why: "Workflow files are never changed by the cloud @syok job." };
  if (!w?.config && !w?.flag) return { ok: false, why: "Workflow files decide what runs in GitHub Actions. Only the user can allow edits: allow_workflow_edits in their own ~/.syok/config.json (syok setup), or --allow-workflow-edits for one run." };
  if (mode === "plan") return { ok: false, why: "Plan mode: nothing changes until the user approves the plan." };
  if (mode === "auto") return w.flag ? { ok: true, ask: false } : { ok: false, why: "In auto mode nobody is asked, so workflow edits need --allow-workflow-edits on the command line for this run; the saved setting alone is not enough." };
  return { ok: true, ask: true };
}
/** "" when rel may be edited (allowEdit still decides about asking), otherwise the error for the AI. */
export function editBlocked(mode: Mode, w: WorkflowEdits | undefined, rel: string): string {
  const r = workflowRule(mode, w, rel);
  if (r) return r.ok ? "" : `Error: ${rel} is protected and cannot be changed. ${r.why}`;
  return isProtected(rel) ? `Error: ${rel} is protected and cannot be changed.` : "";
}
export function checkCommand(cmd: string, s: Settings = {}): "deny" | "safe" | "other" {
  const c = cmd.trim();
  if (DENY.some((r) => r.test(c)) || (s.deny || []).some((p) => c.includes(p))) return "deny";
  const parts = c.split(/&&|;|\|\|?|\n/).map((x) => x.trim()).filter(Boolean);
  if (parts.length && parts.every((p) => SAFE.some((r) => r.test(p)) || SAFE_WIN.some((r) => r.test(p)) || (s.allow || []).some((a) => p.startsWith(a)))) return "safe";
  return "other";
}
export async function allowEdit(mode: Mode, ask: Asker, rel: string, preview: string, w?: WorkflowEdits) {
  if (mode === "plan") return false;
  const r = workflowRule(mode, w, rel); // asked every time in ask and accept-edits, with the warning above the diff
  if (r) return r.ok && (!r.ask || ask("edit " + rel, WORKFLOW_WARNING + "\n" + preview));
  return mode === "ask" ? ask("edit " + rel, preview) : true;
}
export async function allowCommand(mode: Mode, ask: Asker, cmd: string, s: Settings) {
  const k = checkCommand(cmd, s);
  if (k === "deny") return { ok: false, why: "That command is blocked by Syok Code's safety rules." };
  if (mode === "plan") return k === "safe" ? { ok: true, why: "" } : { ok: false, why: "Plan mode: only read-only commands run. Finish with your plan; the user approves it before anything changes." };
  if (mode === "auto" || k === "safe") return { ok: true, why: "" };
  return (await ask("run command", cmd)) ? { ok: true, why: "" } : { ok: false, why: "The user did not allow this command." };
}
