//! The one gate on what the app lays out for an agent: the kit in a project, `_bridge` and the Claude handoff. A configuration profile's `DisableAgentKit` closes it first, then `RequireManagedClaude` where Claude Code's own managed policy pins no organisation (claude_policy.rs); after that it opens only once a person has turned Claude on, and an unanswered question counts as off. The answer is mirrored here from `settings.json` at boot and by `set_claude_consent`, since several callers hold no app handle.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::workspace::{self, SettingsState};

const UNDECIDED: u8 = 0;
const OFF: u8 = 1;
const ON: u8 = 2;

static CONSENT: AtomicU8 = AtomicU8::new(UNDECIDED);

/// What a refusal says while Claude is off by the person's own answer, or none yet.
pub const OFF_REASON: &str = "Claude is off. Turn it on in Settings ▸ Claude";

/// Told to every window when the answer changes.
pub const CHANGED_EVENT: &str = "kookaburra://claude-consent-changed";

fn encode(consent: Option<bool>) -> u8 {
    match consent {
        None => UNDECIDED,
        Some(false) => OFF,
        Some(true) => ON,
    }
}

/// Record the stored answer for every caller that reads the gate.
pub fn note(consent: Option<bool>) {
    CONSENT.store(encode(consent), Ordering::SeqCst);
}

/// The stored answer: `None` until a person gives one.
pub fn consent() -> Option<bool> {
    match CONSENT.load(Ordering::SeqCst) {
        ON => Some(true),
        OFF => Some(false),
        _ => None,
    }
}

/// A debug build takes `KOOKABURRA_CLAUDE=1` as the answer, for throwaway-home dev runs; a release build never reads it.
fn dev_override() -> bool {
    static SET: OnceLock<bool> = OnceLock::new();
    *SET.get_or_init(|| {
        cfg!(debug_assertions)
            && std::env::var("KOOKABURRA_CLAUDE").is_ok_and(|value| value.trim() == "1")
    })
}

/// Whether Claude is turned on: the stored answer, or the dev override.
pub fn turned_on() -> bool {
    consent() == Some(true) || dev_override()
}

/// The gate over injected inputs: the profile's `DisableAgentKit`, its `RequireManagedClaude` against whether an organisation is pinned, then the person's answer.
pub fn deny_in(
    policy: &crate::managed::ManagedPolicy,
    org_pinned: bool,
    turned_on: bool,
) -> Result<(), String> {
    crate::managed::deny_agent_kit_in(policy)?;
    crate::managed::deny_unmanaged_claude_in(policy, org_pinned)?;
    if turned_on {
        Ok(())
    } else {
        Err(OFF_REASON.to_owned())
    }
}

/// Whether the organisation's own Claude Code policy is in place, read (and cached) only where a profile asks for it.
fn org_pinned() -> bool {
    !crate::managed::policy().require_managed_claude || crate::claude_policy::org_pinned()
}

/// Refuses while the agent kit is managed off, the organisation's Claude policy is required and missing, or Claude is not turned on.
pub fn deny() -> Result<(), String> {
    deny_in(crate::managed::policy(), org_pinned(), turned_on())
}

/// Where `RequireManagedClaude` stands on this Mac.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OrgPolicy {
    /// No profile asks for it.
    NotRequired,
    /// Asked for, and Claude Code's managed policy pins an organisation.
    Found,
    /// Asked for, and nothing on this Mac pins one: Claude stays off.
    Missing,
}

pub fn org_policy() -> OrgPolicy {
    if !crate::managed::policy().require_managed_claude {
        OrgPolicy::NotRequired
    } else if crate::claude_policy::org_pinned() {
        OrgPolicy::Found
    } else {
        OrgPolicy::Missing
    }
}

/// A profile's `DisableAgentKit`: the gate can't open in this launch, whatever a person answers.
pub fn managed_off() -> bool {
    crate::managed::deny_agent_kit().is_err()
}

/// Read the stored answer once at boot, before the bridge decides whether it serves.
pub fn load_at_boot(app: &AppHandle) {
    let stored = workspace::load_settings(app, &app.state::<SettingsState>())
        .ok()
        .and_then(|settings| settings.claude_consent);
    note(stored);
    let state = match (managed_off(), stored, dev_override()) {
        (true, _, _) => "off (DisableAgentKit)",
        (false, _, true) => "on (KOOKABURRA_CLAUDE=1)",
        (false, Some(true), false) => "on",
        (false, Some(false), false) => "off",
        (false, None, false) => "off (not answered yet)",
    };
    match org_policy() {
        OrgPolicy::NotRequired => log::info!("[claude] {state}"),
        OrgPolicy::Found => log::info!(
            "[claude] {state}; the organisation's Claude Code policy is on this Mac (RequireManagedClaude)"
        ),
        OrgPolicy::Missing => log::info!(
            "[claude] off: the organisation's Claude Code policy is not on this Mac (RequireManagedClaude)"
        ),
    }
}

/// What the windows read to show or hide every Claude entry point.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    /// The stored answer; null until a person gives one.
    pub consent: Option<bool>,
    /// The gate is open: the kit, the bridge and the handoff may run.
    pub allowed: bool,
    /// Why not, when it is closed.
    pub reason: Option<String>,
    /// Whether a profile asks for the organisation's own Claude Code policy, and whether it is here.
    pub org_policy: OrgPolicy,
}

pub fn status() -> ClaudeStatus {
    let denied = deny().err();
    ClaudeStatus {
        consent: consent(),
        allowed: denied.is_none(),
        reason: denied,
        org_policy: org_policy(),
    }
}

#[tauri::command]
pub fn claude_status() -> ClaudeStatus {
    status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed::ManagedPolicy;

    #[test]
    fn the_gate_stays_shut_until_claude_is_turned_on() {
        let open = ManagedPolicy::default();
        for org_pinned in [false, true] {
            assert_eq!(
                deny_in(&open, org_pinned, false),
                Err(OFF_REASON.to_owned())
            );
            assert!(deny_in(&open, org_pinned, true).is_ok());
        }
    }

    #[test]
    fn a_profile_shuts_the_gate_whatever_the_answer() {
        let managed = ManagedPolicy {
            disable_agent_kit: true,
            ..ManagedPolicy::default()
        };
        for answer in [false, true] {
            let refusal = deny_in(&managed, true, answer).unwrap_err();
            assert!(
                refusal.starts_with(crate::managed::REASON_PREFIX),
                "{refusal}"
            );
            assert!(refusal.contains("DisableAgentKit"), "{refusal}");
        }
    }

    #[test]
    fn a_required_organisation_policy_shuts_the_gate_until_it_is_here() {
        let required = ManagedPolicy {
            require_managed_claude: true,
            ..ManagedPolicy::default()
        };
        for answer in [false, true] {
            let refusal = deny_in(&required, false, answer).unwrap_err();
            assert!(refusal.contains("RequireManagedClaude"), "{refusal}");
        }
        assert_eq!(
            deny_in(&required, true, false),
            Err(OFF_REASON.to_owned()),
            "the organisation's policy never answers for the person"
        );
        assert!(deny_in(&required, true, true).is_ok());
    }

    #[test]
    fn an_answer_round_trips_and_unanswered_is_not_on() {
        for stored in [None, Some(false), Some(true)] {
            assert_eq!(
                match encode(stored) {
                    ON => Some(true),
                    OFF => Some(false),
                    _ => None,
                },
                stored
            );
        }
        assert_eq!(encode(None), UNDECIDED);
    }
}
