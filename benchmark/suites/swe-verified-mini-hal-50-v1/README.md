# Community Verified Mini 50-task suite v1

English | [简体中文](README.zh-CN.md)

This fixed 50-task suite uses the task set loaded by the pinned HAL version below. Tasks are not replaced based on Omni results. `manifest.json` records identities, source checks, coverage, and image references. Profiles own execution configuration; jobs own individual results.

## Source verification

Verification date: 2026-09-15. The recorded source checks establish that **HAL's 50 tasks match MariusHobbhahn's published storage-optimized subset** at these revisions. Treating HAL's random set and this subset as two independent selections was inaccurate. HAL's page/README wording about randomness differs from the pinned loader and IDs; the loader and manifest are authoritative for this suite.

| Evidence                                                                                                                                                                         | Pinned revision                            | Recorded verification                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [HAL loader](https://github.com/princeton-pli/hal-harness/blob/16bb03ebc11577fb5ea6dc8bb6c968387085e6aa/hal/benchmarks/swebench.py)                                              | `16bb03ebc11577fb5ea6dc8bb6c968387085e6aa` | Filters full Verified using a fixed ID file                                                            |
| [HAL IDs](https://github.com/princeton-pli/hal-harness/blob/16bb03ebc11577fb5ea6dc8bb6c968387085e6aa/hal/benchmarks/swebench_verified_mini_task_ids.txt)                         | Same as above                              | 50 unique IDs                                                                                          |
| [Published optimized subset](https://github.com/mariushobbhahn/SWEBench-verified-mini/blob/1ce432065d9ed226017ef1ac88b5f91818383c64/data/subsets/size_optimized_sample_ids.json) | `1ce432065d9ed226017ef1ac88b5f91818383c64` | Same ID set as HAL                                                                                     |
| [Hugging Face Mini](https://huggingface.co/datasets/MariusHobbhahn/swe-bench-verified-mini/tree/b316c349947c29963fce3f4a65967c9807a4b673)                                        | `b316c349947c29963fce3f4a65967c9807a4b673` | Same ID set as HAL                                                                                     |
| [Full Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified/tree/78f471bf655a3137b2e8a75af1501690ec009ec3)                                                      | `78f471bf655a3137b2e8a75af1501690ec009ec3` | All 50 present; repo, base_commit, environment_setup_commit, version, and problem_statement match Mini |
| [Harbor tasks](https://github.com/laude-institute/harbor-datasets/tree/61366953049fd63a7dff54f67193bf39f5d1cde6/datasets/swebench-verified)                                      | `61366953049fd63a7dff54f67193bf39f5d1cde6` | All 50 present; task.toml files parse with Harbor 0.23.0                                               |

HAL's loader does not pin the Hugging Face revision. These checks establish correspondence only for the listed versions, not identical bytes for every historical leaderboard run. Matching task IDs does not establish matching models, budgets, prompts, or network policies, or reproduce HAL leaderboard scores.

## Selection method and capability limits

The author used historical runs from 16 models, clustered tasks using performance, test pass rates, and difficulty information, allocated samples across clusters, and optimized environment storage. See the [pinned method description](https://github.com/mariushobbhahn/SWEBench-verified-mini/blob/1ce432065d9ed226017ef1ac88b5f91818383c64/README.md). This suite reuses the published selection; it does not retrain clustering or introduce a new selection algorithm.

- Coverage is 25 Django and 25 Sphinx tasks, all Python. It does not represent Java, PHP, Rust, or the entire software-engineering task space.
- This is a lower-cost proxy, not a guarantee that any new Agent/model's 50-task score approximates the full 500-task score. Storage optimization trades off repository coverage.
- Upstream difficulty labels: 19 `<15 min fix`, 23 `15 min - 1 hour`, 7 `1-4 hours`, and 1 `>4 hours`. These are neither Agent runtime predictions nor new annotations.
- Do not select, replace, or exclude tasks based on Omni pass rates. Preserve first results as a baseline. Repeated Agent tuning on these tasks makes them a development/regression set; independent capability claims need an untouched evaluation set.
- Public task statements may contain reproductions and suggested fixes. The manifest does not include reference or test patches. It cannot establish that a model never saw these public tasks during training.

## Upstream environments and grading

Each task uses its corresponding Harbor Verified task and SWE-bench base image. If present, `pinned_base_image` supplies a digest; otherwise preparation resolves and freezes `upstream_image`. Preparation artifacts record the final image identities. Different tasks may need different images; 25 tasks per repository does not imply only two images.

Source checks found formatting differences: blank-only lines in Django tasks and line endings/outer whitespace in Sphinx tasks. The 50 statements match after normalizing these differences. Original statement and Harbor instruction hashes are retained separately. This normalization is a source-check procedure, not runtime rewriting of task instructions.

Use the production `pnpm run benchmark prepare` / `run` entry. Preparation accesses the network to generate official test specifications and run empty/reference-patch controls. Solver tools are offline. After sealing, the independent verifier follows the taskpack policy to access official test resources. Grading rules and reference material are not supplied to the solver Agent. See the [benchmark contract and acceptance limits](../../README.md).

## Rechecking sources

Retrieve the source files at the manifest's Git commits/Hugging Face revisions and verify SHA-256. HAL IDs, the published optimized JSON, and Mini dataset IDs should be the same 50-task set. Compare public task metadata with the parent dataset without reading reference or test patches. Identity checks do not establish current container readiness or Agent task success.
