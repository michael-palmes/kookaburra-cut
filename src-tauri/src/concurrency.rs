//! Caps bulk background ffmpeg work (thumbnails, clip extraction) so it can't saturate every core; exports and the user-attended editor render stay uncapped and at normal priority.

use std::sync::Arc;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// At most this many background ffmpeg processes at once; the rest queue.
const BACKGROUND_FFMPEG_PERMITS: usize = 3;

pub(crate) struct BackgroundLimiter(Arc<Semaphore>);

impl Default for BackgroundLimiter {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(BACKGROUND_FFMPEG_PERMITS)))
    }
}

impl BackgroundLimiter {
    pub(crate) async fn acquire(&self) -> Result<OwnedSemaphorePermit, String> {
        self.0
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "background ffmpeg limiter closed".to_string())
    }
}

/// Drop a spawned sidecar's scheduling priority so foreground work wins under contention.
#[cfg(target_os = "macos")]
pub(crate) fn lower_priority(pid: u32) {
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, pid, 10);
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn lower_priority(_pid: u32) {}
