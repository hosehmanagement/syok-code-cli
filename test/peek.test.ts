// peek_file: a look inside files too big to read. Every mode on small files, then a generated 300 MB log that must be
// read as a stream (memory stays small) in a few seconds.
import { test, expect } from "bun:test";
import { writeFileSync, openSync, writeSync, closeSync, mkdtempSync, rmSync, statSync, symlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tmpProject } from "./helpers.ts";
import { makeCtx, runTool, toolDefs, READONLY } from "../src/tools.ts";
import { DEFAULT } from "../src/profiles.ts";
import { peekFile, shapeOf, detectFormat, splitCsv, scanLines, capOutput, PEEK_MAX_CHARS } from "../src/peek.ts";

const LOG = [
  "2026-11-22T10:00:00.120Z INFO request 101 served in 12ms user=u42",
  "2026-11-22T10:00:01.300Z INFO request 102 served in 7ms user=u7",
  "2026-11-22T10:00:02.001Z ERROR db timeout after 3000ms id=550e8400-e29b-41d4-a716-446655440000",
  "2026-11-22T10:00:03.000Z INFO request 103 served in 15ms user=u42",
  "2026-11-22T10:00:04.000Z WARN slow disk 0x7ffe12 at 10.0.0.12:5432",
  "2026-11-22T10:00:05.000Z ERROR db timeout after 2500ms id=6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "2026-11-22T10:00:06.000Z INFO request 104 served in 9ms user=u9",
  "java.lang.IllegalStateException: boom",
].join("\n") + "\n";
const ctxFor = (d: string, mode: any = "auto") => makeCtx(d, mode, async () => true, {} as any, DEFAULT);

test("shapes: uuids, timestamps, hex ids, addresses and numbers become placeholders", () => {
  expect(shapeOf("2026-11-22T10:00:00.123Z ERROR id=550e8400-e29b-41d4-a716-446655440000 took 12.5ms from 10.0.0.1:8080 req123 hash=3f2a9c1d77 0xFF"))
    .toBe("<time> ERROR id=<uuid> took <n>ms from <ip> req<n> hash=<hex> <hex>");
  expect(shapeOf("Nov 22 10:00:01 host sshd[1234]: Accepted")).toBe("<time> host sshd[<n>]: Accepted");
  expect(shapeOf("2026-11-22 10:00:00+08:00 a 2026/11/22 b 12:30:45,5")).toBe("<time> a <time> b <time>");
  expect(shapeOf("deadbeefcafe served 96753735")).toBe("<hex> served <n>"); // plain words keep their letters
});

test("formats are recognised from the first lines", () => {
  expect(detectFormat(LOG.split("\n"), "app.log").kind).toBe("log");
  expect(detectFormat(['{"a":1}', '{"a":2,"b":"x"}'], "x.txt").kind).toBe("jsonl");
  expect(detectFormat(["[", '  {"a": 1}', "]"], "x.json").kind).toBe("json");
  expect(detectFormat(["id,name,city", "1,Ann,KL", '2,"Lee, Bo",Penang'], "x.txt")).toEqual({ kind: "csv", delim: "," });
  expect(detectFormat(["a\tb", "1\t2"], "x.tsv")).toEqual({ kind: "csv", delim: "\t" });
  expect(detectFormat(["just some words", "and more words"], "notes.txt").kind).toBe("other");
  expect(splitCsv('2,"Lee, Bo","say ""hi"""', ",")).toEqual(["2", "Lee, Bo", 'say "hi"']);
});

test("summary: size, line count, first and last lines, line lengths, format", async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `2026-11-22T10:00:${String(i % 60).padStart(2, "0")}Z INFO line ${i + 1}`);
  const d = tmpProject({ "app.log": lines.join("\r\n") + "\r\n" });
  const out = await runTool(ctxFor(d), "peek_file", { path: "app.log" }); // summary is the default
  expect(out).toContain("app.log: "); expect(out).toContain("60 lines, format: log");
  expect(out).toContain("First 20 lines:"); expect(out).toContain("      1  2026-11-22T10:00:00Z INFO line 1\n"); expect(out).toContain("     20  2026-11-22T10:00:19Z INFO line 20");
  expect(out).toContain("Last 20 lines:"); expect(out).toContain("     41  "); expect(out).toContain("     60  2026-11-22T10:00:59Z INFO line 60");
  expect(out).not.toContain("     21  "); expect(out).not.toContain("\r");
  expect(out).toMatch(/shortest 32, longest 33, average 32\.9, median 33/); // lines 1-9 have 32 characters, lines 10-60 have 33
  // a file without a newline at the end, and one huge line, are counted right
  writeFileSync(join(d, "one.txt"), "a\nbb\n" + "x".repeat(50000));
  const one = await runTool(ctxFor(d), "peek_file", { path: "one.txt", mode: "summary" });
  expect(one).toContain("3 lines"); expect(one).toContain("longest 50,000"); expect(one).toContain("1 longer than 4096"); expect(one).toContain("...[+49700 chars]");
});

test("patterns: the most frequent shapes with counts and first line, and the error lines", async () => {
  const d = tmpProject({ "app.log": LOG });
  const out = await peekFile(join(d, "app.log"), "app.log", { mode: "patterns" });
  expect(out).toContain("8 lines, 4 different shapes"); // INFO request, ERROR timeout, WARN slow disk, the exception
  expect(out).toMatch(/\n\s+1  line 8\s+java\.lang\.IllegalStateException: boom\n/);
  expect(out).toMatch(/\n\s+4  line 1\s+<time> INFO request <n> served in <n>ms user=u<n>\n/);
  expect(out).toMatch(/\n\s+2  line 3\s+<time> ERROR db timeout after <n>ms id=<uuid>\n/);
  expect(out).toMatch(/\n\s+1  line 5\s+<time> WARN slow disk <hex> at <ip>\n/);
  expect(out).toContain("4 lines mention ERROR, WARN, FATAL, Exception or similar");
  expect(out).toContain("2026-11-22T10:00:02.001Z ERROR db timeout after 3000ms"); expect(out).toContain("java.lang.IllegalStateException: boom");
  expect(out.indexOf("ERROR db timeout")).toBeLessThan(out.indexOf("IllegalStateException")); // most frequent first
  expect(await peekFile(join(d, "app.log"), "app.log", { mode: "patterns", top: 1 })).not.toContain("WARN slow disk <hex>");
});

test("sample: evenly spaced windows of lines from the whole file", async () => {
  const d = tmpProject({ "n.txt": Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`).join("\n") + "\n" });
  const out = await peekFile(join(d, "n.txt"), "n.txt", { mode: "sample", windows: 4, lines: 3 });
  expect(out).toContain("1,000 lines; 4 windows of up to 3 lines");
  for (const s of [1, 333, 665, 998]) expect(out).toContain(`(from line ${s.toLocaleString("en-US")}`);
  expect(out).toContain("        1  row 1\n"); expect(out).toContain("      335  row 335"); expect(out).toContain("     1000  row 1000"); expect(out).not.toContain("row 4\n");
  const small = await peekFile(join(d, "n.txt"), "n.txt", { mode: "sample", windows: 50, lines: 100 }); expect(small).toContain("window 10 (from line 901"); expect(small.length).toBeLessThanOrEqual(PEEK_MAX_CHARS + 100); // capped
});

test("around: lines around the first matches of a regular expression, with the total count", async () => {
  const d = tmpProject({ "app.log": LOG });
  const out = await peekFile(join(d, "app.log"), "app.log", { mode: "around", pattern: "ERROR", context: 1, max_matches: 1 });
  expect(out).toContain("2 matching line(s) of 8 (first at line 3, last at line 6). Showing the first 1 with 1 line(s) around each");
  expect(out).toContain("         2  2026-11-22T10:00:01.300Z INFO"); expect(out).toContain(">        3  2026-11-22T10:00:02.001Z ERROR"); expect(out).toContain("         4  2026-11-22T10:00:03.000Z INFO");
  expect(out).not.toContain("10:00:05");
  const both = await peekFile(join(d, "app.log"), "app.log", { mode: "around", pattern: "error", ignore_case: true, context: 1 });
  expect(both).toContain(">        6  "); expect(both).toContain("         5  "); expect(both.match(/        4  /g)!.length).toBe(1); // close matches share one block, no line twice
  expect(await peekFile(join(d, "app.log"), "app.log", { mode: "around", pattern: "nothing-like-this" })).toContain("no line of 8 matches");
  expect(await peekFile(join(d, "app.log"), "app.log", { mode: "around", pattern: "(" })).toContain("not a valid regular expression");
  expect(await peekFile(join(d, "app.log"), "app.log", { mode: "around" })).toContain("needs pattern");
});

test("columns: csv and jsonl field names, types and the values of low-cardinality fields", async () => {
  const rows = ["id,name,city,score,active,joined"]; for (let i = 1; i <= 100; i++) rows.push(`${i},"Person ${i}",${["KL", "Penang", "Ipoh"][i % 3]},${(i * 1.5).toFixed(1)},${i % 2 ? "true" : "false"},2026-01-${String((i % 28) + 1).padStart(2, "0")}`);
  const d = tmpProject({ "p.csv": rows.join("\n") + "\n", "e.jsonl": ['{"level":"info","ms":12,"tags":["a"]}', '{"level":"error","ms":3.5,"user":null}', '{"level":"info","ms":7}', "not json"].join("\n") + "\n", "doc.json": '{\n  "a": [1, 2]\n}\n' });
  const csv = await peekFile(join(d, "p.csv"), "p.csv", { mode: "columns" });
  expect(csv).toContain('csv (separator ","), 6 field(s), 100 row(s) read');
  expect(csv).toContain("- id: integer 100%; more than 20 distinct values"); expect(csv).toContain("- name: string 100%; more than 20 distinct values");
  expect(csv).toContain('- city: string 100%; 3 distinct: "Penang" (34), "Ipoh" (33), "KL" (33)'); expect(csv).toContain("- score: number");
  expect(csv).toContain('- active: boolean 100%; 2 distinct: "true" (50), "false" (50)'); expect(csv).toContain("- joined: date 100%");
  const jl = await peekFile(join(d, "e.jsonl"), "e.jsonl", { mode: "columns" });
  expect(jl).toContain("jsonl (one JSON value per line), 4 field(s), 4 row(s) read"); expect(jl).toContain("1 line(s) were not JSON objects");
  expect(jl).toContain('- level: string 100%; 2 distinct: "info" (2), "error" (1)'); expect(jl).toContain("- ms: integer 67%, number 33%");
  expect(jl).toContain("- tags: array 100%, missing in 2 row(s)"); expect(jl).toContain("- user: null 100%, missing in 2 row(s)");
  expect(await peekFile(join(d, "p.csv"), "p.csv", { mode: "columns", max_rows: 10 })).toContain("10 row(s) read (stopped at max_rows 10; the file has more)");
  expect(await peekFile(join(d, "doc.json"), "doc.json", { mode: "columns" })).toContain("works for csv and jsonl files");
});

test("only inside the project, read-only, offered in planning mode and to read-only helpers, answers capped", async () => {
  const out = mkdtempSync(join(tmpdir(), "syok-peek-out-")); writeFileSync(join(out, "secret.log"), "outside\n");
  const d = tmpProject({ "a.log": "x\n", "bin.dat": "", "empty.txt": "" }); writeFileSync(join(d, "bin.dat"), Buffer.from([1, 0, 2, 0, 3]));
  try {
    const c = ctxFor(d);
    expect(await runTool(c, "peek_file", { path: "../x.log" })).toContain("outside the project folder");
    expect(await runTool(c, "peek_file", { path: join(out, "secret.log") })).toContain("outside the project folder");
    let linked = true; try { symlinkSync(join(out, "secret.log"), join(d, "link.log")); } catch { linked = false; } // Windows may not allow links
    if (linked) { const r = await runTool(c, "peek_file", { path: "link.log" }); expect(r).toContain("outside the project folder"); expect(r).not.toContain("outside\n"); }
    expect(await runTool(c, "peek_file", { path: "none.log" })).toContain("does not exist");
    mkdirSync(join(d, "sub")); expect(await runTool(c, "peek_file", { path: "sub" })).toContain("is a folder");
    expect(await runTool(c, "peek_file", { path: "bin.dat" })).toContain("not a text file");
    expect(await runTool(c, "peek_file", { path: "empty.txt" })).toContain("is empty");
    expect(await runTool(c, "peek_file", { path: "a.log", mode: "everything" })).toContain("mode must be one of summary, patterns, sample, around, columns");
    expect(READONLY.has("peek_file")).toBe(true);
    expect(toolDefs(ctxFor(d, "plan")).some((t: any) => t.function.name === "peek_file")).toBe(true);
    const ro = ctxFor(d); ro.allowed = READONLY; ro.depth = 1; expect(toolDefs(ro).some((t: any) => t.function.name === "peek_file")).toBe(true);
    expect(await runTool(c, "read_file", { path: "a.log" })).toContain("x"); // read_file unchanged for small files
    expect(capOutput("y".repeat(50000)).length).toBeLessThan(PEEK_MAX_CHARS + 100);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test("a 300 MB log is read as a stream: memory stays small and every mode finishes in seconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "syok-peek-big-")); const f = join(dir, "big.log");
  try {
    const fd = openSync(f, "w"); let written = 0, chunk = 0; const target = 300 * 1024 * 1024;
    while (written < target) {
      const rows: string[] = [];
      for (let i = 0; i < 12000; i++) { const k = chunk * 12000 + i; rows.push(i % 997 === 0 ? `2026-11-22T10:${String(k % 60).padStart(2, "0")}:00Z ERROR db timeout after ${k % 900}ms id=${(k * 2654435761 >>> 0).toString(16)}` : `2026-11-22T10:${String(k % 60).padStart(2, "0")}:${String(k % 60).padStart(2, "0")}Z INFO request ${k} served in ${k % 300}ms user=u${k % 5000}`); }
      const b = Buffer.from(rows.join("\n") + "\n"); writeSync(fd, b); written += b.length; chunk++;
    }
    closeSync(fd); const size = statSync(f).size; expect(size).toBeGreaterThan(300 * 1024 * 1024); const lineCount = chunk * 12000;
    Bun.gc(true); const base = process.memoryUsage().rss; let peak = base; const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const timed = async (mode: string, extra: any = {}) => { const t = Date.now(); const out = await peekFile(f, "big.log", { mode, ...extra }); peak = Math.max(peak, process.memoryUsage().rss); return { out, ms: Date.now() - t }; };
    try {
      const s = await timed("summary"); expect(s.out).toContain(`${lineCount.toLocaleString("en-US")} lines, format: log`); expect(s.out).toContain("Last 20 lines:"); expect(s.ms).toBeLessThan(8000);
      const sa = await timed("sample"); expect(sa.out).toContain("8 windows"); expect(sa.ms).toBeLessThan(10000);
      const ar = await timed("around", { pattern: "ERROR", max_matches: 3 }); expect(ar.out).toMatch(/[\d,]+ matching line\(s\)/); expect(ar.ms).toBeLessThan(10000);
      const p = await timed("patterns"); expect(p.out).toContain("<time> INFO request <n> served in <n>ms user=u<n>"); expect(p.out).toContain("lines mention ERROR"); expect(p.ms).toBeLessThan(20000);
      for (const r of [s, sa, ar, p]) expect(r.out.length).toBeLessThanOrEqual(PEEK_MAX_CHARS + 100);
      console.log(`  300 MB log: summary ${s.ms} ms, sample ${sa.ms} ms, around ${ar.ms} ms, patterns ${p.ms} ms; memory grew by at most ${Math.round((peak - base) / 1048576)} MB`);
    } finally { clearInterval(iv); }
    expect(peak - base).toBeLessThan(150 * 1024 * 1024); // the file is 300 MB: reading it whole would need far more than this
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 180000);

test("scanLines can stop early", async () => {
  const d = tmpProject({ "n.txt": "a\nb\nc\nd\n" }); const seen: string[] = [];
  await scanLines(join(d, "n.txt"), (t, _l, no) => { seen.push(t); return no < 2; }); expect(seen).toEqual(["a", "b"]);
});
