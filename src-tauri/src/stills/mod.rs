//! Stills export: the PDF handout and the PNG zip, streamed one page at a time from the capture loop into a hidden `.<stem>.part.<ext>` file that `finish_stills_export` renames into place. Lives beside the video export in `ExportState`, mutually exclusive with it.

pub(crate) mod commands;
mod jpeg;
mod pdf;
mod pdf_font;
mod pngzip;
#[cfg(test)]
mod tests;

use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;

use crate::Progress;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub(crate) enum StillsKind {
    #[serde(rename = "pdf")]
    Pdf,
    #[serde(rename = "png-zip")]
    PngZip,
}

impl StillsKind {
    pub(crate) fn ext(self) -> &'static str {
        match self {
            StillsKind::Pdf => "pdf",
            StillsKind::PngZip => "zip",
        }
    }
}

/// The per-page `x-kookaburra-meta` header, decoded.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageMeta {
    pub(crate) scene_index: u32,
    #[serde(default)]
    pub(crate) scene_name: String,
    pub(crate) scene_ms: f64,
    pub(crate) global_ms: f64,
}

impl PageMeta {
    /// The scene's display name, or "Scene N" when it has none.
    pub(crate) fn scene_title(&self) -> String {
        let name: String = self
            .scene_name
            .chars()
            .filter(|c| !c.is_control())
            .collect();
        let name = name.trim();
        if name.is_empty() {
            format!("Scene {}", u64::from(self.scene_index) + 1)
        } else {
            name.to_string()
        }
    }
}

/// One line of the PDF text layer in normalised page coordinates, top-left origin.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct TextItem {
    pub(crate) text: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
}

/// A local wall-clock reading, split out so the PDF date and zip timestamp formatting stay pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Civil {
    pub(crate) year: i32,
    pub(crate) month: u32,
    pub(crate) day: u32,
    pub(crate) hour: u32,
    pub(crate) minute: u32,
    pub(crate) second: u32,
    pub(crate) offset_minutes: i32,
}

pub(crate) fn local_now() -> Civil {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        let now = libc::time(std::ptr::null_mut());
        libc::localtime_r(&now, &mut tm);
    }
    Civil {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec.min(59) as u32,
        offset_minutes: (tm.tm_gmtoff / 60) as i32,
    }
}

/// The macOS account's full name for the PDF `/Author`, `None` when blank.
pub(crate) fn full_user_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    let name = objc2_foundation::NSFullUserName().to_string();
    #[cfg(not(target_os = "macos"))]
    let name = String::new();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

pub(crate) enum Sink {
    Pdf(Box<pdf::PdfWriter<BufWriter<File>>>),
    PngZip(Box<pngzip::PngZipWriter<BufWriter<File>>>),
}

/// One page, ready for the sink: the JPEG and its text layer, or an encoded PNG.
pub(crate) enum PagePayload {
    Pdf {
        jpeg: Vec<u8>,
        info: jpeg::JpegInfo,
        text: Vec<TextItem>,
    },
    Png(Vec<u8>),
}

impl PagePayload {
    fn bytes(&self) -> &[u8] {
        match self {
            PagePayload::Pdf { jpeg, .. } => jpeg,
            PagePayload::Png(png) => png,
        }
    }
}

static NEXT_SERIAL: AtomicU64 = AtomicU64::new(1);

pub(crate) struct StillsJob {
    /// Tells a page that finished encoding after a cancel and restart apart from the new job's pages.
    serial: u64,
    kind: StillsKind,
    output: PathBuf,
    temp: PathBuf,
    page_width: u32,
    page_height: u32,
    total: u32,
    written: u32,
    progress: Channel<Progress>,
    /// Taken by `finish_stills_export` while it finalises.
    sink: Option<Sink>,
    page_sha256: Vec<String>,
    finishing: bool,
    cancelled: Arc<AtomicBool>,
    published: bool,
}

impl StillsJob {
    pub(crate) fn new(
        kind: StillsKind,
        output: PathBuf,
        temp: PathBuf,
        (page_width, page_height): (u32, u32),
        total: u32,
        progress: Channel<Progress>,
        sink: Sink,
    ) -> Self {
        StillsJob {
            serial: NEXT_SERIAL.fetch_add(1, Ordering::Relaxed),
            kind,
            output,
            temp,
            page_width,
            page_height,
            total,
            written: 0,
            progress,
            sink: Some(sink),
            page_sha256: Vec::new(),
            finishing: false,
            cancelled: Arc::new(AtomicBool::new(false)),
            published: false,
        }
    }
}

impl Drop for StillsJob {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.temp);
        }
    }
}

const NO_JOB: &str = "no stills export in progress";

/// What `push_still` learns about the job before it encodes outside the lock.
pub(crate) struct Ticket {
    pub(crate) serial: u64,
    pub(crate) kind: StillsKind,
}

/// Everything the blocking finalise needs, taken out of the job so the lock is free meanwhile.
pub(crate) struct FinishPlan {
    pub(crate) serial: u64,
    pub(crate) kind: StillsKind,
    pub(crate) sink: Sink,
    pub(crate) temp: PathBuf,
    pub(crate) output: PathBuf,
    pub(crate) pages: u32,
    pub(crate) page_sha256: Vec<String>,
    pub(crate) cancelled: Arc<AtomicBool>,
}

/// The stills half of `ExportState`; video's push, finish and cancel never reach it.
#[derive(Default)]
pub(crate) struct StillsSlot(Mutex<Option<StillsJob>>);

impl StillsSlot {
    /// A panic mid-page must not leave stills busy for the rest of the session.
    fn lock(&self) -> MutexGuard<'_, Option<StillsJob>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn clear(mut guard: MutexGuard<'_, Option<StillsJob>>) {
        let job = guard.take();
        drop(guard);
        drop(job);
    }

    pub(crate) fn busy(&self) -> bool {
        self.lock().is_some()
    }

    pub(crate) fn install(&self, job: StillsJob) -> Result<(), String> {
        let mut guard = self.lock();
        if guard.is_some() {
            return Err("an export is already in progress".into());
        }
        *guard = Some(job);
        Ok(())
    }

    /// Drops a streaming job (deleting its temp file), or flags a finalising one so `finish_stills_export` unwinds; a no-op when idle.
    pub(crate) fn cancel(&self) {
        let guard = self.lock();
        match guard.as_ref() {
            Some(job) if job.finishing => job.cancelled.store(true, Ordering::SeqCst),
            Some(_) => Self::clear(guard),
            None => {}
        }
    }

    pub(crate) fn ticket(&self, index: u32, width: u32, height: u32) -> Result<Ticket, String> {
        let guard = self.lock();
        let job = guard.as_ref().ok_or(NO_JOB)?;
        if job.finishing {
            return Err("the stills export is already finishing".into());
        }
        let problem = if index != job.written {
            Some(format!(
                "still {index} arrived out of order (expected {})",
                job.written
            ))
        } else if index >= job.total {
            Some(format!(
                "still {index} is past the planned {} pages",
                job.total
            ))
        } else if (width, height) != (job.page_width, job.page_height) {
            Some(format!(
                "still is {width}x{height}, expected {}x{}",
                job.page_width, job.page_height
            ))
        } else {
            None
        };
        if let Some(problem) = problem {
            Self::clear(guard);
            return Err(problem);
        }
        Ok(Ticket {
            serial: job.serial,
            kind: job.kind,
        })
    }

    /// Clears the job a failed push belonged to (`None`: whichever is streaming), unless a finish already owns it.
    pub(crate) fn abort(&self, serial: Option<u64>) {
        let guard = self.lock();
        if guard
            .as_ref()
            .is_some_and(|job| serial.map_or(true, |s| s == job.serial) && !job.finishing)
        {
            Self::clear(guard);
        }
    }

    /// Appends one page; returns the progress to report. Any failure clears the job.
    pub(crate) fn write_page(
        &self,
        serial: u64,
        index: u32,
        meta: &PageMeta,
        payload: PagePayload,
    ) -> Result<(Progress, Channel<Progress>), String> {
        let mut guard = self.lock();
        let job = match guard.as_mut() {
            Some(job) if job.serial == serial && !job.finishing => job,
            _ => return Err(crate::EXPORT_CANCELLED.into()),
        };
        if index != job.written {
            let problem = format!(
                "still {index} arrived out of order (expected {})",
                job.written
            );
            Self::clear(guard);
            return Err(problem);
        }
        let digest = Sha256::digest(payload.bytes());
        let result = match (job.sink.as_mut(), payload) {
            (Some(Sink::Pdf(writer)), PagePayload::Pdf { jpeg, info, text }) => writer
                .write_page(&jpeg, info, &text, meta, digest.as_slice())
                .map_err(|e| format!("could not write the PDF page: {e}")),
            (Some(Sink::PngZip(writer)), PagePayload::Png(png)) => writer
                .write_page(&png, meta)
                .map_err(|e| format!("could not write the PNG: {e}")),
            _ => Err("the still does not match the export's format".into()),
        };
        if let Err(problem) = result {
            Self::clear(guard);
            return Err(problem);
        }
        job.written += 1;
        job.page_sha256.push(crate::hex_digest(digest.as_slice()));
        Ok((
            Progress {
                frame: job.written,
                total: job.total,
                stage: "still",
            },
            job.progress.clone(),
        ))
    }

    /// Hands the sink to the finaliser while the job stays in the slot, so `busy()` holds until the file is published.
    pub(crate) fn begin_finish(&self) -> Result<FinishPlan, String> {
        let mut guard = self.lock();
        let job = guard.as_mut().ok_or(NO_JOB)?;
        if job.finishing {
            return Err("the stills export is already finishing".into());
        }
        if job.written != job.total {
            let problem = format!(
                "the stills export has {} of its {} pages",
                job.written, job.total
            );
            Self::clear(guard);
            return Err(problem);
        }
        let Some(sink) = job.sink.take() else {
            Self::clear(guard);
            return Err("the stills export lost its file".into());
        };
        job.finishing = true;
        Ok(FinishPlan {
            serial: job.serial,
            kind: job.kind,
            sink,
            temp: job.temp.clone(),
            output: job.output.clone(),
            pages: job.written,
            page_sha256: job.page_sha256.clone(),
            cancelled: job.cancelled.clone(),
        })
    }

    /// Removes the finished job; `published` keeps its Drop from deleting a temp path that is now the output's name.
    pub(crate) fn end_finish(&self, serial: u64, published: bool) {
        let mut guard = self.lock();
        if guard.as_ref().is_some_and(|job| job.serial == serial) {
            if let Some(job) = guard.as_mut() {
                job.published = published;
            }
            Self::clear(guard);
        }
    }
}
