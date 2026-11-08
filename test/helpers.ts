import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
export function tmpProject(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "syok-"));
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
    if (msg.__status) return new Response("fail", { status: msg.__status });
    return new Response(JSON.stringify({ choices: [{ message: msg }], usage: { total_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}
let n = 0;
export const call = (name: string, args: any) => ({ role: "assistant", content: "", tool_calls: [{ id: "c" + n++, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
