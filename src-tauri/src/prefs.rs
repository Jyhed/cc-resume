//! The app's own settings, kept as JSON beside its cache.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Prefs {
    /// Where the light/dark dimmer rests: 0 is dark, 1 is light.
    pub mix: f64,
    /// Follow the Windows light/dark setting instead of the dimmer.
    pub auto_theme: bool,
    /// "window" or "split".
    pub mode: String,
    pub fork: bool,
    /// Project keys pinned by the user, in pin order.
    pub pins: Vec<String>,
    /// The app is for being there when needed, so it starts with Windows until the user says otherwise.
    pub start_with_windows: bool,
    pub retention_dismissed: bool,
    /// "chats" or "desks": the view in use last, which the window opens on.
    pub view: String,
    /// Chats opened together, remembered with where each one sat. The page owns this list.
    pub desks: Vec<Desk>,
}

/// A set of chats and the spot each one takes in its window. Every "open together" is kept as an
/// unnamed desk; naming one saves it for good.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Desk {
    pub id: String,
    pub name: Option<String>,
    /// The layout rule, read by the page: "grid", "main", "cols" or "rows".
    pub shape: String,
    /// Session ids in pane order.
    pub slots: Vec<String>,
    /// Milliseconds since the epoch.
    pub created: u64,
    pub opened: Option<u64>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs {
            mix: 0.0,
            auto_theme: false,
            mode: "window".into(),
            fork: false,
            pins: Vec::new(),
            start_with_windows: true,
            retention_dismissed: false,
            view: "chats".into(),
            desks: Vec::new(),
        }
    }
}

pub fn load(path: &Path) -> Prefs {
    fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(path: &Path, prefs: &Prefs) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prefs written before desks existed, with the retired theme choice, still load as they were.
    #[test]
    fn reads_older_prefs() {
        let old = br#"{"theme":"channel","mix":0.57,"autoTheme":false,"mode":"tab","fork":true,"pins":["k"],"startWithWindows":false,"retentionDismissed":true}"#;
        let p: Prefs = serde_json::from_slice(old).unwrap();
        assert_eq!((p.mix, p.fork, p.pins.len(), p.start_with_windows, p.desks.len(), p.view.as_str()), (0.57, true, 1, false, 0, "chats"));
    }
}
