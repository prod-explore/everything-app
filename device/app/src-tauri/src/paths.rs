//! Where the app keeps its files.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug)]
pub struct Paths {
    /// `config.json` lives here (the agent reads it too).
    pub config_dir: PathBuf,
    /// The agent's data dir (token file for headless use, browser profile, ...).
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> Result<Self, String> {
        let r = app.path();
        let p = Paths {
            // Plain paths: these are handed to the Node agent, which mishandles verbatim `\\?\` paths.
            config_dir: plain(r.app_config_dir().map_err(|e| e.to_string())?),
            data_dir: plain(r.app_data_dir().map_err(|e| e.to_string())?),
            log_dir: plain(r.app_log_dir().map_err(|e| e.to_string())?),
        };
        for d in [&p.config_dir, &p.data_dir, &p.log_dir] {
            std::fs::create_dir_all(d).map_err(|e| format!("cannot create {}: {e}", d.display()))?;
        }
        Ok(p)
    }

    pub fn config_file(&self) -> PathBuf {
        self.config_dir.join("config.json")
    }

    /// Marks that the first-pairing autostart default has been applied.
    pub fn autostart_marker(&self) -> PathBuf {
        self.data_dir.join(".autostart-initialised")
    }
}

fn plain(p: PathBuf) -> PathBuf {
    dunce::simplified(&p).to_path_buf()
}
