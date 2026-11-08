// Per-model tuning. Each profile changes how the loop talks to one family of models.
// The eval runner (evals/run.ts) scores a profile; keep a change only if the score goes up.
export interface Profile {
  name: string;
  temperature: number;
  maxSteps: number;
  compactAtChars: number; // when the chat grows past this, old tool output is shortened
  keepRecent: number;     // how many of the newest tool results stay in full
  maxToolChars: number;   // one tool result is cut to this many characters
  fuzzyEdit: boolean;     // let edit_file match text that differs only in spaces/indentation
  nudgeTests: boolean;    // after edits with no test run, ask once whether tests were run
  systemExtra: string;
}
export const DEFAULT: Profile = {
  name: "default", temperature: 0.2, maxSteps: 40, compactAtChars: 120_000, keepRecent: 6,
  maxToolChars: 12_000, fuzzyEdit: true, nudgeTests: true, systemExtra: "",
};
// Small or free models run with short context, so compact earlier and keep outputs short.
const SMALL: Partial<Profile> = { name: "small-context", compactAtChars: 40_000, keepRecent: 4, maxToolChars: 6_000, maxSteps: 50 };
const RULES: Array<[RegExp, Partial<Profile>]> = [
  [/(^|[-/:])(7b|8b|9b|3b|4b|1b|mini|nano|small|haiku|flash-lite)/i, SMALL],
  [/(qwen|llama|mistral|devstral|gemma|deepseek)/i, { name: "open-model", compactAtChars: 60_000, keepRecent: 5, maxToolChars: 8_000 }],
];
export function pickProfile(model: string, override?: string, table: Record<string, Partial<Profile>> = {}): Profile {
  if (override && table[override]) return { ...DEFAULT, ...table[override], name: override };
  for (const [re, p] of RULES) if (re.test(model)) return { ...DEFAULT, ...p };
  return { ...DEFAULT };
}
