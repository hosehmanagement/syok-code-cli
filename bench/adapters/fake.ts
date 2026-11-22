// A stand-in "AI tool" for --dry-run and the tests: it spends nothing and needs no login.
// What it does is set by BENCH_FAKE (default "solve"):
//   solve   copy the scenario's solution/ folder over the project (a correct fix)
//   noop    change nothing
//   hang    never finish (and start a child that never finishes) to prove the time limit kills the whole group
//   <name>  copy the scenario's fake/<name>/ folder over the project (for example a fix that also edits a protected test)
// It prints a JSON result in the same shape as `syok --json`, so the usage parsing is exercised too.
import { type Adapter } from "./types.ts";
import { syok } from "./syok.ts";
import { resolve } from "node:path";

const TOOL = resolve(import.meta.dir, "fake-tool.ts");
export const fake: Adapter = {
  name: "fake",
  label: "Fake tool (dry run)",
  docs: [],
  unverified: [],
  async check() { return { installed: true, loggedIn: true, version: "dry-run", detail: "stand-in tool, spends nothing" }; },
  command(ctx) {
    return {
      cmd: [process.execPath, TOOL, ctx.cwd],
      env: { BENCH_SCENARIO_DIR: ctx.scenarioDir || "", BENCH_FAKE_MODEL: process.env.BENCH_FAKE_MODEL || ctx.model, BENCH_PROMPT: ctx.prompt },
      enforced: [],
    };
  },
  parse: syok.parse,
};
