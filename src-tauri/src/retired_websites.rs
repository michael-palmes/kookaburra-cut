//! Live website scenes are gone. What they left on a Mac goes at each launch while it exists: every WebKit data store the app made (one per project, and the one they shared before 0.23) and the origin grants in `settings.json`. The app's own windows use WebKit's default store, so nothing of theirs is listed.
#![allow(unsafe_code)]

use tauri::AppHandle;

pub fn clear_at_launch(app: &AppHandle) {
    crate::workspace::drop_website_grants(app);
    #[cfg(target_os = "macos")]
    if let Err(error) = app.run_on_main_thread(macos::remove_stores) {
        log::warn!("[website] could not schedule the removal of old website data: {error}");
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_foundation::{MainThreadMarker, NSArray, NSError, NSUUID};
    use objc2_web_kit::WKWebsiteDataStore;

    pub fn remove_stores() {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let listed = RcBlock::new(|ids: NonNull<NSArray<NSUUID>>| {
            let Some(mtm) = MainThreadMarker::new() else {
                log::warn!("[website] WebKit listed its data stores off the main thread");
                return;
            };
            // SAFETY: WebKit hands the completion a live NSArray for the call's duration.
            for id in unsafe { ids.as_ref() }.to_vec() {
                let removed = RcBlock::new(|error: *mut NSError| {
                    // SAFETY: WebKit passes nil or a live NSError.
                    match unsafe { error.as_ref() } {
                        None => log::info!("[website] removed an old website data store"),
                        Some(error) => log::warn!(
                            "[website] removing an old website data store failed: {}",
                            error.localizedDescription()
                        ),
                    }
                });
                // SAFETY: the marker proves the main thread and WebKit copies the block.
                unsafe {
                    WKWebsiteDataStore::removeDataStoreForIdentifier_completionHandler(
                        &id, &removed, mtm,
                    )
                };
            }
        });
        // SAFETY: the block outlives the call (WebKit copies it) and the marker proves the main thread.
        unsafe { WKWebsiteDataStore::fetchAllDataStoreIdentifiers(&listed, mtm) };
    }
}
