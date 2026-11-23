//! TalaStudio Upload: Windows app for the team to send files (renders, drawings, models) to Drive
//! TALASTUDIO ASSETS/_UPLOAD/<item>/ and see the same history on every PC. Server: upload.talastudio.net.

mod api;
mod config;
mod feed;
mod toast;
mod tray;
mod uploads;

use base64::Engine;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_updater::UpdaterExt;
use tokio::io::AsyncWriteExt;

#[derive(Serialize)]
struct AppState {
    registered: bool,
    name: Option<String>,
    device_id: Option<String>,
    version: &'static str,
    notify: String,
    paused: bool,
}

fn app_state(app: &AppHandle) -> AppState {
    let c = config::get(app);
    AppState {
        registered: c.token.is_some(),
        name: c.name,
        device_id: c.device_id,
        version: env!("CARGO_PKG_VERSION"),
        notify: c.notify,
        paused: c.paused_until > config::now_secs(),
    }
}

#[tauri::command]
fn get_state(app: AppHandle) -> AppState {
    app_state(&app)
}

#[tauri::command]
async fn register(app: AppHandle, name: String) -> Result<AppState, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err("Type a PC name (1–60 characters).".into());
    }
    let r: Value = api::post(&app, "/api/register", &json!({ "name": name, "os": std::env::consts::OS })).await?;
    let token = r.get("token").and_then(|x| x.as_str()).ok_or("The server did not return a token.")?.to_string();
    config::update(&app, |c| {
        c.token = Some(token);
        c.device_id = r.get("device_id").and_then(|x| x.as_str()).map(String::from);
        c.name = Some(name.clone());
    });
    feed::reset(&app);
    Ok(app_state(&app))
}

#[tauri::command]
async fn rename(app: AppHandle, name: String) -> Result<AppState, String> {
    let r: Value = api::post(&app, "/api/rename", &json!({ "name": name.trim() })).await?;
    config::update(&app, |c| c.name = r.get("name").and_then(|x| x.as_str()).map(String::from));
    feed::reset(&app);
    Ok(app_state(&app))
}

#[tauri::command]
fn set_notify(app: AppHandle, mode: String) -> AppState {
    let mode = if ["all", "downloaded", "off"].contains(&mode.as_str()) { mode } else { "all".into() };
    config::update(&app, |c| c.notify = mode);
    app_state(&app)
}

#[tauri::command]
async fn codes(app: AppHandle) -> Result<Value, String> {
    let r: Value = api::get(&app, "/api/codes").await?;
    Ok(r.get("codes").cloned().unwrap_or(json!([])))
}

#[tauri::command]
fn items(app: AppHandle) -> Vec<Value> {
    feed::snapshot(&app)
}

#[derive(Serialize)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
    is_file: bool,
}

#[tauri::command]
fn file_info(paths: Vec<String>) -> Vec<FileInfo> {
    let mut out = vec![];
    for p in paths {
        let path = std::path::Path::new(&p);
        if path.is_dir() {
            // a dropped folder: take the files directly inside it (not sub-folders)
            if let Ok(rd) = std::fs::read_dir(path) {
                for e in rd.flatten() {
                    if let Ok(m) = e.metadata() {
                        if m.is_file() {
                            out.push(FileInfo { path: e.path().to_string_lossy().to_string(), name: e.file_name().to_string_lossy().to_string(), size: m.len(), is_file: true });
                        }
                    }
                }
            }
        } else if let Ok(m) = std::fs::metadata(path) {
            out.push(FileInfo { path: p.clone(), name: path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), size: m.len(), is_file: m.is_file() });
        }
    }
    out
}

#[tauri::command]
fn start_upload(app: AppHandle, path: String, code: String, kind: String, note: Option<String>) -> Result<uploads::Job, String> {
    uploads::start(app, path, code, kind, note)
}

#[tauri::command]
fn upload_list(app: AppHandle) -> Vec<uploads::Job> {
    uploads::list(&app)
}

#[tauri::command]
fn cancel_upload(app: AppHandle, local_id: String) {
    uploads::cancel(&app, &local_id)
}

#[tauri::command]
fn dismiss_upload(app: AppHandle, local_id: String) {
    uploads::dismiss(&app, &local_id)
}

#[tauri::command]
async fn set_note(app: AppHandle, version_id: String, note: String) -> Result<(), String> {
    let _: Value = api::post(&app, &format!("/api/versions/{version_id}/note"), &json!({ "note": note })).await?;
    Ok(())
}

/// Download a version to Downloads\TalaStudio\<name> (never overwriting: "name (2).ext"). Returns the saved path.
#[tauri::command]
async fn download(app: AppHandle, version_id: String) -> Result<String, String> {
    download_to_disk(&app, &version_id).await
}

async fn download_to_disk(app: &AppHandle, version_id: &str) -> Result<String, String> {
    let token = api::token(app)?;
    let res = api::transfer_client()
        .get(format!("{}/api/versions/{version_id}/download", config::SERVER))
        .bearer_auth(token)
        .header("x-app-version", env!("CARGO_PKG_VERSION"))
        .send()
        .await
        .map_err(|e| format!("Cannot reach the server: {e}"))?;
    if !res.status().is_success() {
        let msg = res.json::<Value>().await.ok().and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from));
        return Err(msg.unwrap_or_else(|| "The file could not be downloaded.".into()));
    }
    let name = res
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split("filename*=UTF-8''").nth(1))
        .map(|s| percent_decode(s.trim()))
        .unwrap_or_else(|| format!("{version_id}.bin"));
    let name: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let total = res.content_length().unwrap_or(0);
    let dir = app.path().download_dir().map_err(|e| e.to_string())?.join("TalaStudio");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let mut target = dir.join(&name);
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (name.clone(), String::new()),
    };
    let mut i = 2;
    while target.exists() {
        target = dir.join(format!("{stem} ({i}){ext}"));
        i += 1;
    }
    let part = target.with_extension("part");
    let mut f = tokio::fs::File::create(&part).await.map_err(|e| e.to_string())?;
    let mut got = 0u64;
    let mut last = std::time::Instant::now();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("The download was interrupted: {e}"))?;
        f.write_all(&chunk).await.map_err(|e| e.to_string())?;
        got += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(250) {
            let _ = app.emit("download", json!({ "version_id": version_id, "bytes": got, "total": total }));
            last = std::time::Instant::now();
        }
    }
    f.flush().await.map_err(|e| e.to_string())?;
    drop(f);
    tokio::fs::rename(&part, &target).await.map_err(|e| e.to_string())?;
    let path = target.to_string_lossy().to_string();
    let _ = app.emit("download", json!({ "version_id": version_id, "bytes": got, "total": total, "path": path, "done": true }));
    Ok(path)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub struct Previews(pub Mutex<HashMap<String, Option<String>>>);

/// Small preview picture of an uploaded version, as a data: URL (null when Drive has none).
#[tauri::command]
async fn preview(app: AppHandle, version_id: String) -> Result<Option<String>, String> {
    if let Some(hit) = app.state::<Previews>().0.lock().unwrap().get(&version_id).cloned() {
        return Ok(hit);
    }
    let res = api::client()
        .get(format!("{}/api/versions/{version_id}/preview?s=480", config::SERVER))
        .bearer_auth(api::token(&app)?)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let out = if res.status().as_u16() == 200 {
        let ct = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("image/jpeg").to_string();
        let bytes = res.bytes().await.map_err(|e| e.to_string())?;
        Some(format!("data:{ct};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
    } else {
        None
    };
    let cache = app.state::<Previews>();
    let mut g = cache.0.lock().unwrap();
    if g.len() > 300 {
        g.clear();
    }
    // a missing preview may appear later (Drive makes them after a while): only cache successes
    if out.is_some() {
        g.insert(version_id, out.clone());
    }
    Ok(out)
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<String>, String> {
    update_now(&app, true).await
}

/// Check upload.talastudio.net for a newer signed installer; install it when no upload is running.
async fn update_now(app: &AppHandle, manual: bool) -> Result<Option<String>, String> {
    let Ok(token) = api::token(app) else { return Ok(None) };
    let url = format!("{}/app/update?current={{{{current_version}}}}", config::SERVER).parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .header("Authorization", format!("Bearer {token}"))
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(None) };
    let version = update.version.clone();
    while uploads::status(app).0 {
        tokio::time::sleep(Duration::from_secs(20)).await;
    }
    if !manual {
        toast::simple("TalaStudio Upload is updating", &format!("Installing version {version}. The app will open again by itself."));
    }
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}

fn files_from_args(args: &[String]) -> Vec<String> {
    args.iter().skip(1).filter(|a| !a.starts_with("--") && std::path::Path::new(a).exists()).cloned().collect()
}

pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // a second start (desktop shortcut, "Send to", file dropped on the icon) hands its files to this one
            tray::show_window(app);
            let files = files_from_args(&args);
            if !files.is_empty() {
                let _ = app.emit("files-dropped", files);
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .manage(feed::Feed(Mutex::new(Default::default())))
        .manage(uploads::Uploads::default())
        .manage(tray::TrayState(Mutex::new(None)))
        .manage(Previews(Mutex::new(HashMap::new())))
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(config::ConfigState(Mutex::new(config::load(&handle))));

            // switch "start with Windows" on once; after that the person decides in Settings
            if !config::get(&handle).autostart_set {
                use tauri_plugin_autostart::ManagerExt;
                let _ = handle.autolaunch().enable();
                config::update(&handle, |c| c.autostart_set = true);
            }

            tray::build(&handle)?;

            let h = handle.clone();
            toast::on_action(move |arg| {
                let h2 = h.clone();
                if let Some(id) = arg.strip_prefix("download:") {
                    let id = id.to_string();
                    tauri::async_runtime::spawn(async move {
                        match download_to_disk(&h2, &id).await {
                            Ok(p) => toast::simple("File saved", &p),
                            Err(e) => toast::simple("Download failed", &e),
                        }
                    });
                } else {
                    tray::show_window(&h2);
                    if let Some(id) = arg.strip_prefix("open:").filter(|s| !s.is_empty()) {
                        let _ = h2.emit("focus-version", id.to_string());
                    }
                }
            });

            let args: Vec<String> = std::env::args().collect();
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                if args.iter().any(|a| a == "--minimized") {
                    let _ = w.minimize();
                }
            }
            let files = files_from_args(&args);
            if !files.is_empty() {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    let _ = h.emit("files-dropped", files);
                });
            }

            feed::start(handle.clone());

            let h = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                loop {
                    if let Err(e) = update_now(&h, false).await {
                        eprintln!("update: {e}");
                    }
                    tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // X keeps the app running: the window goes to the taskbar, so files can still be dragged onto its button
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.minimize();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state, register, rename, set_notify, codes, items, file_info, start_upload, upload_list, cancel_upload,
            dismiss_upload, set_note, download, preview, check_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running TalaStudio Upload");
}
