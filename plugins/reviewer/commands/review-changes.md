---
description: Review your uncommitted changes for real bugs, security problems and missing tests (reads only)
---
Review the uncommitted changes in this project. $ARGUMENTS

This is a read-only review: do not edit, create or delete any file, and do not run commands that change anything.

Steps:
1. Run `git status --short` and `git diff HEAD` (new files that git does not track yet: read them directly). If nothing changed, say so and stop.
2. For every changed place, read enough of the surrounding file to understand it. A diff alone is not enough to judge.
3. Look for, in this order:
   a. Bugs: wrong results, off-by-one, a missing case, a value that can be null or empty, an error that is swallowed, something that worked before and no longer does.
   b. Security: text from outside put straight into a database query, a shell command, a file path or a web page; keys or passwords written in the code; checks that were removed.
   c. Missing tests: changed behaviour with no test that would notice if it broke.
   d. Only then: things that are confusing to read. Leave out matters of taste.
4. For each finding give: the file and line, what goes wrong and with which input, and the smallest change that fixes it.

Output:
- Start with one line: how many findings, and whether you would commit this as it is.
- Then the findings, most serious first, each marked BUG, SECURITY, TESTS or CLARITY.
- If you found nothing serious, say so plainly instead of inventing problems.
Be exact. A finding you are not sure about must say that it is a suspicion and what would confirm it.
