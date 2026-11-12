import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Ctx } from "./tools.ts";

/** A checkpoint is the state of every file Syok has touched, taken at the start of one of your messages. */
export interface Checkpoint { n: number; label: string; at: string; files: Map<string, string | null>; msgLen: number }
const now = (c: Ctx, rel: string) => { const p = resolve(c.root, rel); return existsSync(p) ? readFileSync(p, "utf8") : null; };
export function takeCheckpoint(c: Ctx, list: Checkpoint[], label: string, msgLen: number): Checkpoint {
  const files = new Map<string, string | null>();
  for (const rel of new Set([...c.snapshots.keys(), ...c.touched])) files.set(rel, now(c, rel));
  const n = (list.length ? list[list.length - 1].n : 0) + 1;
  const cp: Checkpoint = { n, label: label.replace(/\s+/g, " ").trim().slice(0, 60) || "(no label)", at: new Date().toISOString(), files, msgLen };
  list.push(cp); return cp;
}
export function describeCheckpoints(list: Checkpoint[]): string {
  if (!list.length) return "No checkpoints yet. One is saved automatically before each of your messages (or use /checkpoint name).";
  return list.map((c) => "  " + c.n + ". " + c.label + "   (" + c.at.slice(11, 19) + ", " + c.files.size + " files tracked)").join("\n");
}
/** Put every file back the way it was at checkpoint n and forget that checkpoint and the later ones. Returns the files that changed and how long the chat was then. */
export function rewindTo(c: Ctx, list: Checkpoint[], n: number): { restored: string[]; msgLen: number } | null {
  const idx = list.findIndex((x) => x.n === n); if (idx < 0) return null;
  const cp = list[idx]; const restored: string[] = [];
  for (const [rel, orig] of c.snapshots) {
    const want = cp.files.has(rel) ? cp.files.get(rel)! : orig;
    const abs = resolve(c.root, rel); const cur = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (cur === want) continue;
    if (want === null) { try { unlinkSync(abs); } catch {} } else writeFileSync(abs, want);
    restored.push(rel);
  }
  list.length = idx;
  return { restored, msgLen: cp.msgLen };
}
