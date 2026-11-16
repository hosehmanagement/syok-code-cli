import { test, expect } from "bun:test";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { selfUpdate, sha256 } from "../src/update.ts";
import { tmpProject } from "./helpers.ts";

const site = (files: Record<string, string | number>) => (async (u: any) => {
  const name = String(u).split("/").pop()!; const v = files[name];
  return typeof v === "string" ? new Response(v) : new Response("no", { status: (v as number) || 404 });
}) as unknown as typeof fetch;
const NEW = "console.log('new program')";

test("update replaces the program when the checksum matches and the new one starts", async () => {
  const d = tmpProject({ "syok.js": "old" }); const self = join(d, "syok.js");
  const r = await selfUpdate({ self, current: sha256("old"), fetchImpl: site({ "syok.js": NEW, "syok.js.sha256": sha256(NEW) + "  syok.js\n" }) });
  expect(r).toMatchObject({ ok: true, changed: true }); expect(readFileSync(self, "utf8")).toBe(NEW); expect(existsSync(self + ".new")).toBe(false);
});

test("already up to date: nothing is written", async () => {
  const d = tmpProject({ "syok.js": NEW }); const self = join(d, "syok.js");
  const r = await selfUpdate({ self, current: sha256(NEW), check: () => { throw new Error("must not run"); }, fetchImpl: site({ "syok.js": NEW, "syok.js.sha256": sha256(NEW) }) });
  expect(r).toMatchObject({ ok: true, changed: false }); expect(r.message).toContain("up to date");
});

test("a damaged download, a web page instead of a checksum, a failed download or a program that does not start changes nothing", async () => {
  const d = tmpProject({ "syok.js": "old" }); const self = join(d, "syok.js");
  const cases: Array<[Record<string, string | number>, RegExp]> = [
    [{ "syok.js": NEW + "x", "syok.js.sha256": sha256(NEW) }, /checksum/],
    [{ "syok.js": NEW, "syok.js.sha256": "<!doctype html><html>" }, /checksum/],
    [{ "syok.js": NEW, "syok.js.sha256": 404 }, /Could not download/],
    [{ "syok.js": 500, "syok.js.sha256": sha256(NEW) }, /Could not download/],
    [{ "syok.js": "this is not a program (", "syok.js.sha256": sha256("this is not a program (") }, /does not start/],
  ];
  for (const [files, why] of cases) {
    const r = await selfUpdate({ self, current: sha256("old"), fetchImpl: site(files) });
    expect(r.ok).toBe(false); expect(r.message).toMatch(why); expect(r.message).toContain("Nothing was changed");
    expect(readFileSync(self, "utf8")).toBe("old"); expect(existsSync(self + ".new")).toBe(false);
  }
  const boom = await selfUpdate({ self, fetchImpl: (async () => { throw new Error("offline"); }) as any });
  expect(boom.ok).toBe(false); expect(boom.message).toContain("offline"); expect(readFileSync(self, "utf8")).toBe("old");
});

test("a copy that is not the one-file install is told to use the installer", async () => {
  const r = await selfUpdate({ self: "/usr/local/bin/syok", fetchImpl: site({}) });
  expect(r.ok).toBe(false); expect(r.message).toContain("installer");
});

test("command line: syok update needs no API key and reports a failed download with exit code 1", () => {
  const d = tmpProject({}); const copy = join(d, "syok.js"); writeFileSync(copy, "import " + JSON.stringify(join(import.meta.dir, "..", "src", "main.ts")) + ";");
  const r = spawnSync("bun", [copy, "update"], { encoding: "utf8", env: { ...process.env, SYOK_API_KEY: "", SYOK_BASE_URL: "", SYOK_SITE: "http://127.0.0.1:9" } });
  expect(r.status).toBe(1); expect(r.stderr).toContain("Nothing was changed");
});
