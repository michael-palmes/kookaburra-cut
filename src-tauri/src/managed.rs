//! Managed preferences: what an administrator's configuration profile forces on the app's preference domain, read once per process and honoured only while macOS reports the key as forced (`CFPreferencesAppValueIsForced`), so a plain `defaults write` changes nothing. A forced key of the wrong shape fails closed: the feature it governs is treated as turned off, and a `[managed]` log line names the key. The key table and a sample profile live in docs/mdm.md.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

/// The preference domain a profile targets: the bundle id.
pub const DOMAIN: &str = "com.mpalmes.kookaburracut";

/// Every refusal a managed key causes starts with this, so a caller can tell policy from a fault.
pub const REASON_PREFIX: &str = "managed:";

/// A preference value as a reader found it; `Other` names the type for the log line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrefValue {
    Bool(bool),
    String(String),
    Array(Vec<PrefValue>),
    Other(&'static str),
}

impl PrefValue {
    fn kind(&self) -> &'static str {
        match self {
            Self::Bool(_) => "a boolean",
            Self::String(_) => "a string",
            Self::Array(_) => "an array",
            Self::Other(kind) => kind,
        }
    }
}

/// Where forced values come from: CFPreferences in the app, a map in tests.
pub trait PreferenceSource {
    /// The key's value when a configuration profile forces it; `None` when it is unset or set only by the user.
    fn forced(&self, key: &str) -> Option<PrefValue>;
}

impl PreferenceSource for HashMap<&'static str, PrefValue> {
    fn forced(&self, key: &str) -> Option<PrefValue> {
        self.get(key).cloned()
    }
}

/// The keys the app honours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    DisableClaude,
    DisableLiveWebsites,
    AllowedPublisherKeyIds,
    DisableUpdateCheck,
    WorkspaceRoot,
}

impl Key {
    pub const ALL: [Key; 5] = [
        Key::DisableClaude,
        Key::DisableLiveWebsites,
        Key::AllowedPublisherKeyIds,
        Key::DisableUpdateCheck,
        Key::WorkspaceRoot,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Key::DisableClaude => "DisableClaude",
            Key::DisableLiveWebsites => "DisableLiveWebsites",
            Key::AllowedPublisherKeyIds => "AllowedPublisherKeyIds",
            Key::DisableUpdateCheck => "DisableUpdateCheck",
            Key::WorkspaceRoot => "WorkspaceRoot",
        }
    }

    /// The one line a refusal shows.
    fn reason(self) -> &'static str {
        match self {
            Key::DisableClaude => "Claude is turned off by your organisation",
            Key::DisableLiveWebsites => "Live websites are turned off by your organisation",
            Key::AllowedPublisherKeyIds => {
                "Your organisation only allows packs from approved publishers"
            }
            Key::DisableUpdateCheck => "Update checks are turned off by your organisation",
            Key::WorkspaceRoot => "Your organisation sets where projects are kept",
        }
    }

    fn expected(self) -> &'static str {
        match self {
            Key::AllowedPublisherKeyIds => "an array of strings",
            Key::WorkspaceRoot => "an absolute path",
            _ => "a boolean",
        }
    }
}

/// The effective policy: what a profile forces, already failed closed where it was malformed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPolicy {
    /// True when any key is forced.
    pub managed: bool,
    pub disable_claude: bool,
    pub disable_live_websites: bool,
    /// Lower-case 16-hex key ids; `None` when unmanaged, an empty list means no pack imports at all.
    pub allowed_publisher_key_ids: Option<Vec<String>>,
    pub disable_update_check: bool,
    /// The fixed workspace root when the forced value was usable.
    pub workspace_root: Option<String>,
    /// True whenever WorkspaceRoot is forced, usable or not: relocation is refused either way.
    pub workspace_root_locked: bool,
    /// The forced keys by name, for the lock rows and the log.
    pub forced_keys: Vec<String>,
    /// What was wrong with a forced key, one line each; logged, never shown.
    #[serde(skip)]
    pub issues: Vec<String>,
}

impl ManagedPolicy {
    /// Read every key once from `source`.
    pub fn from_source(source: &dyn PreferenceSource) -> Self {
        let mut policy = Self::default();
        for key in Key::ALL {
            let Some(value) = source.forced(key.name()) else {
                continue;
            };
            policy.managed = true;
            policy.forced_keys.push(key.name().to_owned());
            match key {
                Key::DisableClaude => policy.disable_claude = policy.bool_or_closed(key, &value),
                Key::DisableLiveWebsites => {
                    policy.disable_live_websites = policy.bool_or_closed(key, &value)
                }
                Key::DisableUpdateCheck => {
                    policy.disable_update_check = policy.bool_or_closed(key, &value)
                }
                Key::AllowedPublisherKeyIds => {
                    policy.allowed_publisher_key_ids = Some(policy.key_ids_or_closed(&value))
                }
                Key::WorkspaceRoot => {
                    policy.workspace_root_locked = true;
                    policy.workspace_root = policy.root_or_closed(&value, home_dir().as_deref());
                }
            }
        }
        policy
    }

    /// The fixed workspace root as a path.
    pub fn workspace_root_path(&self) -> Option<PathBuf> {
        self.workspace_root.as_deref().map(PathBuf::from)
    }

    fn note(&mut self, key: Key, value: &PrefValue, outcome: &str) {
        self.issues.push(format!(
            "{} is forced but is {} rather than {}; {}",
            key.name(),
            value.kind(),
            key.expected(),
            outcome
        ));
    }

    /// A forced boolean, or closed (true) when the value is anything else.
    fn bool_or_closed(&mut self, key: Key, value: &PrefValue) -> bool {
        match value {
            PrefValue::Bool(flag) => *flag,
            other => {
                self.note(key, other, "treating it as true");
                true
            }
        }
    }

    /// The allow-list, normalised to lower-case hex; a malformed entry is dropped (it allows nothing), anything but an array allows nothing.
    fn key_ids_or_closed(&mut self, value: &PrefValue) -> Vec<String> {
        let PrefValue::Array(items) = value else {
            self.note(Key::AllowedPublisherKeyIds, value, "allowing no packs");
            return Vec::new();
        };
        let mut ids = Vec::new();
        for item in items {
            let PrefValue::String(raw) = item else {
                self.issues.push(format!(
                    "AllowedPublisherKeyIds holds {} where a key id string belongs; ignoring that entry",
                    item.kind()
                ));
                continue;
            };
            match normalise_key_id(raw) {
                Some(id) => {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
                None => self.issues.push(format!(
                    "AllowedPublisherKeyIds entry {raw:?} is not a 16-character hex key id; ignoring it"
                )),
            }
        }
        ids
    }

    /// The forced root when it is an absolute path (a leading `~/` expands against `home`); anything else locks relocation without pinning a path.
    fn root_or_closed(&mut self, value: &PrefValue, home: Option<&Path>) -> Option<String> {
        let PrefValue::String(raw) = value else {
            self.note(
                Key::WorkspaceRoot,
                value,
                "keeping the current location and refusing to move it",
            );
            return None;
        };
        match usable_root(raw, home) {
            Some(root) => Some(root.to_string_lossy().into_owned()),
            None => {
                self.issues.push(format!(
                    "WorkspaceRoot {raw:?} is not an absolute path; keeping the current location and refusing to move it"
                ));
                None
            }
        }
    }
}

/// `a1b2 c3d4 e5f6 0718` and `A1B2C3D4E5F60718` both read as the stored id.
fn normalise_key_id(raw: &str) -> Option<String> {
    let id: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    (id.len() == 16 && id.chars().all(|c| c.is_ascii_hexdigit())).then_some(id)
}

/// Absolute, non-empty and free of `..`; `~` and `~/…` expand against the home folder when one is known.
fn usable_root(raw: &str, home: Option<&Path>) -> Option<PathBuf> {
    let raw = raw.trim();
    let path = if raw == "~" {
        home?.to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home?.join(rest)
    } else {
        PathBuf::from(raw)
    };
    let plain = path
        .components()
        .all(|part| !matches!(part, Component::ParentDir | Component::CurDir));
    (path.is_absolute() && plain && path.file_name().is_some()).then_some(path)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

// ── The process-wide policy ─────────────────────────────────────────

static POLICY: OnceLock<ManagedPolicy> = OnceLock::new();

/// The effective policy, read from CFPreferences on first use and fixed for the life of the process (a profile change takes effect at the next launch, as it does for every managed app).
pub fn policy() -> &'static ManagedPolicy {
    POLICY.get_or_init(|| ManagedPolicy::from_source(&system_source()))
}

#[cfg(target_os = "macos")]
fn system_source() -> impl PreferenceSource {
    cf::CfSource
}

#[cfg(not(target_os = "macos"))]
fn system_source() -> impl PreferenceSource {
    HashMap::<&'static str, PrefValue>::new()
}

/// One `[managed]` line for the forced keys and one per malformed one, at boot; stderr like the other modules' lines, so a packaged app reports it too.
pub fn log_at_boot() {
    let policy = policy();
    if !policy.managed {
        return;
    }
    eprintln!(
        "[managed] configuration profile forces: {}",
        policy.forced_keys.join(", ")
    );
    for issue in &policy.issues {
        eprintln!("[managed] {issue}");
    }
}

/// The error a refused command returns: the reason, then the key, so support can find the profile.
pub fn refusal(key: Key) -> String {
    format!("{REASON_PREFIX} {} ({}).", key.reason(), key.name())
}

// ── Guards: each command that a key governs calls one of these first ─

pub fn deny_claude_in(policy: &ManagedPolicy) -> Result<(), String> {
    if policy.disable_claude {
        return Err(refusal(Key::DisableClaude));
    }
    Ok(())
}

pub fn deny_live_websites_in(policy: &ManagedPolicy) -> Result<(), String> {
    if policy.disable_live_websites {
        return Err(refusal(Key::DisableLiveWebsites));
    }
    Ok(())
}

pub fn deny_update_check_in(policy: &ManagedPolicy) -> Result<(), String> {
    if policy.disable_update_check {
        return Err(refusal(Key::DisableUpdateCheck));
    }
    Ok(())
}

pub fn deny_workspace_change_in(policy: &ManagedPolicy) -> Result<(), String> {
    if policy.workspace_root_locked {
        return Err(refusal(Key::WorkspaceRoot));
    }
    Ok(())
}

/// `key_id` is the id recomputed from the pack's public key, never the one the manifest declares; `None` (an unparseable key) is refused whenever a list is forced.
pub fn deny_publisher_in(policy: &ManagedPolicy, key_id: Option<&str>) -> Result<(), String> {
    let Some(allowed) = &policy.allowed_publisher_key_ids else {
        return Ok(());
    };
    if allowed.is_empty() {
        return Err(format!(
            "{REASON_PREFIX} Your organisation doesn't allow pack imports ({}).",
            Key::AllowedPublisherKeyIds.name()
        ));
    }
    let id = key_id.and_then(normalise_key_id);
    if id.is_some_and(|id| allowed.contains(&id)) {
        return Ok(());
    }
    Err(refusal(Key::AllowedPublisherKeyIds))
}

pub fn deny_claude() -> Result<(), String> {
    deny_claude_in(policy())
}

pub fn deny_live_websites() -> Result<(), String> {
    deny_live_websites_in(policy())
}

pub fn deny_update_check() -> Result<(), String> {
    deny_update_check_in(policy())
}

pub fn deny_workspace_change() -> Result<(), String> {
    deny_workspace_change_in(policy())
}

pub fn deny_publisher(key_id: Option<&str>) -> Result<(), String> {
    deny_publisher_in(policy(), key_id)
}

/// The effective policy for the webviews, which hide or lock what it governs.
#[tauri::command]
pub fn managed_policy() -> ManagedPolicy {
    policy().clone()
}

// ── CFPreferences ───────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod cf {
    use super::{PrefValue, PreferenceSource, DOMAIN};
    use objc2_core_foundation::{
        CFArray, CFBoolean, CFNumber, CFPreferencesAppValueIsForced, CFPreferencesCopyAppValue,
        CFRetained, CFString, CFType, Type,
    };

    pub struct CfSource;

    impl PreferenceSource for CfSource {
        fn forced(&self, key: &str) -> Option<PrefValue> {
            let key = CFString::from_str(key);
            let domain = CFString::from_str(DOMAIN);
            if !CFPreferencesAppValueIsForced(&key, &domain) {
                return None;
            }
            let value = CFPreferencesCopyAppValue(&key, &domain)?;
            Some(convert(&value))
        }
    }

    fn convert(value: &CFType) -> PrefValue {
        if let Some(flag) = value.downcast_ref::<CFBoolean>() {
            return PrefValue::Bool(flag.as_bool());
        }
        if let Some(text) = value.downcast_ref::<CFString>() {
            return PrefValue::String(text.to_string());
        }
        if let Some(items) = value.downcast_ref::<CFArray>() {
            // SAFETY: a property-list array holds CF objects only, so every element is a CFType.
            let items: CFRetained<CFArray<CFType>> =
                unsafe { CFRetained::cast_unchecked(items.retain()) };
            return PrefValue::Array(items.iter().map(|item| convert(&item)).collect());
        }
        if value.downcast_ref::<CFNumber>().is_some() {
            return PrefValue::Other("a number");
        }
        PrefValue::Other("a value of another type")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forced(entries: &[(&'static str, PrefValue)]) -> ManagedPolicy {
        let source: HashMap<&'static str, PrefValue> = entries.iter().cloned().collect();
        ManagedPolicy::from_source(&source)
    }

    fn strings(items: &[&str]) -> PrefValue {
        PrefValue::Array(
            items
                .iter()
                .map(|s| PrefValue::String((*s).to_owned()))
                .collect(),
        )
    }

    #[test]
    fn nothing_forced_is_the_unmanaged_default() {
        let policy = forced(&[]);
        assert_eq!(policy, ManagedPolicy::default());
        assert!(!policy.managed);
        assert!(deny_claude_in(&policy).is_ok());
        assert!(deny_live_websites_in(&policy).is_ok());
        assert!(deny_update_check_in(&policy).is_ok());
        assert!(deny_workspace_change_in(&policy).is_ok());
        assert!(deny_publisher_in(&policy, Some("a1b2c3d4e5f60718")).is_ok());
        assert!(deny_publisher_in(&policy, None).is_ok());
    }

    #[test]
    fn a_source_that_reports_nothing_forced_changes_nothing() {
        // The CF source answers None for a plain `defaults write`; this is that answer.
        struct Unforced;
        impl PreferenceSource for Unforced {
            fn forced(&self, _key: &str) -> Option<PrefValue> {
                None
            }
        }
        assert_eq!(
            ManagedPolicy::from_source(&Unforced),
            ManagedPolicy::default()
        );
    }

    #[test]
    fn forced_booleans_are_honoured_both_ways() {
        let on = forced(&[
            ("DisableClaude", PrefValue::Bool(true)),
            ("DisableLiveWebsites", PrefValue::Bool(true)),
            ("DisableUpdateCheck", PrefValue::Bool(true)),
        ]);
        assert!(on.managed);
        assert!(on.disable_claude && on.disable_live_websites && on.disable_update_check);
        assert_eq!(
            on.forced_keys,
            vec!["DisableClaude", "DisableLiveWebsites", "DisableUpdateCheck"]
        );
        assert!(on.issues.is_empty());

        let off = forced(&[
            ("DisableClaude", PrefValue::Bool(false)),
            ("DisableLiveWebsites", PrefValue::Bool(false)),
            ("DisableUpdateCheck", PrefValue::Bool(false)),
        ]);
        assert!(
            off.managed,
            "a forced false still marks the install as managed"
        );
        assert!(!off.disable_claude && !off.disable_live_websites && !off.disable_update_check);
        assert!(deny_claude_in(&off).is_ok());
    }

    #[test]
    fn a_wrong_typed_boolean_fails_closed_and_names_the_key() {
        let policy = forced(&[
            ("DisableClaude", PrefValue::String("yes".into())),
            ("DisableUpdateCheck", PrefValue::Other("a number")),
        ]);
        assert!(policy.disable_claude);
        assert!(policy.disable_update_check);
        assert_eq!(policy.issues.len(), 2);
        assert!(policy.issues[0].starts_with("DisableClaude is forced but is a string"));
        assert!(policy.issues[1].starts_with("DisableUpdateCheck is forced but is a number"));
    }

    #[test]
    fn publisher_lists_normalise_and_drop_malformed_entries() {
        let policy = forced(&[(
            "AllowedPublisherKeyIds",
            PrefValue::Array(vec![
                PrefValue::String("A1B2 C3D4 E5F6 0718".into()),
                PrefValue::String("a1b2c3d4e5f60718".into()),
                PrefValue::String("not-a-key".into()),
                PrefValue::Bool(true),
                PrefValue::String("00112233445566778".into()),
            ]),
        )]);
        assert_eq!(
            policy.allowed_publisher_key_ids,
            Some(vec!["a1b2c3d4e5f60718".to_owned()])
        );
        assert_eq!(policy.issues.len(), 3);
        assert!(deny_publisher_in(&policy, Some("a1b2c3d4e5f60718")).is_ok());
        assert!(deny_publisher_in(&policy, Some("A1B2C3D4E5F60718")).is_ok());
        let refused = deny_publisher_in(&policy, Some("0011223344556677")).unwrap_err();
        assert!(refused.starts_with(REASON_PREFIX));
        assert!(refused.contains("AllowedPublisherKeyIds"));
        assert!(deny_publisher_in(&policy, None).is_err());
    }

    #[test]
    fn an_empty_or_wrong_typed_publisher_list_allows_no_packs() {
        let empty = forced(&[("AllowedPublisherKeyIds", strings(&[]))]);
        assert_eq!(empty.allowed_publisher_key_ids, Some(Vec::new()));
        let refused = deny_publisher_in(&empty, Some("a1b2c3d4e5f60718")).unwrap_err();
        assert!(refused.starts_with(REASON_PREFIX));
        assert!(refused.contains("doesn't allow pack imports"));

        let wrong = forced(&[(
            "AllowedPublisherKeyIds",
            PrefValue::String("a1b2c3d4e5f60718".into()),
        )]);
        assert_eq!(wrong.allowed_publisher_key_ids, Some(Vec::new()));
        assert!(wrong.issues[0].starts_with("AllowedPublisherKeyIds is forced but is a string"));
        assert!(deny_publisher_in(&wrong, Some("a1b2c3d4e5f60718")).is_err());
    }

    #[test]
    fn workspace_root_pins_an_absolute_path_and_locks_on_anything_else() {
        let pinned = forced(&[(
            "WorkspaceRoot",
            PrefValue::String("/Users/Shared/Videos".into()),
        )]);
        assert_eq!(
            pinned.workspace_root.as_deref(),
            Some("/Users/Shared/Videos")
        );
        assert!(pinned.workspace_root_locked);
        let refused = deny_workspace_change_in(&pinned).unwrap_err();
        assert!(refused.starts_with(REASON_PREFIX) && refused.contains("WorkspaceRoot"));

        for bad in [
            PrefValue::String("Videos".into()),
            PrefValue::String("/Users/Shared/../Videos".into()),
            PrefValue::String("   ".into()),
            PrefValue::String("/".into()),
            PrefValue::Bool(true),
        ] {
            let locked = forced(&[("WorkspaceRoot", bad.clone())]);
            assert_eq!(locked.workspace_root, None, "{bad:?}");
            assert!(locked.workspace_root_locked, "{bad:?}");
            assert_eq!(locked.issues.len(), 1, "{bad:?}");
            assert!(locked.issues[0].starts_with("WorkspaceRoot"), "{bad:?}");
            assert!(deny_workspace_change_in(&locked).is_err());
        }
    }

    #[test]
    fn tilde_roots_expand_against_the_home_folder_only() {
        let mut policy = ManagedPolicy::default();
        let home = Path::new("/Users/x");
        assert_eq!(
            policy.root_or_closed(&PrefValue::String("~/Kookaburra Cut".into()), Some(home)),
            Some("/Users/x/Kookaburra Cut".to_owned())
        );
        assert_eq!(
            policy.root_or_closed(&PrefValue::String("~/Kookaburra Cut".into()), None),
            None
        );
        assert_eq!(
            policy.root_or_closed(&PrefValue::String("~someone/Videos".into()), Some(home)),
            None
        );
    }

    #[test]
    fn every_refusal_carries_the_managed_reason_and_the_key() {
        let policy = forced(&[
            ("DisableClaude", PrefValue::Bool(true)),
            ("DisableLiveWebsites", PrefValue::Bool(true)),
            ("DisableUpdateCheck", PrefValue::Bool(true)),
            (
                "WorkspaceRoot",
                PrefValue::String("/Users/Shared/Videos".into()),
            ),
            ("AllowedPublisherKeyIds", strings(&["a1b2c3d4e5f60718"])),
        ]);
        let refusals = [
            (deny_claude_in(&policy), "DisableClaude"),
            (deny_live_websites_in(&policy), "DisableLiveWebsites"),
            (deny_update_check_in(&policy), "DisableUpdateCheck"),
            (deny_workspace_change_in(&policy), "WorkspaceRoot"),
            (
                deny_publisher_in(&policy, Some("0011223344556677")),
                "AllowedPublisherKeyIds",
            ),
        ];
        for (outcome, key) in refusals {
            let message = outcome.unwrap_err();
            assert!(message.starts_with(REASON_PREFIX), "{message}");
            assert!(message.contains(key), "{message}");
            assert!(
                message.to_lowercase().contains("your organisation"),
                "{message}"
            );
        }
    }

    /// The body of `fn name(` in `src`, up to its closing brace at column zero.
    fn body_of<'a>(src: &'a str, name: &str) -> &'a str {
        let start = src
            .find(&format!("fn {name}("))
            .unwrap_or_else(|| panic!("no fn {name}"));
        let end = src[start..].find("\n}\n").expect("fn end") + start;
        &src[start..end]
    }

    #[test]
    fn every_governed_command_calls_its_guard() {
        let guarded = [
            (
                include_str!("claude_app.rs"),
                "open_in_claude",
                "deny_claude",
            ),
            (
                include_str!("claude_app.rs"),
                "open_claude_download",
                "deny_claude",
            ),
            (
                include_str!("claude_update.rs"),
                "claude_version_info",
                "deny_claude",
            ),
            (include_str!("pty.rs"), "pty_spawn", "deny_claude"),
            (
                include_str!("website.rs"),
                "website_open",
                "deny_live_websites",
            ),
            (
                include_str!("updater.rs"),
                "check_for_update",
                "deny_update_check",
            ),
            (
                include_str!("updater.rs"),
                "set_update_consent",
                "deny_update_check",
            ),
            (
                include_str!("updater.rs"),
                "install_update_and_relaunch",
                "deny_update_check",
            ),
            (
                include_str!("workspace.rs"),
                "init_workspace",
                "deny_workspace_change",
            ),
            (
                include_str!("workspace.rs"),
                "move_workspace",
                "deny_workspace_change",
            ),
            (
                include_str!("pack/commands.rs"),
                "inspect_pack",
                "deny_managed_publisher",
            ),
            (
                include_str!("pack/commands.rs"),
                "stage_pack",
                "deny_managed_publisher",
            ),
        ];
        for (src, command, guard) in guarded {
            assert!(
                body_of(src, command).contains(&format!("{guard}(")),
                "{command} no longer calls {guard}"
            );
        }
        assert!(
            body_of(include_str!("pack/commands.rs"), "deny_managed_publisher")
                .contains("crate::managed::deny_publisher(key::key_id_of(")
        );
    }

    #[test]
    fn the_policy_reaches_the_wire_as_camel_case_without_the_issues() {
        let policy = forced(&[
            ("DisableClaude", PrefValue::String("oops".into())),
            ("AllowedPublisherKeyIds", strings(&["a1b2c3d4e5f60718"])),
        ]);
        let json = serde_json::to_value(&policy).unwrap();
        assert_eq!(json["managed"], true);
        assert_eq!(json["disableClaude"], true);
        assert_eq!(json["disableLiveWebsites"], false);
        assert_eq!(
            json["allowedPublisherKeyIds"],
            serde_json::json!(["a1b2c3d4e5f60718"])
        );
        assert_eq!(json["workspaceRoot"], serde_json::Value::Null);
        assert_eq!(json["workspaceRootLocked"], false);
        assert_eq!(
            json["forcedKeys"],
            serde_json::json!(["DisableClaude", "AllowedPublisherKeyIds"])
        );
        assert!(json.get("issues").is_none());
    }
}
