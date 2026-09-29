//! Which chats are running right now, straight from Claude Code: `claude agents --json` lists every
//! active session, interactive ones included, with its pid, folder and state (busy, idle, or
//! waiting with a reason). It is the documented scripting interface, so it outlives format changes
//! in the files behind it.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};

#[derive(Deserialize, Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    pub pid: u32,
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub started_at: Option<u64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub waiting_for: Option<String>,
}

pub fn query(claude: &Path) -> Result<Vec<LiveSession>, String> {
    let is_shim = claude.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd"));
    let mut cmd = if is_shim {
        let mut c = Command::new("cmd.exe");
        c.arg("/d").arg("/c").arg(claude);
        c
    } else {
        Command::new(claude)
    };
    cmd.args(["agents", "--json"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::env::apply(&mut cmd);
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("could not run claude: {e}"))?;
    if !out.status.success() {
        return Err(format!("claude agents --json exited with {}", out.status));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("unexpected output from claude agents --json: {e}"))
}

/// Keeps a console window from flashing up every time the app asks Claude Code something.
pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_listing() {
        let json = br#"[{"pid":7472,"cwd":"C:\\p","kind":"interactive","startedAt":1,"sessionId":"f09d","name":"p-aa","status":"waiting","waitingFor":"dialog open","extra":true}]"#;
        let s: Vec<LiveSession> = serde_json::from_slice(json).unwrap();
        assert_eq!(s[0].status.as_deref(), Some("waiting"));
        assert_eq!(s[0].waiting_for.as_deref(), Some("dialog open"));
    }
}
