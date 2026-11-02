//! `<app binary> trust check --dir ABS`: whether the person has allowed this folder's current content (the F-001 gate), with the edit CLI's conventions. Read only and stored grants only: it never grants or re-stamps, so kb can't launder consent through it. `kb scene import` asks before it copies scene code out of another project.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::cli::{finish, Fail, Flags};
use crate::tools;
use crate::workspace::{trust_fingerprint, TrustRecord, MANIFEST_FILENAME};

/// What `edit caps` lists under `trust`; kb asks only when `check` is listed (an older binary would start the GUI).
pub const COMMANDS: &[&str] = &["check"];

/// Entry point for `trust …`; returns the process exit code.
pub fn main(args: Vec<OsString>) -> i32 {
    let args: Result<Vec<String>, _> = args.into_iter().map(OsString::into_string).collect();
    let Ok(args) = args else {
        return finish(Err(Fail::usage("arguments must be UTF-8 text")));
    };
    match args.split_first() {
        Some((command, rest)) if command == "check" => finish(check(rest)),
        _ => finish(Err(Fail::usage(format!(
            "give a trust command: {}",
            COMMANDS.join(", ")
        )))),
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Grants {
    trusted_projects: HashMap<String, TrustRecord>,
}

/// An unreadable or absent settings file holds no grants.
fn read_grants(app_data: &Path) -> Grants {
    std::fs::read(app_data.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// A grant counts only for this exact folder and this exact content, the rule `trust_record_matches` applies when the project opens.
fn allowed(grants: &Grants, dir: &Path) -> bool {
    let fingerprint = trust_fingerprint(dir);
    grants.trusted_projects.values().any(|record| {
        record.scenes_fingerprint == fingerprint
            && std::fs::canonicalize(&record.path).is_ok_and(|path| path == dir)
    })
}

fn check_in(args: &[String], app_data: Option<PathBuf>) -> Result<Value, Fail> {
    let flags = Flags::parse(args, &["dir"], &[])?;
    let raw = PathBuf::from(flags.require("dir")?);
    if !raw.is_absolute() {
        return Err(Fail::usage("--dir must be an absolute project folder"));
    }
    let dir = std::fs::canonicalize(&raw)
        .map_err(|e| Fail::new("missing", format!("{}: {e}", raw.display())))?;
    if !dir.join(MANIFEST_FILENAME).is_file() {
        return Err(Fail::new(
            "missing",
            format!("{} is not a project folder", dir.display()),
        ));
    }
    let grants = app_data.map(|data| read_grants(&data)).unwrap_or_default();
    Ok(json!({ "ok": true, "allowed": allowed(&grants, &dir), "dir": dir.to_string_lossy() }))
}

fn check(args: &[String]) -> Result<Value, Fail> {
    check_in(args, tools::app_data_dir().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-cli-trust-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::create_dir_all(dir.join("project/scenes")).unwrap();
        std::fs::write(dir.join("project/project.json"), "{}").unwrap();
        std::fs::write(dir.join("project/scenes/01-a.tsx"), "code").unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn grant(data: &Path, path: &Path, fingerprint: &str) {
        let settings = json!({ "trustedProjects": { "demo": {
            "scenesFingerprint": fingerprint,
            "path": path.to_string_lossy(),
            "allowedAtMs": 1,
        } } });
        std::fs::write(data.join("settings.json"), settings.to_string()).unwrap();
    }

    fn ask(root: &Path) -> Value {
        let dir = root.join("project");
        check_in(
            &["--dir".into(), dir.to_string_lossy().into_owned()],
            Some(root.join("data")),
        )
        .unwrap_or_else(|_| panic!("check failed"))
    }

    #[test]
    fn a_grant_stands_only_for_this_folder_and_this_content() {
        let root = scratch("grant");
        let project = root.join("project");
        assert_eq!(ask(&root)["allowed"], false);

        grant(&root.join("data"), &project, &trust_fingerprint(&project));
        assert_eq!(ask(&root)["allowed"], true);

        std::fs::write(project.join("scenes/01-a.tsx"), "changed since").unwrap();
        assert_eq!(ask(&root)["allowed"], false);

        grant(
            &root.join("data"),
            &root.join("elsewhere"),
            &trust_fingerprint(&project),
        );
        assert_eq!(ask(&root)["allowed"], false);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unreadable_settings_file_holds_no_grants() {
        let root = scratch("broken");
        std::fs::write(root.join("data/settings.json"), "{ not json").unwrap();
        assert_eq!(ask(&root)["allowed"], false);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_relative_or_missing_folder_is_refused() {
        let root = scratch("usage");
        assert!(check_in(&["--dir".into(), "project".into()], Some(root.join("data"))).is_err());
        let gone = root.join("gone").to_string_lossy().into_owned();
        assert!(check_in(&["--dir".into(), gone], Some(root.join("data"))).is_err());
        let not_a_project = root.join("data").to_string_lossy().into_owned();
        assert!(check_in(&["--dir".into(), not_a_project], Some(root.join("data"))).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
