//! Who a pack says it came from, and who this Mac has accepted packs from before.
//!
//! Two halves: the Settings-owned profile stamped into every pack we sign, and the trust-on-first-use store keyed by
//! the manifest's key id. Neither half ever treats a declared name as verified: only the signature is evidence.

use super::key;
use super::model::PackPublisher;
use crate::workspace::{load_settings, save_settings, KnownPublisher, PublisherProfile, SettingsState};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, State};

/// Longest a name or organisation may be, so one field cannot dominate a manifest or a trust screen.
pub const MAX_PUBLISHER_FIELD: usize = 64;
const MAX_WEBSITE_CHARS: usize = 200;

/// The pane's whole state: what was typed, what a pack would actually carry, and the key (never the private half).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherProfileView {
    /// Absent until the pane has been saved once.
    pub profile: Option<PublisherProfile>,
    /// The name a pack signed right now would carry: the profile's, else the macOS full user name.
    pub effective_name: String,
    pub organisation: Option<String>,
    pub website: Option<String>,
    /// From macOS, shown read-only.
    pub device: String,
    /// Absent until this install signs its first pack.
    pub key: Option<PublisherKeyView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherKeyView {
    pub key_id: String,
    /// The same id in groups of four, for reading out loud.
    pub key_id_display: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownPublisherRow {
    pub key_id: String,
    pub key_id_display: String,
    #[serde(flatten)]
    pub publisher: KnownPublisher,
}

/// What the import screen says about the publisher of the pack in hand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum PublisherVerdict {
    FirstTime,
    Known {
        last_pack: String,
        first_seen: String,
        pack_count: u32,
    },
    /// The same key, a different declared name. A warning, not a refusal: the signature still holds.
    NameChanged {
        previous: String,
    },
}

// ── Verdicts and the trust store ────────────────────────────────────

/// Pure: the verdict for a manifest publisher against the store. A stored record whose key differs reads as first time, since a key id is a truncated hash.
pub fn publisher_verdict(
    known: &HashMap<String, KnownPublisher>,
    publisher: &PackPublisher,
) -> PublisherVerdict {
    let Some(record) = known.get(&publisher.key_id) else {
        return PublisherVerdict::FirstTime;
    };
    if record.public_key != publisher.public_key {
        return PublisherVerdict::FirstTime;
    }
    if record.name != publisher.name {
        return PublisherVerdict::NameChanged {
            previous: record.name.clone(),
        };
    }
    PublisherVerdict::Known {
        last_pack: record.last_pack_name.clone(),
        first_seen: record.first_seen.clone(),
        pack_count: record.pack_count,
    }
}

/// Pure: fold a successful import into the store. Only `first_seen` survives from the original record.
pub fn record_import(
    known: &mut HashMap<String, KnownPublisher>,
    publisher: &PackPublisher,
    pack_name: &str,
    now: &str,
) {
    let record = known
        .entry(publisher.key_id.clone())
        .or_insert_with(|| KnownPublisher {
            public_key: publisher.public_key.clone(),
            name: publisher.name.clone(),
            organisation: publisher.organisation.clone(),
            first_seen: now.to_owned(),
            last_seen: now.to_owned(),
            pack_count: 0,
            last_pack_name: String::new(),
        });
    record.public_key = publisher.public_key.clone();
    record.name = publisher.name.clone();
    record.organisation = publisher.organisation.clone();
    record.last_seen = now.to_owned();
    record.pack_count = record.pack_count.saturating_add(1);
    record.last_pack_name = pack_name.to_owned();
}

/// Persist an accepted import. Called after the files land, never before.
pub fn remember_publisher(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    publisher: &PackPublisher,
    pack_name: &str,
) -> Result<(), String> {
    let mut settings = load_settings(app, state)?;
    record_import(
        &mut settings.known_publishers,
        publisher,
        pack_name,
        &now_rfc3339(),
    );
    save_settings(app, state, settings)
}

// ── The profile ─────────────────────────────────────────────────────

/// Trim and check a profile, or return the message the pane shows. Empty optional fields become absent, never `""`.
pub fn validate_profile(input: &PublisherProfile) -> Result<PublisherProfile, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Enter a publisher name.".into());
    }
    if name.chars().count() > MAX_PUBLISHER_FIELD {
        return Err(format!(
            "A publisher name is at most {MAX_PUBLISHER_FIELD} characters."
        ));
    }
    let organisation = trimmed(input.organisation.as_deref());
    if organisation
        .as_ref()
        .is_some_and(|org| org.chars().count() > MAX_PUBLISHER_FIELD)
    {
        return Err(format!(
            "An organisation is at most {MAX_PUBLISHER_FIELD} characters."
        ));
    }
    let website = trimmed(input.website.as_deref());
    if let Some(url) = website.as_deref() {
        if url.chars().count() > MAX_WEBSITE_CHARS {
            return Err(format!(
                "A website address is at most {MAX_WEBSITE_CHARS} characters."
            ));
        }
        if !is_web_url(url) {
            return Err("A website must start with http:// or https://".into());
        }
    }
    Ok(PublisherProfile {
        name: name.to_owned(),
        organisation,
        website,
    })
}

fn trimmed(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn is_web_url(value: &str) -> bool {
    if value.chars().any(char::is_control) {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    let Some(rest) = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
    else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !host.chars().any(char::is_whitespace)
}

/// The publisher block for a pack this install is signing. Creates the key if there isn't one: this is the first-sign path.
pub fn manifest_publisher(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
) -> Result<PackPublisher, String> {
    let settings = load_settings(app, state)?;
    let identity = key::ensure_identity(app).map_err(String::from)?;
    let profile = settings.publisher.as_ref();
    Ok(PackPublisher {
        name: profile.map_or_else(os_full_name, |p| p.name.clone()),
        organisation: profile.and_then(|p| p.organisation.clone()),
        website: profile.and_then(|p| p.website.clone()),
        device: device_name(),
        public_key: identity.public_key,
        key_id: identity.key_id,
    })
}

fn profile_view(app: &AppHandle, state: &State<'_, SettingsState>) -> Result<PublisherProfileView, String> {
    let settings = load_settings(app, state)?;
    let key = key::existing_identity(app)
        .map_err(String::from)?
        .map(|identity| PublisherKeyView {
            key_id_display: key::format_key_id(&identity.key_id),
            key_id: identity.key_id,
            public_key: identity.public_key,
        });
    let profile = settings.publisher;
    Ok(PublisherProfileView {
        effective_name: profile
            .as_ref()
            .map_or_else(os_full_name, |p| p.name.clone()),
        organisation: profile.as_ref().and_then(|p| p.organisation.clone()),
        website: profile.as_ref().and_then(|p| p.website.clone()),
        device: device_name(),
        profile,
        key,
    })
}

// ── Commands ────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_publisher_profile(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<PublisherProfileView, String> {
    profile_view(&app, &state)
}

#[tauri::command]
pub fn set_publisher_profile(
    app: AppHandle,
    state: State<'_, SettingsState>,
    profile: PublisherProfile,
) -> Result<PublisherProfileView, String> {
    let clean = validate_profile(&profile)?;
    let mut settings = load_settings(&app, &state)?;
    settings.publisher = Some(clean);
    save_settings(&app, &state, settings)?;
    profile_view(&app, &state)
}

/// Replace the signing key. `known_publishers` is deliberately untouched: rotating changes who *we* look like, not who we trust.
#[tauri::command]
pub fn rotate_publisher_key(app: AppHandle) -> Result<PublisherKeyView, String> {
    let identity = key::rotate_identity(&app).map_err(String::from)?;
    Ok(PublisherKeyView {
        key_id_display: key::format_key_id(&identity.key_id),
        key_id: identity.key_id,
        public_key: identity.public_key,
    })
}

#[tauri::command]
pub fn list_known_publishers(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<KnownPublisherRow>, String> {
    let settings = load_settings(&app, &state)?;
    let mut rows: Vec<KnownPublisherRow> = settings
        .known_publishers
        .into_iter()
        .map(|(key_id, publisher)| KnownPublisherRow {
            key_id_display: key::format_key_id(&key_id),
            key_id,
            publisher,
        })
        .collect();
    rows.sort_by(|a, b| {
        b.publisher
            .last_seen
            .cmp(&a.publisher.last_seen)
            .then_with(|| a.publisher.name.cmp(&b.publisher.name))
    });
    Ok(rows)
}

/// Drop a trust relationship. The next pack from that key reads as first time again.
#[tauri::command]
pub fn forget_publisher(
    app: AppHandle,
    state: State<'_, SettingsState>,
    key_id: String,
) -> Result<(), String> {
    let mut settings = load_settings(&app, &state)?;
    if settings.known_publishers.remove(&key_id).is_none() {
        return Ok(());
    }
    save_settings(&app, &state, settings)
}

// ── macOS identity, best effort ─────────────────────────────────────

fn shell_line(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!text.is_empty()).then_some(text)
}

/// The macOS full user name, falling back to the login name and then a neutral label.
pub fn os_full_name() -> String {
    shell_line("id", &["-F"])
        .or_else(|| std::env::var("USER").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "Kookaburra Cut user".to_owned())
}

/// The Sharing-panel computer name, falling back to the hostname.
pub fn device_name() -> String {
    shell_line("scutil", &["--get", "ComputerName"])
        .or_else(|| shell_line("hostname", &[]))
        .unwrap_or_else(|| "This Mac".to_owned())
}

// ── Timestamps ──────────────────────────────────────────────────────

/// RFC3339 UTC to seconds precision. Hand-rolled: this is the only place in the app that needs a calendar date.
pub fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    rfc3339_from_unix(secs)
}

fn rfc3339_from_unix(secs: u64) -> String {
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let time = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// Howard Hinnant's civil_from_days: days since the unix epoch to a calendar date.
fn civil_from_days(days: i64) -> (i64, u64, u64) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = year_of_era as i64 + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(name: &str, organisation: Option<&str>, website: Option<&str>) -> PublisherProfile {
        PublisherProfile {
            name: name.to_owned(),
            organisation: organisation.map(str::to_owned),
            website: website.map(str::to_owned),
        }
    }

    fn packer(name: &str, key_id: &str, public_key: &str) -> PackPublisher {
        PackPublisher {
            name: name.to_owned(),
            organisation: Some("Acme".to_owned()),
            website: None,
            device: "Acme iMac".to_owned(),
            public_key: public_key.to_owned(),
            key_id: key_id.to_owned(),
        }
    }

    #[test]
    fn profile_validation_table() {
        assert!(validate_profile(&profile("", None, None)).is_err());
        assert!(validate_profile(&profile("   ", None, None)).is_err());
        assert!(validate_profile(&profile(&"a".repeat(65), None, None)).is_err());
        assert!(validate_profile(&profile(&"a".repeat(64), None, None)).is_ok());
        assert!(validate_profile(&profile("Acme", Some(&"o".repeat(65)), None)).is_err());
        assert!(validate_profile(&profile("Acme", None, Some("ftp://acme.test"))).is_err());
        assert!(validate_profile(&profile("Acme", None, Some("acme.test"))).is_err());
        assert!(validate_profile(&profile("Acme", None, Some("https://"))).is_err());

        let clean = validate_profile(&profile(
            "  Acme Studio  ",
            Some("   "),
            Some(" https://acme.test/brand "),
        ))
        .unwrap();
        assert_eq!(clean.name, "Acme Studio");
        assert_eq!(clean.organisation, None);
        assert_eq!(clean.website.as_deref(), Some("https://acme.test/brand"));

        let http = validate_profile(&profile("Acme", Some(" Acme Pty Ltd "), Some("HTTP://acme.test"))).unwrap();
        assert_eq!(http.organisation.as_deref(), Some("Acme Pty Ltd"));
        assert_eq!(http.website.as_deref(), Some("HTTP://acme.test"));
    }

    #[test]
    fn verdict_is_first_time_then_known_then_name_changed() {
        let mut known = HashMap::new();
        let publisher = packer("Acme Studio", "a1b2c3d4e5f60718", "ed25519:AAAA");
        assert_eq!(
            publisher_verdict(&known, &publisher),
            PublisherVerdict::FirstTime
        );

        record_import(&mut known, &publisher, "Acme Brand Kit", "2026-07-26T01:02:03Z");
        assert_eq!(
            publisher_verdict(&known, &publisher),
            PublisherVerdict::Known {
                last_pack: "Acme Brand Kit".to_owned(),
                first_seen: "2026-07-26T01:02:03Z".to_owned(),
                pack_count: 1,
            }
        );

        let renamed = packer("Acme Creative", "a1b2c3d4e5f60718", "ed25519:AAAA");
        assert_eq!(
            publisher_verdict(&known, &renamed),
            PublisherVerdict::NameChanged {
                previous: "Acme Studio".to_owned()
            }
        );

        // Same id, different key: not the same publisher.
        let collided = packer("Acme Studio", "a1b2c3d4e5f60718", "ed25519:BBBB");
        assert_eq!(
            publisher_verdict(&known, &collided),
            PublisherVerdict::FirstTime
        );
    }

    #[test]
    fn recording_keeps_first_seen_and_counts_packs() {
        let mut known = HashMap::new();
        let publisher = packer("Acme Studio", "a1b2c3d4e5f60718", "ed25519:AAAA");
        record_import(&mut known, &publisher, "Kit One", "2026-01-01T00:00:00Z");
        record_import(&mut known, &publisher, "Kit Two", "2026-03-04T05:06:07Z");
        let record = &known["a1b2c3d4e5f60718"];
        assert_eq!(record.first_seen, "2026-01-01T00:00:00Z");
        assert_eq!(record.last_seen, "2026-03-04T05:06:07Z");
        assert_eq!(record.pack_count, 2);
        assert_eq!(record.last_pack_name, "Kit Two");
        assert_eq!(known.len(), 1);
    }

    #[test]
    fn rfc3339_matches_known_instants() {
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_from_unix(1_767_225_599), "2025-12-31T23:59:59Z");
        assert_eq!(rfc3339_from_unix(1_784_000_000), "2026-07-14T03:33:20Z");
    }
}
