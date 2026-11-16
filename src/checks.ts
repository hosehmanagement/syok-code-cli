// Checks after edits.
// 1. quickCheck: right after the AI writes a file, a fast syntax check of that one file. The result is added to the tool's answer,
//    so a broken bracket is seen (and fixed) immediately instead of several steps later.
// 2. projectCheck: when the AI says it is finished and it changed files, the project's own check (type-check or linter) runs once.
//    If it fails, the output goes back to the AI to fix (see checkGate in agent.ts).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Settings } from "./perm.ts";

const have = new Map<string, boolean>();
/** Is this program installed? (asked once per program) */
export function hasProgram(name: string): boolean {
  if (!have.has(name)) { let ok = false; try { ok = spawnSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore", windowsHide: true }).status === 0; } catch {} have.set(name, ok); }
  return have.get(name)!;
}
export function resetProgramCache() { have.clear(); }

function run(cmd: string, args: string[], cwd: string, input?: string, ms = 8000): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    let out = "", done = false;
    const env = { ...process.env }; delete env.SYOK_API_KEY; delete env.GITHUB_TOKEN; delete env.MODAL_TOKEN_SECRET;
    let ch;
    try { ch = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }); } catch (e: any) { return res({ code: -1, out: String(e?.message || e) }); }
    const add = (d: Buffer) => { if (out.length < 20000) out += d.toString(); };
    ch.stdout!.on("data", add); ch.stderr!.on("data", add);
    if (input !== undefined) { ch.stdin!.on("error", () => {}); ch.stdin!.end(input); }
    const t = setTimeout(() => { if (!done) { done = true; try { ch.kill("SIGKILL"); } catch {} res({ code: -2, out: "" }); } }, ms);
    ch.on("close", (code) => { if (done) return; done = true; clearTimeout(t); res({ code: code ?? 1, out: out.trim() }); });
    ch.on("error", () => { if (done) return; done = true; clearTimeout(t); res({ code: -1, out: "" }); });
  });
}
const firstLines = (s: string, n = 12) => s.split("\n").filter((l) => l.trim()).slice(0, n).join("\n").slice(0, 1500);
// JSON files that are allowed to contain comments: a plain JSON check would wrongly fail them.
const JSON_WITH_COMMENTS = /^(tsconfig.*|jsconfig.*|\.eslintrc|\.babelrc|devcontainer|settings|launch|tasks|extensions|.*\.code-workspace)\.json$|\.jsonc$/i;
const PY_CHECK = "import ast,sys\nsrc=sys.stdin.read()\ntry:\n    ast.parse(src, sys.argv[1])\nexcept SyntaxError as e:\n    print('%s:%s: SyntaxError: %s' % (sys.argv[1], e.lineno, e.msg)); sys.exit(1)\n";

export interface QuickResult { tool: string; ok: boolean; problems: string }
/** A fast syntax check of one file. Returns null when this kind of file has no fast check here (unknown type, or the tool is not installed). Never changes any file. */
export async function quickCheck(abs: string, rel: string, root: string): Promise<QuickResult | null> {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(rel)?.[1] || "").toLowerCase();
  let text: string; try { text = readFileSync(abs, "utf8"); } catch { return null; }
  if (text.length > 1_500_000) return null;
  const bad = (tool: string, problems: string): QuickResult => ({ tool, ok: false, problems: firstLines(problems) || "syntax error" });
  const good = (tool: string): QuickResult => ({ tool, ok: true, problems: "" });
  if (ext === "json") {
    if (JSON_WITH_COMMENTS.test(basename(rel))) return null;
    try { JSON.parse(text); return good("JSON syntax"); } catch (e: any) { return bad("JSON syntax", String(e?.message || e)); }
  }
  if (["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"].includes(ext)) {
    // The runtime's own parser: no program to install, a few milliseconds. Syntax only (types are the project check's job).
    const B = (globalThis as any).Bun; if (!B?.Transpiler) return null;
    const loader = ext === "tsx" ? "tsx" : ext === "jsx" ? "jsx" : ext.endsWith("ts") ? "ts" : "js";
    const tool = (loader.startsWith("ts") ? "TypeScript" : "JavaScript") + " syntax";
    try { new B.Transpiler({ loader }).transformSync(text); return good(tool); }
    catch (e: any) {
      const errs: any[] = Array.isArray(e?.errors) && e.errors.length ? e.errors : [e];
      return bad(tool, errs.map((x) => `${rel}${x?.position?.line ? ":" + x.position.line : ""}: ${String(x?.message || x).split("\n")[0]}`).join("\n"));
    }
  }
  const external: Record<string, () => Promise<QuickResult | null>> = {
    py: async () => { const py = hasProgram("python3") ? "python3" : hasProgram("python") ? "python" : ""; if (!py) return null; const r = await run(py, ["-c", PY_CHECK, rel], root, text); return r.code < 0 ? null : r.code === 0 ? good("Python syntax") : bad("Python syntax", r.out); },
    sh: async () => { if (!hasProgram("bash")) return null; const r = await run("bash", ["-n", abs], root); return r.code < 0 ? null : r.code === 0 ? good("bash -n") : bad("bash -n", r.out.split(abs).join(rel)); },
    php: async () => { if (!hasProgram("php")) return null; const r = await run("php", ["-l", abs], root); return r.code < 0 ? null : r.code === 0 ? good("php -l") : bad("php -l", r.out.split(abs).join(rel)); },
    rb: async () => { if (!hasProgram("ruby")) return null; const r = await run("ruby", ["-c", abs], root); return r.code < 0 ? null : r.code === 0 ? good("ruby -c") : bad("ruby -c", r.out.split(abs).join(rel)); },
    go: async () => { if (!hasProgram("gofmt")) return null; const r = await run("gofmt", ["-e", "-l", abs], root); return r.code < 0 ? null : r.code === 0 ? good("gofmt -e") : bad("gofmt -e", r.out.split(abs).join(rel)); },
    lua: async () => { if (!hasProgram("luac")) return null; const r = await run("luac", ["-p", abs], root); return r.code < 0 ? null : r.code === 0 ? good("luac -p") : bad("luac -p", r.out.split(abs).join(rel)); },
  };
  const key = ext === "bash" ? "sh" : ext;
  return external[key] ? external[key]() : null;
}
/** The sentence added to the edit tool's answer. */
export function quickLine(r: QuickResult | null): string {
  if (!r) return "";
  return r.ok ? `\nSyntax check (${r.tool}): OK.` : `\nSyntax check (${r.tool}) FAILED. Fix this before doing anything else:\n${r.problems}`;
}

export interface ProjectCheck { command: string; source: string }
/** The project's own check command: the one in settings, else a well-known one found in the project. Null = none. */
export function projectCheck(root: string, s: Settings = {}): ProjectCheck | null {
  if (s.checks === false) return null;
  if (typeof s.check_command === "string" && s.check_command.trim()) return { command: s.check_command.trim(), source: "check_command in .syok/settings.json" };
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) {
    let scripts: Record<string, unknown> = {}; try { scripts = JSON.parse(readFileSync(pkg, "utf8")).scripts || {}; } catch {}
    const name = ["typecheck", "type-check", "check", "lint"].find((n) => typeof scripts[n] === "string" && String(scripts[n]).trim());
    if (name) {
      const pm = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")) ? "bun" : existsSync(join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(join(root, "yarn.lock")) ? "yarn" : "npm";
      if (hasProgram(pm)) return { command: `${pm} run ${name}`, source: `the "${name}" script in package.json` };
    }
  }
  if (existsSync(join(root, "Cargo.toml")) && hasProgram("cargo")) return { command: "cargo check", source: "Cargo.toml" };
  if (existsSync(join(root, "go.mod")) && hasProgram("go")) return { command: "go vet ./...", source: "go.mod" };
  return null;
}
/** Only source-like changes are worth a project check (not a README edit). */
export function worthChecking(touched: Iterable<string>): boolean {
  for (const f of touched) if (!/\.(md|mdx|txt|rst|adoc|csv|log|png|jpe?g|gif|svg|webp|ico|pdf)$/i.test(f) && !/(^|\/)(LICENSE|CHANGELOG|README)[^/]*$/i.test(f)) return true;
  return false;
}
