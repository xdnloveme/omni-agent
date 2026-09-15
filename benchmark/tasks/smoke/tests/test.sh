#!/bin/bash
set -euo pipefail
if node - <<'JS'
const fs = require('fs');
const assert = require('assert');
assert.equal(fs.readFileSync('/testbed/result.txt', 'utf8'), 'ready\n');
const execution = JSON.parse(fs.readFileSync('/testbed/execution.json', 'utf8'));
assert.equal(execution.cwd, '/testbed');
assert.equal(execution.node, 'v20.20.2');
JS
then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
