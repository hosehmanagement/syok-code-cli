---
description: Commit the current changes with a clear message written from what really changed
---
Commit the changes in this project. $ARGUMENTS

Steps:
1. Run `git status --short` and `git diff` (and `git diff --staged` if something is staged). If there is nothing to commit, say so and stop.
2. Read the diff. Do not guess from file names: the message must describe what the lines really do.
3. Decide alone how many commits: changes made for one reason are ONE commit, and you make it now without asking. Only when the diff clearly holds two or more unrelated things (for example a bug fix in one file and a new, separate feature in another) do you stop and ask whether to split them. One changed file, or one fix, is never a reason to ask.
4. If any changed file looks like it holds a key, a password or a token (.env files, private keys, long random strings assigned to a name like KEY or SECRET), stop and tell the user which file. Do not commit it.
5. Stage the changes (`git add -A`, or only the already staged files if the user staged some on purpose).
6. Write the message in this form and commit with it:
   - First line: `type: what changed`, at most 72 characters, no full stop. type is one of feat (new ability), fix (a bug), docs, refactor (no behaviour change), test, chore (tooling, dependencies).
   - If it helps, a blank line and one to three short lines saying why, not how.
7. Show the commit's first line and its short id.

Rules: the user ran this command because they want the commit made, so finish with a commit, not with a question. Never push. Never use --no-verify. Never rewrite existing commits (no --amend, no rebase) unless the user's words above ask for exactly that. If a commit hook fails, show its output and stop.
