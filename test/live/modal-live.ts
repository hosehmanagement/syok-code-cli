// LIVE test against the real Modal service. Costs a few cents of the account's credit (CPU only, about a minute).
// Run:  MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... bun test/live/modal-live.ts
// It is not part of "bun test": it needs a real account. The "modal live test" workflow runs it when the two secrets exist.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteRun, remoteLogs, remoteStop, describeRuns } from "../../src/remote.ts";
import { modalProvider, modalHasToken } from "../../src/remote-modal.ts";

if (!modalHasToken()) { console.log("SKIPPED: no Modal token on this machine (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET)."); process.exit(0); }
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + detail)); if (!ok) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const d = mkdtempSync(join(tmpdir(), "syok-live-")); mkdirSync(join(d, "data"));
writeFileSync(join(d, "job.py"), "import sys, os\nprint('py', sys.version_info[0])\nprint(open('data/in.txt').read().strip())\nprint('warn', file=sys.stderr)\nos.makedirs('results', exist_ok=True)\nopen('results/out.txt','w').write('made-remotely\\n')\nprint('env-file-present' if os.path.exists('.env') else 'env-file-absent')\n");
writeFileSync(join(d, "data/in.txt"), "INPUT-777\n"); writeFileSync(join(d, ".env"), "SECRET=1\n");
writeFileSync(join(d, "tick.sh"), "i=0; mkdir -p results; while [ $i -lt 6 ]; do i=$((i+1)); echo tick $i; echo $i > results/last.txt; sleep 2; done; exit 3\n");
const p = modalProvider();
const mk = () => { const s = { out: "", err: "", log: [] as string[] }; return { s, io: { out: (x: string) => { s.out += x; process.stdout.write(x); }, err: (x: string) => { s.err += x; process.stderr.write(x); }, log: (x: string) => { s.log.push(x); console.log(x); } } }; };
try {
  // 1. A normal run: upload, run, stream, exit code, results back, switched off.
  const a = mk(); const r = await remoteRun(p, { root: d, command: "python job.py && echo done-$((6*7))", out: "results", timeoutMin: 10 }, a.io);
  check("exit code 0", r.exitCode === 0, String(r.exitCode));
  check("output streamed", a.s.out.includes("py 3") && a.s.out.includes("INPUT-777") && a.s.out.includes("done-42"), JSON.stringify(a.s.out));
  check("error output streamed separately", a.s.err.includes("warn"), JSON.stringify(a.s.err));
  check("secret file was not sent", a.s.out.includes("env-file-absent"), JSON.stringify(a.s.out));
  check("results came back", existsSync(join(d, "results/out.txt")) && readFileSync(join(d, "results/out.txt"), "utf8") === "made-remotely\n");
  // 2. A failing command keeps its exit code.
  const b = mk(); const r2 = await remoteRun(p, { root: d, command: "echo before; exit 7", upload: false, timeoutMin: 5 }, b.io);
  check("failing command: exit code 7", r2.exitCode === 7, String(r2.exitCode));
  // 3. Detached: survives after the starting connection ends, logs later, stop brings results and switches off.
  const c = mk(); const r3 = await remoteRun(p, { root: d, command: "sh tick.sh", detach: true, out: "results", timeoutMin: 10 }, c.io);
  check("detached run recorded", r3.detached === 1, JSON.stringify(r3));
  p.close(); await sleep(5000); // a brand-new connection, like a new terminal later
  const l1 = mk(); const s1 = await remoteLogs(p, d, 1, l1.io);
  check("detached: output visible from a new connection while running", l1.s.out.includes("tick 1") && !s1.finished, JSON.stringify([l1.s.out, s1]));
  let fin = { finished: false, exitCode: null as number | null };
  for (let i = 0; i < 30 && !fin.finished; i++) { await sleep(2000); fin = await remoteLogs(p, d, 1, mk().io); }
  check("detached: finished with its own exit code 3", fin.finished && fin.exitCode === 3, JSON.stringify(fin));
  const st = await remoteStop(p, d, 1, mk().io);
  check("detached: stop brought results back", st.exitCode === 3 && readFileSync(join(d, "results/last.txt"), "utf8").trim() === "6", JSON.stringify(st));
  check("detached: listed as stopped", /stopped, exit code 3/.test(describeRuns(d)), describeRuns(d));
  let gone = false; try { const bx = await p.attach(r3.boxId); gone = (await bx.exec("true", {})) !== 0; } catch { gone = true; }
  check("detached: the computer is really off after stop", gone);
} catch (e: any) { check("no unexpected error", false, String(e?.stack || e)); }
finally { p.close(); }
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll live checks passed.");
process.exit(failed ? 1 : 0);
