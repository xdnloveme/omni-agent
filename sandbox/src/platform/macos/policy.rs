use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::invocation::{Invocation, NetworkPolicy, PathScope, ScopeKind};
use crate::SandboxError;

const BASE_POLICY: &str = include_str!("../../../policies/macos/base.sbpl");

pub(crate) fn build(invocation: &Invocation) -> Result<String, SandboxError> {
    let mut profile = BASE_POLICY.to_owned();
    append_allow(
        &mut profile,
        "file-read*",
        &PathScope {
            path: invocation.workspace.clone(),
            kind: ScopeKind::Subtree,
        },
    )?;
    append_scope_metadata(&mut profile, invocation)?;
    append_allow(
        &mut profile,
        "file-write*",
        &PathScope {
            path: invocation.workspace.clone(),
            kind: ScopeKind::Subtree,
        },
    )?;
    append_allow(
        &mut profile,
        "file-read*",
        &PathScope {
            path: invocation.private_temp.clone(),
            kind: ScopeKind::Subtree,
        },
    )?;
    append_allow(
        &mut profile,
        "file-write*",
        &PathScope {
            path: invocation.private_temp.clone(),
            kind: ScopeKind::Subtree,
        },
    )?;
    for scope in &invocation.read {
        append_allow(&mut profile, "file-read*", scope)?;
    }
    for scope in &invocation.write {
        append_allow(&mut profile, "file-write*", scope)?;
    }
    for root in &invocation.protected_write_roots {
        profile.push_str(&format!(
            "(deny file-write-unlink (literal \"{}\"))\n",
            escape(root)?
        ));
    }
    for denied in &invocation.denied_read_subtrees {
        append_sensitive_subtree_deny(
            &mut profile,
            "file-read*",
            denied,
            &invocation.approved_sensitive_reads,
        )?;
        append_sensitive_subtree_deny(&mut profile, "file-write*", denied, &[])?;
    }
    append_sensitive_names(
        &mut profile,
        "file-read*",
        &invocation.denied_read_names,
        &invocation.denied_read_prefixes,
        &invocation.allowed_read_names,
        &invocation.approved_sensitive_reads,
    )?;
    append_sensitive_names(
        &mut profile,
        "file-write*",
        &invocation.denied_read_names,
        &invocation.denied_read_prefixes,
        &invocation.allowed_read_names,
        &[],
    )?;
    if let NetworkPolicy::LoopbackProxy { port } = invocation.network {
        profile.push_str(&format!(
            "(allow network-outbound (remote tcp \"localhost:{port}\"))\n"
        ));
    }
    Ok(profile)
}

fn append_scope_metadata(
    profile: &mut String,
    invocation: &Invocation,
) -> Result<(), SandboxError> {
    let paths = [
        invocation.workspace.as_path(),
        invocation.private_temp.as_path(),
    ]
    .into_iter()
    .chain(invocation.read.iter().map(|scope| scope.path.as_path()))
    .chain(invocation.write.iter().map(|scope| scope.path.as_path()));
    let mut ancestors = BTreeSet::<PathBuf>::new();
    for target in paths {
        for ancestor in target.ancestors() {
            ancestors.insert(ancestor.to_path_buf());
        }
    }
    for ancestor in ancestors {
        profile.push_str(&format!(
            "(allow file-read-metadata (literal \"{}\"))\n",
            escape(&ancestor)?
        ));
    }
    Ok(())
}

fn append_sensitive_names(
    profile: &mut String,
    operation: &str,
    names: &[String],
    prefixes: &[String],
    allowed_names: &[String],
    approved: &[std::path::PathBuf],
) -> Result<(), SandboxError> {
    let denied = names
        .iter()
        .map(|name| format!(r#"(regex #"/{}$")"#, regex_escape(name)))
        .chain(
            prefixes
                .iter()
                .map(|prefix| format!(r#"(regex #"/{}.*$")"#, regex_escape(prefix))),
        )
        .collect::<Vec<_>>();
    if denied.is_empty() {
        return Ok(());
    }
    let exceptions = allowed_names
        .iter()
        .map(|name| format!(r#"(regex #"/{}$")"#, regex_escape(name)))
        .chain(
            approved
                .iter()
                .map(|path| escape(path).map(|value| format!("(literal \"{value}\")")))
                .collect::<Result<Vec<_>, _>>()?,
        )
        .collect::<Vec<_>>();
    profile.push_str(&format!(
        "(deny {operation} (require-all (require-any {}) (require-not (require-any {}))))\n",
        denied.join(" "),
        exceptions.join(" ")
    ));
    Ok(())
}

fn regex_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if matches!(
            character,
            '.' | '+' | '*' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '$' | '|' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn append_allow(
    profile: &mut String,
    operation: &str,
    scope: &PathScope,
) -> Result<(), SandboxError> {
    let path = escape(&scope.path)?;
    match scope.kind {
        ScopeKind::Exact => {
            profile.push_str(&format!("(allow {operation} (literal \"{path}\"))\n"));
        }
        ScopeKind::Subtree => {
            profile.push_str(&format!(
                "(allow {operation} (literal \"{path}\") (subpath \"{path}\"))\n"
            ));
        }
    }
    Ok(())
}

fn append_sensitive_subtree_deny(
    profile: &mut String,
    operation: &str,
    denied: &Path,
    approved: &[std::path::PathBuf],
) -> Result<(), SandboxError> {
    let exceptions = approved
        .iter()
        .filter(|path| path.starts_with(denied))
        .map(|path| escape(path).map(|value| format!("(literal \"{value}\")")))
        .collect::<Result<Vec<_>, _>>()?;
    if exceptions.is_empty() {
        profile.push_str(&format!(
            "(deny {operation} (subpath \"{}\"))\n",
            escape(denied)?
        ));
    } else {
        profile.push_str(&format!(
            "(deny {operation} (require-all (subpath \"{}\") (require-not (require-any {}))))\n",
            escape(denied)?,
            exceptions.join(" ")
        ));
    }
    Ok(())
}

fn escape(path: &Path) -> Result<String, SandboxError> {
    let value = path.to_str().ok_or_else(|| {
        SandboxError::new(
            "sandbox_invalid_request",
            "sandbox paths must be valid UTF-8",
        )
    })?;
    Ok(value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    #[test]
    fn keeps_sensitive_template_exception_inside_one_deny_rule() {
        let invocation = Invocation::parse(
            vec![
                "--protocol-version",
                "4",
                "--diagnostic-token",
                "0123456789abcdef0123456789abcdef",
                "--mode",
                "controlled",
                "--workspace",
                "/",
                "--private-temp",
                "/tmp",
                "--network",
                "disabled",
                "--read-subtree",
                "/tmp",
                "--protect-write-root",
                "/tmp",
                "--deny-read-name",
                ".env",
                "--deny-read-prefix",
                ".env.",
                "--allow-read-name",
                ".env.example",
                "--",
                "true",
            ]
            .into_iter()
            .map(OsString::from)
            .collect(),
        )
        .expect("valid invocation");
        let profile = build(&invocation).expect("valid policy");
        assert!(profile.contains("(require-not (require-any"));
        assert!(profile.contains(r#"/\.env\.example$"#));
        assert!(profile.contains("(deny file-read*"));
        assert!(profile.contains("(deny file-write*"));
        assert!(profile.contains("(deny file-write-unlink (literal \"/private/tmp\"))"));
        assert!(profile
            .contains("(allow file-read* (literal \"/private/tmp\") (subpath \"/private/tmp\"))"));
    }
}
