# Syok Code (command line)

Syok Code for your own computer: an AI coding agent that reads your project, edits files, runs your tests and fixes what it broke. It talks to **your own Syok AI key**, so automatic key switching (when one provider hits a limit) keeps working in the middle of a long task.

Status: early (v0.12). Built for computers that are fast and stable.

## Quick start
1. Install (one line; you do not need to install anything else first):
   - Mac/Linux: `curl -fsSL https://syok-ai.com/syok-code/install.sh | sh`
   - Windows (PowerShell): `irm https://syok-ai.com/syok-code/install.ps1 | iex`

   Everything goes into the `.syok` folder in your home folder: a private copy of the Bun runtime, the one-file program and the `syok` command. Both downloads are checked against their published checksums. Run the same line again, or `syok update`, to get the newest version.
2. In Syok AI open **Developer API**, make a key (starts with `syk_`) and note your Syok address.
3. In your project folder run:
   - Mac/Linux: `SYOK_BASE_URL=https://your-address SYOK_API_KEY=syk_... syok`
   - Windows (PowerShell): `$env:SYOK_BASE_URL="https://your-address"; $env:SYOK_API_KEY="syk_..."; syok`
4. Type what you want. Examples: `fix the failing test`, `add a --verbose flag`.

Other ways to get it: if you already have Bun, download `syok.js` and run `bun syok.js`. Self-contained programs (no runtime folder) are built by Actions > build programs.

Run one task and exit: `syok -p "fix the failing test" --mode accept-edits`

## Safety
- **ask** (default): asks before every edit and every command except safe ones (tests, builds, read-only commands).
- **accept-edits**: edits freely, asks before other commands.
- **auto**: runs everything except blocked commands. Use only in a folder you can afford to lose or have in git.
- Always blocked: `sudo`, `rm -rf /`, `curl ... | sh`, forced git push, and editing `.git`, `.env`, keys or `.github/workflows`. Secrets are never written to files, and your API key is hidden from commands.
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
- Commands the AI runs never see the GitHub token, your Syok key or other keys. The AI cannot edit `.github/workflows`.
- A pull request from a fork is answered but never changed.
- `.env` files and key files are never committed.

Limits: a pull request opened this way does not start your other workflows by itself (a GitHub rule for its built-in token). Each request uses your Syok key and GitHub Actions minutes, up to 30 minutes.

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
- Put skills in `.syok/skills/<name>/SKILL.md` (project) or `~/.syok/skills/` (all projects). Claude-style `.claude/skills/` folders work as they are.
- `syok skills` lists them. `syok skill add <github link or owner/repo/path>` saves one. `syok skill <name> "what you want"` runs one. In chat: `/skills`, `/skill <name> <task>`, or `/<name> <task>`.
- Before it starts you see the commands the skill mentions. Each command still goes through your approval (or `--mode auto`); blocked commands (sudo, wiping a drive, curl-to-shell, forced push...) stay blocked even if a skill asks.
- A skill can list commands it needs in its header: `allowed-tools: Bash(npm test:*), Bash(git status)`. You are asked once at the start whether to allow them for that run.
- If the AI tries to finish a command-running skill without running any command, it is sent back twice; if it still does not, the result says "WARNING: the AI ran none".
- Windows: commands run in Git Bash if installed, otherwise PowerShell, otherwise Command Prompt (WSL not needed). `SYOK_SHELL=bash|powershell|cmd` forces one. GitHub tests this on a real Windows machine for every change.
- `skill-smoke` workflow (Actions tab): runs a real skill through your Syok key and checks the AI really ran the command.

## Not yet
Interactive terminals (programs that wait for typed input), syncing the skills you installed on the Syok website into the CLI, and a web bridge to the Syok app. See the plan in the Syok project notes.

## New in 0.6

- **Plan mode**: `syok --mode plan` or `/plan <task>` explores read-only, writes a plan and asks before anything changes. `/mode` cycles ask, accept-edits, plan, auto.
- **Saved chats**: every chat is saved in .syok/sessions. `syok --continue`, `syok --resume 2` or `/resume` pick one up. `/compact` summarizes a long chat (this also happens by itself when it gets very long).
- **Checkpoints**: one is saved before each message. `/checkpoints`, `/rewind 3` puts every file and the chat back.
- **Instructions**: SYOK.md, AGENTS.md, CLAUDE.md, .claude/CLAUDE.md and ~/.syok/SYOK.md are all read. `/init` writes SYOK.md for you.
- **Your own commands**: .syok/commands/name.md becomes /name (`$ARGUMENTS` = what you type after it).
- **Plugins**: `syok plugin add owner/repo` installs a bundle of skills, commands and hooks.
- **Pictures**: write @screenshot.png in a message, or `/image shot.png what is wrong?`.
- **GitHub**: `syok review 12` reviews a pull request (read-only); `syok pr "title"` commits to a branch and opens a pull request after you approve.
- **Scripts and CI**: `echo "task" | syok -p - --json`.
- **Isolation**: dangerous commands are always blocked; for real isolation use the Daytona sandbox (`syok sandbox start owner/repo`, then `--sandbox`). There is no Docker mode. With `--sandbox`, commands and the project check run in the sandbox's copy of your GitHub repository, and every file the AI edits is copied there too (text files up to 1 MB). The sandbox starts from what is on GitHub, so push your own uncommitted changes first if the commands need them.
