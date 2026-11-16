# Syok Code for VS Code

Runs [Syok Code](https://syok-ai.com/syok-code/), the AI coding agent that works on your own Syok keys, inside the editor.

It is a thin layer: every command starts the `syok` command-line program in the editor's own terminal, in your project folder. The program does the work and asks you before changes and commands, exactly as it does in a normal terminal.

## Commands (Ctrl+Shift+P, then type "Syok")
- **Syok Code: Open chat** - start a chat in this project.
- **Syok Code: Give it a task...** (Ctrl+Alt+S, or the "Syok" button in the status bar) - type what you want done.
- **Syok Code: Ask about the selected code...** - select code, right-click, ask or tell it what to change.
- **Syok Code: Fix the problems in this file** - sends the errors and warnings the editor shows for the open file.
- **Syok Code: Install or update the command-line program** - shows the one-line installer and runs it in a terminal if you agree.

## Setup
1. Install the command-line program, version 0.13 or newer (the last command above does it; `syok update` updates an older one).
2. Give it your Syok address and key once, as described on the Syok Code page (`SYOK_BASE_URL` and `SYOK_API_KEY`, or the file `.syok/config.json` in your home folder). This extension never reads or stores your key.

## Settings
- `syokCode.mode`: how much it may do without asking (ask, accept-edits, plan, auto). Default: ask.
- `syokCode.model`, `syokCode.extraArguments`, `syokCode.path`.
