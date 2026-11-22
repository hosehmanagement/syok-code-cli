#!/usr/bin/env bun
// The program the fake adapter runs. See fake.ts. Usage: bun fake-tool.ts <project folder>
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const cwd = process.argv[2] || process.cwd();
const how = process.env.BENCH_FAKE || "solve";
const dir = process.env.BENCH_SCENARIO_DIR || "";
const model = process.env.BENCH_FAKE_MODEL || "fake-model";
const done = (stopped: string) => {
  console.log("fake tool log line");
  console.log(JSON.stringify({ summary: "fake " + how, steps: 3, tokens: 1200, stopped, usage: { input: 1000, output: 200, total: 1200, steps: 3, by: { ["fake / " + model]: { steps: 3, input: 1000, output: 200 } } } }));
};
if (how === "hang") {
  spawn("sleep", [process.env.BENCH_FAKE_SLEEP || "600"], { stdio: "ignore" }); // a grandchild: must die with the group
  setInterval(() => {}, 1 << 30);
} else if (how === "noop") done("finished");
else {
  const src = how === "solve" ? join(dir, "solution") : join(dir, "fake", how);
  if (!existsSync(src)) { console.error("fake tool: no folder " + src); process.exit(3); }
  cpSync(src, cwd, { recursive: true });
  done("finished");
}
