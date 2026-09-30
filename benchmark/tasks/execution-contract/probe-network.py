"""Executed by the real Bash tool after the model channel handshake, without API spend."""

import errno
import json
import os
from pathlib import Path
import socket
import stat
import subprocess

checks = {}
interfaces = sorted(p.name for p in Path("/sys/class/net").iterdir())
assert interfaces == ["lo"], interfaces
checks["interfaces"] = interfaces
assert "OMNI_SMOKE_API_KEY" not in os.environ
checks["credential_absent"] = True
assert not Path("/installed-agent/omni.providers.json").exists()
assert not Path("/home/benchmark-runner/model/providers.json").exists()
checks["provider_config_absent"] = True
for name, family, address in [
    ("ipv4", socket.AF_INET, ("1.1.1.1", 443)),
    ("ipv6", socket.AF_INET6, ("2606:4700:4700::1111", 443)),
    ("provider", socket.AF_INET, ("127.0.0.1", 18080)),
    ("model_channel", socket.AF_UNIX, "/run/omni-model/session.sock"),
]:
    with socket.socket(family, socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        try:
            connection.connect(address)
        except OSError as error:
            assert error.errno in (
                errno.ENETUNREACH,
                errno.ECONNREFUSED,
                errno.ENOENT,
                errno.EAFNOSUPPORT,
            ), (name, error)
            checks[name] = {"blocked": True, "errno": error.errno}
        else:
            raise AssertionError(name + " unexpectedly connected")
# No capability is inherited through spawn. Opening another process's socket FD
# as a file must not produce a second usable model connection either.
for fd in Path("/proc/self/fd").iterdir():
    if int(fd.name) <= 2:
        continue  # Tool stdin/stdout/stderr are intentional, not model capabilities.
    try:
        inherited_socket = stat.S_ISSOCK(fd.stat().st_mode)
    except FileNotFoundError:
        continue
    assert not inherited_socket, str(fd)
checks["no_inherited_socket"] = True
pid = int(Path("/home/benchmark-runner/output/agent.pid").read_text())
checked = 0
for fd in Path("/proc/" + str(pid) + "/fd").iterdir():
    try:
        if not stat.S_ISSOCK(fd.stat().st_mode):
            continue
    except FileNotFoundError:
        continue
    try:
        handle = os.open(fd, os.O_RDWR)
    except OSError as error:
        assert error.errno in (errno.ENXIO, errno.EACCES, errno.EPERM), error
        checked += 1
    else:
        os.close(handle)
        raise AssertionError("Tool reopened parent socket")
assert checked > 0, "No parent socket was inspected"
checks["parent_sockets_not_reopenable"] = checked
curl = subprocess.run(
    ["curl", "--noproxy", "*", "--max-time", "2", "-sS", "https://example.com"],
    capture_output=True,
)
assert curl.returncode != 0
checks["curl_blocked"] = curl.returncode
Path("/home/benchmark-runner/output/network-probe.json").write_text(
    json.dumps(checks, indent=2) + "\n"
)
print(json.dumps(checks))
