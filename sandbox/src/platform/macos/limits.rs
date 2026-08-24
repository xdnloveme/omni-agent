use crate::SandboxError;

const MAX_OPEN_FILES: libc::rlim_t = 1024;
const MAX_FILE_SIZE: libc::rlim_t = 2 * 1024 * 1024 * 1024;

pub(crate) fn apply() -> Result<(), SandboxError> {
    set(libc::RLIMIT_NOFILE, MAX_OPEN_FILES, "open-file")?;
    set(libc::RLIMIT_FSIZE, MAX_FILE_SIZE, "file-size")
}

fn set(resource: libc::c_int, value: libc::rlim_t, label: &str) -> Result<(), SandboxError> {
    let limit = libc::rlimit {
        rlim_cur: value,
        rlim_max: value,
    };
    // SAFETY: setrlimit only reads the supplied value for the current process.
    let result = unsafe { libc::setrlimit(resource, &limit) };
    if result == 0 {
        Ok(())
    } else {
        Err(SandboxError::new(
            "sandbox_limit_failed",
            format!(
                "unable to apply {label} limit: {}",
                std::io::Error::last_os_error()
            ),
        ))
    }
}
