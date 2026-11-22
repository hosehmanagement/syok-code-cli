// The QUICK local grade: run the row's official eval_script in a fresh container with the model patch applied, then read
// the test results. It is a simplified port of three of the harness's log parsers (swebench/harness/log_parsers/python.py:
// parse_log_pytest, parse_log_django, parse_log_sympy) and the harness's pass rule (grading.py: a test passes when its status
// is PASSED or XFAIL; a missing test counts as failed). It is for a fast look only. The official harness is the authority:
// it has repository-specific parsers this one does not have, so a quick result can differ from the official one.
export type Status = "PASSED" | "FAILED" | "ERROR" | "SKIPPED" | "XFAIL" | "XPASS";
const STATUSES: Status[] = ["PASSED", "FAILED", "ERROR", "SKIPPED", "XFAIL", "XPASS"];
export const START = ">>>>> Start Test Output", END = ">>>>> End Test Output";

/** Only the part of the log between the eval script's start and end markers (the whole log when they are missing). */
export function testSection(log: string): string {
  const s = log.indexOf(START), e = log.lastIndexOf(END);
  return s >= 0 && e > s ? log.slice(s + START.length, e) : log;
}
export function parsePytest(log: string): Record<string, Status> {
  const m: Record<string, Status> = {};
  for (let line of log.split("\n")) {
    const st = STATUSES.find((x) => line.startsWith(x));
    if (!st) continue;
    if (st === "FAILED") line = line.replace(" - ", " ");
    const parts = line.split(/\s+/);
    if (parts.length > 1 && parts[1]) m[parts[1]] = st;
  }
  return m;
}
export function parseDjango(log: string): Record<string, Status> {
  const m: Record<string, Status> = {};
  let prev: string | null = null;
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (line.includes(" ... ")) prev = line.split(" ... ")[0];
    for (const suf of [" ... ok", " ... OK", " ...  OK"]) if (line.endsWith(suf)) { m[line.slice(0, -suf.length)] = "PASSED"; break; }
    if (line.includes(" ... skipped")) m[line.split(" ... skipped")[0]] = "SKIPPED";
    if (line.endsWith(" ... FAIL")) m[line.slice(0, -" ... FAIL".length)] = "FAILED";
    if (line.startsWith("FAIL:")) { const t = line.split(/\s+/)[1]; if (t) m[t] = "FAILED"; }
    if (line.endsWith(" ... ERROR")) m[line.slice(0, -" ... ERROR".length)] = "ERROR";
    if (line.startsWith("ERROR:")) { const t = line.split(/\s+/)[1]; if (t) m[t] = "ERROR"; }
    if (line.startsWith("ok") && prev !== null) m[prev] = "PASSED"; // output printed between "..." and "ok"
  }
  return m;
}
export function parseSympy(log: string): Record<string, Status> {
  const m: Record<string, Status> = {};
  for (const x of log.matchAll(/(_*) (.*)\.py:(.*) (_*)/g)) m[`${x[2]}.py:${x[3]}`] = "FAILED";
  for (const raw of log.split("\n")) {
    const line = raw.trim(); if (!line.startsWith("test_")) continue;
    const t = line.split(/\s+/)[0];
    if (line.endsWith(" E")) m[t] = "ERROR"; if (line.endsWith(" F")) m[t] = "FAILED"; if (line.endsWith(" ok")) m[t] = "PASSED";
  }
  return m;
}
export function parseLog(log: string, parser?: string): { statuses: Record<string, Status>; parser: string } {
  const sec = testSection(log);
  if (parser === "parse_log_django") return { statuses: parseDjango(sec), parser: "django" };
  if (parser === "parse_log_sympy") return { statuses: parseSympy(sec), parser: "sympy" };
  return { statuses: parsePytest(sec), parser: parser && parser !== "parse_log_pytest" ? `pytest (stand-in for ${parser})` : "pytest" };
}
const passed = (t: string, m: Record<string, Status>) => m[t] === "PASSED" || m[t] === "XFAIL";
export interface Grade { resolved: boolean; failToPass: { passed: number; total: number; failing: string[] }; passToPass: { passed: number; total: number; failing: string[] }; parser: string }
export function grade(log: string, f2p: string[], p2p: string[], parser?: string): Grade {
  const { statuses, parser: used } = parseLog(log, parser);
  const f = f2p.filter((t) => !passed(t, statuses)), p = p2p.filter((t) => !passed(t, statuses));
  return { resolved: f2p.length > 0 && !f.length && !p.length, failToPass: { passed: f2p.length - f.length, total: f2p.length, failing: f.slice(0, 20) }, passToPass: { passed: p2p.length - p.length, total: p2p.length, failing: p.slice(0, 20) }, parser: used };
}
