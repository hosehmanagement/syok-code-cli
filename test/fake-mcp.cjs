// A tiny fake MCP tool server for tests (speaks newline-delimited JSON-RPC on stdin/stdout).
// "echo" answers with text only; "shot" answers like a browser screenshot tool (text plus an image block);
// "huge_shot" sends a picture over 5 MB and one of a type that cannot be shown.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  const send = (r) => console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...r }));
  if (m.method === "initialize") send({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list") send({ result: { tools: [
    { name: "echo", description: "echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    { name: "shot", description: "take a screenshot", inputSchema: { type: "object", properties: {} } },
    { name: "huge_shot", description: "take a very large screenshot", inputSchema: { type: "object", properties: {} } },
  ] } });
  else if (m.method === "tools/call" && m.params.name === "shot") send({ result: { content: [{ type: "text", text: "Took a screenshot of the page" }, { type: "image", data: PNG, mimeType: "image/png" }] } });
  else if (m.method === "tools/call" && m.params.name === "huge_shot") send({ result: { content: [{ type: "image", data: Buffer.alloc(5_100_000, 7).toString("base64"), mimeType: "image/png" }, { type: "image", data: PNG, mimeType: "image/tiff" }, { type: "image", data: PNG, mimeType: "image/png" }] } });
  else if (m.method === "tools/call") send({ result: { content: [{ type: "text", text: "echo:" + m.params.arguments.text }] } });
  else send({ error: { message: "unknown method" } });
});
