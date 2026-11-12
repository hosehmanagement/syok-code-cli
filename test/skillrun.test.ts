import { test, expect } from "bun:test";
import { runAgent } from "../src/agent.ts";
import { parseSkill, buildSkillTask, MUST_RUN_NUDGE } from "../src/skills.ts";
import { tmpProject, fakeAI, call } from "./helpers.ts";

const base = "http://fake";
const SKILL = parseSkill("---\nname: hello-check\ndescription: print a number\n---\nRun this:\n```bash\nnode -e \"console.log(6*7)\"\n```\n", "hello-check");
const CMD = 'node -e "console.log(6*7)"';
const text = (s: string) => ({ role: "assistant", content: s });
// every request repeats the whole history, so only the last one is read (counts each message once)
const userMsgs = (seen: any[]) => seen[seen.length - 1].messages.filter((m: any) => m.role === "user").map((m: any) => String(m.content));

test("a skill run executes the command itself and reports it", async () => {
  const d = tmpProject({});
  const ai = fakeAI([call("run_command", { command: CMD }), call("finish", { summary: "printed 42" })]);
  const r = await runAgent({ root: d, task: buildSkillTask(SKILL, ""), base, key: "k", mode: "auto", fetchImpl: ai.f, mustRun: SKILL.needsRun });
  expect(SKILL.needsRun).toBe(true);
  expect(r.commands).toBe(1); expect(r.declined).toBe(0); expect(r.stopped).toBe("finished");
  const tool = ai.seen[1].messages.find((m: any) => m.role === "tool");
  expect(tool.content).toContain("42");
});

test("an AI that only talks is sent back to run the commands (text answer)", async () => {
  const d = tmpProject({});
  const ai = fakeAI([text("You should run node -e to print a number."), call("run_command", { command: CMD }), call("finish", { summary: "done" })]);
  const r = await runAgent({ root: d, task: "go", base, key: "k", mode: "auto", fetchImpl: ai.f, mustRun: true });
  expect(userMsgs(ai.seen)).toContain(MUST_RUN_NUDGE);
  expect(r.commands).toBe(1); expect(r.steps).toBe(3); expect(r.stopped).toBe("finished");
});

test("an AI that calls finish without running anything is sent back too", async () => {
  const d = tmpProject({});
  const ai = fakeAI([call("finish", { summary: "I cannot do that" }), call("run_command", { command: CMD }), call("finish", { summary: "done" })]);
  const r = await runAgent({ root: d, task: "go", base, key: "k", mode: "auto", fetchImpl: ai.f, mustRun: true });
  expect(userMsgs(ai.seen)).toContain(MUST_RUN_NUDGE);
  expect(r.commands).toBe(1); expect(r.summary).toBe("done");
});

test("it asks at most twice, then accepts the answer and says no command ran", async () => {
  const d = tmpProject({});
  const ai = fakeAI([text("no"), text("still no"), text("really no")]);
  const r = await runAgent({ root: d, task: "go", base, key: "k", mode: "auto", fetchImpl: ai.f, mustRun: true });
  expect(userMsgs(ai.seen).filter((m) => m === MUST_RUN_NUDGE).length).toBe(2);
  expect(r.commands).toBe(0); expect(r.stopped).toBe("answered");
});

test("without mustRun there is no pushback (normal chat is unchanged)", async () => {
  const d = tmpProject({});
  const ai = fakeAI([text("just an answer")]);
  const r = await runAgent({ root: d, task: "explain", base, key: "k", mode: "auto", fetchImpl: ai.f });
  expect(userMsgs(ai.seen)).not.toContain(MUST_RUN_NUDGE); expect(r.steps).toBe(1);
});

test("when the user says no, that is counted and the AI is not nagged", async () => {
  const d = tmpProject({});
  const ai = fakeAI([call("run_command", { command: CMD }), call("finish", { summary: "you did not allow the command" })]);
  const r = await runAgent({ root: d, task: "go", base, key: "k", mode: "ask", ask: async () => false, fetchImpl: ai.f, mustRun: true });
  expect(r.declined).toBe(1); expect(r.commands).toBe(0); expect(r.stopped).toBe("finished");
  expect(userMsgs(ai.seen)).not.toContain(MUST_RUN_NUDGE);
});

test("commands a skill allows run without asking, but blocked commands stay blocked", async () => {
  const d = tmpProject({});
  const ai = fakeAI([call("run_command", { command: CMD }), call("run_command", { command: "sudo ls" }), call("finish", { summary: "ok" })]);
  let asked = 0;
  const r = await runAgent({ root: d, task: "go", base, key: "k", mode: "ask", ask: async () => { asked++; return false; }, settings: { allow: ["node -e", "sudo"] }, fetchImpl: ai.f, mustRun: true });
  expect(r.commands).toBe(1); expect(r.declined).toBe(1); expect(asked).toBe(0);
  const outs = ai.seen[2].messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content));
  expect(outs.some((o: string) => o.includes("42"))).toBe(true);
  expect(outs.some((o: string) => o.includes("blocked"))).toBe(true);
});

test("the AI is told which shell it has", async () => {
  const d = tmpProject({});
  const ai = fakeAI([text("hi")]);
  await runAgent({ root: d, task: "hi", base, key: "k", fetchImpl: ai.f });
  expect(String(ai.seen[0].messages[0].content)).toMatch(/\nShell: /);
});

test("a background job starts through the same shell code and is counted", async () => {
  const d = tmpProject({});
  const ai = fakeAI([call("bg_start", { command: 'node -e "setTimeout(()=>{},3000)"' }), call("finish", { summary: "started" })]);
  const r = await runAgent({ root: d, task: "go", base, key: "k", mode: "auto", fetchImpl: ai.f });
  expect(r.commands).toBe(1); expect(r.stopped).toBe("finished");
});
