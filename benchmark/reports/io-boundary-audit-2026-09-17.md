# Tool input/output boundary audit — 2026-09-17

Scope: ToolCallCoordinator input validation and authorization ordering; ToolInvocationRunner middleware, output retention, Session readback, and model message projection. This is not an exhaustive audit of all UI inputs, transports or tool implementations. No production code changed and no paid model requests were made.

## Confirmed findings

### P1: Final sanitization depends on optional output storage

ToolInvocationRunner sanitizes the raw tool result before afterExecute. Middleware may then introduce content. The subsequent sanitizer lives in retainToolOutput and executes only when an OutputCallContext exists. Without an output reader/store, the result returns early. A synthetic registered sensitive value added by middleware reaches the backend model message with storage disabled; the same case is redacted with storage enabled. This proves a conditional disclosure path, not an observed production secret leak.

Owner: the execution result boundary must enforce final sanitization independently of retention availability. Retention must not be the only owner of that security invariant. Preserve pre-middleware sanitization as well; do not add tool-specific filters.

### P2: Result-wide page exemption includes independent attachments

An actual output_read result was modified through ToolInvocationRunner.afterExecute to add independent text and JSON. With a 100-byte raw preview budget, the result returned 110170 text bytes plus 10017 JSON bytes; the saved record still had only its original part. No retention failure was reported. meta.outputSource.kind=page exempts the entire result, so added independent content never enters ordinary retention. The original page's separate pagination limit is intentional; the independent attachment exemption is the defect.

Owner: Core content provenance/presentation boundary. Page classification must identify the content it applies to; do not cap all pages, duplicate the page body, or add a switch on tool names. Page read references and newly retained attachment references must remain distinct and valid.

## Architectural assessment

The writer/part-handle identity split remains sound; these findings concern earlier middleware and page-projection boundaries. Passing identity/lifecycle tests does not prove all input/output combinations correct. Input schema validation precedes domain preflight and access preparation; prepared calls are bound to execution context and consumed once. No new input-side defect was established in this audit.

The probe uses only synthetic data and real runner/storage/model-message projection. Evidence: benchmark/artifacts/io-boundary-audit-2026-09-17/ (gitignored).

Verification: 70 existing tests passed across 5 files (42 coordinator/output tests and 28 input/access tests). Two additional synthetic boundary probes reproduced the findings above; passing existing tests does not cover these missing combinations.

## Resolution and verification

Both confirmed findings are repaired. The runner's shared finalizeResult applies the existing sanitizer before retention and after navigation is generated, independently of optional storage. Raw results remain sanitized before middleware. Success/error results use the same finalization entry; retention no longer owns sanitization.

Page classification now travels on text blocks through the existing outputSource contract and is stripped before transcript/model projection. The result-wide exemption is removed. Existing read provenance is held in outputRead; output describes only newly retained output. A failed attachment save preserves a previously validated read source, while reporting retention failure without claiming every existing saved source is unavailable.

The original synthetic probes now show no sensitive marker in model messages with storage either enabled or disabled. The page-plus-attachment case returns 587 bytes of page/preview/navigation instead of 110170 text bytes; inline structured JSON drops from 10017 to zero bytes and is retained in its own part. Both added bodies are saved and the original read reference survives. This is not a universal 100-byte total ceiling: the budget applies to independent body previews, excluding bounded pages and navigation. The after-probe handles undefined structuredContent because successful offloading intentionally removes the inline value.

990 tests across 138 files passed; typecheck, format check, full build and git diff whitespace check passed. Eight new boundary cases cover optional retention, middleware insertion/reordering/cloning/replacement/removal, independent text/JSON readback and attachment storage failure. No production tool-name dispatch, new storage service, parallel retention route, or compatibility branch was introduced. The existing input/access/cancellation/store lifecycle remains in place. No paid model, Docker rerun or CLI startup test was performed (composition unchanged). No further blocker was confirmed in the modified boundary; this is not exhaustive coverage of multimodal or every transport input.

Architecture and flow diagram: docs/tool-call-runtime.md, Input/output ownership flow. Evidence remains gitignored under benchmark/artifacts/io-boundary-audit-2026-09-17/.

## Follow-up: preserve pages when attachment persistence fails

A subsequent exact-text comparison exposed a fallback omission: when an independent attachment failed to save, the existing page and status were also reduced by the raw-body budget. The read ID and pagination remained correct, but the 1691-byte page text was no longer identical.

The retention owner now carries its already validated page classification into the existing fallback budget allocator. It does not reparse declarations in the catch block, create a second fallback implementation, or exempt captured previews. Invalid saved-read provenance fails before any page exemption is admitted. Regression assertions compare original page/status text, pagination and source IDs; cover failure during both creation and finish; and require the independent attachment to remain bounded with no invalid saved reference.

The same real-runner probe now preserves the complete 1691-byte page, status, pagination and source in plain-read, successful-attachment and failed-attachment cases. Plain reads create no new record; successful attachments create only their own part. No production tool, storage API or model prompt changed in this follow-up.

Follow-up verification: all 992 tests across 138 files passed, including 10 focused output-boundary cases. Typecheck, format check and diff whitespace check passed. No build rerun was needed because exports/dependencies/contracts were unchanged; no paid or Docker run was performed. Probe and logs are archived alongside the earlier gitignored evidence.

## Subsequent flow review: canonical record versus redaction

Confirmed P2: a valid part whose descriptive label equals a configured sensitive value receives a redacted label in the returned OutputRecord. SessionOutputPort.validate compares the complete record with persisted metadata and rejects that returned record. A following real output_read still obtains the safe body, but the runner redacts the returned read record before retention validates it, producing outputPersistence=failed and removing outputRead even though storage is healthy. Probe: sourceResultFailure=null; projectedLabel=[REDACTED]; validation=Output reference does not match this Session; readFailure=failed; readIsError=false; safe body remains visible.

This is a general contract inconsistency between ToolInvocationRunner.finalizeResult (whole-result sanitization) and SessionArtifactStore.validate (canonical metadata equality). It is not a body corruption or observed secret disclosure. Current built-in labels are fixed stdout/stderr/content-N/structured; the probe exercises a valid dynamic-label consumer of the generic capability. No production trace establishes that this condition has occurred. Both normal source output and readback use the shared sanitization boundary, so special-casing output_read would be incorrect.

The follow-up must reconcile canonical storage facts and presentation metadata at their ownership boundary, preserving sanitization and source integrity rather than disabling either or retrying. No production code was changed during this review. The free synthetic probe is archived beside the earlier evidence.

## Resolution: storage-owned reference resolution

The canonical-record/redaction conflict is repaired by removing SessionOutputPort.validate(record). SessionOutputPort.resolve accepts only logical outputId/optional partId and reloads canonical storage facts. Storage readback and reference resolution share one private resolver under the existing metadata lock. It rejects writing records, wrong parts, foreign Session references and body-integrity failures, and propagates AbortSignal. No whole-record equality or compatibility validation entry remains.

Read-source metadata now carries only outputId/partId. Output snapshots remain display data and can be redacted; when retention needs to verify a snapshot it resolves its ID instead of trusting the caller's labels/bytes/state. Newly finished capture is resolved before provenance membership and tool-call ownership checks. Stored version-1 data and IDs are unchanged. Resolving a complete record verifies all retained parts; resolving a specific part verifies that part. This reuses integrity inspection rather than introducing a second algorithm; no performance improvement is claimed.

The original synthetic probe now reports a redacted display label, successful reference validation, no read retention failure, a published read reference, and safe readable body. Two new tests cover real tool-to-reader projection and storage rejection boundaries (unfinished record, wrong part, foreign Session, cancellation, changed body). Tests also confirm the stored label stays canonical while the display label is redacted. No paid or Docker run was used.

Final verification: all 994 tests in 138 files passed on the independent full rerun. The first run had one existing 5000ms long-loop timeout (993 passed); both logs are retained, and no timeout settings were changed. Typecheck, format check, full build and whitespace checks passed. CLI startup was not rerun because composition is unchanged.
