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
      ["function", new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${N}\\s*[(<]`)],
      ["class", new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+${N}\\b`)],
      ["interface", new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+${N}\\b`)],
      ["type", new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+${N}\\s*(?:<[^=]*>)?\\s*=`)],
      ["enum", new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const\\s+)?enum\\s+${N}\\b`)],
      ["function", new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${N}\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>)`)],
      ["variable", new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${N}\\b`)],
      ["method", new RegExp(`^\\s+(?:(?:public|private|protected|static|readonly|override|async|get|set)\\s+)*\\*?${N}\\s*(?:<[^>]*>)?\\([^)]*\\)\\s*(?::\\s*[^{;]+)?\\{`)],
      ["property", new RegExp(`^\\s+${N}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>)`)],
    ];
    case "py": return [["function", new RegExp(`^\\s*(?:async\\s+)?def\\s+${N}\\s*\\(`)], ["class", new RegExp(`^\\s*class\\s+${N}\\b`)], ["variable", new RegExp(`^${N}\\s*(?::[^=]+)?=(?!=)`)]];
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
/** Everything a file defines, in order. */
export function outline(text: string, file: string): Def[] {
  const lang = langOf(file), out: Def[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.length > 400 || isComment(line, lang)) return;
    for (const [kind, re] of pats(lang)) { const m = re.exec(line); const n = m?.groups?.n; if (n && !(kind === "method" && NOT_NAMES.has(n)) && !(kind === "function" && lang === "c" && NOT_NAMES.has(n))) { if (n === "constructor") break; out.push({ name: n, kind, line: i + 1, text: line.trim().slice(0, 160) }); break; } }
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
    text.split("\n").forEach((line, i) => {
      if (line.length > 400 || !word.test(line)) return;
      if (isComment(line, lang)) return;
      let kind = "";
      for (const [k, re] of pats(lang)) { const m = re.exec(line); if (m?.groups?.n === name) { kind = k; break; } }
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
