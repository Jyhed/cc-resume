//! Bringing a running chat's terminal to the front. Claude Code titles its terminal after the chat,
//! with a status glyph in front ("✳ Fix the login bug"), so the tab is found by that title: in
//! Windows Terminal through UI Automation, which can also select the tab inside its window, and
//! otherwise among plain console windows.

use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationSelectionItemPattern, TreeScope_Descendants, UIA_ControlTypePropertyId,
    UIA_SelectionItemPatternId, UIA_TabItemControlTypeId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
};

const TERMINAL_CLASS: &str = "CASCADIA_HOSTING_WINDOW_CLASS";

struct Win {
    hwnd: HWND,
    class: String,
    title: String,
}

/// Focuses the window, and in Windows Terminal the tab, showing a chat with this title.
/// Must run off the UI thread: UI Automation calls block while they walk other processes.
pub fn jump(title: &str) -> Result<(), String> {
    let wins = top_windows();
    if let Some(hwnd) = terminal_tab(&wins, title) {
        front(hwnd);
        return Ok(());
    }
    if let Some(w) = wins.iter().find(|w| same_title(&w.title, title)) {
        front(w.hwnd);
        return Ok(());
    }
    Err(format!("it's running, but no terminal titled \"{title}\" was found"))
}

fn terminal_tab(wins: &[Win], title: &str) -> Option<HWND> {
    unsafe {
        // Each call runs on its own worker thread, so joining the multithreaded apartment is safe.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
        let is_tab = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TabItemControlTypeId.0)).ok()?;
        for w in wins.iter().filter(|w| w.class == TERMINAL_CLASS) {
            let Ok(root) = uia.ElementFromHandle(w.hwnd) else { continue };
            let Ok(tabs) = root.FindAll(TreeScope_Descendants, &is_tab) else { continue };
            for i in 0..tabs.Length().unwrap_or(0) {
                let Ok(tab) = tabs.GetElement(i) else { continue };
                let name = tab.CurrentName().map(|b| b.to_string()).unwrap_or_default();
                if same_title(&name, title) {
                    if let Ok(sel) = tab.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
                        let _ = sel.Select();
                    }
                    return Some(w.hwnd);
                }
            }
        }
        None
    }
}

fn top_windows() -> Vec<Win> {
    unsafe extern "system" fn collect(hwnd: HWND, lp: LPARAM) -> BOOL {
        let list = &mut *(lp.0 as *mut Vec<Win>);
        if IsWindowVisible(hwnd).as_bool() {
            let mut class = [0u16; 256];
            let mut title = [0u16; 512];
            let c = GetClassNameW(hwnd, &mut class).max(0) as usize;
            let t = GetWindowTextW(hwnd, &mut title).max(0) as usize;
            list.push(Win { hwnd, class: String::from_utf16_lossy(&class[..c]), title: String::from_utf16_lossy(&title[..t]) });
        }
        BOOL(1)
    }
    let mut list: Vec<Win> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<Win> as isize));
    }
    list
}

fn front(hwnd: HWND) {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
    }
}

/// Exact title, or the title behind Claude Code's one-glyph status prefix.
fn same_title(shown: &str, title: &str) -> bool {
    let (shown, title) = (shown.trim(), title.trim());
    if title.is_empty() {
        return false;
    }
    if shown == title {
        return true;
    }
    shown.strip_suffix(title).is_some_and(|prefix| {
        let p = prefix.trim();
        p.chars().count() <= 2 && !p.chars().any(char::is_alphanumeric)
    })
}

#[cfg(test)]
mod tests {
    use super::same_title;

    /// Checks against real windows, on demand only:
    /// CC_RESUME_JUMP_TITLE="a running chat's title" cargo test --lib -- --ignored jumps_to_a_real_tab
    #[test]
    #[ignore]
    fn jumps_to_a_real_tab() {
        let title = std::env::var("CC_RESUME_JUMP_TITLE").expect("set CC_RESUME_JUMP_TITLE to a running chat's title");
        super::jump(&title).unwrap();
    }

    #[test]
    fn matches_behind_status_glyph() {
        assert!(same_title("✳ Chat session", "Chat session"));
        assert!(same_title("◑ Idea discussion", "Idea discussion"));
        assert!(same_title("Chat session", "Chat session"));
        assert!(!same_title("Old Chat session", "Chat session"));
        assert!(!same_title("✳ Chat session", ""));
    }
}
