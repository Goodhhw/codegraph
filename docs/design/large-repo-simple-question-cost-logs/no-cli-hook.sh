#!/usr/bin/env bash
set -uo pipefail
cmd="$(cat | jq -r '.tool_input.command // empty' 2>/dev/null)"
if printf '%s' "$cmd" | grep -Eq '(^|[;&|(]|&&|\|\||\$\(|`)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*[A-Za-z0-9_./~-]*codegraph([[:space:]]|$)'; then
  msg="The codegraph CLI is not available in this session. Answer using the tools you have."
  jq -n --arg m "$msg" '{reason:$m, hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$m}}'
fi
exit 0
