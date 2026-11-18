---
description: Rename a function, class or variable everywhere it is really used, then run the tests
---
Rename a name across this project. Old name, then new name: $ARGUMENTS

If two names were not given, ask for them.

Steps:
1. Run the tests first, so you know what passed before you touched anything. Note any that already fail.
2. Find the definition of the old name. If more than one thing has that name (a function and a method, two functions in different files), list them and ask which one is meant. Rename only that one.
3. Find every real use of it. Use the lsp tool (action references) when it is offered: it knows which uses belong to this definition. Otherwise use find_symbol, then read each place to make sure it refers to the same thing and not to something else with the same name.
4. Check the new name is free: nothing in the same scope may already be called that.
5. Change the definition and every use found in step 3, including imports, exports and tests. Do not use search-and-replace on plain text: a different thing with the same name, or the same letters inside a longer word, a string or a comment, must be left alone. Mention places in comments or documentation that talk about the old name and update those that clearly mean it.
6. If the name is part of what other projects use (exported from the package, a command-line option, a web address, a database column), say so before changing it and ask.
7. Run the tests again. The same tests must pass as in step 1. If one now fails, fix the rename, not the test.

Finish with: how many places changed, in which files, and the test result before and after.

The user ran this command because they want the rename done: do it now, do not ask for confirmation first (ask only if the old name cannot be found or two different things share it).
