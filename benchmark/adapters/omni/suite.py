"""Omni packaging and provider requirements for the generic preparation lifecycle."""

import hashlib
import json
import os
from pathlib import Path

from benchmark.adapters.omni.prepare import create_source_archive, prepare


class SuiteAdapter:
    def __init__(self, options, profile_dir, execution):
        if set(options) != {"source"}:
            raise ValueError("Omni preparation requires source")
        self.source = (profile_dir / options["source"]).resolve()
        agents = execution.get("agents", [])
        if (
            len(agents) != 1
            or agents[0].get("import_path") != "benchmark.adapters.omni.agent:OmniAgent"
        ):
            raise ValueError(
                "Omni preparation requires exactly one Omni Agent declaration"
            )
        self.kwargs = agents[0].setdefault("kwargs", {})

    def snapshot(self, work):
        credential = self.kwargs.get("credential_env", "ARK_AGENT_PLAN_API_KEY")
        if not os.environ.get(credential):
            raise ValueError(
                "Required credential environment variable is missing: " + credential
            )
        identity = {}
        for key, name in (
            ("config_file", "omni.config.json"),
            ("providers_file", "omni.providers.json"),
        ):
            source = Path(self.kwargs.get(key, self.source / name))
            if not source.is_absolute():
                source = self.source / source
            data = source.read_bytes()
            target = work / name
            target.write_bytes(data)
            self.kwargs[key] = str(target)
            json.loads(data)
            identity[key] = hashlib.sha256(data).hexdigest()
        # Model selection (including Agent overrides) is validated by App's
        # ConfigService/ModelService at startup, before any model request.
        archive = work / "omni-source.tar"
        identity["source_sha256"] = create_source_archive(self.source, archive)
        return {
            "identity": identity,
            "archive": str(archive),
            "requirements": {},
        }

    def prepare(self, task, output, snapshot):
        return prepare(task, output, self.source, source_archive=snapshot["archive"])
