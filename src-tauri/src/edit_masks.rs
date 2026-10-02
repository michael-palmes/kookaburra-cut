//! Privacy masks in the editor render: each mask becomes a filter chain on its source's normalised stream (before the split), so `t` is source seconds, coordinates are source pixels, and every clip, speed change and freeze cut from that source inherits it. A moving box is driven by `t` expressions (`scale … eval=frame` + `overlay … eval=frame`); a one-key box uses fixed numbers. Strength constants mirror src/engine/editMasks.ts.

use crate::edit::{EditDoc, EditMask, EditMaskStyle, EditSource, EditSourceKind};

const DEFAULT_STRENGTH: f64 = 0.5;
const BLUR_MIN: f64 = 0.008;
const BLUR_MAX: f64 = 0.04;
const BLOCK_MIN: f64 = 0.025;
const BLOCK_MAX: f64 = 0.1;

fn strength(mask: &EditMask) -> f64 {
    match mask.strength {
        Some(s) if s.is_finite() => s.clamp(0.0, 1.0),
        _ => DEFAULT_STRENGTH,
    }
}

/// Blur sigma in source pixels, rounded to 2 dp (mirrored: `maskBlurSigmaPx`).
pub fn blur_sigma_px(mask: &EditMask, source: &EditSource) -> f64 {
    let frac = BLUR_MIN + strength(mask) * (BLUR_MAX - BLUR_MIN);
    (frac * f64::from(source.width.min(source.height)) * 100.0).round() / 100.0
}

/// Pixelate block edge in source pixels, even and at least 2 (mirrored: `maskBlockPx`).
pub fn block_px(mask: &EditMask, source: &EditSource) -> u32 {
    let frac = BLOCK_MIN + strength(mask) * (BLOCK_MAX - BLOCK_MIN);
    let px = 2.0 * (frac * f64::from(source.width.min(source.height)) / 2.0).round();
    (px as u32).max(2)
}

/// `#rrggbb` (absent = black) as ffmpeg's `0xRRGGBB`; anything else is refused, so no free text reaches the filter graph.
pub fn parse_hex_colour(colour: Option<&str>) -> Result<String, String> {
    let Some(hex) = colour else {
        return Ok("0x000000".into());
    };
    let digits = hex.strip_prefix('#').unwrap_or("");
    if digits.len() != 6 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("mask colour must be #rrggbb, got {hex:?}"));
    }
    Ok(format!("0x{}", digits.to_ascii_uppercase()))
}

/// Fail closed: a mask that can't be rendered exactly as drawn errors the render instead of being skipped.
pub fn validate_masks(doc: &EditDoc) -> Result<(), String> {
    for mask in &doc.masks {
        let Some(source) = doc.sources.iter().find(|s| s.id == mask.source_id) else {
            continue;
        };
        parse_hex_colour(mask.color.as_deref())?;
        if mask.keys.is_empty() {
            return Err(format!("mask {} has no keyframes", mask.id));
        }
        if source.kind == EditSourceKind::Video && mask.end_ms <= mask.start_ms {
            return Err(format!("mask {} has an empty time span", mask.id));
        }
        for key in &mask.keys {
            let [x, y, w, h] = key.rect;
            if ![x, y, w, h].iter().all(|v| v.is_finite()) || w <= 0.0 || h <= 0.0 {
                return Err(format!("mask {} has an invalid box", mask.id));
            }
        }
    }
    Ok(())
}

/// A box's edges in source pixels: `[left, top, right, bottom]`.
type Edges = [f64; 4];

fn key_edges(rect: [f64; 4], source: &EditSource) -> Edges {
    let (sw, sh) = (f64::from(source.width), f64::from(source.height));
    let x0 = rect[0].clamp(0.0, 1.0);
    let y0 = rect[1].clamp(0.0, 1.0);
    let x1 = (rect[0] + rect[2]).clamp(x0, 1.0);
    let y1 = (rect[1] + rect[3]).clamp(y0, 1.0);
    [x0 * sw, y0 * sh, x1 * sw, y1 * sh]
}

/// Sorted `(seconds, edges)` per key.
fn key_points(mask: &EditMask, source: &EditSource) -> Vec<(f64, Edges)> {
    let mut keys: Vec<_> = mask.keys.iter().collect();
    keys.sort_by_key(|k| k.source_ms);
    keys.dedup_by_key(|k| k.source_ms);
    keys.iter()
        .map(|k| (k.source_ms as f64 / 1000.0, key_edges(k.rect, source)))
        .collect()
}

/// The box at `t`: linear between keys, held outside them (mirrored: `sampleMaskRect`).
fn edges_at(points: &[(f64, Edges)], t: f64) -> Edges {
    if t <= points[0].0 {
        return points[0].1;
    }
    for w in points.windows(2) {
        let ((ta, a), (tb, b)) = (w[0], w[1]);
        if t < tb {
            let f = (t - ta) / (tb - ta);
            return std::array::from_fn(|i| a[i] + (b[i] - a[i]) * f);
        }
    }
    points[points.len() - 1].1
}

/// The bbox the box sweeps over `[a, b]`: the boxes at both ends plus every key between (the path is linear between keys).
fn swept_bounds(points: &[(f64, Edges)], a: f64, b: f64) -> Edges {
    let mut out = edges_at(points, a);
    let mut grow = |e: Edges| {
        out = [
            out[0].min(e[0]),
            out[1].min(e[1]),
            out[2].max(e[2]),
            out[3].max(e[3]),
        ];
    };
    grow(edges_at(points, b));
    for &(t, e) in points {
        if t > a && t < b {
            grow(e);
        }
    }
    out
}

/// Only the keys that bracket `[a, b]` shape the box inside it.
fn bracketing(points: &[(f64, Edges)], a: f64, b: f64) -> &[(f64, Edges)] {
    let first = points.iter().rposition(|(t, _)| *t <= a).unwrap_or(0);
    let last = points
        .iter()
        .position(|(t, _)| *t >= b)
        .unwrap_or(points.len() - 1);
    &points[first..=last]
}

/// One edge over time as a flat sum of disjoint segment terms (no deep `if` nesting), commas escaped for the graph.
fn axis_expr(points: &[(f64, Edges)], axis: usize) -> String {
    let (t0, v0) = (points[0].0, points[0].1[axis]);
    if points.len() == 1 {
        return format!("{v0:.3}");
    }
    let mut terms = vec![format!("{v0:.3}*lt(t\\,{t0:.6})")];
    for w in points.windows(2) {
        let ((ta, a), (tb, b)) = (w[0], w[1]);
        let (va, dv) = (a[axis], b[axis] - a[axis]);
        terms.push(format!(
            "gte(t\\,{ta:.6})*lt(t\\,{tb:.6})*({va:.3}+{dv:.3}*(t-{ta:.6})/{:.6})",
            tb - ta
        ));
    }
    let (tn, vn) = points[points.len() - 1];
    terms.push(format!("{:.3}*gte(t\\,{tn:.6})", vn[axis]));
    terms.join("+")
}

/// yuv420 snaps overlay positions down to even pixels, so every edge rounds OUTWARD to even (never a 1 px leak).
fn even_floor(v: f64) -> i64 {
    2 * (v / 2.0).floor() as i64
}

fn even_ceil(v: f64) -> i64 {
    2 * (v / 2.0).ceil() as i64
}

/// Expressions for a moving box's even-rounded `(x, y, w, h)`.
fn moving_box(points: &[(f64, Edges)]) -> [String; 4] {
    let l = format!("2*floor(({})/2)", axis_expr(points, 0));
    let t = format!("2*floor(({})/2)", axis_expr(points, 1));
    let w = format!("2*ceil(({})/2)-{l}", axis_expr(points, 2));
    let h = format!("2*ceil(({})/2)-{t}", axis_expr(points, 3));
    [l, t, w, h]
}

/// An integer crop window `[x, y, w, h]` inside the frame.
fn crop_window(bounds: Edges, pad: f64, snap: i64, source: &EditSource) -> [i64; 4] {
    let (sw, sh) = (i64::from(source.width), i64::from(source.height));
    let snap = snap.max(2);
    let floor_to = |v: f64| ((v - pad) / snap as f64).floor() as i64 * snap;
    let ceil_to = |v: f64| ((v + pad) / snap as f64).ceil() as i64 * snap;
    let x0 = floor_to(bounds[0]).clamp(0, sw - 1);
    let y0 = floor_to(bounds[1]).clamp(0, sh - 1);
    let x1 = ceil_to(bounds[2]).clamp(x0 + 1, sw);
    let y1 = ceil_to(bounds[3]).clamp(y0 + 1, sh);
    [x0, y0, x1 - x0, y1 - y0]
}

/// The obscuring filter run on a crop: gaussian blur or a mosaic on the block grid.
fn effect(mask: &EditMask, source: &EditSource, enable: &str) -> String {
    match mask.style {
        EditMaskStyle::Pixelate => {
            let b = block_px(mask, source);
            format!("pixelize=w={b}:h={b}{enable}")
        }
        _ => format!("gblur=sigma={:.2}{enable}", blur_sigma_px(mask, source)),
    }
}

/// The crop a blur or mosaic reads: the swept box plus 3 sigma of real neighbours for a blur, snapped outward to the block grid for a mosaic (so blocks stay put in frame space).
fn effect_window(mask: &EditMask, source: &EditSource, bounds: Edges) -> [i64; 4] {
    match mask.style {
        EditMaskStyle::Pixelate => {
            crop_window(bounds, 0.0, i64::from(block_px(mask, source)), source)
        }
        _ => crop_window(
            bounds,
            (3.0 * blur_sigma_px(mask, source)).ceil(),
            2,
            source,
        ),
    }
}

/// Builds one mask's chain from `[input]` to `[output]` (each statement `;`-terminated). `span` is the active source window in seconds (`None` = always on, a still), `planes` the rate and length of generated planes (`r=…:d=…`), `tag` a label prefix unique to this mask.
fn mask_chain(
    mask: &EditMask,
    source: &EditSource,
    span: Option<(f64, f64)>,
    planes: &str,
    input: &str,
    output: &str,
    tag: &str,
) -> Result<String, String> {
    let colour = parse_hex_colour(mask.color.as_deref())?;
    let points = key_points(mask, source);
    let enable = span
        .map(|(a, b)| format!(":enable='gte(t\\,{a:.6})*lt(t\\,{b:.6})'"))
        .unwrap_or_default();
    // A still has no time, so it always reads its first key; a video glides only over the keys bracketing its window.
    let (points, bounds) = match span {
        Some((a, b)) => {
            let bracket = bracketing(&points, a, b);
            (bracket.to_vec(), swept_bounds(bracket, a, b))
        }
        None => (vec![points[0]], points[0].1),
    };
    let fmt = if span.is_none() { ":format=yuv444" } else { "" };

    if points.len() == 1 {
        let e = points[0].1;
        let (x, y) = (even_floor(e[0]), even_floor(e[1]));
        let w = even_ceil(e[2]).min(i64::from(source.width)) - x;
        let h = even_ceil(e[3]).min(i64::from(source.height)) - y;
        return Ok(match mask.style {
            EditMaskStyle::Solid => format!(
                "[{input}]drawbox=x={x}:y={y}:w={w}:h={h}:color={colour}:t=fill{enable}[{output}];"
            ),
            _ => {
                let [cx, cy, cw, ch] = effect_window(mask, source, bounds);
                format!(
                    "[{input}]split[{tag}a][{tag}b];\
                     [{tag}b]crop={cw}:{ch}:{cx}:{cy},{},crop={w}:{h}:{}:{}[{tag}fx];\
                     [{tag}a][{tag}fx]overlay=x={x}:y={y}{fmt}{enable}[{output}];",
                    effect(mask, source, &enable),
                    x - cx,
                    y - cy,
                )
            }
        });
    }

    let [bx, by, bw, bh] = moving_box(&points);
    let sized_box = |c: &str, gray: bool| {
        let g = if gray { "format=gray," } else { "" };
        format!("color=c={c}:s=2x2:{planes},{g}scale=w='{bw}':h='{bh}':eval=frame[{tag}box];")
    };
    Ok(match mask.style {
        EditMaskStyle::Solid => format!(
            "{}[{input}][{tag}box]overlay=x='{bx}':y='{by}':eval=frame:shortest=1{enable}[{output}];",
            sized_box(&colour, false)
        ),
        _ => {
            let [cx, cy, cw, ch] = effect_window(mask, source, bounds);
            format!(
                "[{input}]split[{tag}a][{tag}b];\
                 [{tag}b]crop={cw}:{ch}:{cx}:{cy},{}[{tag}fx];\
                 color=c=black:s={cw}x{ch}:{planes},format=gray[{tag}bg];\
                 {}[{tag}bg][{tag}box]overlay=x='{bx}-{cx}':y='{by}-{cy}':eval=frame,format=gray[{tag}alpha];\
                 [{tag}fx][{tag}alpha]alphamerge[{tag}fxa];\
                 [{tag}a][{tag}fxa]overlay=x={cx}:y={cy}:shortest=1{enable}[{output}];",
                effect(mask, source, &enable),
                sized_box("white", true),
            )
        }
    })
}

/// Every mask on a video source, chained from `[input]` to `[output]` on its normalised stream. The enable window is padded one frame each side: a freeze takes the first slot at or after its in-point, which can sit just past a span edge.
pub fn video_chain(
    masks: &[&EditMask],
    source: &EditSource,
    fps: f64,
    input: &str,
    output: &str,
    tag: &str,
) -> Result<String, String> {
    let pad = 1.0 / fps;
    let duration_s = if source.duration_ms > 0 {
        source.duration_ms as f64 / 1000.0 + 1.0
    } else {
        masks.iter().map(|m| m.end_ms).max().unwrap_or(0) as f64 / 1000.0 + 1.0
    };
    let planes = format!("r={fps}:d={duration_s:.3}");
    chain(masks, input, output, tag, |mask, from, to, tag| {
        let span = (
            mask.start_ms as f64 / 1000.0 - pad,
            mask.end_ms as f64 / 1000.0 + pad,
        );
        mask_chain(mask, source, Some(span), &planes, from, to, tag)
    })
}

/// Every mask on a still, chained on one image clip's looped input: always on, first key only. Converts to 4:4:4 first so nothing snaps to even pixels and every filter accepts it.
pub fn image_chain(
    masks: &[&EditMask],
    source: &EditSource,
    input: &str,
    output: &str,
    tag: &str,
) -> Result<String, String> {
    let head = format!("{tag}444");
    let mut out = format!("[{input}]format=yuv444p[{head}];");
    out.push_str(&chain(masks, &head, output, tag, |mask, from, to, tag| {
        mask_chain(mask, source, None, "r=1:d=1", from, to, tag)
    })?);
    Ok(out)
}

fn chain(
    masks: &[&EditMask],
    input: &str,
    output: &str,
    tag: &str,
    one: impl Fn(&EditMask, &str, &str, &str) -> Result<String, String>,
) -> Result<String, String> {
    let mut out = String::new();
    let mut from = input.to_owned();
    for (j, mask) in masks.iter().enumerate() {
        let to = if j + 1 == masks.len() {
            output.to_owned()
        } else {
            format!("{tag}m{j}")
        };
        out.push_str(&one(mask, &from, &to, &format!("{tag}k{j}"))?);
        from = to;
    }
    Ok(out)
}

/// The masks a source carries, in document order (later masks draw over earlier ones).
pub fn masks_for<'a>(doc: &'a EditDoc, source: &EditSource) -> Vec<&'a EditMask> {
    doc.masks
        .iter()
        .filter(|m| m.source_id == source.id && !m.keys.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::EditMaskKey;

    fn source() -> EditSource {
        EditSource {
            id: "s1".into(),
            rel: "assets/a.mp4".into(),
            kind: EditSourceKind::Video,
            width: 1179,
            height: 2556,
            fps: 60.0,
            duration_ms: 10_000,
            abs: String::new(),
        }
    }

    fn mask(style: EditMaskStyle, keys: &[(u64, [f64; 4])]) -> EditMask {
        EditMask {
            id: "m1".into(),
            source_id: "s1".into(),
            style,
            strength: None,
            color: None,
            start_ms: 1000,
            end_ms: 3000,
            keys: keys
                .iter()
                .map(|&(source_ms, rect)| EditMaskKey { source_ms, rect })
                .collect(),
        }
    }

    #[test]
    fn strength_maps_above_the_floor_matching_edit_masks_ts() {
        let s = source();
        let mut m = mask(EditMaskStyle::Blur, &[(0, [0.0, 0.0, 0.5, 0.5])]);
        m.strength = Some(0.0);
        assert_eq!(blur_sigma_px(&m, &s), 9.43);
        assert_eq!(block_px(&m, &s), 30);
        m.strength = None;
        assert_eq!(blur_sigma_px(&m, &s), 28.3);
        assert_eq!(block_px(&m, &s), 74);
        m.strength = Some(1.0);
        assert_eq!(blur_sigma_px(&m, &s), 47.16);
        assert_eq!(block_px(&m, &s), 118);
    }

    #[test]
    fn colours_parse_strictly() {
        assert_eq!(parse_hex_colour(None).unwrap(), "0x000000");
        assert_eq!(parse_hex_colour(Some("#a1b2c3")).unwrap(), "0xA1B2C3");
        assert!(parse_hex_colour(Some("red")).is_err());
        assert!(parse_hex_colour(Some("#12345")).is_err());
        assert!(parse_hex_colour(Some("#000000:enable=0")).is_err());
    }

    #[test]
    fn edges_round_outward_to_even() {
        assert_eq!(even_floor(3.3), 2);
        assert_eq!(even_floor(4.0), 4);
        assert_eq!(even_ceil(40.5), 42);
        assert_eq!(even_ceil(40.0), 40);
    }

    #[test]
    fn swept_bounds_include_the_boxes_at_both_window_ends() {
        let pts = vec![
            (0.0, [0.0, 0.0, 10.0, 10.0]),
            (2.0, [100.0, 0.0, 110.0, 10.0]),
            (4.0, [100.0, 50.0, 110.0, 60.0]),
        ];
        // [1, 3]: half way along both segments, plus the key at 2 between them.
        assert_eq!(swept_bounds(&pts, 1.0, 3.0), [50.0, 0.0, 110.0, 35.0]);
        assert_eq!(bracketing(&pts, 1.0, 3.0).len(), 3);
        assert_eq!(bracketing(&pts, 2.5, 3.0).len(), 2);
        assert_eq!(bracketing(&pts, 5.0, 6.0).len(), 1);
    }

    #[test]
    fn axis_expr_is_a_flat_sum_of_segments() {
        let pts = vec![
            (1.0, [0.0, 0.0, 10.0, 10.0]),
            (2.0, [20.0, 0.0, 30.0, 10.0]),
        ];
        assert_eq!(
            axis_expr(&pts, 0),
            "0.000*lt(t\\,1.000000)+gte(t\\,1.000000)*lt(t\\,2.000000)*(0.000+20.000*(t-1.000000)/1.000000)+20.000*gte(t\\,2.000000)"
        );
        assert_eq!(axis_expr(&pts[..1], 2), "10.000");
    }

    #[test]
    fn crop_windows_snap_to_the_block_grid_inside_the_frame() {
        let s = source();
        assert_eq!(
            crop_window([45.0, 10.0, 95.0, 20.0], 0.0, 30, &s),
            [30, 0, 90, 30]
        );
        assert_eq!(
            crop_window([1170.0, 0.0, 1179.0, 5.0], 30.0, 2, &s),
            [1140, 0, 39, 36]
        );
    }

    #[test]
    fn a_static_solid_mask_is_one_even_drawbox() {
        let m = mask(EditMaskStyle::Solid, &[(1000, [0.1, 0.1, 0.2, 0.05])]);
        let out = video_chain(&[&m], &source(), 60.0, "n0", "src0_0", "k0").unwrap();
        // 117.9..353.7 x 255.6..383.4 rounds out to 116..354 x 254..384.
        assert_eq!(
            out,
            "[n0]drawbox=x=116:y=254:w=238:h=130:color=0x000000:t=fill:enable='gte(t\\,0.983333)*lt(t\\,3.016667)'[src0_0];"
        );
    }

    #[test]
    fn a_moving_solid_mask_scales_and_moves_a_colour_box() {
        let mut m = mask(
            EditMaskStyle::Solid,
            &[(1000, [0.1, 0.1, 0.2, 0.05]), (2000, [0.1, 0.5, 0.2, 0.05])],
        );
        m.color = Some("#ff0000".into());
        let out = video_chain(&[&m], &source(), 60.0, "n0", "src0_0", "k0").unwrap();
        assert!(out.starts_with("color=c=0xFF0000:s=2x2:r=60:d=11.000,scale=w='2*ceil(("));
        assert!(out.contains(":eval=frame[k0k0box];[n0][k0k0box]overlay=x='2*floor(("));
        // The generated box outlives the source by a second; the source's end ends the stream.
        assert!(out.ends_with(
            ":eval=frame:shortest=1:enable='gte(t\\,0.983333)*lt(t\\,3.016667)'[src0_0];"
        ));
    }

    #[test]
    fn a_moving_blur_crops_the_swept_box_and_merges_an_alpha_box() {
        let m = mask(
            EditMaskStyle::Blur,
            &[(1000, [0.1, 0.1, 0.2, 0.05]), (2000, [0.1, 0.5, 0.2, 0.05])],
        );
        let out = video_chain(&[&m], &source(), 60.0, "n0", "src0_0", "k0").unwrap();
        assert!(out.starts_with("[n0]split[k0k0a][k0k0b];[k0k0b]crop="));
        assert!(
            out.contains(",gblur=sigma=28.30:enable='gte(t\\,0.983333)*lt(t\\,3.016667)'[k0k0fx];")
        );
        assert!(out.contains("color=c=black:s="));
        assert!(out.contains("color=c=white:s=2x2:r=60:d=11.000,format=gray,scale=w='"));
        assert!(out.contains("[k0k0fx][k0k0alpha]alphamerge[k0k0fxa];"));
        assert!(out.ends_with(":shortest=1:enable='gte(t\\,0.983333)*lt(t\\,3.016667)'[src0_0];"));
    }

    #[test]
    fn a_static_pixelate_crops_on_the_grid_and_cuts_back_to_the_box() {
        let m = mask(EditMaskStyle::Pixelate, &[(1000, [0.1, 0.1, 0.2, 0.05])]);
        let out = video_chain(&[&m], &source(), 60.0, "n0", "src0_0", "k0").unwrap();
        // 74 px blocks: 117.9..353.7 snaps to 74..370, 255.6..383.4 to 222..444.
        assert!(out.contains("[k0k0b]crop=296:222:74:222,pixelize=w=74:h=74:enable="));
        assert!(
            out.contains(",crop=238:130:42:32[k0k0fx];[k0k0a][k0k0fx]overlay=x=116:y=254:enable=")
        );
    }

    #[test]
    fn masks_on_one_source_chain_in_order() {
        let a = mask(EditMaskStyle::Solid, &[(1000, [0.1, 0.1, 0.2, 0.05])]);
        let mut b = a.clone();
        b.id = "m2".into();
        let out = video_chain(&[&a, &b], &source(), 60.0, "n0", "m0", "k0").unwrap();
        assert!(out.contains("[n0]drawbox="));
        assert!(out.contains("[k0m0];[k0m0]drawbox="));
        assert!(out.ends_with("[m0];"));
    }

    #[test]
    fn a_still_is_always_on_in_four_four_four() {
        let mut s = source();
        s.kind = EditSourceKind::Image;
        let m = mask(EditMaskStyle::Blur, &[(0, [0.1, 0.1, 0.2, 0.05])]);
        let out = image_chain(&[&m], &s, "1:v", "im1", "i1").unwrap();
        assert!(out.starts_with("[1:v]format=yuv444p[i1444];[i1444]split[i1k0a][i1k0b];"));
        assert!(out.contains(",gblur=sigma=28.30,crop="));
        assert!(out.ends_with("overlay=x=116:y=254:format=yuv444[im1];"));
        assert!(!out.contains("enable"));
    }

    fn doc_with(masks: &[EditMask]) -> EditDoc {
        EditDoc {
            version: 2,
            name: "cut".into(),
            sources: vec![source()],
            settings: crate::edit::EditSettings {
                width: 1179,
                height: 2556,
                fps: 60.0,
            },
            clips: Vec::new(),
            taps: Vec::new(),
            tap_style: None,
            tap_color: None,
            tap_size: None,
            masks: masks.to_vec(),
            reference: None,
        }
    }

    #[test]
    fn validation_refuses_what_cannot_render_exactly() {
        let mut doc_masks = vec![mask(EditMaskStyle::Solid, &[])];
        let check = |masks: &Vec<EditMask>| validate_masks(&doc_with(masks));
        assert!(check(&doc_masks).unwrap_err().contains("no keyframes"));
        doc_masks[0].keys.push(EditMaskKey {
            source_ms: 0,
            rect: [f64::NAN, 0.0, 0.1, 0.1],
        });
        assert!(check(&doc_masks).unwrap_err().contains("invalid box"));
        doc_masks[0].keys[0].rect = [0.0, 0.0, 0.1, 0.1];
        doc_masks[0].end_ms = doc_masks[0].start_ms;
        assert!(check(&doc_masks).unwrap_err().contains("empty time span"));
        doc_masks[0].end_ms = 3000;
        doc_masks[0].color = Some("black".into());
        assert!(check(&doc_masks).is_err());
        doc_masks[0].color = None;
        assert!(check(&doc_masks).is_ok());
    }

    /// Renders seeded noisy `testsrc2` (busy everywhere, so a blur visibly changes every covered pixel) through `[n0]<chain>[out]` with the dev sidecar and returns gray frames.
    fn render_gray(chain: &str, w: u32, h: u32) -> Vec<Vec<u8>> {
        let ffmpeg = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/bin/ffmpeg-aarch64-apple-darwin"
        );
        let graph = format!("[0:v]fps=30:start_time=0[n0];{chain}");
        let out = std::process::Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
            .arg(format!("testsrc2=s={w}x{h}:r=30:d=2,noise=alls=60:allf=t"))
            .args([
                "-filter_complex",
                graph.trim_end_matches(';'),
                "-map",
                "[out]",
            ])
            .args(["-f", "rawvideo", "-pix_fmt", "gray", "-"])
            .output()
            .expect("run the ffmpeg sidecar (pnpm setup:ffmpeg)");
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let frame = (w * h) as usize;
        assert_eq!(out.stdout.len() % frame, 0);
        out.stdout.chunks(frame).map(<[u8]>::to_vec).collect()
    }

    #[test]
    #[ignore = "runs the dev ffmpeg sidecar (pnpm setup:ffmpeg)"]
    fn rendered_masks_cover_every_frame_of_their_box_and_nothing_else() {
        let (w, h) = (320u32, 240u32);
        let mut s = source();
        s.width = w;
        s.height = h;
        s.fps = 30.0;
        s.duration_ms = 2000;
        let moving = [
            (500, [0.0123, 0.1, 0.2, 0.15]),
            (1500, [0.613, 0.57, 0.31, 0.21]),
        ];
        let still = [(900, [0.3071, 0.4113, 0.1937, 0.1291])];
        let plain = render_gray("[n0]null[out];", w, h);
        let styles = [
            EditMaskStyle::Solid,
            EditMaskStyle::Blur,
            EditMaskStyle::Pixelate,
        ];
        for (style, keys) in styles
            .iter()
            .flat_map(|&st| [(st, &moving[..]), (st, &still[..])])
        {
            let mut m = mask(style, keys);
            m.start_ms = 310;
            m.end_ms = 1690;
            let chain = video_chain(&[&m], &s, 30.0, "n0", "out", "k0").unwrap();
            let masked = render_gray(&chain, w, h);
            assert_eq!(masked.len(), plain.len());
            let points = key_points(&m, &s);
            let (a, b) = (0.31 - 1.0 / 30.0, 1.69 + 1.0 / 30.0);
            for (k, (got, base)) in masked.iter().zip(&plain).enumerate() {
                let t = k as f64 / 30.0;
                let active = t >= a && t < b;
                let e = edges_at(&points, t);
                let (ox0, oy0) = (even_floor(e[0]) - 2, even_floor(e[1]) - 2);
                let (ox1, oy1) = (even_ceil(e[2]) + 2, even_ceil(e[3]) + 2);
                let mut changed = 0usize;
                let mut inside = 0usize;
                for y in 0..h as i64 {
                    for x in 0..w as i64 {
                        let i = (y as u32 * w + x as u32) as usize;
                        let fully_inside = active
                            && x as f64 >= e[0].ceil()
                            && (x as f64) < e[2].floor()
                            && y as f64 >= e[1].ceil()
                            && (y as f64) < e[3].floor();
                        let outside = !active || x < ox0 || x >= ox1 || y < oy0 || y >= oy1;
                        if outside {
                            assert_eq!(got[i], base[i], "{style:?} frame {k} leaked at {x},{y}");
                        }
                        if fully_inside {
                            inside += 1;
                            if style == EditMaskStyle::Solid {
                                assert!(got[i] <= 20, "{style:?} frame {k} uncovered at {x},{y}");
                            } else if got[i] != base[i] {
                                changed += 1;
                            }
                        }
                    }
                }
                if style != EditMaskStyle::Solid && inside > 0 {
                    assert!(
                        changed * 10 >= inside * 7,
                        "{style:?} frame {k} barely obscured"
                    );
                }
            }
        }
    }
}
