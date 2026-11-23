//! The tray icon: colour shows the state (grey normal, orange uploading, green something new, red an upload failed);
//! click opens the window; right-click menu.

use crate::config;
use std::sync::Mutex;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Idle,
    Busy,
    New,
    Error,
}

pub struct TrayState(pub Mutex<Option<(Status, usize)>>);

const IDLE: &[u8] = include_bytes!("../icons/tray-idle.png");
const BUSY: &[u8] = include_bytes!("../icons/tray-busy.png");
const NEW: &[u8] = include_bytes!("../icons/tray-new.png");
const ERROR: &[u8] = include_bytes!("../icons/tray-error.png");

pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Buka TalaStudio Upload", true, None::<&str>)?;
    let pick = MenuItem::with_id(app, "pick", "Upload file…", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Jeda notifikasi 1 jam", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Keluar", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pick, &PredefinedMenuItem::separator(app)?, &pause, &PredefinedMenuItem::separator(app)?, &quit])?;
    let pause_item = pause.clone();
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(IDLE)?)
        .tooltip("TalaStudio Upload")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| match ev.id().as_ref() {
            "open" => show_window(app),
            "pick" => {
                show_window(app);
                let _ = app.emit("pick-files", ());
            }
            "pause" => {
                let on = config::get(app).paused_until <= config::now_secs();
                config::update(app, |c| c.paused_until = if on { config::now_secs() + 3600 } else { 0 });
                let _ = pause_item.set_checked(on);
                let _ = app.emit("settings-changed", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn set(app: &AppHandle, status: Status, new_count: usize) {
    let st = app.state::<TrayState>();
    let mut g = st.0.lock().unwrap();
    if *g == Some((status, new_count)) {
        return;
    }
    *g = Some((status, new_count));
    if let Some(t) = app.tray_by_id("main") {
        let bytes = match status {
            Status::Idle => IDLE,
            Status::Busy => BUSY,
            Status::New => NEW,
            Status::Error => ERROR,
        };
        if let Ok(img) = Image::from_bytes(bytes) {
            let _ = t.set_icon(Some(img));
        }
        let tip = match status {
            Status::Busy => "TalaStudio Upload · sedang upload".to_string(),
            Status::Error => "TalaStudio Upload · ada upload yang gagal".to_string(),
            _ if new_count > 0 => format!("TalaStudio Upload · {new_count} file baru belum diunduh"),
            _ => "TalaStudio Upload".to_string(),
        };
        let _ = t.set_tooltip(Some(tip));
    }
}
