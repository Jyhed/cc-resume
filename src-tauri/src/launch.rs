//! Opening chats in Windows Terminal. Each chat gets a window of its own, or splits the window used
//! last, or several chats are laid out together in one new window. Panes use the user's default
//! profile and run its shell, so the prompt stays open after claude exits.

use crate::paths;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, PartialEq)]
pub enum Mode {
    Window,
    Split,
}

impl Mode {
    pub fn parse(s: &str) -> Mode {
        if s == "split" { Mode::Split } else { Mode::Window }
    }
}

enum Shell {
    Cmd,
    PowerShell(&'static str),
}

struct Profile {
    name: Option<String>,
    shell: Shell,
}

/// One chat to put in a pane: the folder to start in and what follows `claude`.
pub struct Pane {
    pub dir: PathBuf,
    pub args: Vec<String>,
}

/// Runs `claude <claude_args>` in `dir`. Returns the exact command line used, for display.
pub fn open(dir: &Path, claude_args: &[&str], mode: Mode) -> Result<String, String> {
    run(wt_args(dir, claude_args, mode, &default_profile()))
}

/// Which way a region is cut: `V` lines its parts up left to right, `H` stacks them.
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
pub enum Dir {
    V,
    H,
}

/// Where each pane goes: a pane by its index, or a region cut into parts. `sizes` are the parts'
/// shares of the region, equal when left out.
#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(untagged)]
pub enum Node {
    Pane(usize),
    Split {
        dir: Dir,
        #[serde(default)]
        sizes: Option<Vec<f64>>,
        kids: Vec<Node>,
    },
}

impl Node {
    fn leaves(&self, out: &mut Vec<usize>) {
        match self {
            Node::Pane(i) => out.push(*i),
            Node::Split { kids, .. } => kids.iter().for_each(|k| k.leaves(out)),
        }
    }

    fn first(&self) -> usize {
        match self {
            Node::Pane(i) => *i,
            Node::Split { kids, .. } => kids[0].first(),
        }
    }

    /// Each part's share of its region, summing to 1; a missing, short or broken list means equal parts.
    fn shares(sizes: &Option<Vec<f64>>, n: usize) -> Vec<f64> {
        match sizes {
            Some(s) if s.len() == n && s.iter().all(|x| x.is_finite() && *x > 0.0) => {
                let total: f64 = s.iter().sum();
                s.iter().map(|x| x / total).collect()
            }
            _ => vec![1.0 / n as f64; n],
        }
    }

    /// The layout with only the panes `keep` gives a new index to. A region left with one part
    /// becomes that part, so a chat that can't open leaves no hole: its neighbours take the room.
    pub fn prune(&self, keep: &dyn Fn(usize) -> Option<usize>) -> Option<Node> {
        match self {
            Node::Pane(i) => keep(*i).map(Node::Pane),
            Node::Split { dir, sizes, kids } => {
                let shares = Node::shares(sizes, kids.len());
                let (kids, sizes): (Vec<Node>, Vec<f64>) = kids.iter().zip(shares).filter_map(|(k, s)| k.prune(keep).map(|k| (k, s))).unzip();
                match kids.len() {
                    0 => None,
                    1 => kids.into_iter().next(),
                    _ => Some(Node::Split { dir: *dir, sizes: Some(sizes), kids }),
                }
            }
        }
    }
}

/// Checks that a layout places panes 0..n, each exactly once, with no empty region.
pub fn check(layout: &Node, n: usize) -> Result<(), String> {
    fn empty(node: &Node) -> bool {
        match node {
            Node::Pane(_) => false,
            Node::Split { kids, .. } => kids.is_empty() || kids.iter().any(empty),
        }
    }
    let mut seen = Vec::new();
    layout.leaves(&mut seen);
    seen.sort_unstable();
    if empty(layout) || seen != (0..n).collect::<Vec<_>>() {
        return Err("the layout doesn't match the chats picked".into());
    }
    Ok(())
}

/// Opens every pane in one new window, placed by `layout`.
pub fn open_layout(panes: &[Pane], layout: &Node) -> Result<String, String> {
    if panes.is_empty() {
        return Err("nothing to open".into());
    }
    check(layout, panes.len())?;
    run(layout_args(panes, layout, &default_profile()))
}

fn run(args: Vec<String>) -> Result<String, String> {
    let wt = paths::wt_exe().ok_or("Windows Terminal (wt.exe) isn't installed")?;
    let mut cmd = Command::new(&wt);
    cmd.args(&args);
    // Windows Terminal hands new panes the environment of whoever asked for them, so chats get the
    // user's environment as it is now, not the one this app started with.
    crate::env::apply(&mut cmd);
    crate::live::no_window(&mut cmd);
    cmd.spawn().map_err(|e| format!("couldn't start Windows Terminal: {e}"))?;
    Ok(std::iter::once("wt".to_string()).chain(args.iter().map(|a| quote(a))).collect::<Vec<_>>().join(" "))
}

/// A chat gets a window of its own (`-w new`); a split lands in the window used last (`-w 0`),
/// next to whatever you were looking at.
fn wt_args(dir: &Path, claude_args: &[&str], mode: Mode, profile: &Profile) -> Vec<String> {
    let mut args: Vec<String> = match mode {
        Mode::Window => vec!["-w".into(), "new".into(), "nt".into()],
        Mode::Split => vec!["-w".into(), "0".into(), "sp".into(), "-V".into()],
    };
    args.extend(pane_args(dir, &claude_args.iter().map(|a| a.to_string()).collect::<Vec<_>>(), profile));
    args
}

/// One wt call that builds the layout. The window opens with the first pane; then each region is
/// cut part by part, every cut taking the rest of the region off the pane that holds it, so the
/// new pane's share is what remains after that part out of what remained before it. Once a region
/// is cut, each of its parts is cut the same way in turn. A new pane takes the focus, so a pane is
/// focused again by its creation index before it is cut: `move-focus` would read better, but WT
/// ignores it while the window is still being built.
fn layout_args(panes: &[Pane], layout: &Node, profile: &Profile) -> Vec<String> {
    struct Build<'a> {
        args: Vec<String>,
        made: usize,
        focus: usize,
        panes: &'a [Pane],
        profile: &'a Profile,
    }
    impl Build<'_> {
        fn region(&mut self, node: &Node, at: usize) {
            let Node::Split { dir, sizes, kids } = node else { return };
            let shares = Node::shares(sizes, kids.len());
            let mut starts = vec![at];
            let mut left = 1.0;
            for i in 1..kids.len() {
                let before = left;
                left -= shares[i - 1];
                if self.focus != starts[i - 1] {
                    self.args.extend([";".into(), "fp".into(), "-t".into(), starts[i - 1].to_string()]);
                }
                let flag = if *dir == Dir::V { "-V" } else { "-H" };
                self.args.extend([";".into(), "sp".into(), flag.into(), "-s".into(), format!("{:.3}", left / before)]);
                let p = &self.panes[kids[i].first()];
                self.args.extend(pane_args(&p.dir, &p.args, self.profile));
                self.focus = self.made;
                starts.push(self.made);
                self.made += 1;
            }
            for (kid, at) in kids.iter().zip(starts) {
                self.region(kid, at);
            }
        }
    }
    let first = &panes[layout.first()];
    let mut b = Build { args: vec!["-w".into(), "new".into(), "nt".into()], made: 1, focus: 0, panes, profile };
    b.args.extend(pane_args(&first.dir, &first.args, profile));
    b.region(layout, 0);
    b.args
}

fn pane_args(dir: &Path, claude_args: &[String], profile: &Profile) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if let Some(name) = &profile.name {
        args.extend(["-p".into(), escape(name)]);
    }
    args.extend(["-d".into(), escape(&dir.display().to_string())]);
    match profile.shell {
        Shell::Cmd => args.extend(["cmd.exe".into(), "/k".into()]),
        Shell::PowerShell(exe) => args.extend([exe.into(), "-NoExit".into(), "-Command".into()]),
    }
    args.push("claude".into());
    args.extend(claude_args.iter().map(|a| escape(a)));
    args
}

/// wt splits its own command line on `;`, even inside arguments, unless it is escaped.
fn escape(arg: &str) -> String {
    arg.replace(';', "\\;")
}

fn quote(arg: &str) -> String {
    if arg.contains(' ') { format!("\"{arg}\"") } else { arg.to_string() }
}

/// The profile a new tab would get by default, and which shell it runs. Profiles without a
/// Windows shell (WSL, Azure) can't host claude.exe, so those fall back to cmd in that profile.
fn default_profile() -> Profile {
    let fallback = Profile { name: None, shell: Shell::Cmd };
    let Some(settings) = paths::wt_settings().and_then(|p| std::fs::read_to_string(p).ok()) else { return fallback };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&strip_jsonc(&settings)) else { return fallback };
    let Some(default) = v.get("defaultProfile").and_then(|d| d.as_str()) else { return fallback };
    let list = v.pointer("/profiles/list").or_else(|| v.get("profiles")).and_then(|l| l.as_array());
    let Some(p) = list.and_then(|l| {
        l.iter().find(|p| {
            [p.get("guid"), p.get("name")].into_iter().flatten().filter_map(|x| x.as_str()).any(|x| x.eq_ignore_ascii_case(default))
        })
    }) else {
        return fallback;
    };
    let commandline = p.get("commandline").and_then(|c| c.as_str()).unwrap_or("").to_ascii_lowercase();
    let source = p.get("source").and_then(|s| s.as_str()).unwrap_or("");
    let shell = if commandline.contains("pwsh") || source == "Windows.Terminal.PowershellCore" {
        Shell::PowerShell("pwsh.exe")
    } else if commandline.contains("powershell") {
        Shell::PowerShell("powershell.exe")
    } else {
        Shell::Cmd
    };
    Profile { name: p.get("name").and_then(|n| n.as_str()).map(str::to_owned), shell }
}

/// Windows Terminal writes JSON with comments and trailing commas; serde_json accepts neither.
fn strip_jsonc(src: &str) -> String {
    let b = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(src.len());
    let (mut i, mut in_str) = (0, false);
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == b'\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 1;
            } else if c == b'"' {
                in_str = false;
            }
        } else if c == b'"' {
            in_str = true;
            out.push(b'"');
        } else if c == b'/' && b.get(i + 1) == Some(&b'/') {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        } else if c == b',' {
            let next = b[i + 1..].iter().find(|x| !x.is_ascii_whitespace());
            if !matches!(next, Some(b'}') | Some(b']')) {
                out.push(b',');
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_comments_and_trailing_commas() {
        let src = "{\n // c\n \"a\": \"x // not a comment\", /* b */ \"n\": [1, 2,],\n \"é\": \"ü\",\n}";
        let v: serde_json::Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        assert_eq!(v["a"], "x // not a comment");
        assert_eq!(v["n"][1], 2);
        assert_eq!(v["é"], "ü");
    }

    #[test]
    fn escapes_semicolons() {
        assert_eq!(escape("C:\\a;b"), "C:\\a\\;b");
    }

    #[test]
    fn builds_the_terminal_call() {
        let cmd = Profile { name: Some("Invite de commandes".into()), shell: Shell::Cmd };
        let args = wt_args(Path::new("C:\\My Projects\\app"), &["--resume", "abc", "--fork-session"], Mode::Window, &cmd);
        assert_eq!(args, ["-w", "new", "nt", "-p", "Invite de commandes", "-d", "C:\\My Projects\\app", "cmd.exe", "/k", "claude", "--resume", "abc", "--fork-session"]);
        let ps = Profile { name: None, shell: Shell::PowerShell("pwsh.exe") };
        let args = wt_args(Path::new("C:\\p"), &[], Mode::Split, &ps);
        assert_eq!(args, ["-w", "0", "sp", "-V", "-d", "C:\\p", "pwsh.exe", "-NoExit", "-Command", "claude"]);
    }

    fn node(json: &str) -> Node {
        serde_json::from_str(json).unwrap()
    }

    fn call(layout: &str, names: &[&str]) -> String {
        let p = Profile { name: None, shell: Shell::Cmd };
        let panes: Vec<Pane> = names.iter().map(|d| Pane { dir: PathBuf::from(d), args: vec!["--resume".into(), d.to_string()] }).collect();
        layout_args(&panes, &node(layout), &p).join(" ").replace(" cmd.exe /k claude --resume", "")
    }

    /// The three-chat grid is the call already proven in a real window; the general builder must
    /// still produce it exactly, and grids with more columns the way the old grid builder did.
    #[test]
    fn builds_the_grid_call() {
        assert_eq!(call(r#"{"dir":"V","kids":[{"dir":"H","kids":[0,1]},2]}"#, &["a", "b", "c"]), "-w new nt -d a a ; sp -V -s 0.500 -d c c ; fp -t 0 ; sp -H -s 0.500 -d b b");
        assert_eq!(
            call(r#"{"dir":"V","kids":[{"dir":"H","kids":[0,1]},{"dir":"H","kids":[2,3]},4]}"#, &["a", "b", "c", "d", "e"]),
            "-w new nt -d a a ; sp -V -s 0.667 -d c c ; sp -V -s 0.500 -d e e ; fp -t 0 ; sp -H -s 0.500 -d b b ; fp -t 1 ; sp -H -s 0.500 -d d d"
        );
    }

    #[test]
    fn builds_other_layouts() {
        assert_eq!(call("0", &["a"]), "-w new nt -d a a");
        assert_eq!(call(r#"{"dir":"V","sizes":[0.58,0.42],"kids":[0,{"dir":"H","kids":[1,2]}]}"#, &["a", "b", "c"]), "-w new nt -d a a ; sp -V -s 0.420 -d b b ; sp -H -s 0.500 -d c c");
        assert_eq!(call(r#"{"dir":"H","kids":[0,1,2]}"#, &["a", "b", "c"]), "-w new nt -d a a ; sp -H -s 0.667 -d b b ; sp -H -s 0.500 -d c c");
    }

    #[test]
    fn prunes_panes_that_cannot_open() {
        let grid = node(r#"{"dir":"V","kids":[{"dir":"H","kids":[0,1]},{"dir":"H","kids":[2,3]}]}"#);
        // Pane 1 is left out; the rest close up and are renumbered in order.
        let pruned = grid.prune(&|i| [Some(0), None, Some(1), Some(2)][i]).unwrap();
        assert_eq!(pruned, node(r#"{"dir":"V","sizes":[0.5,0.5],"kids":[0,{"dir":"H","sizes":[0.5,0.5],"kids":[1,2]}]}"#));
        assert_eq!(grid.prune(&|_| None), None);
    }

    #[test]
    fn rejects_layouts_that_miss_or_repeat_panes() {
        assert!(check(&node(r#"{"dir":"V","kids":[0,1]}"#), 2).is_ok());
        assert!(check(&node(r#"{"dir":"V","kids":[0,0]}"#), 2).is_err());
        assert!(check(&node(r#"{"dir":"V","kids":[0,2]}"#), 2).is_err());
        assert!(check(&node(r#"{"dir":"V","kids":[0,{"dir":"H","kids":[]},1]}"#), 2).is_err());
    }

    /// Builds real layouts in new windows, on demand only, with echo standing in for claude:
    /// cargo test --lib -- --ignored terminal_builds_layouts
    #[test]
    #[ignore]
    fn terminal_builds_layouts() {
        let layouts = [
            r#"{"dir":"V","kids":[{"dir":"H","kids":[0,1]},{"dir":"H","kids":[2,3]},4]}"#,
            r#"{"dir":"V","sizes":[0.58,0.42],"kids":[0,{"dir":"H","kids":[1,2,3,4]}]}"#,
        ];
        for layout in layouts {
            let panes: Vec<Pane> = ["a", "b", "c", "d", "e"].iter().map(|n| {
                let dir = std::env::temp_dir().join(format!("cc probe {n}"));
                std::fs::create_dir_all(&dir).unwrap();
                Pane { dir, args: vec![format!("pane-{n}")] }
            }).collect();
            let args: Vec<String> = layout_args(&panes, &node(layout), &default_profile()).into_iter().map(|a| if a == "claude" { "echo".into() } else { a }).collect();
            assert!(Command::new(paths::wt_exe().unwrap()).args(&args).status().unwrap().success());
        }
    }

    /// Opens a real pane, on demand only, and reads back the environment it got: variables set in
    /// this process alone (as a Claude Code shell sets NO_COLOR) must not arrive. The pane closes
    /// itself: cargo test --lib -- --ignored terminal_gets_a_fresh_environment
    #[test]
    #[ignore]
    fn terminal_gets_a_fresh_environment() {
        std::env::set_var("NO_COLOR", "1");
        std::env::set_var("CC_RESUME_ONLY_IN_THIS_PROCESS", "1");
        let out = std::env::temp_dir().join("cc-resume-pane-env.txt");
        let _ = std::fs::remove_file(&out);
        run(vec!["-w".into(), "new".into(), "nt".into(), "cmd.exe".into(), "/c".into(), "set".into(), ">".into(), out.display().to_string()]).unwrap();
        let text = (0..100).find_map(|_| {
            std::thread::sleep(std::time::Duration::from_millis(100));
            std::fs::read_to_string(&out).ok().filter(|t| t.contains("PATH="))
        });
        let text = text.expect("the pane never wrote its environment");
        let names: Vec<String> = text.lines().filter_map(|l| l.split('=').next()).map(|n| n.to_ascii_uppercase()).collect();
        assert!(!names.iter().any(|n| n == "NO_COLOR" || n == "CC_RESUME_ONLY_IN_THIS_PROCESS"), "the pane inherited this process's variables");
        assert!(names.iter().any(|n| n == "WT_SESSION"), "not a Windows Terminal pane");
    }

    /// Sends the real call to Windows Terminal, on demand only, in its own probe window and with
    /// echo standing in for claude; the folder name carries a space and a semicolon on purpose:
    /// cargo test --lib -- --ignored terminal_accepts_the_call
    #[test]
    #[ignore]
    fn terminal_accepts_the_call() {
        let dir = std::env::temp_dir().join("cc resume probe;dir");
        std::fs::create_dir_all(&dir).unwrap();
        let mut args = wt_args(&dir, &["--resume", "probe;id", "--fork-session"], Mode::Window, &default_profile());
        args[1] = "cc-resume-probe".into();
        args.splice(3..3, ["--title".to_string(), "cc-resume-probe".to_string()]);
        let at = args.iter().position(|a| a == "claude").unwrap();
        args[at] = "echo".into();
        let status = Command::new(paths::wt_exe().unwrap()).args(&args).status().unwrap();
        assert!(status.success());
    }
}
