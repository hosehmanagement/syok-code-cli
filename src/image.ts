import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { extname, resolve, relative, isAbsolute, sep } from "node:path";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** The largest picture sent to the AI, from a file or from one tool result. */
export const IMAGE_MAX_BYTES = 5_000_000;
/** Picture types the AI can be shown (the same list for files and for tool servers). */
export const IMAGE_TYPES = new Set(Object.values(MIME));
/** One picture file inside the project folder, as a data: address, or why it cannot be used. */
export function loadImage(root: string, p: string): { url: string; rel: string; bytes: number } | { error: string } {
  const ext = extname(p).toLowerCase();
  if (!MIME[ext]) return { error: "not a picture (only .png, .jpg, .jpeg, .gif and .webp can be shown)" };
  const abs = resolve(root, p); const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return { error: "outside the project folder, not attached" };
  if (!existsSync(abs)) return { error: "file not found" };
  // A link inside the project that points outside it is refused too.
  try { const real = relative(realpathSync(root), realpathSync(abs)); if (real.startsWith("..") || isAbsolute(real)) return { error: "outside the project folder, not attached" }; } catch { return { error: "file not found" }; }
  const st = statSync(abs);
  if (!st.isFile()) return { error: "not a file" };
  if (st.size > IMAGE_MAX_BYTES) return { error: "larger than 5 MB, not attached" };
  return { url: "data:" + MIME[ext] + ";base64," + readFileSync(abs).toString("base64"), rel: rel.split(sep).join("/"), bytes: st.size };
}
/** Pictures named like @screenshot.png in your message are attached to it. Only files inside the project folder, up to 5 MB. */
export function extractImages(root: string, text: string): { text: string; images: string[]; notes: string[] } {
  const images: string[] = [], notes: string[] = [];
  const out = text.replace(/(^|\s)@("[^"]+"|'[^']+'|\S+)/g, (whole, pre, tok) => {
    const p = String(tok).replace(/^["']|["']$/g, "");
    if (!MIME[extname(p).toLowerCase()]) return whole;
    const r = loadImage(root, p);
    if ("error" in r) { notes.push(p + ": " + r.error); return whole; }
    images.push(r.url);
    return pre + "[image: " + p + "]";
  });
  return { text: out, images, notes };
}
export function withImages(text: string, images: string[]): any {
  return images.length ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : text;
}
/** The first words of the message that carries pictures from tools (view_image, MCP) to the AI. */
export const TOOL_PICTURES = "[Pictures from your tool calls]";
/** Older tool pictures are replaced by a short note so they are not sent again on every step; the newest `keep` messages keep theirs. */
export function dropOldToolPictures(messages: { role: string; content?: any }[], keep = 2): number {
  const idx = messages.map((m, i) => (m.role === "user" && Array.isArray(m.content) && m.content[0]?.text?.startsWith(TOOL_PICTURES) ? i : -1)).filter((i) => i >= 0);
  let n = 0;
  for (const i of idx.slice(0, Math.max(0, idx.length - keep))) {
    const parts = messages[i].content as any[]; const pics = parts.filter((p) => p.type === "image_url").length;
    messages[i].content = parts.filter((p) => p.type === "text").map((p) => p.text).join("\n") + `\n(${pics} picture${pics === 1 ? "" : "s"} shown earlier, removed to save room; call view_image again if you need to look once more)`; n++;
  }
  return n;
}
