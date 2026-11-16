// Permission rules: what the agent may do without asking.
export type Mode = "ask" | "accept-edits" | "plan" | "auto";
export const MODES: Mode[] = ["ask", "accept-edits", "plan", "auto"];
export const PROTECTED = [/(^|\/)\.git\//, /(^|\/)\.github\/workflows\//, /(^|\/)\.env($|\.)/, /(^|\/)(id_rsa|id_ed25519)/, /\.(pem|key|p12|pfx)$/i];
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
  /^(npm|pnpm|yarn|bun) (test|run (test|build|lint|check|typecheck))\b/, /^(npx |bunx )?(tsc|eslint|prettier --check)\b/,
  /^(pytest|python3? -m (pytest|unittest)|go test|cargo (test|build|check)|node --test|make (test|check|build))\b/,
];
export interface Settings { allow?: string[]; deny?: string[];
  /** run_command: default seconds (120) and the most the AI may ask for (600). Hard ceiling 24 hours. */
  timeout_sec?: number; max_timeout_sec?: number;
  /** Web tools (web_search, web_fetch): false switches them off. allow_hosts: sites that may be read without asking (sub-domains included). */
  web?: boolean; allow_hosts?: string[];
  /** General terminal mode: not only programming. */
  general?: boolean; hooks?: Record<string, Array<{ match?: string; command: string; timeout_sec?: number }>>; mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }
export type Asker = (what: string, detail: string) => Promise<boolean>;
export function isProtected(rel: string): boolean { return PROTECTED.some((r) => r.test(rel.replace(/\\/g, "/"))); }
export function checkCommand(cmd: string, s: Settings = {}): "deny" | "safe" | "other" {
  const c = cmd.trim();
  if (DENY.some((r) => r.test(c)) || (s.deny || []).some((p) => c.includes(p))) return "deny";
  const parts = c.split(/&&|;|\|\|?|\n/).map((x) => x.trim()).filter(Boolean);
  if (parts.length && parts.every((p) => SAFE.some((r) => r.test(p)) || SAFE_WIN.some((r) => r.test(p)) || (s.allow || []).some((a) => p.startsWith(a)))) return "safe";
  return "other";
}
export async function allowEdit(mode: Mode, ask: Asker, rel: string, preview: string) {
  if (mode === "plan") return false;
  return mode === "ask" ? ask("edit " + rel, preview) : true;
}
export async function allowCommand(mode: Mode, ask: Asker, cmd: string, s: Settings) {
  const k = checkCommand(cmd, s);
  if (k === "deny") return { ok: false, why: "That command is blocked by Syok Code's safety rules." };
  if (mode === "plan") return k === "safe" ? { ok: true, why: "" } : { ok: false, why: "Plan mode: only read-only commands run. Finish with your plan; the user approves it before anything changes." };
  if (mode === "auto" || k === "safe") return { ok: true, why: "" };
  return (await ask("run command", cmd)) ? { ok: true, why: "" } : { ok: false, why: "The user did not allow this command." };
}
