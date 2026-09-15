FROM swebench/sweb.eval.x86_64.axios_1776_axios-4731@sha256:e75f3f2f1e91fbd09a00bd14a4c807dab210d58a5d7395b595cf65314d092bb1
COPY . /tests/
RUN mkdir -p /submission /logs/verifier && bash -c 'set +e; bash /tests/upstream-test.sh 2>&1 | tee /tmp/verifier-warm.log; result=${PIPESTATUS[0]}; set -e; test "$result" = 1; grep -qx FAILED /tmp/verifier-warm.log'
RUN /root/.local/bin/uv lock --script /parser.py && /root/.local/bin/uv --version > /tests/uv-version.txt && rm -f /logs/verifier/reward.txt

# Upstream graders can add fixtures; restore a clean baseline after warming caches.
RUN git -C /testbed reset --hard HEAD && git -C /testbed clean -fd && test -z "$(git -C /testbed status --porcelain)"
