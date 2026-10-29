//! Byte-exact PNG decoding for the stage worker: WebKit's `createImageBitmap` premultiplies and unmultiplies a PNG with alpha on the way in, so every semi-transparent texel lands off the file, while the window's `<img>` upload was the file's bytes. The worker sends a PNG's bytes here and gets straight RGBA8 back, no gamma or colour profile applied (what `UNPACK_COLORSPACE_CONVERSION_WEBGL = NONE` gave the window), 16-bit samples kept to their high byte.

/// Decoded, 8 MP-class inputs stay well under this; a hostile scene cannot ask for more.
const MAX_INPUT_BYTES: usize = 256 * 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024 * 1024;

/// Straight RGBA8 rows, top row first, plus the image size.
pub(crate) fn decode_png_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("not a valid PNG: {e}"))?;
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
    let mut rgba = Vec::with_capacity(pixels);
    match info.color_type {
        png::ColorType::Rgba => rgba.extend_from_slice(source),
        png::ColorType::Rgb => source
            .chunks_exact(3)
            .for_each(|pixel| rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255])),
        png::ColorType::GrayscaleAlpha => source
            .chunks_exact(2)
            .for_each(|pixel| rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]])),
        png::ColorType::Grayscale => source
            .iter()
            .for_each(|value| rgba.extend_from_slice(&[*value, *value, *value, 255])),
        png::ColorType::Indexed => return Err("PNG palette was not expanded".into()),
    }
    if rgba.len() != pixels {
        return Err("PNG pixel data is incomplete".into());
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
    let (rgba, width, height) = decode_png_rgba(bytes)?;
    let mut out = Vec::with_capacity(8 + rgba.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&rgba);
    Ok(tauri::ipc::Response::new(out))
}

#[cfg(test)]
mod tests {
    use super::decode_png_rgba;

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
    fn a_non_png_is_refused() {
        assert!(decode_png_rgba(b"\xff\xd8\xff\xe0 not a png").is_err());
    }
}
