import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseSkill, parseAllowed, findCommands, loadSkills, rawUrl, addSkill, preview, buildSkillTask, safeName, splitFront } from "../src/skills.ts";
import { tmpProject } from "./helpers.ts";

const DEPLOY = `---
name: Deploy Check
description: Build the app and run the tests before a release
allowed-tools: Bash(npm test:*), Bash(npm run build)
---
# Deploy check
Run these:

\`\`\`bash
# install
npm install
npm test
\`\`\`

\`\`\`json
{"not": "a command"}
\`\`\`
`;

test("front matter, name, description and allowed commands are read", () => {
  const s = parseSkill(DEPLOY, "folder");
  expect(s.name).toBe("deploy-check"); expect(s.description).toContain("run the tests");
  expect(s.allowed).toEqual(["npm test", "npm run build"]);
  expect(s.needsRun).toBe(true);
});
test("only shell code blocks count as commands; comments are skipped", () => {
  expect(findCommands(DEPLOY)).toEqual(["npm install", "npm test"]);
  expect(findCommands("```\n$ git status\nplain text\n```")).toEqual(["git status"]);
  expect(findCommands("```python\nprint(1)\n```")).toEqual([]);
});
test("a skill with no front matter takes its name from the folder and is guidance only", () => {
  const s = parseSkill("# Write kind emails\nBe warm and short.", "Kind Emails");
  expect(s.name).toBe("kind-emails"); expect(s.needsRun).toBe(false); expect(s.commands).toEqual([]); expect(s.allowed).toEqual([]);
});
test("allowed-tools forms", () => {
  expect(parseAllowed("Bash(git status), Read, Bash(npm run test:*)")).toEqual(["git status", "npm run test"]);
  expect(parseAllowed("")).toEqual([]);
  expect(parseAllowed(undefined)).toEqual([]);
});
test("windows line endings and a byte-order mark are handled", () => {
  const s = splitFront("﻿---\r\nname: x\r\n---\r\nbody");
  expect(s.meta.name).toBe("x"); expect(s.body).toBe("body");
});
test("safeName", () => { expect(safeName("  Hello World!! ")).toBe("hello-world"); expect(safeName("../../etc")).toBe("etc"); });

test("skills load from the project (.syok and .claude) and the home folder; project wins", () => {
  const d = tmpProject({
    ".syok/skills/one/SKILL.md": "---\nname: one\ndescription: project one\n---\nA",
    ".syok/skills/two.md": "# two\nB",
    ".claude/skills/three/SKILL.md": "---\nname: three\n---\nC",
    ".claude/skills/one/SKILL.md": "---\nname: one\ndescription: claude one\n---\nD",
  });
  const home = tmpProject({ ".syok/skills/one/SKILL.md": "---\nname: one\ndescription: home one\n---\nE", ".syok/skills/home-only/SKILL.md": "F" });
  const m = loadSkills(d, home);
  expect([...m.keys()].sort()).toEqual(["home-only", "one", "three", "two"]);
  expect(m.get("one")!.description).toBe("project one");
  expect(m.get("home-only")!.source).toBe("home");
});
test("a missing or broken skills folder is fine", () => {
  const d = tmpProject({ ".syok/skills/empty/readme.txt": "x" });
  expect(loadSkills(d, tmpProject({})).size).toBe(0);
});

test("github links turn into raw file links", () => {
  expect(rawUrl("https://github.com/a/b/blob/main/skills/x/SKILL.md")).toBe("https://raw.githubusercontent.com/a/b/main/skills/x/SKILL.md");
  expect(rawUrl("https://github.com/a/b/tree/main/skills/x/")).toBe("https://raw.githubusercontent.com/a/b/main/skills/x/SKILL.md");
  expect(rawUrl("a/b/skills/x")).toBe("https://raw.githubusercontent.com/a/b/HEAD/skills/x/SKILL.md");
  expect(rawUrl("a/b/skills/x/SKILL.md")).toBe("https://raw.githubusercontent.com/a/b/HEAD/skills/x/SKILL.md");
  expect(rawUrl("nonsense")).toBe("");
});
test("adding a skill from a link saves it under .syok/skills", async () => {
  const d = tmpProject({});
  let asked = "";
  const f = (async (u: any) => { asked = String(u); return new Response(DEPLOY, { status: 200 }); }) as any;
  const r = await addSkill(d, "https://github.com/a/b/blob/main/deploy/SKILL.md", f);
  expect(r.ok).toBe(true); expect(r.name).toBe("deploy-check"); expect(asked).toContain("raw.githubusercontent.com");
  expect(readFileSync(join(d, ".syok", "skills", "deploy-check", "SKILL.md"), "utf8")).toContain("npm test");
  expect(r.message).toContain("2 commands");
});
test("adding from a local file, and the failure messages", async () => {
  const d = tmpProject({ "mine/SKILL.md": "# mine\nhello" });
  expect((await addSkill(d, join(d, "mine", "SKILL.md"))).name).toBe("mine");
  expect(existsSync(join(d, ".syok", "skills", "mine", "SKILL.md"))).toBe(true);
  const bad = (async () => new Response("no", { status: 404 })) as any;
  expect((await addSkill(d, "a/b/c", bad)).message).toContain("404");
  expect((await addSkill(d, "nonsense", bad)).ok).toBe(false);
  const empty = (async () => new Response("  ", { status: 200 })) as any;
  expect((await addSkill(d, "a/b/c", empty)).message).toContain("empty");
});
test("preview lists the commands; the task tells the AI to run them itself", () => {
  const s = parseSkill(DEPLOY, "x");
  expect(preview(s)).toContain("npm install"); expect(preview(s)).toContain("without asking each time");
  const t = buildSkillTask(s, "for the web folder");
  expect(t).toContain("for the web folder"); expect(t).toContain("Run the commands it needs yourself"); expect(t).toContain("=== Skill: deploy-check ===");
  expect(buildSkillTask(parseSkill("# tone\nBe kind.", "tone"), "")).toContain("do not stop to ask");
});

test("front matter values written on the next lines (\"name: >-\"), as CLI-Anything skills write them, are read without the marker", () => {
  const text = "---\nname: >-\n  cli-anything-libreoffice\ndescription: >-\n  Command-line interface for Libreoffice - makes real ODF files\n  and exports them\nother: |\n  line one\n  line two\nplain: \"quoted\"\n---\n\n# cli-anything-libreoffice\n\n```bash\ncli-anything-libreoffice --help\n```\n";
  const { meta } = splitFront(text);
  expect(meta.name).toBe("cli-anything-libreoffice");
  expect(meta.description).toBe("Command-line interface for Libreoffice - makes real ODF files and exports them");
  expect(meta.other).toBe("line one line two"); expect(meta.plain).toBe("quoted");
  const sk = parseSkill(text, "fallback");
  expect(sk.name).toBe("cli-anything-libreoffice"); expect(sk.description.startsWith(">")).toBe(false); expect(sk.commands).toEqual(["cli-anything-libreoffice --help"]); expect(sk.needsRun).toBe(true);
  // a value that really is just ">" followed by text on the same line is kept
  expect(splitFront("---\nname: a\ndescription: > 5 items\n---\nx").meta.description).toBe("> 5 items");
});
