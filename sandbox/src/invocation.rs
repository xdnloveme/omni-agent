use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::SandboxError;

pub(crate) const PROTOCOL_VERSION: &str = "3";
const MAX_SCOPE_ENTRIES: usize = 256;
const MAX_ARGUMENTS: usize = 1024;
const MAX_ARGUMENT_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ScopeKind {
    Exact,
    Subtree,
}

#[derive(Clone, Debug)]
pub(crate) struct PathScope {
    pub(crate) path: PathBuf,
    pub(crate) kind: ScopeKind,
}

pub(crate) struct Invocation {
    pub(crate) workspace: PathBuf,
    pub(crate) private_temp: PathBuf,
    pub(crate) network: bool,
    pub(crate) read: Vec<PathScope>,
    pub(crate) write: Vec<PathScope>,
    pub(crate) protected_write_roots: Vec<PathBuf>,
    pub(crate) denied_read_subtrees: Vec<PathBuf>,
    pub(crate) denied_read_names: Vec<String>,
    pub(crate) denied_read_prefixes: Vec<String>,
    pub(crate) allowed_read_names: Vec<String>,
    pub(crate) approved_sensitive_reads: Vec<PathBuf>,
    pub(crate) command: OsString,
    pub(crate) arguments: Vec<OsString>,
}

impl Invocation {
    pub(crate) fn parse(args: Vec<OsString>) -> Result<Self, SandboxError> {
        if args.len() > MAX_ARGUMENTS
            || args
                .iter()
                .map(|argument| argument.to_string_lossy().len())
                .sum::<usize>()
                > MAX_ARGUMENT_BYTES
        {
            return Err(SandboxError::new(
                "sandbox_invalid_request",
                "sandbox invocation exceeds the argument budget",
            ));
        }
        let mut protocol = None;
        let mut diagnostic_token = None;
        let mut workspace = None;
        let mut private_temp = None;
        let mut network = None;
        let mut read = Vec::new();
        let mut write = Vec::new();
        let mut protected_write_roots = Vec::new();
        let mut denied_read_subtrees = Vec::new();
        let mut denied_read_names = Vec::new();
        let mut denied_read_prefixes = Vec::new();
        let mut allowed_read_names = Vec::new();
        let mut approved_sensitive_reads = Vec::new();
        let mut index = 0;
        while index < args.len() && args[index] != "--" {
            let option = args[index].clone();
            index += 1;
            let value = args.get(index).cloned().ok_or_else(usage)?;
            index += 1;
            match option.to_str() {
                Some("--protocol-version") => protocol = value.to_str().map(str::to_owned),
                Some("--diagnostic-token") => {
                    diagnostic_token = validate_diagnostic_token(value.to_str())
                }
                Some("--mode") => match value.to_str() {
                    Some("controlled" | "autonomous") => {}
                    _ => return Err(usage()),
                },
                Some("--workspace") => workspace = Some(canonical_directory(value, "workspace")?),
                Some("--private-temp") => {
                    private_temp = Some(canonical_directory(value, "private temp")?)
                }
                Some("--network") => {
                    network = Some(match value.to_str() {
                        Some("enabled") => true,
                        Some("disabled") => false,
                        _ => return Err(usage()),
                    })
                }
                Some("--read-exact") => read.push(path_scope(value, ScopeKind::Exact)?),
                Some("--read-subtree") => read.push(path_scope(value, ScopeKind::Subtree)?),
                Some("--write-exact") => write.push(path_scope(value, ScopeKind::Exact)?),
                Some("--write-subtree") => write.push(path_scope(value, ScopeKind::Subtree)?),
                Some("--protect-write-root") => {
                    protected_write_roots.push(canonical_directory(value, "protected write root")?)
                }
                Some("--deny-read-subtree") => {
                    denied_read_subtrees.push(absolute_path(value, "denied read subtree")?)
                }
                Some("--deny-read-name") => denied_read_names.push(utf8_name(value)?),
                Some("--deny-read-prefix") => denied_read_prefixes.push(utf8_name(value)?),
                Some("--allow-read-name") => allowed_read_names.push(utf8_name(value)?),
                Some("--allow-sensitive-read-exact") => {
                    approved_sensitive_reads.push(absolute_path(value, "sensitive read")?)
                }
                _ => return Err(usage()),
            }
        }
        if protocol.as_deref() != Some(PROTOCOL_VERSION) {
            return Err(SandboxError::new(
                "sandbox_protocol_mismatch",
                "unsupported sandbox protocol version",
            ));
        }
        if diagnostic_token.is_none() {
            return Err(usage());
        }
        if read.len()
            + write.len()
            + denied_read_subtrees.len()
            + denied_read_names.len()
            + denied_read_prefixes.len()
            + allowed_read_names.len()
            + approved_sensitive_reads.len()
            + protected_write_roots.len()
            > MAX_SCOPE_ENTRIES
        {
            return Err(SandboxError::new(
                "sandbox_invalid_request",
                "too many sandbox path scopes",
            ));
        }
        if args.get(index).map(OsString::as_os_str) != Some(OsStr::new("--")) {
            return Err(usage());
        }
        let command = args.get(index + 1).cloned().ok_or_else(usage)?;
        if Path::new(&command).is_relative() && command.to_string_lossy().contains('/') {
            return Err(SandboxError::new(
                "sandbox_invalid_request",
                "relative executable paths containing separators are not supported",
            ));
        }
        Ok(Self {
            workspace: workspace.ok_or_else(usage)?,
            private_temp: private_temp.ok_or_else(usage)?,
            network: network.ok_or_else(usage)?,
            read,
            write,
            protected_write_roots,
            denied_read_subtrees,
            denied_read_names,
            denied_read_prefixes,
            allowed_read_names,
            approved_sensitive_reads,
            command,
            arguments: args.into_iter().skip(index + 2).collect(),
        })
    }
}

pub(crate) fn diagnostic_token(args: &[OsString]) -> Option<String> {
    args.windows(2).find_map(|pair| {
        (pair[0] == "--diagnostic-token")
            .then(|| validate_diagnostic_token(pair[1].to_str()))
            .flatten()
    })
}

fn validate_diagnostic_token(value: Option<&str>) -> Option<String> {
    value
        .filter(|token| token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(str::to_owned)
}

fn utf8_name(value: OsString) -> Result<String, SandboxError> {
    let value = value.into_string().map_err(|_| {
        SandboxError::new(
            "sandbox_invalid_request",
            "sensitive names must be valid UTF-8",
        )
    })?;
    if value.is_empty() || value.contains('/') || value.contains('\0') {
        return Err(SandboxError::new(
            "sandbox_invalid_request",
            "sensitive names must be non-empty file-name fragments",
        ));
    }
    Ok(value)
}

fn path_scope(value: OsString, kind: ScopeKind) -> Result<PathScope, SandboxError> {
    let path = absolute_path(value, "scope")?;
    Ok(PathScope { path, kind })
}

fn absolute_path(value: OsString, label: &str) -> Result<PathBuf, SandboxError> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(SandboxError::new(
            "sandbox_invalid_request",
            format!("{label} must be absolute"),
        ));
    }
    Ok(path)
}

fn canonical_directory(value: OsString, label: &str) -> Result<PathBuf, SandboxError> {
    let path = absolute_path(value, label)?;
    let canonical = path.canonicalize().map_err(|error| {
        SandboxError::new(
            "sandbox_invalid_request",
            format!("unable to resolve {label}: {error}"),
        )
    })?;
    if !canonical.is_dir() {
        return Err(SandboxError::new(
            "sandbox_invalid_request",
            format!("{label} must be a directory"),
        ));
    }
    Ok(canonical)
}

fn usage() -> SandboxError {
    SandboxError::new("sandbox_invalid_request", "invalid omni-sandbox invocation")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_policy_paths() {
        let result = Invocation::parse(vec![
            "--protocol-version".into(),
            "3".into(),
            "--diagnostic-token".into(),
            "0123456789abcdef0123456789abcdef".into(),
            "--mode".into(),
            "controlled".into(),
            "--workspace".into(),
            "/".into(),
            "--private-temp".into(),
            "/tmp".into(),
            "--network".into(),
            "disabled".into(),
            "--read-exact".into(),
            "relative".into(),
            "--".into(),
            "true".into(),
        ]);
        let error = match result {
            Ok(_) => panic!("relative policy path must fail"),
            Err(error) => error,
        };
        assert_eq!(error.code, "sandbox_invalid_request");
    }
}
