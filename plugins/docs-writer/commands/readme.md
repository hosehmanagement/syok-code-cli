---
description: Write or refresh README.md from what the project really does, using only commands that exist
---
Write or refresh README.md for this project. $ARGUMENTS

Steps:
1. Find out what the project is: read the entry points, the package or build file (package.json, pyproject.toml, go.mod, Cargo.toml, Makefile) and a few of the main source files. Read an existing README too: keep what is still true.
2. Find the real commands: how to install, run, test and build. Take them from the project's own files. A script named in the project's own files IS a real command: every "start", "test", "build" or "dev" entry under "scripts" in package.json (written as `npm start`, `npm test`, `npm run build`), every such target in a Makefile, every script entry in pyproject.toml. Include each one that exists, even if you think it is rarely needed. Never write a command you did not see there. If you cannot find how to do one of them, leave that part out or say plainly that it is not set up.
3. Write README.md with these parts, in this order, and nothing else unless the project needs it:
   - The name and one or two sentences: what it does and for whom.
   - What you need first (language version, tools), only if the project files state it.
   - Install: the exact commands.
   - Use: the exact command to run it, and one short real example.
   - Test: the exact command.
   - How the code is laid out: the main folders or files, one line each.
4. Plain words, short sentences, commands in code blocks. No badges, no praise, no "getting started is easy".

Change only README.md. Do not change code. At the end, list any part you left out because the project does not say how.

The user ran this command because they want the file written: write it now, do not ask for confirmation first.
