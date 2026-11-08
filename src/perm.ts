// Permission rules: what the agent may do without asking.
export type Mode = "ask" | "accept-edits" | "auto";
export const PROTECTED = [/(^|\/)\.git\//, /(^|\/)\.github\/workflows\//, /(^|\/)\.env($|\.)/, /(^|\/)(id_rsa|id_ed25519)/, /\.(pem|key|p12|pfx)$/i];
export const SECRET_LIKE = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|syk_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
// Commands that are never run, in any mode.
export const DENY = [
  /\bsudo\b/, /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\*)(\s|$)/i, /\bmkfs\b/, /\bdd\s+if=/, /:\(\)\s*\{/,
  /\b(curl|wget)\b[^|;]*\|\s*(sudo\s+)?(ba|z)?sh\b/, /\bgit\s+push\b[^;&|]*(--force|-f\b)/, /\bchmod\s+-R\s+777\s+\//,
  />\s*\/dev\/(sd|nvme)/, /\b(shutdown|reboot|halt)\b/, /\bgit\s+remote\s+(add|set-url)\b/,
];
// Commands treated as safe (tests, builds, read-only inspection): run without asking in every mode.
export const SAFE = [
  /^(ls|pwd|cat|head|tail|wc|echo|grep|rg|find|git (status|diff|log|show|branch)|which|node -v|python3? --version)\b/,
  /^(npm|pnpm|yarn|bun) (test|run (test|build|lint|check|typecheck))\b/, /^(npx |bunx )?(tsc|eslint|prettier --check)\b/,
  /^(pytest|python3? -m (pytest|unittest)|go test|cargo (test|build|check)|node --test|make (test|check|build))\b/,
];
export interface Settings { allow?: string[]; deny?: string[]; hooks?: Record<string, Array<{ match?: string; command: string; timeout_sec?: number }>>; mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> }
export type Asker = (what: string, detail: string) => Promise<boolean>;
export function isProtected(rel: string): boolean { return PROTECTED.some((r) => r.test(rel.replace(/\\/g, "/"))); }
export function checkCommand(cmd: string, s: Settings = {}): "deny" | "safe" | "other" {
  const c = cmd.trim();
  if (DENY.some((r) => r.test(c)) || (s.deny || []).some((p) => c.includes(p))) return "deny";
  const parts = c.split(/&&|;|\|\|?|\n/).map((x) => x.trim()).filter(Boolean);
  if (parts.length && parts.every((p) => SAFE.some((r) => r.test(p)) || (s.allow || []).some((a) => p.startsWith(a)))) return "safe";
  return "other";
}
export async function allowEdit(mode: Mode, ask: Asker, rel: string, preview: string) {
  return mode === "ask" ? ask("edit " + rel, preview) : true;
}
export async function allowCommand(mode: Mode, ask: Asker, cmd: string, s: Settings) {
  const k = checkCommand(cmd, s);
  if (k === "deny") return { ok: false, why: "That command is blocked by Syok Code's safety rules." };
  if (mode === "auto" || k === "safe") return { ok: true, why: "" };
  return (await ask("run command", cmd)) ? { ok: true, why: "" } : { ok: false, why: "The user did not allow this command." };
}
