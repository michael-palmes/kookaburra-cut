//! Where a video's edit list opens, read from its MP4 or QuickTime boxes without decoding: kb's rule (kblib/mp4box.py `analyse`) over the same tables (mvhd, and the first video track's mdhd, hdlr, elst, stts and ctts), so the app and kb judge one file alike. Conformance cases: the kit's `edit-start-vectors.json`.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;

const MAX_MOOV_BYTES: u64 = 64 * 1024 * 1024;
/// Far past any real recording (77 hours at 60 fps); a table claiming more is not one.
const MAX_SAMPLES: u64 = 1 << 24;

/// Where the first video track's edit list opens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum EditStart {
    /// No edit list.
    None,
    /// On the first frame shown: the B-frame delay's trivial edit.
    FirstFrame,
    /// On a later frame: it skips whole frames.
    Frame,
    /// Inside a frame: ffmpeg drops that frame and shows the next one at 0 s.
    MidSample,
    /// Before the first frame.
    Gap,
    /// Several segments, an empty edit or a rate change.
    Complex,
}

impl EditStart {
    /// Anything past no edit or the trivial one.
    pub(crate) fn edited(self) -> bool {
        !matches!(self, Self::None | Self::FirstFrame)
    }
}

/// The edit start of the file's first video track; None when it is no readable movie or has no video track.
pub(crate) fn edit_start(path: &Path) -> Option<EditStart> {
    edit_start_in(&mut File::open(path).ok()?)
}

fn edit_start_in<R: Read + Seek>(movie: &mut R) -> Option<EditStart> {
    edit_start_of(&read_moov(movie)?)
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn u64_at(data: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(
        data.get(at..at.checked_add(8)?)?.try_into().ok()?,
    ))
}

/// The moov payload; every top-level box must fit the file, as kb reads it.
fn read_moov<R: Read + Seek>(file: &mut R) -> Option<Vec<u8>> {
    let length = file.seek(SeekFrom::End(0)).ok()?;
    let mut pos = 0u64;
    let mut moov = None;
    while pos + 8 <= length {
        file.seek(SeekFrom::Start(pos)).ok()?;
        let mut head = [0u8; 16];
        file.read_exact(&mut head[..8]).ok()?;
        let mut size = u64::from(u32_at(&head, 0)?);
        let mut payload = pos + 8;
        if size == 1 {
            file.read_exact(&mut head[8..]).ok()?;
            size = u64_at(&head, 8)?;
            payload += 8;
        } else if size == 0 {
            size = length - pos;
        }
        let end = pos.checked_add(size)?;
        if size < payload - pos || end > length {
            return None;
        }
        if &head[4..8] == b"uuid" {
            payload += 16;
        }
        if &head[4..8] == b"moov" && moov.is_none() {
            moov = Some((payload, end));
        }
        pos = end;
    }
    let (start, end) = moov?;
    if end - start > MAX_MOOV_BYTES {
        return None;
    }
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut data = vec![0u8; usize::try_from(end - start).ok()?];
    file.read_exact(&mut data).ok()?;
    Some(data)
}

/// One box inside a parent: its type, payload start and end.
type Child = ([u8; 4], usize, usize);

/// The boxes inside `data[start..end]` in order; an `Err` ends the walk where one overruns its parent.
fn children(data: &[u8], start: usize, end: usize) -> impl Iterator<Item = Result<Child, ()>> + '_ {
    let mut pos = start;
    let mut failed = false;
    std::iter::from_fn(move || {
        if failed || pos + 8 > end {
            return None;
        }
        let parsed = (|| {
            let mut size = u64::from(u32_at(data, pos)?);
            let kind: [u8; 4] = data.get(pos + 4..pos + 8)?.try_into().ok()?;
            let mut payload = pos + 8;
            if size == 1 {
                if pos + 16 > end {
                    return None;
                }
                size = u64_at(data, pos + 8)?;
                payload += 8;
            } else if size == 0 {
                size = (end - pos) as u64;
            }
            let box_end = pos.checked_add(usize::try_from(size).ok()?)?;
            if size < (payload - pos) as u64 || box_end > end {
                return None;
            }
            if &kind == b"uuid" {
                payload += 16;
            }
            Some((kind, payload, box_end))
        })();
        match parsed {
            Some(child) => {
                pos = child.2;
                Some(Ok(child))
            }
            None => {
                failed = true;
                Some(Err(()))
            }
        }
    })
}

/// The first box along `path`, each a child of the last, as (payload start, end); `Err` when a box on the way is malformed.
fn find(
    data: &[u8],
    start: usize,
    end: usize,
    path: &[&[u8; 4]],
) -> Result<Option<(usize, usize)>, ()> {
    let mut span = (start, end);
    for kind in path {
        let mut found = None;
        for child in children(data, span.0, span.1) {
            let (k, s, e) = child?;
            if &k == *kind {
                found = Some((s, e));
                break;
            }
        }
        match found {
            Some(next) => span = next,
            None => return Ok(None),
        }
    }
    Ok(Some(span))
}

/// mdhd's (or mvhd's) timescale.
fn timescale(data: &[u8], start: usize) -> Option<u32> {
    let version = *data.get(start..start + 4)?.first()?;
    u32_at(data, start + 4 + if version == 1 { 16 } else { 8 })
}

/// elst entries: (segment duration in movie units, media time in media units or -1, rate).
fn edit_list(data: &[u8], start: usize, end: usize) -> Option<Vec<(u64, i64, f64)>> {
    let version = *data.get(start..start + 4)?.first()?;
    let count = u32_at(data, start + 4)?;
    let width = if version == 1 { 20 } else { 12 };
    let mut p = start + 8;
    let mut out = Vec::new();
    for _ in 0..count {
        if p + width > end {
            return None;
        }
        let (seg, media, at) = if version == 1 {
            (u64_at(data, p)?, u64_at(data, p + 8)? as i64, p + 16)
        } else {
            (
                u64::from(u32_at(data, p)?),
                i64::from(u32_at(data, p + 4)? as i32),
                p + 8,
            )
        };
        let whole = i16::from_be_bytes(data.get(at..at + 2)?.try_into().ok()?);
        let frac = u16::from_be_bytes(data.get(at + 2..at + 4)?.try_into().ok()?);
        out.push((seg, media, f64::from(whole) + f64::from(frac) / 65536.0));
        p += width;
    }
    Some(out)
}

/// stts or ctts rows (count, value); a version 0 table's value reads signed, as players take it.
fn sample_rows(data: &[u8], start: usize, end: usize) -> Option<Vec<(u32, i64)>> {
    data.get(start..start + 4)?;
    let count = u32_at(data, start + 4)? as usize;
    let p = start + 8;
    if p + 8 * count > end {
        return None;
    }
    (0..count)
        .map(|i| {
            Some((
                u32_at(data, p + 8 * i)?,
                i64::from(u32_at(data, p + 8 * i + 4)? as i32),
            ))
        })
        .collect()
}

#[derive(Default)]
struct Track {
    video: bool,
    timescale: u32,
    edits: Option<Vec<(u64, i64, f64)>>,
    stts: Vec<(u32, i64)>,
    ctts: Vec<(u32, i64)>,
}

fn track(data: &[u8], start: usize, end: usize) -> Option<Track> {
    let mut t = Track::default();
    let Some(mdia) = find(data, start, end, &[b"mdia"]).ok()? else {
        return Some(t);
    };
    if let Some((s, e)) = find(data, mdia.0, mdia.1, &[b"hdlr"]).ok()? {
        t.video = s + 12 <= e && data.get(s + 8..s + 12)? == b"vide";
    }
    if let Some((s, _)) = find(data, mdia.0, mdia.1, &[b"mdhd"]).ok()? {
        t.timescale = timescale(data, s)?;
    }
    if let Some((s, e)) = find(data, start, end, &[b"edts", b"elst"]).ok()? {
        t.edits = Some(edit_list(data, s, e)?);
    }
    let Some(stbl) = find(data, mdia.0, mdia.1, &[b"minf", b"stbl"]).ok()? else {
        return Some(t);
    };
    for child in children(data, stbl.0, stbl.1) {
        let (kind, s, e) = child.ok()?;
        match &kind {
            b"stts" => t.stts = sample_rows(data, s, e)?,
            b"ctts" => t.ctts = sample_rows(data, s, e)?,
            _ => {}
        }
    }
    Some(t)
}

/// The rule over a moov payload (kblib/mp4box.py `analyse`, `editStart`).
fn edit_start_of(moov: &[u8]) -> Option<EditStart> {
    let mut video = None;
    for child in children(moov, 0, moov.len()) {
        let (kind, s, e) = child.ok()?;
        match &kind {
            b"mvhd" => {
                timescale(moov, s)?;
            }
            b"trak" => {
                let t = track(moov, s, e)?;
                if t.video && video.is_none() {
                    video = Some(t);
                }
            }
            _ => {}
        }
    }
    let video = video?;
    if video
        .stts
        .iter()
        .map(|&(count, _)| u64::from(count))
        .sum::<u64>()
        > MAX_SAMPLES
    {
        return None;
    }
    let deltas: Vec<i64> = video
        .stts
        .iter()
        .flat_map(|&(count, delta)| std::iter::repeat(delta).take(count as usize))
        .collect();
    let mut offsets: Vec<i64> = video
        .ctts
        .iter()
        .flat_map(|&(count, offset)| std::iter::repeat(offset).take(count as usize))
        .take(deltas.len())
        .collect();
    offsets.resize(deltas.len(), 0);
    let mut dts = 0i64;
    let mut times: Vec<i64> = deltas
        .iter()
        .zip(&offsets)
        .map(|(delta, offset)| {
            let cts = dts + offset;
            dts += delta;
            cts
        })
        .collect();
    if times.is_empty() || video.timescale == 0 {
        return Some(EditStart::None);
    }
    times.sort_unstable();
    let edits: Vec<_> = video
        .edits
        .unwrap_or_default()
        .into_iter()
        .filter(|&(seg, media, _)| !(media == -1 && seg == 0))
        .collect();
    let Some(&(_, media, rate)) = edits.first() else {
        return Some(EditStart::None);
    };
    Some(
        if edits.len() > 1 || media < 0 || (rate - 1.0).abs() > 1e-3 {
            EditStart::Complex
        } else if media == times[0] {
            EditStart::FirstFrame
        } else if media < times[0] {
            EditStart::Gap
        } else if times.binary_search(&media).is_ok() {
            EditStart::Frame
        } else {
            EditStart::MidSample
        },
    )
}

#[cfg(test)]
pub(crate) mod synth {
    //! Movies built box by box (the kit's tests/mp4synth.py): just the boxes the edit-start rule reads.

    fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((8 + payload.len()) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    fn full(kind: &[u8; 4], version: u8, payload: &[u8]) -> Vec<u8> {
        let mut body = vec![version, 0, 0, 0];
        body.extend_from_slice(payload);
        boxed(kind, &body)
    }

    fn runs(values: &[i64]) -> Vec<(u32, i64)> {
        let mut out: Vec<(u32, i64)> = Vec::new();
        for &v in values {
            match out.last_mut() {
                Some((count, last)) if *last == v => *count += 1,
                _ => out.push((1, v)),
            }
        }
        out
    }

    fn table(kind: &[u8; 4], version: u8, rows: &[(u32, i64)]) -> Vec<u8> {
        let mut body = (rows.len() as u32).to_be_bytes().to_vec();
        for &(count, value) in rows {
            body.extend_from_slice(&count.to_be_bytes());
            body.extend_from_slice(&(value as i32).to_be_bytes());
        }
        full(kind, version, &body)
    }

    /// A one-track video: decode deltas, composition offsets and an edit list of (segment duration, media time or -1, rate).
    pub(crate) fn movie(
        deltas: &[i64],
        offsets: Option<&[i64]>,
        edits: Option<&[(u64, i64, f64)]>,
        timescale: u32,
        movie_scale: u32,
        elst_version: u8,
    ) -> Vec<u8> {
        let mut mvhd = [0u8; 96];
        mvhd[8..12].copy_from_slice(&movie_scale.to_be_bytes());
        let mut moov = full(b"mvhd", 0, &mvhd);
        let mut trak = Vec::new();
        if let Some(edits) = edits {
            let mut body = (edits.len() as u32).to_be_bytes().to_vec();
            for &(seg, media, rate) in edits {
                if elst_version == 1 {
                    body.extend_from_slice(&seg.to_be_bytes());
                    body.extend_from_slice(&media.to_be_bytes());
                } else {
                    body.extend_from_slice(&(seg as u32).to_be_bytes());
                    body.extend_from_slice(&(media as i32).to_be_bytes());
                }
                let whole = rate.trunc();
                body.extend_from_slice(&(whole as i16).to_be_bytes());
                body.extend_from_slice(&(((rate - whole) * 65536.0).round() as u16).to_be_bytes());
            }
            trak.extend(boxed(b"edts", &full(b"elst", elst_version, &body)));
        }
        let mut mdhd = [0u8; 20];
        mdhd[8..12].copy_from_slice(&timescale.to_be_bytes());
        let mut hdlr = vec![0u8; 4];
        hdlr.extend_from_slice(b"vide");
        hdlr.extend_from_slice(&[0u8; 12]);
        let mut stbl = table(b"stts", 0, &runs(deltas));
        if let Some(offsets) = offsets {
            stbl.extend(table(b"ctts", 1, &runs(offsets)));
        }
        let mut mdia = full(b"mdhd", 0, &mdhd);
        mdia.extend(full(b"hdlr", 0, &hdlr));
        mdia.extend(boxed(b"minf", &boxed(b"stbl", &stbl)));
        trak.extend(boxed(b"mdia", &mdia));
        moov.extend(boxed(b"trak", &trak));
        let mut out = boxed(b"ftyp", b"isom\0\0\x02\0isomiso2avc1mp41");
        out.extend(boxed(b"mdat", &vec![0u8; 4 * deltas.len()]));
        out.extend(boxed(b"moov", &moov));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::synth::movie;
    use super::*;

    fn start_of(bytes: &[u8]) -> Option<EditStart> {
        edit_start_in(&mut std::io::Cursor::new(bytes))
    }

    fn simple(deltas: &[i64], edits: &[(u64, i64, f64)]) -> Option<EditStart> {
        start_of(&movie(deltas, None, Some(edits), 600, 1000, 0))
    }

    /// 29 frames at 60 fps, one held 1 s, then 30 more (the kit's HELD recording).
    fn held() -> Vec<i64> {
        let mut deltas = vec![10; 29];
        deltas.push(600);
        deltas.extend([10; 30]);
        deltas
    }

    #[test]
    fn a_trivial_edit_opens_on_the_first_frame() {
        assert_eq!(
            simple(&[10; 60], &[(1000, 0, 1.0)]),
            Some(EditStart::FirstFrame)
        );
        assert_eq!(
            start_of(&movie(&[10; 30], None, None, 600, 1000, 0)),
            Some(EditStart::None)
        );
        // I P B B as x264 stores them: the edit opens on the first frame shown, past the composition delay.
        let offsets = [20, 50, 10, 10, 50, 20, 20, 20];
        let delayed = movie(
            &[10; 8],
            Some(&offsets),
            Some(&[(133, 20, 1.0)]),
            600,
            1000,
            0,
        );
        assert_eq!(start_of(&delayed), Some(EditStart::FirstFrame));
        assert!(!EditStart::FirstFrame.edited() && !EditStart::None.edited());
    }

    #[test]
    fn a_whole_frame_trim_skips_frames() {
        assert_eq!(
            simple(&[10; 120], &[(1500, 300, 1.0)]),
            Some(EditStart::Frame)
        );
    }

    #[test]
    fn an_edit_inside_a_held_frame_is_mid_sample() {
        assert_eq!(
            simple(&held(), &[(1500, 450, 1.0)]),
            Some(EditStart::MidSample)
        );
        let large = movie(&held(), None, Some(&[(1500, 450, 1.0)]), 600, 1000, 1);
        assert_eq!(
            start_of(&large),
            Some(EditStart::MidSample),
            "a version 1 elst"
        );
        let offsets = [20, 50, 10, 10, 50, 20, 20, 20];
        let trimmed = movie(
            &[10; 8],
            Some(&offsets),
            Some(&[(100, 45, 1.0)]),
            600,
            1000,
            0,
        );
        assert_eq!(start_of(&trimmed), Some(EditStart::MidSample));
    }

    #[test]
    fn an_edit_before_the_first_frame_is_a_gap() {
        let gap = movie(
            &[10; 30],
            Some(&[60; 30]),
            Some(&[(500, 0, 1.0)]),
            600,
            1000,
            0,
        );
        assert_eq!(start_of(&gap), Some(EditStart::Gap));
    }

    #[test]
    fn empty_edits_segments_and_rates_are_complex() {
        assert_eq!(
            simple(&[10; 30], &[(200, -1, 1.0), (500, 0, 1.0)]),
            Some(EditStart::Complex)
        );
        assert_eq!(
            simple(&[10; 30], &[(1000, 0, 0.5)]),
            Some(EditStart::Complex)
        );
        assert_eq!(
            simple(&[10; 30], &[(0, -1, 1.0), (500, 0, 1.0)]),
            Some(EditStart::FirstFrame),
            "a zero-length empty edit is no edit"
        );
    }

    #[test]
    fn what_is_no_movie_reads_as_none() {
        assert_eq!(start_of(b"\x89PNG\r\n\x1a\n\0\0\0\0\0\0\0\0"), None);
        assert_eq!(start_of(b""), None);
        let good = movie(&[10; 30], None, Some(&[(500, 0, 1.0)]), 600, 1000, 0);
        assert_eq!(start_of(&good[..good.len() - 20]), None, "a truncated moov");
    }
}
