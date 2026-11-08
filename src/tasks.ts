// Task modes: turn a short plain-language command into a precise, self-checking brief for the AI.
import { langOf, langOfFile, checkCmd, LANGS } from "./langs.ts";
export const KINDS = ["gen", "translate", "debug", "explain", "test"] as const;
export type Kind = (typeof KINDS)[number];
export interface TaskArgs { text?: string; file?: string; lang?: string; to?: string; out?: string }
export interface Built { task: string; readOnly: boolean; error?: string }
const bad = (error: string): Built => ({ task: "", readOnly: false, error });
const supported = () => LANGS.map((l) => l.id).join(", ");
export function buildTask(kind: Kind, a: TaskArgs): Built {
  if (kind === "gen") {
    if (!a.text?.trim()) return bad('Say what you want, for example: syok gen "a function that checks if a string is a palindrome" --lang python');
    const l = a.lang ? langOf(a.lang) : undefined;
    if (a.lang && !l) return bad(`I do not know the language "${a.lang}". Supported: ${supported()}.`);
    const out = a.out || (l ? `main.${l.ext[0]}` : "");
    const chk = l && out ? checkCmd(l, out) : undefined;
    return { readOnly: false, task: `Write code from this plain-language description:\n"""${a.text.trim()}"""\n\n` +
      (l ? `Language: ${l.name}. Style notes: ${l.hint}\nPut it in the file ${out} (if it exists, edit it instead of overwriting).\n` : "Use the project's main language, or the best fit if the folder is empty. Choose a sensible file name.\n") +
      `Write idiomatic, readable code with clear names, a short comment only where the logic is not obvious, and handle edge cases and bad input.\n` +
      `Then verify it: ${chk ? "run `" + chk + "` to prove it is valid" : "run the language's compiler or syntax check"}, and, if it can run safely, run it with a small example. Fix every problem you find.\n` +
      `Finish with: the file name, how to run it, and exactly what you checked.` };
  }
  if (kind === "translate") {
    if (!a.file || !a.to) return bad("Usage: syok translate <file> --to <language>, for example: syok translate utils.py --to go");
    const to = langOf(a.to); if (!to) return bad(`I do not know the language "${a.to}". Supported: ${supported()}.`);
    const from = langOfFile(a.file);
    const base = a.file.replace(/\.[^./\\]+$/, ""); const out = a.out || `${base}.${to.ext[0]}`;
    const chk = checkCmd(to, out);
    return { readOnly: false, task: `Translate ${a.file}${from ? ` from ${from.name}` : ""} to ${to.name}.\nRules:\n` +
      `1. Read the whole original first. Keep exactly the same behaviour and the same public functions/classes and their meaning.\n` +
      `2. Write idiomatic ${to.name} (its standard library, naming, error handling and types), not a line-by-line copy. Style notes: ${to.hint}\n` +
      `3. Write the result to ${out} beside the original. Do not change or delete the original.\n` +
      `4. If tests exist for the original, translate them too, in ${to.name}'s conventional test layout${to.test ? " (" + to.test + ")" : ""}.\n` +
      `5. Verify: ${chk ? "run `" + chk + "`" : "run the compiler or syntax check"} and fix errors. If both toolchains are installed, run the same example in both and compare results.\n` +
      `6. In your summary list anything that cannot map exactly (integer sizes and overflow, unicode, sorting stability, concurrency, floating point, missing libraries) and what you chose instead.` };
  }
  if (kind === "debug") {
    return { readOnly: false, task: `Find and fix the bug${a.text ? ": " + a.text.trim() : " in this project (start by running its tests or build to see what fails)"}.\n` +
      `Steps: 1) Reproduce it: run the tests or the failing command; if there are none, write the smallest reproduction. 2) Find the root cause by reading the code (say what it is). 3) Make the smallest fix. 4) Run the same thing again to prove it is fixed and nothing else broke. 5) Never delete or weaken a test to make it pass.\n` +
      `Finish with: the cause in plain words, what you changed, and the proof (command and result).` };
  }
  if (kind === "explain") {
    if (!a.file && !a.text) return bad("Usage: syok explain <file>  (or a question about the project)");
    return { readOnly: true, task: `Explain ${a.file ? "the file " + a.file : a.text} in plain, simple language for a beginner: what it is for, how it works step by step, the key functions or parts, and anything risky or confusing. Use only the reading tools; change nothing. Call finish with the explanation.` };
  }
  if (!a.file) return bad("Usage: syok test <file>  (writes tests for that file)");
  const l = langOfFile(a.file);
  return { readOnly: false, task: `Write tests for ${a.file}${l ? " (" + l.name + ")" : ""} using the project's existing test framework${l?.test ? " (default: " + l.test + ")" : ""}.\n` +
    `Cover normal use, edge cases and error cases. Put them in the conventional place. Run them. If a test fails because the test is wrong, fix the test. If it reveals a real bug in ${a.file}, do not weaken the test: report the bug in your summary.` };
}
