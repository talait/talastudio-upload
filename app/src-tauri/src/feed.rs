//! The shared history: polls /api/feed every few seconds (also while the window is hidden), keeps the merged list,
//! sends it to the window, drives the notifications for other people's uploads and the tray icon colour.

use crate::{api, config, toast, tray, uploads};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct FeedState {
    pub items: BTreeMap<i64, Value>,
    since: Option<String>,
    initialized: bool,
    /// version id → last progress percent shown (-1 = finished notification shown)
    toasts: HashMap<String, i64>,
}

pub struct Feed(pub Mutex<FeedState>);

pub fn kind_label(k: &str) -> &'static str {
    match k {
        "render" => "render",
        "drawing" => "drawing",
        "model" => "3D model",
        _ => "file",
    }
}

pub fn mb(b: f64) -> String {
    if b >= 1_048_576.0 {
        format!("{:.1} MB", b / 1_048_576.0)
    } else {
        format!("{:.0} KB", (b / 1024.0).max(1.0))
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}
fn n(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

pub fn snapshot(app: &AppHandle) -> Vec<Value> {
    let st = app.state::<Feed>();
    let g = st.0.lock().unwrap();
    let mut v: Vec<Value> = g.items.values().cloned().collect();
    v.sort_by(|a, b| s(b, "updated_at").cmp(s(a, "updated_at")));
    v
}

/// Item has something this PC has not downloaded yet (newest done version made by someone else).
pub fn is_new_for(item: &Value, me: &str) -> bool {
    let versions = item.get("versions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let latest = versions.iter().find(|v| s(v, "status") == "done");
    match latest {
        None => false,
        Some(v) => {
            if s(v, "device_id") == me {
                return false;
            }
            !v.get("downloads").and_then(|d| d.as_array()).map(|d| d.iter().any(|x| s(x, "device_id") == me)).unwrap_or(false)
        }
    }
}

fn downloaded_any(item: &Value, me: &str) -> bool {
    item.get("versions").and_then(|v| v.as_array()).map(|vs| {
        vs.iter().any(|v| {
            s(v, "device_id") == me
                || v.get("downloads").and_then(|d| d.as_array()).map(|d| d.iter().any(|x| s(x, "device_id") == me)).unwrap_or(false)
        })
    }).unwrap_or(false)
}

pub fn refresh_tray(app: &AppHandle) {
    let me = config::get(app).device_id.unwrap_or_default();
    let items = snapshot(app);
    let others_busy = items.iter().any(|i| {
        i.get("versions").and_then(|v| v.as_array()).map(|vs| vs.iter().any(|v| s(v, "status") == "uploading" && s(v, "device_id") != me)).unwrap_or(false)
    });
    let new_count = items.iter().filter(|i| is_new_for(i, &me)).count();
    let (mine_busy, mine_failed) = uploads::status(app);
    let state = if mine_failed {
        tray::Status::Error
    } else if mine_busy || others_busy {
        tray::Status::Busy
    } else if new_count > 0 {
        tray::Status::New
    } else {
        tray::Status::Idle
    };
    tray::set(app, state, new_count);
}

fn notify(app: &AppHandle, item: &Value, v: &Value, me: &str) {
    let cfg = config::get(app);
    let id = s(v, "id").to_string();
    let status = s(v, "status");
    let st = app.state::<Feed>();
    let shown = st.0.lock().unwrap().toasts.get(&id).copied();

    let muted = cfg.notify == "off"
        || cfg.paused_until > config::now_secs()
        || (cfg.notify == "downloaded" && !downloaded_any(item, me));

    let who = s(v, "by");
    let what = format!(
        "{} {} v{:02}",
        s(item, "code"),
        kind_label(s(item, "kind")),
        v.get("version").and_then(|x| x.as_i64()).unwrap_or(0)
    );
    let size = n(v, "size").max(1.0);
    let done_bytes = n(v, "progress");
    let pct = ((done_bytes / size) * 100.0).floor() as i64;
    match status {
        "uploading" => {
            if muted {
                return;
            }
            let vs = format!("{} of {}", mb(done_bytes), mb(size));
            let p = toast::Progress { title: s(v, "name"), status: "Uploading…", value: done_bytes / size, value_string: &vs };
            match shown {
                None => {
                    toast::progress_show(&id, &format!("{who} is uploading {what}"), &mb(size), &p);
                    st.0.lock().unwrap().toasts.insert(id, pct);
                }
                Some(last) if last >= 0 && pct > last => {
                    toast::progress_update(&id, &p);
                    st.0.lock().unwrap().toasts.insert(id, pct);
                }
                _ => {}
            }
        }
        "done" => {
            if shown == Some(-1) {
                return;
            }
            if !muted {
                let note = s(v, "note");
                let line = if note.is_empty() { format!("{} · {}", s(v, "name"), mb(size)) } else { note.to_string() };
                toast::done(&id, &format!("{who} uploaded {what}"), &line, true);
            } else if shown.is_some() {
                toast::remove(&id);
            }
            st.0.lock().unwrap().toasts.insert(id, -1);
        }
        _ => {
            if shown.is_some() {
                toast::remove(&id);
                st.0.lock().unwrap().toasts.remove(&id);
            }
        }
    }
}

async fn poll_once(app: &AppHandle) -> Result<bool, String> {
    let since = app.state::<Feed>().0.lock().unwrap().since.clone();
    let path = match &since {
        Some(t) => format!("/api/feed?since={}", t.replace('+', "%2B").replace(':', "%3A")),
        None => "/api/feed".to_string(),
    };
    let res: Value = api::get(app, &path).await?;
    let me = s(&res, "device_id").to_string();
    let changed: Vec<Value> = res.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let first;
    {
        let st = app.state::<Feed>();
        let mut g = st.0.lock().unwrap();
        first = !g.initialized;
        for it in &changed {
            if let Some(id) = it.get("id").and_then(|x| x.as_i64()) {
                g.items.insert(id, it.clone());
            }
        }
        g.since = res.get("server_time").and_then(|x| x.as_str()).map(String::from);
        if first {
            // what was already there when the app opened does not pop up; only what happens from now on
            for it in &changed {
                for v in it.get("versions").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                    let st = s(&v, "status");
                    if st == "done" || st == "uploading" {
                        g.toasts.insert(s(&v, "id").to_string(), -1);
                    }
                }
            }
            g.initialized = true;
        }
    }
    if !first {
        for it in &changed {
            for v in it.get("versions").and_then(|x| x.as_array()).cloned().unwrap_or_default() {
                if s(&v, "device_id") != me {
                    notify(app, it, &v, &me);
                }
            }
        }
    }
    let busy = snapshot(app).iter().any(|i| {
        i.get("versions").and_then(|v| v.as_array()).map(|vs| vs.iter().any(|v| s(v, "status") == "uploading")).unwrap_or(false)
    });
    if first || !changed.is_empty() {
        let _ = app.emit("items", snapshot(app));
    }
    refresh_tray(app);
    Ok(busy)
}

/// Forget the cursor so the next poll reloads everything (after registering or renaming).
pub fn reset(app: &AppHandle) {
    let st = app.state::<Feed>();
    let mut g = st.0.lock().unwrap();
    g.since = None;
    g.items.clear();
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        loop {
            let wait = if config::get(&app).token.is_none() {
                Duration::from_secs(2)
            } else {
                match poll_once(&app).await {
                    Ok(busy) => {
                        if failures > 0 {
                            let _ = app.emit("online", true);
                        }
                        failures = 0;
                        Duration::from_secs(if busy { 2 } else { 5 })
                    }
                    Err(e) => {
                        failures += 1;
                        let _ = app.emit("online", false);
                        if failures == 1 {
                            eprintln!("feed: {e}");
                        }
                        Duration::from_secs((5 * failures as u64).min(60))
                    }
                }
            };
            tokio::time::sleep(wait).await;
        }
    });
}
