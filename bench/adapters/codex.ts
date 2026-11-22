// OpenAI Codex CLI. Docs: https://developers.openai.com/codex/noninteractive (that page redirects to learn.chatgpt.com, which
// could not be fetched from the build machine), so every flag below was checked in the official source instead:
//   github.com/openai/codex  codex-rs/exec/src/cli.rs, codex-rs/utils/cli/src/shared_options.rs, codex-rs/exec/src/exec_events.rs,
//   codex-rs/cli/src/login.rs  (main branch, commit cf3ff1530d821ec2d26452da4971d8e3e7d18d25, 22 Nov 2026).
//   `codex exec [PROMPT]`, --json (JSONL events), -m/--model, -s/--sandbox read-only|workspace-write|danger-full-access,
//   -C/--cd, --skip-git-repo-check, --ephemeral. `codex login status` exits 0 when logged in.
//   Token usage arrives in `turn.completed` events: usage { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }.
//   Codex prints no cost; cost comes from bench/prices.json. There is no step or budget flag, so only the time limit applies.
import { spawnSync } from "node:child_process";
import { onPath } from "../lib/proc.ts";
import { type Adapter, noUsage, num } from "./types.ts";

export const codex: Adapter = {
  name: "codex",
  label: "Codex CLI",
  docs: ["https://developers.openai.com/codex/noninteractive", "https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs"],
  unverified: [],
  notes: ["Codex has no step or spending limit flag: only the bench's hard time limit stops it."],
  authEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  containerUnverified: ["codex (container): installing Node.js from the container's package manager may give a Node.js too old for @openai/codex."],
  containerInstall: [
    "command -v npm >/dev/null || (apt-get update -qq && apt-get install -y -qq nodejs npm) >/dev/null", // UNVERIFIED: the distribution's Node.js may be too old for the package
    "npm install -g @openai/codex >/dev/null", // package name from the repository README (README.md line 42, same commit)
  ],
  async check() {
    if (!onPath("codex")) return { installed: false, loggedIn: null, version: "", detail: "codex is not installed. Install: npm install -g @openai/codex (see https://developers.openai.com/codex)" };
    const v = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 30000 });
    const a = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 30000 });
    return { installed: true, loggedIn: a.status === 0, version: (v.stdout || "").trim(), detail: a.status === 0 ? "codex login status: logged in" : "Not logged in: run `codex login` (or set CODEX_API_KEY)" };
  },
  command(ctx) {
    // workspace-write: Codex may change files only in the project folder, and runs without asking (exec is non-interactive).
    return { cmd: ["codex", "exec", "--json", "-m", ctx.model, "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-C", ctx.cwd, ctx.prompt], enforced: [] };
  },
  parse(stdout) {
    // turn.completed carries the thread's running total (event_processor_with_jsonl_output.rs: usage_from_last_total), so the
    // LAST one is the run's total; adding them up would count earlier turns twice. input_tokens already includes
    // cached_input_tokens (protocol.rs: non_cached_input = input_tokens - cached_input), so the cache is not added again.
    const u = noUsage(); let last: any = null, failed = false, turns = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim(); if (!t.startsWith("{")) continue;
      let e: any; try { e = JSON.parse(t); } catch { continue; }
      if (e.type === "turn.completed" && e.usage) { last = e.usage; turns++; }
      if (e.type === "turn.failed" || e.type === "error") failed = true;
    }
    if (last) {
      u.inputTokens = num(last.input_tokens); u.outputTokens = num(last.output_tokens);
      u.totalTokens = u.inputTokens !== null && u.outputTokens !== null ? u.inputTokens + u.outputTokens : null;
      u.ok = !failed;
    } else if (failed) u.ok = false;
    return u;
  },
};
