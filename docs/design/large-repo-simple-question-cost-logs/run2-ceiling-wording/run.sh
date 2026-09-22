#!/usr/bin/env bash
# CG-39 T1.5 A/B on D:\UnrealEngine — new build (budget-as-ceiling wording).
# Protocol (docs/design/large-repo-simple-question-cost.md §6): sonnet / effort
# high, CLI-block hook on both arms, daemon pre-warmed, and the 1h prompt-cache
# window separated: the previous A/B's prefixes were last read at 23:27, so the
# first (cold) run of each arm starts after 00:32; the second run of each arm
# is deliberately WARM (seeded by its own cold run) so cold↔cold and warm↔warm
# pairs can be compared.
set -uo pipefail
S="$(cd "$(dirname "$0")" && pwd)"
LOGS=D:/Git/codegraph/docs/design/large-repo-simple-question-cost-logs
Q="프로젝트에 구현된 카메라 시스템에 대해서 알려줘"
WAIT_UNTIL="${WAIT_UNTIL:-00:32}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# Wait for the cache window to lapse.
while :; do
  now=$(date +%H:%M)
  if [[ "$now" > "$WAIT_UNTIL" || "$now" == "$WAIT_UNTIL" ]] && [[ "$now" < "12:00" ]]; then break; fi
  sleep 20
done
log "cache window lapsed — starting"

# Pre-warm the daemon so the first with-arm turn connects before the agent's first tool call.
# Windows note: `serve --mcp </dev/null` exits on stdin EOF BEFORE spawning the detached daemon,
# so hold its stdin open with a sleeping pipe instead (verified 2026-09-03: "Listening on
# \\.\pipe\codegraph-…" within 2s). The detached daemon outlives the client; idle timeout 1h.
cd /d/UnrealEngine || exit 1
n0=$(wc -l < D:/UnrealEngine/.codegraph/daemon.log 2>/dev/null || echo 0)
(sleep 900 | CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS=3600000 CODEGRAPH_WASM_RELAUNCHED=1 codegraph serve --mcp --path D:/UnrealEngine >"$S/daemon.out" 2>&1 &)
for i in $(seq 1 120); do
  if tail -n +$((n0+1)) D:/UnrealEngine/.codegraph/daemon.log 2>/dev/null | grep -q "Listening on"; then break; fi
  sleep 1
done
log "daemon: $(tail -n +$((n0+1)) D:/UnrealEngine/.codegraph/daemon.log | grep 'Listening on' | tail -1)"
sleep 5

run() {
  local arm=$1 i=$2 mcp
  if [[ $arm == with ]]; then mcp="$S/mcp-with.json"; else mcp="$LOGS/mcp-empty.json"; fi
  log "run-$arm-$i start"
  local t0=$(date +%s)
  claude -p "$Q" --model sonnet --effort high --output-format stream-json --verbose \
    --permission-mode bypassPermissions --strict-mcp-config --mcp-config "$mcp" \
    --settings "$S/hook-settings.json" \
    >"$S/run-$arm-$i.jsonl" 2>"$S/run-$arm-$i.err"
  log "run-$arm-$i done rc=$? in $(( $(date +%s) - t0 ))s"
}

run with 1      # cold
run without 1   # cold
run with 2      # warm (seeded by with-1)
run without 2   # warm (seeded by without-1)

cd /d/Git/codegraph
node scripts/agent-eval/compare-arms.mjs "$S" with without > "$S/compare.txt" 2>&1
for f in "$S"/run-*.jsonl; do node scripts/agent-eval/parse-run.mjs --brief "$f" >> "$S/parse.txt" 2>&1; done
log "all done"
