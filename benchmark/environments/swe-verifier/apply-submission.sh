#!/bin/bash
set -euo pipefail
workspace=$1
patch=$2
test -f "$patch" && test ! -L "$patch"
test "$(wc -c < "$patch")" -le 16777216
# Image extraction can invalidate Git stat caches; refresh must reject real changes.
git -c safe.directory="$workspace" -C "$workspace" update-index --refresh
# Git owns patch parsing, worktree-boundary checks and applicability.
if test -s "$patch"; then
  git -c safe.directory="$workspace" -C "$workspace" apply --check --index "$patch"
  git -c safe.directory="$workspace" -C "$workspace" apply --index "$patch"
fi
# This protocol accepts regular-file changes/deletions, not new links or submodules.
git -c safe.directory="$workspace" -C "$workspace" diff --cached --raw --no-renames --no-abbrev -z |
python3 -c '
import sys
entries = sys.stdin.buffer.read().split(b"\0")
for record in entries[:-1:2]:
    if record.startswith(b":"):
        mode = record.split()[1]
        if mode not in {b"000000", b"100644", b"100755"}:
            raise SystemExit("Unsupported submission file mode: " + mode.decode())
'
