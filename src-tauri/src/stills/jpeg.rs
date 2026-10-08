//! Just enough JPEG parsing to embed a page as `/DCTDecode`: SOI and EOI present, and the frame header's size and colour components, so a mis-sized or truncated still is refused before it reaches the PDF.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JpegInfo {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) components: u8,
}

fn is_frame_marker(marker: u8) -> bool {
    (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC)
}

pub(crate) fn parse_jpeg(bytes: &[u8]) -> Result<JpegInfo, String> {
    if bytes.len() < 4 || bytes[..2] != [0xFF, 0xD8] {
        return Err("the still is not a JPEG (no start-of-image marker)".into());
    }
    if bytes[bytes.len() - 2..] != [0xFF, 0xD9] {
        return Err("the JPEG is truncated (no end-of-image marker)".into());
    }
    let truncated = || "the JPEG is truncated".to_string();
    let mut pos = 2;
    loop {
        if bytes.get(pos) != Some(&0xFF) {
            return Err("the JPEG has a malformed segment".into());
        }
        while bytes.get(pos) == Some(&0xFF) {
            pos += 1;
        }
        let marker = *bytes.get(pos).ok_or_else(truncated)?;
        pos += 1;
        match marker {
            0x01 | 0xD0..=0xD7 => continue,
            0xD8..=0xDA => return Err("the JPEG has no frame header before its image data".into()),
            _ => {}
        }
        let length = bytes
            .get(pos..pos + 2)
            .map(|b| usize::from(u16::from_be_bytes([b[0], b[1]])))
            .ok_or_else(truncated)?;
        if length < 2 || pos + length > bytes.len() {
            return Err(truncated());
        }
        if is_frame_marker(marker) {
            if !matches!(marker, 0xC0..=0xC2) {
                return Err(format!(
                    "unsupported JPEG frame type (SOF{})",
                    marker - 0xC0
                ));
            }
            if length < 8 {
                return Err(truncated());
            }
            let segment = &bytes[pos + 2..pos + length];
            if segment[0] != 8 {
                return Err(format!("unsupported JPEG precision ({} bits)", segment[0]));
            }
            let height = u32::from(u16::from_be_bytes([segment[1], segment[2]]));
            let width = u32::from(u16::from_be_bytes([segment[3], segment[4]]));
            let components = segment[5];
            if width == 0 || height == 0 {
                return Err("the JPEG frame has no size".into());
            }
            if components != 1 && components != 3 {
                return Err(format!("unsupported JPEG colour ({components} components)"));
            }
            return Ok(JpegInfo {
                width,
                height,
                components,
            });
        }
        pos += length;
    }
}
