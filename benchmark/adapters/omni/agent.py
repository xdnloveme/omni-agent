"""Harbor process adapter. Omni owns Agent execution; Harbor owns evaluation."""

import json
import asyncio
import shlex
import tempfile
import time
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.trial.errors import AgentTimeoutError
from pydantic import Field

from .evidence import populate_evidence
from .instruction import prepare_instruction
from .model_channel import model_channel, SOCKET
from .configuration import capture_configuration

ROOT = Path(__file__).resolve().parents[3]
REMOTE_OUTPUT = "/home/benchmark-runner/output"


class OmniOptions(InstalledAgentOptions):
    agent_id: str = Field(default="coding", pattern=r"^[a-z][a-z0-9-]*$")
    configuration_cwd: Path = ROOT
    global_directory: Path = Field(default_factory=lambda: Path.home() / ".omni-agent")
    config_file: Path | None = None
    providers_file: Path | None = None
    cleanup_grace_sec: int = Field(default=10, ge=1)
    credential_env: str = Field(pattern=r"^[A-Z][A-Z0-9_]*$")


class OmniAgent(BaseInstalledAgent):
    options_model = OmniOptions
    options: OmniOptions

    @staticmethod
    def name() -> str:
        return "omni"

    def get_version_command(self) -> str | None:
        return None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.process_timeout_sec = int(self.extra_env["BENCHMARK_AGENT_TIMEOUT_SEC"])
        if not 1 <= self.process_timeout_sec <= 1800:
            raise ValueError("Invalid benchmark Agent budget")

    @classmethod
    def preflight(cls, kwargs=None, env=None) -> None:
        options = cls.parse_options(kwargs, env)
        with tempfile.TemporaryDirectory(prefix="omni-config-check-") as directory:
            capture_configuration(options, Path(directory) / "configuration")

    async def install(self, environment: BaseEnvironment) -> None:
        # One per-trial snapshot feeds both solver configuration and model service.
        self._configuration = self.logs_dir / "configuration"
        self._auth_environment = await asyncio.to_thread(capture_configuration, self.options, self._configuration)
        await self._exec(environment, "test -f /opt/omni/package.json && test -x /opt/omni-node/bin/node")
        await self.exec_as_root(environment, "install -d -m 755 /installed-agent/configuration")
        # Provider definitions and credentials belong only in the model service.
        for name in ("config.json", "omni.config.json"):
            source = self._configuration / name
            if source.exists():
                await environment.upload_file(source, "/installed-agent/configuration/" + name)
                await self.exec_as_root(environment, "chmod 644 /installed-agent/configuration/" + name)
        facts = await self._exec(
            environment, "cat /benchmark-audit/environment.json", user="root"
        )
        self._environment_facts = json.loads(facts.stdout)
        self._cwd = environment.task_env_config.workdir
        if not self._cwd:
            raise ValueError("Prepared task must declare environment.workdir")
        await self.exec_as_root(
            environment,
            "mkdir -p /home/benchmark-runner/output /home/benchmark-runner/.local/share/keyrings && chown -R 10001:10001 /home/benchmark-runner",
        )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="omni-instruction-") as directory:
            path = Path(directory) / "instruction.txt"
            path.write_text(
                prepare_instruction(instruction, self.logs_dir, self._environment_facts)
            )
            await environment.upload_file(path, "/installed-agent/instruction.txt")
        node_invocation = shlex.join(
            [
                "/opt/omni-node/bin/node",
                "--import",
                "/opt/omni/node_modules/tsx/dist/loader.mjs",
                "/opt/omni/apps/omni/src/headless-entry.ts",
                "--cwd",
                self._cwd,
                "--agent",
                self.options.agent_id,
                "--input-file",
                "/installed-agent/instruction.txt",
                "--configuration-dir",
                "/installed-agent/configuration",
                "--model-channel",
                SOCKET,
                "--output-dir",
                REMOTE_OUTPUT,
                "--confirm-unrestricted",
            ]
        )
        invocation = shlex.join(
            [
                "timeout",
                "--verbose",
                "--signal=TERM",
                "--kill-after=5s",
                f"{self.process_timeout_sec + self.options.cleanup_grace_sec}s",
                "bash",
                "-c",
                "set -e; echo $$ > "
                + shlex.quote(REMOTE_OUTPUT + "/agent.pid")
                + "; exec "
                + node_invocation
                + ' --deadline-at-ms "$1"',
                "omni-run",
            ]
        )
        # Compute the deadline on the same container clock used by the Agent.
        # The outer watchdog has a separate cleanup grace, not a second work budget.
        invocation += ' "$run_deadline_ms"'
        deadline_expression = shlex.quote(
            f"Date.now() + {self.process_timeout_sec * 1000}"
        )
        command = (
            "setpriv --no-new-privs bash -c "
            + shlex.quote(
                f"run_deadline_ms=$(/opt/omni-node/bin/node -p {deadline_expression}) && exec "
                + invocation
            )
            + f" > {REMOTE_OUTPUT}/events.jsonl 2> {REMOTE_OUTPUT}/stderr.log"
        )
        try:
            async with model_channel(
                environment,
                configuration=self._configuration,
                auth_environment=self._auth_environment,
                agent_id=self.options.agent_id,
                logs_dir=self.logs_dir,
            ):
                process_started = time.monotonic()
                try:
                    result = await environment.exec(
                        command,
                        user="benchmark-runner",
                        cwd=self._cwd,
                        env={"HOME": "/home/benchmark-runner"},
                    )
                except asyncio.CancelledError:
                    # Signal the Agent before closing its model channel so its
                    # native cancellation/Trace lifecycle can finish normally.
                    await self.exec_as_root(
                        environment,
                        "/usr/bin/python3 /opt/benchmark/handoff.py stop --user benchmark-runner --pid-file /home/benchmark-runner/output/agent.pid",
                    )
                    raise
                process_elapsed = time.monotonic() - process_started
            (self.logs_dir / "process-exit.json").write_text(
                json.dumps(
                    {
                        "return_code": result.return_code,
                        "elapsed_sec": process_elapsed,
                        "process_timeout_sec": self.process_timeout_sec
                        + self.options.cleanup_grace_sec,
                        "run_budget_sec": self.process_timeout_sec,
                        "cleanup_grace_sec": self.options.cleanup_grace_sec,
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
        # Native Agent logs remain diagnostic; task submission belongs to verifier.collect.
        await environment.download_dir(REMOTE_OUTPUT, self.logs_dir / "omni")

    def populate_context_post_run(self, context: AgentContext) -> None:
        populate_evidence(self.logs_dir, context)
