import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, relative, isAbsolute } from "node:path";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
/** Pictures named like @screenshot.png in your message are attached to it. Only files inside the project folder, up to 5 MB. */
export function extractImages(root: string, text: string): { text: string; images: string[]; notes: string[] } {
  const images: string[] = [], notes: string[] = [];
  const out = text.replace(/(^|\s)@("[^"]+"|'[^']+'|\S+)/g, (whole, pre, tok) => {
    const p = String(tok).replace(/^["']|["']$/g, ""); const ext = extname(p).toLowerCase();
    if (!MIME[ext]) return whole;
    const abs = resolve(root, p); const rel = relative(root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) { notes.push(p + ": outside the project folder, not attached"); return whole; }
    if (!existsSync(abs)) { notes.push(p + ": file not found"); return whole; }
    if (statSync(abs).size > 5_000_000) { notes.push(p + ": larger than 5 MB, not attached"); return whole; }
    images.push("data:" + MIME[ext] + ";base64," + readFileSync(abs).toString("base64"));
    return pre + "[image: " + p + "]";
  });
  return { text: out, images, notes };
}
export function withImages(text: string, images: string[]): any {
  return images.length ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : text;
}
