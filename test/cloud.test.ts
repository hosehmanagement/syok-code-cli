// Each test makes real git repositories, which is slow on Windows runners, so each gets a minute (not the default 5 seconds).
// /cloud: handing work to GitHub's cloud. Real git with a real (local) remote; only gh is a stand-in, because it talks to github.com.
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendToCloud } from "../src/cloud.ts";
import { realRun, type Run } from "../src/pr.ts";
import { tmpProject, tmpDir } from "./helpers.ts";

const git = (cwd: string, ...a: string[]) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...a], { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error("git " + a.join(" ") + ": " + r.stderr); return r.stdout.trim(); };
function setup(o: { workflow?: boolean; gh?: (args: string[]) => { code: number; out: string } | undefined } = {}) {
  const remote = tmpDir("remote-"); git(remote, "init", "-q", "--bare");
  const work = tmpProject({ "a.js": "module.exports = 1;\n", ".gitignore": "node_modules\n" }); git(work, "init", "-q"); git(work, "add", "-A"); git(work, "commit", "-qm", "first"); git(work, "branch", "-M", "main"); git(work, "remote", "add", "origin", remote); git(work, "push", "-q", "-u", "origin", "main");
  const gh: string[][] = []; const bodies: Record<string, string> = {}; const asked: { what: string; detail: string }[] = [];
  const run: Run = (cmd, args, cwd) => {
    if (cmd !== "gh") return realRun(cmd, args, cwd);
    gh.push(args); const i = args.indexOf("--body-file"); if (i >= 0) bodies[args[0] + " " + args[1]] = readFileSync(args[i + 1], "utf8");
    const custom = o.gh?.(args); if (custom) return custom;
    if (args[0] === "--version") return { code: 0, out: "gh version 2" };
    if (args[0] === "repo" && args[1] === "view") return { code: 0, out: "me/app main\n" };
    if (args[0] === "api") return o.workflow === false ? { code: 1, out: "HTTP 404" } : { code: 0, out: ".github/workflows/syok.yml" };
    if (args[0] === "pr" && args[1] === "view") return { code: 1, out: "no pull requests found" };
    if (args[0] === "pr" && args[1] === "create") return { code: 0, out: "https://github.com/me/app/pull/7\n" };
    if (args[0] === "pr" && args[1] === "comment") return { code: 0, out: "https://github.com/me/app/pull/7#issuecomment-1\n" };
    if (args[0] === "issue" && args[1] === "create") return { code: 0, out: "https://github.com/me/app/issues/8\n" };
    return { code: 0, out: "" };
  };
  const go = (task: string, yes = true, notes?: string) => sendToCloud({ task, notes, run, cwd: work, approve: async (what, detail) => { asked.push({ what, detail }); return yes; } });
  const remoteBranches = () => git(remote, "branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort();
  return { remote, work, gh, bodies, asked, go, remoteBranches };
}

test("uncommitted work: asked first, pushed to a new branch as one commit, draft pull request opened, and the comment starts the cloud job", async () => {
  const s = setup(); writeFileSync(join(s.work, "a.js"), "module.exports = 2;\n"); writeFileSync(join(s.work, "new.js"), "// new\n"); writeFileSync(join(s.work, ".env"), "SECRET=1\n");
  const r = await s.go("finish the tests and fix what fails", true, "Changed the value to 2. Tests not run yet.");
  expect(r.ok).toBe(true); expect(r.kind).toBe("pull request"); expect(r.url).toBe("https://github.com/me/app/pull/7"); expect(r.branch).toMatch(/^syok\/cloud-finish-the-tests-and-fix-what-[a-z0-9]+$/);
  expect(s.asked.length).toBe(1); expect(s.asked[0].what).toContain("push your uncommitted changes (as one commit) to the branch " + r.branch + " of me/app"); expect(s.asked[0].detail).toContain("a.js");
  expect(s.remoteBranches()).toEqual(["main", r.branch!]);
  const files = git(s.remote, "show", "--stat", "--format=%s", r.branch!); expect(files).toContain("Work in progress, handed to the cloud: finish the tests"); expect(files).toContain("a.js"); expect(files).toContain("new.js"); expect(files).not.toContain(".env");
  expect(git(s.remote, "show", r.branch + ":a.js")).toBe("module.exports = 2;"); expect(git(s.work, "branch", "--show-current")).toBe(r.branch!);
  const create = s.gh.find((a) => a[0] === "pr" && a[1] === "create")!; expect(create).toContain("--draft"); expect(create.slice(create.indexOf("--base"), create.indexOf("--base") + 4)).toEqual(["--base", "main", "--head", r.branch!]);
  const c = s.bodies["pr comment"]; expect(c.startsWith("@syok finish the tests and fix what fails\n")).toBe(true); expect(c).toContain("Continue the work on this pull request's branch."); expect(c).toContain("Notes from the session on my computer:\nChanged the value to 2. Tests not run yet.");
  expect(s.gh.find((a) => a[0] === "pr" && a[1] === "comment")![2]).toBe("https://github.com/me/app/pull/7");
  expect(r.message).toContain("git pull");
}, 60000);

test("saying no pushes nothing and changes nothing", async () => {
  const s = setup(); writeFileSync(join(s.work, "a.js"), "module.exports = 2;\n");
  const r = await s.go("do it", false);
  expect(r.ok).toBe(false); expect(r.message).toContain("Nothing was pushed"); expect(s.remoteBranches()).toEqual(["main"]); expect(git(s.work, "branch", "--show-current")).toBe("main"); expect(git(s.work, "status", "--porcelain")).toContain("a.js");
  expect(s.gh.some((a) => a[0] === "pr" || a[0] === "issue")).toBe(false);
}, 60000);

test("a key in the changes stops everything before the push, and the work is left as it was", async () => {
  const s = setup(); writeFileSync(join(s.work, "config.js"), 'const k = "ghp_' + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4" + '";\n');
  const r = await s.go("deploy it");
  expect(r.ok).toBe(false); expect(r.message).toContain("looks like a key or token"); expect(s.remoteBranches()).toEqual(["main"]);
  expect(git(s.work, "branch", "--show-current")).toBe("main"); expect(git(s.work, "branch", "--format=%(refname:short)")).toBe("main"); expect(git(s.work, "status", "--porcelain")).toContain("?? config.js");
}, 60000);

test("nothing local to send: an issue is opened instead, and nothing is pushed", async () => {
  const s = setup(); const r = await s.go("add a README\nwith install steps");
  expect(r.ok).toBe(true); expect(r.kind).toBe("issue"); expect(r.url).toBe("https://github.com/me/app/issues/8"); expect(s.remoteBranches()).toEqual(["main"]);
  const issue = s.gh.find((a) => a[0] === "issue")!; expect(issue[issue.indexOf("--title") + 1]).toBe("add a README"); expect(s.bodies["issue create"].startsWith("@syok add a README\nwith install steps\n")).toBe(true);
  expect(s.asked[0].what).toContain("open an issue in me/app");
}, 60000);

test("commits GitHub does not have yet are sent too; on your own branch that branch is used; an open pull request is reused", async () => {
  const s = setup({ gh: (a) => a[0] === "pr" && a[1] === "view" ? { code: 0, out: "OPEN https://github.com/me/app/pull/3\n" } : undefined });
  git(s.work, "checkout", "-q", "-b", "feature/x"); writeFileSync(join(s.work, "b.js"), "1\n"); git(s.work, "add", "-A"); git(s.work, "commit", "-qm", "local commit");
  const r = await s.go("review and finish");
  expect(r.ok).toBe(true); expect(r.branch).toBe("feature/x"); expect(s.asked[0].what).toContain("1 commit GitHub does not have yet"); expect(s.remoteBranches()).toEqual(["feature/x", "main"]);
  expect(s.gh.some((a) => a[0] === "pr" && a[1] === "create")).toBe(false); expect(s.gh.find((a) => a[0] === "pr" && a[1] === "comment")![2]).toBe("https://github.com/me/app/pull/3");
}, 60000);

test("only never-sent files changed: nothing is pushed and the temporary branch is removed", async () => {
  const s = setup(); writeFileSync(join(s.work, ".env"), "SECRET=1\n");
  const r = await s.go("do it");
  expect(r.ok).toBe(false); expect(r.message).toContain("never sent"); expect(s.remoteBranches()).toEqual(["main"]); expect(git(s.work, "branch", "--format=%(refname:short)")).toBe("main");
}, 60000);

test("each missing piece is named with what to do: no task, no git, no gh, not on GitHub, the job not set up", async () => {
  const s = setup(); expect((await s.go("  ")).message).toContain("Say what the cloud should do");
  const plain = tmpProject({ "a.txt": "x" });
  expect((await sendToCloud({ task: "x", run: realRun, cwd: plain, approve: async () => true })).message).toContain("not a git project");
  const noGh = setup({ gh: (a) => a[0] === "--version" ? { code: 127, out: "not found" } : undefined }); expect((await noGh.go("x")).message).toContain("https://cli.github.com");
  const noRepo = setup({ gh: (a) => a[0] === "repo" ? { code: 1, out: "no git remotes found" } : undefined }); expect((await noRepo.go("x")).message).toContain("Could not read this project on GitHub");
  const noJob = setup({ workflow: false }); writeFileSync(join(noJob.work, "a.js"), "2\n"); const r = await noJob.go("x");
  expect(r.message).toContain('The "@syok" job is not set up in me/app yet'); expect(r.message).toContain("syok github-action"); expect(noJob.asked.length).toBe(0); expect(noJob.remoteBranches()).toEqual(["main"]);
}, 60000);

test("a failed pull request or comment is reported with what did happen, never as success", async () => {
  const a = setup({ gh: (x) => x[0] === "pr" && x[1] === "create" ? { code: 1, out: "GraphQL: not allowed" } : undefined }); writeFileSync(join(a.work, "a.js"), "2\n");
  const ra = await a.go("x"); expect(ra.ok).toBe(false); expect(ra.message).toContain("was pushed, but the pull request could not be opened"); expect(a.remoteBranches().length).toBe(2);
  const b = setup({ gh: (x) => x[0] === "pr" && x[1] === "comment" ? { code: 1, out: "boom" } : undefined }); writeFileSync(join(b.work, "a.js"), "2\n");
  const rb = await b.go("fix it"); expect(rb.ok).toBe(false); expect(rb.message).toContain("could not be posted"); expect(rb.message).toContain('"@syok fix it"');
}, 60000);
