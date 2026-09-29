//! Index of every Claude Code transcript on this machine: the folder each chat was started in, its
//! title, branch, times and size. Transcripts only ever grow, so each file is read from where the
//! last pass stopped, and the result is cached on disk: a restart reads only what was written since.
//!
//! The transcript format is internal to Claude Code and changes between versions, so every field
//! is optional and a line that doesn't parse is skipped rather than trusted.

use memchr::memmem;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const CACHE_VERSION: u32 = 1;
const CHUNK: usize = 4 << 20;

#[derive(Serialize, Deserialize, Clone, Default)]
struct ChatMeta {
    cwd: Option<String>,
    branch: Option<String>,
    ai_title: Option<String>,
    custom_title: Option<String>,
    first: Option<String>,
    last: Option<String>,
    turns: u32,
    entry: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct FileEntry {
    size: u64,
    mtime: u64,
    offset: u64,
    meta: ChatMeta,
}

#[derive(Serialize, Deserialize, Default)]
struct CacheFile {
    version: u32,
    files: HashMap<String, FileEntry>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub title: Option<String>,
    pub named: bool,
    pub branch: Option<String>,
    pub first: String,
    pub last: String,
    pub turns: u32,
    pub entry: Option<String>,
    pub kb: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub key: String,
    pub name: String,
    pub path: String,
    pub last: String,
    pub chats: Vec<Chat>,
}

pub struct Index {
    root: PathBuf,
    cache_path: PathBuf,
    files: HashMap<PathBuf, FileEntry>,
    dirty: bool,
}

impl Index {
    pub fn open(root: PathBuf, cache_path: PathBuf) -> Self {
        let files = fs::read(&cache_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<CacheFile>(&b).ok())
            .filter(|c| c.version == CACHE_VERSION)
            .map(|c| c.files.into_iter().map(|(k, v)| (PathBuf::from(k), v)).collect())
            .unwrap_or_default();
        Index { root, cache_path, files, dirty: false }
    }

    /// Walks every project folder. Returns true when anything changed.
    pub fn rescan(&mut self) -> bool {
        let mut seen = Vec::new();
        if let Ok(dirs) = fs::read_dir(&self.root) {
            for dir in dirs.flatten().filter(|d| d.path().is_dir()) {
                if let Ok(files) = fs::read_dir(dir.path()) {
                    seen.extend(files.flatten().map(|f| f.path()).filter(|p| is_transcript_name(p)));
                }
            }
        }
        let mut changed = false;
        for path in &seen {
            changed |= self.update_file(path);
        }
        let before = self.files.len();
        self.files.retain(|p, _| seen.contains(p));
        changed |= self.files.len() != before;
        self.dirty |= changed;
        changed
    }

    /// Re-reads just the files a watcher reported. Returns true when anything changed.
    pub fn update_paths(&mut self, paths: &[PathBuf]) -> bool {
        let mut changed = false;
        let transcripts: Vec<&PathBuf> = paths.iter().filter(|p| self.is_transcript(p)).collect();
        for path in transcripts {
            if path.is_file() {
                changed |= self.update_file(path);
            } else if self.files.remove(path).is_some() {
                changed = true;
            }
        }
        self.dirty |= changed;
        changed
    }

    pub fn is_transcript(&self, path: &Path) -> bool {
        is_transcript_name(path) && path.parent().and_then(Path::parent) == Some(self.root.as_path())
    }

    pub fn save(&mut self) {
        if !self.dirty {
            return;
        }
        let cache = CacheFile {
            version: CACHE_VERSION,
            files: self.files.iter().map(|(k, v)| (k.to_string_lossy().into_owned(), v.clone())).collect(),
        };
        if let Some(dir) = self.cache_path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        // Write beside the cache, then swap, so a crash mid-write never leaves a torn cache.
        let tmp = self.cache_path.with_extension("tmp");
        if let Ok(bytes) = serde_json::to_vec(&cache) {
            if fs::write(&tmp, bytes).is_ok() && fs::rename(&tmp, &self.cache_path).is_ok() {
                self.dirty = false;
            }
        }
    }

    pub fn projects(&self) -> Vec<Project> {
        let mut by_key: HashMap<String, Vec<(Chat, Option<String>)>> = HashMap::new();
        for (path, entry) in &self.files {
            let m = &entry.meta;
            let (Some(first), Some(last)) = (m.first.clone(), m.last.clone()) else { continue };
            let key = path.parent().and_then(Path::file_name).map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            let chat = Chat {
                id: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                title: m.custom_title.clone().or_else(|| m.ai_title.clone()),
                named: m.custom_title.is_some(),
                branch: m.branch.clone(),
                first,
                last,
                turns: m.turns,
                entry: m.entry.clone(),
                kb: entry.size / 1024,
            };
            by_key.entry(key).or_default().push((chat, m.cwd.clone()));
        }
        let mut projects: Vec<Project> = by_key
            .into_iter()
            .map(|(key, mut chats)| {
                chats.sort_by(|a, b| b.0.last.cmp(&a.0.last));
                let path = chats.iter().find_map(|(_, cwd)| cwd.clone()).unwrap_or_else(|| key.clone());
                Project {
                    name: display_name(&path),
                    last: chats[0].0.last.clone(),
                    chats: chats.into_iter().map(|(c, _)| c).collect(),
                    key,
                    path,
                }
            })
            .collect();
        projects.sort_by(|a, b| b.last.cmp(&a.last));
        projects
    }

    /// The folder a chat was started in, plus its title, for launching or finding it.
    pub fn locate(&self, session_id: &str) -> Option<(String, Option<String>)> {
        self.files.iter().find_map(|(path, e)| {
            (path.file_stem()?.to_str()? == session_id).then(|| {
                let dir = e.meta.cwd.clone().unwrap_or_default();
                (dir, e.meta.custom_title.clone().or_else(|| e.meta.ai_title.clone()))
            })
        })
    }

    pub fn project_path(&self, key: &str) -> Option<String> {
        self.projects().into_iter().find(|p| p.key == key).map(|p| p.path)
    }

    fn update_file(&mut self, path: &Path) -> bool {
        let Ok(md) = fs::metadata(path) else { return false };
        let size = md.len();
        let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        let mut entry = match self.files.get(path) {
            Some(e) if e.size == size && e.mtime == mtime => return false,
            // A file that shrank was rewritten, so what was read before no longer describes it.
            Some(e) if size >= e.offset => e.clone(),
            _ => FileEntry { size: 0, mtime: 0, offset: 0, meta: ChatMeta::default() },
        };
        match read_from(path, entry.offset, &mut entry.meta) {
            Ok(offset) => {
                entry.offset = offset;
                entry.size = size;
                entry.mtime = mtime;
                self.files.insert(path.to_path_buf(), entry);
                true
            }
            Err(e) => {
                log::warn!("could not read {}: {e}", path.display());
                false
            }
        }
    }
}

fn is_transcript_name(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "jsonl")
}

/// Reads complete lines from `offset` on. A trailing line without its newline is still being
/// written, so it is left for the next pass.
fn read_from(path: &Path, offset: u64, meta: &mut ChatMeta) -> std::io::Result<u64> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut done = offset;
    let mut buf: Vec<u8> = Vec::with_capacity(CHUNK);
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let n = file.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(end) = memchr::memrchr(b'\n', &buf) {
            for line in buf[..end].split(|&b| b == b'\n') {
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                if !line.is_empty() {
                    scan_line(line, meta);
                }
            }
            done += end as u64 + 1;
            buf.drain(..=end);
        }
    }
    Ok(done)
}

fn scan_line(line: &[u8], m: &mut ChatMeta) {
    let head = &line[..line.len().min(2048)];
    if memmem::find(head, b"\"type\":\"ai-title\"").is_some() {
        if let Some(t) = string_field(line, &["aiTitle", "title"]) {
            m.ai_title = Some(t);
        }
        return;
    }
    if memmem::find(head, b"\"type\":\"custom-title\"").is_some() {
        if let Some(t) = string_field(line, &["customTitle", "title"]) {
            m.custom_title = Some(t);
        }
        return;
    }
    // The launch folder is the first cwd: later records follow any cd made during the chat.
    if m.cwd.is_none() {
        m.cwd = pick(head, b"cwd");
    }
    if let Some(b) = pick(head, b"gitBranch").filter(|b| !b.is_empty() && b != "HEAD") {
        m.branch = Some(b);
    }
    if let Some(e) = pick(head, b"entrypoint") {
        m.entry = Some(e);
    }
    let tail = &line[line.len().saturating_sub(512)..];
    if let Some(ts) = pick(tail, b"timestamp").or_else(|| pick(head, b"timestamp")).filter(|t| t.starts_with(|c: char| c.is_ascii_digit())) {
        if m.first.is_none() {
            m.first = Some(ts.clone());
        }
        m.last = Some(ts);
    }
    let is_prompt = memmem::find(head, b"\"type\":\"user\"").is_some()
        && memmem::find(head, b"\"isMeta\":true").is_none()
        && memmem::find(line, b"\"tool_result\"").is_none();
    if is_prompt {
        m.turns += 1;
    }
}

/// Last `"key":"value"` in the bytes, unescaped. Cheap enough to run on every line of every file.
fn pick(hay: &[u8], key: &[u8]) -> Option<String> {
    let mut pat = Vec::with_capacity(key.len() + 4);
    pat.push(b'"');
    pat.extend_from_slice(key);
    pat.extend_from_slice(b"\":\"");
    let start = memmem::rfind(hay, &pat)? + pat.len();
    let mut i = start;
    while i < hay.len() {
        match hay[i] {
            b'\\' => i += 2,
            b'"' => break,
            _ => i += 1,
        }
    }
    if i >= hay.len() {
        return None;
    }
    serde_json::from_slice::<String>(&hay[start - 1..=i]).ok()
}

fn string_field(line: &[u8], keys: &[&str]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(line).ok()?;
    keys.iter().find_map(|k| v.get(*k)?.as_str().map(str::to_owned)).filter(|s| !s.trim().is_empty())
}

/// Short names read badly on their own ("v3", "refs"), so they keep their parent folder.
fn display_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    if let Some(home) = dirs::home_dir() {
        if home.to_string_lossy().trim_end_matches(['\\', '/']).eq_ignore_ascii_case(trimmed) {
            return "~ home".into();
        }
    }
    let mut parts = trimmed.rsplit(['\\', '/']);
    let base = parts.next().unwrap_or(trimmed);
    match parts.next() {
        Some(parent) if base.chars().count() < 7 && !parent.is_empty() && !parent.ends_with(':') => format!("{parent}/{base}"),
        _ if base.is_empty() => path.to_string(),
        _ => base.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_last_escaped_value() {
        let line = br#"{"cwd":"C:\\Users\\a","x":{"cwd":"C:\\Users\\b \"q\""}}"#;
        assert_eq!(pick(line, b"cwd").as_deref(), Some("C:\\Users\\b \"q\""));
        assert_eq!(pick(line, b"nope"), None);
    }

    #[test]
    fn scans_a_prompt_line() {
        let mut m = ChatMeta::default();
        scan_line(br#"{"cwd":"C:\\p","gitBranch":"main","type":"user","message":{"content":"hi"},"timestamp":"2026-09-26T10:00:00.000Z"}"#, &mut m);
        scan_line(br#"{"cwd":"C:\\other","type":"user","message":{"content":[{"type":"tool_result"}]},"timestamp":"2026-09-26T10:05:00.000Z"}"#, &mut m);
        scan_line(br#"{"type":"ai-title","aiTitle":"Fix login"}"#, &mut m);
        assert_eq!(m.cwd.as_deref(), Some("C:\\p"));
        assert_eq!(m.branch.as_deref(), Some("main"));
        assert_eq!(m.turns, 1);
        assert_eq!(m.first.as_deref(), Some("2026-09-26T10:00:00.000Z"));
        assert_eq!(m.last.as_deref(), Some("2026-09-26T10:05:00.000Z"));
        assert_eq!(m.ai_title.as_deref(), Some("Fix login"));
    }

    #[test]
    fn names_projects() {
        assert_eq!(display_name("C:\\Users\\x\\Desktop\\sidequest\\YACG"), "sidequest/YACG");
        assert_eq!(display_name("C:\\Projects\\orangecrush-game\\"), "orangecrush-game");
        assert_eq!(display_name("C:\\"), "C:");
    }
}
