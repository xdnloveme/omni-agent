import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COLLECT = ROOT / "benchmark/adapters/harbor/collect-submission.sh"
APPLY = ROOT / "benchmark/environments/swe-verifier/apply-submission.sh"


def git(path, *args):
    return subprocess.check_output(
        ["git", "-C", str(path), *args], stderr=subprocess.PIPE
    )


class SubmissionContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        git(self.source, "init", "-q")
        git(self.source, "config", "user.name", "Fixture")
        git(self.source, "config", "user.email", "fixture@example.invalid")
        for name in ["modified.txt", "deleted.txt"]:
            (self.source / name).write_text("baseline\n")
        git(self.source, "add", ".")
        git(self.source, "commit", "-qm", "baseline")
        self.baseline = git(self.source, "rev-parse", "HEAD").decode().strip()
        self.clean = self.root / "clean"
        subprocess.run(
            ["git", "clone", "-q", "--no-local", str(self.source), str(self.clean)],
            check=True,
        )
        self.patch = self.root / "changes.patch"

    def collect(self):
        subprocess.run(
            ["bash", str(COLLECT), str(self.source), self.baseline, str(self.patch)],
            check=True,
        )

    def apply(self):
        return subprocess.run(
            ["bash", str(APPLY), str(self.clean), str(self.patch)], capture_output=True
        )

    def test_round_trip_covers_modified_deleted_and_untracked_without_mutating_index(
        self,
    ):
        (self.source / "modified.txt").write_text("fixed\n")
        (self.source / "deleted.txt").unlink()
        (self.source / ":new file.txt").write_text("new\n")
        index_before = git(self.source, "diff", "--cached")
        self.collect()
        self.assertEqual(git(self.source, "diff", "--cached"), index_before)
        result = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.clean / "modified.txt").read_text(), "fixed\n")
        self.assertFalse((self.clean / "deleted.txt").exists())
        self.assertEqual((self.clean / ":new file.txt").read_text(), "new\n")

    def test_empty_submission_preserves_baseline(self):
        self.collect()
        self.assertEqual(self.patch.read_bytes(), b"")
        self.assertEqual(self.apply().returncode, 0)
        self.assertEqual(git(self.clean, "status", "--porcelain"), b"")

    def test_new_symlink_is_rejected_before_test_execution(self):
        (self.source / "escape").symlink_to("/tmp")
        self.collect()
        result = self.apply()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"Unsupported submission file mode", result.stderr)

    def test_outside_path_and_oversize_are_rejected(self):
        self.patch.write_text(
            "diff --git a/../../outside b/../../outside\nnew file mode 100644\n--- /dev/null\n+++ b/../../outside\n@@ -0,0 +1 @@\n+bad\n"
        )
        self.assertNotEqual(self.apply().returncode, 0)
        self.assertFalse((self.root / "outside").exists())
        with self.patch.open("wb") as output:
            output.truncate(16777217)
        self.assertNotEqual(self.apply().returncode, 0)


if __name__ == "__main__":
    unittest.main()
