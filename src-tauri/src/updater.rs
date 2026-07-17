//! Opt-in auto-update: thin commands over tauri-plugin-updater so the check, the consent bookkeeping and the install all run Rust-side; the webview never talks to the network and the CSP stays external-host-free. Consent rules live here, not in the frontend: bookkeeping persists only while consent is on, so an opted-out manual check leaves no trace.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

use crate::workspace::{self, SettingsState};

/// The update found by the last check, held here so any window can install it.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

/// Outcome of a check, tagged for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateCheck {
    DevBuild,
    UpToDate,
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        notes: Option<String>,
        pub_date: Option<String>,
    },
}

/// Ask the configured endpoint whether a newer release exists. Dev builds answer DevBuild without touching the network unless KOOKABURRA_UPDATE_ENDPOINT points at a local test manifest.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    pending: State<'_, PendingUpdate>,
) -> Result<UpdateCheck, String> {
    let override_endpoint = std::env::var("KOOKABURRA_UPDATE_ENDPOINT")
        .ok()
        .filter(|v| !v.trim().is_empty());
    if cfg!(debug_assertions) && override_endpoint.is_none() {
        return Ok(UpdateCheck::DevBuild);
    }

    let mut builder = app.updater_builder();
    if let Some(raw) = override_endpoint {
        let url: tauri::Url = raw
            .parse()
            .map_err(|e| format!("KOOKABURRA_UPDATE_ENDPOINT: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| match e {
        tauri_plugin_updater::Error::ReleaseNotFound => "no published release found".to_string(),
        other => other.to_string(),
    })?;

    let outcome = match found {
        Some(update) => {
            let check = UpdateCheck::Available {
                version: update.version.clone(),
                notes: update.body.clone(),
                pub_date: update.date.map(|d| d.to_string()),
            };
            *pending.0.lock().map_err(|_| "updater state poisoned")? = Some(update);
            check
        }
        None => {
            *pending.0.lock().map_err(|_| "updater state poisoned")? = None;
            UpdateCheck::UpToDate
        }
    };

    let mut s = workspace::load_settings(&app, &settings)?;
    if s.update_check_consent == Some(true) {
        s.last_update_check_ms = Some(workspace::now_unix_ms());
        workspace::save_settings(&app, &settings, s)?;
    }
    Ok(outcome)
}

/// Record the launch-check consent answer. Turning it off wipes the bookkeeping, not just the flag.
#[tauri::command]
pub fn set_update_consent(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    consent: bool,
) -> Result<(), String> {
    let mut s = workspace::load_settings(&app, &settings)?;
    s.update_check_consent = Some(consent);
    if !consent {
        s.last_update_check_ms = None;
        s.last_offered_version = None;
    }
    workspace::save_settings(&app, &settings, s)
}

/// Remember a declined offer so the same version is not re-offered every launch.
#[tauri::command]
pub fn record_skipped_version(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    version: String,
) -> Result<(), String> {
    let mut s = workspace::load_settings(&app, &settings)?;
    if s.update_check_consent == Some(true) {
        s.last_offered_version = Some(version);
        workspace::save_settings(&app, &settings, s)?;
    }
    Ok(())
}

/// Download, verify and install the pending update, then restart into the new version. On failure the update is put back so Install can be retried.
#[tauri::command]
pub async fn install_update_and_relaunch(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "updater state poisoned")?
        .take()
        .ok_or("no pending update; run a check first")?;
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => app.restart(),
        Err(e) => {
            *pending.0.lock().map_err(|_| "updater state poisoned")? = Some(update);
            Err(e.to_string())
        }
    }
}
