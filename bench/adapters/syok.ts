// Syok Code. Flags are this repository's own (src/main.ts help text): -p, --json, --mode auto, --model, --max-steps, --cwd, --no-stream.
// The --json result carries `usage` ({ input, output, total, steps, by: { "<provider> / <model>": {...} } }) and `stopped`.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { onPath } from "../lib/proc.ts";
import { type Adapter, lastJson, noUsage, num } from "./types.ts";

const REPO_MAIN = resolve(import.meta.dir, "..", "..", "src", "main.ts");
/** Which syok to run: SYOK_BIN (a path), else `syok` on PATH, else this checkout's src/main.ts through bun. */
export function syokBin(inContainer = false): string[] {
  if (inContainer) return ["syok"];
  if (process.env.SYOK_BIN) return [process.env.SYOK_BIN];
  if (onPath("syok")) return ["syok"];
  return [process.execPath, REPO_MAIN];
}
function hasLogin(): boolean {
  if (process.env.SYOK_BASE_URL && process.env.SYOK_API_KEY) return true;
  try { const c = JSON.parse(readFileSync(join(homedir(), ".syok", "config.json"), "utf8")); return !!(c.base && c.key); } catch { return false; }
}

export const syok: Adapter = {
  name: "syok",
  label: "Syok Code",
  docs: ["src/main.ts (syok --help) in this repository"],
  unverified: [],
  notes: [
    "Syok routes between providers. For a fair test the Syok key must be pinned to ONE provider and ONE model (make a key in Syok, Work, API Keys that only has that model), " +
      "otherwise a run can be answered by a different model than the other tools use. After each run the bench reads which provider/model answered from the --json usage and marks the run if any other model answered.",
  ],
  authEnv: ["SYOK_BASE_URL", "SYOK_API_KEY"],
  // Inside a SWE-bench container: this repository's own one-line installer (install/install.sh) is copied in and run.
  containerUpload: [{ local: resolve(import.meta.dir, "..", "..", "install", "install.sh"), remote: "/tmp/syok-install.sh" }],
  containerInstall: ["SYOK_HOME=/opt/syok sh /tmp/syok-install.sh && ln -sf /opt/syok/bin/syok /usr/local/bin/syok"],
  async check() {
    const bin = syokBin();
    const installed = bin[0] === process.execPath ? existsSync(bin[1]) : true;
    let version = "";
    if (bin[0] === process.execPath) { try { version = JSON.parse(readFileSync(resolve(REPO_MAIN, "..", "..", "package.json"), "utf8")).version + " (this checkout)"; } catch {} }
    else { const r = spawnSync(bin[0], ["--help"], { encoding: "utf8", timeout: 20000 }); version = r.status === 0 ? "installed" : ""; }
    const loggedIn = hasLogin();
    return { installed, loggedIn, version, detail: loggedIn ? "SYOK_BASE_URL/SYOK_API_KEY or ~/.syok/config.json found" : "No Syok login: run `syok setup` or set SYOK_BASE_URL and SYOK_API_KEY" };
  },
  command(ctx) {
    const cmd = [...syokBin(ctx.inContainer), "-p", ctx.prompt, "--json", "--mode", "auto", "--no-stream", "--model", ctx.model, "--cwd", ctx.cwd];
    const enforced: Array<"steps" | "cost"> = [];
    if (ctx.limits.maxSteps) { cmd.push("--max-steps", String(ctx.limits.maxSteps)); enforced.push("steps"); }
    return { cmd, enforced };
  },
  parse(stdout) {
    const u = noUsage(), j = lastJson(stdout);
    if (!j) return u;
    const us = j.usage || {};
    u.inputTokens = num(us.input); u.outputTokens = num(us.output); u.totalTokens = num(us.total) ?? num(j.tokens);
    u.steps = num(j.steps);
    u.modelsSeen = Object.keys(us.by || {});
    u.ok = j.stopped ? j.stopped === "finished" || j.stopped === "answered" : null;
    return u;
  },
};
