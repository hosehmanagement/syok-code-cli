#!/bin/sh
# LIVE test of the one-file program users actually install, against the real Modal service.
# Usage: sh test/live/bundle-live.sh /path/to/syok.js
# Run it where the build folders (node_modules) are NOT present, so it proves the file works by itself.
set -u
SYOK="$1"
if [ -z "${MODAL_TOKEN_ID:-}" ] || [ -z "${MODAL_TOKEN_SECRET:-}" ]; then echo "SKIPPED: no Modal token (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET)."; exit 0; fi
fails=0
check() { if [ "$2" = "ok" ]; then echo "PASS $1"; else echo "FAIL $1  $3"; fails=$((fails+1)); fi; }
has() { case "$1" in *"$2"*) echo ok ;; *) echo no ;; esac; }
D=$(mktemp -d); cd "$D" || exit 1
mkdir data
printf 'INPUT-555\n' > data/in.txt
printf 'SECRET=1\n' > .env
cat > job.sh <<'J'
echo "start $(cat data/in.txt)"
echo warn >&2
mkdir -p results && echo made-by-bundle > results/out.txt
if [ -f .env ]; then echo env-present; else echo env-absent; fi
exit 0
J
cat > tick.sh <<'J'
i=0; mkdir -p results; while [ $i -lt 5 ]; do i=$((i+1)); echo tick $i; echo $i > results/last.txt; sleep 2; done; exit 4
J

# 1. Normal run through the command line.
out=$(bun "$SYOK" run --on modal --timeout 10 --out results -- sh job.sh 2>err.txt); code=$?
echo "$out"; cat err.txt
check "run: exit code 0" "$([ $code -eq 0 ] && echo ok || echo no)" "got $code"
check "run: output streamed" "$(has "$out" "start INPUT-555")" ""
check "run: error output arrives on stderr" "$(has "$(cat err.txt)" "warn")" ""
check "run: secret file was not sent" "$(has "$out" "env-absent")" ""
check "run: results came back" "$([ "$(cat results/out.txt 2>/dev/null)" = "made-by-bundle" ] && echo ok || echo no)" ""
check "run: computer switched off" "$(has "$out" "Remote computer switched off")" ""

# 2. A failing command keeps its exit code.
bun "$SYOK" run --on modal --timeout 5 --no-upload -- "echo before; exit 9" > out2.txt 2>&1; code=$?
check "failing command: exit code 9" "$([ $code -eq 9 ] && echo ok || echo no)" "got $code: $(tail -n 3 out2.txt)"

# 3. Detached run, then logs and stop from separate program starts.
out=$(bun "$SYOK" run --on modal --timeout 10 --detach --out results -- sh tick.sh 2>&1); code=$?
echo "$out"
check "detach: started" "$([ $code -eq 0 ] && has "$out" "Started as remote run 1")" "exit $code"
check "detach: listed as on" "$(has "$(bun "$SYOK" remote 2>&1)" "billing")" ""
sleep 6
logs=$(bun "$SYOK" remote logs 1 2>&1); echo "$logs"
check "detach: output visible from a new program start" "$(has "$logs" "tick 1")" ""
n=0; while [ $n -lt 30 ]; do logs=$(bun "$SYOK" remote logs 1 2>&1); case "$logs" in *"finished, exit code 4"*) break ;; esac; n=$((n+1)); sleep 2; done
check "detach: finished with its own exit code 4" "$(has "$logs" "finished, exit code 4")" "$(echo "$logs" | tail -n 2)"
stop=$(bun "$SYOK" remote stop 1 2>&1); echo "$stop"
check "detach: stop switched the computer off" "$(has "$stop" "computer switched off")" ""
check "detach: results came back" "$([ "$(cat results/last.txt 2>/dev/null)" = "5" ] && echo ok || echo no)" "$(cat results/last.txt 2>&1)"
check "detach: listed as stopped" "$(has "$(bun "$SYOK" remote 2>&1)" "stopped, exit code 4")" ""
again=$(bun "$SYOK" remote logs 1 2>&1); check "detach: log is gone after stop (says so)" "$(has "$again" "was stopped")" "$again"

if [ $fails -eq 0 ]; then echo; echo "All bundle live checks passed."; exit 0; else echo; echo "$fails bundle check(s) FAILED"; exit 1; fi
