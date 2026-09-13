#!/usr/bin/env bash
#
# Codex, capped.
#
# Codex is allowed on this project as a second pair of eyes and a second pair of
# hands, but only at the light end: GPT-6-Astra at `low` reasoning effort, whose
# own description is "fast responses with lighter reasoning". Everything above
# it — medium, high, xhigh, max, ultra — is refused here rather than left to
# whoever types the next command.
#
# There is no `gpt-6-astra-light` model. Asking for one is rejected by the API
# ("not supported when using Codex with a ChatGPT account"), so the ceiling is
# expressed as the model plus its lightest reasoning tier.
#
# Usage:
#   scripts/codex-light.sh "prompt"                 # read-only, safe to run anywhere
#   scripts/codex-light.sh --write "prompt"         # may edit files in this repo
#   CODEX_BIN=/path/to/codex.exe scripts/codex-light.sh "prompt"
#
# The global ~/.codex/config.toml is deliberately untouched: it is the user's
# own interactive Codex, and capping a shared machine-wide setting from inside
# one project's repo is not this script's business.

set -euo pipefail

MODEL="gpt-6-astra"
EFFORT="low"

find_codex() {
  if [ -n "${CODEX_BIN:-}" ]; then printf '%s' "$CODEX_BIN"; return; fi
  if command -v codex >/dev/null 2>&1; then command -v codex; return; fi
  # The installer keeps the binary under a content-hashed directory that changes
  # on every update, so pick the newest one rather than pinning a hash.
  local root="$HOME/AppData/Local/OpenAI/Codex/bin"
  local found
  found=$(ls -td "$root"/*/ 2>/dev/null | while read -r dir; do
    [ -x "${dir}codex.exe" ] && printf '%s\n' "${dir}codex.exe" && break
  done)
  [ -n "$found" ] && printf '%s' "$found"
}

CODEX=$(find_codex)
if [ -z "$CODEX" ]; then
  echo "codex-light: no codex binary found. Set CODEX_BIN to its path." >&2
  exit 127
fi

SANDBOX="read-only"
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --write)
      # Still confined to this workspace; Codex cannot reach outside it.
      SANDBOX="workspace-write"
      ;;
    -m|--model|-m=*|--model=*)
      echo "codex-light: the model is fixed at $MODEL. Refusing '$arg'." >&2
      exit 2
      ;;
    *model_reasoning_effort*|*reasoning_effort*|--effort*)
      echo "codex-light: the reasoning effort is capped at '$EFFORT'. Refusing '$arg'." >&2
      exit 2
      ;;
    *danger-full-access*)
      echo "codex-light: full disk access is not available through this wrapper." >&2
      exit 2
      ;;
    *)
      ARGS+=("$arg")
      ;;
  esac
done

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "codex-light: nothing to do. Give it a prompt." >&2
  exit 64
fi

exec "$CODEX" exec \
  -m "$MODEL" \
  -c "model_reasoning_effort=\"$EFFORT\"" \
  -s "$SANDBOX" \
  --skip-git-repo-check \
  "${ARGS[@]}"
