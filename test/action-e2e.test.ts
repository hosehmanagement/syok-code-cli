// The whole "syok action" path with the real one-file program, as the workflow runs it: a real event file, a real git remote,
// a stand-in AI server and a stand-in "gh" program on the PATH that records what it was asked to do.
import { test, expect, beforeAll } from "bun:test";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmpProject, call } from "./helpers.ts";
import { planConfine, probeConfine } from "../src/confine.ts";

const unix = process.platform !== "win32";
const bundle = join(mkdtempSync(join(tmpdir(), "syok-act-")), "syok.js");
beforeAll(() => { const r = spawnSync("bun", ["build", join(import.meta.dir, "..", "src", "main.ts"), "--target=bun", "--minify", "--outfile", bundle], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); }, 120000);
const git = (cwd: string, ...a: string[]) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

test.if(unix)("a real run: comment in, AI edits a file, branch pushed, pull request asked for, answer posted; the AI's commands see no token", async () => {
  const remote = mkdtempSync(join(tmpdir(), "remote-")); git(remote, "init", "-q", "--bare");
  const work = tmpProject({ "a.js": "module.exports = 1;\n" }); git(work, "init", "-q"); git(work, "add", "-A"); git(work, "commit", "-qm", "first"); git(work, "branch", "-M", "main"); git(work, "remote", "add", "origin", remote); git(work, "push", "-q", "-u", "origin", "main");
  const tools = mkdtempSync(join(tmpdir(), "fakegh-")); const record = join(tools, "calls.log"); const bodies = join(tools, "bodies");
  mkdirSync(bodies);
  writeFileSync(join(tools, "gh"), `#!/bin/sh\necho "$*" >> "${record}"\nprev=""\nfor a in "$@"; do if [ "$prev" = "--body-file" ]; then cp "$a" "${bodies}/$(date +%s%N).md"; fi; prev="$a"; done\ncase "$1 $2" in "pr view") echo false ;; "pr create") echo "https://github.com/me/app/pull/41" ;; esac\nexit 0\n`);
  chmodSync(join(tools, "gh"), 0o755);
  const evFile = join(tools, "event.json");
  writeFileSync(evFile, JSON.stringify({ action: "created", comment: { id: 9, body: "@syok set the value to 2", user: { login: "lau", type: "User" }, author_association: "OWNER" }, issue: { number: 7, title: "Wrong value", body: "should be 2", user: { login: "reporter" } } }));
  let i = 0; const seen: any[] = [];
  const script = [call("run_command", { command: "echo TOKEN-CHECK:[$GH_TOKEN][$GITHUB_TOKEN][$SYOK_API_KEY]" }), call("run_command", { command: "echo PROC-COUNT:$({ for p in /proc/[0-9]*/environ; do tr '\\0' '\\n' < $p; done; } 2>/dev/null | grep -c -E 'syk_e2e_sec''ret_value|ghs_e2e_tok''en_value')" }), call("edit_file", { path: "a.js", old_text: "= 1;", new_text: "= 2;" }), call("finish", { summary: "Changed the value to 2." })];
  const ai = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { seen.push({ auth: req.headers.get("authorization"), body: await req.json() }); return new Response(JSON.stringify({ choices: [{ message: script[Math.min(i++, script.length - 1)] }], usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 } }), { headers: { "content-type": "application/json", "x-syok-provider": "groq", "x-syok-model": "m" } }); } });
  try {
    const out = await new Promise<string>((res) => {
      const p = spawn("bun", [bundle, "action"], { cwd: work, env: { PATH: tools + ":" + process.env.PATH, HOME: tools, GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "issue_comment", GITHUB_EVENT_PATH: evFile, GITHUB_REPOSITORY: "me/app", SYOK_BASE_URL: `http://127.0.0.1:${ai.port}`, SYOK_API_KEY: "syk_e2e_secret_value", GH_TOKEN: "ghs_e2e_token_value", GITHUB_TOKEN: "ghs_e2e_token_value" }, stdio: ["ignore", "pipe", "pipe"] });
      let o = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (o += d)); p.on("exit", (c) => res(o + "\n[exit " + c + "]"));
    });
    expect(out).toContain("[exit 0]"); expect(out).toContain("Result: opened pull request");
    // The command the AI ran saw none of the three secrets.
    const toolOut = seen[1].body.messages.at(-1).content as string; expect(toolOut).toContain("TOKEN-CHECK:[][][]");
    // Other programs on the machine (this job's own program, the shell that started it) do hold the secrets. On Linux, when
    // confinement works here, the AI's command must not be able to find them there either.
    const procOut = seen[2].body.messages.at(-1).content as string;
    const plan = process.platform === "linux" ? planConfine({ root: work }) : { problem: "not Linux" }; const why = "problem" in plan ? plan.problem : probeConfine(plan);
    if (!why) { expect(out).toContain("(Commands run confined:"); expect(procOut).toContain("PROC-COUNT:0"); }
    else if (process.env.SYOK_REQUIRE_CONFINE === "1" && process.platform === "linux") throw new Error("confinement is required for this run but is not working: " + why);
    else { expect(out).toContain("(Commands are NOT confined on this machine:"); if (process.platform === "linux") expect(procOut).toMatch(/PROC-COUNT:[1-9]/); } // without confinement the secrets ARE findable: the check has teeth
    expect(seen[0].auth).toBe("Bearer syk_e2e_secret_value"); expect(JSON.stringify(seen.map((s) => s.body))).not.toContain("ghs_e2e_token_value");
    const branch = git(remote, "branch", "--list", "syok/*").replace(/^[* ]+/gm, "").trim();
    expect(branch).toMatch(/^syok\/issue-7-set-the-value-to-2-/); expect(git(remote, "show", branch + ":a.js")).toBe("module.exports = 2;"); expect(git(remote, "show", "main:a.js")).toBe("module.exports = 1;");
    const calls = readFileSync(record, "utf8").trim().split("\n");
    expect(calls[0]).toBe("api -X POST repos/me/app/issues/comments/9/reactions -f content=eyes");
    expect(calls.some((c) => c.startsWith("pr create --title Syok Code: #7 set the value to 2 --body-file ") && c.endsWith("--head " + branch))).toBe(true);
    expect(calls.at(-1)).toMatch(/^issue comment 7 --body-file /);
    const posted = spawnSync("sh", ["-c", `cat "${bodies}"/*.md`], { encoding: "utf8" }).stdout;
    expect(posted).toContain("Closes #7."); expect(posted).toContain("Changed the value to 2."); expect(posted).toContain("I opened a pull request with the changes: https://github.com/me/app/pull/41"); expect(posted).toContain("answered by groq / m");
    expect(posted).not.toContain("syk_e2e_secret_value"); expect(posted).not.toContain("ghs_e2e_token_value");
  } finally { ai.stop(true); }
}, 120000);

test("syok github-action writes the workflow file without needing a key", () => {
  const d = tmpProject({});
  const r = spawnSync("bun", [bundle, "github-action", "--cwd", d], { encoding: "utf8", env: { ...process.env, SYOK_API_KEY: "", SYOK_BASE_URL: "", HOME: d } });
  expect(r.status).toBe(0); expect(r.stdout).toContain("Wrote .github/workflows/syok.yml"); expect(existsSync(join(d, ".github/workflows/syok.yml"))).toBe(true);
  expect(spawnSync("bun", [bundle, "github-action", "--cwd", d], { encoding: "utf8", env: { ...process.env, HOME: d } }).status).toBe(2);
});
