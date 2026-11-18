#!/usr/bin/env bash
# Every plugin on the Syok list, used by a REAL AI on a small real project. Each check reads files, git and test results:
# never the AI's own claim. The plugins are installed the real way, by name, from a list served on this computer.
# Needs SYOK_BASE_URL and SYOK_API_KEY. Usage: plugins-live.sh <path to main.ts or syok.js>
set -u
SYOK="$1"; MODEL="${MODEL:-syok-coder}"; fails=0; W="$(mktemp -d)"; HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fails=$((fails+1)); }
run() { bun "$SYOK" "$@"; }
sum() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
# what git sees as changed, without Syok Code's own folder
changed() { git -C "$1" status --porcelain -- . ':(exclude).syok' | sed 's/^...//' | sort | tr '\n' ' '; }
newrepo() { mkdir -p "$1"; git -C "$1" init -q -b main; git -C "$1" config user.email t@example.com; git -C "$1" config user.name T; git -C "$1" config commit.gpgsign false; printf '.syok/\nnode_modules/\n' > "$1/.gitignore"; }
commitall() { git -C "$1" add -A && git -C "$1" commit -q -m "${2:-start}"; }

echo "=== the list, built from the plugins folder and served on this computer"
bun "$REPO/scripts/build-plugins.ts" "$W/list" || { echo "FAIL the list could not be built"; exit 1; }
( cd "$W/list" && bun -e 'Bun.serve({port:8795,hostname:"127.0.0.1",fetch(r){const f=Bun.file("."+new URL(r.url).pathname);return f.exists().then(e=>e?new Response(f,{headers:{"content-type":"application/json"}}):new Response("no",{status:404}))}})' ) & LP=$!
sleep 2; export SYOK_PLUGIN_LIST="http://127.0.0.1:8795/index.json"
add() { ( cd "$1" && run plugin add "$2" > "$W/add-$2.txt" 2>&1 ) && grep -q "from the Syok list" "$W/add-$2.txt" && ok "$2: installed by name from the list" || { bad "$2: could not be installed"; cat "$W/add-$2.txt"; }; }

echo "=== find, with a real AI choosing from the list"
P="$W/find"; newrepo "$P"; echo '{"scripts":{"test":"node --test"}}' > "$P/package.json"
( cd "$P" && run plugin find "my tests fail and I cannot work out why" --model "$MODEL" > "$W/find.txt" 2>&1 ); cat "$W/find.txt"
head -3 "$W/find.txt" | grep -q "bug-hunter" && ok "find: the AI picked bug-hunter first for failing tests" || bad "find: bug-hunter was not the first pick"
if grep -q "plain words" "$W/find.txt"; then bad "find: the AI was not asked (fell back to plain words)"; else ok "find: the AI was really asked"; fi
( cd "$P" && run plugin find "bake me a chocolate cake" --model "$MODEL" > "$W/find2.txt" 2>&1 ); tail -2 "$W/find2.txt"
grep -q "Nothing on the list helps" "$W/find2.txt" && ok "find: for something no plugin does, it says so and picks nothing" || bad "find: it picked a plugin for a wish no plugin serves"

echo "=== 1. git-helper: /commit"
P="$W/git"; newrepo "$P"; mkdir -p "$P/src"; printf 'export function add(a, b) {\n  return a - b;\n}\n' > "$P/src/math.js"; commitall "$P"
printf 'export function add(a, b) {\n  return a + b;\n}\n' > "$P/src/math.js"; add "$P" git-helper; BEFORE="$(git -C "$P" rev-list --count HEAD)"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "/commit" > "$W/commit.txt" 2>&1; tail -6 "$W/commit.txt"
[ "$(git -C "$P" rev-list --count HEAD)" = "$((BEFORE+1))" ] && ok "commit: exactly one new commit" || bad "commit: expected one new commit, history has $(git -C "$P" rev-list --count HEAD) (was $BEFORE)"
SUBJ="$(git -C "$P" log -1 --format=%s)"; echo "   subject: $SUBJ"
echo "$SUBJ" | grep -Eq '^(feat|fix|docs|refactor|test|chore)(\([a-z0-9._/-]+\))?: .{3,}$' && [ ${#SUBJ} -le 72 ] && ok "commit: the message has the asked form and length" || bad "commit: the message is not in the asked form: $SUBJ"
echo "$SUBJ" | grep -Eqi 'add|sum|plus|subtract|minus|math|operator|arithmetic' && ok "commit: the message is about what really changed" || bad "commit: the message does not mention what changed"
[ -z "$(changed "$P")" ] && ok "commit: nothing is left uncommitted" || bad "commit: left uncommitted: $(changed "$P")"
git -C "$P" show --stat --format= HEAD | grep -q "src/math.js" && ok "commit: the commit holds the changed file" || bad "commit: the commit does not hold src/math.js"

echo "=== 2. test-writer: /tests"
P="$W/tw"; newrepo "$P"; mkdir -p "$P/src"; printf '{ "name": "tw", "type": "module", "scripts": { "test": "node --test" } }\n' > "$P/package.json"
printf 'export function priceWithDiscount(price, percent) {\n  if (typeof price !== "number" || typeof percent !== "number") throw new TypeError("numbers only");\n  if (price < 0) throw new RangeError("price must not be negative");\n  if (percent < 0 || percent > 100) throw new RangeError("percent must be 0 to 100");\n  return Math.round(price * (100 - percent)) / 100;\n}\n' > "$P/src/price.js"
commitall "$P"; add "$P" test-writer; H0="$(sum "$P/src/price.js")"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "/tests src/price.js" > "$W/tw.txt" 2>&1; tail -6 "$W/tw.txt"
TF="$(cd "$P" && git status --porcelain -- . ':(exclude).syok' | sed 's/^...//' | grep -Ei 'test|spec' | head -1)"
[ -n "$TF" ] && ok "tests: a new test file was written ($TF)" || bad "tests: no new test file"
[ "$(sum "$P/src/price.js")" = "$H0" ] && ok "tests: the file under test was not changed" || bad "tests: the file under test was changed"
( cd "$P" && node --test > "$W/tw-run.txt" 2>&1 ) && ok "tests: the new tests pass (run by this script)" || { bad "tests: the new tests fail"; tail -15 "$W/tw-run.txt"; }
N="$(grep -E '^# tests ' "$W/tw-run.txt" | grep -oE '[0-9]+' | head -1)"; [ "${N:-0}" -ge 4 ] && ok "tests: at least four tests ($N)" || bad "tests: only ${N:-0} tests"
grep -rqE 'RangeError|TypeError|throws' "$P" --include='*test*' --include='*spec*' --exclude-dir=.syok --exclude-dir=.git && ok "tests: the error cases are tested too" || bad "tests: the error cases are not tested"

echo "=== 3. reviewer: /review-changes"
P="$W/rev"; newrepo "$P"; mkdir -p "$P/src"; printf 'export function findUser(db, id) {\n  return db.query("SELECT * FROM users WHERE id = ?", [id]);\n}\n' > "$P/src/users.js"; commitall "$P"
printf 'export function findUser(db, name) {\n  return db.query("SELECT * FROM users WHERE name = %s" + name + "%s");\n}\n' "'" "'" > "$P/src/users.js"; add "$P" reviewer; S0="$(changed "$P")"; H0="$(sum "$P/src/users.js")"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "/review-changes" > "$W/rev.txt" 2>&1; tail -25 "$W/rev.txt"
grep -qi "injection" "$W/rev.txt" && ok "review: the planted SQL injection was found" || bad "review: the SQL injection was not found"
grep -q "src/users.js" "$W/rev.txt" && ok "review: the finding names the file" || bad "review: the file is not named"
[ "$(changed "$P")" = "$S0" ] && [ "$(sum "$P/src/users.js")" = "$H0" ] && ok "review: nothing was changed" || bad "review: files were changed by a read-only review"

echo "=== 4. docs-writer: /readme"
P="$W/docs"; newrepo "$P"; mkdir -p "$P/src"; printf '{ "name": "tiny-greeter", "version": "1.0.0", "type": "module", "scripts": { "start": "node src/greet.js", "test": "node --test" } }\n' > "$P/package.json"
printf '// Prints a greeting for the name given on the command line.\nconst name = process.argv[2] || "world";\nconsole.log("Hello, " + name + "!");\n' > "$P/src/greet.js"; commitall "$P"; add "$P" docs-writer
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "/readme" > "$W/docs.txt" 2>&1; tail -5 "$W/docs.txt"
[ -s "$P/README.md" ] && ok "readme: README.md was written" || bad "readme: no README.md"
[ "$(changed "$P")" = "README.md " ] && ok "readme: only README.md changed" || bad "readme: changed: $(changed "$P")"
grep -Eq 'npm (run )?start|node src/greet\.js' "$P/README.md" && ok "readme: it gives the real command to run the project" || bad "readme: the real run command is missing"
grep -Eq 'npm (run )?test|node --test' "$P/README.md" && ok "readme: it gives the real test command" || bad "readme: the real test command is missing"
if grep -Eqi 'npm run (build|lint|dev|deploy)|yarn |pnpm |docker ' "$P/README.md"; then bad "readme: it contains a command this project does not have"; grep -Eni 'npm run (build|lint|dev|deploy)|yarn |pnpm |docker ' "$P/README.md"; else ok "readme: no invented commands"; fi

echo "=== 5. bug-hunter: /fix-failing"
P="$W/bug"; newrepo "$P"; mkdir -p "$P/src" "$P/test"; printf '{ "name": "bug", "type": "module", "scripts": { "test": "node --test" } }\n' > "$P/package.json"
printf '// Returns the last n items of a list.\nexport function lastItems(list, n) {\n  return list.slice(list.length - n + 1);\n}\n' > "$P/src/list.js"
printf 'import test from "node:test"; import assert from "node:assert/strict"; import { lastItems } from "../src/list.js";\ntest("last two", () => assert.deepEqual(lastItems([1, 2, 3, 4], 2), [3, 4]));\ntest("last one", () => assert.deepEqual(lastItems([1, 2, 3], 1), [3]));\ntest("all of them", () => assert.deepEqual(lastItems([1, 2], 2), [1, 2]));\n' > "$P/test/list.test.js"
commitall "$P"; add "$P" bug-hunter; T0="$(sum "$P/test/list.test.js")"
( cd "$P" && node --test > /dev/null 2>&1 ) && bad "fix: the planted bug is not there" || ok "fix: the project starts with failing tests"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "/fix-failing" > "$W/bug.txt" 2>&1; tail -8 "$W/bug.txt"
( cd "$P" && node --test > "$W/bug-run.txt" 2>&1 ) && ok "fix: the tests pass now (run by this script)" || { bad "fix: the tests still fail"; tail -12 "$W/bug-run.txt"; }
[ "$(sum "$P/test/list.test.js")" = "$T0" ] && ok "fix: the test file was not touched" || bad "fix: the test file was changed"
[ "$(changed "$P")" = "src/list.js " ] && ok "fix: only the faulty source file changed" || bad "fix: changed: $(changed "$P")"

echo "=== 6. ci-starter: /ci"
P="$W/ci"; newrepo "$P"; mkdir -p "$P/test"; printf '{ "name": "ci", "version": "1.0.0", "type": "module", "engines": { "node": ">=22" }, "scripts": { "test": "node --test" } }\n' > "$P/package.json"
printf '{ "name": "ci", "version": "1.0.0", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "ci", "version": "1.0.0", "engines": { "node": ">=22" } } } }\n' > "$P/package-lock.json"
printf 'import test from "node:test"; import assert from "node:assert/strict";\ntest("works", () => assert.equal(1 + 1, 2));\n' > "$P/test/a.test.js"; commitall "$P"; add "$P" ci-starter
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "/ci" > "$W/ci.txt" 2>&1; tail -8 "$W/ci.txt"
D="$P/ci-workflow.yml"; F="$P/.github/workflows/ci.yml"
[ -s "$D" ] && ok "ci: the workflow file was written (ci-workflow.yml, for the person to put in place)" || bad "ci: no workflow file"
[ ! -e "$P/.github" ] && ok "ci: the AI did not write into .github/workflows itself (that folder is protected)" || bad "ci: the protected folder was written to"
[ "$(changed "$P")" = "ci-workflow.yml " ] && ok "ci: nothing else changed" || bad "ci: changed: $(changed "$P")"
grep -q "mkdir -p .github/workflows && mv ci-workflow.yml .github/workflows/ci.yml" "$W/ci.txt" && ok "ci: the answer gives the one command that puts it in place" || bad "ci: the command to put it in place is missing from the answer"
# this script now does what the person would do, with exactly that command
( cd "$P" && mkdir -p .github/workflows && mv ci-workflow.yml .github/workflows/ci.yml ) 2>/dev/null
python3 - "$F" > "$W/ci-check.txt" 2>&1 <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1])); on = d.get("on", d.get(True)); jobs = d["jobs"]; steps = [s for j in jobs.values() for s in j["steps"]]
uses = [s.get("uses", "") for s in steps]; runs = " ; ".join(s.get("run", "") for s in steps)
assert "pull_request" in on and "push" in on, "must run on push and pull_request"
assert d.get("permissions") == {"contents": "read"}, "permissions must be contents: read only, got %r" % (d.get("permissions"),)
assert any(u.startswith("actions/checkout@") for u in uses), "no checkout"
assert any(u.startswith("actions/setup-node@") for u in uses), "no node setup"
assert all(u == "" or u.startswith("actions/") for u in uses), "third-party action used: %r" % uses
assert "npm test" in runs or "node --test" in runs, "the real test command is not run: %r" % runs
assert "npm ci" in runs, "does not install with the lock file: %r" % runs
assert "secrets." not in open(sys.argv[1]).read(), "uses secrets"
assert all("ubuntu" in str(j.get("runs-on")) for j in jobs.values()), "not ubuntu"
print("valid")
PY
grep -q "^valid$" "$W/ci-check.txt" && ok "ci: valid YAML; push and pull_request; read-only; official actions only; installs with the lock file; runs the real tests" || { bad "ci: the workflow is not as asked: $(tail -1 "$W/ci-check.txt")"; cat "$F"; }

echo "=== 7. refactor-safe: /rename"
P="$W/ren"; newrepo "$P"; mkdir -p "$P/src" "$P/test"; printf '{ "name": "ren", "type": "module", "scripts": { "test": "node --test" } }\n' > "$P/package.json"
printf 'export function calcTotal(items) {\n  return items.reduce((s, x) => s + x, 0);\n}\nexport function calcTotalTax(items) {\n  return calcTotal(items) * 0.1;\n}\n' > "$P/src/cart.js"
printf 'import { calcTotal } from "./cart.js";\nexport const label = "calcTotal is shown to nobody";\nexport function report(items) {\n  return "Total: " + calcTotal(items);\n}\n' > "$P/src/report.js"
printf 'import test from "node:test"; import assert from "node:assert/strict"; import { calcTotal, calcTotalTax } from "../src/cart.js"; import { report, label } from "../src/report.js";\ntest("total", () => assert.equal(calcTotal([1, 2, 3]), 6));\ntest("tax", () => assert.equal(calcTotalTax([10, 10]), 2));\ntest("report", () => assert.equal(report([2, 3]), "Total: 5"));\ntest("label", () => assert.equal(label, "calcTotal is shown to nobody"));\n' > "$P/test/cart.test.js"
commitall "$P"; add "$P" refactor-safe
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "/rename calcTotal computeTotal" > "$W/ren.txt" 2>&1; tail -6 "$W/ren.txt"
grep -q "export function computeTotal(items)" "$P/src/cart.js" && ok "rename: the definition has the new name" || bad "rename: the definition was not renamed"
grep -q "calcTotalTax" "$P/src/cart.js" && ! grep -q "computeTotalTax" "$P/src" -r && ok "rename: a different, longer name (calcTotalTax) was left alone" || bad "rename: calcTotalTax was renamed too"
grep -q 'return computeTotal(items) \* 0.1' "$P/src/cart.js" && grep -q '"Total: " + computeTotal(items)' "$P/src/report.js" && grep -q 'import { computeTotal } from "./cart.js"' "$P/src/report.js" && ok "rename: every real use and the import follow" || bad "rename: a use or the import was missed"
grep -q '"calcTotal is shown to nobody"' "$P/src/report.js" && ok "rename: the same letters inside a piece of text were left alone" || bad "rename: text inside a string was changed"
( cd "$P" && node --test > "$W/ren-run.txt" 2>&1 ) && ok "rename: all tests pass afterwards (run by this script)" || { bad "rename: tests fail afterwards"; tail -12 "$W/ren-run.txt"; }

echo "=== 8. security-check: /secrets-scan"
P="$W/sec"; newrepo "$P"; mkdir -p "$P/config" "$P/src"; printf '.syok/\n' > "$P/.gitignore"
KEYMID="9f8a7b6c5d4e3f2a1b0c"; KEY="sk-live-${KEYMID}9d8e7f6a5b4c"; PW="Tr0ub4dor-horse-battery-77"
printf 'export const API_URL = "https://api.example.com";\nexport const API_KEY = "%s";\n' "$KEY" > "$P/config/settings.js"
printf 'DB_HOST=localhost\nDB_PASSWORD=%s\n' "$PW" > "$P/.env"; printf 'export const PLACEHOLDER_KEY = "your-key-here";\nexport const fromEnv = process.env.API_KEY;\n' > "$P/src/ok.js"
commitall "$P"; add "$P" security-check; S0="$(changed "$P")"
run --cwd "$P" --mode auto --no-checks --model "$MODEL" -p "/secrets-scan" > "$W/sec.txt" 2>&1; tail -25 "$W/sec.txt"
grep -q "config/settings.js" "$W/sec.txt" && ok "scan: the key in config/settings.js was found" || bad "scan: the key in config/settings.js was not found"
grep -q "\.env" "$W/sec.txt" && ok "scan: the password in the tracked .env was found" || bad "scan: the .env password was not found"
# the answer the person reads is what comes after the tool-call lines; the secret must not be in it
if grep -vE '^(  )?(\[[a-z-]+\] )?> ' "$W/sec.txt" | grep -qE "$KEYMID|$PW"; then bad "scan: a secret's value was printed in the report"; else ok "scan: no secret value is printed in the report"; fi
LAST="$(grep -E '^`?Findings: [0-9]+`?$' "$W/sec.txt" | tail -1 | tr -d '`')"; echo "   $LAST"
[ "$LAST" = "Findings: 2" ] && ok "scan: exactly the two planted secrets are counted (the placeholder and the value read from the environment are not)" || bad "scan: expected 'Findings: 2', got '${LAST:-no count line}'"
[ "$(changed "$P")" = "$S0" ] && ok "scan: nothing was changed" || bad "scan: files were changed by a read-only scan"

kill $LP 2>/dev/null
echo; if [ $fails -eq 0 ]; then echo "All plugin checks passed."; else echo "$fails plugin check(s) FAILED"; exit 1; fi
