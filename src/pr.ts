import { spawnSync } from "node:child_process";

export type Run = (cmd: string, args: string[], cwd: string) => { code: number; out: string };
export const realRun: Run = (cmd, args, cwd) => {
  const env: Record<string, string | undefined> = { ...process.env }; delete env.SYOK_API_KEY;
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 120_000, env: env as any });
  return { code: r.status ?? 1, out: ((r.stdout || "") + (r.stderr || "") + (r.error ? String(r.error.message) : "")).trim() };
};
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "change";

/** The job for a read-only reviewer: the pull request text and diff, read through the GitHub command line (gh). */
export function reviewTask(ref: string, run: Run, cwd: string): { task?: string; error?: string } {
  const info = run("gh", ["pr", "view", ref, "--json", "title,body,baseRefName,headRefName,files"], cwd);
  if (info.code) return { error: "Could not read the pull request with gh: " + info.out.slice(0, 300) };
  const diff = run("gh", ["pr", "diff", ref], cwd);
  if (diff.code) return { error: "Could not read the diff with gh: " + diff.out.slice(0, 300) };
  return { task: "Review this pull request. Find real bugs, missing error handling, security problems, missing tests and unclear code. For each finding give the file and line, why it matters and a concrete fix. Skip style nitpicks. If it is fine, say so briefly. You may read the project files for context; change nothing.\n\nPull request:\n" + info.out.slice(0, 6000) + "\n\nDiff:\n" + diff.out.slice(0, 60000) };
}
export type Approve = (what: string, detail: string) => Promise<boolean>;
/** Commit the current changes on a new branch, push it and open a pull request. Never forces, never touches secrets files. */
export async function openPr(title: string, run: Run, cwd: string, approve: Approve): Promise<{ ok: boolean; message: string; url?: string }> {
  const st = run("git", ["status", "--porcelain"], cwd);
  if (st.code) return { ok: false, message: "This folder is not a git repository (or git failed): " + st.out.slice(0, 200) };
  if (!st.out.trim()) return { ok: false, message: "Nothing to commit: there are no changes." };
  const cur = run("git", ["branch", "--show-current"], cwd).out.trim();
  const branch = /^(main|master|trunk|develop)?$/.test(cur) ? "syok/" + slug(title) : cur;
  if (!(await approve("commit, push and open a pull request on branch " + branch, st.out.slice(0, 1500)))) return { ok: false, message: "Not done: you did not approve." };
  const steps: Array<[string, string[]]> = [];
  if (branch !== cur) steps.push(["git", ["checkout", "-b", branch]]);
  steps.push(["git", ["add", "-A", "--", ".", ":(exclude).env", ":(exclude).env.*", ":(exclude)*.pem", ":(exclude)*.key"]]);
  steps.push(["git", ["commit", "-m", title]]);
  steps.push(["git", ["push", "-u", "origin", branch]]);
  for (const [c, a] of steps) { const r = run(c, a, cwd); if (r.code) return { ok: false, message: "Stopped at: " + c + " " + a.slice(0, 2).join(" ") + "\n" + r.out.slice(0, 400) }; }
  const pr = run("gh", ["pr", "create", "--title", title, "--body", "Opened with Syok Code."], cwd);
  if (pr.code) return { ok: false, message: "The branch " + branch + " was pushed, but the pull request failed: " + pr.out.slice(0, 300) };
  const url = (pr.out.match(/https:\/\/\S+/) || [""])[0];
  return { ok: true, url, message: "Pull request opened: " + (url || pr.out) };
}
