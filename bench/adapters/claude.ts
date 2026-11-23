// Claude Code (Anthropic). Checked against the official docs on 22-23 Nov 2026:
//   https://code.claude.com/docs/en/cli-reference   (-p, --output-format json, --model, --max-turns, --max-budget-usd,
//                                                    --dangerously-skip-permissions, --no-session-persistence, --bare,
//                                                    --disallowedTools, `claude auth status`)
//   https://code.claude.com/docs/en/headless        (json output carries total_cost_usd and a per-model breakdown; -p runs start
//                                                    in Manual mode, so unattended runs need a permission mode; --bare skips
//                                                    hooks, skills, plugins, MCP servers, auto memory and CLAUDE.md and reads
//                                                    only ANTHROPIC_API_KEY, never OAuth)
//   https://code.claude.com/docs/en/agent-sdk/cost-tracking  (result fields: total_cost_usd, usage, num_turns,
//                                                    modelUsage{model:{inputTokens,outputTokens,cacheReadInputTokens,...,costUSD}})
//   https://code.claude.com/docs/en/permission-modes (bypassPermissions = --dangerously-skip-permissions is REFUSED as root
//                                                    on Linux and macOS; run as a non-root user)
//   https://code.claude.com/docs/en/model-config, /env-vars  (ANTHROPIC_DEFAULT_HAIKU_MODEL = the model for `haiku` AND for
//                                                    background functionality; CLAUDE_CODE_SUBAGENT_MODEL = subagents' model;
//                                                    DISABLE_AUTOUPDATER = no update during a run)
//   https://code.claude.com/docs/en/setup           (curl -fsSL https://claude.ai/install.sh | bash [-s <version|stable|latest>],
//                                                    launcher at ~/.local/bin/claude)
// Also checked by running Claude Code 2.1.330 against a local stand-in for the API (no real key, nothing sent to Anthropic):
// as root it prints "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons" and exits 1;
// as a normal user its --output-format json result has `modelUsage` with inputTokens, outputTokens, cacheReadInputTokens,
// cacheCreationInputTokens and costUSD, plus total_cost_usd and num_turns.
import { spawnSync } from "node:child_process";
import { onPath } from "../lib/proc.ts";
import { type Adapter, lastJson, noUsage, num } from "./types.ts";
import { BENCH_HOME, BENCH_USER, createUserCommand, runAsCommand } from "../swebench/lane.ts";

/** Which Claude Code to install in a container: CLAUDE_BENCH_VERSION (a version like 2.1.330, or stable / latest), default stable. */
export function claudeVersionSpec(env: Record<string, string | undefined> = process.env): string {
  const v = (env.CLAUDE_BENCH_VERSION || "stable").trim();
  if (!/^(stable|latest|\d+\.\d+\.\d+)$/.test(v)) throw new Error(`CLAUDE_BENCH_VERSION must be stable, latest or a version like 2.1.330 (got "${v}")`);
  return v;
}
const CONTAINER_BIN = BENCH_HOME + "/.local/bin/claude";

export const claude: Adapter = {
  name: "claude",
  label: "Claude Code",
  docs: ["https://code.claude.com/docs/en/cli-reference", "https://code.claude.com/docs/en/headless", "https://code.claude.com/docs/en/agent-sdk/cost-tracking"],
  unverified: [],
  notes: [
    "Claude Code's --max-budget-usd and total_cost_usd are its own client-side estimates, not your bill (docs: agent-sdk/cost-tracking).",
    "The CLI reference page only says the JSON has a per-model cost breakdown; the key `modelUsage` is named on the Agent SDK cost-tracking page and was seen in Claude Code 2.1.330's own output. If it is missing, tokens fall back to `usage` and no model is reported (the same-model check then says \"not confirmed\").",
  ],
  authEnv: ["ANTHROPIC_API_KEY"],
  // Inside a SWE-bench container: a non-root user (Claude Code refuses --dangerously-skip-permissions as root), Claude Code
  // installed for that user with the official installer, and /testbed handed to that user only while the tool runs.
  runAs: { user: BENCH_USER, home: BENCH_HOME },
  get containerInstall() {
    return [
      createUserCommand(BENCH_USER, BENCH_HOME),
      runAsCommand(`curl -fsSL https://claude.ai/install.sh | bash -s ${claudeVersionSpec()} && test -x ${CONTAINER_BIN}`, BENCH_USER, BENCH_HOME),
    ];
  },
  containerVersion: CONTAINER_BIN + " --version",
  async check() {
    if (!onPath("claude")) return { installed: false, loggedIn: null, version: "", detail: "claude is not installed. Install: see https://code.claude.com/docs/en/setup" };
    const v = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 30000 });
    const a = spawnSync("claude", ["auth", "status"], { encoding: "utf8", timeout: 30000 }); // exits 0 when logged in, 1 when not (cli-reference)
    return { installed: true, loggedIn: a.status === 0, version: (v.stdout || "").trim(), detail: a.status === 0 ? "claude auth status: logged in" : "Not logged in: run `claude auth login` (or set ANTHROPIC_API_KEY)" };
  },
  command(ctx) {
    const cmd = [ctx.inContainer ? CONTAINER_BIN : "claude", "-p", ctx.prompt, "--output-format", "json", "--model", ctx.model, "--dangerously-skip-permissions", "--no-session-persistence"];
    // In a container (the cloud lane, logged in by ANTHROPIC_API_KEY): bare mode, so nothing from the image or a home folder
    // (hooks, plugins, MCP servers, CLAUDE.md, auto memory) changes the run. Not on your own computer: bare mode ignores a
    // subscription login (docs: headless, "Start faster with bare mode").
    if (ctx.inContainer) cmd.push("--bare");
    // No web for either tool in the fair lane (Syok Code gets --no-web). A bare tool name removes the tool (cli-reference).
    if (ctx.noWeb) cmd.push("--disallowedTools", "WebSearch", "WebFetch");
    const enforced: Array<"steps" | "cost"> = [];
    // --max-turns counts agentic turns, the nearest thing to Syok's steps.
    if (ctx.limits.maxSteps) { cmd.push("--max-turns", String(ctx.limits.maxSteps)); enforced.push("steps"); }
    if (ctx.limits.maxCostUsd) { cmd.push("--max-budget-usd", String(ctx.limits.maxCostUsd)); enforced.push("cost"); }
    // One model for everything: the model for `haiku` and background functionality, and the subagents' model, are pinned to
    // the same model (docs: model-config "Environment variables"); no update while the bench runs.
    const env = { ANTHROPIC_DEFAULT_HAIKU_MODEL: ctx.model, CLAUDE_CODE_SUBAGENT_MODEL: ctx.model, DISABLE_AUTOUPDATER: "1" };
    return { cmd, env, enforced };
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
      let i = 0, o = 0, cr = 0;
      for (const m of Object.values<any>(mu)) { i += (num(m.inputTokens) ?? 0) + (num(m.cacheReadInputTokens) ?? 0) + (num(m.cacheCreationInputTokens) ?? 0); o += num(m.outputTokens) ?? 0; cr += num(m.cacheReadInputTokens) ?? 0; }
      u.inputTokens = i; u.outputTokens = o; u.totalTokens = i + o; u.cacheReadTokens = cr;
    } else if (j.usage) {
      const x = j.usage;
      const i = (num(x.input_tokens) ?? 0) + (num(x.cache_read_input_tokens) ?? 0) + (num(x.cache_creation_input_tokens) ?? 0);
      u.inputTokens = num(x.input_tokens) === null ? null : i; u.outputTokens = num(x.output_tokens);
      if (u.inputTokens !== null) u.cacheReadTokens = num(x.cache_read_input_tokens) ?? 0;
      u.totalTokens = u.inputTokens !== null && u.outputTokens !== null ? u.inputTokens + u.outputTokens : null;
    }
    return u;
  },
};
