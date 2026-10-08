#![cfg(target_os = "macos")]

use std::net::TcpListener;
use std::path::Path;
use std::process::Command;

#[test]
fn permits_only_the_selected_loopback_proxy_port() {
    let allowed = TcpListener::bind("127.0.0.1:0").expect("allowed listener should bind");
    let denied = TcpListener::bind("127.0.0.1:0").expect("denied listener should bind");
    let allowed_port = allowed.local_addr().unwrap().port();
    let denied_port = denied.local_addr().unwrap().port();
    let accept = std::thread::spawn(move || allowed.accept().map(|_| ()).expect("selected connection should arrive"));

    assert!(probe(allowed_port, allowed_port).success(), "selected proxy port should be reachable");
    accept.join().expect("accept thread should complete");
    assert!(!probe(allowed_port, denied_port).success(), "an adjacent loopback port must remain denied");
}

fn probe(policy_port: u16, target_port: u16) -> std::process::ExitStatus {
    let workspace = std::env::current_dir().unwrap().canonicalize().unwrap();
    let private_temp = std::env::temp_dir().canonicalize().unwrap();
    Command::new(env!("CARGO_BIN_EXE_omni-sandbox"))
        .args(["--protocol-version", "4", "--diagnostic-token", "0123456789abcdef0123456789abcdef", "--mode", "controlled", "--workspace"])
        .arg(&workspace)
        .arg("--private-temp")
        .arg(&private_temp)
        .args(["--network", "loopback_proxy", "--network-proxy-port", &policy_port.to_string()])
        .args(runtime_read_arguments())
        .args(["--", "/usr/bin/nc", "-z", "-w", "1", "127.0.0.1", &target_port.to_string()])
        .status()
        .expect("sandbox network probe should launch")
}

fn runtime_read_arguments() -> Vec<String> {
    ["/System", "/usr/bin", "/usr/lib", "/usr/libexec", "/usr/sbin", "/usr/share", "/bin", "/sbin", "/Library/Apple", "/private/var/select"]
        .into_iter()
        .filter(|path| Path::new(path).exists())
        .flat_map(|path| ["--read-subtree".to_owned(), path.to_owned()])
        .collect()
}
