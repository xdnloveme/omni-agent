#!/bin/bash
set -euo pipefail
test "$(cat /submission/probe.txt)" = artifact-only
test ! -e /tmp/agent-private-marker
test ! -e /home/omni-benchmark/output
test -z "${ARK_AGENT_PLAN_API_KEY:-}"
python3 - <<'PY'
from pathlib import Path
interfaces = {path.name for path in Path('/sys/class/net').iterdir()}
assert interfaces == {'lo'}, interfaces
print('separate verifier: declared artifact present; private state absent; loopback only')
PY
printf '1\n' > /logs/verifier/reward.txt
