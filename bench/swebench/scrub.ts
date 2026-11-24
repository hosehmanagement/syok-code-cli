#!/usr/bin/env bun
// Removes secret values (the Syok key, the Syok address, the Anthropic key of the same-model lane) from every file in a folder
// before it is uploaded, then checks that none is left. The values are read from environment variables named on the command
// line, never from the command line itself, and are never printed.
//   bun bench/swebench/scrub.ts <folder> SYOK_API_KEY SYOK_BASE_URL SYOK_HOST SYOK_ACCT ANTHROPIC_API_KEY   (what bench-pilot.yml runs)
// Exit 0: every file is clean (also when a variable is empty or the folder does not exist).
// Exit 3: a value could not be removed; every file in the folder is then DELETED so nothing unsafe can be uploaded.
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MASK = "<hidden>";
function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}
/** Replace every value in every file (byte for byte, so binary files are safe too). Returns how many files changed. */
export function scrub(dir: string, values: string[]): { changed: number; left: string[] } {
  const vals = values.filter((v) => v && v.length >= 4).map((v) => Buffer.from(v, "utf8"));
  if (!existsSync(dir) || !statSync(dir).isDirectory() || !vals.length) return { changed: 0, left: [] };
  const mask = Buffer.from(MASK, "utf8");
  let changed = 0;
  for (const f of files(dir)) {
    let b = readFileSync(f), hit = false;
    for (const v of vals) {
      let i = b.indexOf(v);
      if (i < 0) continue;
      hit = true;
      const parts: Buffer[] = [];
      let from = 0;
      while (i >= 0) { parts.push(b.subarray(from, i), mask); from = i + v.length; i = b.indexOf(v, from); }
      parts.push(b.subarray(from));
      b = Buffer.concat(parts);
    }
    if (hit) { writeFileSync(f, b); changed++; }
  }
  const left = files(dir).filter((f) => { const b = readFileSync(f); return vals.some((v) => b.includes(v)); });
  return { changed, left };
}

if (import.meta.main) {
  const [dir, ...names] = process.argv.slice(2);
  if (!dir) { console.error("usage: bun bench/swebench/scrub.ts <folder> <ENV_NAME> [<ENV_NAME> ...]"); process.exit(2); }
  const values = names.map((n) => process.env[n] || "");
  const r = scrub(dir, values);
  if (r.left.length) {
    console.error(`A secret value is still in ${r.left.length} file(s) after scrubbing; deleting the folder's contents so nothing unsafe is uploaded.`);
    for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true });
    process.exit(3);
  }
  console.log(`Scrubbed: ${r.changed} file(s) had a secret value replaced by ${MASK}; no file holds one now (checked ${names.filter((n, i) => values[i]).length} value(s)).`);
}
