#![cfg(target_os = "macos")]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn permits_child_mutation_but_preserves_the_protected_root() {
    let fixture = Fixture::new();
    let status = Command::new(env!("CARGO_BIN_EXE_omni-sandbox"))
        .args([
            "--protocol-version",
            "4",
            "--diagnostic-token",
            "0123456789abcdef0123456789abcdef",
            "--mode",
            "controlled",
            "--workspace",
        ])
        .arg(&fixture.root)
        .arg("--private-temp")
        .arg(&fixture.private_temp)
        .args(["--network", "disabled"])
        .arg("--protect-write-root")
        .arg(&fixture.root)
        .arg("--read-subtree")
        .arg(&fixture.base)
        .arg("--write-subtree")
        .arg(&fixture.base)
        .args(runtime_read_arguments())
        .args(["--", "/bin/sh", "-c"])
        .arg(
            r#"
set -eu
printf 'content' > child.txt
test "$(cat child.txt)" = content
rm child.txt
mkdir child-dir
rmdir child-dir
cd "$2"
rm -rf "$1" 2>/dev/null || true
test -d "$1"
mv "$1" "$3" 2>/dev/null || true
test -d "$1"
test ! -e "$3"
"#,
        )
        .arg("root-protection-test")
        .arg(&fixture.root)
        .arg(&fixture.private_temp)
        .arg(fixture.base.join("moved-root"))
        .current_dir(&fixture.root)
        .status()
        .expect("sandbox process should launch");

    assert!(
        status.success(),
        "sandboxed mutation probe failed: {status}"
    );
    assert!(fixture.root.is_dir(), "protected root was removed");
}

fn runtime_read_arguments() -> Vec<String> {
    [
        "/System",
        "/usr/bin",
        "/usr/lib",
        "/usr/libexec",
        "/usr/sbin",
        "/usr/share",
        "/bin",
        "/sbin",
        "/Library/Apple",
        "/private/var/select",
    ]
    .into_iter()
    .filter(|path| Path::new(path).exists())
    .flat_map(|path| ["--read-subtree".to_owned(), path.to_owned()])
    .collect()
}

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    private_temp: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should follow the Unix epoch")
            .as_nanos();
        let base =
            std::env::temp_dir().join(format!("omni-sandbox-root-{nonce}-{}", std::process::id()));
        let root = base.join("root");
        let private_temp = base.join("private-temp");
        fs::create_dir_all(&root).expect("fixture root should be created");
        fs::create_dir(&private_temp).expect("private temp should be created");
        let base = base.canonicalize().expect("fixture base should resolve");
        let root = root.canonicalize().expect("fixture root should resolve");
        let private_temp = private_temp
            .canonicalize()
            .expect("private temp should resolve");
        Self {
            base,
            root,
            private_temp,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}
