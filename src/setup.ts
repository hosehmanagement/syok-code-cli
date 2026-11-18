// "syok setup": a few plain questions, asked once, saved as your personal defaults in ~/.syok/config.json.
// Order of who wins afterwards: a flag on the command line, then the project's .syok/settings.json, then these defaults.
// Two exceptions, where the stricter choice wins so a project you downloaded cannot loosen yours: confinement and web access.
// The key is never printed: not while you type it, and not afterwards.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { MODES, type Mode, type Settings } from "./perm.ts";
import { addressProblem, keyShape } from "./doctor.ts";
import { workerLimit, DEFAULT_WORKERS, MAX_WORKERS } from "./parallel.ts";

export interface Defaults { mode?: Mode; model?: string; web?: boolean; confine?: boolean | "no-network"; checks?: boolean; parallel_workers?: number }
export interface Config { base?: string; key?: string; defaults?: Defaults; [other: string]: unknown }
export interface SetupIO { ask(question: string, o?: { secret?: boolean }): Promise<string>; say(text: string): void; ended?: () => boolean }

export const configFile = (home = homedir()) => join(home, ".syok", "config.json");
const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;

/** Keeps only the choices this program understands. Anything else in the file is ignored, never guessed at. */
export function cleanDefaults(d: unknown): Defaults {
  const out: Defaults = {}; if (!d || typeof d !== "object" || Array.isArray(d)) return out; const x = d as Record<string, unknown>;
  if (typeof x.mode === "string" && (MODES as readonly string[]).includes(x.mode)) out.mode = x.mode as Mode;
  if (typeof x.model === "string" && MODEL_OK.test(x.model)) out.model = x.model;
  if (typeof x.web === "boolean") out.web = x.web;
  if (x.confine === true || x.confine === false || x.confine === "no-network") out.confine = x.confine;
  if (typeof x.checks === "boolean") out.checks = x.checks;
  if (typeof x.parallel_workers === "number" && Number.isInteger(x.parallel_workers) && x.parallel_workers >= 0 && x.parallel_workers <= MAX_WORKERS) out.parallel_workers = x.parallel_workers;
  return out;
}
export function readConfig(home = homedir()): Config {
  try { const j = JSON.parse(readFileSync(configFile(home), "utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; }
}
/** Written whole and then moved into place, readable by you alone (the file holds your key). */
export function writeConfig(home: string, cfg: Config): void {
  const dir = join(home, ".syok"); mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `config.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, configFile(home));
}
const rank = (c: Settings["confine"]) => (c === "no-network" ? 2 : c ? 1 : 0);
/** Lays your personal defaults under a project's settings. The project wins, except that it cannot loosen confinement or switch web access back on. */
export function applyDefaults(project: Settings, d: Defaults): Settings {
  const s: Settings = { ...project };
  if (d.confine !== undefined && rank(d.confine) > rank(s.confine)) s.confine = d.confine;
  if (d.web === false) s.web = false;
  if (s.checks === undefined && d.checks !== undefined) s.checks = d.checks;
  // Workers spend your keys faster, so a project may lower your number and never raise it.
  if (d.parallel_workers !== undefined) s.parallel_workers = s.parallel_workers === undefined ? d.parallel_workers : Math.min(workerLimit(s), d.parallel_workers);
  return s;
}

const MODE_TEXT: Record<Mode, string> = {
  "ask": "ask me before every edit and every command",
  "accept-edits": "edit files without asking, ask me before commands",
  "plan": "plan only: nothing changes until I approve the plan",
  "auto": "do everything without asking",
} as Record<Mode, string>;
const confineText = (c: Defaults["confine"], platform = process.platform) => (c === "no-network" ? "on, and no network" : c === true ? "on" : c === false ? "off" : platform === "win32" ? "off" : "on (the default on Linux and Mac)");
const yesNo = (b: boolean) => (b ? "on" : "off");

/** Your saved choices in words. The key is described, never shown. */
export function describeDefaults(cfg: Config, env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const d = cleanDefaults(cfg.defaults); const base = String(cfg.base || ""), key = String(cfg.key || "");
  const L = [`Your Syok Code setup (${configFile(home)}):`];
  L.push(`  Syok address          ${base || "not set"}${env.SYOK_BASE_URL ? "   (SYOK_BASE_URL is set on this computer and is used instead)" : ""}`);
  L.push(`  Syok key              ${key ? keyShape(key).text : "not set"}${env.SYOK_API_KEY ? "   (SYOK_API_KEY is set on this computer and is used instead)" : ""}`);
  L.push(`  Asking before acting  ${d.mode ?? "ask"}: ${MODE_TEXT[d.mode ?? "ask"]}`);
  L.push(`  Model                 ${d.model ?? "syok-coder"}`);
  L.push(`  Web search and pages  ${yesNo(d.web !== false)}`);
  L.push(`  Confinement           ${confineText(d.confine)}`);
  L.push(`  Checks after edits    ${yesNo(d.checks !== false)}`);
  L.push(`  Parallel workers      ${(d.parallel_workers ?? DEFAULT_WORKERS) === 0 ? "off" : "up to " + (d.parallel_workers ?? DEFAULT_WORKERS) + " at once, each in its own copy of the project"}`);
  L.push("A flag on the command line wins over these; so does a project's .syok/settings.json (it cannot loosen confinement, switch web back on, or raise the number of workers).");
  L.push("Change them: syok setup     Forget the choices (address and key stay): syok setup --reset");
  return L.join("\n");
}
/** Removes the saved choices and keeps the address and the key. */
export function resetDefaults(home = homedir()): boolean {
  if (!existsSync(configFile(home))) return false; const cfg = readConfig(home); if (!("defaults" in cfg)) return false;
  delete cfg.defaults; writeConfig(home, cfg); return true;
}

export interface SetupOpts {
  home?: string; root: string; io: SetupIO; platform?: string; env?: Record<string, string | undefined>;
  /** Tries confinement on this computer for real. Returns "" when it works, otherwise the reason in words. */
  probe?: (network: boolean) => string;
  /** The project check found in this folder (for example "npm test"), or "". */
  projectCheck?: string;
  hasProgram?: (name: string) => boolean;
  /** True when this folder is a GitHub project without the @syok job yet. */
  canAddJob?: boolean; addJob?: () => { ok: boolean; message: string };
}
export interface SetupResult { saved: boolean; config: Config; notes: string[] }

async function pick<T>(io: SetupIO, question: string, options: Array<{ value: T; text: string }>, current: T): Promise<T> {
  const cur = Math.max(0, options.findIndex((o) => o.value === current));
  io.say(question); options.forEach((o, i) => io.say(`  ${i + 1}. ${o.text}${i === cur ? "   (current)" : ""}`));
  for (let tries = 0; tries < 3; tries++) {
    const a = (await io.ask(`Type a number and press Enter, or just Enter to keep ${cur + 1}: `)).trim();
    if (!a) return options[cur].value;
    const n = Number(a); if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    io.say(`Please type a number from 1 to ${options.length}.`); if (io.ended?.()) break;
  }
  return options[cur].value;
}
async function yn(io: SetupIO, question: string, current: boolean): Promise<boolean> {
  for (let tries = 0; tries < 3; tries++) {
    const a = (await io.ask(`${question} ${current ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (!a) return current; if (a === "y" || a === "yes") return true; if (a === "n" || a === "no") return false;
    io.say("Please answer y or n."); if (io.ended?.()) break;
  }
  return current;
}

export async function runSetup(o: SetupOpts): Promise<SetupResult> {
  const home = o.home || homedir(), io = o.io, platform = o.platform || process.platform, env = o.env || process.env;
  const cfg = readConfig(home); const d = cleanDefaults(cfg.defaults); const notes: string[] = [];
  io.say("Syok Code setup. Eight short questions. Press Enter to keep what is shown as current. Nothing is saved until the end.\n");

  // 1. The address.
  let base = String(cfg.base || "");
  io.say("1 of 8. Your Syok address: the web address of your Syok, for example https://syok-ai.com");
  if (env.SYOK_BASE_URL) io.say("   (SYOK_BASE_URL is set on this computer. It is used instead of what you save here, until you remove it.)");
  for (let tries = 0; tries < 3; tries++) {
    const a = (await io.ask(`Address${base ? ` [${base}]` : ""}: `)).trim(); const next = a || base;
    const p = addressProblem(next); if (!p) { base = next.replace(/\/+$/, ""); break; }
    io.say(`That will not work: ${p}.`); if (io.ended?.() || tries === 2) { notes.push("The address was not changed: " + p + "."); break; }
  }

  // 2. The key. Typed blind, and never repeated back.
  let key = String(cfg.key || "");
  io.say("\n2 of 8. Your Syok key: in Syok, open Developer API and make a key. It starts with syk_ and is shown once.");
  io.say("   What you type or paste here stays hidden.");
  if (env.SYOK_API_KEY) io.say("   (SYOK_API_KEY is set on this computer. It is used instead of what you save here, until you remove it.)");
  const k = (await io.ask(`Key${key ? " [press Enter to keep the saved one]" : ""}: `, { secret: true })).trim();
  if (k) { key = k; const ks = keyShape(k); io.say(ks.ok ? `   Got it: ${ks.text}.` : `   Saved, but it looks unusual: ${ks.text}. The check at the end will tell.`); }
  else if (!key) notes.push("No key was given. Syok Code cannot answer until one is saved: run syok setup again.");

  // 3. How much it asks.
  io.say("");
  let mode = await pick<Mode>(io, "3 of 8. How much should it ask before acting?", (MODES as readonly Mode[]).map((m) => ({ value: m, text: `${m}: ${MODE_TEXT[m]}` })), d.mode ?? ("ask" as Mode));
  if (mode === ("auto" as Mode) && d.mode !== mode) {
    io.say("   In auto it edits files and runs commands with no question to you. That is meant for a throwaway folder or a confined run.");
    if (!(await yn(io, "   Make auto your everyday default?", false))) { mode = d.mode ?? ("ask" as Mode); io.say(`   Kept ${mode}.`); }
  }

  // 4. The model.
  io.say("");
  const known = [{ value: "syok-coder", text: "syok-coder: tuned for programming" }, { value: "syok-auto", text: "syok-auto: general routing, for all kinds of work" }];
  const curModel = d.model ?? "syok-coder";
  if (!known.some((x) => x.value === curModel)) known.push({ value: curModel, text: `${curModel}: the one you saved` });
  const model = await pick(io, "4 of 8. Which model preset? (Syok still switches providers by itself when one runs out.)", known, curModel);

  // 5. The web.
  io.say("");
  const web = await yn(io, "5 of 8. May it search the web and read pages when that helps? (It still asks before reading a site it has not been allowed.)", d.web !== false);

  // 6. Confinement.
  io.say("");
  let confine: Defaults["confine"] = d.confine ?? (platform === "win32" ? false : true);
  if (platform === "win32") {
    io.say("6 of 8. Confinement on Windows gives write protection: the AI's commands can change files only inside the project folder.");
    io.say("   They can still read your other files. To make it work, the project folder gets a mark that lets low-privilege programs");
    io.say("   write in it; \"syok confine undo\" removes the mark. (Inside WSL, Windows' built-in Linux, you get the full kind instead.)");
    confine = await yn(io, "   Switch it on for every project?", confine === true) ? true : false;
    if (confine && o.probe) {
      const problem = o.probe(true);
      if (problem) { io.say("   This computer cannot do that right now, so it stays off:\n   " + problem.split("\n").join("\n   ")); notes.push("Confinement stayed off: this computer cannot do it yet. Run syok doctor for what is missing."); confine = false; }
      else io.say("   Tried it on this project folder: it works.");
    }
  } else {
    confine = await pick<Defaults["confine"]>(io, "6 of 8. Confinement: hold the AI's commands inside the project folder, so they cannot change your other files or read your keys?", [
      { value: true, text: "on (recommended, and what you get if you never choose): a few commands that reach outside the project, such as Docker, are blocked until you add --no-confine for that run" },
      { value: "no-network", text: "on, and no network for the AI's commands either" },
      { value: false, text: "off" },
    ], confine);
    if (confine && o.probe) {
      const problem = o.probe(confine !== "no-network");
      if (problem) { io.say("   This computer cannot do that right now. Nothing is saved for this question: Syok Code keeps trying at each start, says so in one line, and carries on unconfined until it is fixed:\n   " + problem.split("\n").join("\n   ")); notes.push("Confinement cannot work on this computer yet. Run syok doctor for what is missing."); confine = undefined; }
      else io.say("   Tried it on this computer: it works.");
    }
  }

  // 7. Checks after edits.
  io.say("");
  const checks = await yn(io, `7 of 8. Check its own work: a quick syntax check after each edit, and the project's check before it says it is done${o.projectCheck ? ` (found here: ${o.projectCheck})` : ""}?`, d.checks !== false);

  // 8. Parallel workers.
  io.say("");
  io.say("8 of 8. Parallel workers: for a job that splits into separate parts, several workers can each change one part at the same time,");
  io.say("   each in its own copy of the project (it needs to be a git project). It is faster, and it uses your provider limits faster.");
  io.say("   You are asked every time before workers start.");
  let workers = d.parallel_workers ?? DEFAULT_WORKERS;
  for (let tries = 0; tries < 3; tries++) {
    const a = (await io.ask(`How many at once? 0 switches it off, the most is ${MAX_WORKERS}. Press Enter to keep ${workers}: `)).trim();
    if (!a) break; const n = Number(a);
    if (Number.isInteger(n) && n >= 0 && n <= MAX_WORKERS) { workers = n; break; }
    io.say(`Please type a whole number from 0 to ${MAX_WORKERS}.`); if (io.ended?.()) break;
  }

  const next: Config = { ...cfg, defaults: { mode, model, web, confine, checks, parallel_workers: workers } };
  if (base) next.base = base; if (key) next.key = key;
  writeConfig(home, next);
  io.say("\nSaved.\n\n" + describeDefaults(next, env, home));

  // Only when they apply to this computer or this folder.
  if (o.canAddJob && o.addJob) {
    io.say("");
    if (await yn(io, "This folder is a GitHub project. Add the @syok job, so people can write \"@syok ...\" in its issues and pull requests? (It only writes one file here; nothing is pushed.)", false)) { const r = o.addJob(); io.say(r.message); }
  }
  if ((o.hasProgram ?? (() => false))("code")) notes.push("VS Code is on this computer. The Syok Code add-on for it: https://syok-ai.com/syok-code/syok-code.vsix (in VS Code: Extensions, the ... menu, Install from VSIX).");
  return { saved: true, config: next, notes };
}

/** Questions and answers on the terminal. A secret answer is not shown while it is typed. Works with piped answers too. */
export function terminalIO(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): SetupIO & { close(): void } {
  let muted = false, done = false; const tty = !!input.isTTY;
  const out = new Writable({ write(chunk, _enc, cb) { if (!muted) output.write(chunk); cb(); } });
  const rl = createInterface({ input, output: out, terminal: tty });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(question, o = {}) {
      output.write(question); if (done) { output.write("\n"); return ""; }
      muted = !!o.secret && tty;
      const r = await lines.next(); muted = false;
      if (o.secret && tty) output.write("\n");
      if (r.done) { done = true; output.write("\n"); return ""; }
      return String(r.value);
    },
    say: (text) => { output.write(text + "\n"); },
    ended: () => done,
    close: () => rl.close(),
  };
}
