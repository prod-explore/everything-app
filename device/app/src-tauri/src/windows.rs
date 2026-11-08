//! The settings window, created on demand.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn open_settings(app: &AppHandle) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window("settings") {
        w.show()?;
        w.unminimize()?;
        return w.set_focus();
    }
    WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("EverythingApp Device")
        .inner_size(620.0, 720.0)
        .min_inner_size(520.0, 480.0)
        .center()
        .build()?;
    Ok(())
}
