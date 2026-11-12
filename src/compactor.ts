import type { Msg } from "./agent.ts";

export type Ask = (prompt: string) => Promise<string>;
const flat = (m: Msg): string => {
  const c = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => (p.type === "text" ? p.text : "[image]")).join(" ") : "";
  const calls = (m.tool_calls || []).map((t: any) => t.function?.name + "(" + String(t.function?.arguments || "").slice(0, 200) + ")").join("; ");
  return m.role + ": " + c.slice(0, 1500) + (calls ? " [calls: " + calls + "]" : "");
};
/** Where the old part ends: the newest user message that leaves about keepTail messages after it (so no tool reply loses its question). */
export function cutPoint(messages: Msg[], keepTail: number): number {
  for (let i = messages.length - keepTail; i >= 2; i--) if (messages[i].role === "user") return i;
  return -1;
}
/** Replace the old middle of a long chat by one short summary written by the AI. The system message and the newest messages stay as they are. */
export async function summarizeHistory(messages: Msg[], ask: Ask, o: { keepTail?: number; focus?: string } = {}): Promise<{ messages: Msg[]; removed: number }> {
  const i = cutPoint(messages, o.keepTail ?? 6);
  if (i < 2) return { messages, removed: 0 };
  const old = messages.slice(1, i);
  const transcript = old.map(flat).join("\n").slice(-60000);
  const prompt = "Summarize this coding-assistant conversation so the work can continue from your summary alone. Keep: the user's goal, decisions made, files created or changed (with paths), commands run and their results, errors still open, and what remains to do. Be specific and short (under 350 words)." + (o.focus ? "\nPay special attention to: " + o.focus : "") + "\n\nConversation:\n" + transcript;
  const s = (await ask(prompt)).trim();
  if (!s) return { messages, removed: 0 };
  return { messages: [messages[0], { role: "user", content: "[Summary of the earlier conversation]\n" + s }, { role: "assistant", content: "Understood. I will continue from this summary." }, ...messages.slice(i)], removed: old.length };
}
