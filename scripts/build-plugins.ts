// Builds the plugin list from the plugins/ folder: index.json and one <name>.json per plugin.
// Usage: bun scripts/build-plugins.ts <output folder>
import { buildList } from "../src/plugin-list.ts";
import { join } from "node:path";
const out = process.argv[2]; if (!out) { console.error("Give the output folder."); process.exit(2); }
const index = buildList(join(import.meta.dir, "..", "plugins"), out);
for (const p of index.plugins) console.log(`${p.name} ${p.version}  ${p.sha256.slice(0, 12)}  ${p.bytes} bytes  commands: ${p.commands.join(", ")}`);
console.log(`${index.plugins.length} plugins written to ${out}`);
