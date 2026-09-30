# Free Docker output-runtime validation — 2026-09-18

Verdict: all 7 scoped runtime cases passed using the current working-tree package sources. No production code changed, no model/provider calls were made, and the temporary container was removed.

| Case                              | Result | Evidence                                                                                                     |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| Long stdout with final error      | PASS   | Final marker, truncation notice and exit code 7 remain model-visible; command executed once                  |
| Large stdout plus critical stderr | PASS   | Critical stderr preserved; stdout/stderr captured in distinct generated parts                                |
| Middle content outside preview    | PASS   | Marker absent from head/tail preview, recovered through real output_read invocation without re-execution     |
| Cancellation                      | PASS   | AbortError observed; record interrupted; pre-cancel output readable; observed cleanup 17 ms, not a guarantee |
| Page plus independent text/JSON   | PASS   | Page/status/pagination and read reference unchanged; both independent bodies saved and read back             |
| Attachment persistence failure    | PASS   | Page/status/pagination and validated source unchanged; explicit retention failure, no invalid new record     |
| Session reopen                    | PASS   | A later Session lease reads the earlier reference successfully                                               |

The page cases include a synthetic sensitive label and configured redaction, with successful source resolution and no sensitive label in returned results. Persisted canonical labels remain storage facts.

Execution bridge: existing ToolInvocationRunner → ProcessExecutionRouter → Bash/host process inside Docker → SessionArtifactStore → real output_read invocation → model-message projection. The probe supplies prepared authorization plans as in the prior environment validation. This is the smallest existing source-level bridge covering the requested execution/storage/readback lifecycle without calling a paid model; it does not claim to test permission planning or full Agent task decisions.

Environment: Linux x64 (amd64 container), existing image `sha256:146d8e810defe56f1ede73cd78ed76806f41d889c38aa260531d229635506a26`, container network `none`, no mounts, no credential environment names present. No image was pulled. Current source archive SHA256: `759ac50e238c9f9eef20d9fe020c5ca9ae2c85e5577b32546d7fc85153411dc2`.

Harness Discovery selected the supported local shell runtime; Resolver selection and Preflight were accepted before execution. Run `run_92f7395d-b2b2-434d-a085-3ee5486c7ff1` completed with exit code 0, effect confirmed and cleanup completed. Logs are untruncated, stderr is empty, and no persistence/evidence gaps were reported. Shell execution has no browser/action provenance requirement; source archive, image identity, artifact digests, assertions and cleanup inspection provide the scoped evidence.

Evidence directory (gitignored): `benchmark/artifacts/output-container-2026-09-18/`, containing current probes, discovery/preflight/run receipts, source archive, preview/readback text, output records and cleanup confirmation.

Limits: no LLM, SWE scoring, full Agent loop, access-planner validation, Seatbelt rerun, crash recovery after process kill, or long-duration stress test was performed. Session reopen here is a new lease in the same process. This verifies the recent runtime changes in Docker, not benchmark success rate or long-run performance.
