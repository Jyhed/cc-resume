//! Claude Code deletes transcripts older than `cleanupPeriodDays` (30 days unless set), and a chat
//! whose transcript is gone can't be listed or resumed. This reads that setting, and changes it
//! only when the user asks, keeping every other setting and a backup of the file as it was.

use crate::paths;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn cleanup_days() -> Option<u64> {
    let text = fs::read_to_string(paths::claude_settings()).ok()?;
    let v: serde_json::Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    v.get("cleanupPeriodDays")?.as_u64()
}

pub fn set_cleanup_days(days: u64) -> Result<(), String> {
    let path = paths::claude_settings();
    let original = fs::read_to_string(&path).ok();
    let mut v: serde_json::Value = match &original {
        Some(text) => serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .map_err(|e| format!("Claude Code's settings.json isn't valid JSON, so it was left alone: {e}"))?,
        None => serde_json::json!({}),
    };
    let obj = v.as_object_mut().ok_or("Claude Code's settings.json isn't a JSON object, so it was left alone")?;
    obj.insert("cleanupPeriodDays".into(), days.into());
    if let Some(text) = &original {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        let backup = path.with_file_name(format!("settings.json.cc-resume-{stamp}.bak"));
        fs::write(&backup, text).map_err(|e| format!("couldn't back up settings.json: {e}"))?;
    }
    let mut out = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    out.push('\n');
    fs::write(&path, out).map_err(|e| format!("couldn't write settings.json: {e}"))
}
