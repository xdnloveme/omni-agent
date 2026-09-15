#!/bin/bash
set -euo pipefail
bash /tests/apply-submission.sh /testbed /submission/changes.patch
exec bash /tests/upstream-test.sh
