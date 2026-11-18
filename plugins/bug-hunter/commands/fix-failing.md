---
description: Run the tests, find the real cause of each failure and fix the code (not the test)
---
Make the failing tests in this project pass by fixing what is really wrong. $ARGUMENTS

Steps:
1. Find the test command from the project's own files and run it. If everything passes, say so and stop.
2. Take the failures one at a time. For each:
   a. Read the failing test to learn what is expected.
   b. Read the code it tests and follow the failing input through it until you can say exactly which line gives the wrong result and why. Do not change anything before you can say that.
   c. Decide where the mistake is. Almost always it is in the code. It is in the test only if the test contradicts what the code is clearly meant to do (its name, its documentation, its other tests).
   d. Make the smallest change that fixes the cause. Fix the cause, not the symptom: no special case for the test's exact input, no catching and hiding the error.
3. Run the whole test command again. A fix must not break a test that passed before.
4. Repeat until all pass, or until a failure remains that you cannot explain: then stop and report what you found instead of guessing.

Rules: do not edit, skip, delete or loosen a test to make it pass. If you believe a test is wrong, leave it as it is and tell the user why. Do not change what the code does beyond the fix.

Finish with: each failure, its cause in one sentence, and the file and line you changed.
