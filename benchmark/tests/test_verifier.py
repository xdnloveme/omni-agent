"""Opt-in real-container contract tests; build the first Verified verifier image first."""

import hashlib
import json
import os
import shlex
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("OMNI_TEST_VERIFIER_IMAGE")


@unittest.skipUnless(IMAGE, "Set OMNI_TEST_VERIFIER_IMAGE for offline container tests")
class OfflineVerifierContractTest(unittest.TestCase):
    def run_case(
        self,
        setup,
        expected_reward=None,
        expected_error=None,
        patch=None,
        expected_stage=None,
    ):
        name = "omni-verifier-test-" + uuid.uuid4().hex[:12]
        command = (
            "mkdir -p /submission /logs/verifier; touch /submission/changes.patch; "
            + setup
            + "; python3 -c "
            + shlex.quote(
                "import sys,json,uuid; sys.path.insert(0,'/tests'); from handoff import file_info; from pathlib import Path; "
                "Path('/submission/handoff.json').write_text(json.dumps({'version':1,'collection_id':str(uuid.uuid4()),'collector_id':'trusted-test-fixture','artifacts':[file_info(Path('/submission'),'changes.patch')]}))"
            )
            + "; exec bash /tests/test.sh"
        )
        try:
            subprocess.run(
                [
                    "docker",
                    "create",
                    "--name",
                    name,
                    "--platform",
                    "linux/amd64",
                    "--network",
                    "none",
                    "--entrypoint",
                    "bash",
                    IMAGE,
                    "-ec",
                    command,
                ],
                check=True,
                capture_output=True,
            )
            if patch is not None:
                subprocess.run(
                    ["docker", "cp", str(patch), name + ":/submission/changes.patch"],
                    check=True,
                    capture_output=True,
                )
            # Exercise current boundary code against the frozen official scoring environment.
            for source, destination in [
                (ROOT / "benchmark/environments/handoff.py", "/tests/handoff.py"),
                (ROOT / "benchmark/taskpacks/swe/verifier/test.sh", "/tests/test.sh"),
                (ROOT / "benchmark/taskpacks/swe/verifier/grade.py", "/tests/grade.py"),
            ]:
                subprocess.run(
                    ["docker", "cp", str(source), name + ":" + destination],
                    check=True,
                    capture_output=True,
                )
            inspect = json.loads(subprocess.check_output(["docker", "inspect", name]))[
                0
            ]
            self.assertEqual(inspect["HostConfig"]["NetworkMode"], "none")
            result = subprocess.run(
                ["docker", "start", "-a", name], capture_output=True, timeout=240
            )
            with tempfile.TemporaryDirectory() as temporary:
                subprocess.run(
                    ["docker", "cp", name + ":/logs/verifier/.", temporary],
                    check=True,
                    capture_output=True,
                )
                logs = Path(temporary)
                if evidence := os.environ.get("OMNI_TEST_VERIFIER_EVIDENCE"):
                    target = Path(evidence) / name
                    shutil.copytree(logs, target)
                    (target / "container.json").write_text(
                        json.dumps(inspect, indent=2)
                    )
                    (target / "process.json").write_text(
                        json.dumps(
                            {
                                "exit_code": result.returncode,
                                "expected_reward": expected_reward,
                                "setup": setup,
                                "patch_sha256": hashlib.sha256(
                                    Path(patch).read_bytes()
                                ).hexdigest()
                                if patch is not None
                                else None,
                            },
                            indent=2,
                        )
                    )
                    (target / "stdout.txt").write_bytes(result.stdout)
                    (target / "stderr.txt").write_bytes(result.stderr)
                if expected_reward is None:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((logs / "reward.txt").exists())
                    self.assertFalse((logs / "report.json").exists())
                    error_record = json.loads((logs / "error.json").read_text())
                    self.assertEqual(error_record["version"], 1)
                    self.assertEqual(error_record["stage"], expected_stage)
                    if expected_stage in {
                        "asset_validation",
                        "baseline_validation",
                        "patch_application",
                    }:
                        self.assertFalse((logs / "test-output.txt").exists())
                    if expected_stage == "evaluation":
                        self.assertIsInstance(
                            error_record["command_failure"]["exit_code"], int
                        )
                    self.assertIn(
                        expected_error,
                        json.loads((logs / "error.json").read_text())["message"],
                    )
                else:
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    self.assertEqual(
                        (logs / "reward.txt").read_text().strip(), str(expected_reward)
                    )
                    report = json.loads((logs / "report.json").read_text())
                    self.assertEqual(len(report), 1)
                    item = next(iter(report.values()))
                    self.assertEqual(item["resolved"], bool(expected_reward))
                    self.assertTrue(item["patch_successfully_applied"])
                    self.assertIn("tests_status", item)
                    # Assert the selected task's official regression outcome, not
                    # a test name belonging to one particular fixture image.
                    self.assertTrue(
                        item["tests_status"]["FAIL_TO_PASS"][
                            "success" if expected_reward else "failure"
                        ]
                    )
        finally:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)

    def test_official_gold_and_empty_patch_are_scored_offline(self):
        for gold in (True, False):
            with self.subTest(gold=gold):
                setup = (
                    'python3 -c \'import json; from pathlib import Path; Path("/submission/changes.patch").write_text(json.load(open("/tests/config.json"))["patch"])\''
                    if gold
                    else ":"
                )
                self.run_case(setup, int(gold))

    def test_workspace_and_patch_failures_report_their_own_stage(self):
        self.run_case(
            "touch /testbed/unexpected-grading-state",
            expected_error="Verifier workspace is not clean",
            expected_stage="baseline_validation",
        )
        self.run_case(
            "printf 'invalid patch\\n' > /submission/changes.patch",
            expected_error="returned non-zero exit status",
            expected_stage="patch_application",
        )

    def test_invalid_assets_never_reuse_a_previous_score(self):
        for damage, error in (
            ("echo damaged >> /tests/test-spec.json", "Scoring asset hash mismatch"),
            ("rm /tests/eval.sh", "No such file or directory"),
        ):
            with self.subTest(damage=damage):
                self.run_case(
                    "echo 1 > /logs/verifier/reward.txt; echo '{}' > /logs/verifier/report.json; echo stale > /logs/verifier/test-output.txt; "
                    + damage,
                    expected_error=error,
                    expected_stage="asset_validation",
                )

    def broken_eval_setup(self, change):
        script = "\n".join(
            [
                "import json, hashlib",
                "from pathlib import Path",
                "root = Path('/tests')",
                "spec = json.loads((root / 'test-spec.json').read_text())",
                change,
                "(root / 'test-spec.json').write_text(json.dumps(spec))",
                "(root / 'eval.sh').write_text('\\n'.join(['#!/bin/bash', 'set -uxo pipefail'] + spec['eval_script_list']) + '\\n')",
                "manifest = json.loads((root / 'spec-manifest.json').read_text())",
                "manifest['files'] = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in manifest['files']}",
                "(root / 'spec-manifest.json').write_text(json.dumps(manifest))",
            ]
        )
        return "python3 -c " + shlex.quote(script)

    def test_missing_test_output_and_setup_failure_are_not_scores(self):
        for empty_output in (True, False):
            with self.subTest(empty_output=empty_output):
                # Deliberately re-seal a broken trusted fixture to exercise execution/report checks.
                change = (
                    "spec['eval_script_list'] = [\": '>>>>> Start Test Output'\", 'echo no tests', \": '>>>>> End Test Output'\"]"
                    if empty_output
                    else "spec['eval_script_list'].insert(0, 'false')"
                )
                self.run_case(
                    self.broken_eval_setup(change),
                    expected_stage="report_parsing" if empty_output else "evaluation",
                    expected_error="Official parser did not find"
                    if empty_output
                    else "Official eval command failed: 1\tfalse",
                )

    @unittest.skipUnless(
        os.environ.get("BENCHMARK_SUBMISSION_PATCH"),
        "Set BENCHMARK_SUBMISSION_PATCH to regrade a preserved submission",
    )
    def test_preserved_submission_is_scored_offline(self):
        self.run_case(
            ":",
            int(os.environ["BENCHMARK_EXPECTED_REWARD"]),
            patch=Path(os.environ["BENCHMARK_SUBMISSION_PATCH"]),
        )

    def test_missing_offline_build_dependencies_are_not_a_score(self):
        # Require a real pip resolution from an empty source, independent of what
        # the selected image already installed. Only the trusted test spec changes.
        change = "\n".join(
            [
                "import shlex",
                "declarations = json.loads((root / 'build-dependencies.json').read_text())",
                "python = declarations[0]['python']",
                "(root / 'empty-wheels').mkdir()",
                "command = shlex.join([python, '-m', 'pip', 'install', '--ignore-installed', '--no-deps', '--no-index', '--no-cache-dir', '--find-links', str(root / 'empty-wheels'), 'packaging'])",
                "spec['eval_script_list'].insert(0, command)",
            ]
        )
        self.run_case(
            self.broken_eval_setup(change),
            expected_error="Official eval command failed",
            expected_stage="evaluation",
        )
