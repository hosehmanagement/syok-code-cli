#!/usr/bin/env bash
# The real thing for "syok cloud": real GitHub, a real pull request, the real @syok job, a real AI.
# It works on the private test repository given in TEST_REPO and removes what it made at the end.
# Needs: GH_TOKEN (a token for the test repository only), SYOK_BASE_URL, SYOK_API_KEY. Usage: cloud-live.sh <path to main.ts or syok.js>
set -u
SYOK="$1"; REPO="${TEST_REPO:?}"; fails=0; W="$(mktemp -d)"; BRANCH=""; PR=""
ok() { echo "PASS $1"; }; bad() { echo "FAIL $1"; fails=$((fails+1)); }
cleanup() {
  echo "=== tidy up"
  [ -n "$PR" ] && gh pr close "$PR" -R "$REPO" >/dev/null 2>&1 && echo "closed pull request $PR"
  [ -n "$BRANCH" ] && gh api -X DELETE "repos/$REPO/git/refs/heads/$BRANCH" >/dev/null 2>&1 && echo "deleted branch $BRANCH"
}
trap cleanup EXIT

echo "=== 1. the test repository has the Syok secrets the @syok job needs"
printf '%s' "$SYOK_BASE_URL" | gh secret set SYOK_BASE_URL -R "$REPO" && printf '%s' "$SYOK_API_KEY" | gh secret set SYOK_API_KEY -R "$REPO" && ok "secrets set in $REPO" || { bad "could not set the secrets in $REPO (does the token have Secrets: read and write?)"; exit 1; }

echo "=== 2. local work that is not committed yet"
gh auth setup-git; gh repo clone "$REPO" "$W/work" -- -q || { bad "could not clone $REPO"; exit 1; }
cd "$W/work"; git config user.name "cloud live test"; git config user.email "cloud-live@users.noreply.github.com"
MARK="m$(date +%s)"
printf 'const assert = require("node:assert");\nconst calc = require("./calc.js");\nassert.strictEqual(calc.add(2, 3), 5);\nassert.strictEqual(calc.multiply(6, 7), 42); // %s\nassert.strictEqual(calc.multiply(0, 9), 0);\nconsole.log("all tests passed");\n' "$MARK" > test.js
if node test.js >/dev/null 2>&1; then bad "the test should fail before the cloud does its work"; fi
cp test.js "$W/test.sent"; START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "=== 3. syok cloud"
bun "$SYOK" cloud "Add a multiply(a, b) function to calc.js and export it, so that 'node test.js' passes. Do not change test.js." --mode auto --cwd "$W/work" > "$W/cloud.txt" 2>&1; code=$?; cat "$W/cloud.txt"
[ $code -eq 0 ] && grep -q "^Handed over" "$W/cloud.txt" && ok "syok cloud reported the hand-over" || bad "syok cloud failed (exit $code)"
BRANCH="$(git branch --show-current)"; case "$BRANCH" in syok/cloud-*) ok "work is on the new branch $BRANCH";; *) bad "not on a syok/cloud- branch: $BRANCH";; esac
URL="$(grep -o 'https://github.com/[^ ]*/pull/[0-9]*' "$W/cloud.txt" | head -1)"; PR="${URL##*/}"
[ -n "$PR" ] && ok "a pull request link was printed: $URL" || { bad "no pull request link in the output"; exit 1; }

echo "=== 4. what is really on GitHub"
gh pr view "$PR" -R "$REPO" --json isDraft,headRefName,baseRefName,state,comments > "$W/pr.json"; cat "$W/pr.json" | head -c 600; echo
node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const want=process.argv[2]; const c=p.comments.map(x=>x.body).join("\n---\n"); const bad=[]; if(!p.isDraft)bad.push("not a draft"); if(p.state!=="OPEN")bad.push("not open"); if(p.headRefName!==want)bad.push("wrong branch "+p.headRefName); if(p.baseRefName!=="main")bad.push("wrong base"); if(!/^@syok Add a multiply/m.test(c))bad.push("no @syok comment"); if(bad.length){console.log(bad.join("; "));process.exit(1)}' "$W/pr.json" "$BRANCH" && ok "draft pull request, open, from $BRANCH into main, with the @syok comment" || bad "the pull request is not as expected"
gh api "repos/$REPO/contents/test.js?ref=$BRANCH" --jq .content | base64 -d > "$W/test.remote" 2>/dev/null
cmp -s "$W/test.remote" "$W/test.sent" && ok "the uncommitted work reached GitHub unchanged" || bad "test.js on GitHub differs from the local work"

echo "=== 5. the @syok job starts by itself and finishes"
RUN=""; for i in $(seq 1 40); do RUN="$(gh run list -R "$REPO" --workflow syok.yml --event issue_comment --created ">=$START" --json databaseId,status --jq '.[0].databaseId' 2>/dev/null)"; [ -n "$RUN" ] && break; sleep 6; done
[ -n "$RUN" ] && ok "the job started (run $RUN)" || { bad "the @syok job did not start within 4 minutes"; exit 1; }
gh run watch "$RUN" -R "$REPO" --interval 15 >/dev/null 2>&1
CON="$(gh run view "$RUN" -R "$REPO" --json conclusion --jq .conclusion)"; [ "$CON" = "success" ] && ok "the job finished: success" || { bad "the job finished: $CON"; gh run view "$RUN" -R "$REPO" --log 2>/dev/null | tail -40; }

echo "=== 6. the cloud's work, checked here"
git pull -q origin "$BRANCH" 2>&1 | tail -2
cmp -s test.js "$W/test.sent" && ok "test.js was not changed by the cloud" || bad "test.js was changed"
grep -q "multiply" calc.js && ok "calc.js now has multiply" || bad "calc.js has no multiply"
node test.js 2>&1 | grep -q "all tests passed" && ok "node test.js passes with the cloud's work" || { bad "node test.js fails"; cat calc.js; }
N="$(git rev-list --count origin/main..HEAD)"; [ "$N" -ge 2 ] && ok "the branch has the hand-over commit plus the cloud's commit ($N commits)" || bad "expected at least 2 commits on the branch, found $N"
gh pr view "$PR" -R "$REPO" --json comments --jq '.comments[].body' | grep -q "syok-code" && ok "the job answered on the pull request" || bad "no answer from the job on the pull request"

echo; if [ $fails -eq 0 ]; then echo "All cloud live checks passed."; else echo "$fails cloud live check(s) FAILED"; exit 1; fi
