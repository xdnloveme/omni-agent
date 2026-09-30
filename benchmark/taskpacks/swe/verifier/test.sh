#!/bin/bash
set -euo pipefail
# Harbor collect is best-effort: absent/invalid handoff must never become a score.
rm -f /logs/verifier/reward.txt /logs/verifier/report.json
/usr/bin/python3 /tests/handoff.py validate --directory /submission --required changes.patch
export UV_OFFLINE=1
exec /root/.local/bin/uv run --locked --script /tests/grade.py grade
