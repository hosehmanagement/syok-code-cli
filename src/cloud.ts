// "/cloud <what to do>" and "syok cloud <what to do>": hand the work over to GitHub's cloud and carry on there.
// It reuses the "@syok" GitHub job (see: syok github-action). Nothing new runs anywhere and Syok hosts nothing.
// - With local work (changed files, or commits GitHub does not have yet): the work goes to a new branch, a draft pull
//   request is opened, and a comment "@syok <what to do>" starts the job, which commits to that pull request.
// - With nothing local to send: an issue "@syok <what to do>" is opened, and the job opens a pull request itself.
// You are asked before anything is pushed. The pushed work is checked for keys first.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slug, type Run, type Approve } from "./pr.ts";
import { SECRET_LIKE } from "./perm.ts";
import { WORKFLOW_PATH } from "./action.ts";

export interface CloudResult { ok: boolean; message: string; url?: string; kind?: "pull request" | "issue"; branch?: string }
const EXCLUDE = [":(exclude).env", ":(exclude).env.*", ":(exclude)*.pem", ":(exclude)*.key", ":(exclude).syok/sessions", ":(exclude).syok/jobs", ":(exclude).syok/remote"];
const GIT_ID = ["-c", "user.name=Syok Code", "-c", "user.email=syok-code@users.noreply.github.com"];
const rand = () => Math.random().toString(36).slice(2, 6);

export async function sendToCloud(o: { task: string; notes?: string; run: Run; cwd: string; approve: Approve; trigger?: string }): Promise<CloudResult> {
  const { run, cwd } = o; const trigger = o.trigger || "@syok";
  const task = o.task.trim(); if (!task) return { ok: false, message: "Say what the cloud should do, for example: /cloud finish the tests and fix what fails" };
  const fail = (message: string): CloudResult => ({ ok: false, message });
  if (run("git", ["rev-parse", "--is-inside-work-tree"], cwd).code) return fail("This folder is not a git project, so there is nothing to hand over. /cloud needs a project that is on GitHub.");
  if (run("gh", ["--version"], cwd).code) return fail("/cloud needs GitHub's program gh. Install it from https://cli.github.com and sign in with: gh auth login");
  const repo = run("gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef", "--jq", ".nameWithOwner + \" \" + .defaultBranchRef.name"], cwd);
  if (repo.code) return fail("Could not read this project on GitHub (is it pushed there, and are you signed in to gh?): " + repo.out.slice(0, 200));
  const [name, base] = repo.out.trim().split(/\s+/); if (!name || !base) return fail("Could not tell which GitHub repository this is.");
  // The job only exists if its workflow file is on the main branch of the repository on GitHub.
  if (run("gh", ["api", `repos/${name}/contents/${WORKFLOW_PATH}?ref=${base}`, "--jq", ".path"], cwd).code) return fail(`The "${trigger}" job is not set up in ${name} yet. One-time setup: run "syok github-action", commit and push the file it writes to ${base}, and add the two secrets it names. Then try /cloud again.`);

  const status = run("git", ["status", "--porcelain"], cwd); if (status.code) return fail("git failed: " + status.out.slice(0, 200));
  const dirty = !!status.out.trim();
  run("git", ["fetch", "-q", "origin", base], cwd);
  const ahead = run("git", ["rev-list", "--count", `origin/${base}..HEAD`], cwd); const commitsAhead = ahead.code ? 0 : +ahead.out.trim() || 0;
  const body = (extra: string) => `${trigger} ${task}\n\n${extra}${o.notes ? "Notes from the session on my computer:\n" + o.notes.trim().slice(0, 3000) + "\n\n" : ""}Sent with Syok Code (/cloud).`;
  const withBody = (text: string, f: (file: string) => { code: number; out: string }) => { const d = mkdtempSync(join(tmpdir(), "syok-cloud-")); try { const file = join(d, "body.md"); writeFileSync(file, text); return f(file); } finally { rmSync(d, { recursive: true, force: true }); } };

  if (!dirty && !commitsAhead) {
    if (!(await o.approve(`open an issue in ${name} that asks the cloud to: ${task.slice(0, 200)}`, "There is no local work to send, so the cloud starts from the " + base + " branch on GitHub and opens a pull request with its result."))) return fail("Not done: you did not approve.");
    const r = withBody(body(""), (file) => run("gh", ["issue", "create", "--title", task.split("\n")[0].slice(0, 80), "--body-file", file], cwd));
    if (r.code) return fail("Could not open the issue: " + r.out.slice(0, 300));
    const url = (r.out.match(/https:\/\/\S+/) || [""])[0];
    return { ok: true, kind: "issue", url, message: `Handed over. The cloud job starts from this issue: ${url || r.out.trim()}\nIt will open a pull request with its result. Watch it under the Actions tab of ${name}.` };
  }

  const cur = run("git", ["branch", "--show-current"], cwd).out.trim();
  const onBase = !cur || cur === base || /^(main|master|trunk|develop)$/.test(cur);
  const branch = onBase ? `syok/cloud-${slug(task).slice(0, 30).replace(/-+$/, "")}-${rand()}` : cur;
  const what = [dirty ? "your uncommitted changes (as one commit)" : "", commitsAhead ? `${commitsAhead} commit${commitsAhead === 1 ? "" : "s"} GitHub does not have yet` : ""].filter(Boolean).join(" and ");
  if (!(await o.approve(`push ${what} to the branch ${branch} of ${name}, open a draft pull request, and ask the cloud to: ${task.slice(0, 200)}`, (status.out.trim() || "(no uncommitted changes)").slice(0, 1500)))) return fail("Not done: you did not approve. Nothing was pushed.");
  if (onBase) { const c = run("git", ["checkout", "-q", "-b", branch], cwd); if (c.code) return fail("Could not create the branch " + branch + ": " + c.out.slice(0, 200)); }
  const undoBranch = () => { if (onBase) { run("git", ["checkout", "-q", cur || base], cwd); run("git", ["branch", "-D", branch], cwd); } };
  if (dirty) {
    const add = run("git", ["add", "-A", "--", ".", ...EXCLUDE], cwd); if (add.code) { run("git", ["reset", "-q"], cwd); undoBranch(); return fail("git add failed: " + add.out.slice(0, 200)); }
    const staged = run("git", ["diff", "--cached", "--no-color", "-U0"], cwd);
    const leak = staged.out.split("\n").find((l) => l.startsWith("+") && !l.startsWith("+++") && SECRET_LIKE.test(l));
    if (leak) { run("git", ["reset", "-q"], cwd); undoBranch(); return fail("Stopped: your changes contain something that looks like a key or token, so nothing was pushed. Remove it from the files (keys belong in .env, which is never sent), then try again."); }
    if (run("git", ["diff", "--cached", "--quiet"], cwd).code) { const cm = run("git", [...GIT_ID, "commit", "-q", "-m", "Work in progress, handed to the cloud: " + task.split("\n")[0].slice(0, 60)], cwd); if (cm.code) { run("git", ["reset", "-q"], cwd); undoBranch(); return fail("git commit failed: " + cm.out.slice(0, 300)); } }
  }
  if (!(+run("git", ["rev-list", "--count", `origin/${base}..HEAD`], cwd).out.trim() > 0)) { undoBranch(); return fail("There is nothing to send: your changes are only in files that are never sent (.env, keys, Syok's own session files)."); }
  const push = run("git", ["push", "-q", "-u", "origin", branch], cwd);
  if (push.code) return fail(`Your work is committed on the local branch ${branch}, but the push failed: ${push.out.slice(0, 300)}`);
  let url = "";
  const existing = run("gh", ["pr", "view", branch, "--json", "url,state", "--jq", ".state + \" \" + .url"], cwd);
  if (!existing.code && existing.out.startsWith("OPEN ")) url = existing.out.trim().slice(5);
  else {
    const pr = withBody("Work handed over from my computer with Syok Code (/cloud). The cloud job continues it below.", (file) => run("gh", ["pr", "create", "--draft", "--base", base, "--head", branch, "--title", task.split("\n")[0].slice(0, 80), "--body-file", file], cwd));
    if (pr.code) return { ok: false, branch, message: `The branch ${branch} was pushed, but the pull request could not be opened: ${pr.out.slice(0, 300)}` };
    url = (pr.out.match(/https:\/\/\S+/) || [""])[0];
  }
  const cm = withBody(body("Continue the work on this pull request's branch.\n\n"), (file) => run("gh", ["pr", "comment", url || branch, "--body-file", file], cwd));
  if (cm.code) return { ok: false, branch, url, message: `The pull request is open (${url}), but the comment that starts the cloud job could not be posted: ${cm.out.slice(0, 300)}\nYou can start it yourself by writing "${trigger} ${task.split("\n")[0].slice(0, 80)}" as a comment there.` };
  return { ok: true, kind: "pull request", url, branch, message: `Handed over. The cloud job continues on this pull request: ${url}\nYou are now on the branch ${branch}. When the job is done (see the Actions tab of ${name}), get its work with: git pull` };
}
