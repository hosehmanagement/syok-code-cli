// Runs INSIDE a real VS Code (started by run-vscode.js). Every check uses the real editor: real commands, real terminals.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const vscode = require("vscode");

const OUT = process.env.SYOK_TEST_OUT, FAKE = process.env.SYOK_TEST_RECORDER, PROJECT = process.env.SYOK_TEST_PROJECT, REAL = process.env.SYOK_TEST_REAL, SEEN = process.env.SYOK_TEST_SEEN;
const os = require("node:os");
const taskDirs = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("syok-task-"));
const closed = (term, ms = 30000) => new Promise((res, rej) => { if (term.exitStatus) return res(term.exitStatus); const t = setTimeout(() => { d.dispose(); rej(new Error("the terminal did not close within " + ms / 1000 + " seconds")); }, ms); const d = vscode.window.onDidCloseTerminal((x) => { if (x === term) { clearTimeout(t); d.dispose(); res(x.exitStatus); } }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = () => fs.readdirSync(OUT).sort().map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8")));
async function nextCall(before, ms = 30000) { const t = Date.now(); while (Date.now() - t < ms) { const c = calls(); if (c.length > before) return c[c.length - 1]; await sleep(200); } throw new Error("the syok program was not started within " + ms / 1000 + " seconds"); }
const same = (a, b) => fs.realpathSync(a) === fs.realpathSync(b);

exports.run = async function run() {
  const results = [];
  const check = async (name, fn) => { try { await fn(); results.push("PASS " + name); console.log("PASS " + name); } catch (e) { results.push("FAIL " + name + ": " + (e && e.message)); console.log("FAIL " + name + ": " + (e && e.stack)); } };
  const cfg = () => vscode.workspace.getConfiguration("syokCode");
  await cfg().update("path", FAKE, vscode.ConfigurationTarget.Global);

  await check("the extension is loaded and all five commands exist", async () => {
    const ext = vscode.extensions.getExtension("syok-code.syok-code"); assert.ok(ext, "the extension is not installed in this editor");
    await ext.activate(); assert.equal(ext.isActive, true);
    const all = await vscode.commands.getCommands(true);
    for (const c of ["syokCode.start", "syokCode.runTask", "syokCode.askSelection", "syokCode.fixProblems", "syokCode.install"]) assert.ok(all.includes(c), c + " is missing");
  });

  await check("Open chat starts the program in the project folder with no task", async () => {
    const n = calls().length; const term = await vscode.commands.executeCommand("syokCode.start");
    assert.ok(term, "no terminal was returned"); assert.equal(term.name, "Syok Code");
    const c = await nextCall(n); assert.ok(same(c.cwd, PROJECT), c.cwd); assert.deepEqual(c.args, []); assert.equal(c.task, null);
    assert.ok(vscode.window.terminals.some((t) => t.name === "Syok Code"));
  });

  const taskOf = (c) => { const i = c.args.indexOf("--task-file"); assert.ok(i >= 0, "no --task-file in " + JSON.stringify(c.args)); assert.equal(c.args[i + 2], "--stay"); assert.equal(c.args.length, i + 3); assert.ok(path.isAbsolute(c.args[i + 1])); return { before: c.args.slice(0, i), file: c.args[i + 1] }; };

  await check("Give it a task hands the task over in a file, so no shell ever reads it, and tidies up when the terminal closes", async () => {
    const nasty = "say \"hi\"; echo $HOME && `id` 'x' | cat > /tmp/should-not-exist-syok & echo %PATH% ^ !x! <a >b\nsecond line";
    const dirs0 = taskDirs().length;
    const n = calls().length; const term = await vscode.commands.executeCommand("syokCode.runTask", nasty);
    const c = await nextCall(n); const t = taskOf(c);
    assert.deepEqual(t.before, []); assert.equal(c.task, nasty); assert.equal(fs.existsSync("/tmp/should-not-exist-syok"), false);
    for (const w of c.args) assert.ok(!/[&%^!<>`$|;'"\n]/.test(w), "a word given to the program has a character a shell could read: " + w);
    await closed(term); await sleep(500); assert.equal(taskDirs().length, dirs0, "the folder of the task file was left behind");
  });

  await check("mode, model and extra words from the settings are used", async () => {
    await cfg().update("mode", "accept-edits", vscode.ConfigurationTarget.Global); await cfg().update("model", "my-model", vscode.ConfigurationTarget.Global); await cfg().update("extraArguments", ["--no-web"], vscode.ConfigurationTarget.Global);
    try { const n = calls().length; await vscode.commands.executeCommand("syokCode.runTask", "do it"); const c = await nextCall(n); assert.deepEqual(taskOf(c).before, ["--mode", "accept-edits", "--model", "my-model", "--no-web"]); assert.equal(c.task, "do it"); }
    finally { await cfg().update("mode", undefined, vscode.ConfigurationTarget.Global); await cfg().update("model", undefined, vscode.ConfigurationTarget.Global); await cfg().update("extraArguments", undefined, vscode.ConfigurationTarget.Global); }
  });

  await check("Ask about the selected code sends the selection with its file and lines", async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(PROJECT, "src", "a.js")); const ed = await vscode.window.showTextDocument(doc);
    ed.selection = new vscode.Selection(1, 0, 1, 12);
    const n = calls().length; await vscode.commands.executeCommand("syokCode.askSelection", "what is b?");
    const c = await nextCall(n);
    taskOf(c);
    assert.equal(c.task.replace(/\\/g, "/"), "what is b?\n\nThis is about src/a.js, lines 2-2:\n```\nconst b = 2;\n```");
  });

  await check("Ask about the selected code does nothing without a selection, and an empty task starts nothing", async () => {
    const ed = vscode.window.activeTextEditor; ed.selection = new vscode.Selection(0, 0, 0, 0);
    const n = calls().length;
    assert.equal(await vscode.commands.executeCommand("syokCode.askSelection", "q"), undefined);
    assert.equal(await vscode.commands.executeCommand("syokCode.runTask", "   "), undefined);
    await sleep(1500); assert.equal(calls().length, n);
  });

  await check("Fix the problems lists what the editor reports for the file, and says so when there is nothing", async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(PROJECT, "src", "a.js")); await vscode.window.showTextDocument(doc);
    const n0 = calls().length; assert.equal(await vscode.commands.executeCommand("syokCode.fixProblems"), undefined); await sleep(1000); assert.equal(calls().length, n0);
    const col = vscode.languages.createDiagnosticCollection("syok-test");
    const d1 = new vscode.Diagnostic(new vscode.Range(2, 0, 2, 5), "Something is wrong here", vscode.DiagnosticSeverity.Error); d1.source = "testlint"; d1.code = "E42";
    const d2 = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), "just a hint", vscode.DiagnosticSeverity.Hint);
    col.set(doc.uri, [d1, d2]);
    try {
      const n = calls().length; await vscode.commands.executeCommand("syokCode.fixProblems"); const c = await nextCall(n);
      taskOf(c); assert.ok(c.task.includes("- line 3 [testlint E42]: Something is wrong here"), c.task); assert.ok(!c.task.includes("just a hint")); assert.ok(c.task.replace(/\\/g, "/").includes("in src/a.js."));
    } finally { col.dispose(); }
  });

  await check("a wrong path in the settings starts nothing", async () => {
    await cfg().update("path", path.join(PROJECT, "does-not-exist"), vscode.ConfigurationTarget.Global);
    try { const n = calls().length; const p = vscode.commands.executeCommand("syokCode.runTask", "x"); await sleep(1500); assert.equal(calls().length, n); void p; }
    finally { await cfg().update("path", FAKE, vscode.ConfigurationTarget.Global); }
  });

  if (REAL) await check("the REAL syok program, started by the extension in the editor's terminal: gets the task intact, edits the file, stays open, leaves on /exit", async () => {
    for (const t of vscode.window.terminals) t.dispose();
    const task = "Set b to 40 in src/a.js. Keep \"quotes\", $HOME, `ticks`, 100% & more | intact\nsecond line";
    await cfg().update("path", REAL, vscode.ConfigurationTarget.Global); await cfg().update("mode", "auto", vscode.ConfigurationTarget.Global);
    try {
      const file = path.join(PROJECT, "src", "a.js"); const dirs0 = taskDirs().length;
      const term = await vscode.commands.executeCommand("syokCode.runTask", task); assert.ok(term);
      const t0 = Date.now(); while (Date.now() - t0 < 60000 && !fs.readFileSync(file, "utf8").includes("const b = 40;")) { if (term.exitStatus) throw new Error("the program ended early with code " + term.exitStatus.code); await sleep(300); }
      assert.equal(fs.readFileSync(file, "utf8"), "const a = 1;\nconst b = 40;\nconsole.log(a + b);\n");
      let reqs = []; const t1 = Date.now(); while (Date.now() - t1 < 30000) { reqs = JSON.parse(fs.readFileSync(SEEN, "utf8")); if (reqs.length >= 2) break; await sleep(300); }
      assert.ok(reqs.length >= 2, "the AI was asked " + reqs.length + " time(s)"); assert.equal(reqs[0].auth, "Bearer syk_vscode_test_key");
      const users = reqs[0].body.messages.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      assert.ok(users.some((u) => u.includes(task)), "the task did not reach the AI intact: " + JSON.stringify(users).slice(0, 600));
      await sleep(4000); assert.equal(term.exitStatus, undefined, "the terminal closed after the task: the result would be lost");
      assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("syok-task-")).every((d) => !fs.existsSync(path.join(os.tmpdir(), d, "task.txt"))), true, "the task file was not removed by the program");
      term.sendText("/exit", true); const st = await closed(term, 30000); assert.equal(st && st.code, 0);
      await sleep(500); assert.equal(taskDirs().length, dirs0);
    } finally { await cfg().update("path", FAKE, vscode.ConfigurationTarget.Global); await cfg().update("mode", undefined, vscode.ConfigurationTarget.Global); }
  });

  for (const t of vscode.window.terminals) t.dispose();
  const failed = results.filter((r) => r.startsWith("FAIL"));
  if (failed.length) throw new Error(failed.length + " check(s) failed:\n" + failed.join("\n"));
};
