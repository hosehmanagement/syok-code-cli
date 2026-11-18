---
description: Write a GitHub Actions workflow that runs this project's real tests on every push and pull request, ready for you to put in place
---
Set up automatic checks on GitHub for this project. $ARGUMENTS

Steps:
1. Find out the language, its version and the real commands to install and to test, from the project's own files (package.json and its lock file, pyproject.toml or requirements.txt, go.mod, Cargo.toml, Makefile). Use the package manager the lock file belongs to (package-lock.json: npm ci; pnpm-lock.yaml: pnpm; yarn.lock: yarn; bun.lock: bun).
2. Run the test command once here, so you know it works before it is written into a workflow. If it fails, say so and ask whether to go on.
3. If `.github/workflows` already has a workflow that runs the tests, do not add a second one: say what is there and stop.
4. Write the workflow as a file named `ci-workflow.yml` in the project's top folder. Syok Code does not let an AI write into `.github/workflows` (a safety rule: that folder decides what runs on GitHub with the project's permissions), so the user puts the file in place themselves. Do not try to get around this with a shell command. The file holds:
   - name: CI
   - on: push to the default branch, and every pull_request
   - permissions: contents: read (nothing more)
   - one job on ubuntu-latest: check out the code with actions/checkout@v4, set up the language with its official setup action at the version the project states, install with the lock file, run the test command.
   - Add a lint or build step only if the project already has such a command.
5. Read the file back and check it is valid YAML with correct indentation.
6. Finish by telling the user, in these words, the one command that puts it in place:
   `mkdir -p .github/workflows && mv ci-workflow.yml .github/workflows/ci.yml`
   and that the checks start once that file is committed and pushed to GitHub.

Rules: no secrets, no deploy step, no write permissions, no third-party actions beyond the official checkout and language setup ones. Change no other file. Do not commit or push.

The user ran this command because they want the file written: when the test command works, write the file now without asking for confirmation.
