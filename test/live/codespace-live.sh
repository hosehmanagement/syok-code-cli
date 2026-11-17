#!/bin/sh
# LIVE test of "syok run --on codespace" against a real GitHub Codespace, through the real gh tool.
# Usage: sh test/live/codespace-live.sh /path/to/syok.js <codespace-name>
# Needs gh signed in with the "codespace" scope (GH_TOKEN). Uses the Codespace for a few minutes.
set -u
SYOK="$1"; CS="$2"
export SYOK_EXPERIMENTAL=codespace
fails=0
check() { if [ "$2" = "ok" ]; then echo "PASS $1"; else echo "FAIL $1  $3"; fails=$((fails+1)); fi; }
has() { case "$1" in *"$2"*) echo ok ;; *) echo no ;; esac; }
D=$(mktemp -d); cd "$D" || exit 1
mkdir data
printf 'INPUT-321\n' > data/in.txt
printf 'SECRET=1\n' > .env
cat > job.sh <<'J'
echo "start $(cat data/in.txt)"
echo warn >&2
mkdir -p results && echo made-on-codespace > results/out.txt
if [ -f .env ]; then echo env-present; else echo env-absent; fi
echo "quote test: it's \"fine\" \$HOME"
J
cat > tick.sh <<'J'
i=0; mkdir -p results; while [ $i -lt 5 ]; do i=$((i+1)); echo tick $i; echo $i > results/last.txt; sleep 2; done; exit 4
J
printf 'while true; do date >> alive.txt; sleep 1; done\n' > forever.sh

out=$(bun "$SYOK" run --on codespace --codespace "$CS" --timeout 10 --out results -- sh job.sh 2>err.txt); code=$?
echo "$out"; cat err.txt
check "run: exit code 0" "$([ $code -eq 0 ] && echo ok || echo no)" "got $code"
check "run: output streamed" "$(has "$out" "start INPUT-321")" ""
check "run: quoting survives the trip" "$(has "$out" "quote test: it's \"fine\" \$HOME")" ""
check "run: error output arrives on stderr" "$(has "$(cat err.txt)" "warn")" ""
check "run: secret file was not sent" "$(has "$out" "env-absent")" ""
check "run: results came back" "$([ "$(cat results/out.txt 2>/dev/null)" = "made-on-codespace" ] && echo ok || echo no)" ""
check "run: its folder was removed" "$(has "$out" "folder on the Codespace was removed")" ""
left=$(gh codespace ssh -c "$CS" -- 'ls /tmp/syok-runs 2>/dev/null | wc -l' 2>/dev/null | tr -d ' \r\n')
check "run: nothing left in /tmp/syok-runs" "$([ "$left" = "0" ] && echo ok || echo no)" "left: $left"

bun "$SYOK" run --on codespace --codespace "$CS" --timeout 5 --no-upload -- "echo before; exit 9" > out2.txt 2>&1; code=$?
check "failing command: exit code 9" "$([ $code -eq 9 ] && echo ok || echo no)" "got $code: $(tail -n 3 out2.txt)"

bun "$SYOK" run --on codespace --codespace "$CS" --gpu T4 -- echo hi > out3.txt 2>&1; code=$?
check "gpu is refused for a Codespace" "$([ $code -ne 0 ] && has "$(cat out3.txt)" "cannot be used with Codespace")" "$(cat out3.txt)"

out=$(bun "$SYOK" run --on codespace --codespace "$CS" --timeout 10 --detach --out results -- sh tick.sh 2>&1); code=$?
echo "$out"
check "detach: started" "$([ $code -eq 0 ] && has "$out" "Started as remote run 1")" "exit $code"
sleep 5
logs=$(bun "$SYOK" remote logs 1 2>&1); echo "$logs"
check "detach: output visible from a new program start" "$(has "$logs" "tick 1")" ""
n=0; while [ $n -lt 30 ]; do logs=$(bun "$SYOK" remote logs 1 2>&1); case "$logs" in *"finished, exit code 4"*) break ;; esac; n=$((n+1)); sleep 2; done
check "detach: finished with its own exit code 4" "$(has "$logs" "finished, exit code 4")" "$(echo "$logs" | tail -n 2)"
stop=$(bun "$SYOK" remote stop 1 2>&1); echo "$stop"
check "detach: stop removed the folder" "$(has "$stop" "folder on the Codespace removed")" ""
check "detach: results came back" "$([ "$(cat results/last.txt 2>/dev/null)" = "5" ] && echo ok || echo no)" "$(cat results/last.txt 2>&1)"

out=$(bun "$SYOK" run --on codespace --codespace "$CS" --timeout 10 --detach -- sh forever.sh 2>&1)
sleep 4
bun "$SYOK" remote stop 2 > stop2.txt 2>&1; cat stop2.txt
sleep 3
alive=$(gh codespace ssh -c "$CS" -- 'pgrep -f forever.sh | wc -l' 2>/dev/null | tr -d ' \r\n')
check "detach: stop really kills a job that never ends" "$([ "$alive" = "0" ] && echo ok || echo no)" "processes left: $alive"

if [ $fails -eq 0 ]; then echo; echo "All Codespace live checks passed."; exit 0; else echo; echo "$fails Codespace check(s) FAILED"; exit 1; fi
