//! A copy installed from the release `.pkg` leaves updates to whoever installed it: it never checks for one or installs one itself, unless a configuration profile turns the in-app updater back on (`UpdateEndpoint`, or `DisableUpdateCheck` forced to false). The sign of a package install is the installer's receipt for the bundle id naming the running version, with the app running from `/Applications`; a receipt left by an older package under a newer copy from the DMG does not count.
#![allow(unsafe_code)]

use std::path::Path;
use std::sync::OnceLock;

use tauri::AppHandle;

use crate::managed::ManagedPolicy;

/// Installer's receipt for the release package (`pkgbuild --identifier` in scripts/sign-and-notarize.sh).
pub const RECEIPT: &str = "/var/db/receipts/com.mpalmes.kookaburracut.plist";
const INSTALL_ROOT: &str = "/Applications";
const MAX_RECEIPT_BYTES: u64 = 64 * 1024;

/// What a refusal says; not a managed-key refusal, since no profile is involved.
pub const REASON: &str =
    "This copy was installed by a package, so updates arrive the same way, from whoever manages this Mac";

/// The decision over injected facts: the receipt names this exact version and the app runs from `/Applications`.
pub fn installed_by_package_in(receipt_version: Option<&str>, running: &str, exe: &Path) -> bool {
    receipt_version == Some(running) && exe.starts_with(INSTALL_ROOT)
}

/// A profile opts a package install back into the in-app updater: its own server, or update checks forced on.
pub fn profile_keeps_updater_in(policy: &ManagedPolicy) -> bool {
    let forced_on = !policy.disable_update_check
        && policy
            .forced_keys
            .iter()
            .any(|key| key == crate::managed::Key::DisableUpdateCheck.name());
    policy.update_endpoint.is_some() || forced_on
}

/// Whether updates are left to the installer: a package install no profile has opted back in.
pub fn left_to_installer_in(policy: &ManagedPolicy, installed_by_package: bool) -> bool {
    installed_by_package && !profile_keeps_updater_in(policy)
}

pub fn deny_update_in(policy: &ManagedPolicy, installed_by_package: bool) -> Result<(), String> {
    if left_to_installer_in(policy, installed_by_package) {
        return Err(REASON.to_owned());
    }
    Ok(())
}

/// `PackageVersion` from an installer receipt; `None` when the file is missing, oversized or not a property list holding one.
pub fn receipt_version(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_RECEIPT_BYTES {
        return None;
    }
    plist_string(&std::fs::read(path).ok()?, "PackageVersion")
}

#[cfg(target_os = "macos")]
fn plist_string(bytes: &[u8], key: &str) -> Option<String> {
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2_foundation::{
        NSData, NSDictionary, NSPropertyListMutabilityOptions, NSPropertyListSerialization,
        NSString,
    };
    autoreleasepool(|_| {
        let data = NSData::with_bytes(bytes);
        // SAFETY: a null format pointer is allowed, and the data outlives the call.
        let parsed = unsafe {
            NSPropertyListSerialization::propertyListWithData_options_format_error(
                &data,
                NSPropertyListMutabilityOptions::Immutable,
                std::ptr::null_mut(),
            )
        }
        .ok()?;
        let dictionary = parsed.downcast::<NSDictionary>().ok()?;
        // SAFETY: a property list dictionary's keys are strings and its values are objects.
        let dictionary: Retained<NSDictionary<NSString, AnyObject>> =
            unsafe { Retained::cast_unchecked(dictionary) };
        let value = dictionary.objectForKey(&NSString::from_str(key))?;
        Some(value.downcast::<NSString>().ok()?.to_string())
    })
}

#[cfg(not(target_os = "macos"))]
fn plist_string(_bytes: &[u8], _key: &str) -> Option<String> {
    None
}

/// Whether this running copy came from the package, read once a launch; a debug build never counts.
pub fn installed_by_package(app: &AppHandle) -> bool {
    static FOUND: OnceLock<bool> = OnceLock::new();
    *FOUND.get_or_init(|| {
        if cfg!(debug_assertions) {
            return false;
        }
        let Ok(exe) = tauri::utils::platform::current_exe() else {
            return false;
        };
        let running = app.package_info().version.to_string();
        let found = installed_by_package_in(
            receipt_version(Path::new(RECEIPT)).as_deref(),
            &running,
            &exe,
        );
        if found {
            log::info!("[update] installed by the package: updates are left to the installer unless a profile turns them on");
        }
        found
    })
}

/// Refuses the in-app updater on a package install no profile has opted back in.
pub fn deny_update(app: &AppHandle) -> Result<(), String> {
    deny_update_in(crate::managed::policy(), installed_by_package(app))
}

/// For the windows: updates are left to the installer, so the switch and Check now give way to one line.
#[tauri::command]
pub fn updates_left_to_installer(app: AppHandle) -> bool {
    left_to_installer_in(crate::managed::policy(), installed_by_package(&app))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const EXE: &str = "/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut";

    fn forcing(keys: &[&str], edit: impl FnOnce(&mut ManagedPolicy)) -> ManagedPolicy {
        let mut policy = ManagedPolicy {
            managed: !keys.is_empty(),
            forced_keys: keys.iter().map(|key| (*key).to_owned()).collect(),
            ..ManagedPolicy::default()
        };
        edit(&mut policy);
        policy
    }

    #[test]
    fn a_package_install_is_the_receipt_for_this_version_under_applications() {
        assert!(installed_by_package_in(
            Some("0.24.0"),
            "0.24.0",
            Path::new(EXE)
        ));
        assert!(
            !installed_by_package_in(None, "0.24.0", Path::new(EXE)),
            "a copy from the DMG has no receipt"
        );
        assert!(
            !installed_by_package_in(Some("0.23.0"), "0.24.0", Path::new(EXE)),
            "a receipt left by an older package under a newer copy from the DMG"
        );
        assert!(
            !installed_by_package_in(Some("0.24.1"), "0.24.0", Path::new(EXE)),
            "a newer receipt than the copy that is running"
        );
        for elsewhere in [
            "/Users/x/Applications/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut",
            "/Users/x/Downloads/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut",
            "/Volumes/Kookaburra Cut/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut",
            "/ApplicationsOld/Kookaburra Cut.app/Contents/MacOS/kookaburra-cut",
        ] {
            assert!(
                !installed_by_package_in(Some("0.24.0"), "0.24.0", Path::new(elsewhere)),
                "{elsewhere}"
            );
        }
    }

    #[test]
    fn a_package_install_leaves_updates_to_the_installer_until_a_profile_says_otherwise() {
        let unmanaged = ManagedPolicy::default();
        assert!(left_to_installer_in(&unmanaged, true));
        assert_eq!(deny_update_in(&unmanaged, true), Err(REASON.to_owned()));
        assert!(
            deny_update_in(&unmanaged, false).is_ok(),
            "a copy from the DMG keeps its updater"
        );

        let mirrored = forcing(&["UpdateEndpoint"], |policy| {
            policy.update_endpoint_locked = true;
            policy.update_endpoint = Some("https://updates.example.com/latest.json".into());
        });
        assert!(deny_update_in(&mirrored, true).is_ok());

        let forced_on = forcing(&["DisableUpdateCheck"], |_| {});
        assert!(deny_update_in(&forced_on, true).is_ok());

        let forced_off = forcing(&["DisableUpdateCheck"], |policy| {
            policy.disable_update_check = true;
        });
        assert!(left_to_installer_in(&forced_off, true));

        let broken_mirror = forcing(&["UpdateEndpoint"], |policy| {
            policy.update_endpoint_locked = true;
        });
        assert!(
            left_to_installer_in(&broken_mirror, true),
            "an unusable server opts nothing back in"
        );

        let other_keys = forcing(&["ExportsInProject", "DisableClaude"], |policy| {
            policy.exports_in_project = true;
            policy.disable_claude = true;
        });
        assert!(left_to_installer_in(&other_keys, true));
    }

    #[test]
    fn a_receipt_reads_its_package_version_and_anything_else_reads_as_none() {
        let dir: PathBuf = std::env::temp_dir().join(format!("kc-receipt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let receipt = dir.join("receipt.plist");
        std::fs::write(
            &receipt,
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>InstallPrefixPath</key>
  <string>Applications</string>
  <key>PackageIdentifier</key>
  <string>com.mpalmes.kookaburracut</string>
  <key>PackageVersion</key>
  <string>0.24.0</string>
</dict>
</plist>
"#,
        )
        .unwrap();
        let expected = cfg!(target_os = "macos").then(|| "0.24.0".to_owned());
        assert_eq!(receipt_version(&receipt), expected);

        std::fs::write(
            &receipt,
            r#"<plist version="1.0"><dict><key>PackageVersion</key><integer>24</integer></dict></plist>"#,
        )
        .unwrap();
        assert_eq!(
            receipt_version(&receipt),
            None,
            "a version that is not a string"
        );
        std::fs::write(&receipt, r#"<plist version="1.0"><array/></plist>"#).unwrap();
        assert_eq!(receipt_version(&receipt), None, "not a dictionary");
        std::fs::write(&receipt, "not a property list").unwrap();
        assert_eq!(receipt_version(&receipt), None);
        std::fs::write(&receipt, vec![b' '; MAX_RECEIPT_BYTES as usize + 1]).unwrap();
        assert_eq!(receipt_version(&receipt), None, "oversized");
        assert_eq!(receipt_version(&dir.join("missing.plist")), None);
        assert_eq!(receipt_version(&dir), None, "a folder in its place");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
