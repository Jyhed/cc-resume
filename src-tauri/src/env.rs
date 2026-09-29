//! The environment a program started fresh by Windows gets: the user's and the system's variables
//! as they stand in the registry right now. The app runs from login to logout, so its own copy is
//! only as new as the moment it started, and whatever launched it (an installer, a terminal, a
//! Claude Code session) may have added to it. Everything the app starts gets this one instead,
//! the same set a terminal opened from the Start menu would have.

use std::ffi::{c_void, OsString};
use std::os::windows::ffi::OsStringExt;
use std::process::Command;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_QUERY};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub type Vars = Vec<(OsString, OsString)>;

/// Builds the current user's environment from the registry, leaving this process's own out.
pub fn fresh() -> Result<Vars, String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, &mut token).map_err(|e| format!("opening the user token: {e}"))?;
        let mut block: *mut c_void = std::ptr::null_mut();
        let made = CreateEnvironmentBlock(&mut block, Some(token), false);
        let _ = CloseHandle(token);
        made.map_err(|e| format!("building the environment: {e}"))?;
        let vars = split(block_slice(block as *const u16));
        let _ = DestroyEnvironmentBlock(block);
        Ok(vars)
    }
}

/// One variable from the fresh environment, falling back to the app's own if Windows can't build one.
pub fn var(name: &str) -> Option<OsString> {
    match fresh() {
        Ok(vars) => vars.into_iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v),
        Err(_) => std::env::var_os(name),
    }
}

/// Gives `cmd` the fresh environment. If Windows can't build one, the app's own goes along instead,
/// which is why startup still clears what a Claude Code session leaves in it.
pub fn apply(cmd: &mut Command) {
    match fresh() {
        Ok(vars) => {
            cmd.env_clear().envs(vars);
        }
        Err(e) => log::warn!("couldn't read a fresh environment, passing on the app's own: {e}"),
    }
}

/// The block is `NAME=value` strings back to back, each ending in a NUL, with one more NUL after the last.
unsafe fn block_slice<'a>(p: *const u16) -> &'a [u16] {
    let mut len = 0;
    while !(*p.add(len) == 0 && *p.add(len + 1) == 0) {
        len += 1;
    }
    std::slice::from_raw_parts(p, len + 2)
}

fn split(block: &[u16]) -> Vars {
    block
        .split(|&c| c == 0)
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            // Names can start with '=' (per-drive current folders), so the split looks past the first character.
            let eq = entry.iter().skip(1).position(|&c| c == u16::from(b'='))? + 1;
            Some((OsString::from_wide(&entry[..eq]), OsString::from_wide(&entry[eq + 1..])))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn splits_a_block() {
        let vars = split(&wide("A=1\0=C:=C:\\x\0PATH=C:\\a;C:\\b\0\0"));
        let text: Vec<(String, String)> = vars.into_iter().map(|(k, v)| (k.into_string().unwrap(), v.into_string().unwrap())).collect();
        assert_eq!(text, [("A".into(), "1".into()), ("=C:".into(), "C:\\x".into()), ("PATH".into(), "C:\\a;C:\\b".into())]);
    }

    /// Something set in this process only must not reach what the app starts, while the user's
    /// real variables do.
    #[test]
    fn leaves_the_apps_own_variables_out() {
        std::env::set_var("CC_RESUME_ONLY_IN_THIS_PROCESS", "1");
        let vars = fresh().unwrap();
        let has = |n: &str| vars.iter().any(|(k, _)| k.eq_ignore_ascii_case(n));
        assert!(!has("CC_RESUME_ONLY_IN_THIS_PROCESS"));
        for name in ["PATH", "USERPROFILE", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT"] {
            assert!(has(name), "{name} is missing from the fresh environment");
        }
    }
}
