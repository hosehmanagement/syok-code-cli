---
description: Add what changed since the last release to CHANGELOG.md, written for the people who use the project
---
Update CHANGELOG.md with the changes since the last release. $ARGUMENTS

Steps:
1. Find the last release: `git describe --tags --abbrev=0`. If there is no tag, use the whole history.
2. List the commits since then: `git log <tag>..HEAD --pretty=format:%s` (without a tag: `git log --pretty=format:%s`).
3. Group them under these headings, leaving out empty ones: Added, Changed, Fixed. Leave out commits that users cannot notice (tests, tooling, formatting).
4. Write each line for a user of the project, in plain words: what they can now do or what no longer goes wrong. One line each. Do not copy commit messages word for word when they are unclear; read the commit (`git show --stat <id>`) if you need to.
5. Put the new section at the top of CHANGELOG.md under a heading "## Unreleased" (create the file with a "# Changelog" title if it is missing). If an "## Unreleased" section is already there, add to it without repeating lines.

Change no other file. Do not commit: tell the user the changelog is ready to look at.
