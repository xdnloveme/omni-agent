use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;

use crate::SandboxError;

#[link(name = "sandbox")]
unsafe extern "C" {
    fn sandbox_init(profile: *const c_char, flags: u64, error_buffer: *mut *mut c_char) -> i32;
    fn sandbox_free_error(error_buffer: *mut c_char);
}

pub(crate) fn apply(profile: &str) -> Result<(), SandboxError> {
    let profile = CString::new(profile).map_err(|_| {
        SandboxError::new(
            "sandbox_policy_error",
            "sandbox policy contains an embedded NUL byte",
        )
    })?;
    let mut error_buffer = ptr::null_mut();
    // SAFETY: profile is a live NUL-terminated string and error_buffer is an out pointer
    // released with sandbox_free_error when populated by sandbox_init.
    let result = unsafe { sandbox_init(profile.as_ptr(), 0, &mut error_buffer) };
    if result == 0 {
        return Ok(());
    }
    let detail = if error_buffer.is_null() {
        "unable to initialize the macOS sandbox".to_owned()
    } else {
        // SAFETY: sandbox_init documents a NUL-terminated error string on failure.
        let message = unsafe { CStr::from_ptr(error_buffer) }
            .to_string_lossy()
            .into_owned();
        // SAFETY: error_buffer was allocated by sandbox_init and is released exactly once.
        unsafe { sandbox_free_error(error_buffer) };
        message
    };
    Err(SandboxError::new("sandbox_policy_error", detail))
}
