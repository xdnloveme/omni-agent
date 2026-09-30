import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import yaml
from benchmark.environments.runtime import validate_runtime
from benchmark.taskpacks.swe.prepare import SOURCE_URL, SOURCE_REVISION, prepare
from harbor.models.task.id import GitTaskId
from harbor.models.task.config import TaskConfig, NetworkMode, VerifierEnvironmentMode
from harbor.models.trial.config import AgentConfig as TrialAgentConfig
from harbor.models.trial.config import EnvironmentConfig as TrialEnvironmentConfig
from harbor.trial.network_policy import resolve_trial_network_plan


class PrepareTaskContractTest(unittest.IsolatedAsyncioTestCase):
    async def test_new_task_keeps_upstream_inputs_and_uses_its_own_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / "tests").mkdir(parents=True)
            (source / "solution").mkdir()
            (source / "environment").mkdir()
            (source / "environment/Dockerfile").write_text(
                "FROM upstream/task:latest\nRUN echo upstream-setup\n"
            )
            (source / "task.toml").write_text("")
            (source / "instruction.md").write_bytes(b"Task\r\nunchanged\n")
            (source / "tests/test.sh").write_bytes(b"#!/bin/bash\necho official\n")
            (source / "tests/config.json").write_text(
                json.dumps({"base_commit": "a" * 40})
            )
            (source / "solution/solve.sh").write_text("echo solution\n")
            task_id = GitTaskId(
                git_url=SOURCE_URL,
                git_commit_id=SOURCE_REVISION,
                path=Path("datasets/swebench-verified/other__repo-1"),
            )
            image = "example/repo@sha256:" + "b" * 64
            downloaded = SimpleNamespace(
                results=[SimpleNamespace(path=source, content_hash="source-hash")]
            )
            output = root / "derived"
            with patch(
                "benchmark.taskpacks.swe.prepare.TaskClient.download_tasks",
                new=AsyncMock(return_value=downloaded),
            ) as download:
                runtime = validate_runtime(
                    {
                        "version": 2,
                        "tools": [
                            {
                                "name": "node",
                                "argv_prefix": ["/usr/bin/node"],
                                "description": "Node",
                                "probe_args": ["--version"],
                            }
                        ],
                    }
                )
                await prepare(output, task_id, image, runtime)
                download.assert_awaited_once_with([task_id])
            self.assertEqual(
                json.loads((output / "environment/runtime.json").read_text()),
                runtime,
            )
            manifest = json.loads((output / "derivation.json").read_text())
            self.assertEqual(
                manifest["derived_files_sha256"]["environment/runtime.json"],
                hashlib.sha256(
                    (output / "environment/runtime.json").read_bytes()
                ).hexdigest(),
            )
            config = TaskConfig.model_validate_toml((output / "task.toml").read_text())
            self.assertIsNone(config.environment.docker_image)
            plan = resolve_trial_network_plan(
                config,
                TrialAgentConfig(name="oracle"),
                TrialEnvironmentConfig(),
                None,
                verifier_mode=VerifierEnvironmentMode.SEPARATE,
            )
            self.assertEqual(
                plan.agent_env_baseline.network_mode, NetworkMode.NO_NETWORK
            )
            solver_compose = yaml.safe_load(
                (output / "environment/docker-compose.yaml").read_text()
            )
            verifier_compose = yaml.safe_load(
                (output / "tests/docker-compose.yaml").read_text()
            )
            self.assertEqual(solver_compose["services"]["main"]["network_mode"], "none")
            self.assertNotEqual(
                verifier_compose["services"]["main"].get("network_mode"), "none"
            )
            self.assertEqual(plan.agent_env_baseline.allowed_hosts, [])
            self.assertEqual(plan.agent_phase.allowed_hosts, [])
            self.assertEqual(plan.agent_phase.network_mode, NetworkMode.NO_NETWORK)
            self.assertEqual(
                plan.verifier_env_baseline.network_mode, NetworkMode.PUBLIC
            )
            self.assertEqual(plan.verifier_phase.network_mode, NetworkMode.PUBLIC)
            self.assertTrue(
                (output / "environment/Dockerfile")
                .read_text()
                .startswith(f"FROM {image}\nRUN echo upstream-setup\n")
            )
            self.assertIn(
                "RUN echo upstream-setup\nCOPY . /tests/",
                (output / "tests/Dockerfile").read_text(),
            )
            self.assertEqual(config.verifier.environment_mode, "separate")
            self.assertEqual(
                yaml.safe_load(
                    (output / "environment/docker-compose.yaml").read_text()
                ),
                {
                    "services": {
                        "main": {
                            "platform": "linux/amd64",
                            "init": True,
                            "network_mode": "none",
                        }
                    }
                },
            )
            self.assertEqual(
                (output / "tests/Dockerfile").read_text().splitlines()[0],
                "FROM " + image,
            )
            self.assertEqual(
                (output / "tests/upstream-test.sh").read_bytes(),
                (source / "tests/test.sh").read_bytes(),
            )
            self.assertEqual(
                (output / "instruction.md").read_bytes(),
                (source / "instruction.md").read_bytes(),
            )
            self.assertEqual(
                json.loads((output / "derivation.json").read_text())["source"]["path"],
                str(task_id.path),
            )
            with self.assertRaises(ValueError):
                runtime = validate_runtime(
                    {
                        "version": 2,
                        "tools": [
                            {
                                "name": "node",
                                "argv_prefix": ["/usr/bin/node"],
                                "description": "Node",
                                "probe_args": ["--version"],
                            }
                        ],
                    }
                )
                await prepare(output, task_id, image, runtime)
