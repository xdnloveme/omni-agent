use crate::{invocation::Invocation, SandboxError};

pub(crate) fn apply_policy(_invocation: &Invocation) -> Result<(), SandboxError> {
    Err(unsupported())
}

pub(crate) fn exec_target(_invocation: &Invocation) -> Result<(), SandboxError> {
    Err(unsupported())
}

fn unsupported() -> SandboxError {
    SandboxError::new(
        "sandbox_unsupported_platform",
        "the formal sandbox currently supports macOS only",
    )
}
