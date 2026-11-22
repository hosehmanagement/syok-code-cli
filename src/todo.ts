/** The AI's own todo list for long tasks: kept per chat, saved with it, and given back after the chat is shortened. */
export type TodoStatus = "pending" | "in_progress" | "done";
export interface TodoItem { id: string; text: string; status: TodoStatus }
export const TODO_MAX_ITEMS = 50;
export const TODO_MAX_TEXT = 300;
const STATUSES: TodoStatus[] = ["pending", "in_progress", "done"];

const cleanText = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").trim();
/** Checks one whole list. Returns the problem in words the AI can act on, or "" when it is fine. */
export function todoProblem(items: TodoItem[]): string {
  if (!items.length) return "the list is empty. Give at least one item (to clear a finished list, mark its items done instead).";
  if (items.length > TODO_MAX_ITEMS) return `the list has ${items.length} items; at most ${TODO_MAX_ITEMS} are allowed. Group small steps into bigger ones.`;
  const ids = new Set<string>();
  for (const it of items) {
    if (!it.id) return "every item needs an id.";
    if (ids.has(it.id)) return `the id "${it.id}" is used twice. Every id must be different.`;
    ids.add(it.id);
    if (!it.text) return `item "${it.id}" has no text.`;
    if (it.text.length > TODO_MAX_TEXT) return `item "${it.id}" is ${it.text.length} characters long; at most ${TODO_MAX_TEXT} are allowed. Keep each item to one short line.`;
    if (!STATUSES.includes(it.status)) return `item "${it.id}" has the status "${it.status}"; use pending, in_progress or done.`;
  }
  const busy = items.filter((i) => i.status === "in_progress");
  if (busy.length > 1) return `${busy.length} items are in_progress (${busy.map((i) => i.id).join(", ")}); at most one may be in_progress at a time. Finish one first, or set the others back to pending.`;
  return "";
}
/** Runs one todo tool call. The list is only changed when the result is valid. */
export function applyTodo(current: TodoItem[] | undefined, a: any): { items?: TodoItem[]; changed: boolean; out: string } {
  const now = current || [];
  const action = String(a?.action || "list");
  if (action === "list") return { changed: false, out: now.length ? renderTodos(now) : "The todo list is empty. Make one with action 'set'." };
  if (action === "set") {
    if (!Array.isArray(a?.items)) return { changed: false, out: "Error: 'set' needs items: a list of {id, text, status}." };
    const items: TodoItem[] = a.items.map((x: any, i: number) => ({ id: cleanText(x?.id ?? i + 1) || String(i + 1), text: cleanText(x?.text), status: (x?.status ?? "pending") as TodoStatus }));
    const bad = todoProblem(items); if (bad) return { changed: false, out: "Error: not saved: " + bad };
    return { items, changed: true, out: renderTodos(items) };
  }
  if (action === "update") {
    const id = cleanText(a?.id);
    if (!id) return { changed: false, out: "Error: 'update' needs the id of the item to change." };
    const at = now.findIndex((x) => x.id === id);
    if (at < 0) return { changed: false, out: `Error: there is no item "${id.slice(0, 60)}".` + (now.length ? " Ids: " + now.map((x) => x.id).join(", ") + "." : " The list is empty; make one with action 'set'.") };
    if (a?.status === undefined && a?.text === undefined) return { changed: false, out: "Error: 'update' needs a new status or a new text." };
    const items = now.map((x) => ({ ...x }));
    if (a.status !== undefined) items[at].status = a.status;
    if (a.text !== undefined) items[at].text = cleanText(a.text);
    const bad = todoProblem(items); if (bad) return { changed: false, out: "Error: not saved: " + bad };
    return { items, changed: true, out: renderTodos(items) };
  }
  return { changed: false, out: `Error: unknown action "${action.slice(0, 30)}". Use set, update or list.` };
}
const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", done: "[x]" };
/** The list as a short checklist, for the AI and for people. */
export function renderTodos(items: TodoItem[]): string {
  const done = items.filter((i) => i.status === "done").length;
  return `Todo list (${done}/${items.length} done):\n` + items.map((i) => `${MARK[i.status] || "[ ]"} ${i.id}. ${i.text}${i.status === "in_progress" ? "  (in progress)" : ""}`).join("\n");
}
export const openTodos = (items?: TodoItem[]) => (items || []).filter((i) => i.status !== "done");
/** Read back from a saved chat: only well-formed lists are kept. */
export function loadTodos(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const items = raw.map((x: any) => ({ id: cleanText(x?.id), text: cleanText(x?.text), status: x?.status }));
  return todoProblem(items as TodoItem[]) ? undefined : (items as TodoItem[]);
}
/** The message put back into a shortened chat so the AI never loses its place. */
export const todoReminder = (items: TodoItem[]) => "[Your todo list, kept from before the chat was shortened]\n" + renderTodos(items) + "\nContinue from the item in progress (or the first pending one) and keep the list up to date with the todo tool.";
/** Sent back once when the AI finishes with items still open. */
export const todoNudge = (items: TodoItem[]) => "You called finish, but your todo list still has open items:\n" + renderTodos(openTodos(items)) + "\nDo them now and mark them done with the todo tool. If some cannot or should not be done, mark the finished ones done and call finish again, saying in your summary which items were left open and why.";
