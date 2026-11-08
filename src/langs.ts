// Language knowledge base: how to check, test and run code in each language, so the AI can verify what it writes.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
export interface Lang { id: string; name: string; ext: string[]; alias?: string[]; check?: string; run?: string; test?: string; hint: string }
// {f} = the file name. check = fastest way to prove the file is valid (syntax/compile only).
export const LANGS: Lang[] = [
  { id: "javascript", name: "JavaScript", ext: ["js", "mjs", "cjs"], alias: ["js", "node", "nodejs"], check: "node --check {f}", run: "node {f}", test: "node --test", hint: "Modern ES modules or CommonJS to match the project; prefer const/let, async/await." },
  { id: "typescript", name: "TypeScript", ext: ["ts", "tsx"], alias: ["ts"], check: "npx tsc --noEmit {f}", run: "bun {f}", test: "bun test", hint: "Strict types, avoid any, export types for public shapes." },
  { id: "python", name: "Python", ext: ["py"], alias: ["py", "python3"], check: "python3 -m py_compile {f}", run: "python3 {f}", test: "python3 -m pytest", hint: "PEP 8, type hints, f-strings, pathlib, context managers; no mutable default arguments." },
  { id: "java", name: "Java", ext: ["java"], check: "javac -d /tmp/syok_out {f}", run: "java {f}", test: "mvn test", hint: "One public class per file named like the file; use records, streams and Optional where they fit." },
  { id: "c", name: "C", ext: ["c", "h"], check: "gcc -std=c11 -Wall -Wextra -fsyntax-only {f}", run: "gcc -Wall {f} -o /tmp/syok_c && /tmp/syok_c", hint: "Check every allocation and return value; free what you allocate; no undefined behaviour." },
  { id: "cpp", name: "C++", ext: ["cpp", "cc", "cxx", "hpp"], alias: ["c++"], check: "g++ -std=c++17 -Wall -Wextra -fsyntax-only {f}", run: "g++ -std=c++17 {f} -o /tmp/syok_cpp && /tmp/syok_cpp", hint: "RAII, smart pointers, std algorithms and containers; avoid raw new/delete." },
  { id: "csharp", name: "C#", ext: ["cs"], alias: ["cs", "c#", "dotnet"], check: "dotnet build", run: "dotnet run", test: "dotnet test", hint: "Nullable reference types, async/await, LINQ, records; needs a .csproj." },
  { id: "go", name: "Go", ext: ["go"], alias: ["golang"], check: "gofmt -l {f} && go vet {f}", run: "go run {f}", test: "go test ./...", hint: "Return errors (do not panic), gofmt style, small interfaces, table-driven tests." },
  { id: "rust", name: "Rust", ext: ["rs"], alias: ["rs"], check: "rustc --edition 2021 --emit=metadata -o /tmp/syok_rs {f}", run: "cargo run", test: "cargo test", hint: "Use Result and the ? operator, borrow instead of clone, derive traits, iterators." },
  { id: "php", name: "PHP", ext: ["php"], check: "php -l {f}", run: "php {f}", test: "vendor/bin/phpunit", hint: "PHP 8+: strict_types, typed properties, match, null-safe operator, PDO prepared statements." },
  { id: "ruby", name: "Ruby", ext: ["rb"], alias: ["rb"], check: "ruby -c {f}", run: "ruby {f}", test: "bundle exec rspec", hint: "Idiomatic blocks and enumerables, frozen string literals, small methods." },
  { id: "swift", name: "Swift", ext: ["swift"], check: "swiftc -parse {f}", run: "swift {f}", test: "swift test", hint: "Optionals not force-unwraps, structs over classes, guard for early exit, async/await." },
  { id: "kotlin", name: "Kotlin", ext: ["kt", "kts"], alias: ["kt"], check: "kotlinc {f} -d /tmp/syok_kt", run: "kotlin {f}", test: "gradle test", hint: "Data classes, null safety, extension functions, coroutines, when expressions." },
  { id: "scala", name: "Scala", ext: ["scala"], check: "scalac -d /tmp/syok_sc {f}", run: "scala {f}", test: "sbt test", hint: "Immutable case classes, Option/Either, pattern matching." },
  { id: "dart", name: "Dart", ext: ["dart"], alias: ["flutter"], check: "dart analyze {f}", run: "dart run {f}", test: "dart test", hint: "Null safety, async/await, const constructors; Flutter widgets stay small." },
  { id: "r", name: "R", ext: ["r"], check: "Rscript -e 'invisible(parse(file=\"{f}\"))'", run: "Rscript {f}", test: "Rscript -e 'testthat::test_dir(\"tests\")'", hint: "Vectorised code, tidyverse style if the project uses it." },
  { id: "lua", name: "Lua", ext: ["lua"], check: "luac -p {f}", run: "lua {f}", hint: "Local variables, tables as arrays (1-based), no global leaks." },
  { id: "perl", name: "Perl", ext: ["pl", "pm"], check: "perl -c {f}", run: "perl {f}", hint: "use strict and warnings; lexical variables." },
  { id: "bash", name: "Bash", ext: ["sh", "bash"], alias: ["shell", "sh"], check: "bash -n {f}", run: "bash {f}", hint: "set -euo pipefail, quote every variable, use [[ ]], functions for reuse." },
  { id: "powershell", name: "PowerShell", ext: ["ps1"], alias: ["pwsh"], check: "pwsh -NoProfile -Command \"[void][scriptblock]::Create((Get-Content {f} -Raw))\"", run: "pwsh -File {f}", hint: "Approved verbs, advanced functions with param blocks, objects not text." },
  { id: "sql", name: "SQL", ext: ["sql"], hint: "Explicit column lists, parameterised queries, indexes for filters and joins; say which dialect you assumed." },
  { id: "haskell", name: "Haskell", ext: ["hs"], check: "ghc -fno-code {f}", run: "runghc {f}", test: "cabal test", hint: "Total functions, small pure functions, type signatures on everything top-level." },
  { id: "elixir", name: "Elixir", ext: ["ex", "exs"], check: "elixirc {f}", run: "elixir {f}", test: "mix test", hint: "Pattern matching, pipes, small functions, let it crash with supervisors." },
  { id: "julia", name: "Julia", ext: ["jl"], check: "julia -e 'Meta.parseall(read(\"{f}\", String))'", run: "julia {f}", hint: "Type-stable functions, multiple dispatch, broadcasting." },
  { id: "zig", name: "Zig", ext: ["zig"], check: "zig ast-check {f}", run: "zig run {f}", test: "zig test {f}", hint: "Explicit allocators, errdefer, error unions." },
  { id: "objc", name: "Objective-C", ext: ["m", "mm"], alias: ["objective-c"], check: "clang -fsyntax-only {f}", hint: "ARC, nullability annotations, modern literals." },
  { id: "fortran", name: "Fortran", ext: ["f90", "f95"], check: "gfortran -fsyntax-only {f}", run: "gfortran {f} -o /tmp/syok_f && /tmp/syok_f", hint: "implicit none, modules, array syntax." },
  { id: "ocaml", name: "OCaml", ext: ["ml"], check: "ocamlfind ocamlopt -c {f}", run: "ocaml {f}", test: "dune test", hint: "Variants and pattern matching, immutable data, Result for errors." },
  { id: "clojure", name: "Clojure", ext: ["clj"], hint: "Pure functions, immutable data, threading macros." },
  { id: "groovy", name: "Groovy", ext: ["groovy"], check: "groovyc -d /tmp/syok_gr {f}", run: "groovy {f}", hint: "Closures, def with types where clear." },
  { id: "html", name: "HTML", ext: ["html", "htm"], hint: "Semantic elements, accessible labels and alt text, responsive viewport meta." },
  { id: "css", name: "CSS", ext: ["css", "scss"], hint: "Custom properties, flex/grid, mobile first, no !important." },
];
const byKey = new Map<string, Lang>();
for (const l of LANGS) { byKey.set(l.id, l); l.alias?.forEach((a) => byKey.set(a, l)); l.ext.forEach((e) => { if (!byKey.has(e)) byKey.set(e, l); }); byKey.set(l.name.toLowerCase(), l); }
export function langOf(s?: string): Lang | undefined { return s ? byKey.get(s.toLowerCase().replace(/^\./, "")) : undefined; }
export function langOfFile(file: string): Lang | undefined { const m = /\.([A-Za-z0-9]+)$/.exec(file); return m ? langOf(m[1]) : undefined; }
export const checkCmd = (l: Lang, file: string) => l.check?.replaceAll("{f}", file);
const MARKERS: Array<[RegExp, string]> = [
  [/^tsconfig\.json$/, "typescript"], [/^package\.json$/, "javascript"], [/^(pyproject\.toml|requirements\.txt|setup\.py|Pipfile)$/, "python"], [/^go\.mod$/, "go"], [/^Cargo\.toml$/, "rust"],
  [/^(pom\.xml|build\.gradle|build\.gradle\.kts)$/, "java"], [/\.(csproj|sln)$/, "csharp"], [/^composer\.json$/, "php"], [/^Gemfile$/, "ruby"], [/^Package\.swift$/, "swift"],
  [/^pubspec\.yaml$/, "dart"], [/^mix\.exs$/, "elixir"], [/^CMakeLists\.txt$/, "cpp"], [/^(stack\.yaml|.*\.cabal)$/, "haskell"], [/^DESCRIPTION$/, "r"], [/^build\.zig$/, "zig"],
];
/** Languages this project uses, from its marker files (top folder only; cheap). */
export function detectProject(root: string): Lang[] {
  const out = new Set<string>();
  try { for (const f of readdirSync(root)) for (const [re, id] of MARKERS) if (re.test(f)) out.add(id); } catch {}
  if (out.has("typescript")) out.delete("javascript");
  return [...out].map((id) => byKey.get(id)!).filter(Boolean);
}
export function langContext(root: string): string {
  const ls = detectProject(root); if (!ls.length || !existsSync(root)) return "";
  return "\n\nLanguage notes for this project:\n" + ls.map((l) => `- ${l.name}: ${l.hint}${l.test ? " Tests: " + l.test + "." : ""}`).join("\n");
}
