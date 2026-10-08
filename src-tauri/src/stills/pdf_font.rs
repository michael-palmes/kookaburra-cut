//! The invisible text layer's font: a two-glyph TrueType built in code (glyph 1 is empty, so nothing ever paints) plus the per-document CID allocation and its ToUnicode map, which is what makes the handout searchable and copyable.

use std::collections::HashMap;
use std::fmt::Write as _;

pub(crate) const FONT_NAME: &str = "KookaburraGlyphless";
pub(crate) const UNITS_PER_EM: u16 = 1000;
pub(crate) const ADVANCE: u16 = 500;
pub(crate) const ASCENT: i16 = 800;
pub(crate) const DESCENT: i16 = -200;
/// CID 0 is notdef and 0xFFFF is reserved.
pub(crate) const MAX_CID: usize = 65534;
const BFCHAR_BLOCK: usize = 100;
/// Glyph 0's tiny box, in font units.
const BOX: i16 = 100;

/// Sequential CIDs in first-appearance order across the whole document.
#[derive(Default)]
pub(crate) struct CidMap {
    by_char: HashMap<char, u16>,
    chars: Vec<char>,
    overflowed: bool,
}

impl CidMap {
    pub(crate) fn cid(&mut self, c: char) -> Option<u16> {
        if let Some(&cid) = self.by_char.get(&c) {
            return Some(cid);
        }
        if self.chars.len() >= MAX_CID {
            if !self.overflowed {
                self.overflowed = true;
                eprintln!(
                    "[stills] text layer ran out of CIDs; further new characters are left out"
                );
            }
            return None;
        }
        self.chars.push(c);
        let cid = self.chars.len() as u16;
        self.by_char.insert(c, cid);
        Some(cid)
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.chars.len()
    }

    /// Two bytes per CID from 0: notdef stays on glyph 0, every used CID lands on the empty glyph 1.
    pub(crate) fn cid_to_gid_map(&self) -> Vec<u8> {
        let mut map = Vec::with_capacity((self.chars.len() + 1) * 2);
        map.extend_from_slice(&[0, 0]);
        for _ in &self.chars {
            map.extend_from_slice(&[0, 1]);
        }
        map
    }

    pub(crate) fn to_unicode_cmap(&self) -> String {
        let mut cmap = String::from(
            "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
        );
        for (block, chunk) in self.chars.chunks(BFCHAR_BLOCK).enumerate() {
            let _ = writeln!(cmap, "{} beginbfchar", chunk.len());
            for (i, c) in chunk.iter().enumerate() {
                let cid = block * BFCHAR_BLOCK + i + 1;
                let mut units = [0u16; 2];
                let _ = write!(cmap, "<{cid:04X}> <");
                for unit in c.encode_utf16(&mut units) {
                    let _ = write!(cmap, "{unit:04X}");
                }
                cmap.push_str(">\n");
            }
            cmap.push_str("endbfchar\n");
        }
        cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
        cmap
    }
}

fn u16be(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn i16be(out: &mut Vec<u8>, v: i16) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn u32be(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// The sfnt checksum: the big-endian u32 sum of the zero-padded table.
pub(crate) fn table_checksum(data: &[u8]) -> u32 {
    data.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

fn head() -> Vec<u8> {
    let mut t = Vec::with_capacity(54);
    u32be(&mut t, 0x0001_0000);
    u32be(&mut t, 0x0001_0000);
    u32be(&mut t, 0); // checkSumAdjustment, patched once the font is whole
    u32be(&mut t, 0x5F0F_3CF5);
    u16be(&mut t, 0x000B);
    u16be(&mut t, UNITS_PER_EM);
    t.extend_from_slice(&[0; 16]); // created + modified: zero for reproducible bytes
    for v in [0, 0, BOX, BOX] {
        i16be(&mut t, v);
    }
    u16be(&mut t, 0);
    u16be(&mut t, 8);
    i16be(&mut t, 2);
    i16be(&mut t, 0);
    i16be(&mut t, 0);
    t
}

fn hhea() -> Vec<u8> {
    let mut t = Vec::with_capacity(36);
    u32be(&mut t, 0x0001_0000);
    i16be(&mut t, ASCENT);
    i16be(&mut t, DESCENT);
    i16be(&mut t, 0);
    u16be(&mut t, ADVANCE);
    i16be(&mut t, 0);
    i16be(&mut t, ADVANCE as i16 - BOX);
    i16be(&mut t, BOX);
    i16be(&mut t, 1);
    t.extend_from_slice(&[0; 12]);
    i16be(&mut t, 0);
    u16be(&mut t, 2);
    t
}

fn maxp() -> Vec<u8> {
    let mut t = Vec::with_capacity(32);
    u32be(&mut t, 0x0001_0000);
    for v in [2, 4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0] {
        u16be(&mut t, v);
    }
    t
}

fn hmtx() -> Vec<u8> {
    let mut t = Vec::with_capacity(8);
    for _ in 0..2 {
        u16be(&mut t, ADVANCE);
        i16be(&mut t, 0);
    }
    t
}

/// Glyph 0 is a one-contour square; glyph 1 has no outline at all.
fn glyf() -> Vec<u8> {
    let mut t = Vec::with_capacity(34);
    i16be(&mut t, 1);
    for v in [0, 0, BOX, BOX] {
        i16be(&mut t, v);
    }
    u16be(&mut t, 3);
    u16be(&mut t, 0);
    t.extend_from_slice(&[0x01; 4]);
    for dx in [0, 0, BOX, 0] {
        i16be(&mut t, dx);
    }
    for dy in [0, BOX, 0, -BOX] {
        i16be(&mut t, dy);
    }
    t
}

fn loca(glyf_len: usize) -> Vec<u8> {
    let half = (glyf_len / 2) as u16;
    let mut t = Vec::with_capacity(6);
    for v in [0, half, half] {
        u16be(&mut t, v);
    }
    t
}

/// A Windows BMP subtable mapping only U+0020 to the empty glyph.
fn cmap() -> Vec<u8> {
    let mut t = Vec::with_capacity(44);
    u16be(&mut t, 0);
    u16be(&mut t, 1);
    u16be(&mut t, 3);
    u16be(&mut t, 1);
    u32be(&mut t, 12);
    for v in [4, 32, 0, 4, 4, 1, 0] {
        u16be(&mut t, v);
    }
    for v in [0x0020, 0xFFFF, 0, 0x0020, 0xFFFF] {
        u16be(&mut t, v);
    }
    i16be(&mut t, 1 - 0x20);
    i16be(&mut t, 1);
    u16be(&mut t, 0);
    u16be(&mut t, 0);
    t
}

fn name() -> Vec<u8> {
    let records: [(u16, &str); 5] = [
        (1, "Kookaburra Glyphless"),
        (2, "Regular"),
        (3, FONT_NAME),
        (4, "Kookaburra Glyphless"),
        (6, FONT_NAME),
    ];
    let mut strings: Vec<u8> = Vec::new();
    let mut t = Vec::new();
    u16be(&mut t, 0);
    u16be(&mut t, records.len() as u16);
    u16be(&mut t, (6 + 12 * records.len()) as u16);
    for (name_id, text) in records {
        let offset = strings.len();
        for unit in text.encode_utf16() {
            u16be(&mut strings, unit);
        }
        for v in [3, 1, 0x0409, name_id] {
            u16be(&mut t, v);
        }
        u16be(&mut t, (strings.len() - offset) as u16);
        u16be(&mut t, offset as u16);
    }
    t.extend_from_slice(&strings);
    t
}

fn os2() -> Vec<u8> {
    let mut t = Vec::with_capacity(96);
    u16be(&mut t, 4);
    i16be(&mut t, ADVANCE as i16);
    u16be(&mut t, 400);
    u16be(&mut t, 5);
    u16be(&mut t, 0); // fsType: installable, no embedding restrictions
    for v in [650, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0] {
        i16be(&mut t, v);
    }
    t.extend_from_slice(&[0; 10]);
    t.extend_from_slice(&[0; 16]);
    t.extend_from_slice(b"NONE");
    u16be(&mut t, 0x0040);
    u16be(&mut t, 0x0020);
    u16be(&mut t, 0x0020);
    i16be(&mut t, ASCENT);
    i16be(&mut t, DESCENT);
    i16be(&mut t, 0);
    u16be(&mut t, ASCENT as u16);
    u16be(&mut t, DESCENT.unsigned_abs());
    u32be(&mut t, 1);
    u32be(&mut t, 0);
    i16be(&mut t, 500);
    i16be(&mut t, 700);
    u16be(&mut t, 0);
    u16be(&mut t, 0x0020);
    u16be(&mut t, 1);
    t
}

fn post() -> Vec<u8> {
    let mut t = Vec::with_capacity(32);
    u32be(&mut t, 0x0003_0000);
    u32be(&mut t, 0);
    i16be(&mut t, -100);
    i16be(&mut t, 50);
    u32be(&mut t, 1);
    t.extend_from_slice(&[0; 16]);
    t
}

/// The embedded TrueType: tables in tag order, valid checksums and checkSumAdjustment, no timestamps.
pub(crate) fn glyphless_ttf() -> Vec<u8> {
    let glyf = glyf();
    let tables: [(&[u8; 4], Vec<u8>); 10] = [
        (b"OS/2", os2()),
        (b"cmap", cmap()),
        (b"head", head()),
        (b"hhea", hhea()),
        (b"hmtx", hmtx()),
        (b"loca", loca(glyf.len())),
        (b"maxp", maxp()),
        (b"name", name()),
        (b"post", post()),
        (b"glyf", glyf),
    ];
    let mut sorted: Vec<&(&[u8; 4], Vec<u8>)> = tables.iter().collect();
    sorted.sort_by_key(|(tag, _)| **tag);

    let count = sorted.len();
    let selector = usize::BITS - 1 - count.leading_zeros();
    let search_range = (1usize << selector) * 16;
    let mut font = Vec::new();
    u32be(&mut font, 0x0001_0000);
    u16be(&mut font, count as u16);
    u16be(&mut font, search_range as u16);
    u16be(&mut font, selector as u16);
    u16be(&mut font, (count * 16 - search_range) as u16);

    let mut offset = 12 + 16 * count;
    let mut head_offset = 0;
    for (tag, data) in &sorted {
        font.extend_from_slice(*tag);
        u32be(&mut font, table_checksum(data));
        u32be(&mut font, offset as u32);
        u32be(&mut font, data.len() as u32);
        if *tag == b"head" {
            head_offset = offset;
        }
        offset += data.len().next_multiple_of(4);
    }
    for (_, data) in &sorted {
        font.extend_from_slice(data);
        font.resize(font.len().next_multiple_of(4), 0);
    }
    let adjustment = 0xB1B0_AFBAu32.wrapping_sub(table_checksum(&font));
    font[head_offset + 8..head_offset + 12].copy_from_slice(&adjustment.to_be_bytes());
    font
}
