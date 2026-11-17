// --task-file: the task is read from a file, which is then removed. Used by the editor extension.
import { test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpProject, call } from "./helpers.ts";

const main = join(import.meta.dir, "..", "src", "main.ts");
function run(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => { const p = spawn("bun", [main, ...args], { cwd, env: { ...process.env, HOME: cwd, USERPROFILE: cwd, ...env }, stdio: ["ignore", "pipe", "pipe"] }); let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d)); p.on("exit", (c) => res({ code: c, out: o })); });
}
test("the task comes from the file, reaches the AI unchanged, and the file is removed", async () => {
  const d = tmpProject({ "a.txt": "x\n" }); const tf = join(d, "task.txt");
  const task = "say \"hi\" & echo %PATH% $HOME `id` | cat\nsecond line";
  writeFileSync(tf, "  " + task + "\n");
  const seen: any[] = [];
  const ai = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { seen.push(await req.json()); return new Response(JSON.stringify({ choices: [{ message: call("finish", { summary: "Done." }) }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { "content-type": "application/json" } }); } });
  try {
    const r = await run(["--task-file", tf, "--stay", "--mode", "auto"], d, { SYOK_BASE_URL: `http://127.0.0.1:${ai.port}`, SYOK_API_KEY: "syk_test" });
    expect(r.out).toContain("Done."); expect(r.code).toBe(0); // no terminal here, so --stay does not keep it open
    expect(existsSync(tf)).toBe(false);
    expect(seen[0].messages.filter((m: any) => m.role === "user").some((m: any) => String(m.content).includes(task))).toBe(true);
  } finally { ai.stop(true); }
}, 60000);
test("a missing or empty task file is an error, and nothing is sent", () => {
  const d = tmpProject({}); const env = { ...process.env, HOME: d, USERPROFILE: d, SYOK_BASE_URL: "http://127.0.0.1:9", SYOK_API_KEY: "syk_test" };
  const a = spawnSync("bun", [main, "--task-file", join(d, "nope.txt")], { cwd: d, env, encoding: "utf8" });
  expect(a.status).toBe(2); expect(a.stderr).toContain("Could not read the task file");
  writeFileSync(join(d, "empty.txt"), "  \n");
  const b = spawnSync("bun", [main, "--task-file", join(d, "empty.txt")], { cwd: d, env, encoding: "utf8" });
  expect(b.status).toBe(2); expect(b.stderr).toContain("The task file is empty"); expect(existsSync(join(d, "empty.txt"))).toBe(false);
});
