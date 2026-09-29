//! The tray icon: the way back to the window, and a dot that says whether a chat needs you
//! (pink: one is waiting on you, green: one is working).

use crate::live::LiveSession;
use crate::prefs::Prefs;
use crate::{apply_autostart, lock, prefs, show, toggle, Core};
use std::sync::{Mutex, OnceLock};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

const WAITING: [u8; 3] = [255, 45, 111];
const WORKING: [u8; 3] = [43, 255, 90];

struct TrayItems {
    autostart: CheckMenuItem<Wry>,
    shown: Mutex<Option<(Option<[u8; 3]>, String)>>,
}

pub fn build(app: &AppHandle, prefs: &Prefs) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open CC-Resume\tCtrl+Alt+Space", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, prefs.start_with_windows, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit CC-Resume", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &sep()?, &autostart, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(icon(None))
        .tooltip("CC-Resume")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show(app),
            "autostart" => flip_autostart(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(TrayItems { autostart, shown: Mutex::new(None) });
    Ok(())
}

fn flip_autostart(app: &AppHandle) {
    let core = app.state::<Core>();
    let on = {
        let mut p = lock(&core.prefs);
        p.start_with_windows = !p.start_with_windows;
        let _ = prefs::save(&core.prefs_path, &p);
        p.start_with_windows
    };
    apply_autostart(app, on);
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.autostart.set_checked(on);
    }
}

pub fn reflect(app: &AppHandle, live: &[LiveSession]) {
    let count = |s: &str| live.iter().filter(|l| l.status.as_deref() == Some(s)).count();
    let (waiting, busy) = (count("waiting"), count("busy"));
    let dot = if waiting > 0 { Some(WAITING) } else if busy > 0 { Some(WORKING) } else { None };
    let mut tip = format!("CC-Resume \u{b7} {} open", live.len());
    if waiting > 0 {
        tip.push_str(&format!(", {waiting} waiting on you"));
    }
    let Some(items) = app.try_state::<TrayItems>() else { return };
    let mut shown = lock(&items.shown);
    if shown.as_ref() == Some(&(dot, tip.clone())) {
        return;
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(icon(dot)));
        let _ = tray.set_tooltip(Some(&tip));
    }
    *shown = Some((dot, tip));
}

/// The app icon with an optional status dot in the corner, composited over the icon's pixels.
fn icon(dot: Option<[u8; 3]>) -> Image<'static> {
    static BASE: OnceLock<(Vec<u8>, u32, u32)> = OnceLock::new();
    let (rgba, w, h) = BASE.get_or_init(|| {
        let img = Image::from_bytes(include_bytes!("../icons/32x32.png")).expect("the bundled tray icon is a valid PNG");
        (img.rgba().to_vec(), img.width(), img.height())
    });
    let (w, h) = (*w, *h);
    let mut px = rgba.clone();
    if let Some(rgb) = dot {
        let r = w as f32 * 0.2;
        let (cx, cy) = (w as f32 - r - 1.0, h as f32 - r - 1.0);
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                let i = ((y * w + x) * 4) as usize;
                over(&mut px[i..i + 4], [12, 12, 12], (r + 1.6 - d).clamp(0.0, 1.0));
                over(&mut px[i..i + 4], rgb, (r - d).clamp(0.0, 1.0));
            }
        }
    }
    Image::new_owned(px, w, h)
}

/// Porter-Duff "over" for one straight-alpha pixel.
fn over(p: &mut [u8], rgb: [u8; 3], a: f32) {
    if a <= 0.0 {
        return;
    }
    let pa = p[3] as f32 / 255.0;
    let out = a + pa * (1.0 - a);
    for k in 0..3 {
        p[k] = ((rgb[k] as f32 * a + p[k] as f32 * pa * (1.0 - a)) / out).round() as u8;
    }
    p[3] = (out * 255.0).round() as u8;
}
