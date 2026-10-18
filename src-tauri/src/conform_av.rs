//! AVFoundation through objc2, the ingest conform's only unsafe module: a video track's facts without decoding (`probe`), and a decode to 8-bit NV12 in presentation time with the partly covered first sample kept (`Frames`), optionally converted to BT.709 primaries with the IEC sRGB transfer (never the ITU_R_709_2 transfer, which gives the wrong values for the sRGB texture path). Everything around it is pure (conform.rs).

use std::path::Path;

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVAssetTrack, AVMediaTypeAudio,
    AVMediaTypeVideo, AVURLAsset, AVURLAssetPreferPreciseDurationAndTimingKey,
    AVVideoColorPrimariesKey, AVVideoColorPrimaries_ITU_R_709_2, AVVideoColorPropertiesKey,
    AVVideoTransferFunctionKey, AVVideoTransferFunction_IEC_sRGB, AVVideoYCbCrMatrixKey,
    AVVideoYCbCrMatrix_ITU_R_709_2,
};
use objc2_core_foundation::{CFBoolean, CFNumber, CFString};
use objc2_core_media::{
    kCMFormatDescriptionExtension_BitsPerComponent, kCMFormatDescriptionExtension_ColorPrimaries,
    kCMFormatDescriptionExtension_FullRangeVideo, kCMFormatDescriptionExtension_TransferFunction,
    kCMFormatDescriptionExtension_YCbCrMatrix, CMFormatDescription, CMTime,
};
use objc2_core_video::{
    kCVPixelBufferPixelFormatTypeKey, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    CVPixelBuffer, CVPixelBufferGetBaseAddressOfPlane, CVPixelBufferGetBytesPerRowOfPlane,
    CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType, CVPixelBufferGetPlaneCount,
    CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
    CVPixelBufferUnlockBaseAddress,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

use crate::conform::{tenth, AvFacts, Colour, EditSegment, MediaTime, SourceFrame};

const VALID: u32 = 1;

fn media_time(time: CMTime) -> Option<MediaTime> {
    let (value, scale, flags) = (time.value, time.timescale, time.flags.0);
    (flags & VALID != 0 && scale > 0).then(|| MediaTime::new(value, scale))
}

fn ms(time: CMTime) -> f64 {
    media_time(time).map_or(0.0, MediaTime::ms)
}

/// A CoreFoundation string key as the NSString it toll-free bridges to.
fn bridged(key: &CFString) -> &NSString {
    // SAFETY: CFString and NSString are toll-free bridged; the reference keeps its lifetime.
    unsafe { &*(key as *const CFString).cast::<NSString>() }
}

fn open_asset(path: &Path) -> Result<Retained<AVURLAsset>, String> {
    let text = path
        .to_str()
        .ok_or_else(|| format!("{} is not a UTF-8 path", path.display()))?;
    let precise = NSNumber::new_bool(true);
    // SAFETY: plain Foundation constructors; the key is a framework constant.
    unsafe {
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        let value: &AnyObject = &precise;
        let options = NSDictionary::<NSString, AnyObject>::from_slices(
            &[AVURLAssetPreferPreciseDurationAndTimingKey],
            &[value],
        );
        Ok(AVURLAsset::URLAssetWithURL_options(&url, Some(&options)))
    }
}

/// The asset's first video track and whether it carries audio.
fn video_track(asset: &AVURLAsset) -> Result<(Retained<AVAssetTrack>, bool), String> {
    // SAFETY: the synchronous accessors block until loaded, which a background thread can afford.
    unsafe {
        let video = AVMediaTypeVideo.ok_or("AVFoundation lacks the video media type")?;
        let audio = AVMediaTypeAudio;
        let mut found = None;
        let mut has_audio = false;
        for track in asset.tracks().iter() {
            let kind = track.mediaType();
            if found.is_none() && &*kind == video {
                found = Some(track);
            } else if audio.is_some_and(|a| &*kind == a) {
                has_audio = true;
            }
        }
        let track = found.ok_or("AVFoundation found no video track it can read")?;
        Ok((track, has_audio))
    }
}

fn string_extension(fd: &CMFormatDescription, key: &CFString) -> Option<String> {
    // SAFETY: reads an immutable format description.
    let value = unsafe { fd.extension(key) }?;
    value.downcast_ref::<CFString>().map(|s| s.to_string())
}

fn four_cc(code: u32) -> String {
    code.to_be_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_graphic() {
                *b as char
            } else {
                '?'
            }
        })
        .collect()
}

/// The transform's turn in whole degrees, and whether it mirrors or turns by an odd angle.
fn turn(a: f64, b: f64, c: f64, d: f64) -> (i64, bool) {
    let degrees = b.atan2(a).to_degrees().round() as i64;
    let mirrored = a * d - b * c < 0.0;
    (degrees, mirrored || degrees.rem_euclid(90) != 0)
}

/// Track facts for the probe: no decode, so it costs one asset load.
pub(crate) fn probe(path: &Path) -> Result<AvFacts, String> {
    autoreleasepool(|_| {
        let asset = open_asset(path)?;
        let (track, has_audio) = video_track(&asset)?;
        // SAFETY: synchronous property reads on a loaded asset and its track.
        unsafe {
            let size = track.naturalSize();
            let t = track.preferredTransform();
            let (rotation, odd_transform) = turn(t.a, t.b, t.c, t.d);
            let duration = media_time(asset.duration());
            let mut facts = AvFacts {
                width: size.width.round().max(0.0) as u32,
                height: size.height.round().max(0.0) as u32,
                rotation,
                odd_transform,
                nominal_fps: f64::from(track.nominalFrameRate()),
                min_frame_ms: ms(track.minFrameDuration()),
                duration_ms: duration.map_or(0.0, MediaTime::ms),
                duration,
                reorders: track.requiresFrameReordering(),
                has_audio,
                ..AvFacts::default()
            };
            let descriptions = track.formatDescriptions();
            if let Some(first) = descriptions.firstObject() {
                let fd = &*Retained::as_ptr(&first).cast::<CMFormatDescription>();
                facts.codec = four_cc(fd.media_sub_type());
                facts.colour = Colour {
                    primaries: string_extension(fd, kCMFormatDescriptionExtension_ColorPrimaries),
                    transfer: string_extension(fd, kCMFormatDescriptionExtension_TransferFunction),
                    matrix: string_extension(fd, kCMFormatDescriptionExtension_YCbCrMatrix),
                    range: fd
                        .extension(kCMFormatDescriptionExtension_FullRangeVideo)
                        .and_then(|v| v.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool))
                        .map(|full| if full { "full" } else { "video" }.to_owned()),
                };
                facts.bits = fd
                    .extension(kCMFormatDescriptionExtension_BitsPerComponent)
                    .and_then(|v| v.downcast_ref::<CFNumber>().and_then(CFNumber::as_i32))
                    .and_then(|bits| u32::try_from(bits).ok());
            }
            facts.edit_list = track
                .segments()
                .iter()
                .map(|segment| {
                    let mapping = segment.timeMapping();
                    EditSegment {
                        media_start_ms: (!segment.isEmpty())
                            .then(|| tenth(ms(mapping.source.start))),
                        media_duration_ms: tenth(ms(mapping.source.duration)),
                        target_start_ms: tenth(ms(mapping.target.start)),
                        target_duration_ms: tenth(ms(mapping.target.duration)),
                    }
                })
                .collect();
            Ok(facts)
        }
    })
}

/// The reader's output settings: 420v, plus the BT.709 primaries, IEC sRGB transfer and BT.709 matrix when converting.
fn output_settings(
    convert_colour: bool,
) -> Result<Retained<NSDictionary<NSString, AnyObject>>, String> {
    let format = NSNumber::new_u32(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange);
    // SAFETY: framework string constants and Foundation constructors.
    unsafe {
        let format_key = bridged(kCVPixelBufferPixelFormatTypeKey);
        let format_value: &AnyObject = &format;
        if !convert_colour {
            return Ok(NSDictionary::from_slices(&[format_key], &[format_value]));
        }
        let missing = "AVFoundation lacks a colour property key";
        let colour = NSDictionary::<NSString, AnyObject>::from_slices(
            &[
                AVVideoColorPrimariesKey.ok_or(missing)?,
                AVVideoTransferFunctionKey.ok_or(missing)?,
                AVVideoYCbCrMatrixKey.ok_or(missing)?,
            ],
            &[
                AVVideoColorPrimaries_ITU_R_709_2.ok_or(missing)?,
                AVVideoTransferFunction_IEC_sRGB.ok_or(missing)?,
                AVVideoYCbCrMatrix_ITU_R_709_2.ok_or(missing)?,
            ]
            .map(|s| -> &AnyObject { s }),
        );
        let colour_value: &AnyObject = &colour;
        Ok(NSDictionary::from_slices(
            &[format_key, AVVideoColorPropertiesKey.ok_or(missing)?],
            &[format_value, colour_value],
        ))
    }
}

/// Decoded frames of the first video track in presentation order; `pixels: false` decodes for timing only and keeps no picture.
pub(crate) struct Frames {
    reader: Retained<AVAssetReader>,
    output: Retained<AVAssetReaderTrackOutput>,
    pixels: bool,
    done: bool,
}

impl Frames {
    pub(crate) fn open(path: &Path, convert_colour: bool, pixels: bool) -> Result<Self, String> {
        autoreleasepool(|_| {
            let asset = open_asset(path)?;
            let (track, _) = video_track(&asset)?;
            let settings = output_settings(convert_colour)?;
            // SAFETY: the settings are uncompressed 420v (and the documented colour keys), which the track output accepts; adding is checked first, so neither raises.
            unsafe {
                let reader = AVAssetReader::assetReaderWithAsset_error(&asset).map_err(|e| {
                    format!(
                        "AVFoundation can't read the video: {}",
                        e.localizedDescription()
                    )
                })?;
                let output =
                    AVAssetReaderTrackOutput::assetReaderTrackOutputWithTrack_outputSettings(
                        &track,
                        Some(&settings),
                    );
                output.setAlwaysCopiesSampleData(false);
                if !reader.canAddOutput(&output) {
                    return Err("AVFoundation can't decode this video track".into());
                }
                reader.addOutput(&output);
                if !reader.startReading() {
                    return Err(reader_error(&reader));
                }
                Ok(Self {
                    reader,
                    output,
                    pixels,
                    done: false,
                })
            }
        })
    }

    fn next_frame(&mut self) -> Result<Option<(MediaTime, SourceFrame)>, String> {
        if self.done {
            return Ok(None);
        }
        autoreleasepool(|_| loop {
            // SAFETY: the reader was started; the sample buffer is owned for this iteration.
            let Some(sample) = (unsafe { self.output.copyNextSampleBuffer() }) else {
                self.done = true;
                // SAFETY: status reads on the reader this output belongs to.
                return match unsafe { self.reader.status() } {
                    AVAssetReaderStatus::Completed => Ok(None),
                    _ => Err(unsafe { reader_error(&self.reader) }),
                };
            };
            // SAFETY: timing and image-buffer reads on a live sample buffer.
            let (pts, image) = unsafe { (sample.presentation_time_stamp(), sample.image_buffer()) };
            let (Some(pts), Some(image)) = (media_time(pts), image) else {
                continue;
            };
            let frame = if self.pixels {
                pack_nv12(&image)?
            } else {
                SourceFrame {
                    width: 0,
                    height: 0,
                    nv12: Vec::new(),
                }
            };
            return Ok(Some((pts, frame)));
        })
    }
}

impl Drop for Frames {
    fn drop(&mut self) {
        if !self.done {
            // SAFETY: cancelling a started reader is always allowed.
            unsafe { self.reader.cancelReading() };
        }
    }
}

impl Iterator for Frames {
    type Item = Result<(MediaTime, SourceFrame), String>;

    fn next(&mut self) -> Option<Self::Item> {
        self.next_frame().transpose()
    }
}

unsafe fn reader_error(reader: &AVAssetReader) -> String {
    reader.error().map_or_else(
        || "AVFoundation stopped reading the video".to_owned(),
        |e| {
            format!(
                "AVFoundation stopped reading the video: {}",
                e.localizedDescription()
            )
        },
    )
}

/// Copy a 420v pixel buffer into tightly packed NV12, cropped to even dimensions (libx264's 4:2:0 needs them).
fn pack_nv12(buffer: &CVPixelBuffer) -> Result<SourceFrame, String> {
    if CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        || CVPixelBufferGetPlaneCount(buffer) != 2
    {
        return Err("AVFoundation returned a frame that is not 8-bit 4:2:0".into());
    }
    let width = CVPixelBufferGetWidth(buffer) & !1;
    let height = CVPixelBufferGetHeight(buffer) & !1;
    if width == 0 || height == 0 {
        return Err("the video's frames are too small to conform".into());
    }
    let mut nv12 = Vec::with_capacity(width * height * 3 / 2);
    // SAFETY: the base address stays valid while locked; every row read is within bytesPerRow × rows of its plane.
    unsafe {
        if CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) != 0 {
            return Err("couldn't lock a decoded frame".into());
        }
        for (plane, rows) in [(0usize, height), (1usize, height / 2)] {
            let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane).cast::<u8>();
            let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane);
            if base.is_null() || stride < width {
                CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly);
                return Err("a decoded frame has no readable plane".into());
            }
            for row in 0..rows {
                nv12.extend_from_slice(std::slice::from_raw_parts(base.add(row * stride), width));
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly);
    }
    Ok(SourceFrame {
        width: width as u32,
        height: height as u32,
        nv12,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transforms_read_as_quarter_turns_or_odd() {
        assert_eq!(turn(1.0, 0.0, 0.0, 1.0), (0, false));
        assert_eq!(turn(0.0, 1.0, -1.0, 0.0), (90, false));
        assert_eq!(turn(0.0, -1.0, 1.0, 0.0), (-90, false));
        assert_eq!(turn(-1.0, 0.0, 0.0, -1.0), (180, false));
        assert!(turn(-1.0, 0.0, 0.0, 1.0).1, "a mirror is odd");
        let h = std::f64::consts::FRAC_1_SQRT_2;
        assert_eq!(turn(h, h, -h, h), (45, true));
    }

    #[test]
    fn four_character_codes_read_big_endian() {
        assert_eq!(four_cc(0x61766331), "avc1");
        assert_eq!(four_cc(0x68766331), "hvc1");
    }

    #[test]
    fn invalid_times_are_none() {
        let t = |value, timescale, flags| CMTime {
            value,
            timescale,
            flags: objc2_core_media::CMTimeFlags(flags),
            epoch: 0,
        };
        assert_eq!(media_time(t(950, 1000, 1)), Some(MediaTime::new(950, 1000)));
        assert_eq!(media_time(t(950, 1000, 0)), None);
        assert_eq!(media_time(t(1, 0, 1)), None);
    }
}
