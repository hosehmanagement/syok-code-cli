// peek_file: a look inside files too big to read (200 MB logs, big JSON lines or CSV). Every mode reads the file as a
// stream, one piece at a time, and keeps only small counters, so memory stays small whatever the size of the file.
// Each answer is cut to a fixed size. Read-only.
import { createReadStream, openSync, readSync, closeSync, statSync } from "node:fs";
import { extname } from "node:path";

export const PEEK_MAX_CHARS = 12_000;
const KEEP = 4096; // characters of one line that are kept (the length is still counted in full)
const SHOW = 300; // characters of one line that are shown
export const PEEK_MODES = ["summary", "patterns", "sample", "around", "columns"] as const;
export interface PeekArgs { mode?: string; top?: number; windows?: number; lines?: number; pattern?: string; max_matches?: number; context?: number; max_rows?: number; ignore_case?: boolean }

type OnLine = (text: string, len: number, no: number) => boolean | void;
/** Calls onLine for every line of the file, reading 1 MB at a time. A line longer than KEEP characters is handed over cut
 *  (len is its real length). Returning false stops the reading. Returns how many lines were read. */
export async function scanLines(abs: string, onLine: OnLine): Promise<number> {
  const stream = createReadStream(abs, { highWaterMark: 1 << 20 }); const dec = new TextDecoder("utf-8");
  let carry = "", carryLen = 0, no = 0, stopped = false;
  const emit = (piece: string): boolean => {
    let len = carryLen + piece.length; let text = carryLen ? (carry.length < KEEP ? carry + piece.slice(0, KEEP - carry.length) : carry) : piece.length > KEEP ? piece.slice(0, KEEP) : piece;
    if (piece.endsWith("\r") || (!piece && carry.endsWith("\r") && carry.length === carryLen)) { len--; if (text.length > len) text = text.slice(0, len); }
    carry = ""; carryLen = 0; no++;
    return onLine(text, len, no) !== false;
  };
  try {
    for await (const chunk of stream) {
      const s = dec.decode(chunk as Buffer, { stream: true }); let start = 0;
      for (;;) {
        const i = s.indexOf("\n", start); if (i < 0) break;
        if (!emit(s.slice(start, i))) { stopped = true; break; }
        start = i + 1;
      }
      if (stopped) break;
      if (start < s.length) { const rest = s.slice(start); if (carry.length < KEEP) carry += rest.slice(0, KEEP - carry.length); carryLen += rest.length; }
    }
    if (!stopped) { const tail = dec.decode(); if (tail) { if (carry.length < KEEP) carry += tail.slice(0, KEEP - carry.length); carryLen += tail.length; } if (carryLen) emit(""); }
  } finally { stream.destroy(); }
  return no;
}
/** The first bytes of the file as text (for guessing its format), without reading the rest. */
function head(abs: string, bytes = 65536): string {
  const fd = openSync(abs, "r"); try { const b = Buffer.alloc(bytes); const n = readSync(fd, b, 0, bytes, 0); return b.subarray(0, n).toString("utf8"); } finally { closeSync(fd); }
}
/** The whole lines among the first bytes (the last, cut one is left out unless the file ends there). */
function headLines(abs: string): string[] { const bytes = 65536; const t = head(abs, bytes); const l = t.split(/\r?\n/); return statSync(abs).size > bytes ? l.slice(0, -1) : l; }
/** A copy of a piece of a line that does not keep the whole 1 MB piece of the file it was cut from alive in memory. */
const own = (s: string) => Buffer.from(s, "utf8").toString("utf8");
const show = (s: string, len = s.length) => { const t = s.length > SHOW ? s.slice(0, SHOW) : s; return len > t.length ? `${t} ...[+${len - t.length} chars]` : t; };
const n = (x: number) => x.toLocaleString("en-US");
const size = (b: number) => (b >= 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + " MB" : b >= 1024 ? (b / 1024).toFixed(1) + " KB" : b + " bytes");
const clampInt = (v: any, def: number, lo: number, hi: number) => { const x = Math.floor(Number(v)); return Number.isFinite(x) && v !== undefined && v !== null && v !== "" ? Math.min(hi, Math.max(lo, x)) : def; };
/** Cuts an answer to the fixed size, keeping its start and end. */
export function capOutput(s: string, max = PEEK_MAX_CHARS): string { return s.length <= max ? s : s.slice(0, Math.floor(max * 0.7)) + `\n...[${n(s.length - max)} characters cut]...\n` + s.slice(-Math.floor(max * 0.3)); }

// ---- the format ----
const TS_START = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}|[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2}|\d{10}(\.\d+)?\s)/;
const LEVEL = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|FATAL|CRITICAL|SEVERE)\b/;
export interface Format { kind: "log" | "json" | "jsonl" | "csv" | "other"; delim?: string }
/** Guesses the format from the first lines: JSON lines, one JSON document, CSV (and its separator), a log, or other. */
export function detectFormat(firstLines: string[], file = ""): Format {
  const lines = firstLines.filter((l) => l.trim()).slice(0, 50); const ext = extname(file).toLowerCase();
  if (!lines.length) return { kind: "other" };
  const objs = lines.filter((l) => { const t = l.trim(); if (!/^[[{]/.test(t)) return false; try { const v = JSON.parse(t); return v !== null && typeof v === "object"; } catch { return false; } }).length;
  // JSON lines: most of the first lines are whole JSON values each (a few broken lines are allowed), or the name says so
  if (objs >= 1 && (ext === ".jsonl" || ext === ".ndjson")) return { kind: "jsonl" };
  if (lines.length >= 2 && objs >= Math.max(2, Math.ceil(lines.length * 0.7))) return { kind: "jsonl" };
  if (/^\s*[[{]/.test(lines[0]) && (ext === ".json" || objs < lines.length)) return { kind: "json" };
  if (objs === 1 && lines.length === 1) return { kind: "json" };
  const sample = lines.slice(0, 20);
  for (const d of ext === ".tsv" ? ["\t"] : [",", "\t", ";", "|"]) {
    const counts = sample.map((l) => splitCsv(l, d).length - 1);
    if (counts[0] >= 1 && counts.every((c) => c === counts[0])) return { kind: "csv", delim: d };
  }
  if (ext === ".csv" || ext === ".tsv") return { kind: "csv", delim: ext === ".tsv" ? "\t" : "," };
  const logish = lines.filter((l) => TS_START.test(l) || LEVEL.test(l)).length;
  if (logish >= Math.ceil(lines.length * 0.3) || ext === ".log") return { kind: "log" };
  return { kind: "other" };
}
/** One CSV line split into fields (quotes understood; a quoted field that runs over several lines is not joined). */
export function splitCsv(line: string, d: string): string[] {
  if (!line.includes('"')) return line.split(d);
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) { const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"' && cur === "") q = true; else if (ch === d) { out.push(cur); cur = ""; } else cur += ch; }
  out.push(cur); return out;
}
const fmtName = (f: Format) => f.kind === "csv" ? `csv (separator ${f.delim === "\t" ? "tab" : `"${f.delim}"`})` : f.kind === "jsonl" ? "jsonl (one JSON value per line)" : f.kind === "json" ? "json (one JSON document)" : f.kind;

// ---- line shapes ----
// What changes from line to line, tried in this order where a word starts: uuid, timestamp (with or without a date), hex id
// (0x..., or 8+ hex characters with a letter a-f), IP address, number. Numbers are replaced inside words too (req123 and
// req456 are the same shape). The line is walked by hand and the patterns are tried only where a word starts with a digit
// or a hex letter (one regular expression over the whole line was slower on a 300 MB log).
// Each pattern has a quick test of the characters near the start, so most numbers never reach the regular expressions.
const AT: Array<[RegExp, string, (s: string, i: number) => boolean]> = [
  [/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/y, "<uuid>", (s, i) => s.charCodeAt(i + 8) === 45],
  [/(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{4}\/\d{2}\/\d{2}|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\b/y, "<time>", (s, i) => { const a = s.charCodeAt(i + 4), b = s.charCodeAt(i + 2); return a === 45 || a === 47 || b === 58; }],
  [/(?:0[xX][0-9a-fA-F]+|(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{8,})\b/y, "<hex>", (s, i) => { const x = s.charCodeAt(i + 1); if (x === 120 || x === 88) return true; let j = i, letter = false; while (j < s.length) { const c = s.charCodeAt(j); if (isHexLetter(c)) letter = true; else if (!isDigit(c)) break; j++; } return letter && j - i >= 8; }],
  [/\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/y, "<ip>", (s, i) => s.charCodeAt(i + 1) === 46 || s.charCodeAt(i + 2) === 46 || s.charCodeAt(i + 3) === 46],
];
const MONTH_TIME = /[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}\b/y;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isHexLetter = (c: number) => (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
/** The end of an ISO date or date-time starting at i (2026-11-22, 2026-11-22T10:00:00.123Z, 2026-11-22 10:00:00+08:00), or -1. Hand-written: it is on almost every log line. */
function isoEnd(s: string, i: number): number {
  const d = (k: number, n: number) => { for (let j = 0; j < n; j++) if (!isDigit(s.charCodeAt(k + j))) return false; return true; };
  if (!(d(i, 4) && s.charCodeAt(i + 4) === 45 && d(i + 5, 2) && s.charCodeAt(i + 7) === 45 && d(i + 8, 2))) return -1;
  let j = i + 10; const sep = s.charCodeAt(j);
  if ((sep === 84 || sep === 32) && d(j + 1, 2) && s.charCodeAt(j + 3) === 58 && d(j + 4, 2)) {
    j += 6; if (s.charCodeAt(j) === 58 && d(j + 1, 2)) { j += 3; const f = s.charCodeAt(j); if ((f === 46 || f === 44) && isDigit(s.charCodeAt(j + 1))) { j += 2; while (isDigit(s.charCodeAt(j))) j++; } }
    const z = s.charCodeAt(j); if (z === 90) j++; else if ((z === 43 || z === 45) && d(j + 1, 2)) { j += 3; if (s.charCodeAt(j) === 58) j++; if (d(j, 2)) j += 2; }
  }
  return j < s.length && isWord(s.charCodeAt(j)) ? -1 : j;
}
/** A line with what changes from line to line (uuids, timestamps, hex ids, addresses, numbers) replaced by placeholders. */
export function shapeOf(line: string): string {
  const s = line.length > SHOW ? line.slice(0, SHOW) : line; const len = s.length;
  let out = "", last = 0, i = 0;
  while (i < len) {
    const c = s.charCodeAt(i); const start = i === 0 || !isWord(s.charCodeAt(i - 1));
    let end = -1, ph = "";
    if (start && c >= 65 && c <= 90 && s.charCodeAt(i + 3) === 32) { MONTH_TIME.lastIndex = i; if (MONTH_TIME.test(s)) { end = MONTH_TIME.lastIndex; ph = "<time>"; } }
    if (end < 0 && start && isDigit(c) && s.charCodeAt(i + 4) === 45) { end = isoEnd(s, i); ph = "<time>"; }
    if (end < 0 && start && (isDigit(c) || isHexLetter(c))) {
      for (let a = 0; a < AT.length; a++) { if ((!isDigit(c) && a !== 0 && a !== 2) || !AT[a][2](s, i)) continue; const re = AT[a][0]; re.lastIndex = i; if (re.test(s)) { end = re.lastIndex; ph = AT[a][1]; break; } }
    }
    if (end < 0 && isDigit(c)) { let j = i + 1; for (;;) { while (j < len && isDigit(s.charCodeAt(j))) j++; const d = s.charCodeAt(j); if ((d === 46 || d === 44) && isDigit(s.charCodeAt(j + 1))) { j += 2; continue; } break; } end = j; ph = "<n>"; }
    if (end > i) { out += s.slice(last, i) + ph; i = last = end; continue; }
    if (isWord(c)) { i++; while (i < len && isWord(s.charCodeAt(i)) && !isDigit(s.charCodeAt(i))) i++; continue; } // the rest of a word, up to a digit
    i++;
  }
  return (out + s.slice(last)).trim();
}
const SEVERE = /\b(ERROR|ERR|FATAL|CRITICAL|SEVERE|PANIC|WARN|WARNING)\b|Exception\b|Traceback \(most recent call last\)|\bpanic:/;
/** Counts shapes, keeping memory bounded: past the limit, shapes seen only once are forgotten. */
class ShapeCounter {
  m = new Map<string, { count: number; first: number; example: string }>(); pruned = 0;
  constructor(public limit: number) {}
  add(shape: string, no: number, raw: string) {
    const e = this.m.get(shape); if (e) { e.count++; return; }
    if (this.m.size >= this.limit) { for (const [k, v] of this.m) if (v.count <= 1) { this.m.delete(k); this.pruned++; } if (this.m.size >= this.limit) { this.pruned++; return; } }
    this.m.set(own(shape), { count: 1, first: no, example: own(raw.length > SHOW ? raw.slice(0, SHOW) : raw) });
  }
  top(k: number) { return [...this.m.entries()].sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first).slice(0, k); }
}

// ---- the modes ----
async function summary(abs: string, rel: string, bytes: number): Promise<string> {
  const first: string[] = [], firstLen: number[] = []; const last: Array<[number, string, number]> = []; const hist = new Uint32Array(KEEP + 1); let longer = 0, empty = 0, maxLen = 0, minLen = Infinity, total = 0;
  const lines = await scanLines(abs, (t, len, no) => {
    if (no <= 20) { first.push(own(t)); firstLen.push(len); } last.push([no, t.length > SHOW ? t.slice(0, SHOW) : t, len]); if (last.length > 20) last.shift();
    if (len <= KEEP) hist[len]++; else longer++; if (!len) empty++; if (len > maxLen) maxLen = len; if (len < minLen) minLen = len; total += len;
  });
  const pct = (p: number) => { const want = Math.ceil(lines * p); let seen = 0; for (let i = 0; i <= KEEP; i++) { seen += hist[i]; if (seen >= want) return `at most ${i}`; } return `more than ${KEEP}`; };
  const fmt = detectFormat(first, rel);
  const L = [`${rel}: ${size(bytes)} (${n(bytes)} bytes), ${n(lines)} lines, format: ${fmtName(fmt)}`];
  if (lines) L.push(`Line length (characters): shortest ${minLen}, longest ${n(maxLen)}, average ${(total / lines).toFixed(1)}, median ${pct(0.5).replace("at most ", "")}; 95% of lines are ${pct(0.95)}, 99% ${pct(0.99)}; ${n(empty)} empty${longer ? `, ${n(longer)} longer than ${KEEP}` : ""}.`);
  L.push("", `First ${Math.min(20, lines)} lines:`, ...first.map((t, i) => `${String(i + 1).padStart(7)}  ${show(t, firstLen[i])}`));
  const tail = last.filter(([no]) => no > 20);
  if (tail.length) { L.push("", `Last ${tail.length} lines:`, ...tail.map(([no, t, len]) => `${String(no).padStart(7)}  ${show(t, len)}`)); }
  L.push("", "Next: mode 'patterns' for the most common kinds of line and the errors, 'around' with a pattern to see lines near a match, 'sample' for lines from all through the file" + (fmt.kind === "csv" || fmt.kind === "jsonl" ? ", 'columns' for the fields" : "") + ".");
  return L.join("\n");
}

async function patterns(abs: string, rel: string, a: PeekArgs): Promise<string> {
  const top = clampInt(a.top, 20, 1, 100); const all = new ShapeCounter(20000), bad = new ShapeCounter(5000); let severe = 0;
  const lines = await scanLines(abs, (t, _len, no) => { const sh = shapeOf(t); all.add(sh, no, t); if (SEVERE.test(t.length > SHOW ? t.slice(0, SHOW) : t)) { severe++; bad.add(sh, no, t); } });
  const L = [`${rel}: ${n(lines)} lines, ${n(all.m.size)}${all.pruned ? "+" : ""} different shapes (numbers, hex ids, timestamps, uuids and addresses replaced by <n>, <hex>, <time>, <uuid>, <ip>).`, "", `Top ${Math.min(top, all.m.size)} shapes (count, first line, shape):`];
  for (const [sh, e] of all.top(top)) L.push(`${n(e.count).padStart(10)}  line ${n(e.first).padEnd(9)} ${sh || "(empty line)"}`);
  if (all.pruned) L.push(`(There are many rare shapes; shapes seen once were dropped from the count to keep memory small, so the rare ones above may be undercounted.)`);
  L.push("", severe ? `${n(severe)} lines mention ERROR, WARN, FATAL, Exception or similar. Most frequent:` : "No lines mention ERROR, WARN, FATAL, Exception or similar.");
  for (const [sh, e] of bad.top(Math.min(top, 15))) L.push(`${n(e.count).padStart(10)}  line ${n(e.first).padEnd(9)} ${show(e.example)}${e.count > 1 ? `\n${"".padStart(27)}shape: ${sh}` : ""}`);
  return L.join("\n");
}

async function sample(abs: string, rel: string, a: PeekArgs): Promise<string> {
  const k = clampInt(a.lines, 10, 1, 100), w = clampInt(a.windows, 8, 1, 50);
  const total = await scanLines(abs, () => {}); if (!total) return `${rel} is empty.`;
  // windows never overlap: a small file is simply shown in pieces of k lines
  const starts: number[] = [];
  if (total <= k * w) for (let s = 1; s <= total; s += k) starts.push(s);
  else for (let i = 0; i < w; i++) starts.push(w === 1 ? 1 : 1 + Math.floor((i * (total - k)) / (w - 1)));
  const want = new Map<number, number>(); starts.forEach((s, i) => { for (let j = 0; j < k && s + j <= total; j++) want.set(s + j, i); });
  const got: string[][] = starts.map(() => []); const lastWanted = Math.max(...want.keys());
  await scanLines(abs, (t, len, no) => { const i = want.get(no); if (i !== undefined) got[i].push(own(`${String(no).padStart(9)}  ${show(t, len)}`)); return no < lastWanted; });
  return [`${rel}: ${n(total)} lines; ${starts.length} windows of up to ${k} lines, evenly spaced:`, ...got.map((g, i) => `\n--- window ${i + 1} (from line ${n(starts[i])}, ${Math.round(((starts[i] - 1) / total) * 100)}% into the file) ---\n${g.join("\n")}`)].join("\n");
}

async function around(abs: string, rel: string, a: PeekArgs): Promise<string> {
  if (!a.pattern) return "Error: mode 'around' needs pattern (a regular expression to look for).";
  let re: RegExp; try { re = new RegExp(String(a.pattern), a.ignore_case ? "i" : ""); } catch { return "Error: that is not a valid regular expression."; }
  const maxM = clampInt(a.max_matches, 10, 1, 50), ctx = clampInt(a.context, 3, 0, 20);
  const before: Array<[number, string]> = []; const blocks: string[][] = []; let cur: string[] | null = null, afterLeft = 0, lastShown = 0, matches = 0, firstNo = 0, lastNo = 0;
  const lines = await scanLines(abs, (t, len, no) => {
    const hit = re.test(t); const row = (mark: string) => `${mark}${String(no).padStart(9)}  ${show(t, len)}`;
    if (hit) { matches++; if (!firstNo) firstNo = no; lastNo = no; }
    if (hit && matches <= maxM) {
      // a match close to the previous block continues it; otherwise a new block starts
      if (!cur || (afterLeft <= 0 && no - lastShown > ctx + 1)) { cur = []; blocks.push(cur); }
      for (const [bn, bt] of before) if (bn > lastShown) cur.push(own(`${String(bn).padStart(10)}  ${bt}`));
      cur.push(own(row(">"))); lastShown = no; afterLeft = ctx;
    } else if (cur && afterLeft > 0) { cur.push(own(row(hit ? ">" : " "))); lastShown = no; afterLeft--; }
    before.push([no, show(t, len)]); if (before.length > ctx) before.shift();
  });
  if (!matches) return `${rel}: no line of ${n(lines)} matches /${a.pattern}/${a.ignore_case ? "i" : ""}.`;
  return [`${rel}: ${n(matches)} matching line(s) of ${n(lines)} (first at line ${n(firstNo)}, last at line ${n(lastNo)}). Showing the first ${Math.min(matches, maxM)} with ${ctx} line(s) around each (> marks a match):`, ...blocks.map((b) => b.join("\n"))].join("\n--\n");
}

const typeOf = (v: any): string => v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v === "boolean" ? "boolean" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$/.test(v) ? "date" : "string";
const typeOfCell = (s: string): string => { const t = s.trim(); if (!t) return "empty"; if (/^-?\d+$/.test(t)) return "integer"; if (/^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return "number"; if (/^(true|false)$/i.test(t)) return "boolean"; if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$/.test(t)) return "date"; if (/^(null|NULL|NaN|N\/A|n\/a)$/.test(t)) return "null"; return "string"; };
interface Col { name: string; types: Map<string, number>; values: Map<string, number> | null; seen: number }
async function columns(abs: string, rel: string, a: PeekArgs): Promise<string> {
  const fmt = detectFormat(headLines(abs), rel);
  if (fmt.kind !== "csv" && fmt.kind !== "jsonl") return `Error: mode 'columns' works for csv and jsonl files; ${rel} looks like ${fmtName(fmt)}. Use summary, patterns or around instead.`;
  const maxRows = clampInt(a.max_rows, 200_000, 1, 5_000_000); const LOW = 20, cols = new Map<string, Col>(); let rows = 0, badRows = 0, header: string[] | null = null, cutRows = false, wrongWidth = 0;
  const col = (name: string) => { let c = cols.get(name); if (!c) { if (cols.size >= 200) return null; c = { name, types: new Map(), values: new Map(), seen: 0 }; cols.set(name, c); } return c; };
  const note = (c: Col | null, type: string, val: string) => { if (!c) return; c.seen++; c.types.set(type, (c.types.get(type) || 0) + 1); if (c.values) { const v = own(val.length > 80 ? val.slice(0, 80) + "..." : val); c.values.set(v, (c.values.get(v) || 0) + 1); if (c.values.size > LOW) c.values = null; } };
  const lines = await scanLines(abs, (t) => {
    if (!t.trim()) return;
    if (fmt.kind === "csv") {
      const f = splitCsv(t, fmt.delim!); if (!header) { header = f.map((h, i) => h.trim() || `column ${i + 1}`); header.forEach((h) => col(h)); return; }
      if (rows >= maxRows) { cutRows = true; return false; } rows++; if (f.length !== header.length) wrongWidth++;
      header.forEach((h, i) => { const v = f[i] ?? ""; note(cols.get(h) || null, typeOfCell(v), v.trim()); });
    } else {
      if (rows >= maxRows) { cutRows = true; return false; } rows++;
      let o: any; try { o = JSON.parse(t); } catch { badRows++; return; } if (!o || typeof o !== "object" || Array.isArray(o)) { badRows++; return; }
      for (const [k, v] of Object.entries(o)) note(col(k), typeOf(v), v !== null && typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  });
  const L = [`${rel}: ${fmtName(fmt)}, ${n(cols.size)} field(s)${cols.size >= 200 ? " (only the first 200 are counted)" : ""}, ${n(rows)} row(s) read${cutRows ? ` (stopped at max_rows ${n(maxRows)}; the file has more)` : ` (${n(lines)} lines in all)`}.`];
  if (badRows) L.push(`${n(badRows)} line(s) were not JSON objects.`); if (wrongWidth) L.push(`${n(wrongWidth)} row(s) have a different number of fields than the header (quoted text across lines, or a broken row).`);
  L.push("");
  for (const c of cols.values()) {
    const types = [...c.types.entries()].sort((x, y) => y[1] - x[1]).map(([t, k]) => `${t} ${Math.round((k / Math.max(1, c.seen)) * 100)}%`).join(", ");
    const missing = fmt.kind === "jsonl" && c.seen < rows - badRows ? `, missing in ${n(rows - badRows - c.seen)} row(s)` : "";
    const distinct = c.values ? `${c.values.size} distinct: ` + [...c.values.entries()].sort((x, y) => y[1] - x[1]).map(([v, k]) => `${JSON.stringify(v)} (${n(k)})`).join(", ") : `more than ${LOW} distinct values`;
    L.push(`- ${c.name}: ${types}${missing}; ${distinct}`);
  }
  return L.join("\n");
}

/** Runs one peek_file mode on a file already checked to be inside the project. */
export async function peekFile(abs: string, rel: string, a: PeekArgs): Promise<string> {
  const mode = String(a.mode || "summary");
  if (!(PEEK_MODES as readonly string[]).includes(mode)) return `Error: mode must be one of ${PEEK_MODES.join(", ")}.`;
  const st = statSync(abs); if (st.isDirectory()) return `Error: ${rel} is a folder. Use list_files.`;
  if (st.size === 0) return `${rel} is empty (0 bytes).`;
  if (head(abs, 8192).includes("\0")) return `${rel}: ${size(st.size)}. It is not a text file (it contains zero bytes), so peek_file cannot read it.`;
  const out = mode === "summary" ? await summary(abs, rel, st.size) : mode === "patterns" ? await patterns(abs, rel, a) : mode === "sample" ? await sample(abs, rel, a) : mode === "around" ? await around(abs, rel, a) : await columns(abs, rel, a);
  return capOutput(out);
}
