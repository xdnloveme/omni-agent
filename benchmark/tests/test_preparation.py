"""Protect cache publication and the preparation-to-execution boundary."""

import hashlib
import json
import tempfile
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmark.preparation import prepare_selected
from benchmark.run import tracked_run, index_job


class Taskpack:
    def resolve(self, task, requirements):
        return {"id": task["id"], "requirements": requirements}

    def prepare(self, task, output, resolved):
        output.mkdir()
        (output / "task.toml").write_text("source")


class Adapter:
    def __init__(self):
        self.revision = "one"
        self.builds = 0
        self.fail = False

    def snapshot(self, work):
        return {"identity": {"revision": self.revision}, "requirements": {}}

    def prepare(self, source, output, snapshot):
        self.builds += 1
        output.mkdir()
        (output / "task.toml").write_text(self.revision)
        print("build evidence")
        if self.fail:
            raise RuntimeError("failed build")


class PreparationTest(unittest.TestCase):
    def setUp(self):
        capacity = patch(
            "benchmark.capacity.capture_capacity",
            side_effect=lambda job, config, selection, phase: {"phase": phase},
        )
        capacity.start()
        self.addCleanup(capacity.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        manifest = self.root / "manifest.json"
        manifest.write_text(json.dumps({"tasks": [{"id": "a"}]}))
        self.selection = {
            "manifest_path": str(manifest),
            "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
            "profile_path": str(self.root / "profile.json"),
            "task_root": str(self.root / "cache"),
            "task_ids": ["a"],
            "preparation": {"taskpack": {}, "adapter": {}},
        }
        self.adapter = Adapter()
        self.records = []
        self.jobs = 0
        for name in ("subprocess.run", "check_environment", "check_images"):
            patcher = patch("benchmark.preparation." + name)
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_prepare(self):
        self.jobs += 1
        job = self.root / f"job-{self.jobs}"
        job.mkdir()
        record = {}
        self.records.append(record)
        with patch(
            "benchmark.preparation.load_plugin", side_effect=[Taskpack(), self.adapter]
        ):
            return prepare_selected({}, self.selection, job, record, lambda: None)

    def test_reuses_complete_cache_and_invalidates_changed_source(self):
        first = self.run_prepare()
        self.assertEqual(self.adapter.builds, 1)
        self.assertEqual(first, self.run_prepare())
        self.assertEqual(self.adapter.builds, 1)
        self.assertTrue(self.records[-1]["preparation"]["tasks"][0]["cache_hit"])
        self.adapter.revision = "two"
        second = self.run_prepare()
        self.assertNotEqual(first, second)
        self.assertEqual(self.adapter.builds, 2)
        self.assertEqual(
            Path(first["tasks"][0]["path"]).joinpath("task.toml").read_text(), "one"
        )

    def test_failed_build_is_preserved_but_never_published(self):
        self.adapter.fail = True
        with self.assertRaisesRegex(RuntimeError, "failed build"):
            self.run_prepare()
        self.assertEqual(list((self.root / "cache").rglob("receipt.json")), [])
        self.assertTrue(
            (self.root / "job-1/preparation/a/failed-build/a/task.toml").is_file()
        )
        self.assertIn(
            "build evidence",
            (self.root / "job-1/preparation/a/prepare.log").read_text(),
        )
        self.adapter.fail = False
        self.run_prepare()
        self.assertEqual(self.adapter.builds, 2)

    def test_tampered_cache_is_rejected_instead_of_silently_reused(self):
        first = self.run_prepare()
        (Path(first["tasks"][0]["path"]) / "task.toml").write_text("tampered")
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.run_prepare()
        self.assertEqual(self.adapter.builds, 1)

    def test_missing_image_rebuilds_and_preserves_expired_cache(self):
        first = self.run_prepare()
        with patch(
            "benchmark.preparation.check_images",
            side_effect=subprocess.CalledProcessError(1, "docker"),
        ):
            self.assertEqual(first, self.run_prepare())
        self.assertEqual(self.adapter.builds, 2)
        self.assertTrue(
            (self.root / "job-2/preparation/a/expired-cache/receipt.json").exists()
        )

    def test_failed_readiness_never_publishes_cache(self):
        with patch(
            "benchmark.preparation.check_environment",
            side_effect=RuntimeError("not ready"),
        ):
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                self.run_prepare()
        self.assertFalse(list((self.root / "cache").rglob("receipt.json")))
        self.assertEqual(index_job(self.root / "job-1")["trials"], [])

    def test_failed_preparation_is_recorded_before_harbor_and_config_validation(self):
        config = self.root / "config.yaml"
        config.write_text("n_attempts: 1\n")
        with (
            patch(
                "benchmark.preparation.prepare_selected",
                side_effect=RuntimeError("no environment"),
            ),
            patch("benchmark.run.subprocess.Popen") as launch,
        ):
            with self.assertRaisesRegex(RuntimeError, "no environment"):
                tracked_run(config, self.root / "jobs", "paid", self.selection)
        launch.assert_not_called()
        record = json.loads(
            next((self.root / "jobs").glob("*/invocation.json")).read_text()
        )
        self.assertEqual(record["stage"], "preparation")
        self.assertEqual(record["state"], "failed")

    def test_prepare_only_never_starts_harbor(self):
        config = self.root / "config.yaml"
        config.write_text("n_attempts: 1\n")
        with (
            patch(
                "benchmark.preparation.prepare_selected", return_value={"n_attempts": 1}
            ),
            patch("benchmark.run.verify_log_mount"),
            patch("benchmark.run.subprocess.Popen") as launch,
        ):
            self.assertEqual(
                tracked_run(
                    config,
                    self.root / "jobs",
                    "preparation",
                    self.selection,
                    prepare_only=True,
                ),
                0,
            )
        launch.assert_not_called()
        record = json.loads(
            next((self.root / "jobs").glob("*/invocation.json")).read_text()
        )
        self.assertEqual(record["state"], "prepared")


class SourceSnapshotTest(unittest.TestCase):
    def test_archive_identity_ignores_mtime_but_tracks_content(self):
        from benchmark.adapters.omni.prepare import create_source_archive

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            source = root / "packages/example/source.ts"
            source.parent.mkdir(parents=True)
            source.write_text("first")
            first = create_source_archive(root, root / "first.tar")
            os.utime(source, (1, 1))
            self.assertEqual(first, create_source_archive(root, root / "second.tar"))
            source.write_text("other")
            self.assertNotEqual(first, create_source_archive(root, root / "third.tar"))


class FixtureTaskpack:
    """A second, test-only taskpack exercising the public preparation contract."""

    def __init__(self, options, profile_dir, manifest):
        self.source = Path(options["source"])

    def resolve(self, task, requirements):
        from benchmark.preparation import files_digest

        return {"files": files_digest(self.source)}

    def prepare(self, task, output, resolved):
        import shutil

        shutil.copytree(self.source, output)


@unittest.skipUnless(
    os.environ.get("BENCHMARK_PREPARATION_TEST_ROOT"),
    "Set BENCHMARK_PREPARATION_TEST_ROOT to a Docker-shared directory for real preparation tests",
)
class ContainerPreparationTest(unittest.TestCase):
    def test_public_command_builds_then_reuses_cache_without_model_execution(self):
        import importlib.util
        from benchmark.preparation import ROOT

        root = Path(os.environ["BENCHMARK_PREPARATION_TEST_ROOT"]).resolve()
        root.mkdir(parents=True, exist_ok=False)
        spec = importlib.util.spec_from_file_location(
            "fixture_generator", ROOT / "benchmark/tasks/execution-contract/prepare.py"
        )
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        generator.prepare(root / "source")
        (root / "manifest.json").write_text(
            json.dumps({"suite_id": "preparation-test", "tasks": [{"id": "files"}]})
        )
        profile = json.loads((ROOT / "benchmark/configs/default.json").read_text())
        profile.update(manifest="manifest.json", task_root="cache")
        profile["preparation"]["taskpack"] = {
            "entrypoint": "benchmark.tests.test_preparation:FixtureTaskpack",
            "options": {"source": str(root / "source/files")},
        }
        profile["preparation"]["adapter"]["options"]["source"] = str(ROOT)
        profile["execution"]["agents"][0]["kwargs"] = {
            "credential_env": "OMNI_SMOKE_API_KEY",
            "config_file": "benchmark/adapters/omni/fixtures/omni.config.json",
            "providers_file": "benchmark/adapters/omni/fixtures/omni.providers.json",
        }
        (root / "profile.json").write_text(json.dumps(profile))
        env = {**os.environ, "OMNI_SMOKE_API_KEY": "fixture"}
        records = []
        for attempt in range(2):
            with (root / f"prepare-{attempt}.log").open("w") as log:
                result = subprocess.run(
                    [
                        "pnpm",
                        "run",
                        "benchmark",
                        "prepare",
                        "--all",
                        "--profile",
                        str(root / "profile.json"),
                        "--jobs-dir",
                        str(root / "jobs"),
                    ],
                    cwd=ROOT,
                    env=env,
                    stdout=log,
                    stderr=log,
                    timeout=900,
                )
            self.assertEqual(result.returncode, 0, str(root / f"prepare-{attempt}.log"))
            jobs = sorted((root / "jobs").iterdir())
            job = jobs[-1]
            record = json.loads((job / "invocation.json").read_text())
            self.assertEqual(record["state"], "prepared")
            self.assertEqual(
                record["preparation"]["tasks"][0]["cache_hit"], bool(attempt)
            )
            self.assertEqual(
                json.loads((job / "analysis-index.json").read_text())["trials"], []
            )
            self.assertFalse((job / "launcher.log").exists())
            readiness = (
                job
                / "preparation/files/readiness/artifacts/benchmark-audit/environment.json"
            )
            self.assertEqual(json.loads(readiness.read_text())["status"], "verified")
            records.append(record)
        self.assertEqual(
            records[0]["preparation"]["tasks"][0]["key"],
            records[1]["preparation"]["tasks"][0]["key"],
        )
