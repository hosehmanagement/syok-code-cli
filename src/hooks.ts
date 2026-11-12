// Hooks: your own commands that run around the AI's actions. Configure in .syok/settings.json:
//   { "hooks": { "PreToolUse": [{ "match": "edit_file|write_file", "command": "./check.sh" }],
//                "PostToolUse": [{ "match": "edit_file", "command": "npx prettier --write ." }],
//                "Stop": [{ "command": "npm test" }] } }
// The command gets the event as JSON on its input. Exit code 2 blocks (PreToolUse) or sends the message back to the AI (Stop).
import { spawnCommand, killTree } from "./shell.ts";
export interface Hook { match?: string; command: string; timeout_sec?: number }
export interface HookResult { block: boolean; message: string }
export async function runHooks(hooks: Hook[] | undefined, event: string, payload: any, root: string, toolName = ""): Promise<HookResult> {
  const out: string[] = []; let block = false;
  for (const h of hooks || []) {
    if (h.match && toolName && !new RegExp("^(" + h.match + ")$").test(toolName)) continue;
    if (h.match && !toolName) continue;
    const r = await one(h, { event, ...payload }, root);
    if (r.code === 2) { block = true; out.push(r.text || "A hook blocked this."); } else if (r.text) out.push(r.text);
  }
  return { block, message: out.join("\n").slice(0, 4000) };
}
function one(h: Hook, payload: any, cwd: string): Promise<{ code: number; text: string }> {
  return new Promise((res) => {
    const env = { ...process.env }; delete env.SYOK_API_KEY; delete env.GITHUB_TOKEN;
    const ch = spawnCommand(h.command, cwd, env, ["pipe", "pipe", "pipe"]);
    let o = "", e = "", done = false;
    ch.stdout!.on("data", (d) => (o += d)); ch.stderr!.on("data", (d) => (e += d));
    ch.stdin!.on("error", () => {}); ch.stdin!.end(JSON.stringify(payload));
    const t = setTimeout(() => { if (!done) { killTree(ch); res({ code: 1, text: "hook timed out" }); done = true; } }, (h.timeout_sec || 30) * 1000);
    ch.on("close", (code) => { if (done) return; done = true; clearTimeout(t); res({ code: code ?? 1, text: ((code === 2 ? e || o : o) || "").trim() }); });
    ch.on("error", (er) => { if (done) return; done = true; clearTimeout(t); res({ code: 1, text: "hook failed: " + er.message }); });
  });
}
