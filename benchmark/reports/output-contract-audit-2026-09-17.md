# Output contract follow-up audit (2026-09-17)

Read-only production-code audit plus free local reproductions. No new paid requests or production changes.

## Confirmed findings

1. **Incomplete readback loses model-visible completeness.** A record limited to 12 bytes is incomplete and its part has complete=false. output_read returns only `1|START / 2|START` in text and isError=false; the incomplete state exists only in metadata and is absent from model-message projection. A successful read is not itself an error, but its completeness must accompany the returned content. Ownership: output_read result projection using the authoritative OutputRecord, not keyword classification.
2. **Preview threshold applies to individual blocks, not the total result.** Fifty 9,000-byte text blocks produce 450,049 bytes of visible text despite previewBytes=10,240, without creating saved output. This is a missing aggregate presentation policy, not a claim that the downstream model context limit is bypassed. Ownership: Core result presentation; retain independent bodies and navigation while bounding aggregate display. Preserve explicit page and multimodal semantics.
3. **Mutable middleware can invalidate index-based provenance.** Prepending a 2,200-byte independent block before an existing mapped preview makes index 0 refer to the new block. Retention accepts the mapping, returns 2,399 visible bytes under a 100-byte preview setting, and saves only stdout; the independent attachment is not retained. The probe applies the same mutation allowed by afterExecute, rather than invoking an installed production middleware. No current benchmark trace establishes occurrence. Ownership: the middleware/result-provenance contract; avoid heuristics comparing text or assuming array order never changes.

The first two are broadly applicable presentation gaps; the third is conditional on result-mutating middleware and needs a small contract design before implementation. These findings qualify the prior assessment: passing the existing regression suite did not cover all compound-result and extension-boundary cases.

## Not yet justified as implementation work

Session storage scans existing data files for every append, and readback verifies the full retained part before reading a page. These are real I/O costs, but there is no measured bottleneck in this audit. Do not add counters, caches or indexes without profiling and preserving quota/recovery/integrity guarantees. Likewise, do not add error-keyword inference, automatic pipefail, forced verification ordering or more prompt rules.

Evidence: gitignored `benchmark/artifacts/output-contract-audit-2026-09-17/summary.json` and the replayable local probe. All three reproductions use real SessionArtifactStore / retainToolOutput; the incomplete-read case also uses output_read and the actual model-message mapper.

## Follow-up repair

Findings 1 and 2 are repaired. output_read now exposes record and part completeness in model-visible text, without treating a successful partial read as a tool failure. Independent raw text blocks share the existing Session preview budget; JSON is either kept intact within the same allowance or retained intact. Declared process previews/pages preserve their separate existing presentation contracts, and navigation metadata remains outside the body budget.

Replaying the original probe reduced the multi-block visible response from 450,049 to 15,082 bytes (10 KiB raw body allowance plus navigation references), with all bodies retained. The incomplete read now projects `incomplete: limit` to the model. Focused regression covers normal and failed persistence, many small blocks, mixed text/JSON, and incomplete/interrupted page projection.

Finding 3 was initially left open for middleware contract alignment. The subsequent repair attaches provenance to each text block and deletes the old index-based protocol. Reordering and cloning preserve association; trusted middleware must remove/redeclare provenance for independent replacements. Five real ToolInvocationRunner regressions cover prepend, reorder, clone, replace and remove, including sanitization, readback and absence of internal fields in model messages. No registry, heuristic or compatibility shim was added. No paid model call was made for this repair.

Verification: 974 tests passed across 137 files; typecheck, formatting and diff whitespace checks passed. No build or CLI smoke was run because package exports, dependencies, composition and startup were unchanged. No Docker or paid model rerun was performed for this follow-up.

Block-local provenance verification: 44 focused tests and all 979 repository tests (137 files) passed. Typecheck, format check, full build and git diff whitespace checks passed. Evidence is in gitignored `benchmark/artifacts/output-block-source-2026-09-17/`. No new paid run or container rerun was performed; this change targets the shared result/middleware boundary, exercised through the real ToolInvocationRunner and Session storage. Earlier process/environment evidence remains separate.

## Part identity ownership repair

Follow-up review reproduced a separate generality gap: caller-selected part IDs merged independent retained content into captured content when both used content-0 or structured. A 16-byte captured body became 716/727 bytes without a failure. This pre-existing creation/append ambiguity was not introduced by the block-local provenance change.

The writer now exclusively creates parts and allocates IDs. A part handle only appends; labels are descriptive and may repeat. Process capture and generic retention both use this one entry. Old append(partId, ...) is removed, with no compatibility branch or parallel lifecycle. Append no longer creates a missing body. Process results carry actual stream IDs. Version-1 files without labels remain readable without rewriting historical IDs or records.

Verification: all 982 tests across 137 files passed, including concurrent same-label creation, repeated append, empty parts, post-finish rejection, same-label capture/text/JSON isolation, historical record read, cancellation, quotas and real-process crash recovery. Typecheck, format check, full build and diff whitespace checks passed. Evidence is under gitignored benchmark/artifacts/output-part-identity-2026-09-17/. No paid model call, new Docker run or CLI smoke was performed; composition is unchanged. These tests establish storage/runtime behavior, not model task success.
