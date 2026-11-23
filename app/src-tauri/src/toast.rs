//! Native Windows notifications (toasts).
//!
//! One notification per upload: it appears when someone starts uploading, its progress bar updates in place
//! (same tag, rising sequence number), and it turns into "selesai" with Buka / Unduh buttons, or disappears when the
//! upload fails. Clicks come back through `on_action` with "open:<version_id>" or "download:<version_id>".
//! On other systems (development on Linux/macOS) every call is a no-op.

pub const APP_ID: &str = "net.talastudio.upload";
pub const GROUP: &str = "filedrop";

pub struct Progress<'a> {
    pub title: &'a str,
    pub status: &'a str,
    pub value: f64,
    pub value_string: &'a str,
}

#[cfg(windows)]
mod imp {
    use super::{Progress, APP_ID, GROUP};
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use windows::core::{IInspectable, Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::Collections::StringMap;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        NotificationData, ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
    };

    type Handler = Box<dyn Fn(String) + Send + Sync>;
    static HANDLER: OnceLock<Handler> = OnceLock::new();
    static SEQ: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();

    pub fn on_action(f: impl Fn(String) + Send + Sync + 'static) {
        let _ = HANDLER.set(Box::new(f));
    }

    fn app_id() -> HSTRING {
        // Installed builds have a Start menu shortcut with this AppUserModelID (set by the Tauri NSIS installer).
        // A development build is not installed, so Windows would drop the toast; borrow PowerShell's id there.
        if cfg!(debug_assertions) {
            HSTRING::from("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe")
        } else {
            HSTRING::from(APP_ID)
        }
    }

    fn esc(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
    }

    /// Windows limits tags to 64 characters (16 on very old builds); version ids are uuids, so drop the dashes and cut.
    fn tag(t: &str) -> HSTRING {
        HSTRING::from(t.replace('-', "").chars().take(16).collect::<String>())
    }

    fn values(p: &Progress) -> windows::core::Result<StringMap> {
        let map = StringMap::new()?;
        map.Insert(&HSTRING::from("pTitle"), &HSTRING::from(p.title))?;
        map.Insert(&HSTRING::from("pStatus"), &HSTRING::from(p.status))?;
        map.Insert(&HSTRING::from("pValue"), &HSTRING::from(format!("{:.3}", p.value.clamp(0.0, 1.0))))?;
        map.Insert(&HSTRING::from("pValueString"), &HSTRING::from(p.value_string))?;
        Ok(map)
    }

    fn next_seq(t: &str, reset: bool) -> u32 {
        let m = SEQ.get_or_init(|| Mutex::new(HashMap::new()));
        let mut g = m.lock().unwrap();
        let e = g.entry(t.to_string()).or_insert(0);
        if reset {
            *e = 1;
        } else {
            *e += 1;
        }
        *e
    }

    fn build(xml: &str, t: Option<&str>) -> windows::core::Result<ToastNotification> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        if let Some(t) = t {
            toast.SetTag(&tag(t))?;
            toast.SetGroup(&HSTRING::from(GROUP))?;
        }
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
            let args: &Option<IInspectable> = &args;
            if let Some(a) = args {
                if let Ok(ev) = a.cast::<ToastActivatedEventArgs>() {
                    if let Ok(s) = ev.Arguments() {
                        if let Some(h) = HANDLER.get() {
                            h(s.to_string());
                        }
                    }
                }
            }
            Ok(())
        }))?;
        Ok(toast)
    }

    fn show(toast: &ToastNotification) -> windows::core::Result<()> {
        ToastNotificationManager::CreateToastNotifierWithId(&app_id())?.Show(toast)
    }

    pub fn progress_show(id: &str, title: &str, line: &str, p: &Progress) {
        let r = (|| -> windows::core::Result<()> {
            let xml = format!(
                r#"<toast activationType="foreground" launch="open:{id}"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text><progress title="{{pTitle}}" value="{{pValue}}" valueStringOverride="{{pValueString}}" status="{{pStatus}}"/></binding></visual><audio silent="true"/></toast>"#,
                esc(title),
                esc(line),
                id = esc(id)
            );
            let toast = build(&xml, Some(id))?;
            let data = NotificationData::CreateNotificationDataWithValuesAndSequenceNumber(&values(p)?, next_seq(id, true))?;
            toast.SetData(&data)?;
            show(&toast)
        })();
        if let Err(e) = r {
            eprintln!("toast: {e}");
        }
    }

    pub fn progress_update(id: &str, p: &Progress) {
        let r = (|| -> windows::core::Result<()> {
            let data = NotificationData::CreateNotificationDataWithValuesAndSequenceNumber(&values(p)?, next_seq(id, false))?;
            ToastNotificationManager::CreateToastNotifierWithId(&app_id())?.UpdateWithTagAndGroup(&data, &tag(id), &HSTRING::from(GROUP))?;
            Ok(())
        })();
        if let Err(e) = r {
            eprintln!("toast update: {e}");
        }
    }

    pub fn remove(id: &str) {
        if let Ok(h) = ToastNotificationManager::History() {
            let _ = h.RemoveGroupedTagWithId(&tag(id), &HSTRING::from(GROUP), &app_id());
        }
    }

    /// Replace the progress notification with the finished one (same tag), with Buka / Unduh buttons.
    pub fn done(id: &str, title: &str, line: &str, buttons: bool) {
        remove(id);
        let r = (|| -> windows::core::Result<()> {
            let actions = if buttons {
                format!(
                    r#"<actions><action content="Buka" arguments="open:{id}" activationType="foreground"/><action content="Unduh" arguments="download:{id}" activationType="foreground"/></actions>"#,
                    id = esc(id)
                )
            } else {
                String::new()
            };
            let xml = format!(
                r#"<toast activationType="foreground" launch="open:{id}"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual>{actions}</toast>"#,
                esc(title),
                esc(line),
                id = esc(id)
            );
            show(&build(&xml, Some(id))?)
        })();
        if let Err(e) = r {
            eprintln!("toast done: {e}");
        }
    }

    pub fn simple(title: &str, line: &str) {
        let r = (|| -> windows::core::Result<()> {
            let xml = format!(
                r#"<toast activationType="foreground" launch="open:"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
                esc(title),
                esc(line)
            );
            show(&build(&xml, None)?)
        })();
        if let Err(e) = r {
            eprintln!("toast: {e}");
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Progress;
    pub fn on_action(_f: impl Fn(String) + Send + Sync + 'static) {}
    pub fn progress_show(id: &str, title: &str, _line: &str, _p: &Progress) {
        println!("[toast] {id} {title}");
    }
    pub fn progress_update(_id: &str, _p: &Progress) {}
    pub fn remove(_id: &str) {}
    pub fn done(id: &str, title: &str, _line: &str, _buttons: bool) {
        println!("[toast] {id} {title}");
    }
    pub fn simple(title: &str, _line: &str) {
        println!("[toast] {title}");
    }
}

pub use imp::*;
