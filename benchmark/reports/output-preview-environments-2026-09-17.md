# Output preview environment validation (2026-09-17)

All 9 free environment checks passed: four shared cases on macOS arm64 / Rust Seatbelt and Linux amd64 / Docker, plus a Seatbelt storage-isolation check. No model or provider requests were made. No production code was changed.

| Case                                     | Seatbelt | Docker        | Verified behavior                                                               |
| ---------------------------------------- | -------- | ------------- | ------------------------------------------------------------------------------- |
| Failure at end of stdout                 | PASS     | PASS          | Marker, exit code 7 and truncation notice visible; complete body readable       |
| Small critical stderr after large stdout | PASS     | PASS          | Error survives preview competition; stdout/stderr stored once                   |
| Important information in the middle      | PASS     | PASS          | Absent from head/tail preview as expected, recovered via output_read pagination |
| Cancellation                             | PASS     | PASS          | AbortError, interrupted output record, pre-cancellation output readable         |
| Read private output storage from process | PASS     | Not exercised | Seatbelt denies reading storage outside the authorized workspace                |

Both environments used the current Bash tool, ToolInvocationRunner, ProcessExecutionRouter, retention implementation, SessionArtifactStore, model-message projection and output_read. Normal cases asserted the execution counter remained exactly one and records contained only stdout/stderr parts. Cancellation cleanup measured 3 ms on Seatbelt and 9 ms on Docker; these are observations, not latency guarantees.

Docker used the existing `omni-retention-dependency-base:146d8e810def` image with current package sources copied in, Linux amd64 emulation, no mounted credentials and network mode `none`. The temporary container was removed. Source archive SHA256: `f1e3ab08244c773c88ded0d1f48ddb3e258364fc8ec27c34aa38662e71e185fc`.

Evidence: `benchmark/artifacts/output-preview-environments-2026-09-17/` (gitignored), containing reusable probes, summaries and model-visible preview/readback text.

Limitations: This validates execution and presentation across the two environments, not LLM decisions or benchmark success rate. Prepared execution plans were supplied by the probe; it does not revalidate access-planner decisions, provider transport, full Agent task orchestration or SWE scoring. Linux uses the standard host process route inside Docker, not Seatbelt. No paid model comparison or full SWE task was run.
