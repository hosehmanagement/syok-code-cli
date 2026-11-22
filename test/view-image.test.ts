// GAP 1: the AI can SEE pictures it made itself: view_image for files in the project, and image blocks in MCP tool results
// (for example a Playwright browser screenshot), passed on as a user message with image parts after the tool replies.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpProject, fakeAI, call } from "./helpers.ts";
import { runAgent, makeCtx } from "../src/agent.ts";
import { runTool, READONLY, toolDefs } from "../src/tools.ts";
import { resultText } from "../src/mcp.ts";
import { TOOL_PICTURES, dropOldToolPictures } from "../src/image.ts";
import { DEFAULT } from "../src/profiles.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const base = "https://syok.test";
const profile = { ...DEFAULT, nudgeTests: false };
const pngProject = (extra: Record<string, string> = {}) => { const d = tmpProject(extra); writeFileSync(join(d, "chart.png"), Buffer.from(PNG, "base64")); return d; };
const pictureMsgs = (msgs: any[]) => msgs.filter((m) => m.role === "user" && Array.isArray(m.content) && String(m.content[0]?.text || "").startsWith(TOOL_PICTURES));
const imageUrls = (m: any) => m.content.filter((p: any) => p.type === "image_url").map((p: any) => p.image_url.url);

test("view_image: the picture reaches the model on its next step, after the tool reply, as an image_url part", async () => {
  const d = pngProject();
  const ai = fakeAI([call("view_image", { path: "chart.png" }), call("finish", { summary: "looked" })]);
  const r = await runAgent({ root: d, task: "check the chart", base, key: "k", mode: "ask", ask: async () => false, fetchImpl: ai.f, profile });
  expect(r.summary).toBe("looked");
  const sent = ai.seen[1].messages;
  const tool = sent.findIndex((m: any) => m.role === "tool" && m.name === "view_image");
  expect(sent[tool].content).toContain("chart.png");
  expect(sent[tool].content).toContain("shown to you as a picture");
  const pics = pictureMsgs(sent); expect(pics.length).toBe(1);
  expect(sent.indexOf(pics[0])).toBe(tool + 1); // straight after the tool replies, never between them
  expect(imageUrls(pics[0])).toEqual(["data:image/png;base64," + PNG]);
  expect(pics[0].content[0].text).toContain("chart.png");
  // the first request had no picture: it is shown only once asked for
  expect(pictureMsgs(ai.seen[0].messages).length).toBe(0);
});

test("view_image is read-only: offered to explorers, needs no approval, and is allowed in plan mode", async () => {
  expect(READONLY.has("view_image")).toBe(true);
  const d = pngProject();
  const c = makeCtx(d, "plan", async () => { throw new Error("must not ask"); }, {}, DEFAULT); c.allowed = READONLY; c.depth = 1;
  expect(toolDefs(c).map((t: any) => t.function.name)).toContain("view_image");
  expect(await runTool(c, "view_image", { path: "chart.png" })).toContain("shown to you");
  expect(c.images?.length).toBe(1);
});

test("view_image refuses paths outside the project folder, also through a link", async () => {
  const outside = pngProject(); const d = tmpProject({});
  const c = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  expect(await runTool(c, "view_image", { path: "../x.png" })).toMatch(/^Error: .*outside the project folder/);
  expect(await runTool(c, "view_image", { path: join(outside, "chart.png") })).toMatch(/outside the project folder/);
  if (process.platform !== "win32") { symlinkSync(join(outside, "chart.png"), join(d, "link.png")); expect(await runTool(c, "view_image", { path: "link.png" })).toMatch(/outside the project folder/); }
  expect(c.images || []).toEqual([]);
});

test("view_image refuses pictures over 5 MB, files that are not pictures, folders and missing files", async () => {
  const d = tmpProject({ "notes.txt": "hello", "fake.png.txt": "x" });
  writeFileSync(join(d, "big.png"), Buffer.alloc(5_000_001, 1)); writeFileSync(join(d, "ok.webp"), Buffer.alloc(5_000_000, 1)); mkdirSync(join(d, "dir.png"));
  const c = makeCtx(d, "auto", async () => true, {}, DEFAULT);
  expect(await runTool(c, "view_image", { path: "big.png" })).toMatch(/^Error: .*larger than 5 MB/);
  expect(await runTool(c, "view_image", { path: "notes.txt" })).toMatch(/^Error: .*not a picture/);
  expect(await runTool(c, "view_image", { path: "fake.png.txt" })).toMatch(/^Error: .*not a picture/);
  expect(await runTool(c, "view_image", { path: "dir.png" })).toMatch(/^Error: .*not a file/);
  expect(await runTool(c, "view_image", { path: "gone.png" })).toMatch(/^Error: .*file not found/);
  expect(await runTool(c, "view_image", {})).toMatch(/^Error: .*not a picture/);
  expect(c.images || []).toEqual([]);
  expect(await runTool(c, "view_image", { path: "ok.webp" })).toContain("shown to you"); // exactly 5 MB is allowed
  expect(c.images![0].url.startsWith("data:image/webp;base64,")).toBe(true);
});

test("view_image works inside a helper (delegate): the helper sees the picture, the main agent's chat does not get it", async () => {
  const d = pngProject();
  const ai = fakeAI([call("delegate", { task: "look at chart.png", role: "explorer" }), call("view_image", { path: "chart.png" }), call("finish", { summary: "the chart is blue" }), call("finish", { summary: "done" })]);
  const r = await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: ai.f, profile });
  expect(r.summary).toBe("done");
  expect(pictureMsgs(ai.seen[2].messages).length).toBe(1); // the helper's next step
  expect(imageUrls(pictureMsgs(ai.seen[2].messages)[0])).toEqual(["data:image/png;base64," + PNG]);
  expect(pictureMsgs(ai.seen[3].messages).length).toBe(0); // back in the main agent
  expect(ai.seen[3].messages.some((m: any) => m.role === "tool" && String(m.content).includes("the chart is blue"))).toBe(true);
});

const fakeMcp = { mcpServers: { fake: { command: "node", args: [join(import.meta.dir, "fake-mcp.cjs")] } } };

test("MCP (local server): an image block in a tool result reaches the model; a text-only result is unchanged", async () => {
  const d = tmpProject({});
  const ai = fakeAI([call("mcp__fake__echo", { text: "hi" }), call("mcp__fake__shot", {}), call("finish", { summary: "ok" })]);
  await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: ai.f, settings: fakeMcp, profile });
  // text only: exactly as before, and no picture message
  expect(ai.seen[1].messages.some((m: any) => m.role === "tool" && m.content === "echo:hi")).toBe(true);
  expect(pictureMsgs(ai.seen[1].messages).length).toBe(0);
  // the screenshot
  const sent = ai.seen[2].messages; const tool = sent.findIndex((m: any) => m.role === "tool" && m.name === "mcp__fake__shot");
  expect(sent[tool].content).toBe("Took a screenshot of the page\n[image 1: shown to you as a picture in the next message]");
  const pics = pictureMsgs(sent); expect(pics.length).toBe(1); expect(sent.indexOf(pics[0])).toBe(tool + 1);
  expect(imageUrls(pics[0])).toEqual(["data:image/png;base64," + PNG]);
  expect(pics[0].content[0].text).toContain("mcp__fake__shot");
}, 20000);

test("MCP: pictures over 5 MB in one result, and types that cannot be shown, are left out and the model is told plainly", async () => {
  const d = tmpProject({});
  const ai = fakeAI([call("mcp__fake__huge_shot", {}), call("finish", { summary: "ok" })]);
  await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: ai.f, settings: fakeMcp, profile });
  const sent = ai.seen[1].messages; const out = String(sent.find((m: any) => m.role === "tool" && m.name === "mcp__fake__huge_shot").content);
  expect(out).toContain("[image left out: it is 5.1 MB, and pictures from one tool result may be at most 5 MB in all, so you cannot see this one]");
  expect(out).toContain("[image left out: its type (image/tiff) cannot be shown");
  expect(out).toContain("[image 1: shown to you as a picture in the next message]");
  const pics = pictureMsgs(sent); expect(pics.length).toBe(1); expect(imageUrls(pics[0])).toEqual(["data:image/png;base64," + PNG]);
}, 30000);

test("MCP (hosted server): an image block in a tool result reaches the model too", async () => {
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
    const body: any = await req.json(); const reply = (result: any) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "b", version: "1" } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return reply({ tools: [{ name: "browser_take_screenshot", description: "screenshot" }, { name: "browser_snapshot", description: "page text" }] });
    if (body.params.name === "browser_snapshot") return reply({ content: [{ type: "text", text: "- heading \"Hello\"" }] });
    return reply({ content: [{ type: "text", text: "Screenshot taken" }, { type: "image", data: PNG, mimeType: "image/png" }] });
  } });
  try {
    const d = tmpProject({});
    const settings = { mcpServers: { browser: { url: `http://127.0.0.1:${srv.port}/mcp`, headers: { Authorization: "Bearer test" } } } };
    const ai = fakeAI([call("mcp__browser__browser_snapshot", {}), call("mcp__browser__browser_take_screenshot", {}), call("finish", { summary: "ok" })]);
    await runAgent({ root: d, task: "t", base, key: "k", mode: "auto", fetchImpl: ai.f, settings, profile });
    expect(ai.seen[1].messages.some((m: any) => m.role === "tool" && m.content === "- heading \"Hello\"")).toBe(true);
    expect(pictureMsgs(ai.seen[1].messages).length).toBe(0);
    const pics = pictureMsgs(ai.seen[2].messages); expect(pics.length).toBe(1);
    expect(imageUrls(pics[0])).toEqual(["data:image/png;base64," + PNG]);
  } finally { srv.stop(true); }
}, 20000);

test("resultText: without a picture list the text is exactly as before; bad base64 is named, not passed on", () => {
  const r = { content: [{ type: "text", text: "a" }, { type: "image", data: PNG, mimeType: "image/png" }, { type: "resource" }] };
  expect(resultText(r)).toBe("a\n[image]\n[resource]");
  expect(resultText({ isError: true, content: [{ type: "text", text: "it broke" }] })).toBe("Tool error: it broke");
  const imgs: string[] = [];
  expect(resultText({ content: [{ type: "image", data: "not base64!!", mimeType: "image/png" }, { type: "image", mimeType: "image/png" }] }, imgs)).toBe("[image left out: its data is not valid base64]\n[image left out: its data is not valid base64]");
  expect(imgs).toEqual([]);
  expect(resultText({ content: [{ type: "text", text: "42" }, { type: "image", data: "..." }] }, imgs)).toBe("42\n[image]"); // no type given: named only, as before
  expect(imgs).toEqual([]);
});

test("older tool pictures are dropped from the chat (newest two kept) so they are not sent on every step", () => {
  const pic = (n: number) => ({ role: "user", content: [{ type: "text", text: TOOL_PICTURES + " shot" + n }, { type: "image_url", image_url: { url: "data:image/png;base64," + PNG } }] });
  const typed = { role: "user", content: [{ type: "text", text: "look at this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] };
  const msgs: any[] = [{ role: "system", content: "s" }, typed, pic(1), pic(2), pic(3)];
  expect(dropOldToolPictures(msgs)).toBe(1);
  expect(typeof msgs[2].content).toBe("string"); expect(msgs[2].content).toContain("shot1"); expect(msgs[2].content).toContain("removed to save room");
  expect(Array.isArray(msgs[3].content) && Array.isArray(msgs[4].content)).toBe(true);
  expect(msgs[1]).toBe(typed); expect(Array.isArray(typed.content)).toBe(true); // a picture the user attached is never touched
});
