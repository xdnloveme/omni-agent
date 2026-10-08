"""Omni build inputs for the generic preparation lifecycle; no model configuration."""

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

    def snapshot(self, work):
        archive = work / "omni-source.tar"
        identity = {"source_sha256": create_source_archive(self.source, archive)}
        return {
            "identity": identity,
            "archive": str(archive),
            "requirements": {},
        }

    def prepare(self, task, output, snapshot):
        return prepare(task, output, self.source, source_archive=snapshot["archive"])
