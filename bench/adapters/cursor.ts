// Cursor CLI. Checked against the official docs on 22 Nov 2026:
//   https://cursor.com/docs/cli/reference/parameters  (binary `agent`; -p/--print, --output-format text|json|stream-json, --model,
//                                                     -f/--force, --trust (headless only), --workspace, `status`/`whoami`)
//   https://cursor.com/docs/cli/reference/output-format (json result: type, subtype, is_error, duration_ms, result, session_id;
//                                                     NO token usage and NO cost are documented, so both are recorded as unknown)
//   https://cursor.com/docs/cli/installation           (`curl https://cursor.com/install -fsS | bash`)
// There is no documented step or budget limit, so only the bench's hard time limit applies.
import { spawnSync } from "node:child_process";
import { onPath } from "../lib/proc.ts";
import { type Adapter, lastJson, noUsage, num } from "./types.ts";

/** `agent` is the documented name. `cursor-agent` is the older name some installs still have. */
export function cursorBin(): string | null {
  if (onPath("agent")) return "agent";
  if (onPath("cursor-agent")) return "cursor-agent"; // UNVERIFIED: the current docs only name `agent`
  return null;
}

export const cursor: Adapter = {
  name: "cursor",
  label: "Cursor CLI",
  docs: ["https://cursor.com/docs/cli/reference/parameters", "https://cursor.com/docs/cli/reference/output-format", "https://cursor.com/docs/cli/installation"],
  unverified: [
    "cursor: `agent status` is read as logged in when it exits 0 and does not say 'not logged in'; the docs say what it shows, not its exit codes.",
    "cursor: falls back to the binary name `cursor-agent` when `agent` is missing; the current docs only name `agent`.",
  ],
  notes: ["Cursor's JSON output has no token or cost fields, so tokens and cost show as unknown for Cursor.", "Cursor has no documented step or spending limit flag: only the bench's hard time limit stops it."],
  authEnv: ["CURSOR_API_KEY"],
  containerInstall: ["curl https://cursor.com/install -fsS | bash && ln -sf \"$HOME/.local/bin/agent\" /usr/local/bin/agent"],
  containerUnverified: ["cursor (container): the docs say to add ~/.local/bin to PATH but do not say the binary is placed there."],
  async check() {
    const bin = cursorBin();
    if (!bin) return { installed: false, loggedIn: null, version: "", detail: "Cursor CLI is not installed. Install: curl https://cursor.com/install -fsS | bash" };
    const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30000 });
    const s = spawnSync(bin, ["status"], { encoding: "utf8", timeout: 30000 });
    const text = (s.stdout || "") + (s.stderr || "");
    const loggedIn = s.status === 0 && !/not (logged|authenticated|signed)/i.test(text) ? true : /not (logged|authenticated|signed)/i.test(text) ? false : null;
    return { installed: true, loggedIn, version: (v.stdout || "").trim(), detail: text.trim().split("\n")[0] || "agent status gave no output" };
  },
  command(ctx) {
    const bin = ctx.inContainer ? "agent" : cursorBin() || "agent";
    return { cmd: [bin, "-p", ctx.prompt, "--output-format", "json", "--model", ctx.model, "--force", "--trust", "--workspace", ctx.cwd], enforced: [] };
  },
  parse(stdout) {
    const u = noUsage(), j = lastJson(stdout);
    if (!j) return u;
    u.ok = typeof j.is_error === "boolean" ? !j.is_error : null;
    // Not documented today; read only if a future version adds it.
    if (j.usage) { u.inputTokens = num(j.usage.input_tokens); u.outputTokens = num(j.usage.output_tokens); u.totalTokens = u.inputTokens !== null && u.outputTokens !== null ? u.inputTokens + u.outputTokens : null; }
    return u;
  },
};
