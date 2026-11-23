//! Calls to upload.talastudio.net with this PC's device token.

use crate::config::{self, SERVER};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::OnceLock;
use tauri::AppHandle;

pub fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("TalaStudioUpload/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("http client")
    })
}

/// Long transfers (Drive chunks, downloads) get their own timeout per request.
pub fn transfer_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("TalaStudioUpload/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("http client")
    })
}

pub fn token(app: &AppHandle) -> Result<String, String> {
    config::get(app).token.ok_or_else(|| "PC ini belum terdaftar.".to_string())
}

async fn answer<T: DeserializeOwned>(res: reqwest::Response) -> Result<T, String> {
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("Jawaban server terputus: {e}"))?;
    if status.as_u16() == 204 {
        return serde_json::from_str("null").map_err(|e| e.to_string());
    }
    if !status.is_success() {
        let msg = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| format!("Server menjawab {status}"));
        return Err(msg);
    }
    serde_json::from_str(&text).map_err(|e| format!("Jawaban server tidak terbaca: {e}"))
}

fn net(e: reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() {
        "Tidak bisa terhubung ke server. Cek internet PC ini.".into()
    } else {
        format!("Koneksi bermasalah: {e}")
    }
}

pub async fn get<T: DeserializeOwned>(app: &AppHandle, path: &str) -> Result<T, String> {
    let res = client()
        .get(format!("{SERVER}{path}"))
        .bearer_auth(token(app)?)
        .header("x-app-version", env!("CARGO_PKG_VERSION"))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(net)?;
    answer(res).await
}

pub async fn post<T: DeserializeOwned>(app: &AppHandle, path: &str, body: &Value) -> Result<T, String> {
    let mut req = client()
        .post(format!("{SERVER}{path}"))
        .header("x-app-version", env!("CARGO_PKG_VERSION"))
        .timeout(std::time::Duration::from_secs(60))
        .json(body);
    if let Ok(t) = token(app) {
        req = req.bearer_auth(t);
    }
    answer(req.send().await.map_err(net)?).await
}
