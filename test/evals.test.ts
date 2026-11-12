import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("eval tasks are valid (fail before the fix, pass after)", () => {
  const r = spawnSync("bun", ["evals/run.ts", "--check"], { cwd: join(import.meta.dir, ".."), encoding: "utf8" });
  expect(r.stdout).toContain("all 16 tasks are valid");
}, 300000);

test("eval runner scores a scripted AI that fixes one task", async () => {
  const sol = readFileSync(join(import.meta.dir, "../evals/tasks/js-pagination-off-by-one/solution/lib/paginate.js"), "utf8");
  const steps = [
    { name: "read_file", args: { path: "lib/paginate.js" } },
    { name: "write_file", args: { path: "lib/paginate.js", content: sol } },
    { name: "run_command", args: { command: "node --test" } },
    { name: "finish", args: { summary: "fixed" } },
  ];
  let i = 0;
  const srv = Bun.serve({ port: 0, fetch() {
    const s = steps[Math.min(i++, steps.length - 1)];
    return Response.json({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c" + i, type: "function", function: { name: s.name, arguments: JSON.stringify(s.args) } }] } }], usage: { total_tokens: 5 } });
  } });
  const p = Bun.spawn(["bun", "evals/run.ts", "--tasks", "js-pagination"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", env: { ...process.env, SYOK_BASE_URL: "http://localhost:" + srv.port, SYOK_API_KEY: "k" } });
  const out = await new Response(p.stdout).text(); await p.exited;
  srv.stop();
  expect(out).toContain("PASS js-pagination-off-by-one");
  expect(out).toContain("Score: 1/1");
  const f = readdirSync(join(import.meta.dir, "../evals/results"));
  expect(f.length).toBeGreaterThan(0);
}, 60000);
