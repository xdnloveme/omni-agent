"""Protect cache publication and the preparation-to-execution boundary."""

import hashlib
import json
import tempfile
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

from benchmark.preparation import prepare_selected
from benchmark.run import tracked_run, index_job


class OmniAuthenticationBoundaryTest(unittest.IsolatedAsyncioTestCase):
    def test_snapshot_does_not_require_credentials(self):
        from benchmark.adapters.omni.suite import SuiteAdapter

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("omni.config.json", "omni.providers.json"):
                (root / name).write_text("{}")
            work = root / "snapshot"
            work.mkdir()
            execution = {
                "agents": [{"import_path": "benchmark.adapters.omni.agent:OmniAgent"}]
            }
            with (
                patch.dict(os.environ, {}, clear=True),
                patch(
                    "benchmark.adapters.omni.suite.create_source_archive",
                    return_value="source-hash",
                ),
            ):
                snapshot = SuiteAdapter(
                    {"source": str(root)}, root, execution
                ).snapshot(work)
            self.assertEqual(snapshot["identity"]["source_sha256"], "source-hash")
            self.assertEqual((work / "omni.config.json").read_text(), "{}")
            self.assertNotIn("credential_env", execution["agents"][0]["kwargs"])

    def test_model_configuration_is_frozen_without_invalidating_build_identity(self):
        from benchmark.adapters.omni.suite import SuiteAdapter

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            identities = []
            hashes = []
            for index in range(2):
                for name in ("omni.config.json", "omni.providers.json"):
                    (root / name).write_text(json.dumps({"revision": index}))
                work = root / str(index)
                work.mkdir()
                execution = {
                    "agents": [{"import_path": "benchmark.adapters.omni.agent:OmniAgent"}]
                }
                with patch(
                    "benchmark.adapters.omni.suite.create_source_archive",
                    return_value="same-source",
                ):
                    snapshot = SuiteAdapter(
                        {"source": str(root)}, root, execution
                    ).snapshot(work)
                identities.append(snapshot["identity"])
                hashes.append(json.loads((work / "omni-config-snapshot.json").read_text()))
                for option in ("config_file", "providers_file"):
                    frozen = Path(execution["agents"][0]["kwargs"][option])
                    self.assertEqual(json.loads(frozen.read_text()), {"revision": index})
                    self.assertEqual(hashes[-1][option], hashlib.sha256(frozen.read_bytes()).hexdigest())
            self.assertEqual(identities[0], identities[1])
            self.assertNotEqual(hashes[0], hashes[1])
            self.assertEqual(json.loads((root / "0/omni.config.json").read_text()), {"revision": 0})

    def test_run_rejects_missing_credentials_before_preparation_and_records_failure(self):
        from benchmark.run import check_config

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.json"
            for kwargs in ({}, {"credential_env": "TEST_MODEL_KEY"}):
                config.write_text(json.dumps({
                    "agents": [{
                        "import_path": "benchmark.adapters.omni.agent:OmniAgent",
                        "kwargs": kwargs,
                    }]
                }))
                with patch.dict(os.environ, {}, clear=True):
                    if kwargs:
                        check_config(config, validate_tasks=False)
                    else:
                        with self.assertRaisesRegex(ValueError, "credential_env"):
                            check_config(config, validate_tasks=False)
                    with (
                        patch("benchmark.capacity.capture_capacity") as capacity,
                        patch("benchmark.preparation.prepare_selected") as prepare,
                        patch("benchmark.run.subprocess.Popen") as launch,
                    ):
                        with self.assertRaises(ValueError):
                            tracked_run(config, root / "jobs", "paid")
                    capacity.assert_not_called()
                    prepare.assert_not_called()
                    launch.assert_not_called()
            records = list((root / "jobs").glob("*/invocation.json"))
            self.assertEqual(len(records), 2)
            for path in records:
                record = json.loads(path.read_text())
                self.assertEqual(record["stage"], "configuration")
                self.assertEqual(record["state"], "failed")

    async def test_execution_requires_explicit_credentials_before_environment_io(self):
        from benchmark.adapters.omni.agent import OmniAgent, OmniOptions
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            OmniOptions.model_validate({})
        agent = object.__new__(OmniAgent)
        agent.options = OmniOptions(credential_env="TEST_MODEL_KEY")
        environment = AsyncMock()
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "TEST_MODEL_KEY"):
                await agent.install(environment)
            with self.assertRaisesRegex(ValueError, "TEST_MODEL_KEY"):
                await agent.run("task", environment, None)
        self.assertEqual(environment.mock_calls, [])
        # Unrelated credentials never act as fallback, and values are not retained.
        with patch.dict(os.environ, {"OTHER_MODEL_KEY": "unrelated"}, clear=True):
            with self.assertRaises(ValueError):
                agent._credential(agent.options)
            os.environ["TEST_MODEL_KEY"] = "selected"
            self.assertEqual(agent._credential(agent.options), "selected")
            del os.environ["TEST_MODEL_KEY"]
            with self.assertRaises(ValueError):
                agent._credential(agent.options)


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


class ReadinessPhasesTest(unittest.TestCase):
    def test_both_phases_use_harbor_resource_settings_and_cleanup_before_failure(self):
        from harbor.models.task.config import TaskConfig
        from benchmark.preparation import check_environment
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task = TaskConfig.model_validate({
                "environment": {"cpus": 1, "healthcheck": {"command": "true"}, "network_mode": "no-network"},
                "verifier": {"environment_mode": "separate", "environment": {"cpus": 4, "network_mode": "public"}},
            })
            events = []
            def factory(**kwargs):
                cpus = kwargs["task_env_config"].cpus
                async def start(**unused):
                    events.append(("start", cpus))
                    if cpus > 2:
                        raise RuntimeError("only 2 CPUs available")
                async def stop(**unused):
                    events.append(("stop", cpus))
                from types import SimpleNamespace
                return SimpleNamespace(start=start, stop=stop, run_healthcheck=AsyncMock())
            with (
                patch("benchmark.preparation.check_images", return_value=task),
                patch("harbor.environments.factory.EnvironmentFactory.create_environment_from_config", side_effect=factory) as create,
                patch("harbor.trial.artifact_handler.ArtifactHandler.download_artifacts", new_callable=AsyncMock),
            ):
                with self.assertRaisesRegex(RuntimeError, "only 2 CPUs"):
                    check_environment(root, root / "readiness", {"environment": {"type": "docker"}})
            self.assertEqual(events, [("start", 1), ("stop", 1), ("start", 4), ("stop", 4)])
            self.assertEqual(create.call_args_list[1].kwargs["environment_dir"], root / "tests")
            self.assertEqual(create.call_args_list[1].kwargs["network_policy"].network_mode, "public")
            self.assertEqual(task.verifier.environment.cpus, 4)


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
            "config_file": "benchmark/adapters/omni/fixtures/omni.config.json",
            "providers_file": "benchmark/adapters/omni/fixtures/omni.providers.json",
        }
        (root / "profile.json").write_text(json.dumps(profile))
        env = dict(os.environ)
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
