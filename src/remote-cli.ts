// Command line for remote runs:  syok run --on modal [options] -- <command>   and   syok remote [logs|stop] <n>
import { resolve } from "node:path";
import { remoteRun, remoteLogs, remoteStop, describeRuns, readRun, type Provider, type RunOptions, type Box } from "./remote.ts";
import { modalProvider } from "./remote-modal.ts";
import { codespaceProvider } from "./remote-codespace.ts";

export interface RemoteCliDeps { provider?: (name: string) => Provider | null; out?: (s: string) => void; err?: (s: string) => void; log?: (s: string) => void; onSignal?: (stop: () => Promise<void>) => void }
const VALUE_FLAGS = new Set(["--on", "--image", "--gpu", "--timeout", "--cpu", "--memory", "--out", "--cwd", "--tail", "--codespace"]);
const BOOL_FLAGS = new Set(["--detach", "--no-upload"]);
/** Put the words after "--" back into one command line (a word with spaces or quotes is quoted again). */
export const joinCommand = (words: string[]) => (words.length === 1 ? words[0] : words.map((w) => (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(w) ? w : "'" + w.replace(/'/g, "'\\''") + "'")).join(" "));
export function parseRunArgs(argv: string[]): { flags: Record<string, string>; bools: Set<string>; rest: string[]; command: string; error?: string } {
  const cut = argv.indexOf("--"); const head = cut < 0 ? argv : argv.slice(0, cut), tail = cut < 0 ? [] : argv.slice(cut + 1);
  const flags: Record<string, string> = {}, bools = new Set<string>(), rest: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    if (VALUE_FLAGS.has(a)) { const v = head[i + 1]; if (v === undefined || v.startsWith("--")) return { flags, bools, rest, command: "", error: `${a} needs a value.` }; flags[a] = v; i++; }
    else if (BOOL_FLAGS.has(a)) bools.add(a);
    else if (a.startsWith("--")) return { flags, bools, rest, command: "", error: `Unknown option ${a}. See: syok --help` };
    else rest.push(a);
  }
  return { flags, bools, rest, command: joinCommand(tail) };
}
const num = (s: string | undefined) => (s === undefined ? undefined : /^\d+(\.\d+)?$/.test(s) ? +s : NaN);

export async function remoteCommand(argv: string[], d: RemoteCliDeps = {}): Promise<number> {
  const out = d.out || ((s: string) => void process.stdout.write(s)), err = d.err || ((s: string) => void process.stderr.write(s)), log = d.log || ((s: string) => console.log(s));
  const fail = (m: string, code = 2) => { err(m + "\n"); return code; };
  const sub = argv[0]; const a = parseRunArgs(argv.slice(1));
  if (a.error) return fail(a.error);
  const root = resolve(a.flags["--cwd"] || process.cwd());
  // Running on a Codespace is switched on only after its live test has passed (SYOK_EXPERIMENTAL=codespace tries it early).
  const codespaceOn = /(^|,)\s*codespace\s*(,|$)/i.test(process.env.SYOK_EXPERIMENTAL || "");
  const available = codespaceOn ? "modal, codespace" : "modal";
  const pick = d.provider || ((name: string) => (name === "modal" ? modalProvider() : name === "codespace" && codespaceOn ? codespaceProvider({ name: a.flags["--codespace"] }) : null));
  const io = { log, out, err };

  if (sub === "remote") {
    const act = a.rest[0] || "list";
    if (act === "list") { log(describeRuns(root)); return 0; }
    if (!["logs", "stop"].includes(act) || !/^\d+$/.test(a.rest[1] || "")) return fail("Use: syok remote | syok remote logs <n> [--tail 200] | syok remote stop <n>");
    const rec = readRun(root, +a.rest[1]);
    const p = pick(rec?.provider === "Codespace" ? "codespace" : "modal"); if (!p) return fail("That cloud is not available here.");
    try {
      if (act === "logs") await remoteLogs(p, root, +a.rest[1], io, { tail: num(a.flags["--tail"]) || undefined });
      else await remoteStop(p, root, +a.rest[1], io);
      return 0;
    } catch (e: any) { return fail(String(e?.message || e), 1); }
    finally { p.close(); }
  }

  // syok run
  const on = (a.flags["--on"] || "").toLowerCase();
  if (!on) return fail('Say where to run it: syok run --on modal -- <command>');
  if (a.rest.length) return fail(`Put the command after "--", like: syok run --on ${on} -- ${a.rest.join(" ")}`);
  const p = pick(on);
  if (!p) return fail(`"${on}" is not a place Syok Code can run jobs yet. Available: ${d.provider ? "modal" : available}`);
  const numbers = { timeoutMin: num(a.flags["--timeout"]), cpu: num(a.flags["--cpu"]), memoryMiB: num(a.flags["--memory"]) };
  for (const [k, v] of Object.entries(numbers)) if (Number.isNaN(v) || (v !== undefined && v <= 0)) return fail(`--${k === "timeoutMin" ? "timeout" : k === "memoryMiB" ? "memory" : k} must be a number above 0.`);
  const o: RunOptions = { root, command: a.command, image: a.flags["--image"], gpu: a.flags["--gpu"], ...numbers, out: a.flags["--out"], upload: !a.bools.has("--no-upload"), detach: a.bools.has("--detach") };
  let box: Box | null = null, stopping = false;
  // Ctrl+C must not leave a rented computer on.
  const stop = async () => { if (stopping) return; stopping = true; err("\nStopping: switching the remote computer off...\n"); try { await box?.terminate(); } catch {} p.close(); };
  if (d.onSignal) d.onSignal(stop); else process.once("SIGINT", () => void stop().then(() => process.exit(130)));
  try {
    const r = await remoteRun(p, o, { ...io, onBox: (b) => { box = b; } });
    if (r.detached) box = null;
    if (!r.detached) log(`Exit code ${r.exitCode}.`);
    return r.detached ? 0 : r.exitCode === 0 ? 0 : r.exitCode > 0 && r.exitCode < 256 ? r.exitCode : 1;
  } catch (e: any) { return fail(String(e?.message || e), stopping ? 130 : 1); }
  finally { p.close(); }
}
