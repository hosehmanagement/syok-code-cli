# Syok Code (command line)

Syok Code for your own computer: an AI coding agent that reads your project, edits files, runs your tests and fixes what it broke. It talks to **your own Syok AI key**, so automatic key switching (when one provider hits a limit) keeps working in the middle of a long task.

Status: early (v0.21). Built for computers that are fast and stable.

## Quick start
1. Install (one line; you do not need to install anything else first):
   - Mac/Linux: `curl -fsSL https://syok-ai.com/syok-code/install.sh | sh`
   - Windows (PowerShell): `irm https://syok-ai.com/syok-code/install.ps1 | iex`

   Everything goes into the `.syok` folder in your home folder: a private copy of the Bun runtime, the one-file program and the `syok` command. Both downloads are checked against their published checksums. Run the same line again, or `syok update`, to get the newest version.
2. Run `syok login`. It shows a link and a code. Open the link where you are signed in to Syok (it opens by itself on most computers; on a remote computer such as a Codespace, open it on any device), check that the code matches and press **Allow**. Your browser makes a key for this computer (listed in Syok under **Work → API Keys**, where you can revoke it) and sends it back locked so only this terminal can open it. Nothing to copy or paste. `syok logout` forgets it here.
3. Optional: run `syok setup` for your everyday choices. It asks ten short questions, once: your address (press Enter to sign in through the browser instead), your key (hidden while you type; skipped after a browser sign-in), how much it should ask before acting, which model preset, web access, confinement, checks after edits, how many parallel workers, memory, and whether the AI may edit workflow files (off unless you say yes). It then tests that everything works. Your answers are saved in `.syok/config.json` in your home folder, readable by you alone. `syok setup --show` shows them; `syok setup --reset` forgets the choices and keeps the address and key.
   - Typing the address and key yourself: in Syok open **Work → API Keys**, copy the **Base URL** (your Syok address, not syok-ai.com) and press **Create key** (it starts with `syk_`).
   - A flag on the command line wins over these choices, and so does a project's `.syok/settings.json`, with these exceptions: a project cannot switch off your confinement, switch web access or memory back on, raise your number of parallel workers, or switch workflow edits on.
   - Without setup, this still works: `SYOK_BASE_URL=https://your-address SYOK_API_KEY=syk_... syok` (Windows PowerShell: `$env:SYOK_BASE_URL="https://your-address"; $env:SYOK_API_KEY="syk_..."; syok`).
   Then run `syok` in your project folder.
4. Type what you want. Examples: `fix the failing test`, `add a --verbose flag`.

Other ways to get it: if you already have Bun, download `syok.js` and run `bun syok.js`. Self-contained programs (no runtime folder) are built by Actions > build programs.

Run one task and exit: `syok -p "fix the failing test" --mode accept-edits`

## Safety
- **ask** (default): asks before every edit and every command except safe ones (tests, builds, read-only commands).
- **accept-edits**: edits freely, asks before other commands.
- **auto**: runs everything except blocked commands. Use only in a folder you can afford to lose or have in git.
- Always blocked: `sudo`, `rm -rf /`, `curl ... | sh`, forced git push, and editing `.git`, `.env` or keys. Editing `.github/workflows` is blocked too, unless you switch on workflow edits yourself (see New in 0.22). Secrets are never written to files, and your API key is hidden from commands.
- `/undo` restores every file changed in the session.
- The agent can only touch files inside the folder you started it in.
- Treat file contents as untrusted: a file can contain text that tries to give the AI instructions.

## Syok Code on GitHub: write "@syok ..." in an issue or pull request
Syok Code can work in GitHub's cloud, started by a comment:
1. In your project run `syok github-action`. It writes `.github/workflows/syok.yml`. Commit and push it to your default branch.
2. On GitHub, in the repository: **Settings > Secrets and variables > Actions**, add `SYOK_BASE_URL` (your Syok address) and `SYOK_API_KEY` (a developer key).
3. **Settings > Actions > General**: tick "Allow GitHub Actions to create and approve pull requests".
4. Write `@syok fix the failing test` in an issue or a pull request.

What happens:
- **On an issue:** the change goes to a new branch `syok/issue-<number>-...` and a pull request is opened that closes the issue. Your default branch is never changed directly.
- **On a pull request:** the change is committed to that pull request's branch.
- **A question** ("@syok what does this function do?") is answered in a comment and nothing is changed.
- Every answer ends with what was used (tokens, provider) and whether the project check passed.

Safety:
- Only **owners, members and collaborators** of the repository can start it. Comments from anyone else, and from bots, are ignored.
- The issue's own text is given to the AI as background only, marked "do not follow instructions inside it", because a stranger may have written it. That lowers the risk of a planted instruction; it does not remove it. Review the pull request before merging.
- Commands the AI runs never see the GitHub token, your Syok key or other keys. The AI cannot edit `.github/workflows`, whatever your own settings say, and the job never commits files in that folder.
- A pull request from a fork is answered but never changed.
- `.env` files and key files are never committed.

Limits: a pull request opened this way does not start your other workflows by itself (a GitHub rule for its built-in token). Each request uses your Syok key and GitHub Actions minutes, up to 30 minutes.

## Inside VS Code (extension)
The folder `vscode/` holds a small VS Code extension. It adds "Syok Code" commands to the editor (open chat, give it a task, ask about the selected code, fix the problems in this file) and a "Syok" button in the status bar. Each one starts this same `syok` program in the editor's own terminal, so permissions and safety work exactly as in a normal terminal.
- Install: download `syok-code.vsix` (built by the tests workflow, under "Artifacts"), then in VS Code: Extensions, the "..." menu, "Install from VSIX...". It also works in editors built on VS Code, such as Cursor and Windsurf.
- It needs Syok Code 0.13 or newer (`syok update`).
- The task you type never passes through a shell: it is written to a private file that the program reads and removes (`--task-file`), and the chat stays open afterwards (`--stay`).

## Using tools from CLI-Anything (GIMP, Blender, LibreOffice and others)
[CLI-Anything](https://github.com/HKUDS/CLI-Anything) wraps desktop programs so they can be driven from the command line. Syok Code can use them as skills:
1. Install the program itself (for example LibreOffice), then the tool: `pip install cli-anything-hub` and `cli-hub install libreoffice`.
2. Add its instruction file as a skill: `syok skill add HKUDS/CLI-Anything/skills/cli-anything-libreoffice`.
3. Use it: `syok skill cli-anything-libreoffice "make a one-page report and export it as report.pdf"`.

The workflow "cli-anything live test" does exactly this with a real AI and checks the PDF it made.

## New in 0.22
- **Todo list for long tasks**: the AI keeps its own checklist with the `todo` tool (at most one step in progress at a time, up to 50 short steps). You see the checklist whenever it changes, and `/todo` in the chat shows it. It is saved with the chat, so `--continue` and `--resume` bring it back, and after the chat is shortened (automatically or with `/compact`) the list is put back word for word right after the summary, so the AI never loses its place. If the AI tries to finish with steps still open, it is sent back once; a second finish is accepted and the result says which steps were left open. `--json` output includes the final list (`todos`). Helpers (explorers and workers) do not get the tool.
- **Workflow edits, only if you allow them**: by default the AI still cannot change `.github/workflows`. These files decide what runs in your GitHub Actions and can read your repository's secrets, so a careless or tricked edit there can leak keys or run anything on GitHub's computers. That is why it is opt-in, and why only you can switch it on.
  - Switch it on for good with the last question of `syok setup` (it saves `"allow_workflow_edits": true` in `.syok/config.json` in your home folder), or for one run with `--allow-workflow-edits`. `syok setup --show` says whether it is on.
  - When on, every edit of a `.github/workflows/*.yml` or `*.yaml` file is asked first, also in accept-edits mode, with the change shown under the line "this file controls what runs in your GitHub Actions and can read your repository secrets".
  - In `--mode auto` nobody is asked, so workflow edits happen only when `--allow-workflow-edits` was given on the command line for that run; the saved setting alone is not enough.
  - A project's `.syok/settings.json` cannot switch it on. The cloud `@syok` job never edits workflow files (the flag is ignored inside GitHub Actions). Helpers the AI starts get it only when the main run has it. `.git`, `.env` and key files stay blocked either way.
- **Rename with the language helper** (`lsp` action `rename`): the AI renames a function, class or variable everywhere it is really used, imports and other files included, while other things that happen to share the name are left alone. It first lists the files and the number of changes in each. In ask mode you see one diff for the whole rename and approve it once; `/undo`, `/diff` and checkpoints include it like any other edit. Names that are not valid identifiers, changes to files outside the project (for example a library's own code) and renames the helper cannot do are refused with the reason, and nothing is changed.
- **Comparison bench** (`bench/`): gives the same task, the same limits and the same model to Syok Code, Claude Code, Codex and Cursor, each in a fresh copy of the project, and lets one grader decide. It records pass, regressions, protected tests that were changed, tokens, cost and time, and writes a JSON file and a Markdown table. `--lane claude` or `--lane gpt` refuses to compare tools on different models. Start with `bun bench/run.ts --dry-run` (spends nothing). `bench/swebench/` runs a tool on SWE-bench instances, one container each, and writes `predictions.jsonl` for the official SWE-bench harness. Beginner guide: [bench/README.md](bench/README.md).
- **`peek_file` for huge files** (200 MB logs, big JSON lines or CSV): a read-only tool that reads the file as a stream, so memory stays small whatever its size, and keeps every answer short (at most 12,000 characters). Files inside the project only.
  - `summary`: size, line count, first and last 20 lines, line lengths, and the format (log, json, jsonl, csv or other).
  - `patterns`: the most frequent kinds of line, with numbers, hex ids, timestamps, uuids and addresses replaced by placeholders, each with its count and first line, plus the most frequent ERROR, WARN and Exception lines.
  - `sample`: evenly spaced windows of lines from the whole file. `around`: the lines around the first matches of a regular expression, with the total number of matches.
  - `columns` (csv and jsonl): field names, types, and the values of fields that have only a few different values.
  - A 300 MB log takes well under a second for `summary`, `sample` and `around`, and a few seconds for `patterns`. `read_file` now points to `peek_file` for files over 2 MB.
- **The AI can see pictures it made**: the new `view_image` tool and pictures in tool-server results (for example Playwright browser screenshots). See "Seeing pictures (view_image and browser screenshots)" below.
- **Interactive terminals**: the AI can now drive programs that wait for typed input: `python -m pdb`, `gdb`, a REPL (python, node, irb...), `npm init`, installers that ask questions, ssh prompts. It starts one with `pty_start`, types with `pty_send` (key names such as `<Enter>`, `<Tab>`, `<Up>`, `<Ctrl-C>`, `<Ctrl-D>` work), reads what came back with `pty_read` (plain text: colours and cursor codes removed, with "still running" or "exited with code N") and stops it with `pty_stop`. It uses Bun's own pseudo-terminals, so the program sees a real terminal.
  - **Safety**: the start command passes the same checks as `run_command` (blocked commands refused, your approval in ask mode, read-only plan mode has no terminals), runs inside the same confinement (`--confine`) and without your keys in its environment. In ask mode you approve the start once; what the AI then types is not asked again, but it is checked: a blocked command (sudo, `rm -rf /`, curl into a shell, forced push...), anything that looks like a key or token, and anything that would open a shell is refused and never reaches the terminal.
  - **Plain shells are refused**: `bash`, `sh`, `zsh`, `fish`, `powershell`, `cmd` and the like (also through `env`, `exec`, `docker exec`, `script`, `tmux`, `su`, `nix-shell`, `pty.spawn`...). Checking every line typed into a shell cannot be made watertight (a shell can spell a command in endless ways), and an approved shell would skip your approval of each command. Shell commands go through `run_command`; a script that asks questions (`bash install.sh`) is fine.
  - **Limits**: at most 3 terminals at once; each keeps up to 200 000 characters of unread output (older output is dropped with a plain note); a terminal nobody typed into or read for 10 minutes is stopped, and every terminal is stopped after 60 minutes; all are stopped when Syok Code exits (a helper's terminals when the helper finishes). The main agent and workers have the tools, read-only explorers do not. Not available with `--sandbox`.
  - **Windows**: Bun has no pseudo-terminals on Windows, so the tools are not offered there (they say so if called). Give the answers up front instead (flags such as `--yes`, or `program < answers.txt`), or run Syok Code in WSL. Tested on real Linux and Mac terminals in CI.
  - A REPL or debugger can still run code you did not see typed in advance (as `python3 script.py` through `run_command` can), so use `--confine` (on by default on Linux and Mac) when that matters.

## New in 0.14
- **Parallel editing**: when a job splits into separate parts in different files, the AI can run a worker for each part at the same time, each in its own copy of the project, and join the results into your folder. It needs a git project. You are asked before the workers start (not in `--mode auto`). Up to 2 run at once by default: `--workers 4`, or `"parallel_workers": 4` in `.syok/settings.json`, changes that (0 switches it off, 8 is the most), and `syok setup` asks for your everyday number.
  - Your branch, your commits and your staging area are not touched: the joined changes arrive as ordinary edited files, and `/undo` takes them back.
  - If two workers changed the same lines, the first is joined and the second is not applied at all; the AI is told and redoes that part on top.
  - Each worker uses your Syok key at the same time, so provider limits are reached sooner.
  - The copies live inside the project's `.git` folder while the workers run and are removed afterwards. Files that git ignores are not copied; `node_modules`, `.venv` and `venv` are linked so tests can run.
- **`syok doctor`**: checks your address, your key (never shown), a real AI answer, and the programs Syok Code uses. Each problem comes with what to do.
- **Your own helpers**: a file `.syok/agents/reviewer.md` with a few lines of instructions makes a helper the AI can hand work to. `tools: read, search` makes it read-only. Files written for Claude Code (`.claude/agents/`) and GitHub Copilot (`.github/agents/*.agent.md`) are used as they are. `syok agents` lists them.
- **Hosted tool servers**: in `.syok/settings.json`, `"mcpServers": { "name": { "url": "https://...", "headers": { "Authorization": "Bearer ${MY_KEY}" } } }`. `${MY_KEY}` is read from your environment, so the key is not written in the file. Syok's own keys are never handed to a tool server.
- **Confinement** (on by default on Linux and Mac): the operating system holds every command the AI runs inside the project folder. Commands can read the computer but write only in the project and the temporary folder, cannot read folders that hold keys (`.ssh`, `.aws` and others), and cannot find your keys by looking at other running programs.
  - `--no-confine` switches it off for one run (Docker and a few other commands need that). `syok setup` changes your everyday choice. A project's own settings file cannot switch it off.
  - `--confine-no-network` also cuts the network. Linux needs the program bubblewrap; Mac uses the built-in sandbox-exec. If it cannot work on your computer, Syok Code says so in one line and carries on; with `--confine` it stops instead.
  - **Windows:** `--confine` (or the question in `syok setup`) gives write protection: commands can change files only in the project. They can still read your other files, and the network stays on. To do this, Syok Code marks the project folder so low-privilege programs may write in it; `syok confine undo` removes the mark. Inside WSL you get the full Linux kind. While confined on Windows, commands run in PowerShell (or the Command Prompt), not Git Bash: Git Bash cannot start at the low level while another Git Bash is open.
- **Browser sign-in for hosted tool servers**: `syok mcp login <name>` opens your browser, you approve, and Syok Code keeps the pass in `.syok/mcp-auth.json` in your home folder (readable by you alone) and renews it by itself. `syok mcp` lists your hosted servers and whether you are signed in; `syok mcp logout <name>` forgets the pass. A key written in the settings still works and always wins. For a sign-in service that only accepts apps it knows, register an app there and add `"oauth": { "client_id": "..." }` to that server's settings.
- **Language helpers** (`syok lang`): when the language's own tooling is on your computer (for example `typescript-language-server`, `pyright`, `gopls`, `rust-analyzer`, `clangd`), the AI gets an `lsp` tool with exact answers: where a name is really defined, every real use of it, its type, and the compiler's errors for a file. `syok lang` shows what your project uses, which helpers were found, and the one line that installs a missing one. Syok Code never downloads a helper by itself. `"lsp": false` in the settings switches this off.
- **Memory across chats**: the AI saves short notes by itself (how the project is built and tested, what you decided, how you like things done) and is given them at the start of later chats. They are plain files in `.syok/memory` in your home folder, never in the project. `/memory` (or `syok memory`) shows them, `/memory forget p2` removes one, `/memory clear` removes all; `--no-memory`, `"memory": false` or the question in `syok setup` switches it off. Keys and passwords are refused, and a note about you (read in every project) is saved only after you say yes.
- **`/cloud <what to do>`** (or `syok cloud "..."`): pushes your work to a branch, opens a draft pull request and starts the `@syok` job on GitHub to carry on there. Asks first, and refuses to push anything that looks like a key.
- **`find_symbol` and `outline`**: two new tools the AI uses to find where a name is defined and used, and to see what a file contains without reading all of it. No language servers needed.

## Inside JetBrains editors (add-on)
The folder `jetbrains/` holds a small add-on for IntelliJ IDEA, PyCharm, WebStorm, GoLand and the other JetBrains editors (2024.3 and newer). Under **Tools | Syok Code** it adds: open a chat, give it a task, and (also in the editor's right-click menu) ask about the selected code. It opens the editor's own terminal and starts `syok` there, so everything else works as in a normal terminal.
- Install: download `syok-code-jetbrains.zip`, then in the editor: Settings, Plugins, the gear icon, "Install Plugin from Disk...".
- It needs the `syok` program on your computer; when it is missing, the add-on shows the one line that installs it.
- The task or question is written to a private temporary file and only that file's path is typed into the terminal, so no character of it is read by a shell.

## Checks after edits
The AI's changes are checked automatically, so mistakes are caught while it is still working:
- **After every edit:** a fast syntax check of that one file (JavaScript, TypeScript, JSON, Python, shell, PHP, Ruby, Go, Lua). The result is part of what the AI sees, so a broken bracket is fixed in the next step. It checks syntax only, not types, and never changes a file.
- **Before finishing:** if code files changed, the project's own check runs once: the `typecheck`, `type-check`, `check` or `lint` script in `package.json`, else `cargo check`, else `go vet ./...`. If it fails, the output goes back to the AI to fix (twice at most). After that the final line says the check is still failing. Tests and builds are not started automatically.
- **Your own check:** put `"check_command": "make verify"` in `.syok/settings.json`. In ask mode you are asked before a command that is not on the always-allowed list.
- **Limits:** the project check also reports problems that were already there before the AI's change; the AI is told to leave those and say so. Switch everything off with `--no-checks` or `"checks": false`.

## Usage and cost
After each task you see how many tokens went in and out and which provider answered, and a line whenever Syok switched provider for you. `/usage` shows the total for the session; `--json` output has a `usage` field.

Syok cannot know what each of your providers charges, so it shows no money amount by itself. For an estimate, add your prices (US dollars per million tokens) to `.syok/settings.json`, matched by a piece of the provider or model name:
```json
{ "prices": { "gpt-5": { "in": 1.25, "out": 10 }, "groq": { "in": 0, "out": 0 } } }
```

## Heavy jobs on a rented cloud computer
Some jobs are too heavy for your own computer (training a model, a long build, a big data crunch). `syok run` sends the job to a computer rented from your own [Modal](https://modal.com) account, shows its output live, brings the results back and switches the computer off.

```
syok run --on modal -- python train.py
syok run --on modal --gpu T4 --timeout 120 --out results -- python train.py --epochs 3
```
- **One-time setup:** create a Modal account, make an API token (Settings, API Tokens), and set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in your terminal. The token goes straight from your computer to Modal, never to Syok. No Syok key is needed for `syok run`.
- **What is sent:** the files of the current folder. In a git project `.gitignore` is respected. Never sent: `.env` files, key files (`.pem`, `.key`, `id_rsa`...), `node_modules`, `.venv`, `.git`. At most 200 MB. Use `--no-upload` to send nothing.
- **Options:** `--gpu T4|L4|A10|A100`, `--image python:3.12-slim` (any container image; default is Python, or Node when the folder only has a `package.json`), `--timeout` in minutes (default 60, at most 1440), `--cpu`, `--memory` (MB), `--out <folder>` to bring a results folder back.
- **Cost:** Modal bills your own account per second while the computer is on. It is switched off when the command ends, when you press Ctrl+C, or when the time limit passes, whichever comes first.
- **Leave it running:** add `--detach`. Then `syok remote` lists runs, `syok remote logs 1` shows the output, and `syok remote stop 1` brings results back and switches the computer off. A detached computer stays on (and billing) after its command ends, until you stop it or the time limit passes.
- **Limits:** the job runs in a fresh container, so install what it needs as part of the command (`pip install -r requirements.txt && python train.py`). Results come back only from the `--out` folder.

## Looking things up on the web
The AI has two web tools, so it can check current facts, documentation and error messages instead of guessing:
- `web_search`: finds pages. It tries, in order: the search in your own Syok account (when your Syok version offers it to developer keys), your own Exa key if you set `EXA_API_KEY`, then DuckDuckGo with no key. DuckDuckGo sometimes refuses automated requests; the AI is told plainly when a search did not work.
- `web_fetch`: reads one page as plain text (menus, scripts and styles removed; long pages come in parts).

Safety:
- In **ask** and **accept-edits** modes you approve the first search and each new website. Sites listed in `"allow_hosts"` in `.syok/settings.json` (for example `["python.org"]`, sub-domains included) need no question. **auto** mode does not ask.
- Never fetched: cloud metadata and link-local addresses (also when a redirect or a harmless-looking name points there), addresses with a password in them, and any address or search that contains something that looks like a secret key.
- Web text is marked as untrusted and the AI is told never to follow instructions found in it. That lowers the risk; it does not remove it, so keep **auto** mode for folders you can afford to lose.
- Switch the web tools off with `--no-web` or `"web": false` in `.syok/settings.json`.

## Project instructions
Put a `SYOK.md`, `AGENTS.md` or `CLAUDE.md` in the project root and it is added to the instructions (first 8,000 characters).

## Making it better (scoring)
`evals/` holds 16 small coding tasks (JavaScript, Python, Go, Rust, Java, TypeScript) with hidden tests. `bun evals/run.ts --check` proves each task is fair. In GitHub, Actions > score runs a model on all tasks and saves a score. `profiles.json` holds tuning profiles per model; keep a change only if the score goes up.

## Develop
`bun test ./test`. Single program: `bun build --compile src/main.ts --outfile syok`.

## What the AI can do (v0.2)
- **Streaming**: the answer appears word by word (use `--no-stream` to turn off).
- **Diff viewer**: every edit approval shows a +/- diff; type `/diff` to see all changes so far, `/undo` to roll back.
- **Helper agents**: the AI can hand big searches to read-only "explorers" (up to 4 at once, each with a fresh memory) or one change to a "worker".
- **Hooks**: your own commands around the AI's actions (format after edit, block a file, run tests before it may finish). In `.syok/settings.json`:
  `{"hooks":{"PreToolUse":[{"match":"write_file","command":"./guard.sh"}],"PostToolUse":[{"match":"edit_file","command":"npx prettier --write ."}],"Stop":[{"command":"npm test"}]}}`
  The command receives the event as JSON on its input. Exit code 2 blocks (or, for Stop, sends the message back to the AI).
- **Local tool plug-ins (MCP)**: `{"mcpServers":{"mytools":{"command":"node","args":["server.js"]}}}`. Tools appear as `mcp__mytools__<tool>` and need your approval unless mode is auto or you list `"allow":["mcp__mytools"]`.
- **Background jobs**: dev servers and watchers (`bg_start`, `bg_output`, `bg_stop`; `/jobs` lists them). They are stopped when Syok Code exits.
- **Saved jobs** (0.7): long scripts and heavy tasks that keep running after Syok Code exits. The AI starts one with `job_start` (optional time limit), output goes to `.syok/jobs/<n>/out.log`. Later, from any session or terminal: `syok jobs` (list), `syok logs <n> [--tail 4000]` (read), `syok stop <n>` (stop). The AI reads them with `job_output` and stops them with `job_stop`. These commands need no API key.
- **Longer commands** (0.7): `run_command` still defaults to 120 s and 10 min maximum. Raise it with `--timeout <sec>` / `--max-timeout <sec>` (up to 86400), `"timeout_sec"` / `"max_timeout_sec"` in `.syok/settings.json`, or `SYOK_MAX_TIMEOUT`. Anything longer than a few minutes belongs in a saved job.
- **General terminal mode** (0.7): `syok --general` (or `"general": true` in settings) removes the programming-only rule, so the agent can do scripts, data and file work, system setup and automation. The same safety rules apply (dangerous commands blocked, approvals by mode).
Note: a saved job lives on the machine that started it. If that machine sleeps or restarts (for example a Codespace that stops after being idle) the job stops and shows as "stopped without an exit code".

## Coding modes (v0.3)
Syok Code is specialised for programming. It knows how to check code in 30+ languages (JavaScript, TypeScript, Python, Java, C, C++, C#, Go, Rust, PHP, Ruby, Swift, Kotlin, Scala, Dart, R, Lua, Perl, Bash, PowerShell, SQL, Haskell, Elixir, Julia, Zig, Objective-C, Fortran, OCaml, Clojure, Groovy, HTML, CSS) and uses the right compiler or syntax checker to prove its own output.
- `syok gen "a function that checks a palindrome" --lang python`: plain words to working code, then it checks and runs it.
- `syok translate utils.py --to go`: same behaviour in another language, written beside the original (which is never touched); it lists anything that cannot map exactly.
- `syok debug "login fails"`: reproduces, finds the root cause, makes the smallest fix and proves it (never weakens a test).
- `syok explain app.js`: plain-language explanation; read-only.
- `syok test lib.rs`: writes and runs tests; a real bug is reported, not hidden.
In chat the same modes are `/gen`, `/translate`, `/debug`, `/explain`, `/test`. Language notes for the project are detected from files like `go.mod`, `Cargo.toml`, `package.json` and added automatically. By default it asks your Syok AI for the `syok-coder` preset, which tries your code-strong providers first (use `--model syok-auto` for normal routing). You can also pick a specific code-strong model with `--model` (for example a Qwen-Coder or DeepSeek-Coder name); open coder models get a tuned profile.

## Skills (v0.4)
A skill is a `SKILL.md` file of instructions. The AI follows it and, when the skill needs commands, runs them itself.
- Put skills in `.syok/skills/<name>/SKILL.md` (project) or `~/.syok/skills/` (all projects). Claude-style `.claude/skills/` and `~/.claude/skills/` folders work as they are.
- Like Claude Code, the AI is shown each skill's name and description and opens a fitting one by itself (unless the skill says `disable-model-invocation: true`). Switch that off with `"skills": false` in `.syok/settings.json`; `/<skill>` still works.
- `syok skills` lists them. `syok skill add <github link or owner/repo/path>` saves one. `syok skill <name> "what you want"` runs one. In chat: `/skills`, `/skill <name> <task>`, or `/<name> <task>`.
- Before it starts you see the commands the skill mentions. Each command still goes through your approval (or `--mode auto`); blocked commands (sudo, wiping a drive, curl-to-shell, forced push...) stay blocked even if a skill asks.
- A skill can list commands it needs in its header: `allowed-tools: Bash(npm test:*), Bash(git status)`. You are asked once at the start whether to allow them for that run.
- If the AI tries to finish a command-running skill without running any command, it is sent back twice; if it still does not, the result says "WARNING: the AI ran none".
- Windows: commands run in Git Bash if installed, otherwise PowerShell, otherwise Command Prompt (WSL not needed). `SYOK_SHELL=bash|powershell|cmd` forces one. GitHub tests this on a real Windows machine for every change.
- `skill-smoke` workflow (Actions tab): runs a real skill through your Syok key and checks the AI really ran the command.

## Not yet
Syncing the skills you installed on the Syok website into the CLI, and a web bridge to the Syok app. See the plan in the Syok project notes.

## New in 0.6

- **Plan mode**: `syok --mode plan` or `/plan <task>` explores read-only, writes a plan and asks before anything changes. `/mode` cycles ask, accept-edits, plan, auto.
- **Saved chats**: every chat is saved in .syok/sessions. `syok --continue`, `syok --resume 2` or `/resume` pick one up. `/compact` summarizes a long chat (this also happens by itself when it gets very long).
- **Checkpoints**: one is saved before each message. `/checkpoints`, `/rewind 3` puts every file and the chat back.
- **Instructions**: SYOK.md, AGENTS.md, CLAUDE.md, .claude/CLAUDE.md and ~/.syok/SYOK.md are all read. `/init` writes SYOK.md for you.
- **Your own commands**: .syok/commands/name.md becomes /name (`$ARGUMENTS` = what you type after it).
- **Usage history**: `syok usage` shows what Syok Code used in the last 30 days, by day, by who really answered and by project (`--days 7`, `--all`, `--by model`, `--json`). Each AI call adds one line to `~/.syok/usage/YYYY-MM.jsonl` with the time, the chat id, the project folder, the provider and model, and the token counts. The text of your messages is never in it. Switch it off with `"usage_log": false` in `~/.syok/config.json` or `.syok/settings.json`, or `SYOK_USAGE_LOG=0`.
- **Plugins**: `syok plugin browse` shows the Syok plugin list with the ones that fit this project first, and says why. `syok plugin find "my tests fail"` lets the AI pick from the list for what you describe. `syok plugin add git-helper` installs one by name; it is checked against the fingerprint of the reviewed copy before anything is written. The eight on the list (git-helper, test-writer, reviewer, docs-writer, bug-hunter, ci-starter, refactor-safe, security-check) hold instructions only: no hooks, no tool servers, nothing that runs on its own. `syok plugin add owner/repo` still installs any bundle from GitHub.
- **Claude Code plugins and marketplaces** (for example [terrylica/cc-skills](https://github.com/terrylica/cc-skills), 40 plugins, 212 skills, MIT): `syok plugin add terrylica/cc-skills` lists the plugins in a marketplace; `syok plugin add terrylica/cc-skills itp link-tools` installs those (only their own files are downloaded; add `@tag` or `@commit` to pin a version). A plugin's skills, slash commands (`/itp:go` or `/go`) and helpers work as they are: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_SKILL_DIR}`, `$ARGUMENTS`, `$0`/`$1` and `` !`command` `` are understood. Its hooks (PreToolUse, PostToolUse, Stop, UserPromptSubmit, SessionStart) and tool servers run programs on your computer, so they stay **off** until you say yes (`--with-hooks`, or later `syok plugin hooks <name> on`); when on, they get Claude Code's JSON and may refuse a command, but can never lift a permission. Plugins written for one person's Mac (launchd, SwiftBar, Keychain...) still need that Mac.
- **Pictures**: write @screenshot.png in a message, or `/image shot.png what is wrong?`.
- **GitHub**: `syok review 12` reviews a pull request (read-only); `syok pr "title"` commits to a branch and opens a pull request after you approve.
- **Scripts and CI**: `echo "task" | syok -p - --json`.
- **Isolation**: dangerous commands are always blocked; for real isolation use the Daytona sandbox (`syok sandbox start owner/repo`, then `--sandbox`). There is no Docker mode. With `--sandbox`, commands and the project check run in the sandbox's copy of your GitHub repository, and every file the AI edits is copied there too (text files up to 1 MB). The sandbox starts from what is on GitHub, so push your own uncommitted changes first if the commands need them.

## Seeing pictures (view_image and browser screenshots)
The AI can now look at pictures it made itself, not only the ones you attach with @file.png. This lets it check a chart it drew, a screenshot of the page it built, or an image a script produced, instead of guessing what it looks like.

- **`view_image`**: a new read-only tool. The AI calls it with a file in the project (`.png`, `.jpg`, `.jpeg`, `.gif` or `.webp`, at most 5 MB) and sees the picture on its next step. The same rules as @file.png apply: files outside the project folder (also through a link) are refused, and so are bigger files and files that are not pictures. It needs no approval (like `read_file`), works in plan mode, and helpers started with `delegate` can use it too.
- **Pictures from tool servers (MCP)**: when a tool server answers with a picture (an `image` block with base64 data and a png, jpeg, gif or webp type), the AI sees it the same way. This works for local servers and for hosted ones. At most 5 MB of pictures are passed on per tool result; a picture over that, or of a type that cannot be shown, is left out and the AI is told so in plain words. A hosted server's whole answer may be at most 4 MB, so its pictures must be smaller than about 3 MB.
- How it reaches the AI: a tool reply can only hold text, so the pictures follow the tool replies as one extra message with the pictures in it. Only the newest two such messages keep their pictures; older ones are replaced by a short note, so a long session does not send every screenshot again on every step.

**Browser screenshots with Playwright.** Add the Playwright tool server to `.syok/settings.json` in your project (or merge the `"playwright"` entry into the `"mcpServers"` you already have):

```json
{
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@0.0.86", "--headless", "--isolated"] }
  }
}
```

It needs Node.js (for `npx`). Its tools appear as `mcp__playwright__browser_navigate`, `mcp__playwright__browser_take_screenshot` and so on; ask for example "open http://localhost:3000, take a screenshot and check the layout". Outside `--mode auto` you are asked before each tool call, unless you add `"allow": ["mcp__playwright"]`. If it says no browser is installed, install Google Chrome, or choose another browser by adding `"--browser", "firefox"` (or `webkit`, `msedge`) to `args`.

**The one limit: the model must be able to see images.** Pictures are sent in the standard image format of `/v1/chat/completions`. A model that only reads text (or a provider that refuses images) cannot use them: it either ignores the picture or the request fails. Pick a model that accepts images when you want the AI to look at pictures.

## Licence

Syok Code is open source under the [MIT License](LICENSE), Copyright (c) 2026 Syok AI. You may use, copy, change and share it, including commercially, as long as the copyright and licence notice stay with it. The Syok name and logo are not covered by the licence.
