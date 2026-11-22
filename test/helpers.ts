import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// Temporary folders made by the tests. test/cleanup.ts (loaded before every test file, see bunfig.toml) removes them when
// each test file ends, so test runs no longer leave thousands of folders behind in the temporary folder.
const made: string[] = [];
/** A new empty temporary folder, removed when the current test file ends. */
export function tmpDir(prefix = "syok-"): string { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; }
/** Remove every temporary folder made so far (a folder still in use on Windows is left, never an error). */
export function removeTmpDirs(): number {
  let n = 0;
  for (const d of made.splice(0)) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3 }); n++; } catch {} }
  return n;
}
export function tmpProject(files: Record<string, string>) {
  const d = tmpDir("syok-");
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), c); }
  return d;
}
/** A fake AI service: replays scripted replies and records what it was sent. */
export function fakeAI(script: Array<any | ((req: any) => any)>) {
  const seen: any[] = []; let i = 0;
  const f = (async (_u: any, o: any) => {
    const req = JSON.parse(o.body); seen.push(req);
    const s = script[Math.min(i++, script.length - 1)];
    const msg = typeof s === "function" ? s(req) : s;
    if (msg.__status) return new Response(msg.__body ?? "fail", { status: msg.__status });
    return new Response(JSON.stringify({ choices: [{ message: msg }], usage: { total_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}
let n = 0;
export const call = (name: string, args: any) => ({ role: "assistant", content: "", tool_calls: [{ id: "c" + n++, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
