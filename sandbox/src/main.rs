mod invocation;
mod platform;

use std::env;
use std::process;

use invocation::{diagnostic_token, Invocation, PROTOCOL_VERSION};

fn main() {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    let token = diagnostic_token(&arguments);
    if let Err(error) = run(arguments) {
        if let Some(token) = token {
            eprintln!("omni-sandbox:{}:{}: {}", token, error.code, error.message);
        } else {
            eprintln!("omni-sandbox:{}: {}", error.code, error.message);
        }
        process::exit(error.exit_code);
    }
}

fn run(arguments: Vec<std::ffi::OsString>) -> Result<(), SandboxError> {
    if arguments.len() == 1 && arguments[0] == "--version" {
        println!(
            "omni-sandbox protocol={} version={}",
            PROTOCOL_VERSION,
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    let invocation = Invocation::parse(arguments)?;
    env::set_var("TMPDIR", &invocation.private_temp);
    platform::apply_policy(&invocation)?;
    platform::exec_target(&invocation)
}

#[derive(Debug)]
pub(crate) struct SandboxError {
    code: &'static str,
    message: String,
    exit_code: i32,
}

impl SandboxError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            exit_code: 125,
        }
    }
}
