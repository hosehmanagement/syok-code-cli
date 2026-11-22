import type { Adapter } from "./types.ts";
import { syok } from "./syok.ts";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { fake } from "./fake.ts";

export const ADAPTERS: Record<string, Adapter> = { syok, claude, codex, cursor, fake };
export const REAL_TOOLS = ["syok", "claude", "codex", "cursor"] as const;
export function getAdapter(name: string): Adapter {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`Unknown tool "${name}". Choose from: ${Object.keys(ADAPTERS).join(", ")}`);
  return a;
}
