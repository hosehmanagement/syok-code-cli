// "syok update": replace the installed one-file program with the newest published one.
// The download is checked against its published checksum and must start before it replaces anything.
import { createHash } from "node:crypto";
import { writeFileSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const SITE = "https://syok-ai.com/syok-code";
export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export interface UpdateOpts { self: string; site?: string; fetchImpl?: typeof fetch; current?: string; check?: (file: string) => boolean }

/** Returns the line to show the user. Never leaves a half-written program behind. */
export async function selfUpdate(o: UpdateOpts): Promise<{ ok: boolean; changed: boolean; message: string }> {
  const site = (o.site || process.env.SYOK_SITE || SITE).replace(/\/+$/, ""), f = o.fetchImpl || fetch;
  if (!/\.js$/i.test(o.self)) return { ok: false, changed: false, message: "This copy of Syok Code is not the one-file install, so it cannot update itself. Run the installer again: https://syok-ai.com/syok-code/" };
  let body: Uint8Array, sum: string;
  try {
    const [a, b] = await Promise.all([f(site + "/syok.js"), f(site + "/syok.js.sha256")]);
    if (!a.ok || !b.ok) return { ok: false, changed: false, message: `Could not download the update (${a.ok ? b.status : a.status}). Nothing was changed.` };
    body = new Uint8Array(await a.arrayBuffer()); sum = (await b.text()).trim().split(/\s+/)[0].toLowerCase();
  } catch (e: any) { return { ok: false, changed: false, message: "Could not download the update: " + (e?.message || e) + ". Nothing was changed." }; }
  if (!/^[0-9a-f]{64}$/.test(sum) || sha256(body) !== sum) return { ok: false, changed: false, message: "The update download is damaged (checksum does not match). Nothing was changed." };
  if (o.current && o.current === sum) return { ok: true, changed: false, message: "Syok Code is already up to date." };
  const tmp = o.self + ".new";
  try {
    writeFileSync(tmp, body);
    const starts = o.check ? o.check(tmp) : spawnSync(process.execPath, [tmp, "--help"], { stdio: "ignore", windowsHide: true }).status === 0;
    if (!starts) { rmSync(tmp, { force: true }); return { ok: false, changed: false, message: "The downloaded update does not start on this computer. Nothing was changed." }; }
    renameSync(tmp, o.self);
  } catch (e: any) { try { rmSync(tmp, { force: true }); } catch {} return { ok: false, changed: false, message: "Could not write the update: " + (e?.message || e) + ". Nothing was changed." }; }
  return { ok: true, changed: true, message: "Syok Code was updated. It takes effect the next time you start it." };
}
