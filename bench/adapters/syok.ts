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
    "Syok routes between providers. For a fair test the Syok account behind the key must have ONE provider connected, " +
      "otherwise a run can be answered by a different model than the other tools use. Syok Code sends tool-calling requests, and for those the router " +
      "(syok-ai-router src/tools.ts, routeToolChat, checked 23 Nov 2026) sends each provider's own model and does NOT use the --model name, except that " +
      "syok-coder / syok-code puts code-strong providers first; the X-Syok-Lock header (one provider only) is refused with tools; when every provider fails, Syok's built-in free model answers. " +
      "After each run the bench reads which provider/model answered from the --json usage and marks the run if any other model answered.",
  ],
  authEnv: ["SYOK_BASE_URL", "SYOK_API_KEY"],
  // Syok Code saves each chat in <project>/.syok/sessions/ (found in every prediction of run 45154374333). That is the
  // tool's own record, not part of the fix, so it never goes into a SWE-bench patch.
  patchExclude: [".syok/"],
  // Inside a SWE-bench container: this repository's own one-line installer (install/install.sh) is copied in and run.
  // It installs the PUBLISHED Syok Code. To test this checkout instead, build the one-file program
  // (bun build src/main.ts --target=bun --minify --outfile syok.js) and set SYOK_BENCH_BUNDLE to its path: it then replaces the
  // published one inside the container (the installer still brings the Bun runtime).
  get containerUpload() {
    const up = [{ local: resolve(import.meta.dir, "..", "..", "install", "install.sh"), remote: "/tmp/syok-install.sh" }];
    if (process.env.SYOK_BENCH_BUNDLE) up.push({ local: resolve(process.env.SYOK_BENCH_BUNDLE), remote: "/tmp/syok-bundle.js" });
    return up;
  },
  get containerInstall() {
    return ["SYOK_HOME=/opt/syok sh /tmp/syok-install.sh && ln -sf /opt/syok/bin/syok /usr/local/bin/syok" +
      (process.env.SYOK_BENCH_BUNDLE ? " && cp /tmp/syok-bundle.js /opt/syok/syok.js && syok --help >/dev/null" : "")];
  },
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
    if (us.by && typeof us.by === "object") u.byModel = us.by;
    u.ok = j.stopped ? j.stopped === "finished" || j.stopped === "answered" : null;
    return u;
  },
};
