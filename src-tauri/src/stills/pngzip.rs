//! The PNG images export: one stored entry per page under `<base>/`, named `NN-<scene-slug>[-k].png`, then a deflated `pages.json` index. Follows the `.kbpack` writer's zip settings so a reproducible run writes identical bytes.

use std::collections::BTreeMap;
use std::io::{Seek, Write};

use serde::{Serialize, Serializer};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::{Civil, PageMeta, StillKind};

const SLUG_MAX: usize = 40;

/// Drops the alpha channel of a top-down RGBA buffer (the capture is opaque).
pub(crate) fn rgba_to_rgb(rgba: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for pixel in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
    }
    rgb
}

/// RGB8 with an sRGB chunk; every encoder setting is explicit so the bytes never drift with crate defaults.
pub(crate) fn encode_png(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(rgb.len() / 2);
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
    encoder.set_compression(png::Compression::Balanced);
    encoder.set_filter(png::Filter::Adaptive);
    let mut writer = encoder
        .write_header()
        .map_err(|e| format!("could not start the PNG: {e}"))?;
    writer
        .write_image_data(rgb)
        .map_err(|e| format!("could not encode the PNG: {e}"))?;
    writer
        .finish()
        .map_err(|e| format!("could not finish the PNG: {e}"))?;
    Ok(out)
}

/// ASCII lowercase letters, digits and single hyphens; other ASCII splits words, other letters drop out.
pub(crate) fn scene_slug(name: &str, scene_index: u32) -> String {
    let mut slug = String::new();
    let mut gap = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(c.to_ascii_lowercase());
        } else if !c.is_alphanumeric() {
            gap = true;
        }
    }
    slug.truncate(SLUG_MAX);
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        format!("scene-{}", u64::from(scene_index) + 1)
    } else {
        slug
    }
}

pub(crate) fn number_width(total: u32) -> usize {
    total.to_string().len().max(2)
}

/// `NN-slug.png`, with `-k` from a scene's second page on.
pub(crate) fn entry_file(page: u32, width: usize, slug: &str, ordinal: u32) -> String {
    if ordinal > 1 {
        format!("{page:0width$}-{slug}-{ordinal}.png")
    } else {
        format!("{page:0width$}-{slug}.png")
    }
}

pub(crate) fn zip_timestamp(civil: Option<Civil>) -> zip::DateTime {
    civil
        .and_then(|c| {
            zip::DateTime::from_date_and_time(
                u16::try_from(c.year).ok()?,
                c.month as u8,
                c.day as u8,
                c.hour as u8,
                c.minute as u8,
                c.second as u8,
            )
            .ok()
        })
        .unwrap_or_default()
}

/// Whole milliseconds as integers, anything else to three decimals.
fn ms<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded.fract() == 0.0 && rounded.abs() < 9.0e15 {
        serializer.serialize_i64(rounded as i64)
    } else {
        serializer.serialize_f64(rounded)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageEntry {
    file: String,
    scene: String,
    scene_index: u32,
    kind: StillKind,
    #[serde(serialize_with = "ms")]
    scene_ms: f64,
    #[serde(serialize_with = "ms")]
    global_ms: f64,
}

#[derive(Serialize)]
struct PagesJson<'a> {
    version: u32,
    project: &'a str,
    aspect: &'a str,
    width: u32,
    height: u32,
    pages: &'a [PageEntry],
}

pub(crate) struct ZipMeta {
    /// The output's stem before any Downloads de-dupe suffix, used as the folder inside the zip.
    pub(crate) base: String,
    pub(crate) total: u32,
    pub(crate) timestamp: zip::DateTime,
    pub(crate) project: String,
    pub(crate) aspect: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) struct PngZipWriter<W: Write + Seek> {
    zip: ZipWriter<W>,
    meta: ZipMeta,
    digits: usize,
    per_scene: BTreeMap<u32, u32>,
    pages: Vec<PageEntry>,
}

impl<W: Write + Seek> PngZipWriter<W> {
    pub(crate) fn new(inner: W, meta: ZipMeta) -> Self {
        PngZipWriter {
            zip: ZipWriter::new(inner),
            digits: number_width(meta.total),
            meta,
            per_scene: BTreeMap::new(),
            pages: Vec::new(),
        }
    }

    fn options(&self, method: CompressionMethod) -> SimpleFileOptions {
        SimpleFileOptions::default()
            .compression_method(method)
            .unix_permissions(0o644)
            .last_modified_time(self.meta.timestamp)
    }

    pub(crate) fn write_page(&mut self, png: &[u8], meta: &PageMeta) -> Result<(), String> {
        let ordinal = self.per_scene.entry(meta.scene_index).or_insert(0);
        *ordinal += 1;
        let file = entry_file(
            self.pages.len() as u32 + 1,
            self.digits,
            &scene_slug(&meta.scene_name, meta.scene_index),
            *ordinal,
        );
        let options = self.options(CompressionMethod::Stored);
        self.zip
            .start_file(format!("{}/{file}", self.meta.base), options)
            .map_err(|e| e.to_string())?;
        self.zip.write_all(png).map_err(|e| e.to_string())?;
        self.pages.push(PageEntry {
            file,
            scene: meta.scene_title(),
            scene_index: meta.scene_index,
            kind: meta.kind,
            scene_ms: meta.scene_ms,
            global_ms: meta.global_ms,
        });
        Ok(())
    }

    /// Writes `pages.json` and the central directory, and hands back the inner writer.
    pub(crate) fn finish(mut self) -> Result<W, String> {
        let mut json = serde_json::to_vec_pretty(&PagesJson {
            version: 1,
            project: &self.meta.project,
            aspect: &self.meta.aspect,
            width: self.meta.width,
            height: self.meta.height,
            pages: &self.pages,
        })
        .map_err(|e| e.to_string())?;
        json.push(b'\n');
        let options = self.options(CompressionMethod::Deflated);
        self.zip
            .start_file(format!("{}/pages.json", self.meta.base), options)
            .map_err(|e| e.to_string())?;
        self.zip.write_all(&json).map_err(|e| e.to_string())?;
        self.zip
            .finish()
            .map_err(|e| format!("could not finish the zip: {e}"))
    }
}
