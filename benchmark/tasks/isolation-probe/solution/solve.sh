#!/bin/bash
set -euo pipefail
mkdir -p /submission
printf 'artifact-only\n' > /submission/probe.txt
printf 'must-not-transfer\n' > /tmp/agent-private-marker
