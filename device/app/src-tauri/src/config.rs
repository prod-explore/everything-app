//! `config.json`: the device's capabilities and the server it talks to (docs/devices.md, "Device config").

use crate::paths::Paths;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use url::Url;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub server: String,
    pub device_name: String,
    pub shell: Shell,
    pub files: Files,
    pub browser: Browser,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Shell {
    pub enabled: bool,
    pub path: Option<String>,
    pub cwd: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Files {
    pub enabled: bool,
    pub roots: Vec<String>,
    pub write: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Profile,
    Dedicated,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Product {
    Brave,
    Chrome,
    Edge,
    Chromium,
    Custom,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Browser {
    pub enabled: bool,
    pub mode: Mode,
    pub product: Product,
    pub executable: Option<String>,
    pub user_data_dir: Option<String>,
    pub profile_directory: String,
    pub allow_private_network: bool,
}

impl Default for Shell {
    fn default() -> Self {
        Shell {
            enabled: true,
            path: None,
            cwd: None,
        }
    }
}

impl Default for Browser {
    fn default() -> Self {
        Browser {
            enabled: false,
            mode: Mode::Profile,
            product: Product::Brave,
            executable: None,
            user_data_dir: None,
            profile_directory: "Default".into(),
            allow_private_network: true,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        let host = gethostname::gethostname().to_string_lossy().trim().to_string();
        let name: String = if host.is_empty() {
            "Device".into()
        } else {
            host.chars().take(40).collect()
        };
        Config {
            server: String::new(),
            device_name: name,
            shell: Shell::default(),
            files: Files::default(),
            browser: Browser::default(),
        }
    }
}

fn clean(o: &mut Option<String>) {
    *o = o.take().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
}

impl Config {
    /// Trims, normalises empty strings to `null` and checks the invariants the serde types cannot.
    pub fn validate(&mut self) -> Result<(), String> {
        self.server = self.server.trim().trim_end_matches('/').to_string();
        if !self.server.is_empty() {
            let url = Url::parse(&self.server).map_err(|e| format!("server: not a valid URL ({e})"))?;
            if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                return Err("server: must be an http(s) URL with a host".into());
            }
        }
        self.device_name = self.device_name.trim().to_string();
        let n = self.device_name.chars().count();
        if !(1..=40).contains(&n) {
            return Err("deviceName: 1 to 40 characters".into());
        }
        clean(&mut self.shell.path);
        clean(&mut self.shell.cwd);
        clean(&mut self.browser.executable);
        clean(&mut self.browser.user_data_dir);
        self.browser.profile_directory = self.browser.profile_directory.trim().to_string();
        if self.browser.profile_directory.is_empty() {
            self.browser.profile_directory = "Default".into();
        }
        let mut roots: Vec<String> = Vec::new();
        for r in self
            .files
            .roots
            .iter()
            .map(|r| r.trim())
            .filter(|r| !r.is_empty())
        {
            if !roots.iter().any(|x| x == r) {
                roots.push(r.to_string());
            }
        }
        self.files.roots = roots;
        if self.browser.product == Product::Custom
            && self.browser.executable.is_none()
            && self.browser.enabled
        {
            return Err("browser: product \"custom\" needs an executable".into());
        }
        Ok(())
    }

    /// `host[:port]` of the server: the credential-store account.
    pub fn server_account(&self) -> Option<String> {
        let url = Url::parse(&self.server).ok()?;
        let host = url.host_str()?;
        Some(match url.port() {
            Some(p) => format!("{host}:{p}"),
            None => host.to_string(),
        })
    }

    pub fn server_set(&self) -> bool {
        self.server_account().is_some()
    }
}

/// Parses and validates a JSON value into a config (what `save_config` and the JSON tab go through).
pub fn parse(value: serde_json::Value) -> Result<Config, String> {
    let mut cfg: Config = serde_json::from_value(value).map_err(|e| e.to_string())?;
    cfg.validate()?;
    Ok(cfg)
}

pub fn load(paths: &Paths) -> Result<Config, String> {
    let text =
        fs::read_to_string(paths.config_file()).map_err(|e| format!("cannot read config.json: {e}"))?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("config.json: {e}"))?;
    parse(value).map_err(|e| format!("config.json: {e}"))
}

/// Writes through a temp file in the same directory and renames it into place.
pub fn save(paths: &Paths, cfg: &Config) -> Result<(), String> {
    let target = paths.config_file();
    let tmp = paths.config_dir.join("config.json.tmp");
    let mut text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    text.push('\n');
    let write = || -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, &target)
    };
    write().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot write config.json: {e}")
    })
}

pub fn ensure_default(paths: &Paths) -> Result<(), String> {
    if paths.config_file().exists() {
        return Ok(());
    }
    save(paths, &Config::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_roundtrip_with_documented_shape() {
        let c = Config::default();
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["shell"]["enabled"], true);
        assert_eq!(v["files"]["enabled"], false);
        assert_eq!(v["browser"]["mode"], "profile");
        assert_eq!(v["browser"]["userDataDir"], serde_json::Value::Null);
        assert_eq!(parse(v).unwrap().server, "");
    }

    #[test]
    fn validates_server_and_account() {
        let mut c = Config {
            server: " https://evv.example.com:8443/ ".into(),
            ..Config::default()
        };
        c.validate().unwrap();
        assert_eq!(c.server, "https://evv.example.com:8443");
        assert_eq!(c.server_account().as_deref(), Some("evv.example.com:8443"));
        c.server = "ftp://x".into();
        assert!(c.validate().is_err());
        c.server = "nonsense".into();
        assert!(c.validate().is_err());
    }

    #[test]
    fn rejects_bad_enum_and_normalises_empties() {
        assert!(parse(serde_json::json!({"browser": {"mode": "weird"}})).is_err());
        let c = parse(serde_json::json!({"shell": {"path": "  "}, "files": {"roots": ["/a", "/a", " "]}}))
            .unwrap();
        assert_eq!(c.shell.path, None);
        assert_eq!(c.files.roots, vec!["/a".to_string()]);
    }
}
