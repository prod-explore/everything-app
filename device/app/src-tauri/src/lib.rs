//! EverythingApp Device: the tray shell around the Node agent (ADR 0021).

mod agent;
mod commands;
mod config;
mod creds;
mod log;
mod paths;
mod tray;
mod windows;

use std::sync::Arc;
use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::MacosLauncher;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = windows::open_settings(app);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::get_config_json,
            commands::save_config,
            commands::get_status,
            commands::pair,
            commands::unpair,
            commands::pause,
            commands::resume,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            let paths = paths::Paths::resolve(&handle)?;
            config::ensure_default(&paths)?;
            let log = Arc::new(log::Log::new(paths.log_dir.join("agent.log")));
            app.manage(paths.clone());
            app.manage(tray::TrayState::default());
            let sup = agent::Supervisor::spawn(handle.clone(), paths.clone(), log);
            app.manage(sup);
            tray::build(&handle)?;

            // First run: nothing to connect to yet.
            if !config::load(&paths).map(|c| c.server_set()).unwrap_or(true) {
                windows::open_settings(&handle)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the tray app");

    app.run(|app, event| match event {
        // Closing the settings window must not end a tray app; only Quit (explicit exit code) does.
        RunEvent::ExitRequested { code, api, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            if let Some(sup) = app.try_state::<Arc<agent::Supervisor>>() {
                sup.shutdown();
            }
        }
        _ => {}
    });
}
