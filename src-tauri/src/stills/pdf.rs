//! A streaming PDF 1.7 writer for the stills handout: each page's objects go to disk as the page arrives, and only the document-level objects (fonts, outlines, info, catalog, page tree, xref) wait for `finish`. Uncompressed, classic xref table, no map iteration anywhere near the output order.

use std::fmt::Write as _;
use std::io::{self, Write};

use sha2::{Digest, Sha256};

use super::jpeg::JpegInfo;
use super::pdf_font::{glyphless_ttf, CidMap, ADVANCE, ASCENT, DESCENT, FONT_NAME};
use super::{Civil, PageMeta, TextItem};

/// Every page's short edge, in points: a 16:9 page is 960 x 540.
pub(crate) const SHORT_EDGE_PT: f64 = 540.0;
/// Below this the text layer is unselectable anyway, and a near-zero `Tf` upsets viewers.
const MIN_FONT_SIZE: f64 = 0.01;
const CATALOG: u32 = 1;
const PAGES: u32 = 2;
/// The xref table's offsets are ten digits wide.
const MAX_OFFSET: u64 = 9_999_999_999;

/// How the invisible text is stretched over its line's box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Stretch {
    Tz,
    #[allow(dead_code)]
    Matrix,
}

pub(crate) const STRETCH: Stretch = Stretch::Tz;

pub(crate) fn page_size_pt(format_width: u32, format_height: u32) -> (f64, f64) {
    let (w, h) = (f64::from(format_width), f64::from(format_height));
    let round2 = |v: f64| (v * 100.0).round() / 100.0;
    if w >= h {
        (round2(SHORT_EDGE_PT * w / h), SHORT_EDGE_PT)
    } else {
        (SHORT_EDGE_PT, round2(SHORT_EDGE_PT * h / w))
    }
}

/// A PDF number: at most three decimals, trailing zeros trimmed, never `-0`.
pub(crate) fn num(value: f64) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    let mut s = format!("{:.3}", (value * 1000.0).round() / 1000.0);
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    if s == "-0" {
        s = "0".into();
    }
    s
}

/// A PDF text string: an escaped literal when printable ASCII, else UTF-16BE hex with a BOM; control characters are dropped.
pub(crate) fn pdf_string(text: &str) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    if clean.chars().all(|c| (' '..='~').contains(&c)) {
        let mut out = String::with_capacity(clean.len() + 2);
        out.push('(');
        for c in clean.chars() {
            if matches!(c, '\\' | '(' | ')') {
                out.push('\\');
            }
            out.push(c);
        }
        out.push(')');
        out
    } else {
        let mut out = String::from("<FEFF");
        for unit in clean.encode_utf16() {
            let _ = write!(out, "{unit:04X}");
        }
        out.push('>');
        out
    }
}

pub(crate) fn pdf_date(civil: &Civil) -> String {
    let sign = if civil.offset_minutes < 0 { '-' } else { '+' };
    let offset = civil.offset_minutes.unsigned_abs();
    format!(
        "D:{:04}{:02}{:02}{:02}{:02}{:02}{sign}{:02}'{:02}'",
        civil.year,
        civil.month,
        civil.day,
        civil.hour,
        civil.minute,
        civil.second,
        offset / 60,
        offset % 60
    )
}

/// `m:ss.s` for a still's outline entry.
pub(crate) fn outline_time(ms: f64) -> String {
    let tenths = if ms.is_finite() && ms > 0.0 {
        (ms / 100.0).round() as u64
    } else {
        0
    };
    let rest = tenths % 600;
    format!("{}:{:02}.{}", tenths / 600, rest / 10, rest % 10)
}

fn drawable(item: &TextItem, page_height: f64) -> bool {
    item.h * page_height >= MIN_FONT_SIZE && item.w > 0.0
}

/// One invisible line: glyphs sized so their box fills the item's rect (advance 0.5 em, baseline 0.2 em above the bottom).
pub(crate) fn text_op(
    cids: &[u16],
    item: &TextItem,
    page_width: f64,
    page_height: f64,
    stretch: Stretch,
) -> Option<String> {
    if cids.is_empty() || !drawable(item, page_height) {
        return None;
    }
    let font_size = item.h * page_height;
    let x = item.x * page_width;
    let y = page_height * (1.0 - item.y - item.h) - f64::from(DESCENT) / 1000.0 * font_size;
    let advance = f64::from(ADVANCE) / 1000.0;
    let scale = item.w * page_width / (cids.len() as f64 * advance * font_size);
    let mut hex = String::with_capacity(cids.len() * 4);
    for cid in cids {
        let _ = write!(hex, "{cid:04X}");
    }
    let (fs, x, y) = (num(font_size), num(x), num(y));
    Some(match stretch {
        Stretch::Tz => format!(
            "BT 3 Tr /F0 {fs} Tf {} Tz 1 0 0 1 {x} {y} Tm <{hex}> Tj ET\n",
            num(scale * 100.0)
        ),
        Stretch::Matrix => format!(
            "BT 3 Tr /F0 {fs} Tf {} 0 0 1 {x} {y} Tm <{hex}> Tj ET\n",
            num(scale)
        ),
    })
}

/// The document information dictionary; `None` fields are left out (reproducible mode drops the author and dates).
pub(crate) struct DocInfo {
    pub(crate) title: String,
    pub(crate) author: Option<String>,
    pub(crate) creator: String,
    pub(crate) date: Option<String>,
}

struct Counting<W> {
    inner: W,
    count: u64,
}

impl<W: Write> Write for Counting<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.count += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

struct PageRecord {
    obj: u32,
    scene_index: u32,
    title: String,
    scene_ms: f64,
}

pub(crate) struct PdfWriter<W: Write> {
    out: Counting<W>,
    /// Byte offset of each object, indexed by object number (0 is the free-list head).
    offsets: Vec<u64>,
    width: f64,
    height: f64,
    pages: Vec<PageRecord>,
    /// The Type0 font's number, reserved by the first page with text and written at finish.
    font: Option<u32>,
    cids: CidMap,
    id: Sha256,
    info: DocInfo,
}

impl<W: Write> PdfWriter<W> {
    pub(crate) fn new(inner: W, page_size: (f64, f64), info: DocInfo) -> io::Result<Self> {
        let mut writer = PdfWriter {
            out: Counting { inner, count: 0 },
            offsets: vec![0; 3],
            width: page_size.0,
            height: page_size.1,
            pages: Vec::new(),
            font: None,
            cids: CidMap::default(),
            id: Sha256::new(),
            info,
        };
        writer.out.write_all(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n")?;
        Ok(writer)
    }

    fn alloc(&mut self) -> u32 {
        self.offsets.push(0);
        (self.offsets.len() - 1) as u32
    }

    fn begin(&mut self, obj: u32) -> io::Result<()> {
        self.offsets[obj as usize] = self.out.count;
        writeln!(self.out, "{obj} 0 obj")
    }

    fn object(&mut self, obj: u32, body: &str) -> io::Result<()> {
        self.begin(obj)?;
        self.out.write_all(body.as_bytes())?;
        self.out.write_all(b"\nendobj\n")
    }

    fn stream(&mut self, obj: u32, dict: &str, data: &[u8]) -> io::Result<()> {
        self.begin(obj)?;
        let sep = if dict.is_empty() { "" } else { " " };
        write!(
            self.out,
            "<< {dict}{sep}/Length {} >>\nstream\n",
            data.len()
        )?;
        self.out.write_all(data)?;
        self.out.write_all(b"\nendstream\nendobj\n")
    }

    /// Writes one page (image, content stream, page dictionary); `digest` is the page payload's SHA-256, folded into the document `/ID`.
    pub(crate) fn write_page(
        &mut self,
        jpeg: &[u8],
        info: JpegInfo,
        text: &[TextItem],
        meta: &PageMeta,
        digest: &[u8],
    ) -> io::Result<()> {
        self.id.update(digest);
        let image = self.alloc();
        let content = self.alloc();
        let page = self.alloc();
        let colour = if info.components == 1 {
            "/DeviceGray"
        } else {
            "/DeviceRGB"
        };
        self.stream(
            image,
            &format!(
                "/Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace {colour} /BitsPerComponent 8 /Filter /DCTDecode",
                info.width, info.height
            ),
            jpeg,
        )?;
        let (pw, ph) = (num(self.width), num(self.height));
        let mut ops = format!("q {pw} 0 0 {ph} 0 0 cm /Im0 Do Q\n");
        let mut has_text = false;
        for item in text {
            if !drawable(item, self.height) {
                continue;
            }
            let chars: Vec<char> = item.text.chars().filter(|c| !c.is_control()).collect();
            let inked = chars.len() == 1;
            let cids: Vec<u16> = chars
                .into_iter()
                .filter_map(|c| self.cids.cid(c, inked))
                .collect();
            if let Some(op) = text_op(&cids, item, self.width, self.height, STRETCH) {
                ops.push_str(&op);
                has_text = true;
            }
        }
        self.stream(content, "", ops.as_bytes())?;
        let mut resources = format!("/XObject << /Im0 {image} 0 R >>");
        if has_text {
            let font = match self.font {
                Some(font) => font,
                None => {
                    let font = self.alloc();
                    self.font = Some(font);
                    font
                }
            };
            let _ = write!(resources, " /Font << /F0 {font} 0 R >>");
        }
        self.object(
            page,
            &format!(
                "<< /Type /Page /Parent {PAGES} 0 R /MediaBox [0 0 {pw} {ph}] /Resources << {resources} >> /Contents {content} 0 R >>"
            ),
        )?;
        self.pages.push(PageRecord {
            obj: page,
            scene_index: meta.scene_index,
            title: meta.scene_title(),
            scene_ms: meta.scene_ms,
        });
        Ok(())
    }

    fn write_font(&mut self, type0: u32) -> io::Result<()> {
        let cid_font = self.alloc();
        let descriptor = self.alloc();
        let file = self.alloc();
        let gid_map = self.alloc();
        let to_unicode = self.alloc();
        self.object(
            type0,
            &format!(
                "<< /Type /Font /Subtype /Type0 /BaseFont /{FONT_NAME} /Encoding /Identity-H /DescendantFonts [{cid_font} 0 R] /ToUnicode {to_unicode} 0 R >>"
            ),
        )?;
        self.object(
            cid_font,
            &format!(
                "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{FONT_NAME} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {descriptor} 0 R /DW {ADVANCE} /CIDToGIDMap {gid_map} 0 R >>"
            ),
        )?;
        self.object(
            descriptor,
            &format!(
                "<< /Type /FontDescriptor /FontName /{FONT_NAME} /Flags 4 /FontBBox [0 {DESCENT} {ADVANCE} {ASCENT}] /ItalicAngle 0 /Ascent {ASCENT} /Descent {DESCENT} /CapHeight 700 /StemV 80 /FontFile2 {file} 0 R >>"
            ),
        )?;
        let ttf = glyphless_ttf();
        self.stream(file, &format!("/Length1 {}", ttf.len()), &ttf)?;
        let map = self.cids.cid_to_gid_map();
        self.stream(gid_map, "", &map)?;
        let cmap = self.cids.to_unicode_cmap();
        self.stream(to_unicode, "", cmap.as_bytes())
    }

    /// One top-level item per scene run (its first page), with `m:ss.s` children when the scene has several stills.
    fn write_outlines(&mut self) -> io::Result<Option<u32>> {
        let mut runs: Vec<(usize, usize)> = Vec::new();
        for (index, page) in self.pages.iter().enumerate() {
            match runs.last_mut() {
                Some((start, end)) if self.pages[*start].scene_index == page.scene_index => {
                    *end = index + 1
                }
                _ => runs.push((index, index + 1)),
            }
        }
        if runs.is_empty() {
            return Ok(None);
        }
        let root = self.alloc();
        let items: Vec<u32> = runs.iter().map(|_| self.alloc()).collect();
        let children: Vec<Vec<u32>> = runs
            .iter()
            .map(|&(start, end)| {
                if end - start > 1 {
                    (start..end).map(|_| self.alloc()).collect()
                } else {
                    Vec::new()
                }
            })
            .collect();
        let (first, last) = (items[0], items[items.len() - 1]);
        self.object(
            root,
            &format!(
                "<< /Type /Outlines /First {first} 0 R /Last {last} 0 R /Count {} >>",
                items.len()
            ),
        )?;
        for (k, &(start, _)) in runs.iter().enumerate() {
            let mut dict = format!(
                "<< /Title {} /Parent {root} 0 R",
                pdf_string(&self.pages[start].title)
            );
            sibling_links(&mut dict, &items, k);
            let kids = &children[k];
            if let (Some(first), Some(last)) = (kids.first(), kids.last()) {
                let _ = write!(
                    dict,
                    " /First {first} 0 R /Last {last} 0 R /Count -{}",
                    kids.len()
                );
            }
            let _ = write!(dict, " /Dest [{} 0 R /Fit] >>", self.pages[start].obj);
            self.object(items[k], &dict)?;
            for (j, &child) in kids.iter().enumerate() {
                let page = &self.pages[start + j];
                let mut dict = format!(
                    "<< /Title {} /Parent {} 0 R",
                    pdf_string(&outline_time(page.scene_ms)),
                    items[k]
                );
                sibling_links(&mut dict, kids, j);
                let _ = write!(dict, " /Dest [{} 0 R /Fit] >>", page.obj);
                self.object(child, &dict)?;
            }
        }
        Ok(Some(root))
    }

    /// Writes the document-level objects, the xref table and the trailer, and hands back the inner writer.
    pub(crate) fn finish(mut self) -> io::Result<W> {
        if let Some(type0) = self.font {
            self.write_font(type0)?;
        }
        let outlines = self.write_outlines()?;

        let info_obj = self.alloc();
        let mut info = format!("<< /Title {}", pdf_string(&self.info.title));
        if let Some(author) = &self.info.author {
            let _ = write!(info, " /Author {}", pdf_string(author));
        }
        let _ = write!(
            info,
            " /Creator {} /Producer (Kookaburra Cut)",
            pdf_string(&self.info.creator)
        );
        if let Some(date) = &self.info.date {
            let _ = write!(info, " /CreationDate ({date}) /ModDate ({date})");
        }
        info.push_str(" >>");
        self.object(info_obj, &info)?;

        let mut catalog = format!("<< /Type /Catalog /Pages {PAGES} 0 R");
        if let Some(outlines) = outlines {
            let _ = write!(catalog, " /Outlines {outlines} 0 R /PageMode /UseOutlines");
        }
        catalog.push_str(" /ViewerPreferences << /DisplayDocTitle true >> >>");
        self.object(CATALOG, &catalog)?;

        let kids: Vec<String> = self
            .pages
            .iter()
            .map(|page| format!("{} 0 R", page.obj))
            .collect();
        let pages = format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            self.pages.len()
        );
        self.object(PAGES, &pages)?;

        let xref = self.out.count;
        let size = self.offsets.len();
        write!(self.out, "xref\n0 {size}\n0000000000 65535 f\r\n")?;
        for (obj, &offset) in self.offsets.iter().enumerate().skip(1) {
            if offset == 0 || offset > MAX_OFFSET {
                return Err(io::Error::other(format!(
                    "PDF object {obj} has no usable offset ({offset})"
                )));
            }
            write!(self.out, "{offset:010} 00000 n\r\n")?;
        }
        let mut id = std::mem::take(&mut self.id);
        id.update(self.info.title.as_bytes());
        let id = crate::hex_digest(&id.finalize()[..16]);
        write!(
            self.out,
            "trailer\n<< /Size {size} /Root {CATALOG} 0 R /Info {info_obj} 0 R /ID [<{id}> <{id}>] >>\nstartxref\n{xref}\n%%EOF\n"
        )?;
        self.out.flush()?;
        Ok(self.out.inner)
    }
}

fn sibling_links(dict: &mut String, siblings: &[u32], index: usize) {
    if index > 0 {
        let _ = write!(dict, " /Prev {} 0 R", siblings[index - 1]);
    }
    if let Some(next) = siblings.get(index + 1) {
        let _ = write!(dict, " /Next {next} 0 R");
    }
}
