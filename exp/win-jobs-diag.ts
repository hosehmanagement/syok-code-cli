// Experiment (Windows): why does a saved job show "lost" after the program that started it exits?
// Variant A: the real startJob (runner started with detached:false on Windows).
// Variant B: the same runner started with detached:true + windowsHide.
// For each: after the starter exits, is the runner really dead (tasklist) or does only our alive() check say so?
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const MAIN = join(import.meta.dir, "..", "src", "main.ts");
const JOBS = join(import.meta.dir, "..", "src", "jobs.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tasklist(pid: number) { const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }); return (r.stdout || "").trim().replace(/\s+/g, " ").slice(0, 120); }
function killZero(pid: number) { try { process.kill(pid, 0); return "ok (alive)"; } catch (e: any) { return "threw " + e.code; } }
for (const variant of ["A-real-startJob", "B-detached-true"]) {
  const d = mkdtempSync(join(tmpdir(), "wj-"));
  writeFileSync(join(d, "tick.js"), "let n=0; setInterval(()=>console.log('tick '+(++n)),200);");
  const starter = join(d, "starter.ts");
  if (variant.startsWith("A")) writeFileSync(starter, `process.env.SYOK_ENTRY=${JSON.stringify(MAIN)}; const { startJob } = await import(${JSON.stringify(JOBS)}); console.log(startJob(${JSON.stringify(d)}, "node tick.js"));`);
  else writeFileSync(starter, `import { spawn } from "node:child_process"; import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path";
const dir = join(${JSON.stringify(d)}, ".syok", "jobs", "1"); mkdirSync(dir, { recursive: true });
const meta = { id: 1, cmd: "node tick.js", cwd: ${JSON.stringify(d)}, started: Date.now(), runner: 0, maxSec: 0 };
writeFileSync(join(dir, "meta.json"), JSON.stringify(meta)); writeFileSync(join(dir, "out.log"), "");
const r = spawn(process.execPath, [${JSON.stringify(MAIN)}, "__jobrun", dir], { detached: true, stdio: "ignore", windowsHide: true }); r.unref();
meta.runner = r.pid || 0; writeFileSync(join(dir, "meta.json"), JSON.stringify(meta)); console.log(1);`);
  const s = spawnSync(process.execPath, [starter], { encoding: "utf8", env: { ...process.env } });
  console.log(`\n=== ${variant}: starter exit ${s.status}; out ${JSON.stringify((s.stdout || "").trim())} err ${JSON.stringify((s.stderr || "").trim().slice(0, 300))}`);
  await sleep(3000);
  const dir = join(d, ".syok", "jobs", "1");
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const child = existsSync(join(dir, "child.pid")) ? +readFileSync(join(dir, "child.pid"), "utf8") : 0;
  const log = readFileSync(join(dir, "out.log"), "utf8");
  console.log(`runner pid ${meta.runner}: tasklist -> ${tasklist(meta.runner)} | process.kill(pid,0) -> ${killZero(meta.runner)}`);
  console.log(`child pid ${child}: tasklist -> ${child ? tasklist(child) : "-"} | process.kill(pid,0) -> ${child ? killZero(child) : "-"}`);
  console.log(`log lines: ${log.split("\n").filter(Boolean).length} (last: ${JSON.stringify(log.trim().split("\n").pop())}); code file: ${existsSync(join(dir, "code")) ? readFileSync(join(dir, "code"), "utf8") : "none"}`);
  for (const p of [child, meta.runner]) if (p) spawnSync("taskkill", ["/pid", String(p), "/T", "/F"]);
}
