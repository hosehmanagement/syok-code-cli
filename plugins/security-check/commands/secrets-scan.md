---
description: Find keys and passwords left in the project's files and report where, without printing them (reads only)
---
Look for keys, passwords and tokens that should not be in this project's files. $ARGUMENTS

This is read-only: change nothing.

Where to look:
1. Files git tracks (`git ls-files`), or all files if this is not a git project. Skip dependency and build folders (node_modules, .venv, dist, build, target) and binary files.
2. Look hardest at: .env files and their copies, configuration files (json, yaml, toml, ini), scripts, CI workflow files, notebooks, and anything named like key, secret, credential, token or password.
3. Check whether `.env` and similar files are listed in .gitignore, and whether any of them is tracked by git anyway (`git ls-files | grep -i env`).

What counts:
- A real-looking value assigned to a name such as API_KEY, SECRET, TOKEN, PASSWORD, or passed as a password.
- Known key shapes: `sk-...`, `ghp_...`, `github_pat_...`, `AKIA...`, `xox...`, `-----BEGIN ... PRIVATE KEY-----`, long random strings in a place where a key belongs.
- A web address with a user name and password in it.
What does not count: obvious placeholders (your-key-here, xxx, changeme, example), values read from the environment, test fixtures that are clearly fake.

How to report, and this matters: NEVER print a secret's value, not even part of it. For each finding give the file, the line number, the name it is assigned to, what kind of secret it looks like, and how many characters long it is. Nothing more of the value.

Finish with:
- The findings, most serious first (a real key in a tracked file is the most serious).
- For each real one: it must be replaced at the service that issued it, because removing it from the file does not remove it from git's history.
- Whether .gitignore protects the files that should be private.
- If you found nothing, say so plainly.
