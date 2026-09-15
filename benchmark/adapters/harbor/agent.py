"""Harbor process adapter. Omni owns Agent execution; Harbor owns evaluation."""

import time
import hashlib
import json
import os
import shutil
import shlex
import subprocess
import tarfile
import tempfile
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.trial.errors import AgentTimeoutError
from pydantic import Field

ROOT = Path(__file__).resolve().parents[3]
REMOTE_OUTPUT = "/home/omni-benchmark/output"


def prepare_instruction(instruction: str, output_dir: Path) -> str:
    """Own the evaluation input protocol; retain the original text verbatim."""
    rules = (ROOT / "benchmark/prompts/evaluation-rules.md").read_text()
    if not rules.strip() or not instruction.strip():
        raise ValueError("Evaluation rules and task instruction must not be empty")
    combined = rules + "\n--- BEGIN ORIGINAL TASK ---\n" + instruction
    texts = {"rules": rules, "original": instruction, "submitted": combined}
    for name, value in texts.items():
        (output_dir / f"instruction-{name}.txt").write_text(value)
    (output_dir / "instruction-manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "protocol": "evaluation-rules-v1",
                "sha256": {
                    name: hashlib.sha256(value.encode()).hexdigest()
                    for name, value in texts.items()
                },
            },
            indent=2,
        )
        + "\n"
    )
    return combined


class OmniOptions(InstalledAgentOptions):
    source_dir: Path = ROOT
    config_file: Path = ROOT / "omni.config.json"
    providers_file: Path = ROOT / "omni.providers.json"
    credential_env: str = Field(pattern=r"^[A-Z][A-Z0-9_]*$")
    # The job's outer timeout must leave time for signal handling and artifact collection.
    process_timeout_sec: int = Field(default=590, ge=1, le=1800)


class OmniAgent(BaseInstalledAgent):
    options_model = OmniOptions
    options: OmniOptions

    @staticmethod
    def name() -> str:
        return "omni"

    def get_version_command(self) -> str | None:
        return None

    async def install(self, environment: BaseEnvironment) -> None:
        root = self.options.source_dir.resolve()
        with tempfile.TemporaryDirectory(prefix="omni-source-") as directory:
            archive = Path(directory) / "source.tar"
            # Git supplies the source inventory, including the implementation under review.
            # Explicit roots exclude personal config, secrets, task data and benchmark outputs.
            names = (
                subprocess.check_output(
                    [
                        "git",
                        "ls-files",
                        "-z",
                        "--cached",
                        "--others",
                        "--exclude-standard",
                        "--",
                        "apps/omni",
                        "packages",
                        "agents",
                        "package.json",
                        "pnpm-lock.yaml",
                        "pnpm-workspace.yaml",
                        "tsconfig.base.json",
                    ],
                    cwd=root,
                )
                .decode()
                .split("\0")
            )
            with tarfile.open(archive, "w") as bundle:
                for name in sorted(set(filter(None, names))):
                    path = Path(name)
                    if any(
                        part in {"node_modules", "dist"} or part.startswith(".env")
                        for part in path.parts
                    ):
                        continue
                    if (root / path).is_file():
                        bundle.add(root / path, arcname=name, recursive=False)
            shutil.copyfile(archive, self.logs_dir / "setup" / "source.tar")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            commit = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=root, text=True
            ).strip()
            self._version = f"{commit[:12]}+source.{digest[:12]}"
            (self.logs_dir / "setup" / "source.json").write_text(
                json.dumps(
                    {
                        "commit": commit,
                        "archive_sha256": digest,
                        "node": "22.19.0",
                        "pnpm": "11.5.1",
                        "harbor": "0.23.0",
                        "agent_user": "omni-benchmark",
                    },
                    indent=2,
                )
                + "\n"
            )
            await environment.upload_file(archive, "/installed-agent/omni-source.tar")
        await environment.upload_file(
            Path(__file__).with_name("install.sh"), "/installed-agent/install.sh"
        )
        await self.exec_as_root(
            environment,
            "bash /installed-agent/install.sh > /logs/agent/setup/install.log 2>&1",
        )
        await environment.upload_file(
            self.options.config_file.resolve(), "/installed-agent/omni.config.json"
        )
        await environment.upload_file(
            self.options.providers_file.resolve(),
            "/installed-agent/omni.providers.json",
        )
        baseline = await self._exec(
            environment, "git -c safe.directory=/testbed -C /testbed rev-parse HEAD"
        )
        self._baseline = baseline.stdout.strip()
        if not self._baseline or any(
            c not in "0123456789abcdef" for c in self._baseline
        ):
            raise ValueError("Invalid task baseline commit")
        await environment.upload_file(
            Path(__file__).with_name("collect-submission.sh"),
            "/installed-agent/collect-submission.sh",
        )
        # Prove the execution and scoring boundary before sending any model request.
        await self._exec(
            environment,
            "id; stat -c '%U %G %a %n' /testbed /tests /logs/verifier /opt/omni; "
            "test -w /testbed && test ! -w /tests && test ! -w /logs/verifier && test ! -w /opt/omni && test ! -r /solution/solve.sh",
            user="omni-benchmark",
        )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        key = os.environ.get(self.options.credential_env)
        if not key:
            raise ValueError(
                f"Missing credential environment variable: {self.options.credential_env}"
            )
        with tempfile.TemporaryDirectory(prefix="omni-instruction-") as directory:
            path = Path(directory) / "instruction.txt"
            path.write_text(prepare_instruction(instruction, self.logs_dir))
            await environment.upload_file(path, "/installed-agent/instruction.txt")
        invocation = shlex.join(
            [
                "timeout",
                "--verbose",
                "--signal=TERM",
                "--kill-after=5s",
                f"{self.options.process_timeout_sec}s",
                "/opt/omni-node/bin/node",
                "--import",
                "/opt/omni/node_modules/tsx/dist/loader.mjs",
                "/opt/omni/apps/omni/src/headless-entry.ts",
                "--cwd",
                "/testbed",
                "--input-file",
                "/installed-agent/instruction.txt",
                "--config-file",
                "/installed-agent/omni.config.json",
                "--providers-file",
                "/installed-agent/omni.providers.json",
                "--output-dir",
                REMOTE_OUTPUT,
                "--confirm-unrestricted",
            ]
        )
        command = (
            "setpriv --no-new-privs dbus-run-session -- bash -c "
            + shlex.quote(
                'printf "" | gnome-keyring-daemon --unlock --components=secrets >/dev/null && exec '
                + invocation
            )
            + f" > {REMOTE_OUTPUT}/events.jsonl 2> {REMOTE_OUTPUT}/stderr.log"
        )
        process_started = time.monotonic()
        try:
            result = await environment.exec(
                command,
                user="omni-benchmark",
                cwd="/testbed",
                env={"HOME": "/home/omni-benchmark", self.options.credential_env: key},
            )
            (self.logs_dir / "process-exit.json").write_text(
                json.dumps(
                    {
                        "return_code": result.return_code,
                        "elapsed_sec": time.monotonic() - process_started,
                        "process_timeout_sec": self.options.process_timeout_sec,
                    },
                    indent=2,
                )
                + "\n"
            )
            if result.return_code == 124:
                raise AgentTimeoutError("Omni reached its configured process deadline")
            if result.return_code != 0:
                raise self._classify_exec_error(command, result)
        finally:
            await self._collect_artifacts(environment)

    async def _collect_artifacts(self, environment: BaseEnvironment) -> None:
        # Do not download mutable evidence until all solving-user processes are stopped.
        await self.exec_as_root(environment, "pkill -KILL -u 10001 || test $? -eq 1")
        collection_error = None
        try:
            await self.exec_as_root(
                environment, "mkdir -p /submission && chown 10001:10001 /submission"
            )
            # Git filters are untrusted code: collect with the solving UID.
            await self._exec(
                environment,
                "bash /installed-agent/collect-submission.sh "
                f"/testbed {self._baseline} /submission/changes.patch",
                user="omni-benchmark",
            )
        except Exception as error:
            collection_error = error
        finally:
            await self.exec_as_root(
                environment, "pkill -KILL -u 10001 || test $? -eq 1"
            )
        if collection_error is None:
            try:
                await self.exec_as_root(
                    environment,
                    f"cp --remove-destination /submission/changes.patch {REMOTE_OUTPUT}/changes.patch",
                )
            except Exception as error:
                collection_error = error
        try:
            await environment.download_dir(REMOTE_OUTPUT, self.logs_dir / "omni")
        except Exception as download_error:
            if collection_error is not None:
                raise ExceptionGroup(
                    "Submission collection and diagnostic download failed",
                    [collection_error, download_error],
                )
            raise
        if collection_error is not None:
            raise collection_error

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "omni" / "result.json"
        if not path.is_file():
            context.metadata = {"omni_result": "missing", "cost_status": "unknown"}
            return
        result = json.loads(path.read_text())
        context.metadata = {"omni": result, "cost_status": "unknown"}
        # Preserve native usage without inventing a token/cost mapping before its contract is verified.
