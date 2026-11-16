// Starts a real VS Code, loads the extension into it and runs test/suite.js inside the editor.
// Two stand-ins are prepared: a recorder program (to check the exact words the extension starts syok with), and, when Bun is
// present, the REAL syok program built from this repository, talking to a stand-in AI server on this computer.
"use strict";
const path = require("node:path"), fs = require("node:fs"), os = require("node:os"), http = require("node:http");
const { spawnSync } = require("node:child_process");
const { runTests } = require("@vscode/test-electron");
const win = process.platform === "win32";

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "syok-vsc-"));
  const project = path.join(work, "project"); fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.js"), "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n");
  const out = path.join(work, "calls"); fs.mkdirSync(out);

  // 1. The recorder: writes down the folder it was started in and its words. Like the real program, it reads and removes the task file.
  const recJs = path.join(work, "recorder.js");
  fs.writeFileSync(recJs, `const fs=require("node:fs"),path=require("node:path");const a=process.argv.slice(2);let task=null;const i=a.indexOf("--task-file");if(i>=0){task=fs.readFileSync(a[i+1],"utf8");fs.rmSync(a[i+1]);}
fs.writeFileSync(path.join(${JSON.stringify(out)},Date.now()+"-"+process.pid+".json"),JSON.stringify({cwd:process.cwd(),args:a,task}));setTimeout(()=>{},1500);\n`);
  let recorder;
  if (win) { recorder = path.join(work, "recorder.cmd"); fs.writeFileSync(recorder, `@echo off\r\n"${process.execPath}" "${recJs}" %*\r\n`); }
  else { recorder = path.join(work, "recorder"); fs.writeFileSync(recorder, `#!/bin/sh\nexec "${process.execPath}" "${recJs}" "$@"\n`); fs.chmodSync(recorder, 0o755); }

  // 2. The real program, laid out as the installer lays it out (bin/syok or bin/syok.cmd + bin/bun.exe + syok.js), and a stand-in AI.
  const env = { SYOK_TEST_RECORDER: recorder, SYOK_TEST_OUT: out, SYOK_TEST_PROJECT: project };
  let server = null;
  const bunPath = (spawnSync(win ? "where" : "which", ["bun"], { encoding: "utf8" }).stdout || "").split(/\r?\n/).find((l) => l.trim() && (!win || /\.exe$/i.test(l.trim())));
  if (bunPath) {
    const inst = path.join(work, "inst"), bin = path.join(inst, "bin"); fs.mkdirSync(bin, { recursive: true });
    const b = spawnSync(bunPath.trim(), ["build", path.resolve(__dirname, "..", "..", "src", "main.ts"), "--target=bun", "--minify", "--outfile", path.join(inst, "syok.js")], { encoding: "utf8" });
    if (b.status !== 0) { console.error("Could not build the real program:\n" + b.stderr); process.exit(1); }
    let real;
    if (win) { fs.copyFileSync(bunPath.trim(), path.join(bin, "bun.exe")); real = path.join(bin, "syok.cmd"); fs.writeFileSync(real, '@echo off\r\n"%~dp0bun.exe" "%~dp0..\\syok.js" %*'); }
    else { real = path.join(bin, "syok"); fs.writeFileSync(real, `#!/bin/sh\nexec "${bunPath.trim()}" "${path.join(inst, "syok.js")}" "$@"\n`); fs.chmodSync(real, 0o755); }
    const seen = path.join(work, "ai-requests.json"); const bodies = []; let n = 0;
    const call = (name, args) => ({ role: "assistant", content: "", tool_calls: [{ id: "c" + n, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    const script = [call("edit_file", { path: "src/a.js", old_text: "const b = 2;", new_text: "const b = 40;" }), call("finish", { summary: "Changed b to 40." })];
    server = http.createServer((req, res) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => {
      if (req.method !== "POST" || !/chat\/completions/.test(req.url)) { res.writeHead(404, { "content-type": "application/json" }); return res.end("{}"); }
      try { bodies.push({ auth: req.headers.authorization, body: JSON.parse(d) }); } catch { bodies.push({ bad: d.slice(0, 200) }); }
      fs.writeFileSync(seen, JSON.stringify(bodies));
      res.writeHead(200, { "content-type": "application/json", "x-syok-provider": "groq", "x-syok-model": "m" });
      res.end(JSON.stringify({ choices: [{ message: script[Math.min(n++, script.length - 1)] }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
    }); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    Object.assign(env, { SYOK_TEST_REAL: real, SYOK_TEST_SEEN: seen, SYOK_BASE_URL: `http://127.0.0.1:${server.address().port}`, SYOK_API_KEY: "syk_vscode_test_key", SYOK_NO_UPDATE_CHECK: "1" });
  } else if (process.env.SYOK_REQUIRE_REAL) { console.error("Bun was not found, and SYOK_REQUIRE_REAL is set: the real-program test cannot be skipped."); process.exit(1); }
  else console.log("Bun was not found: the real-program test is skipped (the recorder tests still run).");

  let code = 0;
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, ".."), extensionTestsPath: path.resolve(__dirname, "suite.js"),
      launchArgs: [project, "--disable-extensions", "--disable-workspace-trust", "--user-data-dir", path.join(work, "user")],
      extensionTestsEnv: env,
    });
    console.log("VS Code tests passed.");
  } catch (e) { console.error("VS Code tests FAILED:", e && e.message ? e.message : e); code = 1; }
  if (server) server.close();
  process.exit(code);
})();
