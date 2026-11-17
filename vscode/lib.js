// Everything that does not need the editor itself, so it can be tested without it.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const MODES = ["ask", "accept-edits", "plan", "auto"];
/** Where the syok program is: the path from settings, else the installer's place, else plain "syok" (found through PATH).
 *  "first" holds words that go before all others. On Windows the installed program is started as bun.exe + syok.js, not through
 *  syok.cmd: a .cmd file is run by the Command Prompt, which reads characters such as & and % in the words it is given. */
function findSyok(configured, o = {}) {
  const platform = o.platform || process.platform, home = o.home || os.homedir(), exists = o.exists || fs.existsSync;
  const P = platform === "win32" ? path.win32 : path.posix;
  const direct = (cmd) => { // syok.cmd made by the installer sits next to bun.exe, with syok.js one folder up
    if (platform !== "win32" || !/\.(cmd|bat)$/i.test(cmd)) return null;
    const bun = P.join(P.dirname(cmd), "bun.exe"), js = P.join(P.dirname(cmd), "..", "syok.js");
    return exists(bun) && exists(js) ? { program: bun, first: [js] } : null;
  };
  const want = String(configured || "").trim();
  if (want) { const d = exists(want) ? direct(want) : null; return { program: want, first: [], ...(d || {}), found: exists(want), from: "setting" }; }
  const installed = platform === "win32" ? P.join(home, ".syok", "bin", "syok.cmd") : P.join(home, ".syok", "bin", "syok");
  if (exists(installed)) return { program: installed, first: [], ...(direct(installed) || {}), found: true, from: "installer" };
  return { program: platform === "win32" ? "syok.cmd" : "syok", first: [], found: false, from: "path" };
}
/** The words given to syok. The task itself is never one of them: it is written to a file and only the file's path is passed
 *  (--task-file), so no character of the task can be read by a shell. --stay keeps the chat open after the task. */
function buildArgs(o = {}) {
  const a = [];
  if (o.mode && o.mode !== "ask") { if (!MODES.includes(o.mode)) throw new Error("Unknown mode: " + o.mode); a.push("--mode", o.mode); }
  if (o.model && String(o.model).trim()) a.push("--model", String(o.model).trim());
  for (const x of Array.isArray(o.extra) ? o.extra : []) if (typeof x === "string" && x.trim()) a.push(x);
  if (o.taskFile) a.push("--task-file", String(o.taskFile), "--stay");
  return a;
}
/** Write a task to a new private file and return its path. The syok program removes the file once it has read it. */
function writeTask(task, o = {}) {
  const t = String(task == null ? "" : task).trim(); if (!t) throw new Error("The task is empty.");
  const dir = fs.mkdtempSync(path.join(o.tmp || os.tmpdir(), "syok-task-"));
  const file = path.join(dir, "task.txt"); fs.writeFileSync(file, t, { mode: 0o600 });
  return { file, dir };
}
/** A question about selected code, with where the code is. */
function selectionTask(question, sel) {
  const q = String(question || "").trim(); if (!q) throw new Error("The question is empty.");
  const code = String(sel.text || ""); if (!code.trim()) throw new Error("No code is selected.");
  const cut = code.length > 12000 ? code.slice(0, 12000) + "\n...[the rest of the selection was left out]" : code;
  return `${q}\n\nThis is about ${sel.file}, lines ${sel.startLine}-${sel.endLine}:\n\`\`\`\n${cut}\n\`\`\``;
}
/** A task that asks to fix the problems the editor shows in one file. severity: 0 = error, 1 = warning. */
function problemsTask(file, problems) {
  const list = (problems || []).filter((p) => p && (p.severity === 0 || p.severity === 1)).slice(0, 40);
  if (!list.length) return null;
  const lines = list.map((p) => `- line ${p.line}${p.source ? " [" + p.source + (p.code ? " " + p.code : "") + "]" : ""}: ${String(p.message).replace(/\s+/g, " ").slice(0, 300)}`);
  return `Fix these problems that the editor reports in ${file}. Change as little as possible, and run the project's check afterwards.\n${lines.join("\n")}`;
}
/** The one line that installs Syok Code, for this kind of computer. */
function installLine(platform = process.platform) {
  return platform === "win32" ? "irm https://syok-ai.com/syok-code/install.ps1 | iex" : "curl -fsSL https://syok-ai.com/syok-code/install.sh | sh";
}
module.exports = { MODES, findSyok, buildArgs, writeTask, selectionTask, problemsTask, installLine };
