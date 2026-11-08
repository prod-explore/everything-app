//! A small size-rotated log file (`agent.log`, `agent.log.1` .. `agent.log.3`).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const MAX_BYTES: u64 = 1024 * 1024;
const KEEP: u32 = 3;

pub struct Log {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Log {
    pub fn new(path: PathBuf) -> Self {
        Log {
            path,
            lock: Mutex::new(()),
        }
    }

    pub fn write(&self, level: &str, message: &str) {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.rotate();
        let ts = OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default();
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = writeln!(f, "{ts} {level:<5} {message}");
        }
    }

    fn rotate(&self) {
        let size = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if size < MAX_BYTES {
            return;
        }
        let numbered = |n: u32| PathBuf::from(format!("{}.{n}", self.path.display()));
        let _ = fs::remove_file(numbered(KEEP));
        for n in (1..KEEP).rev() {
            let _ = fs::rename(numbered(n), numbered(n + 1));
        }
        let _ = fs::rename(&self.path, numbered(1));
    }
}
