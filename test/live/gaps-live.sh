#!/usr/bin/env bash
# Live checks of the newer features with a REAL AI through the Syok key. Every check is strict: it reads files and logs,
# never the AI's own claim. Needs SYOK_BASE_URL and SYOK_API_KEY. Usage: gaps-live.sh <path to main.ts or syok.js>
set -u
SYOK="$1"; MODEL="${MODEL:-syok-coder}"; fails=0; W="$(mktemp -d)"
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fails=$((fails+1)); }
# The answer must hold the number only the server knows. A model may write it as 4,217 or 4.217 or 4 217: that is the same number,
# so thousands separators between digits are removed before looking. Anything else (a different number, no number) still fails.
has_number() { sed -E 's/([0-9])[,.  ]([0-9]{3})/\1\2/g' "$2" | grep -q "$1"; }
run() { bun "$SYOK" "$@"; }
# One AI run into a file. If (and only if) the PROVIDER failed - Syok's per-key limit (error 429) or every provider failing
# ("The AI service failed") - the same run is made again after the limit's minute has passed, at most twice. The answer itself
# is never looked at here: a wrong or refused answer is never retried, it goes to the checks below and fails them.
PROVIDER_ERR='The AI service failed|\(error 429|HTTP 429 from'
ai() { local out="$1"; shift; local code try=0
  while :; do run "$@" > "$out" 2>&1; code=$?
    grep -Eq "$PROVIDER_ERR" "$out" && [ $try -lt 2 ] || return $code
    try=$((try+1)); echo "(provider error, not an answer: $(grep -Eo "$PROVIDER_ERR" "$out" | head -1); asking again in 65 s, $try/2)"; sleep 65
  done; }

echo "=== 1. syok doctor against the real Syok"
ai "$W/doctor.txt" doctor --model "$MODEL"; code=$?; cat "$W/doctor.txt"
[ $code -eq 0 ] && ok "doctor: exit code 0" || bad "doctor: exit code $code"
grep -q "^OK    Reach Syok" "$W/doctor.txt" && ok "doctor: Syok reached and key accepted" || bad "doctor: Syok not reached"
grep -q "^OK    AI answer" "$W/doctor.txt" && ok "doctor: a real AI answered" || bad "doctor: no AI answer"
if grep -q "$SYOK_API_KEY" "$W/doctor.txt"; then bad "doctor: the key was printed"; else ok "doctor: the key is not printed"; fi

echo "=== 2. find_symbol with a real AI, in a project where plain reading would be slow"
P="$W/sym"; mkdir -p "$P/src/a" "$P/src/b" "$P/lib"
for i in $(seq 1 40); do printf 'export function helper%s(x) {\n  return x + %s;\n}\n// computeShippingCost is mentioned in this comment only\n' "$i" "$i" > "$P/src/a/mod$i.js"; done
printf 'import { helper1 } from "../a/mod1.js";\n\n\n\n\n\nexport function computeShippingCost(weightKg, zone) {\n  return helper1(weightKg) * zone;\n}\n' > "$P/src/b/shipping.js"
printf 'import { computeShippingCost } from "../src/b/shipping.js";\nexport const quote = (w) => computeShippingCost(w, 3);\n' > "$P/lib/quote.js"
ai "$W/sym.txt" --cwd "$P" --mode plan --model "$MODEL" -p "In which file and on which line is the function computeShippingCost defined, and which other file uses it? Answer with the exact paths and the line number."; cat "$W/sym.txt" | tail -25
grep -q "> find_symbol" "$W/sym.txt" && ok "find_symbol: the AI used the tool" || bad "find_symbol: the AI did not use the tool"
grep -q "src/b/shipping.js" "$W/sym.txt" && grep -Eq "(line|:) ?7\b" "$W/sym.txt" && ok "find_symbol: right file and line 7 in the answer" || bad "find_symbol: the answer lacks src/b/shipping.js line 7"
grep -q "lib/quote.js" "$W/sym.txt" && ok "find_symbol: the using file is named" || bad "find_symbol: lib/quote.js not named"

echo "=== 3. a custom read-only helper with a real AI"
P="$W/agent"; mkdir -p "$P/.syok/agents" "$P/src"
printf -- '---\ndescription: Reviews one file for bugs and reports them. Read-only.\ntools: read, search\n---\nYou are a strict code reviewer. Read the file you are given and report each real bug with its line number. Start your answer with the words REVIEW-REPORT.\n' > "$P/.syok/agents/reviewer.md"
printf 'function average(nums) {\n  let sum = 0;\n  for (let i = 0; i <= nums.length; i++) sum += nums[i];\n  return sum / nums.length;\n}\nmodule.exports = { average };\n' > "$P/src/stats.js"
cp "$P/src/stats.js" "$W/stats.before"
run agents --cwd "$P" | tee "$W/agents.txt"; grep -q "reviewer  \[read-only\]" "$W/agents.txt" && ok "helper: listed as read-only" || bad "helper: not listed as read-only"
ai "$W/agent.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Hand src/stats.js to the reviewer helper (use delegate with role reviewer) and tell me what it reports. Do not change any file."; tail -30 "$W/agent.txt"
grep -q "\[reviewer\]" "$W/agent.txt" && ok "helper: the reviewer helper really ran" || bad "helper: the reviewer helper did not run"
cmp -s "$P/src/stats.js" "$W/stats.before" && ok "helper: the file is unchanged" || bad "helper: the file was changed"
grep -Eqi "<=|off.by.one|out of (bounds|range)|undefined|NaN|line 3" "$W/agent.txt" && ok "helper: the planted bug was reported" || bad "helper: the planted bug was not reported"

echo "=== 4. a hosted tool server with a real AI"
P="$W/mcp"; mkdir -p "$P/.syok"; export STANDIN_KEY="live-$RANDOM-$RANDOM" STANDIN_PORT=8791 STANDIN_LOG="$W/standin.log"
bun "$(dirname "$0")/mcp-standin.ts" > "$W/standin.out" 2>&1 & SP=$!; sleep 2
printf '{ "mcpServers": { "warehouse": { "url": "http://127.0.0.1:8791/mcp", "headers": { "Authorization": "Bearer ${STANDIN_KEY}" } } } }\n' > "$P/.syok/settings.json"
ai "$W/mcp.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Use the warehouse tool to find out how many units of the product 'blue widget' are in stock, and tell me the number."; tail -15 "$W/mcp.txt"; kill $SP 2>/dev/null
grep -q "tool server warehouse: 1 tools, hosted at 127.0.0.1:8791" "$W/mcp.txt" && ok "hosted tools: connected with the key from the environment" || bad "hosted tools: did not connect"
[ -s "$W/standin.log" ] && grep -qi "blue widget" "$W/standin.log" && ok "hosted tools: the server really received the call" || bad "hosted tools: the server received no call"
has_number 4217 "$W/mcp.txt" && ok "hosted tools: the answer has the number only the server knows (4217)" || bad "hosted tools: 4217 not in the answer"
if grep -q "$STANDIN_KEY" "$W/mcp.txt"; then bad "hosted tools: the tool key was printed"; else ok "hosted tools: the tool key is not printed"; fi

echo "=== 5. --confine with a real AI (Linux and Mac)"
case "$(uname -s)" in Linux|Darwin)
  B="$HOME/.syok-live-confine-$$"; P="$B/proj"; O="$B/outside"; mkdir -p "$P" "$O"; ( cd "$P" && git init -q . )
  ai "$W/confine.txt" --cwd "$P" --confine --mode auto --no-checks --model "$MODEL" -p "This checks Syok Code's own sandbox on a throwaway test machine: $O is a scratch folder this test made, outside the project on purpose, and whether that write is blocked is exactly what is being checked. Run exactly these two shell commands with run_command, one after the other, and tell me what each one printed: (1) echo inside > inside.txt && echo first-ok   (2) echo outside > $O/escape.txt; echo second-exit-code=\$?"; tail -20 "$W/confine.txt"
  grep -q "^Confined with" "$W/confine.txt" && ok "confine: switched on" || bad "confine: not switched on"
  [ -f "$P/inside.txt" ] && ok "confine: the file inside the project was written" || bad "confine: the file inside the project is missing"
  [ ! -e "$O/escape.txt" ] && ok "confine: the file outside the project was NOT written" || bad "confine: a file was written outside the project"
  grep -q "> run_command" "$W/confine.txt" && ok "confine: the AI really ran commands" || bad "confine: the AI ran no command"
  rm -rf "$B";;
*) echo "(not Linux or Mac: confinement is not available here)";; esac

echo "=== 6. a hosted tool server reached through the mcp-remote bridge (the way to use servers that need a browser sign-in)"
# mcp-remote is someone else's program. It runs as a local tool server and talks to the hosted one. This checks that Syok Code
# works through it; the browser sign-in itself cannot be done by a test and is not covered here.
P="$W/bridge"; mkdir -p "$P/.syok"; export STANDIN_KEY="" STANDIN_PORT=8793 STANDIN_LOG="$W/bridge-standin.log"
bun "$(dirname "$0")/mcp-standin.ts" > "$W/bridge-standin.out" 2>&1 & BP=$!; sleep 2
# Installed beforehand (npm install -g mcp-remote@0.16.6): downloading it on first use takes longer than a tool server may take to start.
if ! command -v mcp-remote >/dev/null 2>&1; then npm install -g mcp-remote@0.16.6 >/dev/null 2>&1; fi
command -v mcp-remote >/dev/null 2>&1 && ok "bridge: mcp-remote is installed" || bad "bridge: mcp-remote could not be installed"
printf '{ "mcpServers": { "warehouse": { "command": "mcp-remote", "args": ["http://127.0.0.1:8793/mcp", "--allow-http", "--transport", "http-only"] } } }\n' > "$P/.syok/settings.json"
ai "$W/bridge.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Use the warehouse tool to find out how many units of the product 'red gadget' are in stock, and tell me the number."; grep "tool server" "$W/bridge.txt"; tail -8 "$W/bridge.txt"
grep -q "could not start" "$W/bridge.txt" && { echo "--- mcp-remote by itself:"; (printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n'; sleep 8) | mcp-remote http://127.0.0.1:8793/mcp --allow-http --transport http-only 2>&1 | tail -15; }
grep -q "tool server warehouse: 1 tools" "$W/bridge.txt" && ok "bridge: Syok Code connected through mcp-remote" || bad "bridge: did not connect through mcp-remote"
[ -s "$W/bridge-standin.log" ] && grep -qi "red gadget" "$W/bridge-standin.log" && ok "bridge: the hosted server really received the call" || bad "bridge: the hosted server received no call"
has_number 4217 "$W/bridge.txt" && ok "bridge: the answer has the number only the server knows (4217)" || bad "bridge: 4217 not in the answer"
kill $BP 2>/dev/null

echo "=== 7. parallel editing with a real AI: three workers, each in its own copy of the project, joined afterwards"
PP="$W/par"; mkdir -p "$PP/src" "$PP/test"
for m in area volume speed; do printf 'export function %s(a, b) {\n  return 0; // TODO\n}\n' "$m" > "$PP/src/$m.js"; done
printf 'import { area } from "../src/area.js"; import { volume } from "../src/volume.js"; import { speed } from "../src/speed.js";\nconst eq = (a, b, n) => { if (a !== b) { console.error("FAIL " + n + ": got " + a + ", want " + b); process.exit(1); } };\neq(area(3, 4), 12, "area"); eq(volume(2, 5), 10, "volume"); eq(speed(100, 4), 25, "speed");\nconsole.log("all three pass");\n' > "$PP/test/all.mjs"
printf '{ "name": "par", "type": "module", "scripts": { "test": "node test/all.mjs" } }\n' > "$PP/package.json"
( cd "$PP" && git init -q -b main . && git -c user.email=t@example.com -c user.name=T add -A && git -c user.email=t@example.com -c user.name=T commit -q -m first )
HEAD_BEFORE="$(cd "$PP" && git rev-parse HEAD)"
run --cwd "$PP" --mode auto --model "$MODEL" -p "Three functions return 0 and need a real body. Use the parallel_edit tool with exactly three tasks, one per file, so three workers do them at the same time: (1) name area: in src/area.js make area(a, b) return a times b. (2) name volume: in src/volume.js make volume(a, b) return a times b. (3) name speed: in src/speed.js make speed(a, b) return a divided by b. Each worker changes only its own file. When they are joined, run npm test yourself and report." > "$W/par.txt" 2>&1; tail -30 "$W/par.txt"
grep -q "> parallel_edit" "$W/par.txt" && ok "parallel: the AI used parallel_edit" || bad "parallel: the AI did not use parallel_edit"
n=$(grep -c "started in its own copy" "$W/par.txt"); [ "$n" -eq 3 ] && ok "parallel: three workers started, each in its own copy" || bad "parallel: $n workers started, wanted 3"
( cd "$PP" && node test/all.mjs ) > "$W/par-test.txt" 2>&1 && ok "parallel: the joined project passes its test (checked by this script, not by the AI)" || { bad "parallel: the joined project fails its test"; cat "$W/par-test.txt"; }
# .syok/ holds Syok Code's own record of this chat (so it can be resumed); it is not part of the project's work
changed="$(cd "$PP" && git status --porcelain -- . ':(exclude).syok' | sed 's/^...//' | sort | tr '\n' ' ')"
[ "$changed" = "src/area.js src/speed.js src/volume.js " ] && ok "parallel: exactly the three files changed" || bad "parallel: changed files were: $changed"
[ "$(cd "$PP" && git rev-parse HEAD)" = "$HEAD_BEFORE" ] && ok "parallel: no commit was made on your branch" || bad "parallel: the branch moved"
[ "$(cd "$PP" && git worktree list | wc -l | tr -d ' ')" = "1" ] && [ -z "$(ls -A "$PP/.git/syok-parallel" 2>/dev/null)" ] && ok "parallel: no copy was left behind" || bad "parallel: a copy was left behind"

REPO="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== 8. confinement is ON without asking (Linux and Mac), with a real AI"
case "$(uname -s)" in Linux|Darwin)
  B="$HOME/.syok-live-default-$$"; P="$B/proj"; O="$B/outside"; mkdir -p "$P" "$O"
  ai "$W/default.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "This checks Syok Code's own sandbox on a throwaway test machine: $O is a scratch folder this test made, outside the project on purpose, and whether that write is blocked is exactly what is being checked. Run exactly these two shell commands with run_command, one after the other, and tell me what each one printed: (1) echo inside > inside.txt && echo first-ok   (2) echo outside > $O/escape.txt; echo second-exit-code=\$?"; tail -12 "$W/default.txt"
  grep -q "^Confined with" "$W/default.txt" && grep -q "On by default" "$W/default.txt" && ok "default: confined without any flag" || bad "default: not confined without a flag"
  [ -f "$P/inside.txt" ] && ok "default: the file inside the project was written" || bad "default: the file inside the project is missing"
  [ ! -e "$O/escape.txt" ] && ok "default: the file outside the project was NOT written" || bad "default: a file was written outside the project"
  ai "$W/default-off.txt" --cwd "$P" --no-confine --mode auto --no-checks --model "$MODEL" -p "This checks that Syok Code's --no-confine switch really turns its sandbox off, on a throwaway test machine: $O is a scratch folder this test made, outside the project on purpose. Run exactly this shell command with run_command and tell me what it printed: echo outside > $O/escape2.txt; echo exit-code=\$?"
  [ -e "$O/escape2.txt" ] && ! grep -q "^Confined with" "$W/default-off.txt" && ok "default: --no-confine really switches it off" || { bad "default: --no-confine did not switch it off"; tail -15 "$W/default-off.txt"; }
  rm -rf "$B";;
*) echo "(not Linux or Mac)";; esac

echo "=== 9. a language helper with a real AI: exact uses, then a compiler error found and fixed without running anything"
LS="$REPO/node_modules/.bin/typescript-language-server"
if [ -x "$LS" ]; then
  P="$W/lsp"; mkdir -p "$P/src" "$P/.syok"
  printf '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler", "noEmit": true }, "include": ["src"] }\n' > "$P/tsconfig.json"
  printf 'export function greet(name: string): string { return "hi " + name; }\nexport class Box {\n  value = 1;\n  greet() { return 2; }\n}\n' > "$P/src/a.ts"
  printf 'import { greet, Box } from "./a";\nconst x: number = greet("y");\nexport const n = new Box().greet();\nexport { x };\n' > "$P/src/b.ts"
  printf '{ "lsp": { "typescript": { "command": "%s", "args": ["--stdio"] } } }\n' "$LS" > "$P/.syok/settings.json"
  ( cd "$P" && "$REPO/node_modules/.bin/tsc" -p . > "$W/lsp-before.txt" 2>&1 ) && bad "lsp: the planted type error is not there" || ok "lsp: the project starts with a type error (checked with the real compiler)"
  ai "$W/lsp.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Use the lsp tool for this, not search and not commands. First, with action diagnostics, find the compiler error in src/b.ts. Then fix it by changing only the type written on that line of src/b.ts. Then check with lsp diagnostics again that the file has no problems. Finally, with action references, tell me how many places refer to the FUNCTION greet that is defined on line 1 of src/a.ts."; tail -25 "$W/lsp.txt"
  grep -q '> lsp {"action":"diagnostics"' "$W/lsp.txt" && ok "lsp: the AI asked the helper for the compiler's errors" || bad "lsp: the AI did not use lsp diagnostics"
  grep -q '> lsp {"action":"references"' "$W/lsp.txt" && ok "lsp: the AI asked the helper for the uses" || bad "lsp: the AI did not use lsp references"
  ( cd "$P" && "$REPO/node_modules/.bin/tsc" -p . > "$W/lsp-after.txt" 2>&1 ) && ok "lsp: the real compiler now reports no error (checked by this script)" || { bad "lsp: the compiler still reports an error"; cat "$W/lsp-after.txt"; }
  [ "$(cat "$P/src/a.ts" | wc -l | tr -d ' ')" = "5" ] && grep -q 'export function greet(name: string): string' "$P/src/a.ts" && ok "lsp: src/a.ts was left alone" || bad "lsp: src/a.ts was changed"
else echo "(typescript-language-server is not in node_modules: skipped)"; bad "lsp: the helper for the check is missing"; fi

echo "=== 10. memory across two chats with a real AI"
export SYOK_MEMORY_DIR="$W/memory"; P="$W/mem"; mkdir -p "$P"; printf 'nothing here says how tests are run\n' > "$P/README.md"
ai "$W/mem1.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "For later chats, save this fact about this project with the remember tool, then finish: the fast tests are run with the command make quick-check-77"; tail -6 "$W/mem1.txt"
grep -q "> remember" "$W/mem1.txt" && ok "memory: the AI used the remember tool" || bad "memory: the AI did not use the remember tool"
grep -rqs "quick-check-77" "$SYOK_MEMORY_DIR/projects" && ok "memory: the note is in the memory folder" || bad "memory: no note was saved"
[ "$(ls -A "$P" | grep -v '^\.syok$' | tr '\n' ' ')" = "README.md " ] && ok "memory: nothing was written into the project" || bad "memory: the project folder changed: $(ls -A "$P" | tr '\n' ' ')"
ai "$W/mem2.txt" --cwd "$P" --no-checks --no-web --model "$MODEL" -p "Do not read, list or search any file. From what you already know: which exact command runs the fast tests in this project? Answer in one line."; tail -6 "$W/mem2.txt"
grep -q "quick-check-77" "$W/mem2.txt" && ok "memory: a NEW chat knows the fact" || bad "memory: the new chat does not know the fact"
if grep -qE "^> (read_file|search|list_files|find_files|run_command)" "$W/mem2.txt"; then bad "memory: the new chat looked in the files instead"; else ok "memory: the new chat answered without looking in any file"; fi
ai "$W/mem3.txt" --cwd "$P" --no-memory --no-checks --no-web --model "$MODEL" -p "Do not read, list or search any file. From what you already know: which exact command runs the fast tests in this project? If you do not know, say exactly: I do not know."
if grep -q "quick-check-77" "$W/mem3.txt"; then bad "memory: --no-memory still gave the note to the AI"; else ok "memory: with --no-memory the AI is not given the note"; fi
unset SYOK_MEMORY_DIR

echo "=== 11. browser sign-in to a hosted tool server, then a real AI uses it"
AH="$W/authhome"; mkdir -p "$AH"; P="$W/oauth"; mkdir -p "$P/.syok"
export OAUTH_STANDIN_PORT=8793 OAUTH_STANDIN_NUMBER=5309 OAUTH_STANDIN_LOG="$W/oauth-standin.log"
bun "$(dirname "$0")/oauth-standin.ts" > "$W/oauth-standin.out" 2>&1 & OP=$!; sleep 2
printf '{ "mcpServers": { "vault": { "url": "http://127.0.0.1:8793/mcp" } } }\n' > "$P/.syok/settings.json"
HOME="$AH" ai "$W/oauth-before.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Say hello."
grep -q "it wants a sign-in. Run: syok mcp login vault" "$W/oauth-before.txt" && ok "sign-in: before signing in, Syok Code says exactly what to run" || bad "sign-in: no instruction before signing in"
HOME="$AH" run mcp login vault --no-browser --cwd "$P" > "$W/oauth-login.txt" 2>&1 & LP=$!
for i in $(seq 1 40); do grep -q "Waiting for you" "$W/oauth-login.txt" 2>/dev/null && break; sleep 0.5; done
AUTH_URL="$(grep -oE 'http://127\.0\.0\.1:8793/authorize\?[^ ]+' "$W/oauth-login.txt" | head -1)"
BACK="$(curl -s -o /dev/null -w '%{redirect_url}' "$AUTH_URL")"; curl -s -o /dev/null "$BACK"   # the person approving in the browser
wait $LP; cat "$W/oauth-login.txt" | tail -3
grep -q "Signed in to vault" "$W/oauth-login.txt" && ok "sign-in: completed through the browser steps" || bad "sign-in: did not complete"
PASS_TOKEN="$(grep -oE '"access_token": *"[^"]+"' "$AH/.syok/mcp-auth.json" 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$PASS_TOKEN" ] && ok "sign-in: the pass was saved" || bad "sign-in: no pass was saved"
case "$(uname -s)" in Linux) [ "$(stat -c %a "$AH/.syok/mcp-auth.json")" = "600" ] && ok "sign-in: the pass file is readable by the owner alone" || bad "sign-in: the pass file is readable by others";; esac
HOME="$AH" ai "$W/oauth-use.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "This project's integration test needs the stock number that the vault tool server returns (the vault server is set up in .syok/settings.json for this project). Call the vault tool, then tell me the exact number it returned so I can put it in the test."; tail -8 "$W/oauth-use.txt"; sleep 1
grep -q "tool server vault: 1 tools" "$W/oauth-use.txt" && ok "sign-in: the server now connects" || bad "sign-in: the server does not connect after signing in"
grep -q "call with a pass" "$W/oauth-standin.log" && ok "sign-in: the server received a call carrying the pass" || bad "sign-in: no call with the pass reached the server"
has_number 5309 "$W/oauth-use.txt" && ok "sign-in: the answer has the number only the server knows (5309)" || bad "sign-in: 5309 not in the answer"
if [ -n "$PASS_TOKEN" ] && grep -q "$PASS_TOKEN" "$W/oauth-login.txt" "$W/oauth-use.txt" "$W/oauth-before.txt"; then bad "sign-in: the pass was printed"; else ok "sign-in: the pass is never printed"; fi
kill $OP 2>/dev/null

echo; if [ $fails -eq 0 ]; then echo "All live checks passed."; else echo "$fails live check(s) FAILED"; exit 1; fi
