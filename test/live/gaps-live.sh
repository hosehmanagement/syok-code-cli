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
ai "$W/mcp.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "I am writing a stock-check script for this project and need the real number for a test value in the code. Call the warehouse tool server's stock_count tool for the product 'blue widget' and tell me the exact number it returns, so I can paste it into the code."; tail -15 "$W/mcp.txt"; kill $SP 2>/dev/null
grep -q "tool server warehouse: 1 tools, hosted at 127.0.0.1:8791" "$W/mcp.txt" && ok "hosted tools: connected with the key from the environment" || bad "hosted tools: did not connect"
[ -s "$W/standin.log" ] && grep -qi "blue widget" "$W/standin.log" && ok "hosted tools: the server really received the call" || bad "hosted tools: the server received no call"
has_number 4217 "$W/mcp.txt" && ok "hosted tools: the answer has the number only the server knows (4217)" || bad "hosted tools: 4217 not in the answer"
if grep -q "$STANDIN_KEY" "$W/mcp.txt"; then bad "hosted tools: the tool key was printed"; else ok "hosted tools: the tool key is not printed"; fi

echo "=== 5. --confine with a real AI (Linux and Mac)"
case "$(uname -s)" in Linux|Darwin)
  B="$HOME/.syok-live-confine-$$"; P="$B/proj"; O="$B/outside"; mkdir -p "$P" "$O"; ( cd "$P" && git init -q . )
  printf 'echo inside > inside.txt && echo first-ok\necho outside > %s/escape.txt; echo second-exit-code=$?\n' "$O" > "$P/check.sh"
  ai "$W/confine.txt" --cwd "$P" --confine --mode auto --no-checks --model "$MODEL" -p "I am fixing this project's build script check.sh. Its first line writes the build marker inside.txt in the project; its second line copies a marker to another folder. Run it once, unchanged, with run_command exactly as: sh check.sh (from the project folder, do not edit it or run anything else first). Then tell me exactly what each of its two lines printed, so I can fix the script."
  grep -E '^> ' "$W/confine.txt" | cut -c1-200; tail -6 "$W/confine.txt"
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
ai "$W/bridge.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "I am writing a stock-check script for this project and need the real number for a test value in the code. Call the warehouse tool server's stock_count tool for the product 'red gadget' and tell me the exact number it returns, so I can paste it into the code."; grep "tool server" "$W/bridge.txt"; tail -8 "$W/bridge.txt"
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
  printf 'echo inside > inside.txt && echo first-ok\necho outside > %s/escape.txt; echo second-exit-code=$?\n' "$O" > "$P/check.sh"
  ai "$W/default.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "I am fixing this project's build script check.sh. Its first line writes the build marker inside.txt in the project; its second line copies a marker to another folder. Run it once, unchanged, with run_command exactly as: sh check.sh (from the project folder, do not edit it or run anything else first). Then tell me exactly what each of its two lines printed, so I can fix the script."
  grep -q "^Confined with" "$W/default.txt" && grep -q "On by default" "$W/default.txt" && ok "default: confined without any flag" || bad "default: not confined without a flag"
  [ -f "$P/inside.txt" ] && ok "default: the file inside the project was written" || bad "default: the file inside the project is missing"
  [ ! -e "$O/escape.txt" ] && ok "default: the file outside the project was NOT written" || bad "default: a file was written outside the project"
  printf 'echo outside > %s/escape2.txt; echo exit-code=$?\n' "$O" > "$P/write-marker.sh"
  ai "$W/default-off.txt" --cwd "$P" --no-confine --mode auto --no-checks --model "$MODEL" -p "Run this project's script with run_command: sh write-marker.sh (from the project folder). Then tell me exactly what it printed."
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

FIX="$(dirname "$0")/make-fixture.py"
# Which model answered a run, from its usage line ("answered by claude / claude-sonnet-5 (3 steps)").
who() { grep -Eo 'answered by [^;]*' "$1" | tail -1 | sed -E 's/\)$//'; }
# What a run did: the model, every tool call it made, and (from the saved chat) the start of every read_file result.
show() { echo "(model: $(who "$1"))"; echo "--- tool calls:"; grep -E '^> ' "$1" | cut -c1-240; echo "---"; }
SESSION_JS='const fs = require("fs"), d = process.argv[1] + "/.syok/sessions";
let f = []; try { f = fs.readdirSync(d).filter((x) => x.endsWith(".json")).map((x) => d + "/" + x).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); } catch {}
const m = f.length ? JSON.parse(fs.readFileSync(f[0], "utf8")).messages || [] : [];
const res = new Map(m.filter((x) => x.role === "tool").map((x) => [x.tool_call_id, String(x.content)]));
for (const x of m) for (const c of x.tool_calls || []) if (c.function?.name === "read_file") { let a = {}; try { a = JSON.parse(c.function.arguments || "{}"); } catch {}
  console.log("  " + JSON.stringify(a.path) + " -> " + JSON.stringify((res.get(c.id) ?? "(no result)").slice(0, 160))); }'
reads() { echo "--- read_file results (from the saved chat):"; bun -e "$SESSION_JS" "$1"; echo "---"; }

echo "=== 12. the todo list with a real AI, kept through a shortened chat: three sessions, the fact only the list still holds"
# profiles.json in the project makes the chat be shortened (summarized) early, as in a long task. The release code is read
# from a file in session 1 and written into the todo list; the file is then deleted, so in session 3 the code can only come
# from what the chat kept. A one-run task cannot be summarized (the cut is made at a request of yours, and a one-run task has
# only one), so the work is spread over three sessions with --continue, as a person would.
P="$W/todo"; mkdir -p "$P/notes"
CODE="RC-$(python3 -I -c 'import random;r=random.SystemRandom();print("%04d-%s"%(r.randrange(1000,10000),r.choice("ABCDEFGHJKMNPQRSTUVWXYZ")))')"
{ for i in $(seq 1 40); do echo "# release notes: line $i of the changelog, nothing to do here, keep reading until the release code line"; done; echo "RELEASE_CODE=$CODE"; echo "# end"; } > "$P/notes/release.txt"
printf '{ "short-room": { "compactAtChars": 1500, "keepRecent": 2 } }\n' > "$P/profiles.json"
TODO_RUN=(--cwd "$P" --mode auto --no-checks --profile short-room --model "$MODEL")
ai "$W/todo1.txt" "${TODO_RUN[@]}" -p "We prepare this project's release in three short sessions; this is session 1. First read notes/release.txt and find the line that starts with RELEASE_CODE=. Then make a todo list with the todo tool (action set) with exactly these five items, in this order, with ids 1 to 5: 1 'Create out/one.txt containing alpha', 2 'Create out/two.txt containing beta', 3 'Create out/three.txt containing gamma', 4 'Create out/four.txt containing delta', 5 'Report release code X' where X is the value after RELEASE_CODE=. Then do item 1 only and mark it done. Items 2 to 5 belong to the next sessions: leave them pending and call finish (if you are reminded about open items, call finish again)."; tail -12 "$W/todo1.txt"; show "$W/todo1.txt"; reads "$P"
order="$(grep -E '^\[.\] [1-5]\. ' "$W/todo1.txt" | head -5 | sed -E 's/^\[.\] ([1-5])\. .*/\1/' | tr -d '\n')"
[ "$order" = "12345" ] && grep -qE "^\[.\] 5\. .*$CODE" "$W/todo1.txt" && ok "todo: session 1 made the five-item list in order, item 5 holds the code" || bad "todo: session 1 list wrong (order '$order', or item 5 lacks the code)"
rm -f "$P/notes/release.txt"   # from here on the code is in no file
ai "$W/todo2.txt" "${TODO_RUN[@]}" --continue -p "Session 2: do item 2 of your todo list only and mark it done. Leave items 3 to 5 pending and call finish (if you are reminded about open items, call finish again)."; tail -6 "$W/todo2.txt"; show "$W/todo2.txt"
ai "$W/todo3.txt" "${TODO_RUN[@]}" --continue -p "Session 3, the last one: do the remaining items of your todo list and mark each done. For item 5, write the release code in your final answer exactly as your todo list gives it."; tail -10 "$W/todo3.txt"; show "$W/todo3.txt"
cat "$W/todo2.txt" "$W/todo3.txt" | grep -q "(the earlier conversation was summarized to save room)" && ok "todo: the chat was shortened (summarized) in session 2 or 3" || bad "todo: the chat was never summarized"
reads "$P"
SESS="$(ls -t "$P/.syok/sessions/"*.json 2>/dev/null | head -1)"
bun -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), code = process.argv[2], m = s.messages || [];
const t = m.findIndex((x) => typeof x.content === "string" && x.content.startsWith("[Your todo list, kept from before the chat was shortened]"));
const sum = m.findIndex((x) => typeof x.content === "string" && x.content.startsWith("[Summary of the earlier conversation]"));
const lines = t < 0 ? [] : m[t].content.split("\n").filter((l) => /^\[.\] \d+\. /.test(l));
console.log("REINJECTED=" + (t > 0 && sum > 0 && t === sum + 2 ? "yes" : "no"));
console.log("ORDER=" + lines.map((l) => l.replace(/^\[.\] (\d+)\. .*/, "$1")).join(""));
console.log("CODE_IN_LIST=" + (lines.length === 5 && lines[4].includes(code) ? "yes" : "no"));
console.log("CODE_IN_SUMMARY=" + (sum > 0 && m[sum].content.includes(code) ? "yes" : "no"));
console.log("SAVED_IDS=" + (s.todos || []).map((x) => x.id).join(""));
console.log("SAVED_DONE_1_4=" + ((s.todos || []).slice(0, 4).length === 4 && (s.todos || []).slice(0, 4).every((x) => x.status === "done") ? "yes" : "no"));
' "$SESS" "$CODE" > "$W/todo-check.txt" 2>&1; cat "$W/todo-check.txt"
grep -q "^REINJECTED=yes" "$W/todo-check.txt" && ok "todo: the saved chat has the todo list put back right after the summary" || bad "todo: the todo list was not put back after the summary"
grep -q "^ORDER=12345$" "$W/todo-check.txt" && grep -q "^CODE_IN_LIST=yes" "$W/todo-check.txt" && ok "todo: the list put back keeps the item order 1-5 and the code in item 5" || bad "todo: the list put back lost the order or the code"
grep -q "^SAVED_IDS=12345$" "$W/todo-check.txt" && grep -q "^SAVED_DONE_1_4=yes" "$W/todo-check.txt" && ok "todo: the saved list has items 1-5 in order, 1-4 done" || bad "todo: the saved list is wrong"
# each file on its own: the word, with only surrounding blank space allowed (a file written without a final newline is fine)
ftxt() { [ -f "$P/out/$1.txt" ] && sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$P/out/$1.txt" | grep -v '^$' | paste -sd'/' - || echo "(missing)"; }
FILES="one=$(ftxt one) two=$(ftxt two) three=$(ftxt three) four=$(ftxt four)"
[ "$FILES" = "one=alpha two=beta three=gamma four=delta" ] && ok "todo: the four files were made across the sessions (checked on disk)" || bad "todo: out/*.txt are wrong: $FILES"
grep -q "$CODE" "$W/todo3.txt" && ok "todo: the last answer has the release code $CODE (its file was deleted after session 1)" || bad "todo: the last answer lacks the release code $CODE"
grep -q "^CODE_IN_SUMMARY=yes" "$W/todo-check.txt" && echo "NOTE todo: the AI's summary also kept the code, so the answer could have come from either" || echo "NOTE todo: the summary did not keep the code: the answer came from the todo list put back"

echo "=== 13. lsp rename with a real AI: one function renamed everywhere, a method with the same name left alone"
if [ -x "$LS" ]; then
  P="$W/rename"; mkdir -p "$P/src" "$P/.syok"
  printf '{ "compilerOptions": { "strict": true, "target": "es2022", "module": "esnext", "moduleResolution": "bundler", "noEmit": true }, "include": ["src"] }\n' > "$P/tsconfig.json"
  printf 'export function calcTotal(prices: number[]): number { return prices.reduce((a, b) => a + b, 0); }\nexport class Cart {\n  items: number[] = [];\n  calcTotal(): number { return this.items.length; }\n}\n' > "$P/src/pricing.ts"
  printf 'import { calcTotal } from "./pricing";\nexport const total = calcTotal([1, 2, 3]);\n' > "$P/src/checkout.ts"
  printf 'import { calcTotal, Cart } from "./pricing";\nexport function report(): string {\n  const all = calcTotal([4, 5]);\n  const count = new Cart().calcTotal();\n  return `total ${all}, items ${count}, again ${calcTotal([6])}`;\n}\n' > "$P/src/report.ts"
  printf '{ "lsp": { "typescript": { "command": "%s", "args": ["--stdio"] } } }\n' "$LS" > "$P/.syok/settings.json"
  ( cd "$P" && "$REPO/node_modules/.bin/tsc" -p . > "$W/rename-before.txt" 2>&1 ) && ok "rename: the project compiles before (checked with the real compiler)" || { bad "rename: the project does not compile before"; cat "$W/rename-before.txt"; }
  ai "$W/rename.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "Rename the function calcTotal that is defined on line 1 of src/pricing.ts to computeOrderTotal, everywhere it is used. Use the lsp tool's rename action for it (path src/pricing.ts, line 1, symbol calcTotal, new_name computeOrderTotal), not edit_file and not search and replace. The method calcTotal of the class Cart is a different thing and keeps its name. Then tell me which files changed."; tail -15 "$W/rename.txt"; show "$W/rename.txt"; reads "$P"
  grep -q '> lsp {"action":"rename"' "$W/rename.txt" && ok "rename: the AI used lsp rename" || bad "rename: the AI did not use lsp rename"
  # The changes must come from the rename itself: no hand edits, and the rename's own reply (in the saved chat) applied all
  # 6 changes in the 3 files. Commands the AI ran afterwards to check its work (Syok Code asks it to run checks) are allowed,
  # since the exact file contents below and this reply show the rename did all of the work.
  if grep -Eq '^> (edit_file|write_file)' "$W/rename.txt"; then bad "rename: the AI also edited files by hand"; else ok "rename: no hand edits (edit_file, write_file)"; fi
  grep -E '^> run_command' "$W/rename.txt" | sed 's/^/  (checked its work with: /; s/$/)/'
  RSESS="$(ls -t "$P/.syok/sessions/"*.json 2>/dev/null | head -1)"
  [ -n "$RSESS" ] && grep -qF 'Renamed \"calcTotal\" to \"computeOrderTotal\": 6 changes in 3 files' "$RSESS" && ok "rename: the rename itself applied all 6 changes in the 3 files (its reply in the saved chat)" || bad "rename: the saved chat has no rename reply with 6 changes in 3 files"
  cnt() { grep -oE "$1" "$P/src/$2" | wc -l | tr -d ' '; }
  OLD='(^|[^A-Za-z0-9_])calcTotal([^A-Za-z0-9_]|$)'
  [ "$(cnt "$OLD" checkout.ts)" = 0 ] && [ "$(cnt computeOrderTotal checkout.ts)" = 2 ] && ok "rename: src/checkout.ts has the new name twice and the old name nowhere" || bad "rename: src/checkout.ts is wrong: $(cat "$P/src/checkout.ts")"
  [ "$(cnt computeOrderTotal report.ts)" = 3 ] && [ "$(cnt "$OLD" report.ts)" = 1 ] && grep -qF 'new Cart().calcTotal()' "$P/src/report.ts" && ok "rename: src/report.ts has the new name 3 times; the method call new Cart().calcTotal() is untouched" || bad "rename: src/report.ts is wrong: $(cat "$P/src/report.ts")"
  grep -qF 'export function computeOrderTotal(prices: number[]): number' "$P/src/pricing.ts" && grep -qF '  calcTotal(): number { return this.items.length; }' "$P/src/pricing.ts" && [ "$(cnt "$OLD" pricing.ts)" = 1 ] && ok "rename: src/pricing.ts: the function renamed, the method Cart.calcTotal kept" || bad "rename: src/pricing.ts is wrong: $(cat "$P/src/pricing.ts")"
  ( cd "$P" && "$REPO/node_modules/.bin/tsc" -p . > "$W/rename-after.txt" 2>&1 ) && ok "rename: the real compiler reports no error after the rename (checked by this script)" || { bad "rename: the compiler reports errors after the rename"; cat "$W/rename-after.txt"; }
else bad "rename: the language helper for the check is missing"; fi

echo "=== 14. peek_file with a real AI: the one error line in a 150 MB log"
P="$W/peek"; mkdir -p "$P/logs"
PCODE="$(python3 -I "$FIX" biglog "$P/logs/service.log" 150)"; echo "log size: $(wc -c < "$P/logs/service.log" | tr -d ' ') bytes"
[ -n "$PCODE" ] && [ "$(grep -c "$PCODE" "$P/logs/service.log")" = 1 ] && ok "peek: the log was made with one planted error line" || bad "peek: the planted line is missing"
ai "$W/peek.txt" --cwd "$P" --mode plan --model "$MODEL" -p "Payments stopped overnight. Our service log logs/service.log is about 150 MB, too big to read whole: look inside it with peek_file. Find the single ERROR line that explains why payments stopped and tell me its exact error code (the value after code=) and its line number."; tail -15 "$W/peek.txt"; show "$W/peek.txt"
grep -q '> peek_file' "$W/peek.txt" && ok "peek: the AI used peek_file" || bad "peek: the AI did not use peek_file"
# What must be proven is that the whole log never reaches the AI. read_file refuses files over 2 MB and points to peek_file,
# so an attempt refused that way is the designed behaviour, not a failure. Checked in the saved chat: every read_file call on
# the log must have got exactly that refusal and no line of the log; peek_file must have been used; the answer must hold the
# exact code. A read_file that returned any log content fails.
reads "$P" > "$W/peek-reads.txt"; cat "$W/peek-reads.txt"
LOGREADS="$(grep -F 'service.log' "$W/peek-reads.txt")"
if [ -z "$LOGREADS" ]; then ok "peek: read_file was not called on the big log"
elif ! echo "$LOGREADS" | grep -vqF 'Error: file is larger than 2 MB. Use peek_file' && ! echo "$LOGREADS" | grep -qE '20[0-9]{2}-[0-9]{2}-[0-9]{2}T|INFO|WARN|ERROR'; then ok "peek: every read_file on the big log ($(echo "$LOGREADS" | wc -l | tr -d ' ') call(s)) was refused with the pointer to peek_file; no log content reached the AI"
else bad "peek: a read_file on the big log was not refused, or returned log content"; fi
grep -q "$PCODE" "$W/peek.txt" && ok "peek: the answer has the exact code $PCODE (random, only in the log)" || bad "peek: the answer lacks the code $PCODE"
rm -rf "$P"

echo "=== 15. view_image with a real AI: a picture of a random number (needs a model that can see images)"
# syok-coder may send a step to a provider that cannot see pictures (codestral, deepseek), so this step pins ONE model that
# can, chosen from the models this Syok key lists (/v1/models). VISION_MODEL overrides the choice.
MODELS="$(curl -s -m 30 -H "authorization: Bearer $SYOK_API_KEY" "$(echo "$SYOK_BASE_URL" | sed -E 's#/+$##; s#/v1$##')/v1/models" | bun -e 'let t="";for await (const c of process.stdin) t+=c; try { console.log((JSON.parse(t).data||[]).map((m)=>m.id).join(" ")); } catch { console.log(""); }')"
echo "models this key lists: ${MODELS:-(none)}"
VM="${VISION_MODEL:-}"
if [ -z "$VM" ]; then for pat in '^claude-(sonnet|opus)' '^claude' '^gpt-4o' '^gpt-4\.1' '^gpt-5' '^gemini' '^pixtral' '^grok-.*vision' '^grok-4' 'llama-4' 'qwen.*vl'; do
  VM="$(printf '%s\n' $MODELS | grep -Ei "$pat" | grep -Eiv 'embed|audio|tts|whisper|image-gen|dall' | head -1)"; [ -n "$VM" ] && break; done; fi
# The list may hold presets only. Ask the router once, cheaply, whether it takes a specific model name: one tiny request per
# name, accepted only when it answers 200 AND says (X-Syok-Model) that this very model answered. A preset answering instead
# does not count: then the picture could go to a model that cannot see.
if [ -z "$VM" ]; then CHAT="$(echo "$SYOK_BASE_URL" | sed -E 's#/+$##; s#/v1$##')/v1/chat/completions"
  for cand in claude-sonnet-5 gpt-4o gemini-2.5-flash; do
    st="$(curl -s -m 60 -o "$W/probe.json" -D "$W/probe.h" -w '%{http_code}' -H "authorization: Bearer $SYOK_API_KEY" -H 'content-type: application/json' -d "{\"model\":\"$cand\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word OK.\"}],\"max_tokens\":5}" "$CHAT")"
    pm="$(grep -i '^x-syok-model:' "$W/probe.h" | tail -1 | cut -d' ' -f2- | tr -d '\r')"; pp="$(grep -i '^x-syok-provider:' "$W/probe.h" | tail -1 | cut -d' ' -f2- | tr -d '\r')"
    echo "probe --model $cand: HTTP $st, answered by ${pp:-?} / ${pm:-?}$( [ "$st" = 200 ] || echo "; said: $(head -c 200 "$W/probe.json" | tr '\n' ' ')")"
    if [ "$st" = 200 ] && [ "$(echo "$pm" | tr 'A-Z' 'a-z')" = "$cand" ]; then VM="$cand"; echo "the router takes the specific model name $cand"; break; fi
  done; fi
if [ -z "$VM" ]; then echo "SKIP view_image: no model that can see images can be pinned for this key (it lists: ${MODELS:-nothing}, and the router did not answer a specific model name with that model, see the probes above; presets such as syok-coder may route to models that cannot see pictures), so this cannot be checked here"; else
  echo "view_image model (pinned): $VM"
  P="$W/image"; mkdir -p "$P"
  read -r INUM ICOL < <(python3 -I "$FIX" png "$P/shot.png")
  [ -s "$P/shot.png" ] && [ -n "$INUM" ] && ok "image: the picture was made" || bad "image: the picture was not made"
  ai "$W/image.txt" --cwd "$P" --mode plan --model "$VM" -p "Look at the picture shot.png in this project with view_image. Which number is written in it, and what colour is the bar along its top edge (red, green or blue)? Answer in one line."; tail -8 "$W/image.txt"; show "$W/image.txt"; reads "$P"
  grep -q '> view_image' "$W/image.txt" && ok "image: the AI used view_image" || bad "image: the AI did not use view_image"
  has_number "$INUM" "$W/image.txt" && ok "image: the answer has the number $INUM (random, only in the picture)" || bad "image: the answer lacks the number $INUM"
  # the right colour named, and neither of the two other colours (so a list of all three cannot pass)
  OTHERS="$(printf 'red\ngreen\nblue\n' | grep -vx "$ICOL" | paste -sd'|' -)"
  grep -v '^> ' "$W/image.txt" | grep -qiw "$ICOL" && ! grep -v '^> ' "$W/image.txt" | grep -Eqiw "$OTHERS" && ok "image: the answer names the bar colour $ICOL and no other" || bad "image: the answer does not name the bar colour $ICOL alone"
  who "$W/image.txt" | grep -qF "$VM" && ok "image: answered by the pinned model $VM" || bad "image: not answered by the pinned model $VM ($(who "$W/image.txt"))"
fi

echo "=== 16. interactive terminal with a real AI: a setup wizard that asks two questions (Linux and Mac)"
case "$(uname -s)" in Linux|Darwin)
  P="$W/pty"; mkdir -p "$P"
  cat > "$P/wizard.py" <<'PY'
import hashlib, secrets, sys
if not (sys.stdin.isatty() and sys.stdout.isatty()):
    print("wizard: this setup wizard must be run in an interactive terminal"); sys.exit(3)
name = input("Project owner name: ").strip()
build = input("Build number: ").strip()
nonce = secrets.token_hex(4)  # new on every run, so the result cannot be worked out from this file
code = hashlib.sha256(("%s:%s:%s" % (name, build, nonce)).encode()).hexdigest()[:10]
with open(".wizard-result", "w") as f:
    f.write("%s|%s|%s\n" % (name, build, code))
print("REGISTRATION " + code)
PY
  ai "$W/pty.txt" --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "This project has a setup wizard, wizard.py, that asks two questions and only works in an interactive terminal. Run python3 wizard.py with pty_start, answer its questions with pty_send (owner name: Mira Tan, build number: 4096), read its output with pty_read, then stop the terminal with pty_stop. Then reply with the exact REGISTRATION line copied from the terminal."; tail -12 "$W/pty.txt"; show "$W/pty.txt"; reads "$P"
  grep -q '> pty_start' "$W/pty.txt" && grep -q '> pty_send' "$W/pty.txt" && ok "pty: the AI used pty_start and pty_send" || bad "pty: the AI did not use pty_start and pty_send"
  grep -q '> pty_read' "$W/pty.txt" && ok "pty: the AI read the terminal with pty_read" || bad "pty: the AI did not use pty_read"
  RES="$(cat "$P/.wizard-result" 2>/dev/null)"; RCODE="${RES##*|}"
  [ "${RES%|*}" = "Mira Tan|4096" ] && ok "pty: the wizard got both answers typed right (Mira Tan, 4096)" || bad "pty: the wizard did not get the right answers: '${RES:-nothing}'"
  [ -n "$RCODE" ] && grep -q "REGISTRATION $RCODE" "$W/pty.txt" && ok "pty: the answer has the exact line REGISTRATION $RCODE (random, made while it ran)" || bad "pty: the answer lacks REGISTRATION ${RCODE:-?}";;
*) echo "(not Linux or Mac: interactive terminals are checked there only)";; esac

echo; if [ $fails -eq 0 ]; then echo "All live checks passed."; else echo "$fails live check(s) FAILED"; exit 1; fi
