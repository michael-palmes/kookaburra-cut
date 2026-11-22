//! Byte-exact PNG decoding for the stage worker: WebKit's `createImageBitmap` premultiplies and unmultiplies a PNG with alpha on the way in, so every semi-transparent texel lands off the file, while the window's `<img>` upload was the file's bytes. The worker sends a PNG's bytes here and gets straight RGBA8 back, no gamma or colour profile applied (what `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` gave the window), 16-bit samples kept to their high byte.

/// RGBA8 out: 8 MP-class inputs stay well under this; a hostile scene cannot ask for more.
const MAX_INPUT_BYTES: usize = 256 * 1024 * 1024;
pub(crate) const MAX_OUTPUT_BYTES: usize = 1024 * 1024 * 1024;

/// Straight RGBA8 rows, top row first, plus the image size.
pub(crate) fn decode_png_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    decode_png_rows(bytes, 0, false)
}

/// The reply both decode commands send: width and height as little-endian u32, then the RGBA8 rows, top row first or (`bottom_up`) last row first.
pub(crate) fn decode_png_reply(bytes: &[u8], bottom_up: bool) -> Result<Vec<u8>, String> {
    let (mut out, width, height) = decode_png_rows(bytes, 8, bottom_up)?;
    out[..4].copy_from_slice(&width.to_le_bytes());
    out[4..8].copy_from_slice(&height.to_le_bytes());
    Ok(out)
}

/// A clip frame's reply, last row first, or `None` unless the PNG is 8-bit opaque RGB: only those decode here to the webview's own bytes (it rounds 16-bit samples and alpha its own way), so the caller keeps the webview's decode for the rest.
pub(crate) fn decode_clip_frame_reply(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .map_err(|e| format!("not a valid PNG: {e}"))?;
    let info = reader.info();
    let plain = info.bit_depth == png::BitDepth::Eight
        && info.color_type == png::ColorType::Rgb
        && info.trns.is_none();
    if !plain {
        return Ok(None);
    }
    decode_png_reply(bytes, true).map(Some)
}

/// Straight RGBA8 rows after `header` zeroed bytes, plus the image size.
fn decode_png_rows(
    bytes: &[u8],
    header: usize,
    bottom_up: bool,
) -> Result<(Vec<u8>, u32, u32), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("not a valid PNG: {e}"))?;
    // The ceiling is on the RGBA8 output: a one-bit image grows thirty-two-fold on the way there.
    let (width, height) = (reader.info().width, reader.info().height);
    let fits = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|value| value.checked_mul(4))
        .is_some_and(|value| value <= MAX_OUTPUT_BYTES as u64);
    if !fits {
        return Err("PNG is too large to decode".into());
    }
    let output_size = reader
        .output_buffer_size()
        .filter(|size| *size <= MAX_OUTPUT_BYTES)
        .ok_or_else(|| "PNG is too large to decode".to_string())?;
    let mut decoded = vec![0; output_size];
    let info = reader
        .next_frame(&mut decoded)
        .map_err(|e| format!("PNG could not be decoded: {e}"))?;
    if info.bit_depth != png::BitDepth::Eight {
        return Err("PNG has an unsupported bit depth".into());
    }
    let source = &decoded[..info.buffer_size()];
    let pixels = u64::from(info.width)
        .checked_mul(u64::from(info.height))
        .and_then(|value| value.checked_mul(4))
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "PNG dimensions are too large".to_string())?;
    let channels = match info.color_type {
        png::ColorType::Rgba => 4,
        png::ColorType::Rgb => 3,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Grayscale => 1,
        png::ColorType::Indexed => return Err("PNG palette was not expanded".into()),
    };
    let row = info.width as usize * channels;
    if row == 0 || source.len() != row * info.height as usize {
        return Err("PNG pixel data is incomplete".into());
    }
    // Plain indexed loops: a debug build runs them ten times faster than iterator chains, and dev builds decode every clip frame here.
    let mut rgba = vec![255u8; header + pixels];
    rgba[..header].fill(0);
    let out_row = info.width as usize * 4;
    let last = info.height as usize - 1;
    for (y, line) in source.chunks_exact(row).enumerate() {
        let at = header + if bottom_up { last - y } else { y } * out_row;
        let out = &mut rgba[at..at + out_row];
        let (mut i, mut o) = (0, 0);
        match channels {
            4 => out.copy_from_slice(line),
            3 => {
                while i < row {
                    out[o] = line[i];
                    out[o + 1] = line[i + 1];
                    out[o + 2] = line[i + 2];
                    i += 3;
                    o += 4;
                }
            }
            2 => {
                while i < row {
                    out[o] = line[i];
                    out[o + 1] = line[i];
                    out[o + 2] = line[i];
                    out[o + 3] = line[i + 1];
                    i += 2;
                    o += 4;
                }
            }
            _ => {
                while i < row {
                    out[o] = line[i];
                    out[o + 1] = line[i];
                    out[o + 2] = line[i];
                    i += 1;
                    o += 4;
                }
            }
        }
    }
    Ok((rgba, info.width, info.height))
}

/// Raw body: the PNG. Raw response: width and height as little-endian u32, then the RGBA8 rows.
#[tauri::command]
pub fn decode_png(request: tauri::ipc::Request) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("decode_png expects a raw binary body".into());
    };
    if bytes.len() > MAX_INPUT_BYTES {
        return Err("PNG is too large to decode".into());
    }
    Ok(tauri::ipc::Response::new(decode_png_reply(bytes, false)?))
}

#[cfg(test)]
mod tests {
    use super::{decode_clip_frame_reply, decode_png_reply, decode_png_rgba};

    fn encode(width: u32, height: u32, color: png::ColorType, depth: png::BitDepth, data: &[u8], setup: impl FnOnce(&mut png::Encoder<&mut Vec<u8>>)) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(color);
            encoder.set_depth(depth);
            setup(&mut encoder);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(data).unwrap();
        }
        out
    }

    #[test]
    fn semi_transparent_rgba_bytes_come_back_as_written() {
        let pixels = [0, 1, 0, 131, 10, 10, 11, 220, 33, 33, 35, 188, 255, 128, 0, 0];
        let png = encode(2, 2, png::ColorType::Rgba, png::BitDepth::Eight, &pixels, |_| {});
        let (rgba, w, h) = decode_png_rgba(&png).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(rgba, pixels);
    }

    #[test]
    fn a_palette_with_transparency_expands_and_keeps_colour_under_zero_alpha() {
        let png = encode(2, 1, png::ColorType::Indexed, png::BitDepth::Eight, &[0, 1], |e| {
            e.set_palette(vec![200, 100, 50, 7, 8, 9]);
            e.set_trns(vec![0, 90]);
        });
        let (rgba, w, h) = decode_png_rgba(&png).unwrap();
        assert_eq!((w, h), (2, 1));
        assert_eq!(rgba, [200, 100, 50, 0, 7, 8, 9, 90]);
    }

    #[test]
    fn grey_rgb_and_sixteen_bit_normalise_to_rgba8() {
        let grey = encode(1, 1, png::ColorType::Grayscale, png::BitDepth::Eight, &[77], |_| {});
        assert_eq!(decode_png_rgba(&grey).unwrap().0, [77, 77, 77, 255]);
        let rgb = encode(1, 1, png::ColorType::Rgb, png::BitDepth::Eight, &[1, 2, 3], |_| {});
        assert_eq!(decode_png_rgba(&rgb).unwrap().0, [1, 2, 3, 255]);
        let deep = encode(1, 1, png::ColorType::Rgba, png::BitDepth::Sixteen, &[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0], |_| {});
        assert_eq!(decode_png_rgba(&deep).unwrap().0, [0x12, 0x56, 0x9a, 0xde]);
    }

    #[test]
    fn gamma_and_colour_chunks_do_not_touch_the_bytes() {
        let png = encode(1, 1, png::ColorType::Rgba, png::BitDepth::Eight, &[40, 80, 120, 160], |e| {
            e.set_source_gamma(png::ScaledFloat::new(0.45455));
            e.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        });
        assert_eq!(decode_png_rgba(&png).unwrap().0, [40, 80, 120, 160]);
    }

    #[test]
    fn a_reply_carries_the_size_then_the_rows_in_the_order_asked() {
        let rgb = encode(1, 2, png::ColorType::Rgb, png::BitDepth::Eight, &[1, 2, 3, 4, 5, 6], |_| {});
        let head = [1, 0, 0, 0, 2, 0, 0, 0];
        assert_eq!(decode_png_reply(&rgb, false).unwrap(), [&head[..], &[1, 2, 3, 255, 4, 5, 6, 255]].concat());
        assert_eq!(decode_png_reply(&rgb, true).unwrap(), [&head[..], &[4, 5, 6, 255, 1, 2, 3, 255]].concat());
    }

    #[test]
    fn only_an_eight_bit_opaque_rgb_frame_decodes_as_a_clip_frame() {
        let rgb = encode(1, 2, png::ColorType::Rgb, png::BitDepth::Eight, &[1, 2, 3, 4, 5, 6], |_| {});
        assert_eq!(decode_clip_frame_reply(&rgb).unwrap(), Some(decode_png_reply(&rgb, true).unwrap()));
        let alpha = encode(1, 1, png::ColorType::Rgba, png::BitDepth::Eight, &[1, 2, 3, 4], |_| {});
        assert_eq!(decode_clip_frame_reply(&alpha).unwrap(), None);
        let deep = encode(1, 1, png::ColorType::Rgb, png::BitDepth::Sixteen, &[1, 2, 3, 4, 5, 6], |_| {});
        assert_eq!(decode_clip_frame_reply(&deep).unwrap(), None);
        let keyed = encode(1, 1, png::ColorType::Rgb, png::BitDepth::Eight, &[1, 2, 3], |e| {
            e.set_trns(vec![0, 1, 0, 2, 0, 3]);
        });
        assert_eq!(decode_clip_frame_reply(&keyed).unwrap(), None);
        assert!(decode_clip_frame_reply(b"not a png").is_err());
    }

    #[test]
    fn a_non_png_is_refused() {
        assert!(decode_png_rgba(b"\xff\xd8\xff\xe0 not a png").is_err());
    }

    /// A 31 KB one-bit image can claim a gigabyte of RGBA; it is refused on its header, before anything is allocated.
    #[test]
    fn an_image_past_the_rgba_ceiling_is_refused_on_its_header() {
        fn crc(bytes: &[u8]) -> u32 {
            let step = |c: u32| (c >> 1) ^ (0xEDB8_8320 & 0u32.wrapping_sub(c & 1));
            !bytes.iter().fold(u32::MAX, |crc, &byte| {
                (0..8).fold(crc ^ u32::from(byte), |c, _| step(c))
            })
        }
        fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
            let mut out = (data.len() as u32).to_be_bytes().to_vec();
            out.extend_from_slice(kind);
            out.extend_from_slice(data);
            out.extend_from_slice(&crc(&[kind.as_slice(), data].concat()).to_be_bytes());
            out
        }
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&20_000u32.to_be_bytes());
        ihdr.extend_from_slice(&20_000u32.to_be_bytes());
        ihdr.extend_from_slice(&[1, 0, 0, 0, 0]);
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(chunk(b"IHDR", &ihdr));
        png.extend(chunk(b"IDAT", &[0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
        png.extend(chunk(b"IEND", &[]));
        assert_eq!(decode_png_rgba(&png).unwrap_err(), "PNG is too large to decode");
    }
}
