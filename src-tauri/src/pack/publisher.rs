//! Who a pack says it came from, and who this Mac has accepted packs from before.
//!
//! Two halves: the Settings-owned profile stamped into every pack we sign, and the trust-on-first-use store keyed by
//! the id derived from the pack's public key (never the id the manifest declares) and cross-checked by name. Neither
//! half ever treats a declared name as verified: only the signature is evidence.

use super::key;
use super::model::PackPublisher;
use crate::workspace::{
    load_settings, update_settings, KnownPublisher, PublisherProfile, SettingsState,
};
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
    /// The name a pack signed right now would carry; absent until a profile is saved, and the packs window asks for one.
    pub effective_name: Option<String>,
    pub organisation: Option<String>,
    pub website: Option<String>,
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
    /// The login Keychain, or the 0600 file where the Keychain could not answer.
    pub stored_in: key::KeyStorage,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownPublisherRow {
    pub key_id: String,
    pub key_id_display: String,
    #[serde(flatten)]
    pub publisher: KnownPublisher,
}

/// What the import screen says about the publisher of the pack in hand. `rename_all` alone renames the variants; the struct-variant FIELDS need `rename_all_fields` to reach the frontend as camelCase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
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
    /// An unknown key declaring a name this Mac already knows under another key: the shape of someone borrowing a name.
    KeyChanged {
        known_as: String,
        previous_key_id: String,
        last_pack: String,
    },
}

/// Names compare trimmed, case-folded and with runs of whitespace collapsed, so "Acme  Studio" cannot pose as "acme studio".
pub fn same_publisher_name(a: &str, b: &str) -> bool {
    let fold = |s: &str| {
        s.split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>()
            .join(" ")
    };
    !a.trim().is_empty() && fold(a) == fold(b)
}

// ── Verdicts and the trust store ────────────────────────────────────

/// The store's key for a publisher: the id its public key hashes to. `None` when the key does not parse, which the reader refuses before anything reaches here.
fn store_key(publisher: &PackPublisher) -> Option<String> {
    key::key_id_of(&publisher.public_key)
}

/// Pure: the verdict for a manifest publisher against the store. A key the store does not hold (or holds under another public key, since a key id is a truncated hash) is first time, unless the declared name is one a different key already uses here.
pub fn publisher_verdict(
    known: &HashMap<String, KnownPublisher>,
    publisher: &PackPublisher,
) -> PublisherVerdict {
    let record = store_key(publisher)
        .and_then(|id| known.get(&id))
        .filter(|record| record.public_key == publisher.public_key);
    let Some(record) = record else {
        let mut by_name: Vec<_> = known
            .iter()
            .filter(|(_, record)| same_publisher_name(&record.name, &publisher.name))
            .collect();
        by_name.sort_by(|a, b| b.1.last_seen.cmp(&a.1.last_seen));
        return match by_name.first() {
            Some((key_id, record)) => PublisherVerdict::KeyChanged {
                known_as: record.name.clone(),
                previous_key_id: (*key_id).clone(),
                last_pack: record.last_pack_name.clone(),
            },
            None => PublisherVerdict::FirstTime,
        };
    };
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
    let Some(id) = store_key(publisher) else {
        return;
    };
    let record = known.entry(id).or_insert_with(|| KnownPublisher {
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

/// Pure: re-key every record by the id its stored public key derives, once, for stores written when the manifest's declared id was the key. A record whose key does not parse can never match a verdict and is dropped; where two records derive one id, the one already under it stays. Returns whether anything changed.
pub fn migrate_known_publishers(known: &mut HashMap<String, KnownPublisher>) -> bool {
    let stale: Vec<String> = known
        .iter()
        .filter(|(id, record)| key::key_id_of(&record.public_key).as_ref() != Some(id))
        .map(|(id, _)| id.clone())
        .collect();
    for id in &stale {
        let Some(record) = known.remove(id) else {
            continue;
        };
        if let Some(derived) = key::key_id_of(&record.public_key) {
            known.entry(derived).or_insert(record);
        }
    }
    !stale.is_empty()
}

/// The store as every reader sees it: migrated on first read and written back when that changed anything.
pub fn known_publishers(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
) -> Result<HashMap<String, KnownPublisher>, String> {
    let mut known = load_settings(app, state)?.known_publishers;
    if migrate_known_publishers(&mut known) {
        let migrated = known.clone();
        update_settings(app, state, |settings| settings.known_publishers = migrated)?;
    }
    Ok(known)
}

/// Persist an accepted import. Called after the files land, never before.
pub fn remember_publisher(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    publisher: &PackPublisher,
    pack_name: &str,
) -> Result<(), String> {
    let now = now_rfc3339();
    update_settings(app, state, |settings| {
        migrate_known_publishers(&mut settings.known_publishers);
        record_import(&mut settings.known_publishers, publisher, pack_name, &now);
    })
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

/// The publisher block for a pack this install is signing. Creates the key if there isn't one: this is the first-sign path. With no saved profile the name comes from `name_override` (the packs window asks for it, the round trip supplies one) and is never guessed from the account.
pub fn manifest_publisher(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
    name_override: Option<&str>,
) -> Result<PackPublisher, String> {
    let settings = load_settings(app, state)?;
    let profile = settings.publisher.as_ref();
    let name = match profile {
        Some(profile) => profile.name.clone(),
        None => {
            let name = name_override.map(str::trim).unwrap_or_default();
            if name.is_empty() {
                return Err(super::error::PackError::PublisherNameMissing.into());
            }
            validate_profile(&PublisherProfile {
                name: name.to_owned(),
                organisation: None,
                website: None,
            })?
            .name
        }
    };
    let identity = key::ensure_identity(app).map_err(String::from)?;
    Ok(PackPublisher {
        name,
        organisation: profile.and_then(|p| p.organisation.clone()),
        website: profile.and_then(|p| p.website.clone()),
        device: device_name(),
        public_key: identity.public_key,
        key_id: identity.key_id,
    })
}

fn profile_view(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
) -> Result<PublisherProfileView, String> {
    let settings = load_settings(app, state)?;
    let key = key::existing_identity(app)
        .map_err(String::from)?
        .map(|(identity, stored_in)| PublisherKeyView {
            key_id_display: key::format_key_id(&identity.key_id),
            key_id: identity.key_id,
            public_key: identity.public_key,
            stored_in,
        });
    let profile = settings.publisher;
    Ok(PublisherProfileView {
        effective_name: profile.as_ref().map(|p| p.name.clone()),
        organisation: profile.as_ref().and_then(|p| p.organisation.clone()),
        website: profile.as_ref().and_then(|p| p.website.clone()),
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
    update_settings(&app, &state, |settings| settings.publisher = Some(clean))?;
    profile_view(&app, &state)
}

/// Replace the signing key. `known_publishers` is deliberately untouched: rotating changes who *we* look like, not who we trust.
#[tauri::command]
pub fn rotate_publisher_key(app: AppHandle) -> Result<PublisherKeyView, String> {
    key::rotate_identity(&app).map_err(String::from)?;
    key::existing_identity(&app)
        .map_err(String::from)?
        .map(|(identity, stored_in)| PublisherKeyView {
            key_id_display: key::format_key_id(&identity.key_id),
            key_id: identity.key_id,
            public_key: identity.public_key,
            stored_in,
        })
        .ok_or_else(|| "the new signing key could not be read back".to_owned())
}

#[tauri::command]
pub fn list_known_publishers(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<KnownPublisherRow>, String> {
    let mut rows: Vec<KnownPublisherRow> = known_publishers(&app, &state)?
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
    update_settings(&app, &state, |settings| {
        settings.known_publishers.remove(&key_id);
    })
}

// ── Device ──────────────────────────────────────────────────────────

/// What a pack says it was made on. The computer name is often a person's name and never left by choice, so it is not read.
pub fn device_name() -> String {
    "Mac".to_owned()
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
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
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

    /// A real key pair from a seed, so the store's derived id has something to derive.
    fn keyed(seed: u8) -> (String, String) {
        let key = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        let public_key = format!(
            "ed25519:{}",
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key.verifying_key().to_bytes())
        );
        let key_id = key::key_id_of(&public_key).expect("a real key derives an id");
        (key_id, public_key)
    }

    fn packer(name: &str, seed: u8) -> PackPublisher {
        let (key_id, public_key) = keyed(seed);
        PackPublisher {
            name: name.to_owned(),
            organisation: Some("Acme".to_owned()),
            website: None,
            device: "Mac".to_owned(),
            public_key,
            key_id,
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

        let http = validate_profile(&profile(
            "Acme",
            Some(" Acme Pty Ltd "),
            Some("HTTP://acme.test"),
        ))
        .unwrap();
        assert_eq!(http.organisation.as_deref(), Some("Acme Pty Ltd"));
        assert_eq!(http.website.as_deref(), Some("HTTP://acme.test"));
    }

    #[test]
    fn verdict_is_first_time_then_known_then_name_changed() {
        let mut known = HashMap::new();
        let publisher = packer("Acme Studio", 1);
        assert_eq!(
            publisher_verdict(&known, &publisher),
            PublisherVerdict::FirstTime
        );

        record_import(
            &mut known,
            &publisher,
            "Acme Brand Kit",
            "2026-07-26T01:02:03Z",
        );
        assert_eq!(
            publisher_verdict(&known, &publisher),
            PublisherVerdict::Known {
                last_pack: "Acme Brand Kit".to_owned(),
                first_seen: "2026-07-26T01:02:03Z".to_owned(),
                pack_count: 1,
            }
        );

        let renamed = packer("Acme Creative", 1);
        assert_eq!(
            publisher_verdict(&known, &renamed),
            PublisherVerdict::NameChanged {
                previous: "Acme Studio".to_owned()
            }
        );

        // A different key declaring the known key's id: the store is keyed by what the key derives, so it is a stranger
        // wearing a known name, never that publisher.
        let mut collided = packer("Acme Studio", 2);
        collided.key_id = publisher.key_id.clone();
        assert_eq!(
            publisher_verdict(&known, &collided),
            PublisherVerdict::KeyChanged {
                known_as: "Acme Studio".to_owned(),
                previous_key_id: publisher.key_id.clone(),
                last_pack: "Acme Brand Kit".to_owned(),
            }
        );
    }

    #[test]
    fn the_store_is_keyed_by_the_derived_id_and_migrates_declared_ones() {
        let mut known = HashMap::new();
        let acme = packer("Acme Studio", 1);
        let mut declared_wrong = acme.clone();
        declared_wrong.key_id = "ffffffffffffffff".to_owned();
        record_import(&mut known, &declared_wrong, "Kit", "2026-01-01T00:00:00Z");
        assert!(known.contains_key(&acme.key_id), "recorded under the derived id");
        assert!(!known.contains_key("ffffffffffffffff"));

        // A store written by an older build keyed by the declared id, plus one record whose key does not parse.
        let mut legacy = HashMap::new();
        legacy.insert("ffffffffffffffff".to_owned(), known[&acme.key_id].clone());
        legacy.insert(
            "0000000000000000".to_owned(),
            KnownPublisher {
                public_key: "ed25519:not-a-key".to_owned(),
                name: "Ghost".to_owned(),
                organisation: None,
                first_seen: "2026-01-01T00:00:00Z".to_owned(),
                last_seen: "2026-01-01T00:00:00Z".to_owned(),
                pack_count: 1,
                last_pack_name: "Kit".to_owned(),
            },
        );
        assert!(migrate_known_publishers(&mut legacy));
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[&acme.key_id].name, "Acme Studio");
        assert!(!migrate_known_publishers(&mut legacy), "a migrated store is left alone");
        assert!(matches!(
            publisher_verdict(&legacy, &acme),
            PublisherVerdict::Known { .. }
        ));
    }

    #[test]
    fn a_known_name_under_a_new_key_is_a_key_change_not_a_first_time() {
        let mut known = HashMap::new();
        let acme = packer("Acme Studio", 1);
        record_import(&mut known, &acme, "Acme Brand Kit", "2026-07-26T01:02:03Z");

        let borrowed = packer("  acme   STUDIO ", 3);
        assert_eq!(
            publisher_verdict(&known, &borrowed),
            PublisherVerdict::KeyChanged {
                known_as: "Acme Studio".to_owned(),
                previous_key_id: acme.key_id.clone(),
                last_pack: "Acme Brand Kit".to_owned(),
            }
        );
        let stranger = packer("Beta Films", 3);
        assert_eq!(
            publisher_verdict(&known, &stranger),
            PublisherVerdict::FirstTime
        );
        // Accepting the new key records it beside the old one; both then read as known.
        record_import(&mut known, &borrowed, "Acme Kit 2", "2026-08-01T00:00:00Z");
        assert_eq!(known.len(), 2);
        assert!(matches!(
            publisher_verdict(&known, &borrowed),
            PublisherVerdict::Known { .. }
        ));
        assert!(matches!(
            publisher_verdict(&known, &acme),
            PublisherVerdict::Known { .. }
        ));
        assert!(same_publisher_name("Acme Studio", "acme\tstudio"));
        assert!(!same_publisher_name("", ""));
    }

    #[test]
    fn recording_keeps_first_seen_and_counts_packs() {
        let mut known = HashMap::new();
        let publisher = packer("Acme Studio", 1);
        record_import(&mut known, &publisher, "Kit One", "2026-01-01T00:00:00Z");
        record_import(&mut known, &publisher, "Kit Two", "2026-03-04T05:06:07Z");
        let record = &known[&publisher.key_id];
        assert_eq!(record.first_seen, "2026-01-01T00:00:00Z");
        assert_eq!(record.last_seen, "2026-03-04T05:06:07Z");
        assert_eq!(record.pack_count, 2);
        assert_eq!(record.last_pack_name, "Kit Two");
        assert_eq!(known.len(), 1);
    }

    #[test]
    fn verdict_fields_reach_the_wire_as_camel_case() {
        let known = serde_json::to_string(&PublisherVerdict::Known {
            last_pack: "Acme Brand Kit".to_owned(),
            first_seen: "2026-07-26T01:02:03Z".to_owned(),
            pack_count: 3,
        })
        .unwrap();
        assert_eq!(
            known,
            r#"{"kind":"known","lastPack":"Acme Brand Kit","firstSeen":"2026-07-26T01:02:03Z","packCount":3}"#
        );
        let renamed = serde_json::to_string(&PublisherVerdict::NameChanged {
            previous: "Acme Studio".to_owned(),
        })
        .unwrap();
        assert_eq!(
            renamed,
            r#"{"kind":"nameChanged","previous":"Acme Studio"}"#
        );
        assert_eq!(
            serde_json::to_string(&PublisherVerdict::FirstTime).unwrap(),
            r#"{"kind":"firstTime"}"#
        );
        let borrowed = serde_json::to_string(&PublisherVerdict::KeyChanged {
            known_as: "Acme Studio".to_owned(),
            previous_key_id: "a1b2c3d4e5f60718".to_owned(),
            last_pack: "Acme Brand Kit".to_owned(),
        })
        .unwrap();
        assert_eq!(
            borrowed,
            r#"{"kind":"keyChanged","knownAs":"Acme Studio","previousKeyId":"a1b2c3d4e5f60718","lastPack":"Acme Brand Kit"}"#
        );
    }

    #[test]
    fn rfc3339_matches_known_instants() {
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_from_unix(1_767_225_599), "2025-12-31T23:59:59Z");
        assert_eq!(rfc3339_from_unix(1_784_000_000), "2026-07-14T03:33:20Z");
    }
}
