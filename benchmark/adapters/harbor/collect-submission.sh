#!/bin/bash
set -euo pipefail
workspace=$1
baseline=$2
output=$3
index_dir=$(mktemp -d)
trap 'rm -rf "$index_dir"' EXIT
export GIT_INDEX_FILE="$index_dir/index"
git -c safe.directory="$workspace" -C "$workspace" read-tree "$baseline"
# Use Git's tracked/non-ignored file semantics without modifying the Agent's index.
git -c safe.directory="$workspace" -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$workspace" add -A -- .
git -c safe.directory="$workspace" -C "$workspace" diff --cached --binary --no-ext-diff --no-textconv "$baseline" -- | head -c 16777217 > "$output"
test "$(wc -c < "$output")" -le 16777216
