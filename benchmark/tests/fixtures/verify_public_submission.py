"""Verifier-side evidence for the opt-in public-network lifecycle acceptance."""

import json
import os
import pwd
import sys
from pathlib import Path
import time
import urllib.request

from handoff import file_info, validate_submission

root = Path("/submission")
required = ["result.txt", "execution.json"]
validate_submission(root, required)


def snapshot():
    return {
        name: file_info(root, name)["sha256"] for name in [*required, "handoff.json"]
    }


before = snapshot()
if "--seal" in sys.argv:
    account = pwd.getpwnam("benchmark-runner")
    pid = os.fork()
    if pid == 0:
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
        for name in [*required, "handoff.json", "unexpected-write"]:
            try:
                fd = os.open(str(root / name), os.O_WRONLY | os.O_CREAT, 0o600)
            except PermissionError:
                continue
            else:
                os.close(fd)
                os._exit(1)
        os._exit(0)
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0, (
        "Solver identity can write sealed input"
    )
    Path("/benchmark-audit/seal-probe.json").write_text(
        json.dumps(
            {
                "solver_write_denied": True,
                "hashes": before,
                "collection_id": json.loads((root / "handoff.json").read_text())[
                    "collection_id"
                ],
            },
            indent=2,
        )
    )
    sys.exit(0)
with urllib.request.urlopen("https://example.com", timeout=20) as response:
    http_status = response.status
    assert http_status == 200
    response.read(1024)
validate_submission(root, required)
after = snapshot()
assert before == after
Path("/logs/verifier/public-submission.json").write_text(
    json.dumps(
        {
            "container": Path("/etc/hostname").read_text().strip(),
            "timestamp": time.time(),
            "http_status": http_status,
            "interfaces": sorted(p.name for p in Path("/sys/class/net").iterdir()),
            "before": before,
            "after": after,
        },
        indent=2,
    )
)
