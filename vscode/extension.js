// Syok Code for VS Code: a thin layer that starts the syok command-line program in the editor's own terminal.
// The program does all the work (and all the asking for permission); this file only decides what to start it with.
"use strict";
const vscode = require("vscode");
const lib = require("./lib.js");

const NAME = "Syok Code";
const fs = require("node:fs");
const taskDirs = new Map(); // terminal -> the folder that held its task file, removed when the terminal closes
const tidy = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
function settings() {
  const c = vscode.workspace.getConfiguration("syokCode");
  return { path: c.get("path", ""), mode: c.get("mode", "ask"), model: c.get("model", ""), extra: c.get("extraArguments", []) };
}
function folder() {
  const ed = vscode.window.activeTextEditor;
  const f = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  return f ? f.uri.fsPath : undefined;
}
/** Start syok in a terminal. The program is started directly (not typed into a shell), so a task can contain any characters. */
async function launch(task) {
  const s = settings(); const where = lib.findSyok(s.path);
  if (!where.found && where.from !== "path") {
    const pick = await vscode.window.showErrorMessage(`The syok program was not found at ${where.program}. Check the "Syok Code: Path" setting.`, "Open settings");
    if (pick) vscode.commands.executeCommand("workbench.action.openSettings", "syokCode.path");
    return undefined;
  }
  const cwd = folder();
  if (!cwd) { vscode.window.showWarningMessage("Open a folder first: Syok Code works in a project folder."); return undefined; }
  let args, made = null;
  try { if (typeof task === "string") made = lib.writeTask(task); args = [...where.first, ...lib.buildArgs({ mode: s.mode, model: s.model, extra: s.extra, taskFile: made && made.file })]; }
  catch (e) { vscode.window.showErrorMessage(String(e.message || e)); return undefined; }
  const term = vscode.window.createTerminal({ name: NAME, cwd, shellPath: where.program, shellArgs: args, isTransient: true });
  if (made) taskDirs.set(term, made.dir);
  term.show(false);
  if (!where.found) setTimeout(() => { if (term.exitStatus && term.exitStatus.code !== 0) offerInstall(); }, 2500);
  return term;
}
async function offerInstall() {
  const line = lib.installLine();
  const pick = await vscode.window.showInformationMessage(`Syok Code's command-line program is not installed yet. Install it by running this line in a terminal?\n\n${line}`, { modal: true }, "Run it in a terminal");
  if (!pick) return undefined;
  const t = vscode.window.createTerminal({ name: "Install Syok Code" }); t.show(false); t.sendText(line, true);
  return t;
}
async function ask(prompt, placeHolder, given) {
  if (typeof given === "string") return given;
  return vscode.window.showInputBox({ prompt, placeHolder, ignoreFocusOut: true });
}

function activate(context) {
  context.subscriptions.push(vscode.window.onDidCloseTerminal((t) => { const d = taskDirs.get(t); if (d) { tidy(d); taskDirs.delete(t); } }));
  context.subscriptions.push({ dispose: () => { for (const d of taskDirs.values()) tidy(d); taskDirs.clear(); } });
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg("syokCode.start", () => launch(undefined));
  reg("syokCode.runTask", async (given) => {
    const task = await ask("What should Syok Code do in this project?", "for example: add a test for the date parser", given);
    if (!task || !task.trim()) return undefined;
    return launch(task);
  });
  reg("syokCode.askSelection", async (given) => {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.selection.isEmpty) { vscode.window.showWarningMessage("Select some code first."); return undefined; }
    const q = await ask("What do you want to know or change about the selected code?", "for example: explain this, or: make this faster", given);
    if (!q || !q.trim()) return undefined;
    const sel = { text: ed.document.getText(ed.selection), file: vscode.workspace.asRelativePath(ed.document.uri), startLine: ed.selection.start.line + 1, endLine: ed.selection.end.line + 1 };
    return launch(lib.selectionTask(q, sel));
  });
  reg("syokCode.fixProblems", async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) { vscode.window.showWarningMessage("Open the file with the problems first."); return undefined; }
    const problems = vscode.languages.getDiagnostics(ed.document.uri).map((d) => ({ severity: d.severity, line: d.range.start.line + 1, message: d.message, source: d.source, code: typeof d.code === "object" && d.code ? d.code.value : d.code }));
    const task = lib.problemsTask(vscode.workspace.asRelativePath(ed.document.uri), problems);
    if (!task) { vscode.window.showInformationMessage("The editor reports no errors or warnings in this file."); return undefined; }
    return launch(task);
  });
  reg("syokCode.install", () => offerInstall());
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  bar.text = "$(sparkle) Syok"; bar.tooltip = "Give Syok Code a task (in this project)"; bar.command = "syokCode.runTask"; bar.show();
  context.subscriptions.push(bar);
}
function deactivate() {}
module.exports = { activate, deactivate };
