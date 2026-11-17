// Measures find_symbol/outline against a compiler-grade answer on real projects.
//   TypeScript and JavaScript: the TypeScript compiler's own syntax tree.   Python: Python's own "ast" module.
// For every definition the compiler sees (functions, classes, interfaces, types, enums, methods, top-level variables) it checks
// that outline() reports the same name on the same line (recall), and that what outline() reports is a real definition
// (precision). Usage: bun test/bench/symbols-bench.ts <folder> [<folder>...] [--json] [--misses N]
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, extname, relative } from "node:path";
import { outline } from "../../src/symbols.ts";

interface Truth { name: string; line: number; kind: string; core: boolean }
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", "vendor", ".next", "__pycache__", ".venv", "venv"]);
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) { if (SKIP.has(n)) continue; const p = join(dir, n); const st = statSync(p); if (st.isDirectory()) walk(p, out); else if (st.size < 400_000) out.push(p); }
  return out;
}
const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
/** Every declaration in a TS/JS file. "core" ones are what a person means by "where is X defined"; the rest (locals, parameters of arrow functions assigned to properties...) may be listed but need not be. */
function tsTruth(file: string, text: string): Truth[] {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind); const out: Truth[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const add = (name: ts.Node | undefined, k: string, core: boolean, at?: ts.Node) => { if (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) out.push({ name: name.text.replace(/^#/, ""), line: line(at || name), kind: k, core }); };
  const visit = (n: ts.Node, top: boolean) => {
    if (ts.isFunctionDeclaration(n)) add(n.name, "function", true);
    else if (ts.isFunctionExpression(n) || ts.isClassExpression(n)) add(n.name, "named expression", false);
    else if (ts.isClassDeclaration(n)) add(n.name, "class", true);
    else if (ts.isInterfaceDeclaration(n)) add(n.name, "interface", true);
    else if (ts.isTypeAliasDeclaration(n)) add(n.name, "type", true);
    else if (ts.isEnumDeclaration(n)) add(n.name, "enum", true);
    else if (ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) add(n.name, "method", !!n.body && ts.isClassLike(n.parent));
    else if (ts.isMethodSignature(n) || ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) add(n.name, "member", false);
    else if (ts.isPropertyAssignment(n)) add(n.name, "property", false);
    else if (ts.isVariableDeclaration(n)) { const stmtTop = top && ts.isVariableDeclarationList(n.parent) && ts.isVariableStatement(n.parent.parent) && ts.isSourceFile(n.parent.parent.parent); add(n.name, "variable", stmtTop && line(n.name) === line(n.parent)); }
    else if (ts.isModuleDeclaration(n)) add(n.name as any, "namespace", false);
    else if (ts.isParameter(n) || ts.isBindingElement(n)) add(n.name as any, "local", false);
    ts.forEachChild(n, (c) => visit(c, top && (ts.isSourceFile(n) || ts.isVariableStatement(n) || ts.isVariableDeclarationList(n) || ts.isExportAssignment(n))));
  };
  visit(sf, true); return out;
}
const PY = `
import ast, json, sys
out = {}
for path in sys.argv[1:]:
    try:
        tree = ast.parse(open(path, encoding="utf-8").read())
    except Exception:
        continue
    items = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            items.append({"name": node.name, "line": node.lineno, "kind": "function", "core": True})
        elif isinstance(node, ast.ClassDef):
            items.append({"name": node.name, "line": node.lineno, "kind": "class", "core": True})
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        for t in targets:
            if isinstance(t, ast.Name):
                items.append({"name": t.id, "line": node.lineno, "kind": "variable", "core": True})
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.For, ast.With, ast.NamedExpr, ast.arg, ast.Import, ast.ImportFrom)):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Name):
                    items.append({"name": sub.id, "line": sub.lineno, "kind": "other", "core": False})
    out[path] = items
print(json.dumps(out))
`;
function pyTruth(files: string[]): Record<string, Truth[]> {
  const all: Record<string, Truth[]> = {};
  for (let i = 0; i < files.length; i += 200) { const r = spawnSync("python3", ["-c", PY, ...files.slice(i, i + 200)], { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error("python3 failed: " + r.stderr.slice(0, 300)); Object.assign(all, JSON.parse(r.stdout)); }
  return all;
}

export interface Score { lang: string; files: number; core: number; found: number; reported: number; real: number; misses: string[]; wrong: string[] }
export function measure(roots: string[]): Score[] {
  const scores: Record<string, Score> = {}; const sc = (lang: string) => (scores[lang] ||= { lang, files: 0, core: 0, found: 0, reported: 0, real: 0, misses: [], wrong: [] });
  for (const root of roots) {
    const files = walk(root); const py = files.filter((f) => extname(f) === ".py"); const pyT = py.length ? pyTruth(py) : {};
    for (const f of files) {
      const ext = extname(f).toLowerCase(); const isTs = TS_EXT.has(ext), isPy = ext === ".py"; if (!isTs && !isPy) continue; if (/\.d\.ts$/.test(f) || /\.min\.js$/.test(f)) continue;
      const text = readFileSync(f, "utf8"); if (text.includes("\0")) continue;
      let truth: Truth[]; if (isPy) { if (!pyT[f]) continue; truth = pyT[f]; } else { try { truth = tsTruth(f, text); } catch (e: any) { if (!(globalThis as any).__w) { (globalThis as any).__w = 1; console.error("tsTruth failed on " + f + ": " + e.message); } continue; } }
      const s = sc(isPy ? "Python" : /\.(ts|tsx|mts|cts)$/.test(ext) ? "TypeScript" : "JavaScript"); s.files++;
      const got = outline(text, f); const gotKey = new Set(got.map((g) => g.name + "@" + g.line)); const truthKey = new Set(truth.map((t) => t.name + "@" + t.line));
      const seen = new Set<string>();
      for (const t of truth) { if (!t.core) continue; const k = t.name + "@" + t.line; if (seen.has(k)) continue; seen.add(k); s.core++; if (gotKey.has(k)) s.found++; else if (s.misses.length < 400) s.misses.push(`${relative(root, f)}:${t.line} [${t.kind}] ${t.name}  |  ${text.split("\n")[t.line - 1].trim().slice(0, 110)}`); }
      for (const g of got) { s.reported++; if (truthKey.has(g.name + "@" + g.line)) s.real++; else if (s.wrong.length < 400) s.wrong.push(`${relative(root, f)}:${g.line} [${g.kind}] ${g.name}  |  ${g.text.slice(0, 110)}`); }
    }
  }
  return Object.values(scores);
}
export const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 100);
/** The floor each language must reach, fixed when the benchmark was added. If a change drops below it, fix the change. */
export const MIN_PERCENT = 97;
if (import.meta.main) {
  const args = process.argv.slice(2); const roots = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--misses"); const n = +(args[args.indexOf("--misses") + 1] || 0) || 0;
  const res = measure(roots);
  if (args.includes("--check")) { let bad = 0; for (const r of res) { const rec = pct(r.found, r.core), pre = pct(r.real, r.reported); const ok = rec >= MIN_PERCENT && pre >= MIN_PERCENT && r.core >= 500; console.log(`${ok ? "PASS" : "FAIL"} ${r.lang}: found ${rec}% of ${r.core} definitions, ${pre}% of what it reports is a real definition (floor ${MIN_PERCENT}%, at least 500 definitions measured)`); if (!ok) bad++; } if (res.length < 3) { console.log("FAIL fewer than 3 languages were measured"); bad++; } process.exit(bad ? 1 : 0); }
  if (args.includes("--json")) console.log(JSON.stringify(res.map(({ misses, wrong, ...r }) => ({ ...r, recall: pct(r.found, r.core), precision: pct(r.real, r.reported) }))));
  else for (const r of res) { console.log(`${r.lang}: ${r.files} files. Found ${r.found} of ${r.core} definitions (${pct(r.found, r.core)}%). Of ${r.reported} reported, ${r.real} are real definitions (${pct(r.real, r.reported)}%).`); if (n) { console.log("  missed:"); r.misses.slice(0, n).forEach((m) => console.log("    " + m)); console.log("  reported but not a definition:"); r.wrong.slice(0, n).forEach((m) => console.log("    " + m)); } }
}
