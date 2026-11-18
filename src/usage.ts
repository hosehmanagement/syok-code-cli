// Usage history: one line per AI call, kept on this computer so totals can be shown later ("syok usage")
// and read by other tools that add up token use (for example Tokscale).
//
// Where:  ~/.syok/usage/YYYY-MM.jsonl   (one file per month; SYOK_USAGE_DIR moves it)
// What:   time, chat id, project folder, provider and model, token counts. Never the text of a message.
// Off:    "usage_log": false in ~/.syok/config.json or .syok/settings.json, or SYOK_USAGE_LOG=0.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface UsageLine {
  v: 1; ts: string; session: string; project: string; client: "syok-code";
  /** the model or preset that was asked for, e.g. "syok-coder" */
  requested: string;
  /** who really answered (from Syok's X-Syok-* reply headers); empty when the server did not say */
  provider: string; model: string;
  input: number; output: number; cache_read: number; reasoning: number; total: number;
}

export const usageDir = (home = homedir(), env: Record<string, string | undefined> = process.env) => env.SYOK_USAGE_DIR || join(home, ".syok", "usage");

let ctx: { session: string; project: string; on: boolean } = { session: "", project: "", on: true };
/** Called once by the program: which chat and project the following calls belong to, and whether to write at all. */
export function setUsageContext(c: { session?: string; project?: string; on?: boolean }): void { ctx = { ...ctx, ...c }; }

/** Logging is on unless switched off. Inside the test runner it is off, unless a test names its own folder. */
export function usageLogOn(env: Record<string, string | undefined> = process.env): boolean {
  if (/^(0|false|off|no)$/i.test(env.SYOK_USAGE_LOG || "")) return false;
  if (env.NODE_ENV === "test" && !env.SYOK_USAGE_DIR) return false;
  return ctx.on;
}

const num = (x: any) => (Number.isFinite(Number(x)) ? Math.max(0, Math.round(Number(x))) : 0);
/** Turn one reply's "usage" block (OpenAI style, as Syok returns it) into a line. */
export function makeLine(usage: any, route: { provider?: string; model?: string } | undefined, requested: string, now = new Date()): UsageLine {
  const input = num(usage?.prompt_tokens), output = num(usage?.completion_tokens);
  return {
    v: 1, ts: now.toISOString(), session: ctx.session, project: ctx.project, client: "syok-code", requested: String(requested || ""),
    provider: String(route?.provider || ""), model: String(route?.model || ""),
    input, output,
    cache_read: num(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens),
    reasoning: num(usage?.completion_tokens_details?.reasoning_tokens),
    total: num(usage?.total_tokens) || input + output,
  };
}

/** Append one call. Never throws: a full disk or a read-only home must not stop the work. */
export function recordCall(usage: any, route: any, requested: string, o: { dir?: string; env?: Record<string, string | undefined>; now?: Date } = {}): UsageLine | null {
  const env = o.env || process.env;
  if (!usageLogOn(env) || !usage) return null;
  const line = makeLine(usage, route, requested, o.now);
  if (!line.input && !line.output && !line.total) return null;
  try {
    const d = o.dir || usageDir(homedir(), env); mkdirSync(d, { recursive: true });
    appendFileSync(join(d, line.ts.slice(0, 7) + ".jsonl"), JSON.stringify(line) + "\n");
    return line;
  } catch { return null; }
}

/** Every line from the last `days` days (0 = all). Broken lines are skipped, not fatal. */
export function readUsage(o: { dir?: string; days?: number; now?: Date } = {}): UsageLine[] {
  const d = o.dir || usageDir(); if (!existsSync(d)) return [];
  const now = o.now || new Date(); const since = o.days ? new Date(now.getTime() - o.days * 86_400_000).toISOString() : "";
  const sinceMonth = since.slice(0, 7);
  const out: UsageLine[] = [];
  for (const f of readdirSync(d).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()) {
    if (sinceMonth && f.slice(0, 7) < sinceMonth) continue;
    for (const raw of readFileSync(join(d, f), "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try { const j = JSON.parse(raw); if (j && j.v === 1 && typeof j.ts === "string" && (!since || j.ts >= since)) out.push(j); } catch {}
    }
  }
  return out;
}

export interface Group { key: string; calls: number; input: number; output: number; cache_read: number; total: number; sessions: number }
export function groupBy(lines: UsageLine[], by: "day" | "model" | "project" | "session"): Group[] {
  const m = new Map<string, Group & { s: Set<string> }>();
  for (const l of lines) {
    const key = by === "day" ? l.ts.slice(0, 10) : by === "model" ? ([l.provider, l.model].filter(Boolean).join(" / ") || l.requested || "(unknown)") : by === "project" ? (l.project || "(unknown)") : (l.session || "(unknown)");
    const g = m.get(key) || { key, calls: 0, input: 0, output: 0, cache_read: 0, total: 0, sessions: 0, s: new Set<string>() };
    g.calls++; g.input += l.input; g.output += l.output; g.cache_read += l.cache_read; g.total += l.total; if (l.session) g.s.add(l.session);
    m.set(key, g);
  }
  const all = [...m.values()].map(({ s, ...g }) => ({ ...g, sessions: s.size }));
  return by === "day" ? all.sort((a, b) => (a.key < b.key ? 1 : -1)) : all.sort((a, b) => b.total - a.total);
}

const fmt = (n: number) => (n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + "M" : n >= 10_000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
/** Money only when the person listed prices (per million tokens), matched like the per-task line does. */
export function costOf(lines: UsageLine[], prices?: Record<string, { in?: number; out?: number }>): number | null {
  if (!prices || !Object.keys(prices).length) return null;
  const keys = Object.keys(prices).sort((a, c) => c.length - a.length); let cost = 0, hit = false;
  for (const l of lines) {
    const name = [l.provider, l.model, l.requested].join(" ").toLowerCase();
    const k = keys.find((k) => name.includes(k.toLowerCase())); if (!k) continue; hit = true;
    cost += (l.input * (Number(prices[k].in) || 0) + l.output * (Number(prices[k].out) || 0)) / 1_000_000;
  }
  return hit ? cost : null;
}

export function describeHistory(lines: UsageLine[], o: { days: number; by?: "day" | "model" | "project"; prices?: Record<string, { in?: number; out?: number }>; dir: string }): string {
  const span = o.days ? `the last ${o.days} days` : "all time";
  if (!lines.length) return `No AI use recorded for ${span}.\nSyok Code writes one line per AI call to ${o.dir} (token counts only, never what was said).`;
  const sum = groupBy(lines, "session"); const t = lines.reduce((a, l) => ({ i: a.i + l.input, o: a.o + l.output, c: a.c + l.cache_read }), { i: 0, o: 0, c: 0 });
  const cost = costOf(lines, o.prices);
  const out = [`Syok Code, ${span}: ${lines.length} AI call${lines.length === 1 ? "" : "s"} in ${sum.length} chat${sum.length === 1 ? "" : "s"}, ${fmt(t.i)} tokens in${t.c ? ` (${fmt(t.c)} of them from cache)` : ""}, ${fmt(t.o)} out` + (cost === null ? "" : `, about $${cost.toFixed(2)} at your listed prices`)];
  const table = (title: string, gs: Group[], max = 12) => {
    out.push("", title);
    const w = Math.min(40, Math.max(...gs.slice(0, max).map((g) => g.key.length)));
    for (const g of gs.slice(0, max)) out.push(`  ${g.key.length > w ? g.key.slice(0, w - 1) + "…" : g.key.padEnd(w)}  ${String(g.calls).padStart(5)} calls  ${fmt(g.input).padStart(7)} in  ${fmt(g.output).padStart(7)} out`);
    if (gs.length > max) out.push(`  … and ${gs.length - max} more`);
  };
  const want = o.by ? [o.by] : (["day", "model", "project"] as const);
  for (const b of want) table(b === "day" ? "By day:" : b === "model" ? "By provider and model (who really answered):" : "By project:", groupBy(lines, b).map((g) => (b === "project" ? { ...g, key: basename(g.key) || g.key } : g)), b === "day" ? 14 : 8);
  if (cost === null) out.push("", 'No money amount: list your prices per million tokens under "prices" in .syok/settings.json to see one.');
  return out.join("\n");
}
