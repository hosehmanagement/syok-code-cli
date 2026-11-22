// Claude Code (Anthropic). Checked against the official docs on 22 Nov 2026:
//   https://code.claude.com/docs/en/cli-reference   (-p, --output-format json, --model, --max-turns, --max-budget-usd,
//                                                    --dangerously-skip-permissions, --no-session-persistence, `claude auth status`)
//   https://code.claude.com/docs/en/headless        (json output carries total_cost_usd; -p runs start in Manual mode, so
//                                                    unattended runs need a permission mode)
//   https://code.claude.com/docs/en/agent-sdk/cost-tracking  (result fields: total_cost_usd, usage.input_tokens/output_tokens,
//                                                    modelUsage{model:{inputTokens,outputTokens,costUSD}}, num_turns)
import { spawnSync } from "node:child_process";
import { onPath } from "../lib/proc.ts";
import { type Adapter, lastJson, noUsage, num } from "./types.ts";

export const claude: Adapter = {
  name: "claude",
  label: "Claude Code",
  docs: ["https://code.claude.com/docs/en/cli-reference", "https://code.claude.com/docs/en/headless", "https://code.claude.com/docs/en/agent-sdk/cost-tracking"],
  unverified: [
    "claude: the CLI's --output-format json is read for `modelUsage` (per-model tokens). That key name is documented for the Agent SDK result message; the CLI page only says the JSON has a per-model cost breakdown. If it is missing, tokens fall back to `usage`.",
  ],
  notes: ["Claude Code's --max-budget-usd and total_cost_usd are its own client-side estimates, not your bill (docs: agent-sdk/cost-tracking)."],
  authEnv: ["ANTHROPIC_API_KEY"],
  containerUnverified: ["claude (container): the install line `curl -fsSL https://claude.ai/install.sh | bash` could not be read verbatim from the setup page."],
  containerInstall: [
    "curl -fsSL https://claude.ai/install.sh | bash && ln -sf \"$HOME/.local/bin/claude\" /usr/local/bin/claude", // UNVERIFIED: the docs page's code block could not be read; the install path ~/.local/bin/claude is from the docs text
  ],
  async check() {
    if (!onPath("claude")) return { installed: false, loggedIn: null, version: "", detail: "claude is not installed. Install: see https://code.claude.com/docs/en/setup" };
    const v = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 30000 });
    const a = spawnSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 30000 }); // exits 0 when logged in, 1 when not (cli-reference)
    return { installed: true, loggedIn: a.status === 0, version: (v.stdout || "").trim(), detail: a.status === 0 ? "claude auth status: logged in" : "Not logged in: run `claude auth login` (or set ANTHROPIC_API_KEY)" };
  },
  command(ctx) {
    const cmd = ["claude", "-p", ctx.prompt, "--output-format", "json", "--model", ctx.model, "--dangerously-skip-permissions", "--no-session-persistence"];
    const enforced: Array<"steps" | "cost"> = [];
    // --max-turns counts agentic turns, the nearest thing to Syok's steps.
    if (ctx.limits.maxSteps) { cmd.push("--max-turns", String(ctx.limits.maxSteps)); enforced.push("steps"); }
    if (ctx.limits.maxCostUsd) { cmd.push("--max-budget-usd", String(ctx.limits.maxCostUsd)); enforced.push("cost"); }
    return { cmd, enforced };
  },
  parse(stdout) {
    const u = noUsage(), j = lastJson(stdout);
    if (!j) return u;
    u.costUsd = num(j.total_cost_usd);
    u.steps = num(j.num_turns);
    u.ok = typeof j.is_error === "boolean" ? !j.is_error : null;
    const mu = j.modelUsage && typeof j.modelUsage === "object" ? j.modelUsage : null;
    if (mu && Object.keys(mu).length) {
      u.modelsSeen = Object.keys(mu);
      let i = 0, o = 0;
      for (const m of Object.values<any>(mu)) { i += (num(m.inputTokens) ?? 0) + (num(m.cacheReadInputTokens) ?? 0) + (num(m.cacheCreationInputTokens) ?? 0); o += num(m.outputTokens) ?? 0; }
      u.inputTokens = i; u.outputTokens = o; u.totalTokens = i + o;
    } else if (j.usage) {
      const x = j.usage;
      const i = (num(x.input_tokens) ?? 0) + (num(x.cache_read_input_tokens) ?? 0) + (num(x.cache_creation_input_tokens) ?? 0);
      u.inputTokens = num(x.input_tokens) === null ? null : i; u.outputTokens = num(x.output_tokens);
      u.totalTokens = u.inputTokens !== null && u.outputTokens !== null ? u.inputTokens + u.outputTokens : null;
    }
    return u;
  },
};
