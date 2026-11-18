#!/usr/bin/env bash
# Live checks of the 0.14 features with a REAL AI through the Syok key. Every check is strict: it reads files and logs,
# never the AI's own claim. Needs SYOK_BASE_URL and SYOK_API_KEY. Usage: gaps-live.sh <path to main.ts or syok.js>
set -u
SYOK="$1"; MODEL="${MODEL:-syok-coder}"; fails=0; W="$(mktemp -d)"
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fails=$((fails+1)); }
# The answer must hold the number only the server knows. A model may write it as 4,217 or 4.217 or 4 217: that is the same number,
# so thousands separators between digits are removed before looking. Anything else (a different number, no number) still fails.
has_number() { sed -E 's/([0-9])[,.  ]([0-9]{3})/\1\2/g' "$2" | grep -q "$1"; }
run() { bun "$SYOK" "$@"; }

echo "=== 1. syok doctor against the real Syok"
run doctor --model "$MODEL" > "$W/doctor.txt" 2>&1; code=$?; cat "$W/doctor.txt"
[ $code -eq 0 ] && ok "doctor: exit code 0" || bad "doctor: exit code $code"
grep -q "^OK    Reach Syok" "$W/doctor.txt" && ok "doctor: Syok reached and key accepted" || bad "doctor: Syok not reached"
grep -q "^OK    AI answer" "$W/doctor.txt" && ok "doctor: a real AI answered" || bad "doctor: no AI answer"
if grep -q "$SYOK_API_KEY" "$W/doctor.txt"; then bad "doctor: the key was printed"; else ok "doctor: the key is not printed"; fi

echo "=== 2. find_symbol with a real AI, in a project where plain reading would be slow"
P="$W/sym"; mkdir -p "$P/src/a" "$P/src/b" "$P/lib"
for i in $(seq 1 40); do printf 'export function helper%s(x) {\n  return x + %s;\n}\n// computeShippingCost is mentioned in this comment only\n' "$i" "$i" > "$P/src/a/mod$i.js"; done
printf 'import { helper1 } from "../a/mod1.js";\n\n\n\n\n\nexport function computeShippingCost(weightKg, zone) {\n  return helper1(weightKg) * zone;\n}\n' > "$P/src/b/shipping.js"
printf 'import { computeShippingCost } from "../src/b/shipping.js";\nexport const quote = (w) => computeShippingCost(w, 3);\n' > "$P/lib/quote.js"
run --cwd "$P" --mode plan --model "$MODEL" -p "In which file and on which line is the function computeShippingCost defined, and which other file uses it? Answer with the exact paths and the line number." > "$W/sym.txt" 2>&1; cat "$W/sym.txt" | tail -25
grep -q "> find_symbol" "$W/sym.txt" && ok "find_symbol: the AI used the tool" || bad "find_symbol: the AI did not use the tool"
grep -q "src/b/shipping.js" "$W/sym.txt" && grep -Eq "(line|:) ?7\b" "$W/sym.txt" && ok "find_symbol: right file and line 7 in the answer" || bad "find_symbol: the answer lacks src/b/shipping.js line 7"
grep -q "lib/quote.js" "$W/sym.txt" && ok "find_symbol: the using file is named" || bad "find_symbol: lib/quote.js not named"

echo "=== 3. a custom read-only helper with a real AI"
P="$W/agent"; mkdir -p "$P/.syok/agents" "$P/src"
printf -- '---\ndescription: Reviews one file for bugs and reports them. Read-only.\ntools: read, search\n---\nYou are a strict code reviewer. Read the file you are given and report each real bug with its line number. Start your answer with the words REVIEW-REPORT.\n' > "$P/.syok/agents/reviewer.md"
printf 'function average(nums) {\n  let sum = 0;\n  for (let i = 0; i <= nums.length; i++) sum += nums[i];\n  return sum / nums.length;\n}\nmodule.exports = { average };\n' > "$P/src/stats.js"
cp "$P/src/stats.js" "$W/stats.before"
run agents --cwd "$P" | tee "$W/agents.txt"; grep -q "reviewer  \[read-only\]" "$W/agents.txt" && ok "helper: listed as read-only" || bad "helper: not listed as read-only"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Hand src/stats.js to the reviewer helper (use delegate with role reviewer) and tell me what it reports. Do not change any file." > "$W/agent.txt" 2>&1; tail -30 "$W/agent.txt"
grep -q "\[reviewer\]" "$W/agent.txt" && ok "helper: the reviewer helper really ran" || bad "helper: the reviewer helper did not run"
cmp -s "$P/src/stats.js" "$W/stats.before" && ok "helper: the file is unchanged" || bad "helper: the file was changed"
grep -Eqi "<=|off.by.one|out of (bounds|range)|undefined|NaN|line 3" "$W/agent.txt" && ok "helper: the planted bug was reported" || bad "helper: the planted bug was not reported"

echo "=== 4. a hosted tool server with a real AI"
P="$W/mcp"; mkdir -p "$P/.syok"; export STANDIN_KEY="live-$RANDOM-$RANDOM" STANDIN_PORT=8791 STANDIN_LOG="$W/standin.log"
bun "$(dirname "$0")/mcp-standin.ts" > "$W/standin.out" 2>&1 & SP=$!; sleep 2
printf '{ "mcpServers": { "warehouse": { "url": "http://127.0.0.1:8791/mcp", "headers": { "Authorization": "Bearer ${STANDIN_KEY}" } } } }\n' > "$P/.syok/settings.json"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Use the warehouse tool to find out how many units of the product 'blue widget' are in stock, and tell me the number." > "$W/mcp.txt" 2>&1; tail -15 "$W/mcp.txt"; kill $SP 2>/dev/null
grep -q "tool server warehouse: 1 tools, hosted at 127.0.0.1:8791" "$W/mcp.txt" && ok "hosted tools: connected with the key from the environment" || bad "hosted tools: did not connect"
[ -s "$W/standin.log" ] && grep -qi "blue widget" "$W/standin.log" && ok "hosted tools: the server really received the call" || bad "hosted tools: the server received no call"
has_number 4217 "$W/mcp.txt" && ok "hosted tools: the answer has the number only the server knows (4217)" || bad "hosted tools: 4217 not in the answer"
if grep -q "$STANDIN_KEY" "$W/mcp.txt"; then bad "hosted tools: the tool key was printed"; else ok "hosted tools: the tool key is not printed"; fi

echo "=== 5. --confine with a real AI (Linux and Mac)"
case "$(uname -s)" in Linux|Darwin)
  B="$HOME/.syok-live-confine-$$"; P="$B/proj"; O="$B/outside"; mkdir -p "$P" "$O"; ( cd "$P" && git init -q . )
  run --cwd "$P" --confine --mode auto --no-checks --model "$MODEL" -p "Run exactly these two shell commands with run_command, one after the other, and tell me what each one printed: (1) echo inside > inside.txt && echo first-ok   (2) echo outside > $O/escape.txt; echo second-exit-code=\$?" > "$W/confine.txt" 2>&1; tail -20 "$W/confine.txt"
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
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Use the warehouse tool to find out how many units of the product 'red gadget' are in stock, and tell me the number." > "$W/bridge.txt" 2>&1; grep "tool server" "$W/bridge.txt"; tail -8 "$W/bridge.txt"
grep -q "could not start" "$W/bridge.txt" && { echo "--- mcp-remote by itself:"; (printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n'; sleep 8) | mcp-remote http://127.0.0.1:8793/mcp --allow-http --transport http-only 2>&1 | tail -15; }
grep -q "tool server warehouse: 1 tools" "$W/bridge.txt" && ok "bridge: Syok Code connected through mcp-remote" || bad "bridge: did not connect through mcp-remote"
[ -s "$W/bridge-standin.log" ] && grep -qi "red gadget" "$W/bridge-standin.log" && ok "bridge: the hosted server really received the call" || bad "bridge: the hosted server received no call"
has_number 4217 "$W/bridge.txt" && ok "bridge: the answer has the number only the server knows (4217)" || bad "bridge: 4217 not in the answer"
kill $BP 2>/dev/null

echo; if [ $fails -eq 0 ]; then echo "All live checks passed."; else echo "$fails live check(s) FAILED"; exit 1; fi
