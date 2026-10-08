"""Invoke Omni's configuration owner; never parse Provider or model semantics here."""

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def capture_configuration(options, output):
    command = [
        "node", "--import", "tsx", str(ROOT / "apps/omni/src/configuration-entry.ts"),
        "--cwd", str(options.configuration_cwd.resolve()),
        "--global-directory", str(options.global_directory.resolve()),
        "--agent", options.agent_id,
        "--credential-env", options.credential_env,
        "--output-dir", str(output),
    ]
    for flag, path in (("config-file", options.config_file), ("providers-file", options.providers_file)):
        if path is not None:
            command.extend(["--" + flag, str(path.resolve())])
    # stdout carries only the explicitly selected authentication environment.
    # Never inherit launcher log redirection or include it in exception text.
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError(result.stderr.strip() or "Omni configuration capture failed")
    return json.loads(result.stdout)["authEnvironment"]
