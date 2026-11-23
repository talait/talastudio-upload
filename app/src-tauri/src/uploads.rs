//! Sending files: hash (sha256, to refuse exact duplicates), ask the server for a Drive upload session, then PUT the
//! file to Google Drive in 8 MiB pieces, resuming after network drops. Progress goes to the window (event "upload")
//! and to the server every ~1.5 s, so the other PCs can show it in their notification.

use crate::{api, config, feed, toast};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const CHUNK: u64 = 8 * 1024 * 1024; // multiple of 256 KiB, as Drive requires

#[derive(Clone, Serialize)]
pub struct Job {
    pub local_id: String,
    pub path: String,
    pub name: String,
    pub size: u64,
    pub code: String,
    pub kind: String,
    pub note: Option<String>,
    /// hashing | starting | uploading | done | duplicate | failed | cancelled
    pub state: String,
    pub bytes: u64,
    pub version_id: Option<String>,
    pub version: Option<i64>,
    pub stored_name: Option<String>,
    pub message: Option<String>,
    pub started_ms: u64,
}

#[derive(Default)]
pub struct Uploads {
    pub jobs: Mutex<HashMap<String, Job>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn emit(app: &AppHandle, job: &Job) {
    app.state::<Uploads>().jobs.lock().unwrap().insert(job.local_id.clone(), job.clone());
    let _ = app.emit("upload", job.clone());
}

/// (any upload of this PC running, any failed in this session and not dismissed)
pub fn status(app: &AppHandle) -> (bool, bool) {
    let st = app.state::<Uploads>();
    let jobs = st.jobs.lock().unwrap();
    (
        jobs.values().any(|j| matches!(j.state.as_str(), "hashing" | "starting" | "uploading")),
        jobs.values().any(|j| j.state == "failed"),
    )
}

pub fn list(app: &AppHandle) -> Vec<Job> {
    let mut v: Vec<Job> = app.state::<Uploads>().jobs.lock().unwrap().values().cloned().collect();
    v.sort_by(|a, b| b.started_ms.cmp(&a.started_ms));
    v
}

pub fn dismiss(app: &AppHandle, local_id: &str) {
    app.state::<Uploads>().jobs.lock().unwrap().remove(local_id);
    feed::refresh_tray(app);
}

pub fn cancel(app: &AppHandle, local_id: &str) {
    if let Some(c) = app.state::<Uploads>().cancels.lock().unwrap().get(local_id) {
        c.store(true, Ordering::SeqCst);
    }
}

pub fn start(app: AppHandle, path: String, code: String, kind: String, note: Option<String>) -> Result<Job, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("The file cannot be opened: {e}"))?;
    if !meta.is_file() {
        return Err("Send files, not folders.".into());
    }
    if meta.len() == 0 {
        return Err("This file is empty.".into());
    }
    let name = std::path::Path::new(&path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
    let job = Job {
        local_id: format!("u{}", NEXT.fetch_add(1, Ordering::SeqCst)),
        path,
        name,
        size: meta.len(),
        code,
        kind,
        note: note.filter(|n| !n.trim().is_empty()),
        state: "hashing".into(),
        bytes: 0,
        version_id: None,
        version: None,
        stored_name: None,
        message: None,
        started_ms: now_ms(),
    };
    let cancel = Arc::new(AtomicBool::new(false));
    app.state::<Uploads>().cancels.lock().unwrap().insert(job.local_id.clone(), cancel.clone());
    emit(&app, &job);
    feed::refresh_tray(&app);
    let j = job.clone();
    tauri::async_runtime::spawn(async move {
        let mut job = j;
        let result = run(&app, &mut job, &cancel).await;
        match result {
            Ok(()) => {}
            Err(msg) => {
                let cancelled = cancel.load(Ordering::SeqCst);
                job.state = if cancelled { "cancelled".into() } else { "failed".into() };
                job.message = Some(if cancelled { "Cancelled.".into() } else { msg.clone() });
                if let Some(id) = &job.version_id {
                    let _ = api::post::<Value>(&app, &format!("/api/uploads/{id}/fail"), &json!({ "cancelled": cancelled, "reason": msg })).await;
                }
                emit(&app, &job);
                if !cancelled {
                    toast::simple(&format!("Upload failed: {}", job.name), &msg);
                }
            }
        }
        app.state::<Uploads>().cancels.lock().unwrap().remove(&job.local_id);
        feed::refresh_tray(&app);
    });
    Ok(job)
}

async fn hash(app: &AppHandle, job: &mut Job, cancel: &AtomicBool) -> Result<String, String> {
    let mut f = tokio::fs::File::open(&job.path).await.map_err(|e| format!("The file cannot be opened: {e}"))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut done = 0u64;
    let mut last = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled.".into());
        }
        let n = f.read(&mut buf).await.map_err(|e| format!("The file cannot be read: {e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        done += n as u64;
        if last.elapsed() > Duration::from_millis(300) {
            job.bytes = done;
            emit(app, job);
            last = Instant::now();
        }
    }
    if done != job.size {
        return Err("The file changed while it was being read. Wait until it has finished saving, then send it again.".into());
    }
    job.bytes = 0;
    Ok(hex::encode(h.finalize()))
}

/// Ask Drive how much of the session it already has (after a network drop). None = finished (file JSON returned).
async fn probe(session: &str, size: u64) -> Result<Result<u64, Value>, String> {
    let res = api::transfer_client()
        .put(session)
        .header("Content-Range", format!("bytes */{size}"))
        .header("Content-Length", "0")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Google Drive cannot be reached: {e}"))?;
    match res.status().as_u16() {
        200 | 201 => Ok(Err(res.json::<Value>().await.map_err(|e| e.to_string())?)),
        308 => Ok(Ok(next_offset(&res))),
        404 | 410 => Err("The Drive upload session expired. Send the file again.".into()),
        s => Err(format!("Google Drive answered {s}")),
    }
}

fn next_offset(res: &reqwest::Response) -> u64 {
    res.headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|r| r.rsplit('-').next())
        .and_then(|e| e.parse::<u64>().ok())
        .map(|e| e + 1)
        .unwrap_or(0)
}

async fn run(app: &AppHandle, job: &mut Job, cancel: &AtomicBool) -> Result<(), String> {
    let sha = hash(app, job, cancel).await?;
    job.state = "starting".into();
    emit(app, job);
    let mime = mime_guess::from_path(&job.path).first_or_octet_stream().essence_str().to_string();
    let start: Value = api::post(
        app,
        "/api/uploads",
        &json!({ "name": job.name, "size": job.size, "sha256": sha, "mime": mime, "code": job.code, "kind": job.kind, "note": job.note }),
    )
    .await?;
    if let Some(d) = start.get("duplicate") {
        job.state = "duplicate".into();
        job.message = Some(if d.get("uploading").and_then(|x| x.as_bool()).unwrap_or(false) {
            format!("The same file is being uploaded by {}.", d.get("by").and_then(|x| x.as_str()).unwrap_or("someone else"))
        } else {
            format!(
                "Already there: {} {} v{:02}, uploaded by {}. Not uploaded again.",
                d.get("code").and_then(|x| x.as_str()).unwrap_or(""),
                feed::kind_label(d.get("kind").and_then(|x| x.as_str()).unwrap_or("")),
                d.get("version").and_then(|x| x.as_i64()).unwrap_or(0),
                d.get("by").and_then(|x| x.as_str()).unwrap_or("")
            )
        });
        emit(app, job);
        return Ok(());
    }
    let id = start.get("version_id").and_then(|x| x.as_str()).ok_or("The server did not return an upload ID.")?.to_string();
    let session = start.get("session_url").and_then(|x| x.as_str()).ok_or("The server did not return an upload address.")?.to_string();
    job.version_id = Some(id.clone());
    job.version = start.get("version").and_then(|x| x.as_i64());
    job.stored_name = start.get("stored_name").and_then(|x| x.as_str()).map(String::from);
    job.code = start.get("code").and_then(|x| x.as_str()).unwrap_or(&job.code).to_string();
    job.state = "uploading".into();
    emit(app, job);

    let mut file = tokio::fs::File::open(&job.path).await.map_err(|e| format!("The file cannot be opened: {e}"))?;
    let mut offset = 0u64;
    let mut retries = 0u32;
    let mut last_report = Instant::now();
    let mut drive_file: Option<Value> = None;
    while drive_file.is_none() {
        if cancel.load(Ordering::SeqCst) {
            return Err("Cancelled.".into());
        }
        let len = CHUNK.min(job.size - offset);
        let mut buf = vec![0u8; len as usize];
        file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
        file.read_exact(&mut buf).await.map_err(|e| format!("The file cannot be read: {e}"))?;
        let sent = api::transfer_client()
            .put(&session)
            .header("Content-Range", format!("bytes {}-{}/{}", offset, offset + len - 1, job.size))
            .header("Content-Length", len.to_string())
            .timeout(Duration::from_secs(300))
            .body(buf)
            .send()
            .await;
        let outcome: Result<Result<u64, Value>, String> = match sent {
            Ok(res) => match res.status().as_u16() {
                308 => Ok(Ok(next_offset(&res))),
                200 | 201 => res.json::<Value>().await.map(|v| Err(v)).map_err(|e| e.to_string()),
                404 | 410 => Err("The Drive upload session expired. Send the file again.".into()),
                s if s >= 500 || s == 429 => Err(format!("retry:Google Drive answered {s}")),
                s => Err(format!("Google Drive refused the upload ({s}).")),
            },
            Err(e) => Err(format!("retry:{e}")),
        };
        match outcome {
            Ok(Ok(next)) => {
                offset = next;
                retries = 0;
            }
            Ok(Err(f)) => {
                offset = job.size;
                drive_file = Some(f);
            }
            Err(e) if e.starts_with("retry:") && retries < 8 => {
                retries += 1;
                job.message = Some("Connection lost, retrying…".into());
                emit(app, job);
                tokio::time::sleep(Duration::from_secs((2u64 << retries.min(5)).min(60))).await;
                match probe(&session, job.size).await {
                    Ok(Ok(next)) => offset = next,
                    Ok(Err(f)) => {
                        offset = job.size;
                        drive_file = Some(f);
                    }
                    Err(_) => {}
                }
                job.message = None;
            }
            Err(e) => return Err(e.trim_start_matches("retry:").to_string()),
        }
        job.bytes = offset;
        emit(app, job);
        if last_report.elapsed() > Duration::from_millis(1500) || drive_file.is_some() {
            let _ = api::post::<Value>(app, &format!("/api/uploads/{id}/progress"), &json!({ "bytes": offset })).await;
            last_report = Instant::now();
        }
    }
    let f = drive_file.unwrap_or(Value::Null);
    let file_id = f.get("id").and_then(|x| x.as_str()).ok_or("Google Drive did not return a file ID.")?;
    let done: Value = api::post(app, &format!("/api/uploads/{id}/done"), &json!({ "file_id": file_id })).await?;
    job.state = "done".into();
    job.bytes = job.size;
    job.stored_name = done.get("name").and_then(|x| x.as_str()).map(String::from).or(job.stored_name.clone());
    emit(app, job);
    let what = format!("{} {} v{:02}", job.code, feed::kind_label(&job.kind), job.version.unwrap_or(0));
    let visible = app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)).unwrap_or(false);
    if !visible && config::get(app).notify != "off" {
        toast::simple(&format!("Upload finished: {what}"), &format!("{} · {}", job.name, feed::mb(job.size as f64)));
    }
    Ok(())
}
