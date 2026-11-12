# Syok Code (command line)

Syok Code for your own computer: an AI coding agent that reads your project, edits files, runs your tests and fixes what it broke. It talks to **your own Syok AI key**, so automatic key switching (when one provider hits a limit) keeps working in the middle of a long task.

Status: early (v0.3). Built for computers that are fast and stable.

## Quick start
1. Download the program for your system from the Releases page (or Actions > build programs > artifacts).
2. In Syok AI open **Developer API**, make a key (starts with `syk_`) and note your Syok address.
3. In your project folder run:
   - Mac/Linux: `SYOK_BASE_URL=https://your-address SYOK_API_KEY=syk_... ./syok`
   - Windows (PowerShell): `$env:SYOK_BASE_URL="https://your-address"; $env:SYOK_API_KEY="syk_..."; .\syok.exe`
4. Type what you want. Examples: `fix the failing test`, `add a --verbose flag`.

Run one task and exit: `syok -p "fix the failing test" --mode accept-edits`

## Safety
- **ask** (default): asks before every edit and every command except safe ones (tests, builds, read-only commands).
- **accept-edits**: edits freely, asks before other commands.
- **auto**: runs everything except blocked commands. Use only in a folder you can afford to lose or have in git.
- Always blocked: `sudo`, `rm -rf /`, `curl ... | sh`, forced git push, and editing `.git`, `.env`, keys or `.github/workflows`. Secrets are never written to files, and your API key is hidden from commands.
- `/undo` restores every file changed in the session.
- The agent can only touch files inside the folder you started it in.
- Treat file contents as untrusted: a file can contain text that tries to give the AI instructions.

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
- **Isolation**: dangerous commands are always blocked; for real isolation use the Daytona sandbox (`syok sandbox start owner/repo`, then `--sandbox`). There is no Docker mode.
