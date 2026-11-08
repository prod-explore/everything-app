//! The tray icon, its tooltip and its menu.

use crate::agent::{self, Shared, Supervisor};
use crate::paths::Paths;
use crate::{config, windows};
use serde_json::json;
use std::sync::{Arc, Mutex};
use tauri::image::Image;
use tauri::menu::{CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt;

const TRAY_ID: &str = "main";

// macOS draws template images (black mark, the system tints it); elsewhere the white mark is used.
#[cfg(target_os = "macos")]
const ICON: &[u8] = include_bytes!("../../icons/tray/tray-template-32@2x.png");
#[cfg(target_os = "macos")]
const ICON_DIM: &[u8] = include_bytes!("../../icons/tray/tray-template-dim-32@2x.png");
#[cfg(not(target_os = "macos"))]
const ICON: &[u8] = include_bytes!("../../icons/tray/tray-32@2x.png");
#[cfg(not(target_os = "macos"))]
const ICON_DIM: &[u8] = include_bytes!("../../icons/tray/tray-dim-32@2x.png");

/// Everything the menu shows; the menu is rebuilt only when this changes (an open menu does not flicker).
#[derive(Clone, PartialEq, Debug)]
struct Model {
    status: String,
    activity: String,
    show_pair: bool,
    can_pause: bool,
    paused: bool,
    terminal: bool,
    files: bool,
    browser: bool,
    autostart: bool,
}

#[derive(Default)]
pub struct TrayState {
    last: Mutex<Option<Model>>,
}

pub fn label(s: &Shared, server_set: bool, device_name: &str) -> String {
    let detail = |base: &str| match &s.detail {
        Some(d) if !d.is_empty() => format!("{base}: {d}"),
        _ => base.to_string(),
    };
    if !server_set {
        return "Set the server URL in Settings".into();
    }
    match s.state.as_str() {
        "online" => format!("Online \u{2014} {device_name}"),
        "connecting" => "Connecting\u{2026}".into(),
        "offline" => detail("Offline"),
        "paused" => "Paused".into(),
        "unpaired" => "Not paired".into(),
        "pairing" => match &s.user_code {
            Some(c) => format!("Pairing \u{2014} code {c}"),
            None => "Pairing\u{2026}".into(),
        },
        "revoked" => "Revoked in EverythingApp \u{2014} pair again".into(),
        "replaced" => "Replaced by another connection of this device".into(),
        "error" => detail("Error"),
        other => other.to_string(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if flat.chars().count() <= max {
        flat
    } else {
        let head: String = flat.chars().take(max.saturating_sub(1)).collect();
        format!("{head}\u{2026}")
    }
}

fn model(app: &AppHandle, shared: &Shared) -> Model {
    let cfg = config::load(&app.state::<Paths>()).unwrap_or_default();
    let server_set = cfg.server_set();
    let paired_states = ["connecting", "online", "offline", "paused"];
    Model {
        status: label(shared, server_set, &cfg.device_name),
        activity: match &shared.activity {
            Some(a) => format!("Last: {}", truncate(a, 48)),
            None => "No activity yet".into(),
        },
        show_pair: server_set && matches!(shared.state.as_str(), "unpaired" | "revoked"),
        can_pause: server_set && paired_states.contains(&shared.state.as_str()),
        paused: shared.state == "paused",
        terminal: cfg.shell.enabled,
        files: cfg.files.enabled,
        browser: cfg.browser.enabled,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
    }
}

fn build_menu(app: &AppHandle, m: &Model) -> tauri::Result<Menu<tauri::Wry>> {
    let mut b = MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::with_id("status", &m.status)
                .enabled(false)
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("activity", &m.activity)
                .enabled(false)
                .build(app)?,
        )
        .separator();
    if m.show_pair {
        b = b.item(&MenuItemBuilder::with_id("pair", "Pair device\u{2026}").build(app)?);
    }
    b = b
        .item(
            &MenuItemBuilder::with_id("pause", if m.paused { "Resume" } else { "Pause" })
                .enabled(m.can_pause)
                .build(app)?,
        )
        .separator()
        .item(
            &CheckMenuItemBuilder::with_id("cap-terminal", "Terminal")
                .checked(m.terminal)
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("cap-files", "Files")
                .checked(m.files)
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("cap-browser", "Browser")
                .checked(m.browser)
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("settings", "Settings\u{2026}").build(app)?)
        .item(&MenuItemBuilder::with_id("open", "Open EverythingApp").build(app)?)
        .item(
            &CheckMenuItemBuilder::with_id("autostart", "Start at login")
                .checked(m.autostart)
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "Quit").build(app)?);
    b.build()
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let shared = app.state::<Arc<Supervisor>>().snapshot();
    let m = model(app, &shared);
    let menu = build_menu(app, &m)?;
    *app.state::<TrayState>()
        .last
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(m);
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON_DIM)?)
        .tooltip("EverythingApp Device")
        .menu(&menu)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    builder.build(app)?;
    refresh(app);
    Ok(())
}

/// Re-reads state and config and updates icon, tooltip and (when it changed) the menu; also pushes to the settings window.
pub fn refresh(app: &AppHandle) {
    let Some(sup) = app.try_state::<Arc<Supervisor>>() else {
        return;
    };
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let shared = sup.snapshot();
    let m = model(app, &shared);

    let bright = matches!(shared.state.as_str(), "online" | "connecting" | "pairing");
    if let Ok(img) = Image::from_bytes(if bright { ICON } else { ICON_DIM }) {
        let _ = tray.set_icon(Some(img));
        #[cfg(target_os = "macos")]
        let _ = tray.set_icon_as_template(true);
    }
    let _ = tray.set_tooltip(Some(format!("EverythingApp Device \u{2014} {}", m.status)));

    let state = app.state::<TrayState>();
    let mut last = state.last.lock().unwrap_or_else(|e| e.into_inner());
    if last.as_ref() != Some(&m) {
        if let Ok(menu) = build_menu(app, &m) {
            let _ = tray.set_menu(Some(menu));
            *last = Some(m);
        }
    }
    drop(last);
    agent::emit_status(app);
}

fn toggle_capability(app: &AppHandle, which: &str) {
    let paths = app.state::<Paths>();
    let Ok(mut cfg) = config::load(&paths) else {
        let _ = windows::open_settings(app);
        return;
    };
    match which {
        "cap-terminal" => cfg.shell.enabled = !cfg.shell.enabled,
        "cap-files" => cfg.files.enabled = !cfg.files.enabled,
        _ => cfg.browser.enabled = !cfg.browser.enabled,
    }
    if agent::apply_config(app, cfg).is_err() {
        refresh(app);
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    let sup = app.state::<Arc<Supervisor>>();
    match id {
        "pair" => sup.send(json!({"type": "pair"})),
        "pause" => {
            let paused = sup.snapshot().paused;
            sup.send(json!({"type": if paused { "resume" } else { "pause" }}));
        }
        "cap-terminal" | "cap-files" | "cap-browser" => toggle_capability(app, id),
        "settings" => {
            let _ = windows::open_settings(app);
        }
        "open" => {
            if let Ok(cfg) = config::load(&app.state::<Paths>()) {
                if cfg.server_set() {
                    let _ = app.opener().open_url(&cfg.server, None::<&str>);
                    return;
                }
            }
            let _ = windows::open_settings(app);
        }
        "autostart" => {
            let manager = app.autolaunch();
            let _ = if manager.is_enabled().unwrap_or(false) {
                manager.disable()
            } else {
                manager.enable()
            };
            refresh(app);
        }
        "quit" => {
            let app = app.clone();
            std::thread::spawn(move || {
                app.state::<Arc<Supervisor>>().shutdown();
                app.exit(0);
            });
        }
        _ => {}
    }
}
