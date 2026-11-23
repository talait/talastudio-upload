//! Settings of this PC, kept in %APPDATA%\net.talastudio.upload\config.json.
//! The device token is the PC's only credential (made once at install by /api/register).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const SERVER: &str = "https://upload.talastudio.net";

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// "all" = every upload of others, "downloaded" = only new versions of items I downloaded, "off".
    #[serde(default = "default_notify")]
    pub notify: String,
    /// Unix seconds until which notifications are paused (tray menu "Pause notifications for 1 hour").
    #[serde(default)]
    pub paused_until: u64,
    /// Versions this PC has seen (row opened, downloaded, or opened from a notification). The red number on the
    /// taskbar counts new files of others that are not seen yet. Newest last, capped.
    #[serde(default)]
    pub seen: Vec<String>,
    /// Autostart was switched on once at first run; after that the person decides.
    #[serde(default)]
    pub autostart_set: bool,
}

fn default_notify() -> String {
    "all".into()
}

pub struct ConfigState(pub Mutex<Config>);

fn path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&dir);
    dir.join("config.json")
}

pub fn load(app: &AppHandle) -> Config {
    std::fs::read_to_string(path(app))
        .ok()
        .and_then(|s| serde_json::from_str::<Config>(&s).ok())
        .unwrap_or(Config { notify: default_notify(), ..Default::default() })
}

pub fn save(app: &AppHandle, c: &Config) {
    if let Ok(s) = serde_json::to_string_pretty(c) {
        let p = path(app);
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, &p);
        }
    }
}

pub fn get(app: &AppHandle) -> Config {
    app.state::<ConfigState>().0.lock().map(|c| c.clone()).unwrap_or_default()
}

pub fn update(app: &AppHandle, f: impl FnOnce(&mut Config)) -> Config {
    let st = app.state::<ConfigState>();
    let mut c = st.0.lock().expect("config lock");
    f(&mut c);
    save(app, &c);
    c.clone()
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Remember versions as seen on this PC (keeps the newest 3000).
pub fn mark_seen(app: &AppHandle, ids: &[String]) {
    update(app, |c| {
        for id in ids {
            if !c.seen.iter().any(|s| s == id) {
                c.seen.push(id.clone());
            }
        }
        let n = c.seen.len();
        if n > 3000 {
            c.seen.drain(0..n - 3000);
        }
    });
}
