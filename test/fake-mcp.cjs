// A tiny fake MCP tool server for tests (speaks newline-delimited JSON-RPC on stdin/stdout).
const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  const m = JSON.parse(l); if (m.id === undefined) return;
  const send = (r) => console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...r }));
  if (m.method === "initialize") send({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (m.method === "tools/list") send({ result: { tools: [{ name: "echo", description: "echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
  else if (m.method === "tools/call") send({ result: { content: [{ type: "text", text: "echo:" + m.params.arguments.text }] } });
  else send({ error: { message: "unknown method" } });
});
