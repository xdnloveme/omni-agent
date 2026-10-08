"""Suite selection and configuration translation; no preparation or execution policy."""

import copy
import hashlib
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROFILE = ROOT / "benchmark/configs/default.json"


def add_selection_arguments(parser):
    parser.add_argument(
        "--config",
        type=Path,
        help="Explicit Harbor job config; excludes suite selection",
    )
    parser.add_argument(
        "--profile",
        type=Path,
        help="Suite profile (default: benchmark/configs/default.json)",
    )
    selectors = parser.add_mutually_exclusive_group()
    selectors.add_argument(
        "--all", action="store_true", help="All tasks in manifest order"
    )
    selectors.add_argument(
        "--task", action="append", help="Exact task ID; repeat for multiple tasks"
    )
    selectors.add_argument("--first", type=int, help="First N tasks in manifest order")
    selectors.add_argument(
        "--sample", type=int, help="Sample N tasks without replacement; requires --seed"
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        help="Maximum concurrent Harbor trials (positive integer)",
    )
    parser.add_argument("--seed", type=int)
    parser.add_argument(
        "--task-root",
        type=Path,
        help="Task cache root for automatic preparation, or prepared task root for manual profiles",
    )
    parser.add_argument(
        "--timeout", type=int, help="Agent execution seconds, 1–1800; excludes setup"
    )


def select_ids(ids, *, all_tasks=False, tasks=None, first=None, sample=None, seed=None):
    if not ids or len(set(ids)) != len(ids):
        raise ValueError("Manifest must contain unique task IDs")
    if sum((all_tasks, tasks is not None, first is not None, sample is not None)) != 1:
        raise ValueError("Choose exactly one of --all, --task, --first, --sample")
    if (sample is None) != (seed is None):
        raise ValueError("--sample and --seed must be supplied together")
    for count in (first, sample):
        if count is not None and not 1 <= count <= len(ids):
            raise ValueError(f"Task count must be between 1 and {len(ids)}")
    if tasks is not None:
        if len(set(tasks)) != len(tasks) or not set(tasks).issubset(ids):
            raise ValueError("--task IDs must be unique and present in the manifest")
        chosen = set(tasks)
    elif sample is not None:
        chosen = set(random.Random(seed).sample(ids, sample))
    else:
        return ids[:first] if first is not None else ids[:]
    # Selection never changes the suite's canonical execution order.
    return [task for task in ids if task in chosen]


def compile_selection(args):
    if args.config is not None:
        if args.action == "list" or any(
            (
                args.profile,
                args.all,
                args.task,
                args.first is not None,
                args.sample is not None,
                args.seed is not None,
                args.task_root,
                args.timeout is not None,
                args.concurrency is not None,
            )
        ):
            raise ValueError("--config cannot be combined with suite options or list")
        return args.config.resolve(), None
    profile_path = (args.profile or DEFAULT_PROFILE).resolve()
    profile_bytes = profile_path.read_bytes()
    profile = json.loads(profile_bytes)
    if (
        set(profile)
        not in (
            {"version", "manifest", "task_root", "execution"},
            {"version", "manifest", "task_root", "execution", "preparation"},
        )
        or profile["version"] != 1
    ):
        raise ValueError(
            "Invalid suite profile: expected version, manifest, task_root, execution"
        )

    def relative(value):
        return (profile_path.parent / value).resolve()

    manifest_path = relative(profile["manifest"])
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    ids = [task["id"] for task in manifest["tasks"]]
    if any(
        not isinstance(task, str)
        or task in {"", ".", ".."}
        or "/" in task
        or "\\" in task
        for task in ids
    ):
        raise ValueError("Task IDs must be safe directory names")
    selected = select_ids(
        ids,
        all_tasks=args.all,
        tasks=args.task,
        first=args.first,
        sample=args.sample,
        seed=args.seed,
    )
    task_root = (
        args.task_root.resolve() if args.task_root else relative(profile["task_root"])
    )
    config = copy.deepcopy(profile["execution"])
    if "tasks" in config or "datasets" in config:
        raise ValueError(
            "Profile execution cannot declare tasks or datasets; the manifest owns selection"
        )
    if args.timeout is not None:
        config.setdefault("benchmark", {})["agent_timeout_sec"] = args.timeout
    if args.concurrency is not None:
        config["n_concurrent_trials"] = args.concurrency
    config["tasks"] = [{"path": str(task_root / task)} for task in selected]
    missing = [
        task for task in selected if not (task_root / task / "task.toml").is_file()
    ]
    record = {
        "version": 1,
        "suite_id": manifest["suite_id"],
        "manifest_path": str(manifest_path),
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "profile_path": str(profile_path),
        "profile_sha256": hashlib.sha256(profile_bytes).hexdigest(),
        "selector": "all"
        if args.all
        else "task"
        if args.task
        else "first"
        if args.first is not None
        else "sample",
        "seed": args.seed,
        "task_ids": selected,
        "task_root": str(task_root),
        "missing_tasks": missing,
    }
    if "preparation" in profile:
        record["preparation"] = copy.deepcopy(profile["preparation"])
        record.pop("missing_tasks")
        record["readiness"] = "not_checked"
    if (
        missing
        and args.action != "list"
        and not (
            args.action in {"run", "prepare", "check"} and "preparation" in profile
        )
    ):
        raise ValueError(
            "Selected tasks are not prepared: "
            + ", ".join(missing)
            + ". Prepare them using the taskpack and agent adapter, then set --task-root; no tasks were run."
        )
    return config, record
