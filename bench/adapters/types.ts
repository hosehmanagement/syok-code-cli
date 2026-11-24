// What every tool adapter provides. One small file per tool (syok.ts, claude.ts, codex.ts, cursor.ts, fake.ts).
// Rule: a flag that could not be confirmed in the tool's official documentation or source is listed in `unverified`
// (and marked // UNVERIFIED next to it), and the orchestrator prints a one-line warning for each at run time.

export interface Limits { timeSec: number; maxSteps?: number; maxCostUsd?: number }
export interface CommandCtx {
  prompt: string;
  cwd: string;            // the project folder the tool works in
  model: string;          // the pinned model for this tool (same model across tools in a fair lane)
  limits: Limits;
  inContainer?: boolean;  // true when the tool runs inside a SWE-bench container (bin names may differ)
  scenarioDir?: string;   // only used by the fake adapter
  noWeb?: boolean;        // switch the tool's web search and web fetch off (the fair lane gives no tool the web)
}
export interface ToolCommand {
  cmd: string[];
  env?: Record<string, string>;
  stdin?: string;
  /** Which of the limits the tool itself enforces (the time limit is always enforced by the orchestrator). */
  enforced: Array<"steps" | "cost">;
}
export interface Check { installed: boolean; loggedIn: boolean | null; version: string; detail: string }
/** Numbers read from the tool's own output. null = the tool did not say (recorded as "unknown", never guessed). */
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;   // only when the tool itself reports a cost
  steps: number | null;
  /** Models the tool's output says answered (for the same-model check). Empty = the tool did not say. */
  modelsSeen: string[];
  ok: boolean | null;       // the tool's own success flag, when it has one
  /** Input tokens read from the prompt cache, when the tool says so (Claude Code's modelUsage cacheReadInputTokens).
   *  They are INCLUDED in inputTokens; this number only shows how many of them were cache reads. */
  cacheReadTokens?: number | null;
  /** Tokens per answering "<provider> / <model>", when the tool says so (Syok Code's usage.by). */
  byModel?: Record<string, { steps: number; input: number; output: number }>;
}
export interface Adapter {
  name: "syok" | "claude" | "codex" | "cursor" | "fake";
  label: string;
  /** Official documentation used to write this adapter. */
  docs: string[];
  /** Flags or output fields that could not be confirmed. Each is printed as a warning when the adapter is used. */
  unverified: string[];
  /** Extra notes printed once at the start (for example how to pin Syok to one provider). */
  notes?: string[];
  check(): Promise<Check>;
  command(ctx: CommandCtx): ToolCommand;
  parse(stdout: string, stderr: string): Usage;
  /** Shell lines that install the tool inside a Linux container (SWE-bench). Empty = not supported. */
  containerInstall?: string[];
  /** Local files copied into the container before containerInstall runs. */
  containerUpload?: Array<{ local: string; remote: string }>;
  /** Like `unverified`, for the container install lines only (printed by the SWE-bench runner). */
  containerUnverified?: string[];
  /** The tool's own bookkeeping folders in the project (saved chats, caches), relative to the project root. They are left
   *  out of SWE-bench patches, so predictions hold only code changes. */
  patchExclude?: string[];
  /** Names of environment variables that carry this tool's login, passed into containers by name only. */
  authEnv?: string[];
  /** Inside a container, run the tool as this non-root user (created by containerInstall). The project folder is given to
   *  the user just before the run and given back right after it, so the patch and the grade are taken exactly as before. */
  runAs?: { user: string; home: string };
  /** A shell line (run like the tool itself) that prints the tool's version inside the container; kept in the results. */
  containerVersion?: string;
}
export const noUsage = (): Usage => ({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, steps: null, modelsSeen: [], ok: null });
/** The last JSON object printed on its own line (tools print logs before their JSON result). */
export function lastJson(text: string): any | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try { return JSON.parse(lines[i]); } catch {}
  }
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(text.slice(s, e + 1)); } catch {} }
  return null;
}
export const num = (v: any): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
