// Lightweight code intelligence without language servers: where a name is defined, where it is used, and what a file contains.
// It reads the files with patterns for each language. It is fast and needs nothing installed; it is not a compiler, so it can
// miss unusual code and it says so in its answers by showing the lines it found.
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

export type Lang = "js" | "py" | "go" | "rs" | "java" | "php" | "rb" | "c" | "other";
const EXT: Record<string, Lang> = { ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js", ".ts": "js", ".tsx": "js", ".mts": "js", ".cts": "js", ".vue": "js", ".svelte": "js", ".py": "py", ".pyi": "py", ".go": "go", ".rs": "rs", ".java": "java", ".kt": "java", ".kts": "java", ".cs": "java", ".scala": "java", ".swift": "java", ".dart": "java", ".php": "php", ".rb": "rb", ".c": "c", ".h": "c", ".cc": "c", ".cpp": "c", ".hpp": "c", ".cxx": "c", ".m": "c", ".mm": "c" };
export const langOf = (file: string): Lang => EXT[extname(file).toLowerCase()] || "other";
const CODE = new Set(Object.keys(EXT).concat([".sh", ".bash", ".lua", ".sql", ".ex", ".exs", ".zig", ".r", ".pl"]));
export const isCode = (file: string) => CODE.has(extname(file).toLowerCase());
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ID = "[A-Za-z_$][A-Za-z0-9_$]*";

/** One pattern per kind of definition. In each, the group named "n" is the name being defined. */
function defPatterns(lang: Lang): Array<[string, RegExp]> {
  const N = `(?<n>${ID})`;
  switch (lang) {
    case "js": return [
      ["function", new RegExp(`^\\s*(?:export\\s+)?(?:\\/\\*.*?\\*\\/\\s*)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${N}\\s*[(<]`)],
      ["class", new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+${N}\\b`)],
      ["interface", new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+${N}\\b`)],
      ["type", new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+${N}\\s*(?:=|<)`)],
      ["enum", new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+${N}\\b`)],
      ["function", new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${N}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>)`)],
      ["variable", new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${N}(?![A-Za-z0-9_$])(?!\\s+extends\\b)`)],
      ["method", new RegExp(`^\\s+(?:(?:public|private|protected|static|readonly|override|async|get|set)\\s+)*\\*?${N}\\s*(?:<[^>]*>)?\\((?![^)]*(?:['"\`]|\\bfunction\\b))[^)]*\\)\\s*(?::\\s*[^{;]+)?\\{`)],
      ["property", new RegExp(`^\\s+${N}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>)`)],
    ];
    case "py": return [["function", new RegExp(`^\\s*(?:async\\s+)?def\\s+${N}\\s*[(\\[]`)], ["class", new RegExp(`^\\s*class\\s+${N}\\b`)], ["variable", new RegExp(`^${N}\\s*(?::[^=]+)?=(?!=)`)], ["variable", new RegExp(`^(?!(?:else|try|finally|except|lambda|case|match|default|if|elif|while|for|with|class|def|async)\\b)${N}\\s*:\\s*[A-Za-z_"'\\[(]`)]];
    case "go": return [["function", new RegExp(`^func\\s+${N}\\s*[(\\[]`)], ["method", new RegExp(`^func\\s+\\([^)]*\\)\\s+${N}\\s*[(\\[]`)], ["type", new RegExp(`^\\s*type\\s+${N}\\b`)], ["variable", new RegExp(`^\\s*(?:var|const)\\s+${N}\\b`)]];
    case "rs": return [["function", new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+${N}\\b`)], ["type", new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|type|union|mod)\\s+${N}\\b`)], ["variable", new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const|static)\\s+(?:mut\\s+)?${N}\\b`)], ["macro", new RegExp(`^\\s*macro_rules!\\s+${N}\\b`)]];
    case "java": return [["class", new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial)\\s+)*(?:class|interface|enum|record|struct|object|trait|protocol|extension)\\s+${N}\\b`)], ["function", new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|final|override|open|suspend|mutating)\\s+)*(?:fun|func|def)\\s+(?:<[^>]*>\\s*)?${N}\\s*[(<]`)], ["method", new RegExp(`^\\s+(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|virtual|async)\\s+)+[\\w<>\\[\\],.? ]+\\s+${N}\\s*\\([^;]*$`)]];
    case "php": return [["function", new RegExp(`^\\s*(?:(?:public|private|protected|static|final|abstract)\\s+)*function\\s+&?${N}\\s*\\(`)], ["class", new RegExp(`^\\s*(?:(?:final|abstract)\\s+)*(?:class|interface|trait|enum)\\s+${N}\\b`)]];
    case "rb": return [["function", new RegExp(`^\\s*def\\s+(?:self\\.)?(?<n>[A-Za-z_][A-Za-z0-9_]*[?!=]?)`)], ["class", new RegExp(`^\\s*(?:class|module)\\s+(?<n>[A-Z][A-Za-z0-9_]*)`)]];
    case "c": return [["type", new RegExp(`^\\s*(?:typedef\\s+)?(?:struct|class|union|enum(?:\\s+class)?|namespace)\\s+${N}\\b(?!\\s*[;*&])`)], ["macro", new RegExp(`^\\s*#\\s*define\\s+${N}\\b`)], ["function", new RegExp(`^(?!\\s*(?:return|if|else|while|for|switch)\\b)[A-Za-z_][\\w\\s\\*&:<>,~]*?[\\s\\*&]~?${N}\\s*\\([^;]*$`)]];
    default: return [["function", new RegExp(`^\\s*(?:function|def|fn|func|sub)\\s+${N}\\b`)], ["class", new RegExp(`^\\s*(?:class|module|struct|interface)\\s+${N}\\b`)]];
  }
}
const cache = new Map<Lang, Array<[string, RegExp]>>();
const pats = (l: Lang) => { let p = cache.get(l); if (!p) cache.set(l, (p = defPatterns(l))); return p; };
const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "else", "do", "try", "new", "await", "typeof", "super", "this"]);
const isComment = (line: string, lang: Lang) => { const t = line.trimStart(); return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || ((lang === "py" || lang === "rb" || lang === "other") && t.startsWith("#")) || (lang === "c" && false); };

export interface Def { name: string; kind: string; line: number; text: string }
// A member of a class: optional decorators and modifiers, then the name (a "#" marks a private one), then "(" or "<".
const MEMBER = new RegExp(`^\\s*(?:@[\\w.]+(?:\\([^)]*\\))?\\s+)*(?:(?:public|private|protected|static|readonly|override|async|abstract|declare|accessor|get|set)\\s+)*\\*?\\s*#?(?<n>${ID})\\s*[(<]`);
const CLASS_START = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\b|=\s*class\b[^;]*\{\s*$/;
const indentOf = (line: string) => line.length - line.trimStart().length;
/** Everything a file defines, in order. Plain variables inside functions are left out unless locals is set: they are noise in a
 *  list of what a file contains. */
export function outline(text: string, file: string, o: { locals?: boolean } = {}): Def[] {
  const lang = langOf(file), out: Def[] = [];
  const classes: { indent: number; member: number; open: boolean }[] = []; // JS and TS: the class bodies we are inside, by indentation
  let inBlock = false, pyQuote = "";
  const lines = text.replace(/^\uFEFF/, "").split("\n");
  // Some files are indented as a whole (generated code): "top level" is the smallest indentation that code lines have.
  let baseIndent = Infinity; for (const l of lines) { if (l.trim() && l.length <= 400 && !/^\s*(?:\/\/|\/\*|\*|#)/.test(l)) { baseIndent = Math.min(baseIndent, indentOf(l)); if (!baseIndent) break; } }
  lines.forEach((line, i) => {
    const t = line.trim();
    // Text that is not code: Python's triple-quoted blocks (docstrings often hold example code) and /* ... */ comments.
    if (lang === "py") {
      if (pyQuote) { if ((line.split(pyQuote).length - 1) % 2 === 1) pyQuote = ""; return; }
      // A block of text starts where a line begins with three quotes, or ends with an opening three quotes after "=", "(", "," or "return".
      const start = /^\s*[rRbBuUfF]{0,2}("""|''')/.exec(line);
      if (start) { if ((line.split(start[1]).length - 1) % 2 === 1) pyQuote = start[1]; return; }
      const open = /(?:=|\(|,|\breturn)\s*[rRbBuUfF]{0,2}("""|''')(?:(?!\1).)*$/.exec(line);
      if (open && (line.split(open[1]).length - 1) % 2 === 1) pyQuote = open[1]; // the name on this line still counts
    }
    // Only a comment that STARTS the line counts: "/*" also appears inside ordinary text such as a path pattern '/api/*'.
    else if (lang !== "rb" && lang !== "other") { if (inBlock) { if (line.includes("*/")) inBlock = false; return; } if (t.startsWith("/*")) { if (t.indexOf("*/", 2) < 0) inBlock = true; return; } }
    if (!t || line.length > 400 || isComment(line, lang)) return;
    const ind = indentOf(line);
    if (lang === "js") {
      // A class ends at a "}" back at its own indentation. Its heading may run over several lines ("class A<\n  T\n> {").
      while (classes.length && ((ind <= classes[classes.length - 1].indent && t.startsWith("}")) || ind < classes[classes.length - 1].indent)) classes.pop();
      const c = classes[classes.length - 1];
      if (c && !c.open) { if (/\{\s*(?:\/\/.*)?$/.test(line)) c.open = true; return; }
      if (c) {
        if (c.member < 0) c.member = ind;
        if (ind === c.member) { const m = MEMBER.exec(line); const n = m?.groups?.n; if (n && !NOT_NAMES.has(n) && n !== "constructor" && !/^\s*(?:return|throw|await|yield|new|typeof|delete|void)\b/.test(line)) { out.push({ name: n, kind: "method", line: i + 1, text: t.slice(0, 160) }); return; } }
      }
      if (CLASS_START.test(line) && !/\{[^{}]*\}\s*;?\s*(?:\/\/.*)?$/.test(line)) classes.push({ indent: ind, member: -1, open: /\{\s*(?:\/\/.*)?$/.test(line) });
    }
    for (const [kind, re] of pats(lang)) {
      const m = re.exec(line); const n = m?.groups?.n; if (!n) continue;
      if ((kind === "method" || (kind === "function" && lang === "c")) && NOT_NAMES.has(n)) continue;
      if (n === "constructor") break;
      if (kind === "variable" && lang === "js" && ind > baseIndent && !o.locals) break;
      out.push({ name: n, kind, line: i + 1, text: t.slice(0, 160) }); break;
    }
  });
  return out;
}
export interface Hit { file: string; line: number; text: string; kind?: string }
/** Where a name is defined and where it is used, across the given files. */
export function findSymbol(name: string, files: string[], read: (file: string) => string | null): { defs: Hit[]; uses: Hit[]; filesWithUses: number } {
  const word = new RegExp(`(?<![A-Za-z0-9_$])${esc(name)}(?![A-Za-z0-9_$])`);
  const defs: Hit[] = [], uses: Hit[] = []; const useFiles = new Set<string>();
  for (const file of files) {
    if (!isCode(file)) continue;
    const text = read(file); if (text === null || !text.includes(name)) continue;
    const lang = langOf(file);
    const defAt = new Map<number, string>(); for (const d of outline(text, file, { locals: true })) if (d.name === name) defAt.set(d.line, d.kind);
    text.split("\n").forEach((line, i) => {
      if (line.length > 400 || !word.test(line)) return;
      const kind = defAt.get(i + 1);
      if (!kind && isComment(line, lang)) return;
      const hit = { file, line: i + 1, text: line.trim().slice(0, 160) };
      if (kind) defs.push({ ...hit, kind }); else { uses.push(hit); useFiles.add(file); }
    });
  }
  return { defs, uses, filesWithUses: useFiles.size };
}
export function describeSymbol(name: string, r: { defs: Hit[]; uses: Hit[]; filesWithUses: number }, show: "both" | "definition" | "usages" = "both"): string {
  if (!r.defs.length && !r.uses.length) return `Nothing named ${name} was found in the code files. Check the spelling (it is case-sensitive), or use search for text that is not a name.`;
  const out: string[] = [];
  if (show !== "usages") { out.push(r.defs.length ? `Defined in ${r.defs.length} place${r.defs.length === 1 ? "" : "s"}:` : `No definition of ${name} was found (it may come from a library, or be defined in a way this lookup does not recognise).`); for (const d of r.defs.slice(0, 30)) out.push(`  ${d.file}:${d.line}  [${d.kind}]  ${d.text}`); if (r.defs.length > 30) out.push(`  ... and ${r.defs.length - 30} more`); }
  if (show !== "definition") { out.push(r.uses.length ? `Used in ${r.uses.length} place${r.uses.length === 1 ? "" : "s"} (${r.filesWithUses} file${r.filesWithUses === 1 ? "" : "s"}):` : "No uses found."); for (const u of r.uses.slice(0, 60)) out.push(`  ${u.file}:${u.line}  ${u.text}`); if (r.uses.length > 60) out.push(`  ... and ${r.uses.length - 60} more`); }
  return out.join("\n");
}
export function describeOutline(file: string, defs: Def[], lines: number): string {
  if (!defs.length) return `${file} (${lines} lines): no functions, classes or other definitions were recognised. Use read_file to see it.`;
  return `${file} (${lines} lines) defines:\n` + defs.slice(0, 300).map((d) => `${String(d.line).padStart(5)}  [${d.kind}]  ${d.text}`).join("\n") + (defs.length > 300 ? `\n  ... and ${defs.length - 300} more` : "");
}
export const readSmall = (root: string) => (file: string): string | null => { try { const p = resolve(root, file); if (statSync(p).size > 1_000_000) return null; const t = readFileSync(p, "utf8"); return t.includes("\0") ? null : t; } catch { return null; } };
