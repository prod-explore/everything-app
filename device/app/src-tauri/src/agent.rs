//! Supervision of the Node agent: spawn, stdio protocol (docs/devices.md, "Tray <-> agent"), restart with backoff.

use crate::config::{self, Config};
use crate::log::Log;
use crate::paths::Paths;
use crate::{creds, tray};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const CRASH_WINDOW: Duration = Duration::from_secs(120);
const CRASH_LIMIT: usize = 5;
const STABLE_AFTER: Duration = Duration::from_secs(30);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// What the tray and the settings window show.
#[derive(Clone, Debug, Default)]
pub struct Shared {
    /// Agent states plus the local `error`.
    pub state: String,
    pub detail: Option<String>,
    pub activity: Option<String>,
    pub user_code: Option<String>,
    pub paused: bool,
}

enum Msg {
    Cmd(Value),
    Restart,
    Shutdown(Sender<()>),
    Out(u64, Value),
    Eof(u64),
}

pub struct Supervisor {
    tx: Sender<Msg>,
    shared: Arc<Mutex<Shared>>,
}

impl Supervisor {
    pub fn spawn(app: AppHandle, paths: Paths, log: Arc<Log>) -> Arc<Supervisor> {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Mutex::new(Shared {
            state: "connecting".into(),
            ..Shared::default()
        }));
        let sup = Arc::new(Supervisor {
            tx: tx.clone(),
            shared: shared.clone(),
        });
        std::thread::Builder::new()
            .name("agent-supervisor".into())
            .spawn(move || {
                Runner {
                    app,
                    paths,
                    log,
                    shared,
                    tx,
                    gen: 0,
                }
                .run(rx)
            })
            .expect("spawn supervisor thread");
        sup
    }

    pub fn snapshot(&self) -> Shared {
        lock(&self.shared).clone()
    }

    /// Sends one protocol line to the agent (dropped when it is not running; `start` re-syncs it).
    pub fn send(&self, line: Value) {
        if line["type"] == "pause" {
            lock(&self.shared).paused = true;
        } else if line["type"] == "resume" {
            lock(&self.shared).paused = false;
        }
        let _ = self.tx.send(Msg::Cmd(line));
    }

    /// Kills and restarts the agent process (used when the server changes, so the old token is never sent there).
    pub fn restart(&self) {
        let _ = self.tx.send(Msg::Restart);
    }

    /// `shutdown`, wait up to 5 s, then kill.
    pub fn shutdown(&self) {
        let (done_tx, done_rx) = mpsc::channel();
        if self.tx.send(Msg::Shutdown(done_tx)).is_ok() {
            let _ = done_rx.recv_timeout(SHUTDOWN_GRACE + Duration::from_secs(3));
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

struct Running {
    child: Child,
    stdin: ChildStdin,
    gen: u64,
    started: Instant,
}

struct Runner {
    app: AppHandle,
    paths: Paths,
    log: Arc<Log>,
    shared: Arc<Mutex<Shared>>,
    tx: Sender<Msg>,
    gen: u64,
}

impl Runner {
    fn run(mut self, rx: mpsc::Receiver<Msg>) {
        let mut running: Option<Running> = None;
        let mut crashes: VecDeque<Instant> = VecDeque::new();
        let mut backoff = BACKOFF_MIN;
        let mut retry_at: Option<Instant> = None;
        let mut gave_up = false;

        loop {
            let due = retry_at.is_none_or(|t| Instant::now() >= t);
            // Without a server the agent has nothing to do (it rejects such a config), so it is not started;
            // saving a server restarts the supervisor loop.
            let startable = config::load(&self.paths).is_ok_and(|c| c.server_set());
            if running.is_none() && !startable && !gave_up {
                let mut s = lock(&self.shared);
                if s.state != "unpaired" {
                    s.state = "unpaired".into();
                    s.detail = None;
                    drop(s);
                    self.changed();
                }
            }
            if running.is_none() && !gave_up && due && startable {
                retry_at = None;
                match self.start_child() {
                    Ok(r) => running = Some(r),
                    Err(e) => {
                        self.log.write("error", &format!("cannot start agent: {e}"));
                        gave_up = self.register_crash(&mut crashes, &mut backoff, &mut retry_at, None, &e);
                    }
                }
            }
            let wait = retry_at
                .map(|t| t.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_secs(3600));
            match rx.recv_timeout(wait) {
                Ok(Msg::Out(g, v)) => {
                    if running.as_ref().is_some_and(|r| r.gen == g) {
                        self.handle_out(v);
                    }
                }
                Ok(Msg::Eof(g)) => {
                    if running.as_ref().is_some_and(|r| r.gen == g) {
                        let mut r = running.take().expect("checked above");
                        let status = r.child.wait().map(|s| s.to_string()).unwrap_or_default();
                        let ran = r.started.elapsed();
                        self.log.write(
                            "warn",
                            &format!("agent exited ({status}) after {}s", ran.as_secs()),
                        );
                        let why = format!("agent exited ({status})");
                        gave_up =
                            self.register_crash(&mut crashes, &mut backoff, &mut retry_at, Some(ran), &why);
                    }
                }
                Ok(Msg::Cmd(v)) => {
                    if let Some(r) = running.as_mut() {
                        if let Err(e) = send_line(&mut r.stdin, &v) {
                            self.log.write("warn", &format!("cannot write to agent: {e}"));
                        }
                    }
                }
                Ok(Msg::Restart) => {
                    if let Some(mut r) = running.take() {
                        let _ = r.child.kill();
                        let _ = r.child.wait();
                    }
                    crashes.clear();
                    backoff = BACKOFF_MIN;
                    retry_at = None;
                    gave_up = false;
                    {
                        let mut s = lock(&self.shared);
                        s.state = "connecting".into();
                        s.detail = None;
                        s.activity = None;
                        s.user_code = None;
                    }
                    self.changed();
                }
                Ok(Msg::Shutdown(done)) => {
                    if let Some(r) = running.take() {
                        self.stop(r);
                    }
                    let _ = done.send(());
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    }

    /// Returns true when the supervisor gives up (too many crashes).
    fn register_crash(
        &self,
        crashes: &mut VecDeque<Instant>,
        backoff: &mut Duration,
        retry_at: &mut Option<Instant>,
        ran: Option<Duration>,
        why: &str,
    ) -> bool {
        let now = Instant::now();
        crashes.push_back(now);
        while crashes
            .front()
            .is_some_and(|t| now.duration_since(*t) > CRASH_WINDOW)
        {
            crashes.pop_front();
        }
        if ran.is_some_and(|r| r >= STABLE_AFTER) {
            *backoff = BACKOFF_MIN;
        }
        let give_up = crashes.len() >= CRASH_LIMIT;
        {
            let mut s = lock(&self.shared);
            if give_up {
                s.state = "error".into();
                s.detail = Some(format!(
                    "The agent crashed {CRASH_LIMIT} times in 2 minutes ({why}). See the log."
                ));
            } else {
                s.state = "offline".into();
                s.detail = Some(format!("{why}; restarting in {}s", backoff.as_secs()));
            }
            s.activity = None;
        }
        if !give_up {
            *retry_at = Some(now + *backoff);
            *backoff = (*backoff * 2).min(BACKOFF_MAX);
        }
        self.changed();
        give_up
    }

    fn stop(&self, mut r: Running) {
        let _ = send_line(&mut r.stdin, &json!({"type": "shutdown"}));
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            if matches!(r.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.log
            .write("warn", "agent did not exit within 5 s of shutdown; killing it");
        let _ = r.child.kill();
        let _ = r.child.wait();
    }

    fn changed(&self) {
        tray::refresh(&self.app);
    }

    fn start_child(&mut self) -> Result<Running, String> {
        let cfg = config::load(&self.paths);
        let token = match &cfg {
            Ok(c) => c.server_account().and_then(|acc| match creds::get(&acc) {
                Ok(t) => t,
                Err(e) => {
                    self.log.write("error", &format!("credential store: {e}"));
                    None
                }
            }),
            Err(e) => {
                self.log.write("error", e);
                None
            }
        };
        let node = node_path(&self.app);
        let main = agent_main(&self.app)?;
        let mut cmd = Command::new(&node);
        cmd.arg(&main)
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("cannot run {} {}: {e}", node.display(), main.display()))?;
        self.gen += 1;
        let gen = self.gen;
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        let start = json!({
            "type": "start",
            "configPath": self.paths.config_file(),
            "dataDir": self.paths.data_dir,
            "token": token,
        });
        send_line(&mut stdin, &start).map_err(|e| format!("cannot write start line: {e}"))?;
        if lock(&self.shared).paused {
            let _ = send_line(&mut stdin, &json!({"type": "pause"}));
        }

        let tx = self.tx.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let v = serde_json::from_str::<Value>(&line).unwrap_or_else(|_| {
                    json!({"type": "log", "level": "warn", "message": format!("non-protocol stdout: {line}")})
                });
                if tx.send(Msg::Out(gen, v)).is_err() {
                    return;
                }
            }
            let _ = tx.send(Msg::Eof(gen));
        });
        let log = self.log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log.write("stderr", &line);
            }
        });

        self.log
            .write("info", &format!("agent started (pid {})", child.id()));
        {
            let mut s = lock(&self.shared);
            s.state = "connecting".into();
            s.detail = None;
        }
        self.changed();
        Ok(Running {
            child,
            stdin,
            gen,
            started: Instant::now(),
        })
    }

    fn account(&self) -> Option<String> {
        config::load(&self.paths).ok().and_then(|c| c.server_account())
    }

    fn handle_out(&self, v: Value) {
        let kind = v["type"].as_str().unwrap_or("");
        let text = |k: &str| v[k].as_str().map(str::to_string);
        match kind {
            "status" => {
                let state = text("state").unwrap_or_default();
                if state == "revoked" {
                    self.forget_token();
                }
                let mut s = lock(&self.shared);
                s.paused = state == "paused";
                if state != "pairing" {
                    s.user_code = None;
                }
                s.state = state;
                s.detail = text("detail");
            }
            "pairing" => {
                let code = text("userCode").unwrap_or_default();
                lock(&self.shared).user_code = Some(code.clone());
                if let Some(url) = text("url") {
                    self.open_pairing_url(&url);
                }
                let _ = self
                    .app
                    .notification()
                    .builder()
                    .title("EverythingApp Device")
                    .body(format!("Approve the device in your browser. Code {code}"))
                    .show();
            }
            "paired" => {
                match (text("token"), self.account()) {
                    (Some(token), Some(acc)) => {
                        if let Err(e) = creds::set(&acc, &token) {
                            self.log.write("error", &format!("cannot store the token: {e}"));
                        }
                    }
                    _ => self
                        .log
                        .write("error", "paired without a token or without a server"),
                }
                self.enable_autostart_once();
            }
            "unpaired" => self.forget_token(),
            "activity" => {
                let tool = text("tool").unwrap_or_default();
                let summary = text("summary").unwrap_or_default();
                lock(&self.shared).activity = Some(format!("{tool}: {summary}"));
            }
            "log" => {
                let level = text("level").unwrap_or_else(|| "info".into());
                self.log.write(&level, &text("message").unwrap_or_default());
                return;
            }
            other => {
                self.log
                    .write("warn", &format!("unknown message from agent: {other}"));
                return;
            }
        }
        self.changed();
    }

    fn forget_token(&self) {
        if let Some(acc) = self.account() {
            if let Err(e) = creds::delete(&acc) {
                self.log.write("error", &format!("cannot delete the token: {e}"));
            }
        }
    }

    /// Only the configured server's own pairing page is opened, whatever the agent sends.
    fn open_pairing_url(&self, url: &str) {
        let same_host = url::Url::parse(url).ok().is_some_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && config::load(&self.paths)
                    .ok()
                    .and_then(|c| url::Url::parse(&c.server).ok())
                    .is_some_and(|s| s.host_str() == u.host_str() && s.port() == u.port())
        });
        if !same_host {
            self.log.write(
                "warn",
                "refusing to open a pairing URL that is not on the configured server",
            );
            return;
        }
        if let Err(e) = self.app.opener().open_url(url, None::<&str>) {
            self.log.write("error", &format!("cannot open the browser: {e}"));
        }
    }

    /// "Start at login" defaults to on after the first pairing; later the user's choice sticks.
    fn enable_autostart_once(&self) {
        let marker = self.paths.autostart_marker();
        if marker.exists() {
            return;
        }
        let _ = std::fs::write(&marker, b"1");
        if let Err(e) = self.app.autolaunch().enable() {
            self.log.write("warn", &format!("cannot enable autostart: {e}"));
        }
    }
}

fn send_line(stdin: &mut ChildStdin, v: &Value) -> std::io::Result<()> {
    let mut s = serde_json::to_string(v).map_err(std::io::Error::other)?;
    s.push('\n');
    stdin.write_all(s.as_bytes())?;
    stdin.flush()
}

/// The bundled runtime sits next to the app binary (Tauri strips the target triple from `externalBin`).
/// In development it falls back to `node` on the PATH; `EVVAPP_NODE` overrides both.
fn node_path(_app: &AppHandle) -> PathBuf {
    if let Some(p) = std::env::var_os("EVVAPP_NODE") {
        return p.into();
    }
    let name = if cfg!(windows) {
        "evvapp-node.exe"
    } else {
        "evvapp-node"
    };
    if let Some(p) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join(name)))
    {
        if p.exists() {
            return p;
        }
    }
    PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
}

fn agent_main(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("EVVAPP_AGENT_MAIN") {
        return Ok(p.into());
    }
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("agent/dist/main.mjs");
    if bundled.exists() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../agent/dist/main.mjs");
        if dev.exists() {
            return Ok(dev);
        }
    }
    Err(format!(
        "agent not found at {} (run scripts/stage-agent.mjs)",
        bundled.display()
    ))
}

/// Pushes the new status to the settings window (the tray is refreshed separately).
pub fn emit_status(app: &AppHandle) {
    let _ = app.emit("status-changed", crate::commands::status_dto(app));
}

/// Applies a validated config: writes it, tells the agent, refreshes the UI. A changed server restarts the agent.
pub fn apply_config(app: &AppHandle, new: Config) -> Result<(), String> {
    let paths = app.state::<Paths>();
    let sup = app.state::<Arc<Supervisor>>();
    let old = config::load(&paths).ok();
    config::save(&paths, &new)?;
    let server_changed = old.as_ref().map(|o| o.server_account()) != Some(new.server_account());
    if server_changed {
        sup.restart();
    } else {
        sup.send(json!({"type": "config-changed"}));
    }
    tray::refresh(app);
    let _ = app.emit("config-changed", &new);
    Ok(())
}
