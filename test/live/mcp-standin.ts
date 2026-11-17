// A tiny hosted tool server for the live test: one tool, protected by a key, speaking MCP over HTTP.
const KEY = process.env.STANDIN_KEY || ""; const port = +(process.env.STANDIN_PORT || 8791);
Bun.serve({ port, hostname: "127.0.0.1", fetch: async (req) => {
  if (req.method === "DELETE") return new Response(null, { status: 200 });
  if (req.method !== "POST") return new Response("this server answers POST only", { status: 405 });
  if (KEY && req.headers.get("authorization") !== "Bearer " + KEY) return new Response("no", { status: 401 }); // with no key set it is open
  const b: any = await req.json(); const reply = (result: any) => Response.json({ jsonrpc: "2.0", id: b.id, result });
  if (b.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "warehouse", version: "1" } });
  if (b.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (b.method === "tools/list") return reply({ tools: [{ name: "stock_count", description: "Returns how many units of a product are in the warehouse right now.", inputSchema: { type: "object", properties: { product: { type: "string" } }, required: ["product"] } }] });
  if (b.method === "tools/call") { await Bun.write(process.env.STANDIN_LOG || "/tmp/standin.log", JSON.stringify(b.params) + "\n"); return reply({ content: [{ type: "text", text: `There are 4217 units of ${b.params?.arguments?.product} in the warehouse.` }] }); }
  return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "no such method" } });
} });
console.log("stand-in tool server on " + port);
