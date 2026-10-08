//! The stills IPC: `start_stills_export` plans the output and opens the hidden temp file, `push_still` streams one page (raw body plus `x-kookaburra-*` headers), `finish_stills_export` finalises and publishes, `cancel_stills_export` drops the job.

use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::Ordering;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

use super::jpeg::parse_jpeg;
use super::pdf::{page_size_pt, pdf_date, DocInfo, PdfWriter};
use super::pngzip::{encode_png, rgba_to_rgb, zip_timestamp, PngZipWriter, ZipMeta};
use super::{
    full_user_name, local_now, Civil, FinishPlan, PageMeta, PagePayload, Sink, StillsJob,
    StillsKind, TextItem,
};
use crate::{workspace, ExportState, LastExport, Progress};

const MAX_PAGES: u32 = 2000;
const MAX_PAGE_EDGE: u32 = 8192;
const MAX_FORMAT_EDGE: u32 = 16384;
const MAX_TITLE_BYTES: usize = 4096;
const MAX_META_BYTES: usize = 8 * 1024;
const MAX_JPEG_BYTES: usize = 64 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXT_ITEMS: usize = 4000;
const MAX_TEXT_CHARS: usize = 2000;

const H_INDEX: &str = "x-kookaburra-still";
const H_WIDTH: &str = "x-kookaburra-width";
const H_HEIGHT: &str = "x-kookaburra-height";
const H_META: &str = "x-kookaburra-meta";
const H_TEXT_BYTES: &str = "x-kookaburra-text-bytes";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StillsOptions {
    kind: StillsKind,
    project_id: String,
    #[serde(default)]
    project_slug: Option<String>,
    /// Filename label, e.g. "16x9".
    aspect: String,
    #[serde(default)]
    output_suffix: Option<String>,
    /// None, "downloads", or "autorun" (the run's result dir, auto-runs only).
    #[serde(default)]
    destination: Option<String>,
    /// The project's display name: the PDF `/Title` and `pages.json` project.
    title: String,
    /// Native format size; sets the PDF page's aspect.
    format_width: u32,
    format_height: u32,
    /// Pixel size of every pushed page.
    page_width: u32,
    page_height: u32,
    total_pages: u32,
    /// Leaves out the PDF dates, author and app version, and stamps zip entries 1980-01-01.
    #[serde(default)]
    reproducible: bool,
}

impl StillsOptions {
    fn validate(&self) -> Result<(), String> {
        if !(1..=MAX_PAGES).contains(&self.total_pages) {
            return Err(format!(
                "a stills export needs 1 to {MAX_PAGES} pages, not {}",
                self.total_pages
            ));
        }
        let page_ok = |edge: u32| (1..=MAX_PAGE_EDGE).contains(&edge);
        if !page_ok(self.page_width) || !page_ok(self.page_height) {
            return Err(format!(
                "implausible still size {}x{}",
                self.page_width, self.page_height
            ));
        }
        let format_ok = |edge: u32| (1..=MAX_FORMAT_EDGE).contains(&edge);
        if !format_ok(self.format_width) || !format_ok(self.format_height) {
            return Err(format!(
                "implausible format size {}x{}",
                self.format_width, self.format_height
            ));
        }
        if self.title.len() > MAX_TITLE_BYTES {
            return Err("the project title is too long".into());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StillsResult {
    path: String,
    kind: StillsKind,
    pages: u32,
    bytes: u64,
    sha256: String,
    page_sha256: Vec<String>,
}

/// The PDF's Info entries; `now` is `None` in reproducible mode, which leaves out the author, the dates and the app version.
pub(super) fn doc_info(title: &str, version: &str, now: Option<&Civil>) -> DocInfo {
    DocInfo {
        title: title.to_string(),
        author: now.and_then(|_| full_user_name()),
        creator: match now {
            Some(_) => format!("Kookaburra Cut {version}"),
            None => "Kookaburra Cut".into(),
        },
        date: now.map(pdf_date),
    }
}

/// Plans the output (the video export's destination rules), opens its hidden temp file and arms the job; returns the planned final path.
#[tauri::command]
pub(crate) fn start_stills_export(
    app: AppHandle,
    state: State<'_, ExportState>,
    settings: State<'_, workspace::SettingsState>,
    options: StillsOptions,
    on_progress: Channel<Progress>,
) -> Result<String, String> {
    if state.busy() {
        return Err("an export is already in progress".into());
    }
    options.validate()?;
    let output = crate::resolve_export_output(
        &app,
        &settings,
        &crate::ExportTarget {
            project_id: &options.project_id,
            project_slug: options.project_slug.as_deref(),
            aspect: &options.aspect,
            output_suffix: options.output_suffix.as_deref(),
            destination: options.destination.as_deref(),
        },
        options.kind.ext(),
        true,
    )?;
    let temp = crate::partial_output_path(&output.path);
    let file = File::create(&temp).map_err(|e| format!("could not create the stills file: {e}"))?;
    let writer = BufWriter::with_capacity(1 << 20, file);
    let now = (!options.reproducible).then(local_now);
    let sink = match options.kind {
        StillsKind::Pdf => {
            let version = app.package_info().version.to_string();
            let info = doc_info(&options.title, &version, now.as_ref());
            let size = page_size_pt(options.format_width, options.format_height);
            match PdfWriter::new(writer, size, info) {
                Ok(pdf) => Sink::Pdf(Box::new(pdf)),
                Err(e) => {
                    let _ = std::fs::remove_file(&temp);
                    return Err(format!("could not start the PDF: {e}"));
                }
            }
        }
        StillsKind::PngZip => Sink::PngZip(Box::new(PngZipWriter::new(
            writer,
            ZipMeta {
                base: output.base.clone(),
                total: options.total_pages,
                timestamp: zip_timestamp(now),
                project: options.title.clone(),
                aspect: options.aspect.clone(),
                width: options.page_width,
                height: options.page_height,
            },
        ))),
    };
    let job = StillsJob::new(
        options.kind,
        output.path.clone(),
        temp,
        (options.page_width, options.page_height),
        options.total_pages,
        on_progress,
        sink,
    );
    state.stills.install(job)?;
    Ok(output.path.to_string_lossy().into_owned())
}

struct StillHeaders {
    index: u32,
    width: u32,
    height: u32,
    meta: PageMeta,
    text_bytes: usize,
}

fn header<'r>(request: &'r Request<'_>, name: &str) -> Option<&'r str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

fn number_header(request: &Request<'_>, name: &str) -> Result<u32, String> {
    header(request, name)
        .ok_or_else(|| format!("missing {name} header"))?
        .trim()
        .parse()
        .map_err(|_| format!("{name} is not a whole number"))
}

pub(crate) fn decode_meta(raw: &str) -> Result<PageMeta, String> {
    if raw.len() > MAX_META_BYTES {
        return Err(format!("{H_META} is over {MAX_META_BYTES} bytes"));
    }
    let json = BASE64
        .decode(raw.trim())
        .map_err(|_| format!("{H_META} is not base64"))?;
    let meta: PageMeta =
        serde_json::from_slice(&json).map_err(|e| format!("{H_META} is not valid: {e}"))?;
    let valid_ms = |ms: f64| ms.is_finite() && ms >= 0.0;
    if !valid_ms(meta.scene_ms) || !valid_ms(meta.global_ms) {
        return Err(format!("{H_META} has an invalid time"));
    }
    Ok(meta)
}

impl StillHeaders {
    fn parse(request: &Request<'_>) -> Result<Self, String> {
        let index = number_header(request, H_INDEX)?;
        let width = number_header(request, H_WIDTH)?;
        let height = number_header(request, H_HEIGHT)?;
        let text_bytes = match header(request, H_TEXT_BYTES) {
            Some(raw) => raw
                .trim()
                .parse()
                .map_err(|_| format!("{H_TEXT_BYTES} is not a whole number"))?,
            None => 0,
        };
        let meta = decode_meta(header(request, H_META).ok_or(format!("missing {H_META} header"))?)?;
        Ok(StillHeaders {
            index,
            width,
            height,
            meta,
            text_bytes,
        })
    }
}

/// The text layer: a JSON array of `{text, x, y, w, h}` in normalised top-left page coordinates.
pub(crate) fn parse_text_layer(bytes: &[u8]) -> Result<Vec<TextItem>, String> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(format!("the text layer is over {MAX_TEXT_BYTES} bytes"));
    }
    let items: Vec<TextItem> =
        serde_json::from_slice(bytes).map_err(|e| format!("the text layer is not valid: {e}"))?;
    if items.len() > MAX_TEXT_ITEMS {
        return Err(format!("the text layer has over {MAX_TEXT_ITEMS} lines"));
    }
    for item in &items {
        if item.text.chars().count() > MAX_TEXT_CHARS {
            return Err(format!(
                "a text layer line is over {MAX_TEXT_CHARS} characters"
            ));
        }
        if ![item.x, item.y, item.w, item.h]
            .iter()
            .all(|v| v.is_finite())
        {
            return Err("a text layer line has a non-finite position".into());
        }
    }
    Ok(items)
}

/// What a page body becomes before the blocking write: PDF bodies are complete, PNG bodies still need encoding.
pub(crate) enum Prepared {
    Ready(PagePayload),
    Rgb(Vec<u8>),
}

/// Splits and checks a page body against its headers.
pub(crate) fn prepare_body(
    kind: StillsKind,
    body: &[u8],
    width: u32,
    height: u32,
    text_bytes: usize,
) -> Result<Prepared, String> {
    match kind {
        StillsKind::Pdf => {
            let split = body
                .len()
                .checked_sub(text_bytes)
                .ok_or(format!("{H_TEXT_BYTES} is longer than the body"))?;
            let (jpeg, text) = body.split_at(split);
            if jpeg.len() > MAX_JPEG_BYTES {
                return Err(format!("the JPEG is over {MAX_JPEG_BYTES} bytes"));
            }
            let info = parse_jpeg(jpeg)?;
            if (info.width, info.height) != (width, height) {
                return Err(format!(
                    "the JPEG is {}x{}, its headers say {width}x{height}",
                    info.width, info.height
                ));
            }
            let text = parse_text_layer(text)?;
            Ok(Prepared::Ready(PagePayload::Pdf {
                jpeg: jpeg.to_vec(),
                info,
                text,
            }))
        }
        StillsKind::PngZip => {
            if text_bytes != 0 {
                return Err("PNG stills carry no text layer".into());
            }
            let expected = crate::expected_frame_len(width, height);
            if body.len() != expected {
                return Err(format!(
                    "still is {} bytes, expected {expected} for {width}x{height} RGBA",
                    body.len()
                ));
            }
            Ok(Prepared::Rgb(rgba_to_rgb(body)))
        }
    }
}

/// Appends one page. Encoding and the file write run off the async workers; any failure clears the job.
#[tauri::command]
pub(crate) async fn push_still(app: AppHandle, request: Request<'_>) -> Result<(), String> {
    let state = app.state::<ExportState>();
    let InvokeBody::Raw(body) = request.body() else {
        state.stills.abort(None);
        return Err("push_still expects a raw binary body".into());
    };
    let headers = StillHeaders::parse(&request).inspect_err(|_| state.stills.abort(None))?;
    let ticket = state
        .stills
        .ticket(headers.index, headers.width, headers.height)?;
    let serial = ticket.serial;
    let prepared = prepare_body(
        ticket.kind,
        body,
        headers.width,
        headers.height,
        headers.text_bytes,
    )
    .inspect_err(|_| state.stills.abort(Some(serial)))?;

    let worker = app.clone();
    let StillHeaders {
        index,
        width,
        height,
        meta,
        ..
    } = headers;
    let written = tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<ExportState>();
        let payload = match prepared {
            Prepared::Ready(payload) => payload,
            Prepared::Rgb(rgb) => PagePayload::Png(
                encode_png(&rgb, width, height)
                    .inspect_err(|_| state.stills.abort(Some(serial)))?,
            ),
        };
        state.stills.write_page(serial, index, &meta, payload)
    })
    .await;
    let (progress, channel) = match written {
        Ok(result) => result?,
        Err(e) => {
            state.stills.abort(Some(serial));
            return Err(format!("the still writer stopped: {e}"));
        }
    };
    let _ = channel.send(progress);
    Ok(())
}

pub(super) fn finalise(plan: FinishPlan) -> Result<StillsResult, String> {
    let FinishPlan {
        kind,
        sink,
        temp,
        output,
        pages,
        page_sha256,
        cancelled,
        ..
    } = plan;
    let writer = match sink {
        Sink::Pdf(pdf) => (*pdf)
            .finish()
            .map_err(|e| format!("could not finish the PDF: {e}"))?,
        Sink::PngZip(zip) => (*zip).finish()?,
    };
    let file = writer
        .into_inner()
        .map_err(|e| format!("could not write the stills file: {}", e.error()))?;
    file.sync_all()
        .map_err(|e| format!("could not flush the stills file to disk: {e}"))?;
    drop(file);
    if cancelled.load(Ordering::SeqCst) {
        return Err(crate::EXPORT_CANCELLED.into());
    }
    let sha256 = crate::sha256_file(&temp)?;
    let bytes = std::fs::metadata(&temp).map_err(|e| e.to_string())?.len();
    if cancelled.load(Ordering::SeqCst) {
        return Err(crate::EXPORT_CANCELLED.into());
    }
    std::fs::rename(&temp, &output)
        .map_err(|e| format!("could not move the export into place: {e}"))?;
    Ok(StillsResult {
        path: output.to_string_lossy().into_owned(),
        kind,
        pages,
        bytes,
        sha256,
        page_sha256,
    })
}

/// Finalises once every planned page is in, fsyncs, renames the temp file onto the output and records it for Show in Finder.
#[tauri::command]
pub(crate) async fn finish_stills_export(app: AppHandle) -> Result<StillsResult, String> {
    let state = app.state::<ExportState>();
    let plan = state.stills.begin_finish()?;
    let serial = plan.serial;
    let result = match tauri::async_runtime::spawn_blocking(move || finalise(plan)).await {
        Ok(result) => result,
        Err(e) => Err(format!("the stills finaliser stopped: {e}")),
    };
    state.stills.end_finish(serial, result.is_ok());
    let result = result?;
    if let Ok(mut last) = app.state::<LastExport>().0.lock() {
        *last = Some(PathBuf::from(&result.path));
    }
    Ok(result)
}

/// Idempotent: drops a streaming job and its temp file, or makes a finalising one unwind.
#[tauri::command]
pub(crate) async fn cancel_stills_export(state: State<'_, ExportState>) -> Result<(), String> {
    state.stills.cancel();
    Ok(())
}
