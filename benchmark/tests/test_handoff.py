import json
import tempfile
import unittest
from unittest.mock import patch
import uuid
from pathlib import Path

from benchmark.environments.handoff import file_info, validate_submission, quiesce


class HandoffContractTest(unittest.TestCase):
    def test_receipt_and_artifact_must_agree_before_grading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "result.txt").write_text("answer")
            with self.assertRaises(FileNotFoundError):
                validate_submission(root, ["result.txt"])
            receipt = {
                "version": 1,
                "collection_id": str(uuid.uuid4()),
                "collector_id": "fixture",
                "artifacts": [file_info(root, "result.txt")],
            }
            (root / "handoff.json").write_text(json.dumps(receipt))
            self.assertEqual(validate_submission(root, ["result.txt"]), receipt)
            with self.assertRaises(ValueError):
                validate_submission(root, ["other.txt"])
            (root / "result.txt").write_text("changed")
            with self.assertRaises(ValueError):
                validate_submission(root, ["result.txt"])

    def test_cleanup_does_not_repeat_term_during_the_grace_window(self):
        with (
            patch(
                "benchmark.environments.handoff.solver_processes",
                side_effect=[[42], [42], []],
            ),
            patch("benchmark.environments.handoff.os.kill") as kill,
            patch("benchmark.environments.handoff.time.sleep"),
        ):
            quiesce(10001)
        kill.assert_called_once()

    def test_symlinks_and_outside_paths_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "link").symlink_to("/etc/passwd")
            for name in ["link", "../outside", "/etc/passwd"]:
                with self.assertRaises(ValueError):
                    file_info(root, name)
