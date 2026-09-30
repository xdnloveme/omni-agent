# /// script
# requires-python = ">=3.11"
# dependencies = ["swebench==4.0.3", "datasets==2.16.1", "fastcore==1.10.5", "pyarrow==18.1.0"]
# ///
"""Persist official SWE TestSpec during build; grade without regenerating it."""

import argparse
import hashlib
import json
import subprocess
import tempfile
from dataclasses import asdict, fields
from importlib.metadata import version
from pathlib import Path

from swebench.harness.constants import END_TEST_OUTPUT, START_TEST_OUTPUT
from swebench.harness.grading import get_eval_report, get_logs_eval
from swebench.harness.test_spec.test_spec import TestSpec, make_test_spec

VERSION = "4.0.3"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def baseline():
    return subprocess.check_output(
        [
            "git",
            "-c",
            "safe.directory=/testbed",
            "-C",
            "/testbed",
            "rev-parse",
            "HEAD",
            "HEAD^{tree}",
        ],
        text=True,
    ).splitlines()


def restore(directory):
    metadata = json.loads((directory / "spec-manifest.json").read_text())
    if metadata["schema"] != 1 or metadata["swebench"] != version("swebench"):
        raise ValueError("Unsupported TestSpec schema or SWE-bench version")
    if metadata["swebench"] != VERSION:
        raise ValueError("Unexpected SWE-bench version")
    for name, expected in metadata["files"].items():
        if digest(directory / name) != expected:
            raise ValueError("Scoring asset hash mismatch: " + name)
    if set(metadata["files"]) != {
        "test-spec.json",
        "eval.sh",
        "config.json",
        "grade.py.lock",
    }:
        raise ValueError("Incomplete scoring asset manifest")
    value = json.loads((directory / "test-spec.json").read_text())
    if set(value) != {field.name for field in fields(TestSpec)}:
        raise ValueError("Incomplete or unknown TestSpec fields")
    spec = TestSpec(**value)
    if spec.eval_script != (directory / "eval.sh").read_text():
        raise ValueError("Official eval script differs from persisted TestSpec")
    if not spec.FAIL_TO_PASS:
        raise ValueError("Scored task requires FAIL_TO_PASS references")
    return spec


def prepare(directory):
    if version("swebench") != VERSION:
        raise ValueError("Unexpected SWE-bench version")
    from build_dependencies import prepare as prepare_build_dependencies

    prepare_build_dependencies(directory)
    # This is the only network-capable specification-generation boundary.
    spec = make_test_spec(json.loads((directory / "config.json").read_text()))
    write_json(directory / "test-spec.json", asdict(spec))
    (directory / "eval.sh").write_text(spec.eval_script)
    write_json(
        directory / "spec-manifest.json",
        {
            "schema": 1,
            "baseline": baseline(),
            "swebench": VERSION,
            "files": {
                name: digest(directory / name)
                for name in (
                    "test-spec.json",
                    "eval.sh",
                    "config.json",
                    "grade.py.lock",
                )
            },
        },
    )
    if asdict(restore(directory)) != asdict(spec):
        raise ValueError("TestSpec did not round-trip")


def report(spec, log, patch):
    statuses, found = get_logs_eval(spec, str(log))
    if not found or not statuses:
        raise ValueError("Official parser did not find a valid test run")
    result = get_eval_report(
        spec,
        {
            "instance_id": spec.instance_id,
            "model_name_or_path": "benchmark",
            "model_patch": patch.read_text(),
        },
        str(log),
        include_tests_status=True,
    )
    item = result[spec.instance_id]
    if (
        not item["patch_successfully_applied"]
        or not isinstance(item["resolved"], bool)
        or "tests_status" not in item
    ):
        raise ValueError("Incomplete official grading report")
    return result


def grade(directory, logs, patch):
    logs.mkdir(parents=True, exist_ok=True)
    # No prior result or test transcript may describe a failed new invocation.
    for name in (
        "reward.txt",
        "report.json",
        "error.json",
        "command-errors.log",
        "test-output.txt",
    ):
        (logs / name).unlink(missing_ok=True)
    stage = "asset_validation"
    command_failure = None
    try:
        spec = restore(directory)
        stage = "baseline_validation"
        if (
            baseline()
            != json.loads((directory / "spec-manifest.json").read_text())["baseline"]
        ):
            raise ValueError("Verifier image baseline changed")
        if subprocess.check_output(
            [
                "git",
                "-c",
                "safe.directory=/testbed",
                "-C",
                "/testbed",
                "status",
                "--porcelain",
            ]
        ):
            raise ValueError("Verifier workspace is not clean before submission")
        stage = "patch_application"
        subprocess.run(
            ["bash", str(directory / "apply-submission.sh"), "/testbed", str(patch)],
            check=True,
        )
        errors = logs / "command-errors.log"
        # Preserve the official script's $0 and empty positional arguments. Observe
        # top-level failures only; helper functions own their internal status handling.
        wrapper = (
            'readonly omni_verifier_error_log="$1"; shift; '
            'trap \'printf "%s\\t%s\\n" "$?" "$BASH_COMMAND" >> "$omni_verifier_error_log"\' ERR; '
            'source "$0"'
        )
        log = logs / "test-output.txt"
        stage = "evaluation"
        with log.open("w") as output:
            process = subprocess.run(
                [
                    "bash",
                    "-c",
                    wrapper,
                    str(directory / "eval.sh"),
                    str(errors),
                ],
                stdout=output,
                stderr=subprocess.STDOUT,
            )
        if process.returncode:
            command_failure = {"exit_code": process.returncode}
            raise ValueError(f"Official eval process exited {process.returncode}")
        commands = spec.eval_script_list
        start = commands.index(f": '{START_TEST_OUTPUT}'")
        end = commands.index(f": '{END_TEST_OUTPUT}'")
        test_commands = commands[start + 1 : end]
        if errors.exists():
            for line in errors.read_text().splitlines():
                status, command = line.split("\t", 1)
                if status != "1" or command not in test_commands:
                    command_failure = {"exit_code": int(status), "command": command}
                    raise ValueError("Official eval command failed: " + line)
        stage = "report_parsing"
        result = report(spec, log, patch)
        stage = "result_publication"
        write_json(logs / "report.json", result)
        (logs / "reward.txt").write_text(
            "1\n" if result[spec.instance_id]["resolved"] else "0\n"
        )
    except Exception as error:
        if isinstance(error, subprocess.CalledProcessError):
            command_failure = {"exit_code": error.returncode, "argv": error.cmd}
        write_json(
            logs / "error.json",
            {
                "version": 1,
                "stage": stage,
                "type": type(error).__name__,
                "message": str(error),
                "command_failure": command_failure,
            },
        )
        raise


def validate_controls(directory):
    """Gold/empty controls use the exact grading path, on disposable build state."""
    (directory / "control-validation.json").unlink(missing_ok=True)
    expected_baseline = baseline()
    controls = []
    with tempfile.TemporaryDirectory(prefix="swe-controls-") as temporary:
        root = Path(temporary)
        for name, patch_text, expected in (
            ("empty", "", False),
            (
                "gold",
                json.loads((directory / "config.json").read_text())["patch"],
                True,
            ),
        ):
            patch = root / (name + ".patch")
            patch.write_text(patch_text)
            logs = root / name
            try:
                grade(directory, logs, patch)
                reward = (logs / "reward.txt").read_text().strip()
                if reward != str(int(expected)):
                    raise ValueError("Grading control outcome mismatch: " + name)
                controls.append(
                    {
                        "control": name,
                        "reward": int(reward),
                        "report": json.loads((logs / "report.json").read_text()),
                    }
                )
            except Exception:
                if (logs / "test-output.txt").exists():
                    print((logs / "test-output.txt").read_text(), flush=True)
                raise
            finally:
                subprocess.run(
                    ["git", "-C", "/testbed", "reset", "--hard", expected_baseline[0]],
                    check=True,
                )
                subprocess.run(["git", "-C", "/testbed", "clean", "-fd"], check=True)
        if baseline() != expected_baseline:
            raise ValueError("Grading controls changed verifier baseline")
    write_json(
        directory / "control-validation.json",
        {
            "spec_manifest_sha256": digest(directory / "spec-manifest.json"),
            "controls": controls,
        },
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "grade", "validate-controls"])
    parser.add_argument("--directory", type=Path, default=Path("/tests"))
    parser.add_argument("--logs", type=Path, default=Path("/logs/verifier"))
    parser.add_argument("--patch", type=Path, default=Path("/submission/changes.patch"))
    args = parser.parse_args()
    if args.mode == "prepare":
        prepare(args.directory)
    elif args.mode == "validate-controls":
        validate_controls(args.directory)
    else:
        grade(args.directory, args.logs, args.patch)
