use std::os::unix::process::CommandExt;
use std::process::Command;

use crate::{invocation::Invocation, SandboxError};

mod limits;
mod policy;
mod seatbelt;

pub(crate) fn apply(invocation: &Invocation) -> Result<(), SandboxError> {
    seatbelt::apply(&policy::build(invocation)?)
}

pub(crate) fn apply_policy(invocation: &Invocation) -> Result<(), SandboxError> {
    limits::apply()?;
    apply(invocation)
}

pub(crate) fn exec_target(invocation: &Invocation) -> Result<(), SandboxError> {
    let error = Command::new(&invocation.command)
        .args(&invocation.arguments)
        .exec();
    Err(SandboxError::new(
        "sandbox_launch_failed",
        format!("unable to execute target command: {error}"),
    ))
}
