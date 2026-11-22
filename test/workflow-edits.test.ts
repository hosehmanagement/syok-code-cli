// Workflow-file edits (.github/workflows/*.yml): blocked unless YOU allow them (your own config or a flag for one run),
// asked every time, never from a project's settings, never in the cloud @syok job, never loosening the other protected paths.
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeCtx, runTool } from "../src/tools.ts";
import { runAgent, SYSTEM, SYSTEM_GENERAL } from "../src/agent.ts";
import { DEFAULT } from "../src/profiles.ts";
import { workflowRule, editBlocked, WORKFLOW_WARNING, type Mode } from "../src/perm.ts";
import { cleanDefaults, applyDefaults, workflowEdits, describeDefaults } from "../src/setup.ts";
import { tmpProject, call } from "./helpers.ts";

const WF = ".github/workflows/ci.yml";
const OLD = "on: push\njobs: {}\n";
function mk(mode: Mode, answer = true, settings: any = {}) {
  const d = tmpProject({ [WF]: OLD, ".env": "A=1", "a.txt": "x" }); const asked: Array<{ what: string; detail: string }> = [];
  const c = makeCtx(d, mode, async (what, detail) => { asked.push({ what, detail }); return answer; }, settings, DEFAULT);
  return { d, c, asked, wf: () => readFileSync(join(d, WF), "utf8") };
}
const write = (c: any, path = WF, content = "on: pull_request\n") => runTool(c, "write_file", { path, content });

test("by default workflow files are blocked in every mode, and nobody is asked", async () => {
  for (const mode of ["ask", "accept-edits", "auto", "plan"] as Mode[]) {
    const { c, asked, wf } = mk(mode);
    const r = await write(c); expect(r).toContain("protected"); expect(r).toContain("allow_workflow_edits"); expect(r).toContain("--allow-workflow-edits");
    expect(await runTool(c, "edit_file", { path: WF, old_text: "push", new_text: "pull_request" })).toContain("protected");
    expect(asked).toEqual([]); expect(wf()).toBe(OLD);
  }
  // also a new workflow file, a .yaml one, and other spellings of the folder (Mac and Windows folders ignore case)
  const { c } = mk("auto");
  for (const p of [".github/workflows/new.yaml", ".GitHub/Workflows/x.yml", "sub/.github/workflows/y.yml"]) expect(await write(c, p)).toContain("protected");
});

test("a project's .syok/settings.json cannot switch workflow edits on", async () => {
  // straight into the tools: the setting in the project's settings is ignored
  const { c, asked, wf } = mk("auto", true, { allow_workflow_edits: true });
  expect(await write(c)).toContain("protected"); expect(asked).toEqual([]); expect(wf()).toBe(OLD);
  // through the merge with your defaults: the project's key is dropped, whatever your own choice
  expect("allow_workflow_edits" in applyDefaults({ allow_workflow_edits: true } as any, {})).toBe(false);
  expect("allow_workflow_edits" in applyDefaults({ allow_workflow_edits: true } as any, { allow_workflow_edits: false })).toBe(false);
  // the allowance is built from your own defaults and the flag only; there is no project input at all
  expect(workflowEdits(cleanDefaults({}), { env: {} })).toEqual({ config: false, flag: false, cloud: false });
  expect(workflowEdits(cleanDefaults({ allow_workflow_edits: "yes" }), { env: {} }).config).toBe(false); // only a real true counts
  expect(workflowEdits(cleanDefaults({ allow_workflow_edits: true }), { env: {} }).config).toBe(true);
});

test("switched on in your config: every edit is asked, with the warning and the diff, in ask and accept-edits", async () => {
  for (const mode of ["ask", "accept-edits"] as Mode[]) {
    const no = mk(mode, false); no.c.workflowEdits = workflowEdits({ allow_workflow_edits: true }, { env: {} });
    expect(await write(no.c)).toContain("did not allow"); expect(no.wf()).toBe(OLD);
    expect(no.asked.length).toBe(1); expect(no.asked[0].what).toBe("edit " + WF);
    expect(no.asked[0].detail.split("\n")[0]).toBe(WORKFLOW_WARNING);
    expect(WORKFLOW_WARNING).toContain("this file controls what runs in your GitHub Actions and can read your repository secrets");
    expect(no.asked[0].detail).toContain("-on: push"); expect(no.asked[0].detail).toContain("+on: pull_request");

    const yes = mk(mode, true); yes.c.workflowEdits = workflowEdits({ allow_workflow_edits: true }, { env: {} });
    expect(await runTool(yes.c, "edit_file", { path: WF, old_text: "push", new_text: "pull_request" })).toContain("Edited " + WF);
    expect(yes.wf()).toContain("on: pull_request"); expect(yes.asked.length).toBe(1);
    expect(await write(yes.c, ".github/workflows/new.yml", "on: push\n")).toContain("Wrote"); expect(yes.asked.length).toBe(2); // each edit asked again
    expect(yes.asked[1].detail).toContain(WORKFLOW_WARNING);
  }
  // accept-edits still edits ordinary files without asking
  const ae = mk("accept-edits"); ae.c.workflowEdits = { config: true };
  expect(await write(ae.c, "a.txt", "y")).toContain("Wrote"); expect(ae.asked).toEqual([]);
  // the flag alone (no saved setting) also means asked, outside auto
  const fl = mk("ask", false); fl.c.workflowEdits = { flag: true };
  expect(await write(fl.c)).toContain("did not allow"); expect(fl.asked[0].detail).toContain(WORKFLOW_WARNING);
});

test("auto mode: refused with the saved setting alone, allowed only with the flag for this run", async () => {
  const cfg = mk("auto"); cfg.c.workflowEdits = workflowEdits({ allow_workflow_edits: true }, { env: {} });
  const r = await write(cfg.c); expect(r).toContain("protected"); expect(r).toContain("--allow-workflow-edits"); expect(cfg.wf()).toBe(OLD);

  const flag = mk("auto"); flag.c.workflowEdits = workflowEdits({}, { flag: true, env: {} });
  expect(await write(flag.c)).toContain("Wrote " + WF); expect(flag.wf()).toBe("on: pull_request\n"); expect(flag.asked).toEqual([]);
  // the mode can change in chat (/mode auto): the rule follows the mode at the moment of the edit
  const later = mk("ask"); later.c.workflowEdits = { config: true }; later.c.mode = "auto";
  expect(await write(later.c)).toContain("protected");
  // plan mode never edits
  expect(workflowRule("plan", { config: true, flag: true }, WF)).toMatchObject({ ok: false });
});

test("the cloud @syok job never edits workflow files, whatever the flag or the config", async () => {
  const env = { GITHUB_ACTIONS: "true" };
  expect(workflowEdits({ allow_workflow_edits: true }, { flag: true, env }).cloud).toBe(true);
  for (const mode of ["auto", "ask", "accept-edits"] as Mode[]) {
    const { c, asked, wf } = mk(mode); c.workflowEdits = workflowEdits({ allow_workflow_edits: true }, { flag: true, env });
    const r = await write(c); expect(r).toContain("protected"); expect(r).toContain("cloud @syok job"); expect(asked).toEqual([]); expect(wf()).toBe(OLD);
  }
  // what the action path sets (src/main.ts, "syok action")
  const { c } = mk("auto"); c.workflowEdits = { cloud: true, config: true, flag: true };
  expect(await write(c)).toContain("protected");
  expect(editBlocked("auto", { cloud: true }, WF)).toContain("cloud");
});

test("switched on: .env, .git, keys and other files in the workflows folder stay blocked", async () => {
  const { c, d, asked } = mk("auto"); c.workflowEdits = { config: true, flag: true };
  for (const p of [".env", ".env.local", ".git/config", "id_rsa", "certs/server.pem", "deploy.key", ".github/workflows/run.sh", ".github/workflows/sub/x.yml"]) expect(await write(c, p, "x")).toContain("protected");
  expect(readFileSync(join(d, ".env"), "utf8")).toBe("A=1"); expect(asked).toEqual([]);
  expect(await runTool(c, "edit_file", { path: ".env", old_text: "A=1", new_text: "A=2" })).toContain("protected");
  // a secret in a workflow is still refused
  expect(await write(c, WF, "env:\n  T: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n")).toContain("secret");
});

// A parent agent that delegates to a worker, which tries to write a workflow file.
function delegating(d: string) {
  const f = (async (_u: any, o: any) => {
    const req = JSON.parse(o.body); const child = String(req.messages[0].content).startsWith("You are a focused helper");
    const n = req.messages.filter((m: any) => m.role === "tool").length;
    const msg = child ? (n === 0 ? call("write_file", { path: WF, content: "on: workflow_dispatch\n" }) : call("finish", { summary: "worker done" }))
      : (n === 0 ? call("delegate", { task: "change the workflow", role: "worker" }) : call("finish", { summary: "parent done" }));
    return new Response(JSON.stringify({ choices: [{ message: msg }], usage: { total_tokens: 1 } }));
  }) as any;
  return f;
}
test("sub-agent workers get workflow edits only when the parent was allowed them", async () => {
  const blocked = mk("auto");
  const r1 = await runAgent({ root: blocked.d, task: "t", base: "http://x", key: "k", mode: "auto", fetchImpl: delegating(blocked.d), ctx: blocked.c, profile: { ...DEFAULT, nudgeTests: false } });
  expect(r1.summary).toBe("parent done"); expect(blocked.wf()).toBe(OLD);

  const allowed = mk("auto"); allowed.c.workflowEdits = { flag: true };
  await runAgent({ root: allowed.d, task: "t", base: "http://x", key: "k", mode: "auto", fetchImpl: delegating(allowed.d), ctx: allowed.c, profile: { ...DEFAULT, nudgeTests: false } });
  expect(allowed.wf()).toBe("on: workflow_dispatch\n");

  const asking = mk("ask", true); asking.c.workflowEdits = { config: true };
  await runAgent({ root: asking.d, task: "t", base: "http://x", key: "k", mode: "ask", fetchImpl: delegating(asking.d), ctx: asking.c, profile: { ...DEFAULT, nudgeTests: false } });
  expect(asking.asked.some((a) => a.what === "edit " + WF && a.detail.includes(WORKFLOW_WARNING))).toBe(true);
  // a fresh context (as a parallel worker starts with) has no allowance of its own
  expect(makeCtx(tmpProject({}), "auto", async () => true, {}, DEFAULT).workflowEdits).toBeUndefined();
});

test("the agent's rule 5 says what really happens", () => {
  for (const s of [SYSTEM, SYSTEM_GENERAL]) {
    expect(s).toContain("5. Never write secrets, tokens or keys into files. Do not touch .git, .env or key files.");
    expect(s).toContain("Files in .github/workflows are blocked unless the user switched on workflow edits");
    expect(s).toContain("the user approves each edit");
    expect(s).not.toContain("Do not touch .git, .env or .github/workflows.");
  }
});

test("syok setup --show tells whether workflow edits are on", () => {
  expect(describeDefaults({ defaults: {} }, {}, "/h")).toContain("Workflow file edits   off");
  expect(describeDefaults({ defaults: { allow_workflow_edits: true } }, {}, "/h")).toContain("Workflow file edits   on: asked before every edit");
  expect(describeDefaults({}, {}, "/h")).toContain("or switch workflow edits on");
});

// ---- the whole program: the flag, your config, a project's settings and GitHub Actions, as really wired in src/main.ts ----
test("whole program: only your config or the flag opens workflow edits; auto needs the flag; a project and GitHub Actions cannot", async () => {
  const { spawn } = await import("node:child_process"); const { writeFileSync, mkdirSync } = await import("node:fs");
  const main = join(import.meta.dir, "..", "src", "main.ts");
  const ai = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const b: any = await req.json().catch(() => ({})); const n = (b.messages || []).filter((m: any) => m.role === "tool").length;
    const msg = n === 0 ? call("write_file", { path: WF, content: "on: workflow_dispatch\n" }) : call("finish", { summary: "done" });
    return Response.json({ choices: [{ message: msg }], usage: { total_tokens: 1 } });
  } });
  const run = (home: string, args: string[], env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>((res) => {
    const e: any = { ...process.env, HOME: home, USERPROFILE: home, SYOK_BASE_URL: `http://127.0.0.1:${ai.port}`, SYOK_API_KEY: "syk_wf_test", ...env }; if (!("GITHUB_ACTIONS" in env)) delete e.GITHUB_ACTIONS;
    const p = spawn("bun", [main, "-p", "change the workflow", "--json", "--no-stream", "--no-confine", "--no-checks", ...args], { cwd: home, env: e, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d)); p.on("close", (code) => res({ code, out, err }));
  });
  const project = (cfg: any, settings?: any) => { const h = tmpProject({ [WF]: OLD, ".syok/config.json": JSON.stringify({ defaults: cfg }) }); if (settings) { mkdirSync(join(h, ".syok"), { recursive: true }); writeFileSync(join(h, ".syok", "settings.json"), JSON.stringify(settings)); } return h; };
  const wf = (h: string) => readFileSync(join(h, WF), "utf8");
  try {
    let h = project({}); await run(h, ["--mode", "auto"]); expect(wf(h)).toBe(OLD);                                      // default: blocked
    h = project({}, { allow_workflow_edits: true }); await run(h, ["--mode", "auto"]); expect(wf(h)).toBe(OLD);          // a project cannot
    h = project({ allow_workflow_edits: true }); await run(h, ["--mode", "auto"]); expect(wf(h)).toBe(OLD);               // auto: config alone is not enough
    h = project({ allow_workflow_edits: true }); await run(h, ["--mode", "accept-edits"]); expect(wf(h)).toBe(OLD);       // asked; no terminal here, so the answer is no
    h = project({}); const r = await run(h, ["--mode", "auto", "--allow-workflow-edits"]); expect(r.code).toBe(0); expect(wf(h)).toBe("on: workflow_dispatch\n"); // auto + flag
    h = project({ allow_workflow_edits: true }); const g = await run(h, ["--mode", "auto", "--allow-workflow-edits"], { GITHUB_ACTIONS: "true" }); expect(wf(h)).toBe(OLD); // GitHub Actions: never
    expect(g.err).toContain("ignored inside GitHub Actions");
  } finally { ai.stop(true); }
}, 120000);
