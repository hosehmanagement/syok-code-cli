// Claude Code plugin marketplaces (for example terrylica/cc-skills) in Syok Code: listing, installing only the plugin's own
// files, Claude's folder layout, ${CLAUDE_PLUGIN_ROOT} and friends, skills the AI opens by itself, and Claude-style hooks.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpProject, fakeAI, call } from "./helpers.ts";
import { cleanMarket, parseWhere, installFromMarket, switchHooks, describeMarket } from "../src/marketplace.ts";
import { loadSkills, skillText, skillCatalog, uniqueSkills, skillLabel, expandVars, inlineRuns } from "../src/skills.ts";
import { loadCommands, renderCommand, describeCommands } from "../src/commands.ts";
import { loadAgents } from "../src/agents.ts";
import { runHooks, claudeMatches, claudeInput } from "../src/hooks.ts";
import { pluginSettings, listPlugins } from "../src/plugins.ts";
import { runAgent } from "../src/agent.ts";

const node = "node";
const j = (x: unknown) => JSON.stringify(x, null, 2);

/** A small marketplace laid out exactly like a Claude Code one. */
function marketFiles(): Record<string, string> {
  return {
    ".claude-plugin/marketplace.json": j({
      name: "demo-market", owner: { name: "tester" }, description: "test market",
      plugins: [
        { name: "demo", description: "A demo plugin", version: "1.2.3", source: "./plugins/demo", category: "testing", keywords: ["x"] },
        { name: "plain", description: "Skills only", source: "./plugins/plain" },
        { name: "elsewhere", source: { source: "url", url: "https://gitlab.com/a/b.git" } },
        { name: "../evil", source: "./plugins/evil" },
        { name: "escape", source: "../outside" },
      ],
    }),
    "plugins/demo/.claude-plugin/plugin.json": j({ name: "demo", description: "Demo (manifest)", skills: ["./extra"] }),
    "plugins/demo/skills/check/SKILL.md": "---\nname: check\ndescription: Check the project with the plugin's script\nallowed-tools: Bash(node:*)\n---\nRun:\n```bash\nnode ${CLAUDE_PLUGIN_ROOT}/scripts/count.js\n```\nThen read ${CLAUDE_SKILL_DIR}/references/notes.md. Focus: $ARGUMENTS. Keep awk '{print $1}' as it is.\n",
    "plugins/demo/skills/check/references/notes.md": "notes",
    "plugins/demo/skills/secret-op/SKILL.md": "---\nname: secret-op\ndescription: Only when the user asks\ndisable-model-invocation: true\n---\nDo the thing.\n",
    "plugins/demo/extra/bonus/SKILL.md": "---\nname: bonus\ndescription: A skill from an extra folder\n---\nBonus.\n",
    "plugins/demo/scripts/count.js": "console.log('counted')\n",
    "plugins/demo/commands/greet.md": "---\ndescription: Greets\nargument-hint: <name> <place>\n---\nSay hello to $0 in $1 (all: $ARGUMENTS) using ${CLAUDE_PLUGIN_ROOT}/scripts/count.js. Status: !`git status --short`\n",
    "plugins/demo/agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews changes\ntools: Read, Grep\n---\nYou review code.\n",
    "plugins/demo/hooks/hooks.json": j({ hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.js"' }] }],
      Notification: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      Stop: [{ hooks: [{ type: "prompt", prompt: "check" }] }],
    } }),
    "plugins/demo/hooks/guard.js": "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);if(String(i.tool_input.command).includes('rm -rf'))console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'no rm -rf here'}}));});\n",
    "plugins/demo/.mcp.json": j({ mcpServers: { files: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"], env: { DATA: "${CLAUDE_PLUGIN_DATA}", KEEP: "${MY_TOKEN}" } } } }),
    "plugins/plain/skills/tidy/SKILL.md": "---\nname: tidy\ndescription: Tidy a file\n---\nTidy it.\n",
    "plugins/evil/skills/x/SKILL.md": "x",
  };
}

test("the marketplace file: sources, names and paths are checked; nothing outside the marketplace is reachable", () => {
  const m = cleanMarket(JSON.parse(marketFiles()[".claude-plugin/marketplace.json"]))!;
  expect(m.name).toBe("demo-market"); expect(m.owner).toBe("tester");
  expect(m.plugins.map((p) => p.name)).toEqual(["demo", "plain", "elsewhere", "escape"]); // "../evil" is not a name
  expect(m.plugins[0].source).toEqual({ kind: "path", path: "plugins/demo" });
  expect(m.plugins[2].source.kind).toBe("unsupported");
  expect(m.plugins[3].source.kind).toBe("unsupported"); // ../outside
  const g = cleanMarket({ plugins: [{ name: "a", source: { source: "github", repo: "o/r", ref: "v2" } }, { name: "b", source: { source: "url", url: "https://github.com/o/r.git", sha: "abc" } }, { name: "c", source: { source: "git-subdir", url: "o/r", path: "./p/c" } }, { name: "d", source: "." }, { name: "e", source: "e" }], metadata: { pluginRoot: "./plugins" } })!;
  expect(g.plugins.map((p) => p.source)).toEqual([
    { kind: "github", owner: "o", repo: "r", ref: "v2" }, { kind: "github", owner: "o", repo: "r", ref: "abc" },
    { kind: "github", owner: "o", repo: "r", path: "p/c" }, { kind: "path", path: "" }, { kind: "path", path: "plugins/e" },
  ]);
  expect(cleanMarket({})).toBeNull();
  expect(describeMarket(m, "o/r")).toContain("syok plugin add o/r <name>");
});

test("where a marketplace is: owner/repo, @ref, :plugin, a GitHub link or a folder", () => {
  expect(parseWhere("terrylica/cc-skills")).toEqual({ where: { kind: "github", owner: "terrylica", repo: "cc-skills" } });
  expect(parseWhere("https://github.com/terrylica/cc-skills.git")).toEqual({ where: { kind: "github", owner: "terrylica", repo: "cc-skills" } });
  expect(parseWhere("terrylica/cc-skills@v34.20.0:itp")).toEqual({ where: { kind: "github", owner: "terrylica", repo: "cc-skills", ref: "v34.20.0" }, plugin: "itp" });
  const d = tmpProject({ "x.txt": "" });
  expect(parseWhere(d)!.where).toEqual({ kind: "local", dir: d });
  expect(parseWhere("not a repo")).toBeNull();
});

test("installing from a marketplace folder: Claude's layout is read, hooks and tool servers stay OFF until a yes", async () => {
  const market = tmpProject(marketFiles()); const proj = tmpProject({ "a.txt": "x" });
  const list = await installFromMarket(proj, market, []);
  expect(list.ok).toBe(true); expect(list.message).toContain("demo-market by tester: 4 plugins"); expect(list.message).toContain("cannot be installed");
  const r = await installFromMarket(proj, market, ["demo", "plain"]);
  expect(r.ok).toBe(true); expect(r.installed).toEqual(["demo", "plain"]);
  expect(r.message).toContain("Added demo from demo-market (3 skills, 1 command, 1 helper)");
  expect(r.message).toContain("hooks and tool servers are OFF"); expect(r.message).toContain("PreToolUse Bash");
  expect(r.message).toContain("Notification hook was skipped"); expect(r.message).toContain('hook of type "prompt" was skipped');
  const dir = join(proj, ".syok", "plugins", "demo");
  expect(existsSync(join(dir, "settings.json"))).toBe(false);
  const off = JSON.parse(readFileSync(join(dir, "claude-hooks.off.json"), "utf8"));
  expect(off.hooks.PreToolUse[0]).toMatchObject({ claude: "Bash", plugin: "demo" }); expect(Object.keys(off.mcpServers)).toEqual(["files"]);
  expect(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"))).toMatchObject({ name: "demo", version: "1.2.3", format: "claude-code" });
  expect(existsSync(join(dir, "skills", "bonus", "SKILL.md"))).toBe(true); // the extra skills folder named in plugin.json
  expect(pluginSettings(proj, {}).hooks?.PreToolUse).toBeUndefined(); // off really means off
  // switching on and off again
  expect(switchHooks(proj, "demo", true)).toContain("ON");
  const st = pluginSettings(proj, {});
  expect(st.hooks!.PreToolUse![0]).toMatchObject({ claude: "Bash", plugin: "demo", pluginRoot: dir });
  const srv = (st.mcpServers as any)["demo-files"];
  expect(srv.args[0]).toBe(dir + "/server.js"); expect(srv.env.DATA).toContain(join(".syok", "plugin-data", "demo")); expect(srv.env.KEEP).toBe("${MY_TOKEN}");
  expect(switchHooks(proj, "demo", false)).toContain("OFF"); expect(pluginSettings(proj, {}).hooks?.PreToolUse).toBeUndefined();
  // --with-hooks switches them on at once
  const r2 = await installFromMarket(proj, market, ["demo"], { withHooks: true });
  expect(r2.message).toContain("Hooks and tool servers are ON"); expect(existsSync(join(dir, "settings.json"))).toBe(true);
  // a question is asked when there is a terminal; no means off
  let asked = "";
  await installFromMarket(proj, market, ["demo"], { confirm: async (q) => { asked = q; return false; } });
  expect(asked).toContain("Switch these on? Only say yes if you trust tester"); expect(existsSync(join(dir, "settings.json"))).toBe(false);
  // names that are not in the market, and ones that cannot be installed
  const bad = await installFromMarket(proj, market, ["nope", "elsewhere", "escape"]);
  expect(bad.ok).toBe(false); expect(bad.message).toContain("nope: not in demo-market"); expect(bad.message).toContain("outside GitHub");
  expect(existsSync(join(proj, ".syok", "plugins", "escape"))).toBe(false);
});

test("skills from a plugin: plugin:name, the project's own skill wins the plain name, variables are filled in", async () => {
  const market = tmpProject(marketFiles()); const proj = tmpProject({ ".syok/skills/check/SKILL.md": "---\nname: check\ndescription: my own check\n---\nmine" });
  await installFromMarket(proj, market, ["demo"]);
  const m = loadSkills(proj, join(proj, ".nohome"));
  expect(m.get("check")!.body).toBe("mine"); // the project's own
  const sk = m.get("demo:check")!;
  expect(sk.plugin).toBe("demo"); expect(skillLabel(m, sk)).toBe("demo:check"); expect(skillLabel(m, m.get("bonus")!)).toBe("bonus");
  const root = join(proj, ".syok", "plugins", "demo");
  const t = skillText(sk, "the tests", proj);
  expect(t).toContain("Base directory for this skill: " + join(root, "skills", "check"));
  expect(t).toContain(`node ${root}/scripts/count.js`); expect(t).toContain(join(root, "skills", "check") + "/references/notes.md");
  expect(t).toContain("Focus: the tests."); expect(t).toContain("awk '{print $1}'"); // $1 in a skill is left alone
  expect(m.get("secret-op")!.modelInvocable).toBe(false);
  const cat = skillCatalog(m);
  expect(cat).toContain("- demo:check: Check the project"); expect(cat).toContain("- bonus:"); expect(cat).not.toContain("secret-op");
  expect(uniqueSkills(m).length).toBe(4);
});

test("the AI sees the skills and opens one itself with the skill tool; settings can switch that off", async () => {
  const market = tmpProject(marketFiles()); const proj = tmpProject({ "a.txt": "x" });
  await installFromMarket(proj, market, ["demo"]);
  const ai = fakeAI([call("skill", { name: "demo:check", args: "speed" }), call("skill", { name: "secret-op" }), call("skill", { name: "nope" }), call("finish", { summary: "ok" })]);
  await runAgent({ root: proj, task: "check my project", base: "http://fake", key: "k", mode: "auto", fetchImpl: ai.f });
  const first = ai.seen[0];
  expect(first.messages[0].content).toContain("Skills you can use"); expect(first.messages[0].content).toContain("- check: Check the project");
  expect(first.tools.map((t: any) => t.function.name)).toContain("skill");
  const tools = ai.seen[ai.seen.length - 1].messages.filter((x: any) => x.role === "tool").map((x: any) => x.content);
  expect(tools[0]).toContain("=== Skill: check ==="); expect(tools[0]).toContain(join(proj, ".syok", "plugins", "demo") + "/scripts/count.js"); expect(tools[0]).toContain("Focus: speed.");
  expect(tools[1]).toContain("only started by the user"); expect(tools[2]).toContain('there is no skill called "nope"');
  const off = fakeAI([call("finish", { summary: "ok" })]);
  await runAgent({ root: proj, task: "x", base: "http://fake", key: "k", mode: "auto", fetchImpl: off.f, settings: { skills: false } });
  expect(off.seen[0].messages[0].content).not.toContain("Skills you can use"); expect(off.seen[0].tools.map((t: any) => t.function.name)).not.toContain("skill");
});

test("plugin commands and helpers: /plugin:command, $ARGUMENTS, $0 $1, ${CLAUDE_PLUGIN_ROOT}, !`command`", async () => {
  const market = tmpProject(marketFiles()); const proj = tmpProject({ "a.txt": "x" });
  await installFromMarket(proj, market, ["demo"]);
  const cm = loadCommands(proj, join(proj, ".nohome"));
  expect(cm.get("demo:greet")).toBe(cm.get("greet")!);
  const out = renderCommand(cm.get("greet")!, 'Ann "Kuala Lumpur"');
  expect(out).toContain("Say hello to Ann in Kuala Lumpur"); expect(out).toContain('(all: Ann "Kuala Lumpur")');
  expect(out).toContain(join(proj, ".syok", "plugins", "demo") + "/scripts/count.js");
  expect(out).toContain("`git status --short` (run this command first with run_command");
  expect(describeCommands(cm)).toContain("/greet  (plugin) - Greets");
  expect(loadAgents(proj, join(proj, ".nohome")).find((a) => a.name === "reviewer")?.from).toBe("plugin demo");
  expect(expandVars("$ARGUMENTS[1]", { args: "a b c" })).toBe("b");
  expect(inlineRuns("x !`ls` y")).toContain("`ls` (run this command first");
});

test("Claude hooks: matchers over Claude's tool names, Claude's JSON in, Claude's answers out", async () => {
  expect(claudeMatches("Bash", "Bash")).toBe(true); expect(claudeMatches("Bash", "BashOutput")).toBe(false);
  expect(claudeMatches("Write|Edit", "Edit")).toBe(true); expect(claudeMatches("Write, Edit", "Write")).toBe(true);
  expect(claudeMatches("*", "anything")).toBe(true); expect(claudeMatches("", "Read")).toBe(true);
  expect(claudeMatches("mcp__.*", "mcp__files__read")).toBe(true); expect(claudeMatches("Notebook.*", "Edit")).toBe(false);
  const d = tmpProject({
    "plug/rec.js": "const fs=require('fs');let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{fs.writeFileSync(process.env.CLAUDE_PLUGIN_ROOT+'/in.json',JSON.stringify({input:JSON.parse(s),env:{root:process.env.CLAUDE_PLUGIN_ROOT,project:process.env.CLAUDE_PROJECT_DIR,data:process.env.CLAUDE_PLUGIN_DATA}}));console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'not today'},systemMessage:'guard ran'}));});",
    "plug/two.js": "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('exit two says no');process.exit(2);});",
    "plug/ctx.js": "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'remember the style guide'}})));",
    "plug/plain.js": "process.stdin.resume();process.stdin.on('end',()=>console.log('branch is main'));",
    "plug/top.js": "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({permissionDecision:'deny',reason:'use gh instead'})));",
  });
  const plug = join(d, "plug");
  const h = (file: string, matcher = "Bash") => ({ claude: matcher, command: `${node} "\${CLAUDE_PLUGIN_ROOT}/${file}"`, plugin: "p1", pluginRoot: plug });
  const r = await runHooks([h("rec.js")], "PreToolUse", { tool: "run_command", args: { command: "ls -la" } }, d, "run_command");
  expect(r).toMatchObject({ block: true, message: "not today", notice: "guard ran" });
  const got = JSON.parse(readFileSync(join(plug, "in.json"), "utf8"));
  expect(got.input).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: d });
  expect(got.env.root).toBe(plug); expect(got.env.project).toBe(d); expect(got.env.data).toContain(join(".syok", "plugin-data", "p1"));
  expect((await runHooks([h("rec.js")], "PreToolUse", { tool: "edit_file", args: {} }, d, "edit_file")).block).toBe(false); // Bash hook, Edit tool
  expect(await runHooks([h("two.js", "Edit|Write")], "PreToolUse", { tool: "edit_file", args: {} }, d, "edit_file")).toMatchObject({ block: true, message: "exit two says no" });
  expect(await runHooks([h("ctx.js", "*")], "PostToolUse", { tool: "write_file", args: {}, result: "ok" }, d, "write_file")).toMatchObject({ block: false, context: "remember the style guide" });
  expect(await runHooks([h("plain.js", "")], "UserPromptSubmit", { prompt: "hi" }, d, "", { prompt: "hi" })).toMatchObject({ block: false, context: "branch is main" });
  expect(await runHooks([h("plain.js", "*")], "PreToolUse", { tool: "run_command", args: {} }, d, "run_command")).toMatchObject({ block: false, notice: "branch is main" });
  // the form some real hooks print (cc-skills gh-tools): permissionDecision and reason at the top level
  expect(await runHooks([h("top.js", "WebFetch")], "PreToolUse", { tool: "web_fetch", args: { url: "https://github.com/a/b" } }, d, "web_fetch")).toMatchObject({ block: true, message: "use gh instead" });
  expect(claudeInput("edit_file", { path: "a.ts", old_text: "x", new_text: "y" }, d)).toEqual({ file_path: join(d, "a.ts"), old_string: "x", new_string: "y", replace_all: false });
  expect(claudeInput("write_file", { path: "b.ts", content: "c" }, d)).toEqual({ file_path: join(d, "b.ts"), content: "c" });
});

test("Claude hooks inside a real run: a PreToolUse deny stops the command; UserPromptSubmit and SessionStart add context", async () => {
  const d = tmpProject({
    "plug/deny.js": "let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{const i=JSON.parse(s);if(i.tool_input.command.includes('danger'))console.log(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'danger is blocked'}}));});",
    "plug/say.js": "let s='';process.stdin.on('data',x=>s+=x).on('end',()=>{const i=JSON.parse(s);console.log(i.hook_event_name==='SessionStart'?'session note: use bun':'prompt note: '+i.prompt.length);});",
  });
  const plug = join(d, "plug");
  const hooks = {
    PreToolUse: [{ claude: "Bash", command: `${node} "\${CLAUDE_PLUGIN_ROOT}/deny.js"`, plugin: "p", pluginRoot: plug }],
    UserPromptSubmit: [{ claude: "*", command: `${node} "\${CLAUDE_PLUGIN_ROOT}/say.js"`, plugin: "p", pluginRoot: plug }],
    SessionStart: [{ claude: "*", command: `${node} "\${CLAUDE_PLUGIN_ROOT}/say.js"`, plugin: "p", pluginRoot: plug }],
  };
  const ai = fakeAI([call("run_command", { command: "echo danger" }), call("run_command", { command: "echo fine" }), call("finish", { summary: "done" })]);
  const r = await runAgent({ root: d, task: "do it", base: "http://fake", key: "k", mode: "auto", fetchImpl: ai.f, settings: { hooks } as any });
  const last = ai.seen[ai.seen.length - 1].messages;
  const firstUser = last.find((m: any) => m.role === "user").content;
  expect(firstUser).toContain("session note: use bun"); expect(firstUser).toContain("prompt note: 5");
  const tools = last.filter((m: any) => m.role === "tool").map((m: any) => m.content);
  expect(tools[0]).toContain("Blocked by a hook: danger is blocked"); expect(tools[1]).toContain("fine");
  expect(r.commands).toBe(1);
});

/** A stand-in for GitHub: the API (default branch, file tree) and raw files. Records every address asked for. */
function fakeGithub(files: Record<string, string>, opts: { limited?: boolean; extraTree?: any[]; noArchive?: boolean } = {}) {
  const asked: string[] = [];
  // the repository archive, as codeload.github.com serves it: one top folder holding the files
  const arch = tmpProject(Object.fromEntries(Object.entries(files).map(([k, v]) => ["m-main/" + k, v])));
  spawnSync("tar", ["-czf", join(arch, "x.tgz"), "-C", arch, "m-main"]);
  const tgz = readFileSync(join(arch, "x.tgz"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const u = new URL(req.url); asked.push(u.pathname);
    if (u.pathname.startsWith("/api/")) {
      if (opts.limited) return new Response("rate limited", { status: 403 });
      if (u.pathname === "/api/repos/o/m") return Response.json({ default_branch: "main" });
      if (u.pathname === "/api/repos/o/m/git/trees/main") return Response.json({ truncated: false, tree: [...Object.keys(files).map((p) => ({ path: p, type: "blob", size: files[p].length, mode: p.endsWith(".sh") ? "100755" : "100644" })), { path: "plugins", type: "tree" }, ...(opts.extraTree || [])] });
      return new Response("nf", { status: 404 });
    }
    if (u.pathname === "/codeload/o/m/tar.gz/HEAD" || u.pathname === "/codeload/o/m/tar.gz/main") return opts.noArchive ? new Response("no", { status: 503 }) : new Response(tgz);
    const m = /^\/raw\/o\/m\/(HEAD|main)\/(.+)$/.exec(u.pathname);
    if (m && files[decodeURIComponent(m[2])] !== undefined) return new Response(files[decodeURIComponent(m[2])]);
    return new Response("nf", { status: 404 });
  } });
  const env = { SYOK_GITHUB_API: `http://127.0.0.1:${server.port}/api`, SYOK_GITHUB_RAW: `http://127.0.0.1:${server.port}/raw`, SYOK_GITHUB_CODELOAD: `http://127.0.0.1:${server.port}/codeload` };
  return { server, env, asked };
}

test("from GitHub: the list needs no API call; installing downloads only that plugin's own files", async () => {
  const files = { ...marketFiles(), "plugins/demo/scripts/run.sh": "echo hi\n", "README.md": "big readme", "plugins/other/skills/z/SKILL.md": "z" };
  const gh = fakeGithub(files, { extraTree: [{ path: "plugins/demo/../../evil.txt", type: "blob", size: 3 }] });
  try {
    const proj = tmpProject({ "a.txt": "x" });
    const list = await installFromMarket(proj, "o/m", [], { env: gh.env });
    expect(list.message).toContain("demo-market by tester"); expect(gh.asked.filter((p) => p.startsWith("/api/"))).toEqual([]);
    gh.asked.length = 0;
    const r = await installFromMarket(proj, "o/m", ["demo"], { env: gh.env });
    expect(r.ok).toBe(true); expect(r.message).toContain("Added demo from demo-market (3 skills, 1 command, 1 helper)");
    const raw = gh.asked.filter((p) => p.startsWith("/raw/") && !p.endsWith("marketplace.json"));
    expect(raw.length).toBeGreaterThan(5); expect(raw.every((p) => p.startsWith("/raw/o/m/main/plugins/demo/"))).toBe(true);
    const dir = join(proj, ".syok", "plugins", "demo");
    expect(readFileSync(join(dir, "skills", "check", "SKILL.md"), "utf8")).toContain("CLAUDE_PLUGIN_ROOT");
    expect(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).from).toBe("demo-market (o/m@main)");
    expect(existsSync(join(proj, "evil.txt")) || existsSync(join(proj, ".syok", "evil.txt"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(join(dir, "scripts", "run.sh")).mode & 0o111).toBeTruthy();
    // a repository with no marketplace file is not treated as one
    const none = await installFromMarket(proj, "o/elsewhere", [], { env: gh.env });
    expect(none).toMatchObject({ ok: false, notMarket: true });
  } finally { gh.server.stop(true); }
  // GitHub's API says no (its 60-an-hour anonymous limit): the archive is used instead, and still only the plugin is kept
  const limited = fakeGithub(marketFiles(), { limited: true });
  try {
    const proj = tmpProject({});
    const r = await installFromMarket(proj, "o/m", ["demo"], { env: limited.env });
    expect(r.ok).toBe(true); expect(r.message).toContain("Added demo from demo-market (3 skills, 1 command, 1 helper)");
    expect(existsSync(join(proj, ".syok", "plugins", "demo", "scripts", "count.js"))).toBe(true);
    expect(existsSync(join(proj, ".syok", "plugins", "demo", "plain"))).toBe(false); expect(existsSync(join(proj, ".syok", "plugins", "plain"))).toBe(false);
    expect(limited.asked).toContain("/codeload/o/m/tar.gz/HEAD");
  } finally { limited.server.stop(true); }
  const neither = fakeGithub(marketFiles(), { limited: true, noArchive: true });
  try {
    const r = await installFromMarket(tmpProject({}), "o/m", ["demo"], { env: neither.env });
    expect(r.ok).toBe(false); expect(r.message).toContain("GITHUB_TOKEN");
  } finally { neither.server.stop(true); }
});

test("whole program: syok plugin add <marketplace> lists, installs, and syok plugin hooks switches hooks", async () => {
  const market = tmpProject(marketFiles()); const proj = tmpProject({ "a.txt": "x" });
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const go = (args: string[]) => new Promise<{ code: number | null; out: string }>((res) => { const p = spawn("bun", [main, ...args, "--cwd", proj], { cwd: proj, env: { ...process.env, HOME: proj, USERPROFILE: proj }, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; p.stdout.on("data", (x) => (out += x)); p.stderr.on("data", (x) => (out += x)); p.on("close", (code) => res({ code, out })); });
  const l = await go(["plugin", "add", market]); expect(l.code).toBe(0); expect(l.out).toContain("demo-market by tester: 4 plugins");
  const a = await go(["plugin", "add", market, "demo", "plain"]); expect(a.code).toBe(0); expect(a.out).toContain("Added demo"); expect(a.out).toContain("Added plain"); expect(a.out).toContain("syok plugin hooks demo on");
  const ls = await go(["plugin", "list"]); expect(ls.out).toContain("[hooks off: syok plugin hooks demo on]"); expect(ls.out).toContain("(from demo-market");
  const on = await go(["plugin", "hooks", "demo", "on"]); expect(on.out).toContain("ON");
  expect(listPlugins(proj, join(proj, ".nohome")).map((p) => p.name).sort()).toEqual(["demo", "plain"]);
}, 60000);

test("a single Claude Code plugin repository (no marketplace) is adopted the same way", async () => {
  const src = tmpProject({ ".claude-plugin/plugin.json": j({ name: "solo" }), "hooks/hooks.json": j({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo ok" }] }] } }), "skills/a/SKILL.md": "---\nname: a\ndescription: d\n---\nA" });
  const proj = tmpProject({ "a.txt": "x" });
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const out = await new Promise<string>((res) => { const p = spawn("bun", [main, "plugin", "add", src, "--cwd", proj], { cwd: proj, env: { ...process.env, HOME: proj, USERPROFILE: proj }, stdio: ["ignore", "pipe", "pipe"] }); let o = ""; p.stdout.on("data", (x) => (o += x)); p.stderr.on("data", (x) => (o += x)); p.on("close", () => res(o)); });
  expect(out).toContain("Added plugin solo (1 skill, 0 commands)"); expect(out).toContain("hooks and tool servers are OFF");
  expect(existsSync(join(proj, ".syok", "plugins", "solo", "claude-hooks.off.json"))).toBe(true);
}, 30000);

test("cc-skills conventions: cc-plugin-root, ~/.claude/plugins paths, {{skill_dir}}, ${ARGUMENTS:-x}, Claude tool names, plugins a plugin needs", async () => {
  const files = marketFiles();
  const mk = JSON.parse(files[".claude-plugin/marketplace.json"]); mk.plugins[1].requires = ["demo"]; mk.plugins[0].requires = ["helper-lib"];
  files[".claude-plugin/marketplace.json"] = j(mk);
  files["plugins/plain/skills/conv/SKILL.md"] = "---\nname: conv\ndescription: conventions\n---\nROOT=\"$(cc-plugin-root plain)\"\nbash $HOME/.claude/plugins/marketplaces/cc-skills/plugins/demo/scripts/x.sh\ncat ~/.claude/plugins/cache/cc-skills/plain/34.2.0/README.md\nbun {{skill_dir}}/run.ts\nACTION=\"${ARGUMENTS:-status}\"\nUse AskUserQuestion, then TodoWrite.\nLeave $(cc-plugin-root not-installed) alone.\n";
  const market = tmpProject(files); const proj = tmpProject({ "a.txt": "x" });
  const r = await installFromMarket(proj, market, ["demo", "plain"]);
  expect(r.message).toContain("It works together with helper-lib"); expect(r.message).not.toContain("works together with demo");
  const m = loadSkills(proj, join(proj, ".nohome")); const plain = join(proj, ".syok", "plugins", "plain"), demo = join(proj, ".syok", "plugins", "demo");
  const t = skillText(m.get("conv")!, "", proj);
  expect(t).toContain(`ROOT="${plain}"`); expect(t).toContain(`bash ${demo}/scripts/x.sh`); expect(t).toContain(`cat ${plain}/README.md`);
  expect(t).toContain(`bun ${join(plain, "skills", "conv")}/run.ts`); expect(t).toContain('ACTION="status"');
  expect(t).toContain("$(cc-plugin-root not-installed)"); expect(t).toContain("AskUserQuestion = ask the user in your reply");
  expect(skillText(m.get("conv")!, "install", proj)).toContain('ACTION="install"');
  expect(skillText(m.get("tidy")!, "", proj)).not.toContain("written for Claude Code"); // no Claude tool names: no note
});

test("commands the AI runs find cc-plugin-root and the plugins' bin folders; a background hook is not waited for", async () => {
  const files = { ...marketFiles(), "plugins/demo/bin/demo-tool": "#!/bin/sh\necho demo-tool-ran\n", "plugins/demo/bin/demo-tool.cmd": "@echo demo-tool-ran\r\n", "plugins/demo/bin/node": "#!/bin/sh\necho fake-node\n", "plugins/demo/bin/node.cmd": "@echo fake-node\r\n" };
  const market = tmpProject(files); const proj = tmpProject({ "a.txt": "x" });
  await installFromMarket(proj, market, ["demo"]);
  if (process.platform !== "win32") for (const f of ["demo-tool", "node"]) (await import("node:fs")).chmodSync(join(proj, ".syok", "plugins", "demo", "bin", f), 0o755);
  const ai = fakeAI([call("run_command", { command: "cc-plugin-root demo" }), call("run_command", { command: "demo-tool" }), call("run_command", { command: "node -e \"console.log(6*7)\"" }), call("finish", { summary: "ok" })]);
  await runAgent({ root: proj, task: "where", base: "http://fake", key: "k", mode: "auto", fetchImpl: ai.f, settings: { confine: false } as any });
  const tools = ai.seen[ai.seen.length - 1].messages.filter((x: any) => x.role === "tool").map((x: any) => x.content);
  expect(tools[0]).toContain(join(proj, ".syok", "plugins", "demo")); expect(tools[0]).toContain("[exit code 0]");
  expect(tools[1]).toContain("demo-tool-ran");
  expect(tools[2]).toContain("42"); expect(tools[2]).not.toContain("fake-node"); // a plugin cannot replace a command you already have
  const d = tmpProject({ "slow.js": "setTimeout(()=>{},4000)" });
  const t0 = Date.now();
  const res = await runHooks([{ claude: "*", command: "node slow.js", async: true, plugin: "p", pluginRoot: d }], "PostToolUse", { tool: "run_command", args: {} }, d, "run_command");
  expect(Date.now() - t0).toBeLessThan(2000); expect(res.block).toBe(false);
}, 30000);
