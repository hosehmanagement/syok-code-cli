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
  const r = await sandboxCall(cfg, "exec", { command, timeout: Math.min(90, secs) });
  if (!r.ok) return "Error: the sandbox said HTTP " + r.status + ": " + String(r.data?.error?.message || r.data?.error || JSON.stringify(r.data) || "").slice(0, 300) + " (start one with: syok sandbox start owner/repo)";
  const d = r.data || {};
  const out = String(d.output ?? d.result ?? "");
  return out.trim() + (d.exitCode !== undefined ? "\n[exit code " + d.exitCode + "]" : "");
}
