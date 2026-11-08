//! Tauri commands used by the settings window.

use crate::agent::{self, Supervisor};
use crate::config::{self, Config};
use crate::paths::Paths;
use crate::{creds, tray};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusDto {
    state: String,
    label: String,
    detail: Option<String>,
    activity: Option<String>,
    user_code: Option<String>,
    paused: bool,
    server_set: bool,
    can_pair: bool,
    autostart: bool,
    version: String,
    config_path: String,
    log_dir: String,
}

pub fn status_dto(app: &AppHandle) -> StatusDto {
    let paths = app.state::<Paths>();
    let shared = app.state::<Arc<Supervisor>>().snapshot();
    let cfg = config::load(&paths).unwrap_or_default();
    let server_set = cfg.server_set();
    StatusDto {
        label: tray::label(&shared, server_set, &cfg.device_name),
        can_pair: server_set && matches!(shared.state.as_str(), "unpaired" | "revoked"),
        state: shared.state,
        detail: shared.detail,
        activity: shared.activity,
        user_code: shared.user_code,
        paused: shared.paused,
        server_set,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        version: app.package_info().version.to_string(),
        config_path: paths.config_file().display().to_string(),
        log_dir: paths.log_dir.display().to_string(),
    }
}

#[tauri::command]
pub fn get_config(paths: State<'_, Paths>) -> Result<Config, String> {
    config::load(&paths)
}

/// The file as it is on disk (it may be invalid; the JSON tab lets the user repair it).
#[tauri::command]
pub fn get_config_json(paths: State<'_, Paths>) -> Result<String, String> {
    std::fs::read_to_string(paths.config_file()).map_err(|e| e.to_string())
}

/// Validates with serde, writes atomically, tells the agent. Takes the form's object or the JSON tab's parsed text.
#[tauri::command]
pub fn save_config(app: AppHandle, config: Value) -> Result<Config, String> {
    let cfg = config::parse(config)?;
    agent::apply_config(&app, cfg.clone())?;
    Ok(cfg)
}

#[tauri::command]
pub fn get_status(app: AppHandle) -> StatusDto {
    status_dto(&app)
}

#[tauri::command]
pub fn pair(app: AppHandle, sup: State<'_, Arc<Supervisor>>, paths: State<'_, Paths>) -> Result<(), String> {
    let cfg = config::load(&paths)?;
    if !cfg.server_set() {
        return Err("Set the server URL first".into());
    }
    sup.send(json!({"type": "pair"}));
    tray::refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn unpair(
    app: AppHandle,
    sup: State<'_, Arc<Supervisor>>,
    paths: State<'_, Paths>,
) -> Result<(), String> {
    if let Some(acc) = config::load(&paths).ok().and_then(|c| c.server_account()) {
        creds::delete(&acc)?;
    }
    sup.send(json!({"type": "unpair"}));
    tray::refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn pause(app: AppHandle, sup: State<'_, Arc<Supervisor>>) {
    sup.send(json!({"type": "pause"}));
    tray::refresh(&app);
}

#[tauri::command]
pub fn resume(app: AppHandle, sup: State<'_, Arc<Supervisor>>) {
    sup.send(json!({"type": "resume"}));
    tray::refresh(&app);
}
