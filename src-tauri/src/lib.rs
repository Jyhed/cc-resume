//! CC-Resume: every Claude Code chat on this PC, one click away from its terminal.
//! The Rust side owns the facts (transcripts, running sessions, launching, finding windows); the
//! web side owns how they look.

mod env;
mod focus;
mod index;
mod launch;
mod live;
mod paths;
mod prefs;
mod retention;
mod tray;

use index::{Index, Project};
use live::LiveSession;
use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode};
use prefs::Prefs;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Running sessions are re-read at least this often, in case a process died without a trace.
const LIVE_HEARTBEAT: Duration = Duration::from_secs(12);
/// A busy machine rewrites the session registry constantly; one query per this gap is plenty.
const LIVE_MIN_GAP: Duration = Duration::from_millis(1200);
/// Watchers can miss events (sleep, file system hiccups); a periodic full pass catches up cheaply.
const FULL_RESCAN: Duration = Duration::from_secs(300);

pub struct Core {
    index: Mutex<Index>,
    live: Mutex<Vec<LiveSession>>,
    live_error: Mutex<Option<String>>,
    prefs: Mutex<Prefs>,
    prefs_path: PathBuf,
    scanning: AtomicBool,
    kick_live: Mutex<Option<Sender<()>>>,
}

/// A worker that panicked mid-update must not take the whole app down with a poisoned lock.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The installer puts the program in LocalAppData\CC-Resume, and an uninstall clears that folder,
/// so the app's own data lives beside it under the app identifier instead. Prefs saved by early
/// builds in the program folder move over once.
fn data_dir() -> PathBuf {
    let local = dirs::data_local_dir().unwrap_or_default();
    let dir = local.join("com.jihed.ccresume");
    let (old, new) = (local.join("CC-Resume").join("prefs.json"), dir.join("prefs.json"));
    if !new.exists() && old.is_file() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::copy(&old, &new);
    }
    dir
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    now: u64,
    projects: Vec<Project>,
    live: Vec<LiveSession>,
    live_error: Option<String>,
    retention_days: Option<u64>,
    scanning: bool,
}

#[derive(Serialize)]
struct Outcome {
    kind: &'static str,
    line: String,
    cmd: String,
}

fn snapshot_of(core: &Core) -> Snapshot {
    Snapshot {
        now: now_ms(),
        projects: lock(&core.index).projects(),
        live: lock(&core.live).clone(),
        live_error: lock(&core.live_error).clone(),
        retention_days: retention::cleanup_days(),
        scanning: core.scanning.load(Ordering::Relaxed),
    }
}

fn publish(app: &AppHandle) {
    let snap = snapshot_of(&app.state::<Core>());
    tray::reflect(app, &snap.live);
    let _ = app.emit("snapshot", &snap);
}

fn kick_live(app: &AppHandle) {
    if let Some(tx) = lock(&app.state::<Core>().kick_live).as_ref() {
        let _ = tx.send(());
    }
}

/// Asks Claude Code which sessions are running. On failure the last good list stays, so one bad
/// read doesn't make every open chat look closed.
fn poll_live(app: &AppHandle) -> Vec<LiveSession> {
    let core = app.state::<Core>();
    let (list, err) = match paths::claude_exe() {
        None => (Vec::new(), Some("claude.exe wasn't found, so running chats can't be seen".to_string())),
        Some(exe) => match live::query(&exe) {
            Ok(l) => (l, None),
            Err(e) => (lock(&core.live).clone(), Some(e)),
        },
    };
    let changed = {
        let (mut cur, mut e) = (lock(&core.live), lock(&core.live_error));
        if err.is_some() && *e != err {
            log::warn!("reading running sessions failed: {}", err.as_deref().unwrap_or_default());
        }
        let changed = *cur != list || *e != err;
        *cur = list.clone();
        *e = err;
        changed
    };
    if changed {
        publish(app);
    }
    list
}

async fn fresh_live(app: &AppHandle) -> Vec<LiveSession> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || poll_live(&app)).await.unwrap_or_default()
}

fn usable_dir(dir: &str) -> PathBuf {
    let p = PathBuf::from(dir);
    if !dir.is_empty() && p.is_dir() {
        p
    } else {
        dirs::home_dir().unwrap_or(p)
    }
}

fn place(mode: launch::Mode) -> &'static str {
    if mode == launch::Mode::Split { "a split pane" } else { "its own window" }
}

async fn jump_to(l: LiveSession, title: Option<String>) -> Result<Outcome, String> {
    let title = title.or_else(|| l.name.clone()).ok_or("it's running, but it has no title yet to find its window by")?;
    let t = title.clone();
    tauri::async_runtime::spawn_blocking(move || focus::jump(&t)).await.map_err(|e| e.to_string())??;
    Ok(Outcome { kind: "jump", line: "already open, jumped to its window".into(), cmd: format!("pid {} \u{b7} {title}", l.pid) })
}

/* ---------------- commands ---------------- */

#[tauri::command]
fn snapshot(app: AppHandle) -> Snapshot {
    snapshot_of(&app.state::<Core>())
}

/// The page has drawn its first frame. Started by Windows at login, the app stays in the tray.
#[tauri::command]
fn ready(app: AppHandle) {
    if !std::env::args().any(|a| a == "--hidden") {
        show(&app);
    }
}

/// Opening a chat that is already running would make two terminals write into one transcript, so
/// the running sessions are re-read first and a running chat is a jump to its window. A fork is
/// the exception: it gets its own session id.
#[tauri::command]
async fn resume(app: AppHandle, session_id: String, mode: String, fork: bool) -> Result<Outcome, String> {
    let running = fresh_live(&app).await.into_iter().find(|l| l.session_id == session_id);
    let located = lock(&app.state::<Core>().index).locate(&session_id);
    if let (Some(l), false) = (running, fork) {
        return jump_to(l, located.and_then(|(_, t)| t)).await;
    }
    let (dir, _) = located.ok_or("this chat's transcript is gone, so it can't be resumed")?;
    let mut args = vec!["--resume", session_id.as_str()];
    if fork {
        args.push("--fork-session");
    }
    let mode = launch::Mode::parse(&mode);
    let cmd = launch::open(&usable_dir(&dir), &args, mode)?;
    let verb = if fork { "forking" } else { "resuming" };
    Ok(Outcome { kind: "open", line: format!("{verb} in {}", place(mode)), cmd })
}

#[tauri::command]
async fn new_chat(app: AppHandle, project_key: String, mode: String) -> Result<Outcome, String> {
    let dir = lock(&app.state::<Core>().index).project_path(&project_key).ok_or("that project has no chats left")?;
    let mode = launch::Mode::parse(&mode);
    let cmd = launch::open(&usable_dir(&dir), &[], mode)?;
    Ok(Outcome { kind: "open", line: format!("new chat in {}", place(mode)), cmd })
}

/// Opens the picked chats together in one new window, each in the spot `layout` gives it (pane i is
/// session_ids[i]). A running chat can't get a second copy, so it's left out (or forked, in fork
/// mode) and counted in the answer; a chat whose transcript is gone is left out too. Their
/// neighbours take the room they would have had.
#[tauri::command]
async fn open_together(app: AppHandle, session_ids: Vec<String>, layout: launch::Node, fork: bool) -> Result<Outcome, String> {
    launch::check(&layout, session_ids.len())?;
    let running = fresh_live(&app).await;
    let (mut panes, mut slot) = (Vec::new(), vec![None; session_ids.len()]);
    let (mut open, mut gone) = (0, 0);
    {
        let core = app.state::<Core>();
        let index = lock(&core.index);
        for (i, id) in session_ids.iter().enumerate() {
            let Some((dir, _)) = index.locate(id) else {
                gone += 1;
                continue;
            };
            if !fork && running.iter().any(|l| &l.session_id == id) {
                open += 1;
                continue;
            }
            let mut args = vec!["--resume".to_string(), id.clone()];
            if fork {
                args.push("--fork-session".into());
            }
            slot[i] = Some(panes.len());
            panes.push(launch::Pane { dir: usable_dir(&dir), args });
        }
    }
    let Some(layout) = layout.prune(&|i| slot[i]) else {
        return Err(if open > 0 { "they're all open already".into() } else { "none of those chats can be found anymore".into() });
    };
    let cmd = launch::open_layout(&panes, &layout)?;
    let mut line = format!("{} {} side by side", if fork { "forked" } else { "opened" }, panes.len());
    if open > 0 {
        line.push_str(&format!(", {open} already open"));
    }
    if gone > 0 {
        line.push_str(&format!(", {gone} gone"));
    }
    Ok(Outcome { kind: "open", line, cmd })
}

/// For running sessions that have no transcript yet (nothing sent), which `resume` can't know.
#[tauri::command]
async fn jump(app: AppHandle, session_id: String) -> Result<Outcome, String> {
    let l = fresh_live(&app).await.into_iter().find(|l| l.session_id == session_id).ok_or("that chat isn't running anymore")?;
    let title = lock(&app.state::<Core>().index).locate(&session_id).and_then(|(_, t)| t);
    jump_to(l, title).await
}

#[tauri::command]
fn get_prefs(app: AppHandle) -> Prefs {
    lock(&app.state::<Core>().prefs).clone()
}

#[tauri::command]
fn save_prefs(app: AppHandle, mut prefs: Prefs) -> Result<(), String> {
    let core = app.state::<Core>();
    // The tray owns this one; a page holding an older copy must not undo a tray click.
    prefs.start_with_windows = lock(&core.prefs).start_with_windows;
    prefs::save(&core.prefs_path, &prefs)?;
    *lock(&core.prefs) = prefs;
    Ok(())
}

#[tauri::command]
fn keep_chats(app: AppHandle, days: u64) -> Result<(), String> {
    retention::set_cleanup_days(days)?;
    publish(&app);
    Ok(())
}

#[tauri::command]
fn hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn minimize(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.minimize();
    }
}

/* ---------------- window, tray, hotkey ---------------- */

pub fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit("summoned", ());
    }
}

pub fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let up = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false);
        if up {
            let _ = w.hide();
        } else {
            show(app);
        }
    }
}

/// Each release launch points the Windows startup entry at the running copy, or removes it, so an
/// installed app and an old build never fight over it. Debug builds leave the entry alone.
pub fn apply_autostart(app: &AppHandle, on: bool) {
    if cfg!(debug_assertions) {
        return;
    }
    let launcher = app.autolaunch();
    if let Err(e) = if on { launcher.enable() } else { launcher.disable() } {
        log::warn!("couldn't update start with Windows: {e}");
    }
}

fn summon_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}

fn register_summon(app: &AppHandle) {
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if shortcut == &summon_key() && event.state() == ShortcutState::Pressed {
                toggle(app);
            }
        })
        .build();
    if let Err(e) = app.plugin(plugin) {
        log::warn!("global shortcut plugin failed: {e}");
        return;
    }
    if let Err(e) = app.global_shortcut().register(summon_key()) {
        log::warn!("Ctrl+Alt+Space is taken by another app: {e}");
    }
}

/* ---------------- background work ---------------- */

fn start_background(app: AppHandle) {
    let a = app.clone();
    std::thread::spawn(move || {
        let core = a.state::<Core>();
        {
            let mut idx = lock(&core.index);
            idx.rescan();
            idx.save();
        }
        core.scanning.store(false, Ordering::Relaxed);
        publish(&a);
    });

    let (tx, rx) = mpsc::channel::<()>();
    *lock(&app.state::<Core>().kick_live) = Some(tx);
    let a = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<Instant> = None;
        loop {
            if let Err(RecvTimeoutError::Disconnected) = rx.recv_timeout(LIVE_HEARTBEAT) {
                break;
            }
            if let Some(wait) = last.map(|t| LIVE_MIN_GAP.saturating_sub(t.elapsed())).filter(|w| !w.is_zero()) {
                std::thread::sleep(wait);
            }
            while rx.try_recv().is_ok() {}
            poll_live(&a);
            last = Some(Instant::now());
        }
    });
    kick_live(&app);

    std::thread::spawn(move || watch(app));
}

fn watch(app: AppHandle) {
    let (tx, rx) = mpsc::channel();
    let mut debouncer = match new_debouncer(Duration::from_millis(350), tx) {
        Ok(d) => d,
        Err(e) => {
            log::error!("can't watch Claude Code's folders: {e}");
            return;
        }
    };
    let (projects, sessions) = (paths::projects_dir(), paths::sessions_dir());
    if let Err(e) = debouncer.watcher().watch(&projects, RecursiveMode::Recursive) {
        log::warn!("can't watch {}: {e}", projects.display());
    }
    if let Err(e) = debouncer.watcher().watch(&sessions, RecursiveMode::NonRecursive) {
        log::warn!("can't watch {}: {e}", sessions.display());
    }
    let mut last_full = Instant::now();
    loop {
        match rx.recv_timeout(FULL_RESCAN) {
            Ok(Ok(events)) => {
                let (registry, files): (Vec<PathBuf>, Vec<PathBuf>) = events.into_iter().map(|e| e.path).partition(|p| p.starts_with(&sessions));
                if !registry.is_empty() {
                    kick_live(&app);
                }
                if !files.is_empty() {
                    let changed = {
                        let core = app.state::<Core>();
                        let mut idx = lock(&core.index);
                        let changed = idx.update_paths(&files);
                        if changed {
                            idx.save();
                        }
                        changed
                    };
                    if changed {
                        publish(&app);
                    }
                }
            }
            Ok(Err(e)) => log::warn!("watch error: {e:?}"),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if last_full.elapsed() >= FULL_RESCAN {
            let changed = {
                let core = app.state::<Core>();
                let mut idx = lock(&core.index);
                let changed = idx.rescan();
                if changed {
                    idx.save();
                }
                changed
            };
            if changed {
                publish(&app);
            }
            last_full = Instant::now();
        }
    }
}

/// `cc-resume --dump-snapshot <file>` writes what the window would show, for previewing the UI in
/// a plain browser (`npm run dev`) without launching anything.
fn dump(out: Option<&String>) {
    let Some(out) = out else {
        eprintln!("usage: cc-resume --dump-snapshot <file>");
        return;
    };
    let mut idx = Index::open(paths::projects_dir(), data_dir().join("index.json"));
    idx.rescan();
    idx.save();
    let (live, live_error) = match paths::claude_exe().map(|e| live::query(&e)) {
        Some(Ok(l)) => (l, None),
        Some(Err(e)) => (Vec::new(), Some(e)),
        None => (Vec::new(), Some("claude.exe wasn't found".to_string())),
    };
    let snap = Snapshot { now: now_ms(), projects: idx.projects(), live, live_error, retention_days: retention::cleanup_days(), scanning: false };
    if let Err(e) = std::fs::write(out, serde_json::to_vec_pretty(&snap).unwrap_or_default()) {
        eprintln!("couldn't write {out}: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Everything the app starts gets the user's environment fresh from Windows (see env.rs), so what
    // launched the app never reaches its chats. This is the safety net for the rare case where
    // Windows can't build that environment and the app's own is passed on instead. Started from
    // inside a Claude Code session (a tool call, a dev build), the app carries that session's
    // markers: a chat given them takes itself for a sub-session and stops saving its transcript.
    // Claude Code's shells also turn colour off and mark themselves as an agent, which would leave
    // every chat colourless; those go only in that case, since a user may set them on purpose.
    if std::env::var_os("CLAUDECODE").is_some() {
        for var in ["NO_COLOR", "AI_AGENT", "GIT_TERMINAL_PROMPT"] {
            std::env::remove_var(var);
        }
    }
    for marker in [
        "CLAUDECODE",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_PID",
        "CLAUDE_EFFORT",
    ] {
        std::env::remove_var(marker);
    }
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--dump-snapshot") {
        dump(args.get(i + 1));
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())?;
            }
            let dir = data_dir();
            let prefs_path = dir.join("prefs.json");
            let prefs = prefs::load(&prefs_path);
            let handle = app.handle().clone();
            apply_autostart(&handle, prefs.start_with_windows);
            app.manage(Core {
                index: Mutex::new(Index::open(paths::projects_dir(), dir.join("index.json"))),
                live: Mutex::default(),
                live_error: Mutex::default(),
                prefs: Mutex::new(prefs.clone()),
                prefs_path,
                scanning: AtomicBool::new(true),
                kick_live: Mutex::default(),
            });
            tray::build(&handle, &prefs)?;
            register_summon(&handle);
            start_background(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window sends it back to the tray; Quit lives in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![snapshot, ready, resume, new_chat, open_together, jump, get_prefs, save_prefs, keep_chats, hide, minimize])
        .run(tauri::generate_context!())
        .expect("error while running CC-Resume");
}
