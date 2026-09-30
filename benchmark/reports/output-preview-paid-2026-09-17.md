# Paid output-preview pilot (2026-09-17)

The configured Volcengine Agent Plan / glm-5.2 model correctly reported the diagnostic marker and exit code directly from both repaired previews. No output_read call was needed in either repaired condition. The corresponding old previews each caused two readbacks, first to the redundant content-0 part, then to stdout. This is evidence of a shorter diagnostic path in these two observations, not a benchmark success-rate result.

| Case                               | Before repair                                                          | After repair                                                              |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Failure at stdout tail             | 2 model requests, 2 reads; no final response within observation window | 1 request, 0 reads; FINAL_FAILURE_SENTINEL and exit 7 correctly reported  |
| Critical stderr after large stdout | 2 model requests, 2 reads; no final response within observation window | 1 request, 0 reads; STDERR_FAILURE_SENTINEL and exit 7 correctly reported |

Neither condition requested Bash re-execution. No reduction in repeated execution was demonstrated. All four actual output_read calls succeeded.

## Method and scope

The bridge was the existing ModelRuntime.stream and configured Provider, using real archived before/after tool-result text, identical task/system prompts and current tool schemas/descriptions. Real output_read executed against copied Session records. The arm order was before/after for stdout and after/before for stderr. Bash requests would have been recorded but not executed; none occurred. No product prompt, runtime or provider configuration was modified.

There was one observation per condition and an explicit two-model-turn observation window per arm. Baseline runs ended after their second readback, before an additional model request could generate a final response; they are censored observations, not failures. This experimental bound does not change production runtime budgets. The paid middle-content case was not included in this initial pilot; its execution/readback behavior was validated separately without a model.

Harness CLI preflight initially rejected paths outside its single-workspace trust scope; no paid request occurred then. The supported Harness SDK was configured with the authorized worktree and the exact user-specified main-repository .env file. Synthetic records and scripts were staged inside the worktree. Both SDK preflights were accepted and both runs completed with exit 0, confirmed effects and completed cleanup. Credentials were not copied into artifacts, and an exact-value credential scan passed.

## Usage and interpretation

Six HTTP requests returned 200. Reported usage: 7,736 input tokens, 14,592 cache-read tokens, 1,465 output tokens, 23,793 total tokens. Reasoning tokens are included in output, not added again. Provider cache reads occurred despite requesting cacheRetention none, so latency and monetary savings cannot be inferred cleanly. Actual monetary charge is unknown without the Provider bill; zero-valued configured cost fields are not proof that calls were free.

This is controlled feedback replay through ModelRuntime, not a full AgentRunner / SWE run. The sample supports keeping the preview repair; it does not establish statistical reliability, task-level pass-rate improvement, or model behavior on all output layouts.

## Evidence

`benchmark/artifacts/preview-paid-2026-09-17/` is gitignored and contains the probe, actual responses, readback actions, request IDs, token usage, Harness receipts and run snapshots. `summary.json` is the compact aggregate; `stdout-tail-comparison.json` and `stderr-after-stdout-comparison.json` contain visible model responses and tool results. The underlying before/after previews are real outputs from the earlier free reproduction, rather than handwritten approximations.
