---
description: Write tests for a file, in the style this project already uses, and run them
---
Write tests for: $ARGUMENTS

If no file was named, ask which one.

Steps:
1. Read the file. List for yourself what each public function or class is supposed to do, including the awkward inputs: empty, zero, negative, very large, missing, wrong type, and the edges of every "if".
2. Find out how this project tests: look for existing test files and the test command (package.json scripts, pyproject.toml, Makefile, go.mod, Cargo.toml). Use the same framework, the same folder and the same naming as the tests already there. If the project has no tests at all, use what comes with the language (node:test for JavaScript, unittest or pytest if installed for Python, the testing package for Go, #[test] for Rust) and say which you chose.
3. Write the tests in a NEW test file next to the existing ones. One behaviour per test, with a name that says what should happen. Cover the normal case, the edges from step 1, and every error the code raises on purpose.
4. Run only the new tests. Read the result.
5. If a test fails, decide which is wrong:
   - The test expects something the code never promised: fix the test.
   - The code really does the wrong thing: KEEP the test, do not change the code, and report it as a bug you found, with the input and what came out.
6. Finish when the new tests run. Say how many tests there are, what they cover, and any bug found.

Rules: do not change the file under test or any other source file. Do not delete or weaken existing tests. No test may depend on the network, the clock or random numbers without fixing them to known values.

The user ran this command because they want the tests written: write and run them now, do not ask for confirmation first.
