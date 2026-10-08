use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

use super::commands::{decode_meta, doc_info, finalise, parse_text_layer, prepare_body, Prepared};
use super::jpeg::{parse_jpeg, JpegInfo};
use super::pdf::{
    num, outline_time, page_size_pt, pdf_date, pdf_string, text_op, DocInfo, PdfWriter, Stretch,
};
use super::pdf_font::{glyphless_ttf, table_checksum, CidMap};
use super::pngzip::{
    encode_png, entry_file, number_width, rgba_to_rgb, scene_slug, zip_timestamp, PngZipWriter,
    ZipMeta,
};
use super::*;
use crate::ExportState;

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("kc-stills-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn meta(scene_index: u32, scene_name: &str, scene_ms: f64) -> PageMeta {
    PageMeta {
        scene_index,
        scene_name: scene_name.into(),
        kind: StillKind::Auto,
        scene_ms,
        global_ms: scene_ms + 10_000.0 * f64::from(scene_index),
    }
}

/// SOI, an APP0 stub, a frame header, a stub scan and EOI: enough for `parse_jpeg` and the PDF writer.
fn fake_jpeg(sof: u8, width: u16, height: u16, components: u8) -> Vec<u8> {
    let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46];
    let len = 8 + 3 * u16::from(components);
    jpeg.extend_from_slice(&[0xFF, sof]);
    jpeg.extend_from_slice(&len.to_be_bytes());
    jpeg.push(8);
    jpeg.extend_from_slice(&height.to_be_bytes());
    jpeg.extend_from_slice(&width.to_be_bytes());
    jpeg.push(components);
    for id in 0..components {
        jpeg.extend_from_slice(&[id + 1, 0x11, 0]);
    }
    jpeg.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0x12, 0x34, 0xFF, 0xD9]);
    jpeg
}

fn item(text: &str, x: f64, y: f64, w: f64, h: f64) -> TextItem {
    TextItem {
        text: text.into(),
        x,
        y,
        w,
        h,
    }
}

fn plain_info(title: &str) -> DocInfo {
    doc_info(title, "9.9.9", None)
}

fn write_pdf(pages: &[(PageMeta, Vec<TextItem>)], info: DocInfo) -> Vec<u8> {
    let jpeg = fake_jpeg(0xC0, 16, 9, 3);
    let parsed = parse_jpeg(&jpeg).unwrap();
    let mut writer = PdfWriter::new(Vec::new(), page_size_pt(3840, 2160), info).unwrap();
    for (index, (meta, text)) in pages.iter().enumerate() {
        writer
            .write_page(&jpeg, parsed, text, meta, &[index as u8; 32])
            .unwrap();
    }
    writer.finish().unwrap()
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

/// A minimal classic-xref reader: object offsets by number, plus the trailer text.
struct ParsedPdf<'a> {
    bytes: &'a [u8],
    offsets: Vec<usize>,
    trailer: String,
}

impl<'a> ParsedPdf<'a> {
    fn parse(bytes: &'a [u8]) -> Self {
        let line_at = |from: usize| {
            let end = from + bytes[from..].iter().position(|&b| b == b'\n').unwrap();
            (std::str::from_utf8(&bytes[from..end]).unwrap(), end + 1)
        };
        let at = bytes
            .windows(10)
            .rposition(|w| w == b"startxref\n")
            .unwrap();
        let xref: usize = line_at(at + 10).0.parse().unwrap();
        assert!(
            bytes[xref..].starts_with(b"xref\n0 "),
            "startxref lands on xref"
        );
        let (header, table_at) = line_at(xref + 5);
        let size: usize = header.split(' ').nth(1).unwrap().parse().unwrap();
        let table = &bytes[table_at..];
        assert_eq!(&table[..20], b"0000000000 65535 f\r\n");
        let mut offsets = vec![0];
        for n in 1..size {
            let entry = std::str::from_utf8(&table[n * 20..n * 20 + 20]).unwrap();
            assert!(entry.ends_with(" 00000 n\r\n"), "entry {n}: {entry:?}");
            let offset: usize = entry[..10].parse().unwrap();
            assert!(
                bytes[offset..].starts_with(format!("{n} 0 obj\n").as_bytes()),
                "object {n} offset lands on its header"
            );
            offsets.push(offset);
        }
        let trailer = String::from_utf8_lossy(&bytes[table_at + size * 20..]).into_owned();
        assert!(trailer.starts_with("trailer\n<< "));
        assert!(trailer.contains(&format!("/Size {size} ")));
        assert!(trailer.ends_with("%%EOF\n"));
        ParsedPdf {
            bytes,
            offsets,
            trailer,
        }
    }

    fn object(&self, n: u32) -> String {
        let start = self.offsets[n as usize];
        let text = String::from_utf8_lossy(&self.bytes[start..]);
        let end = text.find("endobj").unwrap();
        text[..end].to_string()
    }
}

fn reference(dict: &str, key: &str) -> Option<u32> {
    let at = dict.find(&format!("/{key} "))?;
    dict[at + key.len() + 2..].split(' ').next()?.parse().ok()
}

fn dest(dict: &str) -> u32 {
    let at = dict.find("/Dest [").unwrap();
    dict[at + 7..].split(' ').next().unwrap().parse().unwrap()
}

#[test]
fn page_size_has_a_540_point_short_edge_for_every_format() {
    let cases = [
        ((3840, 2160), (960.0, 540.0)),
        ((2160, 3840), (540.0, 960.0)),
        ((2160, 2160), (540.0, 540.0)),
        ((2160, 2700), (540.0, 675.0)),
        ((2700, 2160), (675.0, 540.0)),
        ((3240, 2160), (810.0, 540.0)),
        ((2160, 3240), (540.0, 810.0)),
        ((1206, 2622), (540.0, 1174.03)),
        ((2622, 1206), (1174.03, 540.0)),
    ];
    for ((w, h), expected) in cases {
        assert_eq!(page_size_pt(w, h), expected, "{w}x{h}");
    }
}

#[test]
fn numbers_keep_three_decimals_and_never_print_negative_zero() {
    assert_eq!(num(960.0), "960");
    assert_eq!(num(1174.03), "1174.03");
    assert_eq!(num(1.23456), "1.235");
    assert_eq!(num(0.1 + 0.2), "0.3");
    assert_eq!(num(-0.0), "0");
    assert_eq!(num(-0.0004), "0");
    assert_eq!(num(-2.5), "-2.5");
    assert_eq!(num(f64::NAN), "0");
    assert_eq!(num(f64::INFINITY), "0");
}

#[test]
fn strings_escape_ascii_and_switch_to_utf16_for_anything_else() {
    assert_eq!(pdf_string("Launch (2026)"), "(Launch \\(2026\\))");
    assert_eq!(pdf_string("a\\b"), "(a\\\\b)");
    assert_eq!(pdf_string("Café"), "<FEFF00430061006600E9>");
    assert_eq!(pdf_string("你好"), "<FEFF4F60597D>");
    assert_eq!(pdf_string("😀"), "<FEFFD83DDE00>");
    assert_eq!(pdf_string("a\u{0}b\nc\u{7f}d\u{85}"), "(abcd)");
    assert_eq!(pdf_string("\u{1}é"), "<FEFF00E9>");
}

#[test]
fn dates_carry_the_local_offset() {
    let civil = Civil {
        year: 2026,
        month: 10,
        day: 8,
        hour: 9,
        minute: 5,
        second: 7,
        offset_minutes: 600,
    };
    assert_eq!(pdf_date(&civil), "D:20261008090507+10'00'");
    let west = Civil {
        offset_minutes: -270,
        ..civil
    };
    assert_eq!(pdf_date(&west), "D:20261008090507-04'30'");
    let utc = Civil {
        offset_minutes: 0,
        ..civil
    };
    assert_eq!(pdf_date(&utc), "D:20261008090507+00'00'");
}

#[test]
fn outline_times_read_as_minutes_seconds_and_tenths() {
    assert_eq!(outline_time(0.0), "0:00.0");
    assert_eq!(outline_time(4500.0), "0:04.5");
    assert_eq!(outline_time(62_049.0), "1:02.0");
    assert_eq!(outline_time(59_960.0), "1:00.0");
    assert_eq!(outline_time(f64::NAN), "0:00.0");
}

#[test]
fn jpeg_headers_accept_baseline_and_progressive_frames() {
    assert_eq!(
        parse_jpeg(&fake_jpeg(0xC0, 1920, 1080, 3)).unwrap(),
        JpegInfo {
            width: 1920,
            height: 1080,
            components: 3
        }
    );
    assert_eq!(
        parse_jpeg(&fake_jpeg(0xC2, 640, 360, 1))
            .unwrap()
            .components,
        1
    );
}

#[test]
fn jpeg_headers_reject_broken_or_unsupported_files() {
    let good = fake_jpeg(0xC0, 32, 18, 3);
    assert!(parse_jpeg(&good[2..])
        .unwrap_err()
        .contains("start-of-image"));
    assert!(parse_jpeg(&good[..good.len() - 2])
        .unwrap_err()
        .contains("end-of-image"));
    let mut truncated = good[..12].to_vec();
    truncated.extend_from_slice(&[0xFF, 0xD9]);
    assert!(parse_jpeg(&truncated).is_err());
    assert!(parse_jpeg(&fake_jpeg(0xC3, 32, 18, 3))
        .unwrap_err()
        .contains("SOF3"));
    assert!(parse_jpeg(&fake_jpeg(0xC0, 32, 18, 4)).is_err());
    assert!(parse_jpeg(&fake_jpeg(0xC0, 0, 18, 3)).is_err());
    assert!(parse_jpeg(&[0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0xFF, 0xD9]).is_err());
}

#[test]
fn pdf_bodies_must_match_their_headers() {
    let jpeg = fake_jpeg(0xC0, 32, 18, 3);
    let text = br#"[{"text":"Hi","x":0.1,"y":0.1,"w":0.2,"h":0.05}]"#;
    let mut body = jpeg.clone();
    body.extend_from_slice(text);
    match prepare_body(StillsKind::Pdf, &body, 32, 18, text.len()).unwrap() {
        Prepared::Ready(PagePayload::Pdf {
            jpeg: bytes, text, ..
        }) => {
            assert_eq!(bytes, jpeg);
            assert_eq!(text.len(), 1);
        }
        _ => panic!("expected a PDF page"),
    }
    assert!(prepare_body(StillsKind::Pdf, &body, 64, 36, text.len())
        .err()
        .unwrap()
        .contains("headers say"));
    assert!(prepare_body(StillsKind::Pdf, &body, 32, 18, 0).is_err());
    assert!(prepare_body(StillsKind::Pdf, &jpeg, 32, 18, jpeg.len() + 1).is_err());
    assert!(prepare_body(StillsKind::PngZip, &[0; 16], 2, 2, 0).is_ok());
    assert!(prepare_body(StillsKind::PngZip, &[0; 15], 2, 2, 0).is_err());
    assert!(prepare_body(StillsKind::PngZip, &[0; 16], 2, 2, 4).is_err());
}

#[test]
fn text_layers_enforce_their_limits() {
    assert!(parse_text_layer(b"").unwrap().is_empty());
    assert!(parse_text_layer(b"[]").unwrap().is_empty());
    let long = format!(
        r#"[{{"text":"{}","x":0,"y":0,"w":1,"h":0.1}}]"#,
        "a".repeat(2001)
    );
    assert!(parse_text_layer(long.as_bytes()).is_err());
    let many = format!(
        "[{}]",
        vec![r#"{"text":"a","x":0,"y":0,"w":1,"h":0.1}"#; 4001].join(",")
    );
    assert!(parse_text_layer(many.as_bytes()).is_err());
    assert!(parse_text_layer(br#"[{"text":"a","x":1e999,"y":0,"w":1,"h":0.1}]"#).is_err());
    assert!(parse_text_layer(b"{}").is_err());
}

#[test]
fn page_meta_decodes_from_base64_json() {
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD.encode(
        r#"{"sceneIndex":2,"sceneName":"Café","kind":"marked","sceneMs":1500,"globalMs":9500.5}"#,
    );
    let meta = decode_meta(&raw).unwrap();
    assert_eq!(meta.scene_index, 2);
    assert_eq!(meta.scene_title(), "Café");
    assert_eq!(meta.kind, StillKind::Marked);
    assert_eq!(meta.global_ms, 9500.5);
    let negative = base64::engine::general_purpose::STANDARD
        .encode(r#"{"sceneIndex":0,"kind":"auto","sceneMs":-1,"globalMs":0}"#);
    assert!(decode_meta(&negative).is_err());
    assert!(decode_meta("not base64!").is_err());
    assert!(decode_meta(&"A".repeat(9000)).is_err());
    assert_eq!(meta_with_blank_name().scene_title(), "Scene 4");
}

fn meta_with_blank_name() -> PageMeta {
    meta(3, " \t ", 0.0)
}

#[test]
fn text_operators_fill_the_line_box() {
    let line = item("Hi", 0.1, 0.2, 0.25, 0.1);
    assert_eq!(
        text_op(&[1, 2], &line, 960.0, 540.0, Stretch::Tz).unwrap(),
        "BT 3 Tr /F0 54 Tf 444.444 Tz 1 0 0 1 96 388.8 Tm <00010002> Tj ET\n"
    );
    assert_eq!(
        text_op(&[1, 2], &line, 960.0, 540.0, Stretch::Matrix).unwrap(),
        "BT 3 Tr /F0 54 Tf 4.444 0 0 1 96 388.8 Tm <00010002> Tj ET\n"
    );
    assert!(text_op(&[], &line, 960.0, 540.0, Stretch::Tz).is_none());
    assert!(text_op(
        &[1],
        &item("a", 0.0, 0.0, 0.0, 0.1),
        960.0,
        540.0,
        Stretch::Tz
    )
    .is_none());
    assert!(text_op(
        &[1],
        &item("a", 0.0, 0.0, 0.1, 0.0),
        960.0,
        540.0,
        Stretch::Tz
    )
    .is_none());
}

#[test]
fn cids_follow_first_appearance_and_tounicode_chunks_by_100() {
    let mut cids = CidMap::default();
    assert_eq!(cids.cid('b', false), Some(1));
    assert_eq!(cids.cid('a', false), Some(2));
    assert_eq!(cids.cid('b', false), Some(1));
    assert_eq!(cids.cid('😀', false), Some(3));
    for c in (0x4E00u32..0x4E00 + 147).filter_map(char::from_u32) {
        cids.cid(c, false);
    }
    assert_eq!(cids.len(), 150);
    let cmap = cids.to_unicode_cmap();
    assert!(cmap.contains("100 beginbfchar\n<0001> <0062>\n<0002> <0061>\n<0003> <D83DDE00>\n"));
    assert!(cmap.contains("50 beginbfchar\n<0065> <4E61>\n"));
    assert_eq!(cmap.matches("beginbfchar").count(), 2);
    assert_eq!(cmap.matches("endbfchar").count(), 2);
    assert!(cmap.ends_with("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"));
    let map = cids.cid_to_gid_map();
    assert_eq!(map.len(), 151 * 2);
    assert_eq!(&map[..4], &[0, 0, 0, 1]);
    assert!(map[2..].chunks(2).all(|gid| gid == [0, 1]));
}

#[test]
fn inked_cids_map_the_same_text_onto_glyph_2() {
    let mut cids = CidMap::default();
    assert_eq!(cids.cid('4', false), Some(1));
    assert_eq!(cids.cid('4', true), Some(2));
    assert_eq!(cids.cid('4', true), Some(2));
    assert_eq!(cids.cid('4', false), Some(1));
    assert_eq!(cids.cid_to_gid_map(), [0, 0, 0, 1, 0, 2]);
    assert!(cids
        .to_unicode_cmap()
        .contains("2 beginbfchar\n<0001> <0034>\n<0002> <0034>\nendbfchar\n"));
}

#[test]
fn one_glyph_lines_draw_inked_and_longer_lines_do_not() {
    let pages = vec![(
        meta(0, "Chart", 0.0),
        vec![
            item("40", 0.1, 0.1, 0.04, 0.03),
            item("4", 0.1, 0.2, 0.02, 0.03),
        ],
    )];
    let bytes = write_pdf(&pages, plain_info("Inked"));
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("<00010002> Tj"));
    assert!(text.contains("<0003> Tj"));
    assert!(text.contains("<0003> <0034>"));
    assert!(contains(
        &bytes,
        "<< /Length 8 >>\nstream\n\0\0\0\x01\0\x01\0\x02\n"
    ));
}

#[test]
fn cids_stop_at_the_identity_limit() {
    let mut cids = CidMap::default();
    let mut assigned = 0;
    for c in (0x20u32..0x30000).filter_map(char::from_u32) {
        if cids.cid(c, false).is_some() {
            assigned += 1;
        }
    }
    assert_eq!(assigned, 65534);
    assert_eq!(cids.cid(' ', false), Some(1));
}

#[test]
fn the_glyphless_font_parses_and_its_checksums_hold() {
    use allsorts::binary::read::ReadScope;
    use allsorts::tables::cmap::{Cmap, CmapSubtable, EncodingId, PlatformId};
    use allsorts::tables::{
        FontTableProvider, HeadTable, HheaTable, MaxpTable, OpenTypeData, OpenTypeFont,
    };
    use allsorts::tag;

    let ttf = glyphless_ttf();
    assert_eq!(ttf, glyphless_ttf(), "deterministic bytes");
    assert_eq!(ttf.len() % 4, 0);
    let font = ReadScope::new(&ttf).read::<OpenTypeFont<'_>>().unwrap();
    let OpenTypeData::Single(directory) = &font.data else {
        panic!("expected a single font");
    };
    let tags: Vec<u32> = directory
        .table_records
        .iter()
        .map(|r| r.table_tag)
        .collect();
    let mut sorted = tags.clone();
    sorted.sort_unstable();
    assert_eq!(tags, sorted, "table records in tag order");
    assert_eq!(tags.len(), 10);
    for record in directory.table_records.iter() {
        let start = record.offset as usize;
        assert_eq!(start % 4, 0);
        let mut data = ttf[start..start + record.length as usize].to_vec();
        if record.table_tag == tag::HEAD {
            data[8..12].copy_from_slice(&[0; 4]);
        }
        assert_eq!(
            table_checksum(&data),
            record.checksum,
            "{:08x}",
            record.table_tag
        );
    }
    assert_eq!(table_checksum(&ttf), 0xB1B0_AFBA, "checkSumAdjustment");

    let provider = font.table_provider(0).unwrap();
    let head_data = provider.read_table_data(tag::HEAD).unwrap();
    let head = ReadScope::new(&head_data).read::<HeadTable>().unwrap();
    assert_eq!(head.units_per_em, 1000);
    let hhea_data = provider.read_table_data(tag::HHEA).unwrap();
    let hhea = ReadScope::new(&hhea_data).read::<HheaTable>().unwrap();
    assert_eq!((hhea.ascender, hhea.descender), (800, -200));
    assert_eq!(hhea.num_h_metrics, 3);
    let maxp_data = provider.read_table_data(tag::MAXP).unwrap();
    let maxp = ReadScope::new(&maxp_data).read::<MaxpTable>().unwrap();
    assert_eq!(maxp.num_glyphs, 3);
    let loca = provider.read_table_data(tag::LOCA).unwrap();
    assert_eq!(
        &*loca,
        &[0, 0, 0, 17, 0, 17, 0, 29],
        "square, empty, diagonal"
    );
    let cmap_data = provider.read_table_data(tag::CMAP).unwrap();
    let cmap = ReadScope::new(&cmap_data).read::<Cmap<'_>>().unwrap();
    let record = cmap
        .find_subtable(PlatformId::WINDOWS, EncodingId::WINDOWS_UNICODE_BMP_UCS2)
        .unwrap();
    let subtable = cmap
        .scope
        .offset(record.offset as usize)
        .read::<CmapSubtable<'_>>()
        .unwrap();
    assert_eq!(subtable.map_glyph(0x20).unwrap(), Some(1));
    assert_eq!(subtable.map_glyph(0x41).unwrap(), None);
    let os2 = provider.read_table_data(tag::OS_2).unwrap();
    assert_eq!(&os2[8..10], &[0, 0], "fsType 0: installable embedding");
    assert!(provider.has_table(tag::NAME) && provider.has_table(tag::POST));
}

#[test]
fn a_three_page_two_scene_pdf_parses_back() {
    let pages = vec![
        (
            meta(0, "Intro", 1000.0),
            vec![item("Hello Wörld 你好", 0.1, 0.1, 0.5, 0.05)],
        ),
        (meta(0, "Intro", 4500.0), Vec::new()),
        (meta(1, "Café (two)", 0.0), Vec::new()),
    ];
    let bytes = write_pdf(&pages, plain_info("Launch"));
    assert!(bytes.starts_with(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"));
    let pdf = ParsedPdf::parse(&bytes);

    let catalog = pdf.object(1);
    assert!(catalog.contains("/Type /Catalog /Pages 2 0 R"));
    assert!(catalog.contains("/PageMode /UseOutlines"));
    assert!(catalog.contains("/ViewerPreferences << /DisplayDocTitle true >>"));
    assert!(pdf.trailer.contains("/Root 1 0 R"));

    let tree = pdf.object(2);
    assert!(
        tree.contains("/Kids [5 0 R 9 0 R 12 0 R] /Count 3"),
        "{tree}"
    );
    for page in [5, 9, 12] {
        let dict = pdf.object(page);
        assert!(dict.contains("/Type /Page /Parent 2 0 R /MediaBox [0 0 960 540]"));
    }
    assert!(pdf.object(5).contains("/Font << /F0 6 0 R >>"));
    assert!(!pdf.object(9).contains("/Font"));
    assert!(pdf.object(3).contains("/Subtype /Image /Width 16 /Height 9 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode"));
    assert!(pdf
        .object(4)
        .contains("q 960 0 0 540 0 0 cm /Im0 Do Q\nBT 3 Tr /F0 27 Tf "));

    let root = reference(&catalog, "Outlines").unwrap();
    let outlines = pdf.object(root);
    assert!(outlines.contains("/Type /Outlines"));
    assert_eq!(reference(&outlines, "Count"), Some(2));
    let first = reference(&outlines, "First").unwrap();
    let last = reference(&outlines, "Last").unwrap();

    let intro = pdf.object(first);
    assert!(intro.contains("/Title (Intro)"));
    assert_eq!(reference(&intro, "Parent"), Some(root));
    assert_eq!(reference(&intro, "Next"), Some(last));
    assert_eq!(reference(&intro, "Prev"), None);
    assert!(intro.contains("/Count -2"));
    assert_eq!(dest(&intro), 5);

    let cafe = pdf.object(last);
    assert!(cafe.contains("/Title <FEFF"));
    assert_eq!(reference(&cafe, "Prev"), Some(first));
    assert_eq!(reference(&cafe, "Next"), None);
    assert_eq!(reference(&cafe, "First"), None);
    assert_eq!(dest(&cafe), 12);

    let one = pdf.object(reference(&intro, "First").unwrap());
    let two = pdf.object(reference(&intro, "Last").unwrap());
    assert!(one.contains("/Title (0:01.0)"));
    assert!(two.contains("/Title (0:04.5)"));
    assert_eq!(reference(&one, "Parent"), Some(first));
    assert_eq!(reference(&one, "Next"), reference(&intro, "Last"));
    assert_eq!(reference(&two, "Prev"), reference(&intro, "First"));
    assert_eq!((dest(&one), dest(&two)), (5, 9));

    let info = pdf.object(reference(&pdf.trailer, "Info").unwrap());
    assert!(info.contains("/Title (Launch) /Creator (Kookaburra Cut) /Producer (Kookaburra Cut)"));
}

#[test]
fn the_document_id_is_deterministic() {
    let pages = vec![(meta(0, "Intro", 0.0), vec![item("Hi", 0.1, 0.1, 0.2, 0.05)])];
    let a = write_pdf(&pages, plain_info("Launch"));
    let b = write_pdf(&pages, plain_info("Launch"));
    assert_eq!(a, b);
    let c = write_pdf(&pages, plain_info("Other"));
    let id = |bytes: &[u8]| {
        let pdf = ParsedPdf::parse(bytes);
        let at = pdf.trailer.find("/ID [<").unwrap();
        pdf.trailer[at + 6..at + 38].to_string()
    };
    assert_ne!(id(&a), id(&c));
    let pdf = ParsedPdf::parse(&a);
    assert!(pdf.trailer.contains(&format!("/ID [<{0}> <{0}>]", id(&a))));
}

#[test]
fn reproducible_pdfs_have_no_dates_author_or_version() {
    let pages = vec![(meta(0, "Intro", 0.0), Vec::new())];
    let bytes = write_pdf(&pages, plain_info("Launch"));
    for absent in ["/Author", "/CreationDate", "/ModDate", "9.9.9"] {
        assert!(!contains(&bytes, absent), "{absent}");
    }
    let now = Civil {
        year: 2026,
        month: 10,
        day: 8,
        hour: 9,
        minute: 0,
        second: 0,
        offset_minutes: 600,
    };
    let dated = write_pdf(&pages, doc_info("Launch", "9.9.9", Some(&now)));
    assert!(contains(
        &dated,
        "/Creator (Kookaburra Cut 9.9.9) /Producer (Kookaburra Cut) /CreationDate (D:20261008090000+10'00') /ModDate (D:20261008090000+10'00')"
    ));
}

#[test]
fn a_pdf_without_text_has_no_font_objects() {
    let pages = vec![
        (meta(0, "Intro", 0.0), Vec::new()),
        (meta(1, "", 0.0), vec![item("", 0.1, 0.1, 0.2, 0.05)]),
    ];
    let bytes = write_pdf(&pages, plain_info("Launch"));
    for absent in ["/Font", "FontFile2", "ToUnicode", "CIDToGIDMap", " Tj "] {
        assert!(!contains(&bytes, absent), "{absent}");
    }
    let pdf = ParsedPdf::parse(&bytes);
    let catalog = pdf.object(1);
    let outlines = pdf.object(reference(&catalog, "Outlines").unwrap());
    let second = pdf.object(reference(&outlines, "Last").unwrap());
    assert!(second.contains("/Title (Scene 2)"));
}

#[test]
fn a_pdf_with_text_embeds_the_font_once() {
    let pages = vec![
        (meta(0, "A", 0.0), vec![item("ab", 0.1, 0.1, 0.2, 0.05)]),
        (meta(1, "B", 0.0), vec![item("ba😀", 0.1, 0.1, 0.2, 0.05)]),
    ];
    let bytes = write_pdf(&pages, plain_info("Launch"));
    let pdf = ParsedPdf::parse(&bytes);
    let text = String::from_utf8_lossy(&bytes);
    assert_eq!(text.matches("/Subtype /Type0").count(), 1);
    assert_eq!(text.matches("/FontFile2").count(), 1);
    assert!(text.contains("<00010002> Tj"));
    assert!(text.contains("<000200010003> Tj"));
    assert!(text.contains("<0003> <D83DDE00>"));
    let type0 = pdf.object(6);
    assert!(type0.contains("/Encoding /Identity-H"));
    let at = type0.find("/DescendantFonts [").unwrap() + 18;
    let cid_font = pdf.object(type0[at..].split(' ').next().unwrap().parse().unwrap());
    assert!(cid_font.contains("/Subtype /CIDFontType2"));
    let to_unicode = pdf.object(reference(&type0, "ToUnicode").unwrap());
    assert!(to_unicode.contains("beginbfchar"));
    assert!(
        text.contains("/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>")
    );
    assert!(text.contains("/DW 500"));
    let ttf = glyphless_ttf();
    assert!(text.contains(&format!("/Length1 {0} /Length {0} >>", ttf.len())));
}

fn rgba_rows(width: u32, height: u32) -> Vec<u8> {
    let mut rgba = Vec::new();
    for y in 0..height {
        for x in 0..width {
            rgba.extend_from_slice(&[(y * 40) as u8, (x * 30) as u8, 200, 255]);
        }
    }
    rgba
}

#[test]
fn pngs_keep_the_top_down_row_order() {
    let rgba = rgba_rows(5, 4);
    let rgb = rgba_to_rgb(&rgba);
    assert_eq!(rgb.len(), 5 * 4 * 3);
    let png = encode_png(&rgb, 5, 4).unwrap();
    assert_eq!(png, encode_png(&rgb, 5, 4).unwrap(), "deterministic bytes");
    let decoder = png::Decoder::new(Cursor::new(png));
    let mut reader = decoder.read_info().unwrap();
    assert!(reader.info().srgb.is_some());
    let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
    let frame = reader.next_frame(&mut decoded).unwrap();
    assert_eq!(frame.color_type, png::ColorType::Rgb);
    assert_eq!(&decoded[..frame.buffer_size()], &rgb[..]);
    assert_eq!(decoded[0], 0, "row 0 stays the first row");
}

#[test]
fn zip_entries_are_numbered_and_slugged() {
    assert_eq!(scene_slug("Hello, World!", 0), "hello-world");
    assert_eq!(scene_slug("Café Menu", 0), "caf-menu");
    assert_eq!(scene_slug("Intro – Outro", 0), "intro-outro");
    assert_eq!(scene_slug("  --  ", 4), "scene-5");
    assert_eq!(scene_slug("你好", 1), "scene-2");
    let long = scene_slug(&"word ".repeat(12), 0);
    assert!(long.len() <= 40 && !long.ends_with('-'), "{long}");
    assert_eq!(number_width(9), 2);
    assert_eq!(number_width(100), 3);
    assert_eq!(number_width(2000), 4);
    assert_eq!(entry_file(3, 2, "intro", 1), "03-intro.png");
    assert_eq!(entry_file(3, 3, "intro", 2), "003-intro-2.png");
}

fn zip_meta(total: u32) -> ZipMeta {
    ZipMeta {
        base: "launch-16x9".into(),
        total,
        timestamp: zip_timestamp(None),
        project: "Launch".into(),
        aspect: "16x9".into(),
        width: 2,
        height: 1,
    }
}

fn write_zip(metas: &[PageMeta]) -> Vec<u8> {
    let mut writer = PngZipWriter::new(Cursor::new(Vec::new()), zip_meta(metas.len() as u32));
    for (i, meta) in metas.iter().enumerate() {
        let png = encode_png(&[i as u8; 6], 2, 1).unwrap();
        writer.write_page(&png, meta).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[test]
fn the_zip_lays_out_pages_and_their_index() {
    let metas = [
        meta(0, "Intro", 0.0),
        meta(0, "Intro", 1500.5),
        meta(1, "", 0.0),
        meta(2, "你好", 250.0),
    ];
    let bytes = write_zip(&metas);
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().to_owned())
        .collect();
    assert_eq!(
        names,
        [
            "launch-16x9/01-intro.png",
            "launch-16x9/02-intro-2.png",
            "launch-16x9/03-scene-2.png",
            "launch-16x9/04-scene-3.png",
            "launch-16x9/pages.json",
        ]
    );
    for index in 0..archive.len() {
        let entry = archive.by_index(index).unwrap();
        let expected = if entry.name().ends_with(".png") {
            zip::CompressionMethod::Stored
        } else {
            zip::CompressionMethod::Deflated
        };
        assert_eq!(entry.compression(), expected, "{}", entry.name());
        assert_eq!(entry.unix_mode().map(|m| m & 0o777), Some(0o644));
        assert_eq!(entry.last_modified(), Some(zip::DateTime::default()));
    }
    let mut json = String::new();
    archive
        .by_name("launch-16x9/pages.json")
        .unwrap()
        .read_to_string(&mut json)
        .unwrap();
    assert!(json.starts_with(
        "{\n  \"version\": 1,\n  \"project\": \"Launch\",\n  \"aspect\": \"16x9\",\n  \"width\": 2,\n  \"height\": 1,\n  \"pages\": ["
    ));
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let second = &parsed["pages"][1];
    assert_eq!(second["file"], "02-intro-2.png");
    assert_eq!(second["scene"], "Intro");
    assert_eq!(second["sceneIndex"], 0);
    assert_eq!(second["kind"], "auto");
    assert_eq!(second["sceneMs"], 1500.5);
    assert!(json.contains("\"sceneMs\": 0,"));
    assert_eq!(parsed["pages"][2]["scene"], "Scene 2");
    assert_eq!(parsed["pages"][3]["scene"], "你好");
    assert_eq!(parsed["pages"][3]["globalMs"], 20250);
}

#[test]
fn a_reproducible_zip_is_byte_identical_across_writes() {
    let metas = [meta(0, "Intro", 0.0), meta(1, "Outro", 0.0)];
    assert_eq!(write_zip(&metas), write_zip(&metas));
}

#[test]
fn a_dated_zip_stamps_its_entries_with_local_time() {
    let now = Civil {
        year: 2026,
        month: 10,
        day: 8,
        hour: 9,
        minute: 30,
        second: 15,
        offset_minutes: 600,
    };
    let stamp = zip_timestamp(Some(now));
    assert_eq!((stamp.year(), stamp.month(), stamp.day()), (2026, 10, 8));
    assert_eq!((stamp.hour(), stamp.minute()), (9, 30));
}

fn png_job(dir: &Path, total: u32) -> (StillsJob, PathBuf, PathBuf) {
    let output = dir.join("launch-16x9.zip");
    let temp = crate::partial_output_path(&output);
    let file = std::fs::File::create(&temp).unwrap();
    let sink = Sink::PngZip(Box::new(PngZipWriter::new(
        std::io::BufWriter::new(file),
        zip_meta(total),
    )));
    let job = StillsJob::new(
        StillsKind::PngZip,
        output.clone(),
        temp.clone(),
        (2, 1),
        total,
        tauri::ipc::Channel::new(|_| Ok(())),
        sink,
    );
    (job, output, temp)
}

fn push_png(slot: &StillsSlot, index: u32, meta: &PageMeta) -> Result<Progress, String> {
    let ticket = slot.ticket(index, 2, 1)?;
    let Prepared::Rgb(rgb) = prepare_body(ticket.kind, &[index as u8; 8], 2, 1, 0)? else {
        panic!("expected RGB");
    };
    let png = encode_png(&rgb, 2, 1)?;
    slot.write_page(ticket.serial, index, meta, PagePayload::Png(png))
        .map(|(progress, _)| progress)
}

#[test]
fn dropping_a_job_deletes_its_temp_file() {
    let dir = scratch("drop");
    let (job, _, temp) = png_job(&dir, 1);
    assert!(temp.exists());
    assert!(temp
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(".launch-16x9.part.zip"));
    drop(job);
    assert!(!temp.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_full_png_export_publishes_and_reports_hashes() {
    let dir = scratch("publish");
    let slot = StillsSlot::default();
    let (job, output, temp) = png_job(&dir, 2);
    slot.install(job).unwrap();
    let first = push_png(&slot, 0, &meta(0, "Intro", 0.0)).unwrap();
    assert_eq!((first.frame, first.total, first.stage), (1, 2, "still"));
    assert!(push_png(&slot, 1, &meta(1, "Outro", 0.0)).is_ok());
    let plan = slot.begin_finish().unwrap();
    let serial = plan.serial;
    assert!(slot.busy(), "busy until published");
    assert!(slot.ticket(2, 2, 1).is_err());
    let result = finalise(plan);
    slot.end_finish(serial, result.is_ok());
    let result = serde_json::to_value(result.unwrap()).unwrap();
    assert!(!slot.busy());
    assert!(output.is_file());
    assert!(!temp.exists());
    assert_eq!(result["kind"], "png-zip");
    assert_eq!(result["pages"], 2);
    assert_eq!(
        result["sha256"],
        crate::sha256_file(&output).unwrap().as_str()
    );
    assert_eq!(result["bytes"], std::fs::metadata(&output).unwrap().len());
    assert_eq!(result["pageSha256"].as_array().unwrap().len(), 2);
    assert_eq!(result["path"], output.to_string_lossy().as_ref());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn push_errors_clear_the_job() {
    let dir = scratch("push-errors");
    let slot = StillsSlot::default();
    let (job, _, temp) = png_job(&dir, 2);
    slot.install(job).unwrap();
    assert!(slot.install(png_job(&dir, 1).0).is_err());
    assert!(push_png(&slot, 1, &meta(0, "Intro", 0.0))
        .err()
        .unwrap()
        .contains("out of order"));
    assert!(!slot.busy());
    assert!(!temp.exists());

    let (job, _, temp) = png_job(&dir, 2);
    slot.install(job).unwrap();
    assert!(slot.ticket(0, 3, 1).is_err());
    assert!(!slot.busy() && !temp.exists());

    let (job, _, temp) = png_job(&dir, 2);
    slot.install(job).unwrap();
    push_png(&slot, 0, &meta(0, "Intro", 0.0)).unwrap();
    assert!(slot
        .begin_finish()
        .err()
        .unwrap()
        .contains("1 of its 2 pages"));
    assert!(!slot.busy() && !temp.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_page_from_a_cancelled_job_never_lands_in_the_next_one() {
    let dir = scratch("serial");
    let slot = StillsSlot::default();
    slot.install(png_job(&dir, 1).0).unwrap();
    let stale = slot.ticket(0, 2, 1).unwrap();
    slot.cancel();
    slot.install(png_job(&dir, 1).0).unwrap();
    let png = encode_png(&[0; 6], 2, 1).unwrap();
    assert!(slot
        .write_page(stale.serial, 0, &meta(0, "", 0.0), PagePayload::Png(png))
        .is_err());
    assert!(slot.busy(), "the new job survives a stale page");
    slot.cancel();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cancel_while_finishing_lets_the_finaliser_unwind() {
    let dir = scratch("cancel-finishing");
    let slot = StillsSlot::default();
    let (job, output, temp) = png_job(&dir, 1);
    slot.install(job).unwrap();
    push_png(&slot, 0, &meta(0, "Intro", 0.0)).unwrap();
    let plan = slot.begin_finish().unwrap();
    let serial = plan.serial;
    slot.cancel();
    assert!(slot.busy(), "the finaliser still owns the job");
    let result = finalise(plan);
    assert_eq!(result.unwrap_err(), crate::EXPORT_CANCELLED);
    slot.end_finish(serial, false);
    assert!(!slot.busy());
    assert!(!temp.exists() && !output.exists());
    slot.cancel();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn video_and_stills_never_cancel_each_other() {
    let dir = scratch("isolation");
    let state = ExportState::default();
    assert!(!state.busy());
    let (job, _, temp) = png_job(&dir, 1);
    state.stills.install(job).unwrap();
    assert!(
        state.busy(),
        "a stills job alone makes the export state busy"
    );

    state.cancel().unwrap();
    assert!(state.stills.busy(), "a video cancel leaves stills alone");
    assert!(temp.exists());

    *state.run.lock().unwrap() = Some(crate::ExportRun {
        cancelled: false,
        pid: None,
        output: dir.join("out.mp4"),
        partial: dir.join(".out.part.mp4"),
        mezz_dir: None,
    });
    state.stills.cancel();
    assert!(!state.stills.busy());
    assert!(!temp.exists());
    let run = state.run.lock().unwrap();
    assert!(
        run.as_ref().is_some_and(|run| !run.cancelled),
        "a stills cancel leaves video alone"
    );
    drop(run);
    assert!(
        state.busy(),
        "a video run alone makes the export state busy"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// A real JPEG via macOS `sips`, or `None` where it is missing.
fn sips_jpeg(dir: &Path, width: u32, height: u32) -> Option<Vec<u8>> {
    let png_path = dir.join("page.png");
    let jpeg_path = dir.join("page.jpg");
    let rgb = rgba_to_rgb(&rgba_rows(width, height));
    std::fs::write(&png_path, encode_png(&rgb, width, height).ok()?).ok()?;
    let status = std::process::Command::new("sips")
        .args(["-s", "format", "jpeg"])
        .arg(&png_path)
        .arg("--out")
        .arg(&jpeg_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()?;
    status.success().then(|| std::fs::read(&jpeg_path).ok())?
}

fn tool_output(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Optional cross-checks with poppler and PDFKit; each is skipped where its tool is absent.
#[test]
fn external_readers_find_the_text_layer() {
    let dir = scratch("external");
    let Some(jpeg) = sips_jpeg(&dir, 64, 36) else {
        eprintln!("skipping: sips unavailable");
        return;
    };
    let info = parse_jpeg(&jpeg).unwrap();
    let mut writer = PdfWriter::new(
        Vec::new(),
        page_size_pt(3840, 2160),
        doc_info("Stills Test", "9.9.9", None),
    )
    .unwrap();
    writer
        .write_page(
            &jpeg,
            info,
            &[item("Hello Wörld 你好", 0.1, 0.1, 0.6, 0.08)],
            &meta(0, "Intro", 0.0),
            &[1; 32],
        )
        .unwrap();
    writer
        .write_page(
            &jpeg,
            info,
            &[
                item("Second 😀 page", 0.1, 0.5, 0.23, 0.05),
                item("•", 0.8, 0.8, 0.02, 0.05),
            ],
            &meta(1, "Outro", 0.0),
            &[2; 32],
        )
        .unwrap();
    let pdf_path = dir.join("stills.pdf");
    std::fs::write(&pdf_path, writer.finish().unwrap()).unwrap();
    let path = pdf_path.to_string_lossy().into_owned();

    if let Some(text) = tool_output("pdftotext", &["-enc", "UTF-8", &path, "-"]) {
        assert!(text.contains("Hello Wörld 你好"), "pdftotext: {text:?}");
        assert!(text.contains("Second 😀 page"), "pdftotext: {text:?}");
    } else {
        eprintln!("skipping pdftotext: unavailable");
    }
    if let Some(info) = tool_output("pdfinfo", &[&path]) {
        assert!(info.contains("Stills Test"), "pdfinfo: {info}");
        assert!(info.contains("Pages:           2"), "pdfinfo: {info}");
        assert!(
            info.contains("Page size:       960 x 540 pts"),
            "pdfinfo: {info}"
        );
    } else {
        eprintln!("skipping pdfinfo: unavailable");
    }
    let script = format!(
        "ObjC.import('PDFKit'); var d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath('{path}')); d.string.js"
    );
    if let Some(text) = tool_output("osascript", &["-l", "JavaScript", "-e", &script]) {
        assert!(text.contains("Hello Wörld 你好"), "PDFKit: {text:?}");
    } else {
        eprintln!("skipping PDFKit: osascript unavailable");
    }
    // A lone glyph must not stretch the selection of the line before it (17 x 27 pt per glyph here).
    let script = format!(
        "ObjC.import('PDFKit'); var d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath('{path}')); var r = d.findStringWithOptions('page', 0).objectAtIndex(0).boundsForPage(d.pageAtIndex(1)); [r.size.width, r.size.height].join(' ')"
    );
    if let Some(size) = tool_output("osascript", &["-l", "JavaScript", "-e", &script]) {
        let size: Vec<f64> = size
            .split_whitespace()
            .map(|v| v.parse().unwrap())
            .collect();
        assert!(
            size[0] < 75.0 && size[1] < 30.0,
            "PDFKit 'page' bounds: {size:?}"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}
