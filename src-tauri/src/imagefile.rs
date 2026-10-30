//! Stills on the way in through the app, the twin of the kit's `imagefile.py` (`still-facts-vectors.json` keeps the two header readers agreeing). A dropped file is untrusted: its header is read and capped before anything decodes it, and its bytes, never its name, say what it is. The stage reads raw pixels (`decode_png`, `colorSpaceConversion: "none"`), so a colour profile, CMYK or an EXIF turn is baked into plain sRGB, upright pixels through `sips`: ImageIO, the decoder WebKit itself uses, kept out of this process so a hostile file can only take a child down.

use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// `png_decode.rs` MAX_INPUT_BYTES; past MAX_EDGE no GPU the app runs on holds the texture.
pub(crate) const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_EDGE: u64 = 16384;
const MAX_PIXELS: u64 = 100_000_000;
const SIPS: &str = "/usr/bin/sips";
const SRGB_PROFILE: &str = "/System/Library/ColorSync/Profiles/sRGB Profile.icc";
const TOOL_TIMEOUT: Duration = Duration::from_secs(60);
const PROBE_EDGE: u64 = 64;
const BLANK_TOLERANCE: u8 = 3;
const MAX_ICC_BYTES: usize = 16 * 1024 * 1024;
const MAX_CHUNKS: usize = 8192;
const JPEG_QUALITY: &str = "92";

/// A file that does not come in, and why. `code` is the kit's: unreadable, too-large, no-decoder.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Refused {
    pub code: &'static str,
    pub message: String,
}

fn unreadable(shown: &str, why: impl std::fmt::Display) -> Refused {
    Refused {
        code: "unreadable",
        message: format!("{shown} is not a readable image: {why}"),
    }
}

fn too_large(message: String) -> Refused {
    Refused {
        code: "too-large",
        message,
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Format {
    Png,
    Jpeg,
    Webp,
    Gif,
}

impl Format {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpeg => "jpeg",
            Format::Webp => "webp",
            Format::Gif => "gif",
        }
    }

    pub(crate) fn ext(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpeg => "jpg",
            Format::Webp => "webp",
            Format::Gif => "gif",
        }
    }

    fn matches_ext(self, ext: &str) -> bool {
        match self {
            Format::Png => ext == "png",
            Format::Jpeg => ext == "jpg" || ext == "jpeg",
            Format::Webp => ext == "webp",
            Format::Gif => ext == "gif",
        }
    }
}

/// What the header says, from the header alone.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Facts {
    pub format: Format,
    pub width: u64,
    pub height: u64,
    pub space: &'static str,
    pub profile: Option<String>,
    pub orientation: Option<u16>,
    pub animated: bool,
}

impl Facts {
    fn new(format: Format) -> Self {
        Facts {
            format,
            width: 0,
            height: 0,
            space: "rgb",
            profile: None,
            orientation: None,
            animated: false,
        }
    }
}

/// What the first bytes say the file is, whatever its name says.
fn sniff(head: &[u8]) -> Option<&'static str> {
    let at = |range: std::ops::Range<usize>| head.get(range).unwrap_or(&[]);
    if at(0..8) == b"\x89PNG\r\n\x1a\n" {
        return Some("png");
    }
    if at(0..3) == b"\xff\xd8\xff" {
        return Some("jpeg");
    }
    if at(0..4) == b"RIFF" && at(8..12) == b"WEBP" {
        return Some("webp");
    }
    if at(0..6) == b"GIF87a" || at(0..6) == b"GIF89a" {
        return Some("gif");
    }
    if at(0..4) == b"II*\x00" || at(0..4) == b"MM\x00*" {
        return Some("tiff");
    }
    if at(0..2) == b"BM" {
        return Some("bmp");
    }
    if at(0..4) == b"%PDF" {
        return Some("pdf");
    }
    if at(0..2) == b"\xff\x0a" || at(4..12) == b"JXL \r\n\x87\n" {
        return Some("jxl");
    }
    if at(4..8) == b"ftyp" {
        let brand = at(8..12);
        if brand == b"avif" || brand == b"avis" {
            return Some("avif");
        }
        if [&b"heic"[..], b"heix", b"hevc", b"mif1", b"msf1"].contains(&brand) {
            return Some("heic");
        }
    }
    let text = head.get(..4096).unwrap_or(head);
    let start = text
        .iter()
        .position(|b| !b"\xef\xbb\xbf \t\r\n".contains(b))
        .unwrap_or(text.len());
    let text = text[start..].to_ascii_lowercase();
    if text.windows(4).any(|w| w == b"<svg")
        && [
            &b"<svg "[..],
            b"<svg>",
            b"<svg\n",
            b"<?xml",
            b"<!doc",
            b"<!--\n",
            b"<!-- ",
        ]
        .iter()
        .any(|opening| text.starts_with(opening))
    {
        return Some("svg");
    }
    if text.starts_with(b"<!doctype html") || text.starts_with(b"<html") {
        return Some("html");
    }
    None
}

fn u32_be(bytes: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?))
}

/// The ICC profile's description (v2 `desc`, v4 `mluc`); None when it has none.
fn icc_name(profile: &[u8]) -> Option<String> {
    let count = u32_be(profile.get(128..)?)?;
    for i in 0..count.min(256) as usize {
        let entry = profile.get(132 + 12 * i..144 + 12 * i)?;
        if &entry[..4] != b"desc" {
            continue;
        }
        let offset = u32_be(&entry[4..])? as usize;
        let size = u32_be(&entry[8..])? as usize;
        let end = offset.saturating_add(size).min(profile.len());
        let body = profile.get(offset..end)?;
        let text = match body.get(..4)? {
            b"desc" => {
                let length = u32_be(body.get(8..)?)? as usize;
                let stop = 12usize.saturating_add(length).min(body.len());
                let raw = body.get(12..stop)?;
                let raw = raw.split(|b| *b == 0).next()?;
                raw.iter().map(|b| *b as char).collect::<String>()
            }
            b"mluc" => {
                if u32_be(body.get(8..)?)? == 0 {
                    return None;
                }
                let length = u32_be(body.get(20..)?)? as usize;
                let start = u32_be(body.get(24..)?)? as usize;
                let raw = body.get(start..start.saturating_add(length).min(body.len()))?;
                let units: Vec<u16> = raw
                    .chunks_exact(2)
                    .map(|u| u16::from_be_bytes([u[0], u[1]]))
                    .collect();
                String::from_utf16_lossy(&units)
            }
            _ => return None,
        };
        let text = text.trim_matches(|c: char| c == '\0' || c.is_whitespace());
        return (!text.is_empty()).then(|| text.to_owned());
    }
    None
}

/// Tag 0x0112 of IFD0 in a TIFF-format EXIF block.
fn exif_orientation(block: &[u8]) -> Option<u16> {
    let big = match block.get(..2)? {
        b"II" => false,
        b"MM" => true,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let raw: [u8; 2] = block.get(at..at + 2)?.try_into().ok()?;
        Some(if big {
            u16::from_be_bytes(raw)
        } else {
            u16::from_le_bytes(raw)
        })
    };
    let raw: [u8; 4] = block.get(4..8)?.try_into().ok()?;
    let offset = if big {
        u32::from_be_bytes(raw)
    } else {
        u32::from_le_bytes(raw)
    } as usize;
    let count = u16_at(offset)?;
    for i in 0..usize::from(count).min(512) {
        let entry = offset.checked_add(2 + 12 * i)?;
        if u16_at(entry)? == 0x0112 && u16_at(entry + 2)? == 3 {
            let value = u16_at(entry + 8)?;
            return (1..=8).contains(&value).then_some(value);
        }
    }
    None
}

fn png_facts<R: Read + Seek>(reader: R, shown: &str) -> Result<Facts, Refused> {
    let decoder = png::Decoder::new(BufReader::new(reader));
    let reader = decoder
        .read_info()
        .map_err(|e| unreadable(shown, format!("its header is damaged ({e})")))?;
    let info = reader.info();
    let mut out = Facts::new(Format::Png);
    out.width = u64::from(info.width);
    out.height = u64::from(info.height);
    if matches!(
        info.color_type,
        png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha
    ) {
        out.space = "gray";
    }
    out.animated = info.animation_control.is_some();
    out.orientation = info.exif_metadata.as_deref().and_then(exif_orientation);
    out.profile = if let Some(profile) = info.icc_profile.as_deref() {
        Some(icc_name(profile).unwrap_or_else(|| "unnamed profile".to_owned()))
    } else if let Some(points) = info.coding_independent_code_points {
        let srgb = points.color_primaries == 1 && matches!(points.transfer_function, 1 | 13);
        Some(if srgb { "sRGB" } else { "cICP" }.to_owned())
    } else {
        info.srgb.map(|_| "sRGB".to_owned())
    };
    Ok(out)
}

fn jpeg_facts<R: Read + Seek>(reader: R, shown: &str) -> Result<Facts, Refused> {
    let mut f = BufReader::new(reader);
    let damaged = |_| unreadable(shown, "it can't be read");
    f.seek(SeekFrom::Start(2)).map_err(damaged)?;
    let mut out = Facts::new(Format::Jpeg);
    let mut icc: Vec<(u8, Vec<u8>)> = Vec::new();
    let mut icc_bytes = 0;
    let read_byte = |f: &mut BufReader<R>| -> Option<u8> {
        let mut one = [0u8];
        f.read_exact(&mut one).ok().map(|()| one[0])
    };
    for _ in 0..MAX_CHUNKS {
        let Some(byte) = read_byte(&mut f) else { break };
        if byte != 0xFF {
            continue;
        }
        let Some(mut code) = read_byte(&mut f) else {
            break;
        };
        while code == 0xFF {
            let Some(next) = read_byte(&mut f) else { break };
            code = next;
        }
        if code == 0xFF {
            break;
        }
        if code == 0 || (0xD0..=0xD8).contains(&code) {
            continue;
        }
        if code == 0xD9 || code == 0xDA {
            break;
        }
        let mut raw = [0u8; 2];
        if f.read_exact(&mut raw).is_err() {
            break;
        }
        let length = usize::from(u16::from_be_bytes(raw));
        if length < 2 {
            return Err(unreadable(shown, "a segment has a bad length"));
        }
        let wanted =
            matches!(code, 0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF | 0xE1 | 0xE2);
        if !wanted {
            f.seek_relative(length as i64 - 2).map_err(damaged)?;
            continue;
        }
        let mut body = Vec::with_capacity(length - 2);
        (&mut f)
            .take(length as u64 - 2)
            .read_to_end(&mut body)
            .map_err(damaged)?;
        match code {
            0xE1 => {
                if out.orientation.is_none() && body.starts_with(b"Exif\0\0") {
                    out.orientation = exif_orientation(&body[6..]);
                }
            }
            0xE2 => {
                if body.starts_with(b"ICC_PROFILE\0")
                    && body.len() > 14
                    && icc_bytes < MAX_ICC_BYTES
                {
                    icc_bytes += body.len() - 14;
                    icc.retain(|(at, _)| *at != body[12]);
                    icc.push((body[12], body[14..].to_vec()));
                }
            }
            _ => {
                if body.len() < 6 {
                    return Err(unreadable(shown, "its frame header is cut short"));
                }
                out.height = u64::from(u16::from_be_bytes([body[1], body[2]]));
                out.width = u64::from(u16::from_be_bytes([body[3], body[4]]));
                out.space = match body[5] {
                    1 => "gray",
                    4 => "cmyk",
                    _ => "rgb",
                };
            }
        }
    }
    if out.width == 0 && out.height == 0 {
        return Err(unreadable(shown, "it has no frame header"));
    }
    if !icc.is_empty() {
        icc.sort_by_key(|(at, _)| *at);
        let joined: Vec<u8> = icc.into_iter().flat_map(|(_, part)| part).collect();
        out.profile = Some(icc_name(&joined).unwrap_or_else(|| "unnamed profile".to_owned()));
    }
    Ok(out)
}

fn webp_facts<R: Read + Seek>(reader: R, shown: &str) -> Result<Facts, Refused> {
    let mut f = BufReader::new(reader);
    let damaged = |_| unreadable(shown, "it can't be read");
    f.seek(SeekFrom::Start(12)).map_err(damaged)?;
    let mut out = Facts::new(Format::Webp);
    let mut extended = false;
    for _ in 0..MAX_CHUNKS {
        let mut head = [0u8; 8];
        if f.read_exact(&mut head).is_err() {
            break;
        }
        let kind: [u8; 4] = head[..4].try_into().expect("four bytes");
        let length = u64::from(u32::from_le_bytes(
            head[4..].try_into().expect("four bytes"),
        ));
        let step = length + (length & 1);
        let read_up_to = |f: &mut BufReader<R>, wanted: u64| -> Result<Vec<u8>, Refused> {
            let mut body = Vec::new();
            f.take(wanted).read_to_end(&mut body).map_err(damaged)?;
            Ok(body)
        };
        let skip = |f: &mut BufReader<R>, by: u64| -> Result<(), Refused> {
            f.seek_relative(i64::try_from(by).unwrap_or(i64::MAX))
                .map_err(damaged)
        };
        match &kind {
            b"VP8X" => {
                let body = read_up_to(&mut f, 10)?;
                if body.len() < 10 {
                    return Err(unreadable(shown, "its header is cut short"));
                }
                extended = true;
                out.animated = body[0] & 0x02 != 0;
                let three = |at: usize| {
                    1 + (u64::from(body[at])
                        | u64::from(body[at + 1]) << 8
                        | u64::from(body[at + 2]) << 16)
                };
                out.width = three(4);
                out.height = three(7);
                skip(&mut f, step.saturating_sub(10))?;
            }
            b"VP8 " => {
                let body = read_up_to(&mut f, 10)?;
                if body.len() < 10 || body[3..6] != [0x9d, 0x01, 0x2a] {
                    return Err(unreadable(shown, "its frame header is cut short"));
                }
                if out.width == 0 {
                    out.width = u64::from(u16::from_le_bytes([body[6], body[7]]) & 0x3FFF);
                    out.height = u64::from(u16::from_le_bytes([body[8], body[9]]) & 0x3FFF);
                }
                if !extended {
                    return Ok(out);
                }
                skip(&mut f, step.saturating_sub(10))?;
            }
            b"VP8L" => {
                let body = read_up_to(&mut f, 5)?;
                if body.len() < 5 || body[0] != 0x2F {
                    return Err(unreadable(shown, "its frame header is cut short"));
                }
                let bits = u32::from_le_bytes([body[1], body[2], body[3], body[4]]);
                if out.width == 0 {
                    out.width = u64::from(bits & 0x3FFF) + 1;
                    out.height = u64::from((bits >> 14) & 0x3FFF) + 1;
                }
                if !extended {
                    return Ok(out);
                }
                skip(&mut f, step.saturating_sub(5))?;
            }
            b"ICCP" if length <= MAX_ICC_BYTES as u64 => {
                let body = read_up_to(&mut f, length)?;
                out.profile = Some(icc_name(&body).unwrap_or_else(|| "unnamed profile".to_owned()));
                skip(&mut f, length & 1)?;
            }
            b"EXIF" if length <= MAX_ICC_BYTES as u64 => {
                let body = read_up_to(&mut f, length)?;
                let block = body.strip_prefix(b"Exif\0\0").unwrap_or(&body);
                out.orientation = exif_orientation(block);
                skip(&mut f, length & 1)?;
            }
            b"ANMF" => return Ok(out),
            b"ANIM" if out.width != 0 => return Ok(out),
            _ => skip(&mut f, step)?,
        }
    }
    if out.width == 0 {
        return Err(unreadable(shown, "it has no frame header"));
    }
    Ok(out)
}

fn gif_facts<R: Read + Seek>(reader: R, shown: &str) -> Result<Facts, Refused> {
    let mut f = BufReader::new(reader);
    let damaged = |_| unreadable(shown, "it can't be read");
    f.seek(SeekFrom::Start(6)).map_err(damaged)?;
    let mut screen = [0u8; 4];
    f.read_exact(&mut screen)
        .map_err(|_| unreadable(shown, "its header is cut short"))?;
    let mut rest = Vec::new();
    (&mut f)
        .take(1 << 20)
        .read_to_end(&mut rest)
        .map_err(damaged)?;
    let frames = rest.windows(3).filter(|w| *w == b"\x21\xf9\x04").count();
    let mut out = Facts::new(Format::Gif);
    out.width = u64::from(u16::from_le_bytes([screen[0], screen[1]]));
    out.height = u64::from(u16::from_le_bytes([screen[2], screen[3]]));
    out.animated = frames > 1;
    Ok(out)
}

/// The file's size against the cap, before a byte of it is copied.
pub(crate) fn check_size(size: u64, shown: &str) -> Result<(), Refused> {
    if size > MAX_BYTES {
        return Err(too_large(format!(
            "{shown} is {} MB, over the {} MB an image may be",
            size / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        )));
    }
    Ok(())
}

/// The header alone; a file that isn't an image the app reads, or is too big to decode safely, is refused before anything decodes it.
pub(crate) fn facts(path: &Path, shown: &str) -> Result<Facts, Refused> {
    let mut file = std::fs::File::open(path).map_err(|e| unreadable(shown, e))?;
    let size = file.metadata().map_err(|e| unreadable(shown, e))?.len();
    if size == 0 {
        return Err(unreadable(shown, "it is empty"));
    }
    check_size(size, shown)?;
    let mut head = Vec::with_capacity(4096);
    (&mut file)
        .take(4096)
        .read_to_end(&mut head)
        .map_err(|e| unreadable(shown, e))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| unreadable(shown, e))?;
    let out = match sniff(&head) {
        Some("png") => png_facts(file, shown),
        Some("jpeg") => jpeg_facts(file, shown),
        Some("webp") => webp_facts(file, shown),
        Some("gif") => gif_facts(file, shown),
        Some("svg") => Err(unreadable(shown, "it holds an SVG")),
        Some(other) => Err(unreadable(
            shown,
            format!("it holds {}", foreign_name(other)),
        )),
        None => Err(unreadable(shown, "its first bytes aren't an image's")),
    }?;
    if out.width == 0 || out.height == 0 {
        return Err(unreadable(
            shown,
            format!("it says it is {}x{}", out.width, out.height),
        ));
    }
    if out.width > MAX_EDGE || out.height > MAX_EDGE || out.width * out.height > MAX_PIXELS {
        return Err(too_large(format!(
            "{shown} is {}x{}, over the {MAX_EDGE} px a side and {} MP an image may be",
            out.width,
            out.height,
            MAX_PIXELS / 1_000_000
        )));
    }
    Ok(out)
}

fn foreign_name(kind: &str) -> &'static str {
    match kind {
        "tiff" => "TIFF",
        "bmp" => "BMP",
        "heic" => "HEIC",
        "avif" => "AVIF",
        "pdf" => "PDF",
        "html" => "HTML",
        "jxl" => "JPEG XL",
        _ => "another format",
    }
}

fn is_srgb(profile: Option<&str>) -> bool {
    let Some(profile) = profile else {
        return true;
    };
    let low = profile.to_lowercase().replace(' ', "");
    low.contains("srgb") || low.contains("iec61966-2")
}

/// What would draw wrong as it is: a profile the stage ignores, CMYK pixels, an EXIF turn it ignores.
pub(crate) fn needs_conform(f: &Facts) -> Vec<&'static str> {
    let mut out = Vec::new();
    if f.space == "cmyk" {
        out.push("cmyk");
    } else if f.space != "gray" && !is_srgb(f.profile.as_deref()) {
        out.push("colour-profile");
    }
    if !matches!(f.orientation, None | Some(1)) {
        out.push("orientation");
    }
    out
}

/// The format a file is left in once conformed: `sips` can't write WebP or GIF.
fn lands_as(f: &Facts) -> Format {
    if needs_conform(f).is_empty() || f.format == Format::Jpeg {
        f.format
    } else {
        Format::Png
    }
}

/// EXIF orientation to the `sips` turn and flip that shows the picture upright.
fn upright(orientation: u16) -> (u16, Option<&'static str>) {
    match orientation {
        2 => (0, Some("horizontal")),
        3 => (180, None),
        4 => (0, Some("vertical")),
        5 => (270, Some("horizontal")),
        6 => (90, None),
        7 => (90, Some("horizontal")),
        8 => (270, None),
        _ => (0, None),
    }
}

/// A file that is removed unless it moved on.
pub(crate) struct Scratch(pub PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// One `sips` run, bounded in time and with no shell: a hung or crashed decoder is this file's trouble, never the import's.
fn run_sips(args: &[String], src: &Path, out: &Path, shown: &str) -> Result<(), Refused> {
    let mut child = Command::new(SIPS)
        .args(args)
        .arg(src)
        .arg("--out")
        .arg(out)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| Refused {
            code: "no-decoder",
            message: format!("{shown} can't be checked: macOS's sips would not start ({e})"),
        })?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() && out.is_file() => return Ok(()),
            Ok(Some(_)) => return Err(unreadable(shown, "macOS could not decode it")),
            Ok(None) if started.elapsed() > TOOL_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(unreadable(
                    shown,
                    format!("decoding it took longer than {} s", TOOL_TIMEOUT.as_secs()),
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(unreadable(shown, e));
            }
        }
    }
}

/// Drop the `eXIf` chunks `sips` carries across, for the same reason as `strip_jpeg_exif`.
fn strip_png_exif(path: &Path, shown: &str) -> Result<(), Refused> {
    let data = std::fs::read(path).map_err(|e| unreadable(shown, e))?;
    let mut out = data[..8.min(data.len())].to_vec();
    let mut i = 8;
    while i + 8 <= data.len() {
        let length = u32_be(&data[i..]).unwrap_or(0) as usize;
        let end = i.saturating_add(12).saturating_add(length).min(data.len());
        if &data[i + 4..i + 8] != b"eXIf" {
            out.extend_from_slice(&data[i..end]);
        }
        i = end;
    }
    std::fs::write(path, out).map_err(|e| unreadable(shown, e))
}

/// Drop the APP1 EXIF blocks `sips` carries across, so an orientation already baked in isn't applied twice.
fn strip_jpeg_exif(path: &Path, shown: &str) -> Result<(), Refused> {
    let data = std::fs::read(path).map_err(|e| unreadable(shown, e))?;
    let mut out = data[..2.min(data.len())].to_vec();
    let mut i = 2;
    while i + 4 <= data.len() && data[i] == 0xFF {
        let marker = data[i + 1];
        if marker == 0xDA {
            break;
        }
        let length = usize::from(u16::from_be_bytes([data[i + 2], data[i + 3]]));
        let end = (i + 2 + length).min(data.len());
        let block = &data[i..end];
        if !(marker == 0xE1 && block.get(4..10) == Some(b"Exif\0\0")) {
            out.extend_from_slice(block);
        }
        i = end;
    }
    out.extend_from_slice(&data[i..]);
    std::fs::write(path, out).map_err(|e| unreadable(shown, e))
}

/// Blank or not, from every row of a PNG through the stage's own decoder, so a file that passes here decodes in a frame. Rows are read and dropped, so the cost is the decode, never the memory of one.
fn scan_png(path: &Path, shown: &str) -> Result<Option<String>, Refused> {
    let file = std::fs::File::open(path).map_err(|e| unreadable(shown, e))?;
    let mut decoder = png::Decoder::new(BufReader::new(file));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| unreadable(shown, format!("its header is damaged ({e})")))?;
    let (colour, _) = reader.output_color_type();
    let channels = colour.samples();
    let mut tally = Tally::new();
    loop {
        let row = reader
            .next_row()
            .map_err(|e| unreadable(shown, format!("its pixel data is damaged ({e})")))?;
        let Some(row) = row else { break };
        for pixel in row.data().chunks_exact(channels) {
            let (r, g, b, a) = match channels {
                1 => (pixel[0], pixel[0], pixel[0], 255),
                2 => (pixel[0], pixel[0], pixel[0], pixel[1]),
                3 => (pixel[0], pixel[1], pixel[2], 255),
                _ => (pixel[0], pixel[1], pixel[2], pixel[3]),
            };
            tally.add(r, g, b, a);
        }
    }
    Ok(tally.blank(shown))
}

/// `imagefile.py` `summarise`: alpha at or under the tolerance counts as nothing drawn.
struct Tally {
    alpha_min: u8,
    alpha_max: u8,
    low: [u8; 3],
    high: [u8; 3],
    visible: bool,
}

impl Tally {
    fn new() -> Self {
        Tally {
            alpha_min: 255,
            alpha_max: 0,
            low: [255; 3],
            high: [0; 3],
            visible: false,
        }
    }

    fn add(&mut self, r: u8, g: u8, b: u8, a: u8) {
        self.alpha_min = self.alpha_min.min(a);
        self.alpha_max = self.alpha_max.max(a);
        if a <= BLANK_TOLERANCE {
            return;
        }
        self.visible = true;
        for (i, v) in [r, g, b].into_iter().enumerate() {
            self.low[i] = self.low[i].min(v);
            self.high[i] = self.high[i].max(v);
        }
    }

    fn blank(&self, shown: &str) -> Option<String> {
        if !self.visible {
            return Some(format!("{shown} is fully transparent, so it draws nothing"));
        }
        let flat = self.alpha_max - self.alpha_min <= BLANK_TOLERANCE
            && (0..3).all(|i| self.high[i] - self.low[i] <= BLANK_TOLERANCE);
        flat.then(|| {
            let mid = |i: usize| (u16::from(self.low[i]) + u16::from(self.high[i])) / 2;
            format!(
                "{shown} is one flat colour (#{:02x}{:02x}{:02x}), so it draws a plain block",
                mid(0),
                mid(1),
                mid(2)
            )
        })
    }
}

/// Decodes the picture: a PNG here, anything else as a small PNG from `sips` (the decoder WebKit uses for it). A failed decode is a refusal; what comes back says whether it is blank.
fn look(path: &Path, f: &Facts, shown: &str, scratch: &Path) -> Result<Option<String>, Refused> {
    if f.format == Format::Png {
        return scan_png(path, shown);
    }
    let out = Scratch(scratch.to_path_buf());
    let mut args: Vec<String> = ["-s", "format", "png"].map(str::to_owned).to_vec();
    if f.width.max(f.height) > PROBE_EDGE * 2 {
        args.extend(["-Z".to_owned(), PROBE_EDGE.to_string()]);
    }
    run_sips(&args, path, &out.0, shown)?;
    scan_png(&out.0, shown)
}

/// A checked still, ready to land.
pub(crate) struct Checked {
    /// The baked copy; `None` when the parked file itself lands.
    pub converted: Option<Scratch>,
    pub ext: String,
    pub transforms: Vec<Value>,
    /// Things worth telling the person who dropped it: blank, animated, not what its name says.
    pub notes: Vec<String>,
}

/// Everything about a parked import that takes time, so a batch can check side by side and land in turn. `ext` is the name's lowercase extension. Nothing here touches anything but `parked` and scratch files beside it, so no existing asset can move.
pub(crate) fn check(parked: &Path, shown: &str, ext: &str) -> Result<Checked, Refused> {
    let f = facts(parked, shown)?;
    let reasons = needs_conform(&f);
    let lands = lands_as(&f);
    let mut notes = Vec::new();
    let keeps_name = lands.matches_ext(ext);
    let final_ext = if keeps_name { ext } else { lands.ext() }.to_owned();
    if !keeps_name && reasons.is_empty() {
        notes.push(format!(
            "{shown} is really a {}, so it landed as .{final_ext}",
            lands.name().to_uppercase()
        ));
    }
    if f.animated {
        notes.push(format!(
            "{shown} is animated, but only its first frame draws"
        ));
    }
    let look_scratch = scratch_beside(parked, "look.png");
    if reasons.is_empty() {
        notes.extend(look(parked, &f, shown, &look_scratch)?);
        return Ok(Checked {
            converted: None,
            ext: final_ext,
            transforms: Vec::new(),
            notes,
        });
    }
    let (args, transforms) = bake_plan(&f, &reasons, lands, shown)?;
    let converted = Scratch(scratch_beside(
        parked,
        &format!("converted.{}", lands.ext()),
    ));
    run_sips(&args, parked, &converted.0, shown)?;
    if reasons.contains(&"orientation") {
        match lands {
            Format::Jpeg => strip_jpeg_exif(&converted.0, shown)?,
            _ => strip_png_exif(&converted.0, shown)?,
        }
    }
    let g = facts(&converted.0, shown)?;
    let left = needs_conform(&g);
    if !left.is_empty() {
        return Err(unreadable(
            shown,
            format!("converting it still left {}", left.join(", ")),
        ));
    }
    notes.extend(look(&converted.0, &g, shown, &look_scratch)?);
    Ok(Checked {
        converted: Some(converted),
        ext: final_ext,
        transforms,
        notes,
    })
}

fn scratch_beside(parked: &Path, suffix: &str) -> PathBuf {
    let mut name = parked.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{suffix}"));
    parked.with_file_name(name)
}

/// `imagefile.py` `prepare`'s arguments and the provenance they earn.
fn bake_plan(
    f: &Facts,
    reasons: &[&str],
    lands: Format,
    shown: &str,
) -> Result<(Vec<String>, Vec<Value>), Refused> {
    let mut args: Vec<String> = Vec::new();
    let mut transforms = Vec::new();
    if reasons.contains(&"colour-profile") || reasons.contains(&"cmyk") {
        if !Path::new(SRGB_PROFILE).is_file() {
            return Err(Refused {
                code: "no-decoder",
                message: format!(
                    "{shown} needs converting to sRGB, but macOS's sRGB profile is missing"
                ),
            });
        }
        args.extend(["--matchTo".to_owned(), SRGB_PROFILE.to_owned()]);
        let from = if reasons.contains(&"cmyk") {
            Some("cmyk")
        } else {
            f.profile.as_deref()
        };
        transforms.push(json!({"op": "colour", "to": "srgb", "from": from}));
    }
    if reasons.contains(&"orientation") {
        let orientation = f.orientation.unwrap_or(1);
        let (turn, flip) = upright(orientation);
        if turn != 0 {
            args.extend(["--rotate".to_owned(), turn.to_string()]);
        }
        if let Some(flip) = flip {
            args.extend(["--flip".to_owned(), flip.to_owned()]);
        }
        transforms.push(json!({"op": "upright", "orientation": orientation}));
    }
    args.extend([
        "-s".to_owned(),
        "format".to_owned(),
        lands.name().to_owned(),
    ]);
    if lands == Format::Jpeg {
        args.extend([
            "-s".to_owned(),
            "formatOptions".to_owned(),
            JPEG_QUALITY.to_owned(),
        ]);
    }
    Ok((args, transforms))
}

#[cfg(test)]
mod tests {
    use super::*;

    const P3_PROFILE: &str = "/System/Library/ColorSync/Profiles/Display P3.icc";
    const CMYK_PROFILE: &str = "/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc";
    // A 1x1 lossy WebP frame, the smallest real one.
    const TINY_WEBP_FRAME: &[u8] = &[
        0x56, 0x50, 0x38, 0x20, 0x16, 0x00, 0x00, 0x00, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01,
        0x00, 0x01, 0x00, 0x0e, 0xc0, 0xfe, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0x00, 0x00, 0x00,
    ];

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kc-imagefile-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rgba_png(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let mut rows = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                rows.extend_from_slice(&pixel(x, y));
            }
        }
        writer.write_image_data(&rows).unwrap();
        writer.finish().unwrap();
        bytes
    }

    fn checker(width: u32, height: u32) -> Vec<u8> {
        rgba_png(width, height, |x, y| {
            if (x + y) % 2 == 0 {
                [200, 40, 40, 255]
            } else {
                [20, 40, 200, 255]
            }
        })
    }

    fn put(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    /// `sips` itself, for making test media; tests that need it stand down where it is missing.
    fn sips(args: &[&str], src: &Path, out: &Path) -> bool {
        Command::new(SIPS)
            .args(args)
            .arg(src)
            .arg("--out")
            .arg(out)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    fn have_sips() -> bool {
        let there = Path::new(SIPS).is_file() && Path::new(P3_PROFILE).is_file();
        if !there {
            eprintln!("skipping: sips unavailable");
        }
        there
    }

    fn p3_png(dir: &Path) -> PathBuf {
        let plain = put(
            dir,
            "plain.png",
            &rgba_png(64, 32, |x, _| [230, (x * 4 % 255) as u8, 40, 255]),
        );
        let tagged = dir.join("tagged.png");
        assert!(sips(&["--matchTo", P3_PROFILE], &plain, &tagged));
        tagged
    }

    fn rgba_of(path: &Path) -> (Vec<u8>, u32, u32) {
        crate::png_decode::decode_png_rgba(&std::fs::read(path).unwrap()).unwrap()
    }

    /// A 40x20 JPEG, stored red and green over blue and white, so where each corner lands shows the turn.
    fn jpeg_of_four_quadrants(dir: &Path) -> Vec<u8> {
        let plain = put(
            dir,
            "quadrants.png",
            &rgba_png(40, 20, |x, y| match (x < 20, y < 10) {
                (true, true) => [255, 0, 0, 255],
                (false, true) => [0, 255, 0, 255],
                (true, false) => [0, 0, 255, 255],
                (false, false) => [255, 255, 255, 255],
            }),
        );
        let out = dir.join("quadrants.jpg");
        assert!(sips(
            &["-s", "format", "jpeg", "-s", "formatOptions", "100"],
            &plain,
            &out
        ));
        std::fs::read(out).unwrap()
    }

    fn exif_turn(orientation: u16) -> Vec<u8> {
        let mut block = b"Exif\0\0II".to_vec();
        block.extend_from_slice(&42u16.to_le_bytes());
        block.extend_from_slice(&8u32.to_le_bytes());
        block.extend_from_slice(&1u16.to_le_bytes());
        block.extend_from_slice(&0x0112u16.to_le_bytes());
        block.extend_from_slice(&3u16.to_le_bytes());
        block.extend_from_slice(&1u32.to_le_bytes());
        block.extend_from_slice(&orientation.to_le_bytes());
        block.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        block
    }

    fn corners(path: &Path, dir: &Path) -> ((u32, u32), String) {
        let decoded = dir.join("corners.png");
        let _ = std::fs::remove_file(&decoded);
        assert!(sips(&["-s", "format", "png"], path, &decoded));
        let (rgba, width, height) = rgba_of(&decoded);
        let name = |x: u32, y: u32| {
            let at = ((y * width + x) * 4) as usize;
            let (r, g, b) = (rgba[at], rgba[at + 1], rgba[at + 2]);
            if r.min(g).min(b) > 180 {
                'W'
            } else if r > 180 {
                'R'
            } else if g > 180 {
                'G'
            } else {
                'B'
            }
        };
        let seen = format!(
            "{}{}/{}{}",
            name(width / 4, height / 4),
            name(3 * width / 4, height / 4),
            name(width / 4, 3 * height / 4),
            name(3 * width / 4, 3 * height / 4)
        );
        ((width, height), seen)
    }

    #[test]
    fn the_header_readers_agree_with_the_kit() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../.agents/skills/kookaburra-scene-authoring/scripts/tests/fixtures/still-facts-vectors.json"
        ))
        .unwrap();
        let dir = scratch("vectors");
        for case in vectors["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let hex = case["hex"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            let path = put(&dir, "case.bin", &bytes);
            match facts(&path, "case") {
                Ok(f) => {
                    let want = &case["facts"];
                    assert_eq!(want["format"], f.format.name(), "{name}");
                    assert_eq!(want["width"], f.width, "{name}");
                    assert_eq!(want["height"], f.height, "{name}");
                    assert_eq!(want["space"], f.space, "{name}");
                    assert_eq!(want["profile"], json!(f.profile), "{name}");
                    assert_eq!(want["orientation"], json!(f.orientation), "{name}");
                    assert_eq!(want["animated"], f.animated, "{name}");
                    assert_eq!(case["reasons"], json!(needs_conform(&f)), "{name}");
                    assert_eq!(case["landsAs"], lands_as(&f).name(), "{name}");
                }
                Err(refused) => assert_eq!(case["refused"], refused.code, "{name}"),
            }
        }
    }

    #[test]
    fn a_clean_png_lands_as_it_is() {
        let dir = scratch("clean");
        let path = put(&dir, "parked.png", &checker(8, 8));
        let checked = check(&path, "shot.png", "png").unwrap();
        assert!(checked.converted.is_none());
        assert_eq!((checked.ext.as_str(), checked.notes.len()), ("png", 0));
        assert!(checked.transforms.is_empty());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn a_damaged_png_is_refused_where_the_stage_would_fail() {
        let dir = scratch("damaged");
        let whole = checker(64, 64);
        let cut = put(&dir, "cut.png", &whole[..whole.len() - 40]);
        let refused = check(&cut, "cut.png", "png").err().unwrap();
        assert_eq!(refused.code, "unreadable");
        assert!(crate::png_decode::decode_png_rgba(&std::fs::read(&cut).unwrap()).is_err());
        let mut flipped = whole.clone();
        let mid = flipped.len() / 2;
        flipped[mid] ^= 0xFF;
        let flipped = put(&dir, "flipped.png", &flipped);
        assert_eq!(
            check(&flipped, "flipped.png", "png").err().unwrap().code,
            "unreadable"
        );
    }

    #[test]
    fn a_blank_still_is_said_but_lands() {
        let dir = scratch("blank");
        let note = |name: &str, bytes: &[u8]| {
            let path = put(&dir, name, bytes);
            check(&path, name, "png").unwrap().notes.join(" ")
        };
        assert!(
            note("clear.png", &rgba_png(32, 32, |_, _| [0, 0, 0, 0])).contains("fully transparent")
        );
        assert!(note("white.png", &rgba_png(32, 32, |_, _| [255; 4])).contains("#ffffff"));
        let noise = rgba_png(16, 16, |x, y| [100 + ((x + y) % 2) as u8, 100, 100, 255]);
        assert!(note("noise.png", &noise).contains("flat colour"));
        let cut_out = rgba_png(32, 32, |x, _| if x < 16 { [255; 4] } else { [0; 4] });
        assert_eq!(note("mark.png", &cut_out), "");
    }

    #[test]
    fn a_name_that_lies_lands_under_the_real_extension() {
        let dir = scratch("lies");
        let path = put(&dir, "parked.jpg", &checker(8, 8));
        let checked = check(&path, "shot.jpg", "jpg").unwrap();
        assert_eq!(checked.ext, "png");
        assert!(
            checked.notes[0].contains("really a PNG"),
            "{:?}",
            checked.notes
        );
    }

    #[test]
    fn what_isnt_an_image_never_passes_and_leaves_nothing_behind() {
        let dir = scratch("foreign");
        for (bytes, why) in [
            (&b"not an image"[..], "first bytes"),
            (b"<html></html>", "HTML"),
            (b"%PDF-1.7", "PDF"),
            (b"", "empty"),
            (b"\0\0\0\x18ftypheic\0\0\0\0", "HEIC"),
        ] {
            let path = put(&dir, "parked.png", bytes);
            let refused = check(&path, "shot.png", "png").err().unwrap();
            assert_eq!(refused.code, "unreadable");
            assert!(refused.message.contains(why), "{}", refused.message);
            assert!(
                refused.message.starts_with("shot.png"),
                "{}",
                refused.message
            );
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn a_huge_file_is_refused_on_its_size_and_a_bomb_on_its_header() {
        let dir = scratch("huge");
        assert_eq!(
            check_size(MAX_BYTES + 1, "big.png").err().unwrap().code,
            "too-large"
        );
        assert!(check_size(MAX_BYTES, "big.png").is_ok());
        let mut bomb = b"\x89PNG\r\n\x1a\n".to_vec();
        let mut body = b"IHDR".to_vec();
        body.extend_from_slice(&20000u32.to_be_bytes());
        body.extend_from_slice(&20000u32.to_be_bytes());
        body.extend_from_slice(&[8, 6, 0, 0, 0]);
        bomb.extend_from_slice(&13u32.to_be_bytes());
        bomb.extend_from_slice(&body);
        bomb.extend_from_slice(&crc32(&body).to_be_bytes());
        bomb.extend_from_slice(&0u32.to_be_bytes());
        bomb.extend_from_slice(b"IDAT");
        bomb.extend_from_slice(&crc32(b"IDAT").to_be_bytes());
        let path = put(&dir, "bomb.png", &bomb);
        assert_eq!(
            check(&path, "bomb.png", "png").err().unwrap().code,
            "too-large"
        );
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    #[test]
    fn a_p3_png_is_baked_into_plain_srgb_pixels() {
        if !have_sips() {
            return;
        }
        let dir = scratch("p3");
        let tagged = p3_png(&dir);
        assert_eq!(
            needs_conform(&facts(&tagged, "t").unwrap()),
            ["colour-profile"]
        );
        let checked = check(&tagged, "shot.png", "png").unwrap();
        let converted = checked.converted.as_ref().unwrap();
        assert_eq!(checked.transforms[0]["to"], "srgb");
        assert_eq!(checked.transforms[0]["from"], "Display P3");
        let g = facts(&converted.0, "c").unwrap();
        assert!(needs_conform(&g).is_empty(), "{g:?}");
        // The raw values change: drawn as they were, the stage would wash them out.
        assert_ne!(rgba_of(&tagged).0, rgba_of(&converted.0).0);
        let scratch_file = converted.0.clone();
        drop(checked);
        assert!(!scratch_file.exists());
        assert!(tagged.is_file());
    }

    #[test]
    fn every_exif_turn_comes_in_upright() {
        if !have_sips() {
            return;
        }
        let dir = scratch("turns");
        let data = jpeg_of_four_quadrants(&dir);
        let wanted = [
            (2, "GR/WB"),
            (3, "WB/GR"),
            (4, "BW/RG"),
            (5, "RB/GW"),
            (6, "BR/WG"),
            (7, "WG/BR"),
            (8, "GW/RB"),
        ];
        for (orientation, picture) in wanted {
            let block = exif_turn(orientation);
            let mut turned = data[..2].to_vec();
            turned.extend_from_slice(&[0xFF, 0xE1]);
            turned.extend_from_slice(&((block.len() + 2) as u16).to_be_bytes());
            turned.extend_from_slice(&block);
            turned.extend_from_slice(&data[2..]);
            let path = put(&dir, "turned.jpg", &turned);
            let checked = check(&path, "turned.jpg", "jpg").unwrap();
            assert_eq!(checked.transforms[0]["op"], "upright", "{orientation}");
            assert_eq!(checked.ext, "jpg");
            let out = checked.converted.as_ref().unwrap();
            assert_eq!(
                facts(&out.0, "o").unwrap().orientation,
                None,
                "{orientation}"
            );
            let (size, seen) = corners(&out.0, &dir);
            assert_eq!(seen, picture, "{orientation}");
            assert_eq!(
                size,
                if orientation >= 5 { (20, 40) } else { (40, 20) },
                "{orientation}"
            );
        }
    }

    #[test]
    fn every_exif_turn_on_a_png_comes_in_upright_in_its_raw_pixels() {
        if !have_sips() {
            return;
        }
        let dir = scratch("png-turns");
        let plain = rgba_png(40, 20, |x, y| match (x < 20, y < 10) {
            (true, true) => [255, 0, 0, 255],
            (false, true) => [0, 255, 0, 255],
            (true, false) => [0, 0, 255, 255],
            (false, false) => [255, 255, 255, 255],
        });
        let wanted = [
            (2, "GR/WB"),
            (3, "WB/GR"),
            (4, "BW/RG"),
            (5, "RB/GW"),
            (6, "BR/WG"),
            (7, "WG/BR"),
            (8, "GW/RB"),
        ];
        for (orientation, picture) in wanted {
            let exif = exif_turn(orientation);
            let block = &exif[6..];
            let mut chunk = (block.len() as u32).to_be_bytes().to_vec();
            chunk.extend_from_slice(b"eXIf");
            chunk.extend_from_slice(block);
            let mut typed = b"eXIf".to_vec();
            typed.extend_from_slice(block);
            chunk.extend_from_slice(&crc32(&typed).to_be_bytes());
            // After the signature and IHDR, before the pixels.
            let mut turned = plain[..33].to_vec();
            turned.extend_from_slice(&chunk);
            turned.extend_from_slice(&plain[33..]);
            let path = put(&dir, "turned.png", &turned);
            let checked = check(&path, "turned.png", "png").unwrap();
            assert_eq!(checked.transforms[0]["op"], "upright", "{orientation}");
            let out = checked.converted.as_ref().unwrap();
            assert_eq!(
                facts(&out.0, "o").unwrap().orientation,
                None,
                "{orientation}"
            );
            let (rgba, width, height) = rgba_of(&out.0);
            let name = |x: u32, y: u32| {
                let at = ((y * width + x) * 4) as usize;
                match (rgba[at] > 180, rgba[at + 1] > 180, rgba[at + 2] > 180) {
                    (true, true, true) => 'W',
                    (true, _, _) => 'R',
                    (_, true, _) => 'G',
                    _ => 'B',
                }
            };
            let seen = format!(
                "{}{}/{}{}",
                name(width / 4, height / 4),
                name(3 * width / 4, height / 4),
                name(width / 4, 3 * height / 4),
                name(3 * width / 4, 3 * height / 4)
            );
            assert_eq!(seen, picture, "{orientation}");
            assert_eq!(
                (width, height),
                if orientation >= 5 { (20, 40) } else { (40, 20) },
                "{orientation}"
            );
        }
    }

    #[test]
    fn a_cmyk_jpeg_comes_in_as_rgb_and_stays_a_jpeg() {
        if !have_sips() || !Path::new(CMYK_PROFILE).is_file() {
            return;
        }
        let dir = scratch("cmyk");
        let plain = put(&dir, "plain.jpg", &jpeg_of_four_quadrants(&dir));
        let cmyk = dir.join("cmyk.jpg");
        assert!(sips(&["--matchTo", CMYK_PROFILE], &plain, &cmyk));
        assert_eq!(facts(&cmyk, "c").unwrap().space, "cmyk");
        // `.jpeg` keeps its spelling: only a format that changed changes the name.
        let checked = check(&cmyk, "print.jpeg", "jpeg").unwrap();
        assert_eq!(checked.ext, "jpeg");
        assert_eq!(checked.transforms[0]["from"], "cmyk");
        let g = facts(&checked.converted.as_ref().unwrap().0, "o").unwrap();
        assert_eq!((g.format, g.space), (Format::Jpeg, "rgb"));
    }

    #[test]
    fn a_webp_that_has_to_change_becomes_a_png_and_one_that_needn_t_stays() {
        if !have_sips() {
            return;
        }
        let dir = scratch("webp");
        let riff = |parts: &[&[u8]]| {
            let body: Vec<u8> = parts.concat();
            let mut out = b"RIFF".to_vec();
            out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
            out.extend_from_slice(b"WEBP");
            out.extend_from_slice(&body);
            out
        };
        let plain = put(&dir, "plain.webp", &riff(&[TINY_WEBP_FRAME]));
        let same = check(&plain, "plain.webp", "webp").unwrap();
        assert!(same.converted.is_none());
        assert_eq!(same.ext, "webp");
        let profile = std::fs::read(P3_PROFILE).unwrap();
        let mut iccp = b"ICCP".to_vec();
        iccp.extend_from_slice(&(profile.len() as u32).to_le_bytes());
        iccp.extend_from_slice(&profile);
        if profile.len() % 2 == 1 {
            iccp.push(0);
        }
        let mut vp8x = b"VP8X".to_vec();
        vp8x.extend_from_slice(&10u32.to_le_bytes());
        vp8x.extend_from_slice(&[0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        let wide = put(&dir, "wide.webp", &riff(&[&vp8x, &iccp, TINY_WEBP_FRAME]));
        let checked = check(&wide, "wide.webp", "webp").unwrap();
        assert_eq!(checked.ext, "png");
        assert_eq!(checked.transforms[0]["op"], "colour");
        let g = facts(&checked.converted.as_ref().unwrap().0, "o").unwrap();
        assert_eq!(g.format, Format::Png);
    }

    #[test]
    fn a_jpeg_only_sips_can_read_is_decoded_and_refused_when_it_wont() {
        if !have_sips() {
            return;
        }
        let dir = scratch("jpeg");
        let good = put(&dir, "good.jpg", &jpeg_of_four_quadrants(&dir));
        assert!(check(&good, "good.jpg", "jpg").unwrap().notes.is_empty());
        let mut hollow =
            b"\xff\xd8\xff\xc0\x00\x11\x08\x00\x10\x00\x10\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00"
                .to_vec();
        hollow.extend_from_slice(&[0x12; 64]);
        let hollow = put(&dir, "hollow.jpg", &hollow);
        assert_eq!(facts(&hollow, "h").unwrap().width, 16);
        let refused = check(&hollow, "hollow.jpg", "jpg").err().unwrap();
        assert_eq!(refused.code, "unreadable");
        assert!(refused.message.starts_with("hollow.jpg"));
        let flat = put(
            &dir,
            "flat.png",
            &rgba_png(300, 300, |_, _| [90, 90, 90, 255]),
        );
        let flat_jpeg = dir.join("flat.jpg");
        assert!(sips(&["-s", "format", "jpeg"], &flat, &flat_jpeg));
        assert!(check(&flat_jpeg, "flat.jpg", "jpg").unwrap().notes[0].contains("flat colour"));
        assert!(!dir.join("flat.jpg.look.png").exists());
    }
}
