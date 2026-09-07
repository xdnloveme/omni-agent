# Project instructions

`agents/coding` owns target-scoped `AGENTS.md` discovery. For each prepared batch it considers file
targets, Bash cwd, static ShellProgram paths, and bounded declared write scopes. Existing targets use
canonical paths; missing targets use the nearest existing ancestor plus a validated lexical suffix.
Files scan through their parent, directories through themselves.

Lineages apply root to leaf. Deeper files override ancestors only within the same lineage; sibling
manifests remain separate and are labelled by `appliesTo`. A call spanning siblings receives all
applicable contributions. Infrastructure does not invent an ordering for substantive conflicts.

New or changed digests defer the batch before consent or execution. Manifests are revalidated from
identity, mtime, size, and digest again after consent, before planning and execution. A late change
stops the current and remaining ready calls; already completed calls cannot be undone. Read-only dynamic Bash uses the
active cwd lineage; mutation with an unbounded target fails with
`project_instruction_scope_undetermined`. External approved roots never inherit workspace rules and
are not scanned for their own `AGENTS.md`.

Target manifests are Run-scoped, without a cumulative activation-count limit. Prompt contribution
size limits remain enforced. Every Run starts from the
workspace-root manifest already included in the stable prompt, so sibling rules activated by a
previous Run cannot leak into the next one.

Loading is transactional: discovery and contribution-budget validation must both succeed before
the active snapshot changes. Instruction changes are appended through non-executed ToolResults,
not by rewriting the system-prompt prefix. Unchanged digests do not defer again. After a new context
checkpoint, target activation is reset so scoped rules are supplied again before the next affected
Tool executes; a summary is not an authoritative rule snapshot. Actual provider cache hits remain
provider-dependent. The external race between the final check and execution remains a documented
TOCTOU boundary.
