/** Daytona sandbox (the only isolation Syok Code offers besides its blocked-command list). Calls the Syok router, which holds your own Daytona key. */
export interface SandboxCfg { base: string; key: string; f?: typeof fetch }
const urlOf = (base: string, path: string) => base.trim().replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/code/sandbox/" + path;
export async function sandboxCall(cfg: SandboxCfg, path: string, body?: any): Promise<{ ok: boolean; status: number; data: any }> {
  const f = cfg.f || fetch;
  const r = await f(urlOf(cfg.base, path), { method: path === "status" ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Bearer " + cfg.key }, ...(path === "status" ? {} : { body: JSON.stringify(body || {}) }) });
  let data: any = null; try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
}
export async function sandboxExec(cfg: SandboxCfg, command: string, secs: number): Promise<string> {
  const r = await sandboxCall(cfg, "exec", { cmd: command, command, timeout: Math.min(90, secs) });
  if (!r.ok) return "Error: the sandbox said HTTP " + r.status + ": " + String(r.data?.error?.message || r.data?.error || JSON.stringify(r.data) || "").slice(0, 300) + " (start one with: syok sandbox start owner/repo)";
  const d = r.data || {};
  const out = String(d.output ?? d.result ?? "");
  return out.trim() + (d.exitCode !== undefined ? "\n[exit code " + d.exitCode + "]" : "");
}
/** Copy one edited file into the sandbox's copy of the project, so sandbox commands see the edit. Returns a short note for the AI. */
export async function sandboxPut(cfg: SandboxCfg, rel: string, content: string | null): Promise<string> {
  const path = rel.replace(/\\/g, "/");
  if (content === null) { // the file was removed locally (an undo of a new file): remove it there too
    const r = await sandboxCall(cfg, "exec", { cmd: "rm -f -- '" + path.replace(/'/g, "'\\''") + "'" });
    return r.ok ? "(also removed in the sandbox)" : sandboxProblem(r, path);
  }
  const r = await sandboxCall(cfg, "put", { path, content });
  return r.ok ? "(also written in the sandbox)" : sandboxProblem(r, path);
}
function sandboxProblem(r: { status: number; data: any }, path: string): string {
  if ([401, 404, 405].includes(r.status)) return "WARNING: this edit is NOT in the sandbox: your Syok version cannot copy edits into the sandbox yet, so sandbox commands still see the old " + path + ". Update your Syok (load the dashboard once).";
  return "WARNING: this edit is NOT in the sandbox (HTTP " + r.status + ": " + String(r.data?.message || r.data?.error?.message || r.data?.error || "").slice(0, 200) + "), so sandbox commands still see the old " + path + ".";
}
