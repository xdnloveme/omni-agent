#!/bin/bash
set -euo pipefail
while (($#)); do
  case "$1" in
    --workspace) workspace=$2; shift 2;;
    --output-dir) output_dir=$2; shift 2;;
    --baseline-file) baseline_file=$2; shift 2;;
    *) echo "Unknown collector argument" >&2; exit 2;;
  esac
done
baseline=$(cat "$baseline_file")
output="$output_dir/changes.patch"
index_dir=$(mktemp -d)
trap 'rm -rf "$index_dir"' EXIT
export GIT_INDEX_FILE="$index_dir/index"
git -c safe.directory="$workspace" -C "$workspace" read-tree "$baseline"
# Use Git's tracked/non-ignored file semantics without modifying the Agent's index.
git -c safe.directory="$workspace" -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$workspace" add -A -- .
git -c safe.directory="$workspace" -C "$workspace" diff --cached --binary --no-ext-diff --no-textconv "$baseline" -- | head -c 16777217 > "$output"
test "$(wc -c < "$output")" -le 16777216
