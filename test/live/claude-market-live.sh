#!/usr/bin/env bash
# Claude Code plugin marketplaces, live: the real terrylica/cc-skills marketplace on GitHub (pinned to one commit), and a
# REAL AI using a Claude-format plugin: a skill it opens by itself, ${CLAUDE_PLUGIN_ROOT}, a plugin skill started by name,
# and a Claude-style hook that refuses a command. Every check reads files and logs, never the AI's own claim.
# Needs SYOK_BASE_URL and SYOK_API_KEY (and GITHUB_TOKEN in CI, for GitHub's download limit). Usage: claude-market-live.sh <main.ts or syok.js>
set -u
SYOK="$1"; MODEL="${MODEL:-syok-coder}"; fails=0; W="$(mktemp -d)"
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fails=$((fails+1)); }
run() { bun "$SYOK" "$@"; }
newrepo() { mkdir -p "$1"; git -C "$1" init -q -b main; git -C "$1" config user.email t@example.com; git -C "$1" config user.name T; printf '.syok/\n' > "$1/.gitignore"; }
PIN="90d4cb7832d5dc2e2763fc596c2c0fcea0764d7c"   # terrylica/cc-skills, 19 Nov 2026

echo "=== 1. the real cc-skills marketplace on GitHub"
P="$W/real"; newrepo "$P"
( cd "$P" && run plugin add "terrylica/cc-skills@$PIN" ) > "$W/list.txt" 2>&1; head -5 "$W/list.txt"
n=$(grep -cE '^  [a-z0-9-]+ +' "$W/list.txt")
[ "$n" -ge 30 ] && ok "list: $n plugins shown" || bad "list: only $n plugins shown"
grep -q "^  itp " "$W/list.txt" && grep -q "^  link-tools " "$W/list.txt" && ok "list: itp and link-tools are in it" || bad "list: itp or link-tools missing"
( cd "$P" && run plugin add "terrylica/cc-skills@$PIN" link-tools crucible gh-tools ) > "$W/add.txt" 2>&1; cat "$W/add.txt"
[ -f "$P/.syok/plugins/link-tools/skills/link-validator/SKILL.md" ] && ok "install: link-tools skill files are there" || bad "install: link-tools skill missing"
[ "$(ls "$P/.syok/plugins/crucible/skills" | wc -l | tr -d ' ')" = "5" ] && ok "install: crucible has its 5 skills" || bad "install: crucible skills wrong"
[ ! -d "$P/.syok/plugins/itp" ] && ok "install: only the plugins asked for" || bad "install: an unasked plugin was installed"
grep -q "$PIN" "$P/.syok/plugins/link-tools/plugin.json" && ok "install: pinned to the commit asked for" || bad "install: the version is not recorded"
[ -f "$P/.syok/plugins/gh-tools/claude-hooks.off.json" ] && [ ! -f "$P/.syok/plugins/gh-tools/settings.json" ] && ok "install: gh-tools hooks are OFF without a yes" || bad "install: gh-tools hooks were switched on without a yes"
( cd "$P" && run skills ) > "$W/skills.txt" 2>&1
grep -q "link-validator  (plugin link-tools)" "$W/skills.txt" && ok "skills: plugin skills are listed" || bad "skills: plugin skills not listed"

echo "=== 2. a real AI opens a fitting plugin skill by itself; \${CLAUDE_PLUGIN_ROOT} points at the plugin"
M="$W/market"; mkdir -p "$M/.claude-plugin" "$M/plugins/stamper/skills/project-stamp" "$M/plugins/stamper/scripts" "$M/plugins/stamper/hooks" "$M/plugins/stamper/commands"
SECRET="stamp-$RANDOM$RANDOM"
printf '{"name":"live-market","owner":{"name":"syok-test"},"plugins":[{"name":"stamper","description":"Project stamps","source":"./plugins/stamper"}]}\n' > "$M/.claude-plugin/marketplace.json"
mkdir -p "$M/plugins/stamper/.claude-plugin"; printf '{"name":"stamper","version":"1.0.0"}\n' > "$M/plugins/stamper/.claude-plugin/plugin.json"
printf -- '---\nname: project-stamp\ndescription: Stamp a project with its official build stamp (writes STAMP.txt). Use whenever the user asks to stamp the project.\n---\nRun this one command from the project folder, exactly as written:\n\n```bash\nnode "${CLAUDE_PLUGIN_ROOT}/scripts/stamp.js"\n```\n\nIt writes STAMP.txt. Do not write STAMP.txt yourself.\n' > "$M/plugins/stamper/skills/project-stamp/SKILL.md"
printf "require('fs').writeFileSync('STAMP.txt', '%s\\\\n'); console.log('stamped');\n" "$SECRET" > "$M/plugins/stamper/scripts/stamp.js"
printf '{"hooks":{"PreToolUse":[{"matcher":"Bash|Write|Edit","hooks":[{"type":"command","command":"node \\"${CLAUDE_PLUGIN_ROOT}/hooks/guard.js\\""}]}]}}\n' > "$M/plugins/stamper/hooks/hooks.json"
printf "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);if(JSON.stringify(i.tool_input).includes('forbidden-word'))console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'stamper guard: forbidden-word is not allowed'}}));});\n" > "$M/plugins/stamper/hooks/guard.js"
P="$W/stamp"; newrepo "$P"; echo "# demo" > "$P/README.md"
( cd "$P" && run plugin add "$M" stamper --with-hooks ) > "$W/add2.txt" 2>&1; cat "$W/add2.txt"
grep -q "Hooks and tool servers are ON" "$W/add2.txt" && ok "local market: installed with hooks on (--with-hooks)" || bad "local market: hooks not on"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Stamp this project, please." > "$W/stamp.txt" 2>&1; tail -20 "$W/stamp.txt"
grep -q "> skill" "$W/stamp.txt" && ok "auto skill: the AI opened a skill by itself" || bad "auto skill: the AI did not open a skill"
grep -q "stamp.js" "$W/stamp.txt" && grep -q "> run_command" "$W/stamp.txt" && ok "auto skill: the AI ran the plugin's own script" || bad "auto skill: the plugin's script was not run"
[ "$(cat "$P/STAMP.txt" 2>/dev/null)" = "$SECRET" ] && ok "auto skill: STAMP.txt holds what only the plugin's script knows" || bad "auto skill: STAMP.txt is missing or wrong"

echo "=== 3. the same skill started by name, as <plugin>:<skill>"
rm -f "$P/STAMP.txt"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" skill stamper:project-stamp > "$W/byname.txt" 2>&1; tail -8 "$W/byname.txt"
[ "$(cat "$P/STAMP.txt" 2>/dev/null)" = "$SECRET" ] && ok "by name: stamper:project-stamp did its job" || bad "by name: STAMP.txt is missing or wrong"

echo "=== 4. a Claude-style PreToolUse hook refuses a command"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Run exactly this shell command and nothing else: echo forbidden-word > BLOCKED.txt  Then tell me what happened." > "$W/hook.txt" 2>&1; tail -12 "$W/hook.txt"
[ ! -f "$P/BLOCKED.txt" ] && ok "hook: the refused command did not run" || bad "hook: BLOCKED.txt exists, the hook did not stop it"
grep -q "stamper guard: forbidden-word is not allowed" "$W/hook.txt" && ok "hook: its reason reached the AI" || bad "hook: the reason is not in the log"
( cd "$P" && run plugin hooks stamper off ) > /dev/null 2>&1
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Run exactly this shell command and nothing else: echo forbidden-word > BLOCKED.txt" > "$W/hook2.txt" 2>&1
[ -f "$P/BLOCKED.txt" ] && ok "hook: switched off, it no longer stops anything" || bad "hook: still blocking after syok plugin hooks stamper off"

echo; echo "$fails failed"; [ "$fails" -eq 0 ]
