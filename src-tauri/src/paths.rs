//! Where Claude Code and Windows Terminal keep their files on this machine.

use std::path::PathBuf;

/// Claude Code's own folder. CLAUDE_CONFIG_DIR moves all of it, transcripts included.
pub fn claude_home() -> PathBuf {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir().unwrap_or_default().join(".claude"),
    }
}

pub fn projects_dir() -> PathBuf {
    claude_home().join("projects")
}

/// One small file per running session, rewritten whenever that session changes state.
pub fn sessions_dir() -> PathBuf {
    claude_home().join("sessions")
}

pub fn claude_settings() -> PathBuf {
    claude_home().join("settings.json")
}

/// The claude executable: the native installer's location first, then PATH (npm installs a .cmd shim).
/// Looked up each time it's needed, so installing or moving Claude Code needs no restart here.
pub fn claude_exe() -> Option<PathBuf> {
    if let Some(home) = dirs::home_dir() {
        let native = home.join(".local").join("bin").join("claude.exe");
        if native.is_file() {
            return Some(native);
        }
    }
    find_on_path(&["claude.exe", "claude.cmd"])
}

pub fn wt_exe() -> Option<PathBuf> {
    if let Some(local) = dirs::data_local_dir() {
        let alias = local.join("Microsoft").join("WindowsApps").join("wt.exe");
        if alias.is_file() {
            return Some(alias);
        }
    }
    find_on_path(&["wt.exe"])
}

/// Windows Terminal settings: the Store build keeps them in its package folder, the unpackaged
/// build in LocalAppData. Preview builds come last so a stable install wins.
pub fn wt_settings() -> Option<PathBuf> {
    let local = dirs::data_local_dir()?;
    let packaged = |pkg: &str| local.join("Packages").join(pkg).join("LocalState").join("settings.json");
    [
        packaged("Microsoft.WindowsTerminal_8wekyb3d8bbwe"),
        local.join("Microsoft").join("Windows Terminal").join("settings.json"),
        packaged("Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

/// Searches the user's PATH as it is now, not the copy this app started with.
fn find_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = crate::env::var("PATH")?;
    std::env::split_paths(&path).find_map(|dir| names.iter().map(|n| dir.join(n)).find(|p| p.is_file()))
}
