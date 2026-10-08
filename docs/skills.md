# Skills runtime

The existing Core SkillRuntime remains the single owner. Catalog metadata is bounded and eagerly
indexed; the full body is read only when selected. Precedence is built-in/plugin, user, then
workspace. A reload is fully validated before atomic replacement; failure retains the last valid
metadata snapshot. Existing skills are automatically revalidated on their next read, including
explicit slash invocation; no background watcher or manual reload is required for body edits.
Catalog additions/removals remain discovery/reload operations.

Metadata and body come from the same bounded, identity-checked file read. A SHA-256 content
version preserves the cached result across timestamp-only changes. Valid edits update the selected
skill; invalid edits produce a diagnostic and retain its last cached validated body. If that body
was never loaded, the read fails instead of combining old metadata with unvalidated text.
Invocation eligibility is checked against the resulting validated version.

Loaded content states its version and supersedes prior versions without rewriting conversation
history. This preserves unchanged history, not a guarantee of provider prompt-cache hits; changed
catalog metadata can still change the prompt prefix.

Source roots retain their canonical path and directory identity. Reads and reloads cannot silently
rebase that boundary after a source or parent symlink replacement. File-handle identity and version
checks reject changes during reading; this is not OS-level isolation from every external path race.
Full skill files are bounded to 512 KiB before allocation. Skill body and prompt contributions have independent
byte/token budgets. Referenced resources and scripts are progressively disclosed through ordinary
file/process Tools, so access, timeouts, cancellation, audit, and project instructions remain in the
Tool coordinator. No second recursive resource loader exists; therefore cycles cannot be followed
implicitly. A future internal reference resolver must add explicit depth and cycle budgets before it
is enabled.

Explicit invocation, model-eligible invocation, and model-disabled Skills remain distinct policy.
A Skill is untrusted instruction content: it cannot grant access or override higher-priority rules.
