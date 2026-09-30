"""Interpret only Omni's native Trace format; publish references through Harbor."""

import json
import re

from benchmark.environments.handoff import regular_file, file_info


def inspect_traces(trial):
    job = trial
    traces = []
    for manifest in sorted(trial.glob("agent/omni/state/traces/*/*/*/manifest.json")):
        replay = manifest.with_name("replay.jsonl")
        trace = {
            "manifest": str(manifest.relative_to(job)),
            "replay": str(replay.relative_to(job)),
            "state": "incomplete",
        }
        try:
            regular_file(trial, str(manifest.relative_to(trial)))
            regular_file(trial, str(replay.relative_to(trial)))
            metadata = json.loads(manifest.read_text())
            trace.update(
                session_id=metadata.get("sessionId"),
                run_id=metadata.get("runId"),
                status=metadata.get("status"),
            )
            count = 0
            last_kind = None
            contiguous = True
            with replay.open() as stream:
                for line in stream:
                    event = json.loads(line)
                    count += 1
                    contiguous &= event.get("seq") == count
                    last_kind = event.get("kind")
            trace.update(events=count, contiguous=contiguous, last_event=last_kind)
            capture = (metadata.get("summary") or {}).get("capture") or {}
            if capture.get("degraded"):
                trace["state"] = "degraded"
            elif (
                count
                and contiguous
                and metadata.get("completedAt") is not None
                and last_kind is not None
                and last_kind
                == {
                    "completed": "run.completed",
                    "cancelled": "run.cancelled",
                    "error": "run.failed",
                }.get(metadata.get("status"))
            ):
                trace["state"] = "complete"
        except FileNotFoundError:
            pass
        except (ValueError, AttributeError, TypeError, OSError):
            trace["state"] = "invalid"
        traces.append(trace)
    return traces


def inspect_outputs(trial):
    """Verify the closure of native Session output references after directory relocation."""
    state = trial / "agent/omni/state/workspaces"
    records = {}
    failures = []
    captures = []
    for session in state.glob("*/sessions/*/outputs/*"):
        if not session.is_dir() or session.name.startswith("."):
            continue
        for manifest in session.glob("*.json"):
            name = str(manifest.relative_to(trial))
            try:
                regular_file(trial, name)
                record = json.loads(manifest.read_text())
                if record["version"] != 1 or record["id"] != manifest.stem:
                    raise ValueError("Invalid native output identity")
                for part in record["parts"]:
                    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", part["id"]):
                        raise ValueError("Invalid output part identity")
                    body = session / (manifest.stem + "." + part["id"] + ".data")
                    actual = file_info(trial, str(body.relative_to(trial)))
                    if (
                        actual["size"] != part["bytes"]
                        or actual["sha256"] != part["sha256"]
                    ):
                        raise ValueError("Output body integrity mismatch")
                if record["state"] not in {"complete", "interrupted", "incomplete"}:
                    raise ValueError("Output was not finalized")
                records[(session.parent.parent, session.name, manifest.stem)] = record
                captures.append(
                    {
                        "manifest": name,
                        "capture_state": record["state"],
                        "reason": record.get("reason"),
                    }
                )
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
                failures.append({"path": name, "error": str(error)})
    for transcript in state.glob("*/sessions/*/*.jsonl"):
        try:
            regular_file(trial, str(transcript.relative_to(trial)))
            for line in transcript.read_text().splitlines():
                message = json.loads(line).get("message", {})
                details = message.get("details") or {}
                output = details.get("output") if isinstance(details, dict) else None
                if output is not None:
                    key = (transcript.parent, transcript.stem, output["id"])
                    stored = records.get(key)
                    if stored is None:
                        raise ValueError("Referenced output is missing or damaged")
                    if any(
                        stored.get(field) != output.get(field)
                        for field in ("version", "id", "toolCallId", "state", "reason")
                    ):
                        raise ValueError("Output reference metadata mismatch")
                    fields = (
                        "id",
                        "mediaType",
                        "bytes",
                        "observedBytes",
                        "complete",
                        "sha256",
                    )
                    if [
                        {field: part.get(field) for field in fields}
                        for part in stored["parts"]
                    ] != [
                        {field: part.get(field) for field in fields}
                        for part in output["parts"]
                    ]:
                        raise ValueError("Output reference parts mismatch")
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
            failures.append(
                {"path": str(transcript.relative_to(trial)), "error": str(error)}
            )
    return {
        "version": 1,
        "integrity": "incomplete" if failures else "complete",
        "captures": captures,
        "failures": failures,
    }


def populate_evidence(logs_dir, context):
    trial = logs_dir.parent
    path = logs_dir / "omni/result.json"
    result = None
    if path.is_file():
        try:
            result = json.loads(path.read_text())
        except (ValueError, UnicodeError):
            pass
    traces = inspect_traces(trial)
    summary = logs_dir / "trace-summary.json"
    summary.write_text(json.dumps({"version": 1, "traces": traces}, indent=2) + "\n")
    output_summary = logs_dir / "output-summary.json"
    output_summary.write_text(json.dumps(inspect_outputs(trial), indent=2) + "\n")
    items = [
        {
            "kind": kind,
            "path": str(path.relative_to(trial)),
            "media_type": media,
            "producer": "omni",
        }
        for kind, path, media in [
            ("agent_result", logs_dir / "omni/result.json", "application/json"),
            ("trace_summary", summary, "application/json"),
            ("output_summary", output_summary, "application/json"),
            ("process_exit", logs_dir / "process-exit.json", "application/json"),
            ("model_process", logs_dir / "model-process.json", "application/json"),
            ("input", logs_dir / "instruction-manifest.json", "application/json"),
            ("shutdown", logs_dir / "omni/stderr.log", "text/plain"),
        ]
    ]
    for trace in traces:
        for key, media in [
            ("manifest", "application/json"),
            ("replay", "application/x-ndjson"),
        ]:
            items.append(
                {
                    "kind": "trace_" + key,
                    "path": trace[key],
                    "media_type": media,
                    "producer": "omni",
                }
            )
    context.metadata = {
        **(context.metadata or {}),
        "omni": result,
        "cost_status": "unknown",
        "benchmark_evidence": {"version": 1, "items": items},
    }
