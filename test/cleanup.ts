// Loaded before every test file (bunfig.toml: [test] preload). When a test file ends, the temporary folders it made through
// tmpProject or tmpDir (test/helpers.ts) are removed.
import { afterAll } from "bun:test";
import { removeTmpDirs } from "./helpers.ts";
afterAll(() => { removeTmpDirs(); });
