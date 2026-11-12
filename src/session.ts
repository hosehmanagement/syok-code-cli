import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Msg } from "./agent.ts";

/** A saved chat, so work can continue tomorrow (syok --continue, /resume). Stored in <project>/.syok/sessions. */
export interface Session { id: string; model: string; mode: string; updated: string; title: string; messages: Msg[] }
const dirOf = (root: string) => join(root, ".syok", "sessions");
export function newSessionId(): string { return new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6); }
export function titleOf(messages: Msg[]): string {
  const u = messages.find((m) => m.role === "user");
  const t = typeof u?.content === "string" ? u.content : Array.isArray(u?.content) ? String(u.content.find((p: any) => p.type === "text")?.text || "") : "";
  return t.replace(/^Task:\s*/, "").replace(/\s+/g, " ").replace(/\s*The project is in the current folder\.?$/, "").trim().slice(0, 70) || "(empty)";
}
export function saveSession(root: string, s: { id: string; model: string; mode: string; messages: Msg[]; title?: string }): Session {
  const full: Session = { ...s, title: s.title || titleOf(s.messages), updated: new Date().toISOString() };
  mkdirSync(dirOf(root), { recursive: true });
  writeFileSync(join(dirOf(root), s.id + ".json"), JSON.stringify(full));
  return full;
}
export function listSessions(root: string): Array<Omit<Session, "messages"> & { count: number }> {
  const d = dirOf(root); if (!existsSync(d)) return [];
  const out: any[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try { const j = JSON.parse(readFileSync(join(d, f), "utf8")); out.push({ id: j.id, model: j.model, mode: j.mode, updated: j.updated, title: j.title, count: (j.messages || []).length }); } catch {}
  }
  return out.sort((a, b) => (a.updated < b.updated ? 1 : -1));
}
/** ref: nothing or "last" = newest; a small number = position in the list (1 = newest); otherwise an id or the start of one. */
export function loadSession(root: string, ref?: string): Session | null {
  const all = listSessions(root); if (!all.length) return null;
  let hit;
  if (!ref || ref === "last") hit = all[0];
  else if (/^\d{1,3}$/.test(ref)) hit = all[+ref - 1];
  else hit = all.find((s) => s.id === ref) || all.find((s) => s.id.startsWith(ref));
  if (!hit) return null;
  try { return JSON.parse(readFileSync(join(dirOf(root), hit.id + ".json"), "utf8")); } catch { return null; }
}
export function describeSessions(root: string): string {
  const all = listSessions(root);
  if (!all.length) return "No saved chats yet. Every chat is saved automatically in .syok/sessions.";
  return all.slice(0, 20).map((s, i) => "  " + (i + 1) + ". " + s.title + "   (" + s.updated.slice(0, 16).replace("T", " ") + ", " + s.count + " messages, id " + s.id + ")").join("\n");
}
