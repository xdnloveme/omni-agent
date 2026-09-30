"""Container-local quiescence, sealed submission and verifier input validation."""

import argparse
import hashlib
import json
import os
import pwd
import shutil
import signal
import stat
import subprocess
import time
import uuid
from pathlib import Path, PurePosixPath


def regular_file(root, relative):
    path = PurePosixPath(relative)
    if (
        not relative
        or path.is_absolute()
        or any(part in ("..", ".") for part in relative.split("/"))
    ):
        raise ValueError("Invalid artifact path")
    current = Path(root)
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlink artifact is not allowed")
    if not stat.S_ISREG(current.stat().st_mode):
        raise ValueError("Artifact must be a regular file")
    return current


def file_info(root, name):
    path = regular_file(root, name)
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return {"path": name, "size": path.stat().st_size, "sha256": hasher.hexdigest()}


def validate_submission(directory, required):
    directory = Path(directory)
    receipt = json.loads(regular_file(directory, "handoff.json").read_text())
    if (
        set(receipt) != {"version", "collection_id", "collector_id", "artifacts"}
        or receipt["version"] != 1
    ):
        raise ValueError("Invalid handoff receipt")
    uuid.UUID(receipt["collection_id"])
    if not isinstance(receipt["collector_id"], str) or not receipt["collector_id"]:
        raise ValueError("Missing collector identity")
    names = set()
    for item in receipt["artifacts"]:
        if item != file_info(directory, item["path"]) or item["path"] in names:
            raise ValueError("Submission artifact hash/size mismatch or duplicate")
        names.add(item["path"])
    if names != set(required):
        raise ValueError("Submission does not match required artifact contract")
    return receipt


def solver_processes(uid):
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            status = (entry / "status").read_text()
            fields = dict(
                line.split(":", 1) for line in status.splitlines() if ":" in line
            )
            # Zombies cannot execute or mutate files and must be reaped by container PID 1.
            if int(fields["Uid"].split()[0]) == uid and not fields[
                "State"
            ].lstrip().startswith("Z"):
                found.append(int(entry.name))
        except FileNotFoundError:
            continue
    return found


def quiesce(uid):
    if uid == 0 or uid == os.getuid():
        raise ValueError("Refusing to clean management identity")
    for sig in (signal.SIGTERM, signal.SIGKILL):
        deadline = time.monotonic() + 5
        signalled = set()
        while True:
            processes = solver_processes(uid)
            if not processes:
                return
            for pid in set(processes) - signalled:
                try:
                    os.kill(pid, sig)
                    signalled.add(pid)
                except ProcessLookupError:
                    pass
            if time.monotonic() >= deadline:
                break
            time.sleep(0.05)
    if solver_processes(uid):
        raise RuntimeError("Solver process cleanup could not be confirmed")


def stop_primary(uid, pid_file):
    """Signal the declared main process before sweeping wrapper/worker processes.

    Signalling a forwarding wrapper and its child together can deliver TERM twice.
    The adapter writes this identity before exec; an absent file means no main exec.
    """
    pid_file = Path(pid_file)
    if not pid_file.exists():
        return
    path = regular_file(pid_file.parent, pid_file.name)
    if path.stat().st_uid != uid:
        raise PermissionError("Primary process identity must belong to the solver")
    try:
        pid = int(path.read_text())
    except ValueError:
        raise ValueError("Invalid primary process identity") from None
    if pid not in solver_processes(uid):
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 5
    while pid in solver_processes(uid) and time.monotonic() < deadline:
        time.sleep(0.05)
    if pid in solver_processes(uid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def collect(config, audit_dir):
    if os.geteuid() != 0:
        raise PermissionError("Handoff requires container management identity")
    account = pwd.getpwnam(config["user"])
    target = Path(config["submission_dir"])
    audit_dir = Path(audit_dir)
    audit_dir.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=True, exist_ok=True)
    if (
        target.is_symlink()
        or target.stat().st_uid != 0
        or target.stat().st_mode & 0o022
    ):
        raise PermissionError(
            "Submission directory must be management-owned and immutable to solver"
        )
    (target / "handoff.json").unlink(missing_ok=True)
    collection_id = str(uuid.uuid4())
    staging = Path(config["staging_dir"]) / collection_id
    with (audit_dir / "handoff.jsonl").open("a") as audit:

        def record(event, **details):
            audit.write(
                json.dumps(
                    {
                        "event": event,
                        "timestamp": time.time(),
                        "collection_id": collection_id,
                        **details,
                    }
                )
                + "\n"
            )
            audit.flush()

        record("started")
        try:
            quiesce(account.pw_uid)
            record("solver_stopped")
            staging.mkdir(parents=True)
            os.chown(staging, account.pw_uid, account.pw_gid)
            argv = [
                *config["collector_argv"],
                "--workspace",
                config["workspace"],
                "--output-dir",
                str(staging),
            ]
            try:
                with (
                    (audit_dir / "collector.stdout").open("wb") as out,
                    (audit_dir / "collector.stderr").open("wb") as err,
                ):
                    result = subprocess.run(
                        [
                            "runuser",
                            "--user",
                            config["user"],
                            "--preserve-environment",
                            "--",
                            *argv,
                        ],
                        cwd=config["workspace"],
                        env={**os.environ, "HOME": account.pw_dir},
                        stdout=out,
                        stderr=err,
                        timeout=60,
                    )
                if result.returncode != 0:
                    raise RuntimeError("Collector exited " + str(result.returncode))
            finally:
                quiesce(account.pw_uid)
            for name in config["required"]:
                source = regular_file(staging, name)
                destination = target / name
                # No solver process remains; target itself is management-owned.
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.is_symlink():
                    raise ValueError("Unexpected symlink in sealed destination")
                shutil.copyfile(source, destination)
                destination.chmod(0o644)
            receipt = {
                "version": 1,
                "collection_id": collection_id,
                "collector_id": config["collector_id"],
                "artifacts": [file_info(target, name) for name in config["required"]],
            }
            (target / "handoff.json").write_text(json.dumps(receipt, indent=2) + "\n")
            validate_submission(target, config["required"])
            record("completed")
        except BaseException as error:
            (target / "handoff.json").unlink(missing_ok=True)
            record("failed", error_type=type(error).__name__, error=str(error))
            raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    stop = sub.add_parser("stop")
    stop.add_argument("--user", required=True)
    stop.add_argument("--pid-file", type=Path, required=True)
    capture = sub.add_parser("collect")
    capture.add_argument("--config", type=Path, required=True)
    capture.add_argument("--audit-dir", type=Path, required=True)
    verify = sub.add_parser("validate")
    verify.add_argument("--directory", type=Path, required=True)
    verify.add_argument("--required", nargs="+", required=True)
    args = parser.parse_args()
    if args.action == "stop":
        uid = pwd.getpwnam(args.user).pw_uid
        if uid == 0 or os.getuid() != 0:
            raise PermissionError("Expected management caller and non-root solver")
        stop_primary(uid, args.pid_file)
        quiesce(uid)
    elif args.action == "collect":
        collect(json.loads(args.config.read_text()), args.audit_dir)
    else:
        validate_submission(args.directory, args.required)
