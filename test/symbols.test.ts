// find_symbol and outline: where a name is defined and used, and what a file contains, across languages.
import { test, expect } from "bun:test";
import { outline, findSymbol, describeSymbol, describeOutline, langOf, isCode } from "../src/symbols.ts";
import { makeCtx, runTool, toolDefs, READONLY } from "../src/tools.ts";
import { DEFAULT } from "../src/profiles.ts";
import { tmpProject } from "./helpers.ts";

const names = (text: string, file: string) => outline(text, file).map((d) => `${d.kind} ${d.name}@${d.line}`);

test("JavaScript and TypeScript: functions, arrow functions, classes, methods, types, interfaces, enums, variables", () => {
  const src = [
    "import { x } from './x';",                                  // 1
    "export function total(items) {",                            // 2
    "  return items.reduce((a, b) => a + b, 0);",                // 3
    "}",                                                         // 4
    "export const double = (n: number): number => n * 2;",       // 5
    "const add = async function (a, b) { return a + b; };",      // 6
    "export default class Cart extends Base {",                  // 7
    "  constructor() { super(); }",                              // 8
    "  private async load(id: string): Promise<void> {",         // 9
    "    if (id) { await fetch(id); }",                          // 10
    "    for (const k of ks) { use(k); }",                       // 11
    "  }",                                                       // 12
    "  static get size() { return 1; }",                         // 13
    "}",                                                         // 14
    "export interface Item { price: number }",                   // 15
    "export type Id = string | number;",                         // 16
    "export enum Color { Red, Green }",                          // 17
    "let counter = 0;",                                          // 18
    "// function fake() {}",                                     // 19
    "const obj = {",                                             // 20
    "  handler: (e) => e,",                                      // 21
    "};",                                                        // 22
    "export async function* stream<T>(x: T) {}",                 // 23
    "  return total(items);",                                    // 24
  ].join("\n");
  expect(names(src, "cart.ts")).toEqual(["function total@2", "function double@5", "function add@6", "class Cart@7", "method load@9", "method size@13", "interface Item@15", "type Id@16", "enum Color@17", "variable counter@18", "variable obj@20", "property handler@21", "function stream@23"]);
});

test("Python, Go, Rust, Java, PHP, Ruby and C are read with their own rules", () => {
  expect(names("import os\nMAX = 3\nclass Shop(Base):\n    def total(self, items):\n        x = 1\n        return x\nasync def fetch(u):\n    pass\n# def fake():\nif MAX == 3:\n    pass\n", "shop.py")).toEqual(["variable MAX@2", "class Shop@3", "function total@4", "function fetch@7"]);
  expect(names("package main\nfunc Total(items []int) int {\n\treturn 0\n}\nfunc (c *Cart) Add(i int) {}\ntype Cart struct{}\nvar limit = 3\nconst Max = 4\n", "cart.go")).toEqual(["function Total@2", "method Add@5", "type Cart@6", "variable limit@7", "variable Max@8"]);
  expect(names("pub fn total(items: &[i32]) -> i32 { 0 }\npub(crate) async fn load() {}\npub struct Cart;\nenum Kind { A }\ntrait Sum {}\nconst MAX: u32 = 3;\nmacro_rules! say { () => {} }\n", "cart.rs")).toEqual(["function total@1", "function load@2", "type Cart@3", "type Kind@4", "type Sum@5", "variable MAX@6", "macro say@7"]);
  expect(names("public class Cart {\n    private final int n;\n    public int total(List<Item> items) {\n        return 0;\n    }\n    static void main(String[] a) {\n    }\n}\ninterface Sum {}\n", "Cart.java")).toEqual(["class Cart@1", "method total@3", "method main@6", "class Sum@9"]);
  expect(names("data class Item(val p: Int)\nfun total(items: List<Item>): Int = 0\n", "a.kt")).toEqual(["class Item@1", "function total@2"]);
  expect(names("<?php\nclass Cart {\n  public static function total($items) {}\n}\nfunction helper() {}\n", "cart.php")).toEqual(["class Cart@2", "function total@3", "function helper@5"]);
  expect(names("module Shop\n  class Cart\n    def total(items)\n    end\n    def self.empty?\n    end\n  end\nend\n", "cart.rb")).toEqual(["class Shop@1", "class Cart@2", "function total@3", "function empty?@5"]);
  expect(names("#define MAX 3\nstruct cart { int n; };\nstatic int total(const int *items, int n)\n{\n  return 0;\n}\nint main(void) {\n  return total(0, 0);\n}\n", "cart.c")).toEqual(["macro MAX@1", "type cart@2", "function total@3", "function main@7"]);
  expect(langOf("a.TSX")).toBe("js"); expect(langOf("README.md")).toBe("other"); expect(isCode("a.py")).toBe(true); expect(isCode("data.json")).toBe(false); expect(isCode("notes.md")).toBe(false);
});

const FILES: Record<string, string> = {
  "src/cart.js": "function total(items) {\n  return items.length;\n}\nfunction subtotal(items) { return total(items) - 1; }\nmodule.exports = { total, subtotal };\n",
  "src/app.js": "const { total } = require('./cart');\n// total is great\nconsole.log(total([1, 2]));\nconst totals = 1; const mytotal = 2; obj.total_count = 3;\n",
  "lib/sum.py": "def total(xs):\n    return sum(xs)\n\nprint(total([1]))\n",
  "docs/notes.md": "total is mentioned here\n",
  "data.json": "{\"total\": 1}\n",
};
test("find a name: definitions and uses are separate; longer names, comments and non-code files do not count", () => {
  const r = findSymbol("total", Object.keys(FILES), (f) => FILES[f]);
  expect(r.defs.map((d) => `${d.file}:${d.line}:${d.kind}`)).toEqual(["src/cart.js:1:function", "lib/sum.py:1:function"]);
  expect(r.uses.map((u) => `${u.file}:${u.line}`)).toEqual(["src/cart.js:4", "src/cart.js:5", "src/app.js:1", "src/app.js:3", "lib/sum.py:4"]); expect(r.filesWithUses).toBe(3);
  const text = describeSymbol("total", r);
  expect(text).toContain("Defined in 2 places:\n  src/cart.js:1  [function]  function total(items) {"); expect(text).toContain("Used in 5 places (3 files):"); expect(text).not.toContain("notes.md"); expect(text).not.toContain("data.json"); expect(text).not.toContain("totals");
  expect(describeSymbol("total", r, "definition")).not.toContain("Used in"); expect(describeSymbol("total", r, "usages")).not.toContain("Defined in");
  const none = findSymbol("nothingHere", Object.keys(FILES), (f) => FILES[f]); expect(describeSymbol("nothingHere", none)).toContain("Nothing named nothingHere was found");
  const lib = findSymbol("require", Object.keys(FILES), (f) => FILES[f]); expect(describeSymbol("require", lib)).toContain("No definition of require was found (it may come from a library");
  expect(findSymbol("$el", ["a.js"], () => "const $el = 1;\nuse($el); use(my$el);\n").uses.length).toBe(1);
  expect(findSymbol("x", ["a.js"], () => null).defs).toEqual([]);
});

test("the two tools in the agent: real files, limits, helpful errors, and read-only helpers may use them", async () => {
  const big: Record<string, string> = { ...FILES }; for (let i = 0; i < 70; i++) big[`many/u${i}.js`] = "total();\n";
  const d = tmpProject({ ...big, "node_modules/x/index.js": "function total() {}\n", "bin.js": "a\0b total" });
  const c = makeCtx(d, "auto", async () => true, { agents: false }, DEFAULT);
  const out = await runTool(c, "find_symbol", { name: "total" });
  expect(out).toContain("src/cart.js:1  [function]"); expect(out).toContain("... and "); expect(out).not.toContain("node_modules"); expect(out).not.toContain("bin.js");
  expect(await runTool(c, "find_symbol", { name: "total", path: "lib", show: "definition" })).toBe("Defined in 1 place:\n  lib/sum.py:1  [function]  def total(xs):");
  expect(await runTool(c, "find_symbol", { name: "two words" })).toContain("give one name"); expect(await runTool(c, "find_symbol", { name: "a.*b" })).toContain("give one name");
  expect(await runTool(c, "find_symbol", { name: "total", path: "../outside" })).toContain("outside the project folder");
  expect(await runTool(c, "outline", { path: "src/cart.js" })).toBe("src/cart.js (6 lines) defines:\n    1  [function]  function total(items) {\n    4  [function]  function subtotal(items) { return total(items) - 1; }");
  expect(await runTool(c, "outline", { path: "docs/notes.md" })).toContain("no functions, classes or other definitions were recognised");
  expect(await runTool(c, "outline", { path: "nope.js" })).toContain("does not exist"); expect(await runTool(c, "outline", { path: "src" })).toContain("is a folder"); expect(await runTool(c, "outline", { path: "bin.js" })).toContain("not text");
  expect(describeOutline("x.js", [], 3)).toContain("x.js (3 lines)");
  expect(READONLY.has("find_symbol") && READONLY.has("outline")).toBe(true);
  c.allowed = READONLY; c.depth = 1; const names = toolDefs(c).map((t: any) => t.function.name); expect(names).toContain("find_symbol"); expect(names).toContain("outline"); expect(names).not.toContain("edit_file");
}, 60000); // making the test files is slow on Windows; the speed of the lookup itself is checked in the next test

test("it stays fast on a big project", async () => {
  const files: Record<string, string> = {}; for (let i = 0; i < 1500; i++) files[`src/m${i}.ts`] = `export function f${i}(a: number) { return helper(a) + ${i}; }\n`.repeat(40) + (i === 777 ? "export function helper(a: number) { return a; }\n" : "");
  const d = tmpProject(files); const c = makeCtx(d, "auto", async () => true, { agents: false }, DEFAULT);
  const t0 = Date.now(); const out = await runTool(c, "find_symbol", { name: "helper", show: "definition" }); const ms = Date.now() - t0;
  expect(out).toContain("src/m777.ts:41  [function]"); expect(ms).toBeLessThan(5000);
}, 60000);
