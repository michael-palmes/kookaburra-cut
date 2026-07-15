//! The export argv layer: codecs, the audio graph, and the two argv families; `legacy_export_args` is TODAY'S construction extracted VERBATIM from `start_export` and byte-pinned by the goldens below, the frozen-path rule that an `ExportOptions` without an `EncodeSpec` must produce that exact `Vec<String>` forever so the standing baselines and Verify never see the preset machinery.

use serde::Deserialize;

/// Export encoder: `libx264` (software H.264) is deterministic and the default; the Apple hardware encoder is faster but its bit-exactness run-to-run is unconfirmed, and `prores_ks` is ffmpeg's software ProRes encoder, exported as 422 HQ in a `.mov`.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub(crate) enum Codec {
    #[default]
    #[serde(rename = "libx264")]
    Libx264,
    #[serde(rename = "h264_videotoolbox")]
    Videotoolbox,
    #[serde(rename = "prores_ks")]
    ProresKs,
}

impl Codec {
    /// Audio encoder per container: AAC 192k in .mp4, uncompressed 16-bit PCM in .mov; AAC's run-to-run determinism is proven by the Verify ×2 gate, not assumed (recorded contingency: cache-encode once + stream-copy).
    pub(crate) fn audio_encoder_args(self) -> Vec<String> {
        match self {
            Codec::Libx264 | Codec::Videotoolbox => vec![
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                "192k".into(),
            ],
            Codec::ProresKs => vec!["-c:a".into(), "pcm_s16le".into()],
        }
    }

    pub(crate) fn encoder_args(self) -> Vec<String> {
        match self {
            // crf 18 ≈ visually lossless; medium preset is a reasonable speed/size balance.
            Codec::Libx264 => vec![
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "medium".into(),
                "-crf".into(),
                "18".into(),
            ],
            Codec::Videotoolbox => vec!["-c:v".into(), "h264_videotoolbox".into()],
            // Profile 3 = ProRes 422 HQ; the vendor tag is pinned so the bitstream can't drift if a future ffmpeg changes its default.
            Codec::ProresKs => vec![
                "-c:v".into(),
                "prores_ks".into(),
                "-profile:v".into(),
                "3".into(),
                "-vendor".into(),
                "apl0".into(),
            ],
        }
    }

    /// Encoder-side pixel format: H.264 stays broadly-playable 8-bit 4:2:0; ProRes 422 HQ is 10-bit 4:2:2 by definition.
    pub(crate) fn pix_fmt(self) -> &'static str {
        match self {
            Codec::Libx264 | Codec::Videotoolbox => "yuv420p",
            Codec::ProresKs => "yuv422p10le",
        }
    }

    /// Output container extension. ProRes lives in QuickTime `.mov`.
    pub(crate) fn container_ext(self) -> &'static str {
        match self {
            Codec::Libx264 | Codec::Videotoolbox => "mp4",
            Codec::ProresKs => "mov",
        }
    }
}

fn default_aspect() -> String {
    "16x9".into()
}

/// Export request from the frontend: width/height/fps drive the rawvideo demuxer, `total_frames` lets the UI render a progress bar, and `aspect` (a filename-safe label like "9x16") distinguishes per-format outputs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportOptions {
    pub(crate) project_id: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) fps: u32,
    pub(crate) total_frames: u32,
    #[serde(default = "default_aspect")]
    pub(crate) aspect: String,
    #[serde(default)]
    pub(crate) codec: Codec,
    /// Workspace project slug: present → output goes to `<workspace>/<slug>/exports/`; absent (bundled/gate projects) → the legacy `~/Kookaburra Cut/<project>/` path.
    #[serde(default)]
    pub(crate) project_slug: Option<String>,
    /// Per-project music track: `None` → the `-an` argv is byte-for-byte the pre-audio build, so every no-audio baseline stays EQUAL.
    #[serde(default)]
    pub(crate) audio: Option<AudioOptions>,
    /// The resolved encode (a preset or the Custom panel); `None` → THE FROZEN PATH: `legacy_export_args`, byte-pinned, and presets never touch baselines.
    #[serde(default)]
    pub(crate) encode: Option<EncodeSpec>,
    /// Output filename suffix: preset/custom exports write `<project>-<aspect>-<suffix>.<ext>` so they never overwrite the legacy `<project>-<aspect>` file; absent = today's exact name (the frozen path and Verify never carry one), slug-validated in `start_export`.
    #[serde(default)]
    pub(crate) output_suffix: Option<String>,
}

/// The project soundtrack, resolved by the frontend to an absolute path (the `extract_clip_frames` precedent - argv structure stays Rust-owned).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioOptions {
    pub(crate) file: String,
    #[serde(default)]
    pub(crate) gain_db: f64,
    #[serde(default)]
    pub(crate) fade_in_ms: u64,
    #[serde(default)]
    pub(crate) fade_out_ms: u64,
    #[serde(default)]
    pub(crate) start_offset_ms: u64,
}

/// The soundtrack's audio sample rate, fixed so sample counts are exact integers per frame (48000/60fps = 800); changing it is an audio-baseline rebase.
pub(crate) const AUDIO_RATE: u64 = 48_000;

/// Builds the sample-exact `-af` filter graph: trim the offset, apply gain, pad-or-cut to EXACTLY the video's sample count (never `-shortest`, muxer interleaving heuristics aren't a duration contract), then the fades; all numbers are integer samples or fixed-decimal seconds derived from integer ms so the string never floats between runs, fades use `curve=qsin` (quarter-sine, the perceptually even "smooth" fade that the preview envelope mirrors), and the fade-out anchors at the TIMELINE's end (the padded/cut sample count), never the track's.
pub(crate) fn audio_filter_graph(
    audio: &AudioOptions,
    total_frames: u32,
    fps: u32,
) -> Result<String, String> {
    audio_filter_graph_gained(audio, total_frames, fps, 0.0)
}

/// The graph with an EXTRA gain (the loudness delta) summed with the author's gain into the ONE `volume=` slot; `extra_db = 0.0` emits byte-for-byte the legacy string (the goldens above prove it), so the frozen path is untouched.
pub(crate) fn audio_filter_graph_gained(
    audio: &AudioOptions,
    total_frames: u32,
    fps: u32,
    extra_db: f64,
) -> Result<String, String> {
    if fps == 0 || AUDIO_RATE % (fps as u64) != 0 {
        return Err(format!(
            "audio requires an integer samples-per-frame (rate {AUDIO_RATE} / fps {fps})"
        ));
    }
    let n_samples = (total_frames as u64) * (AUDIO_RATE / fps as u64);
    let mut parts: Vec<String> = vec![
        format!("aformat=sample_fmts=fltp:sample_rates={AUDIO_RATE}:channel_layouts=stereo"),
        format!("atrim=start_sample={}", audio.start_offset_ms * AUDIO_RATE / 1000),
        "asetpts=PTS-STARTPTS".into(),
    ];
    let gain_db = audio.gain_db + extra_db;
    if gain_db != 0.0 {
        parts.push(format!("volume={:.2}dB", gain_db));
    }
    parts.push(format!("apad=whole_len={n_samples}"));
    parts.push(format!("atrim=end_sample={n_samples}"));
    parts.push("asetpts=PTS-STARTPTS".into());
    if audio.fade_in_ms > 0 {
        parts.push(format!(
            "afade=t=in:st=0:d={:.3}:curve=qsin",
            audio.fade_in_ms as f64 / 1000.0
        ));
    }
    if audio.fade_out_ms > 0 {
        let out_s = audio.fade_out_ms as f64 / 1000.0;
        let total_s = n_samples as f64 / AUDIO_RATE as f64;
        parts.push(format!(
            "afade=t=out:st={:.6}:d={:.3}:curve=qsin",
            (total_s - out_s).max(0.0),
            out_s
        ));
    }
    Ok(parts.join(","))
}

/// TODAY'S export argv, extracted VERBATIM from `start_export` and pinned byte-for-byte by `legacy_argv_goldens` below; the frozen-path rule is that an export without an `EncodeSpec` runs THIS exact vector, so any edit here is a deliberate baseline rebase of every standing project.
pub(crate) fn legacy_export_args(
    options: &ExportOptions,
    output_path: &str,
) -> Result<Vec<String>, String> {
    let size = format!("{}x{}", options.width, options.height);
    let fps = options.fps.to_string();
    // gl.readPixels gives bottom-up rows, so vflip; output pixel format is codec-dependent (see `Codec::pix_fmt`), and the `bitexact` flags + `-map_metadata -1` strip the muxer's wall-clock creation_time and encoder version tag, which would otherwise differ run-to-run and defeat the byte-identical threshold.
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgba".into(),
        "-s".into(),
        size,
        "-r".into(),
        fps.clone(),
        "-i".into(),
        "pipe:0".into(),
    ];
    if let Some(audio) = &options.audio {
        args.extend(["-i".into(), audio.file.clone()]);
    }
    args.extend(["-vf".into(), "vflip".into()]);
    match &options.audio {
        None => args.push("-an".into()),
        Some(audio) => {
            args.extend([
                "-map".into(),
                "0:v".into(),
                "-map".into(),
                "1:a:0".into(),
                "-af".into(),
                audio_filter_graph(audio, options.total_frames, options.fps)?,
            ]);
            args.extend(options.codec.audio_encoder_args());
            args.extend(["-flags:a".into(), "+bitexact".into()]);
        }
    }
    args.extend(options.codec.encoder_args());
    args.extend([
        "-pix_fmt".into(),
        options.codec.pix_fmt().into(),
        "-r".into(),
        fps,
        "-flags:v".into(),
        "+bitexact".into(),
        "-fflags".into(),
        "+bitexact".into(),
        "-map_metadata".into(),
        "-1".into(),
        output_path.to_string(),
    ]);
    Ok(args)
}


// The EncodeSpec argv family: the FRONTEND resolves a preset/custom into a fully-resolved spec (the registry stays in TS like themes), Rust builds argv from the spec only, and every lane below is pinned by `spec_argv_goldens` - the strings are the contract.

/// Video encoder for the spec family: software x264/x265 are deterministic; the VideoToolbox lanes are "fast drafts" (excluded from Verify by policy).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub(crate) enum EncodeCodec {
    #[serde(rename = "libx264")]
    Libx264,
    #[serde(rename = "libx265")]
    Libx265,
    #[serde(rename = "h264_videotoolbox")]
    H264Videotoolbox,
    #[serde(rename = "hevc_videotoolbox")]
    HevcVideotoolbox,
    #[serde(rename = "prores_ks")]
    ProresKs,
}

impl EncodeCodec {
    pub(crate) fn container_ext(self) -> &'static str {
        match self {
            EncodeCodec::ProresKs => "mov",
            _ => "mp4",
        }
    }
    fn is_hevc(self) -> bool {
        matches!(self, EncodeCodec::Libx265 | EncodeCodec::HevcVideotoolbox)
    }
    fn is_videotoolbox(self) -> bool {
        matches!(
            self,
            EncodeCodec::H264Videotoolbox | EncodeCodec::HevcVideotoolbox
        )
    }
}

/// Rate control: constant quality or capped bitrate (VBV), optionally two-pass.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum RateControl {
    #[serde(rename_all = "camelCase")]
    Bitrate {
        target_kbps: u32,
        max_kbps: u32,
        bufsize_kbps: u32,
        #[serde(default)]
        two_pass: bool,
    },
    Crf { crf: u32 },
}

/// Audio encode for the spec family: `None` on the spec = follow the project (aac/pcm by container, exactly the legacy lane); PCM is resolve-time rejected outside .mov.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum EncodeAudioCodec {
    #[serde(rename_all = "camelCase")]
    Aac { aac_kbps: u32 },
    #[serde(rename_all = "camelCase")]
    Pcm { pcm_bits: u32 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EncodeAudio {
    pub(crate) codec: EncodeAudioCodec,
    /// The loudness delta (target − measured), summed with the author's project gain into the ONE `volume=` slot; 2 dp, matching the filter's formatting.
    #[serde(default)]
    pub(crate) loudness_gain_db: f64,
}

/// A fully-resolved encode (what a preset or the Custom panel produces); absent on `ExportOptions` ⇒ the frozen legacy path.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EncodeSpec {
    pub(crate) codec: EncodeCodec,
    /// Scale so the SHORT edge lands here (aspect preserved, even dims, never upscale).
    #[serde(default)]
    pub(crate) scale_short_edge_to: Option<u32>,
    /// Output fps: the frontend renders AT this rate (render-at-output-fps), so `in_fps == fps` and the chain passes through; the `fps=` decimation branch stays as defence for any input that outpaces it.
    pub(crate) fps: u32,
    pub(crate) rate: RateControl,
    #[serde(default)]
    pub(crate) profile: Option<String>,
    #[serde(default)]
    pub(crate) level: Option<String>,
    /// Keyframe interval in seconds (`-g` = round(outFps × gop)).
    #[serde(default)]
    pub(crate) gop_seconds: Option<f64>,
    #[serde(default)]
    pub(crate) b_frames: Option<u32>,
    /// x264 only: "cabac" | "cavlc" (`-coder`).
    #[serde(default)]
    pub(crate) entropy: Option<String>,
    #[serde(default)]
    pub(crate) ten_bit: bool,
    #[serde(default)]
    pub(crate) faststart: bool,
    /// Write bt709 tags AND perform the RGB→YUV conversion with the bt709 matrix at the scale filter (untagged swscale defaults to bt601 on raw RGBA input).
    #[serde(default)]
    pub(crate) colour_tags: bool,
    #[serde(default)]
    pub(crate) audio: Option<EncodeAudio>,
}

impl EncodeSpec {
    pub(crate) fn two_pass(&self) -> bool {
        matches!(self.rate, RateControl::Bitrate { two_pass: true, .. })
    }

    /// Output frame count after fps decimation (ceil on odd totals, frame 0 always survives `fps=30`'s keep-every-second-frame pattern).
    pub(crate) fn out_frames(&self, total_frames: u32, in_fps: u32) -> u32 {
        if self.fps >= in_fps {
            total_frames
        } else {
            ((total_frames as u64 * self.fps as u64).div_ceil(in_fps as u64)) as u32
        }
    }

    fn pix_fmt(&self) -> &'static str {
        match self.codec {
            EncodeCodec::ProresKs => "yuv422p10le",
            EncodeCodec::Libx265 if self.ten_bit => "yuv420p10le",
            _ => "yuv420p",
        }
    }

    /// The pinned vf chain: `vflip[,fps=N][,scale lanczos]` (+ the bt709 matrix WHEN tagging, since the conversion happens at the scale/format filter so what the tags declare is what the pixels are); the `fps=` decimation only fires when the input outpaces the spec, and since the app renders at the output rate the shipped lanes never carry it.
    pub(crate) fn vf_chain(&self, in_width: u32, in_height: u32, in_fps: u32) -> String {
        let mut parts: Vec<String> = vec!["vflip".into()];
        if self.fps < in_fps {
            parts.push(format!("fps={}", self.fps));
        }
        let (w, h) = self.out_dims(in_width, in_height);
        if self.colour_tags {
            // Same-size scale still performs the format conversion (out format differs), so the bt709 matrix applies even without a resize.
            parts.push(format!(
                "scale={w}:{h}:flags=lanczos:out_color_matrix=bt709,format={}",
                self.pix_fmt()
            ));
        } else if (w, h) != (in_width, in_height) {
            parts.push(format!("scale={w}:{h}:flags=lanczos"));
        }
        parts.join(",")
    }

    /// Output dimensions: short edge to `scale_short_edge_to`, aspect preserved, rounded to even, never upscaled.
    pub(crate) fn out_dims(&self, w: u32, h: u32) -> (u32, u32) {
        let Some(target) = self.scale_short_edge_to else {
            return (w, h);
        };
        let short = w.min(h);
        if target >= short {
            return (w, h);
        }
        let even = |v: f64| -> u32 { ((v / 2.0).round() as u32) * 2 };
        let f = target as f64 / short as f64;
        (even(w as f64 * f), even(h as f64 * f))
    }

    /// Encoder args for this lane (rate control included; pass flags live in `transcode_pass_args`, stage concerns never leak in here).
    fn encoder_args(&self) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        match self.codec {
            EncodeCodec::Libx264 => {
                args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "medium".into()]);
            }
            EncodeCodec::Libx265 => {
                args.extend(["-c:v".into(), "libx265".into(), "-preset".into(), "medium".into()]);
            }
            EncodeCodec::H264Videotoolbox => {
                args.extend(["-c:v".into(), "h264_videotoolbox".into()]);
            }
            EncodeCodec::HevcVideotoolbox => {
                args.extend(["-c:v".into(), "hevc_videotoolbox".into()]);
            }
            EncodeCodec::ProresKs => {
                args.extend([
                    "-c:v".into(),
                    "prores_ks".into(),
                    "-profile:v".into(),
                    "3".into(),
                    "-vendor".into(),
                    "apl0".into(),
                ]);
            }
        }
        match &self.rate {
            RateControl::Crf { crf } => {
                if !matches!(self.codec, EncodeCodec::ProresKs) {
                    args.extend(["-crf".into(), crf.to_string()]);
                }
            }
            RateControl::Bitrate { target_kbps, max_kbps, bufsize_kbps, .. } => {
                args.extend(["-b:v".into(), format!("{target_kbps}k")]);
                if !self.codec.is_videotoolbox() {
                    args.extend([
                        "-maxrate".into(),
                        format!("{max_kbps}k"),
                        "-bufsize".into(),
                        format!("{bufsize_kbps}k"),
                    ]);
                    // VBV rate control is NON-DETERMINISTIC under encoder threads (x264's documented behaviour: frames identical, bytes differing per run), so pin the threads on software VBV lanes; the outputs are 1080p-class, so the cost is small.
                    if matches!(self.codec, EncodeCodec::Libx264) {
                        args.extend(["-threads".into(), "1".into()]);
                    }
                }
            }
        }
        if let Some(profile) = &self.profile {
            args.extend(["-profile:v".into(), profile.clone()]);
        }
        if let Some(level) = &self.level {
            args.extend(["-level".into(), level.clone()]);
        }
        if let Some(gop) = self.gop_seconds {
            args.extend(["-g".into(), ((self.fps as f64 * gop).round() as u32).to_string()]);
        }
        if let Some(bf) = self.b_frames {
            args.extend(["-bf".into(), bf.to_string()]);
        }
        if let Some(entropy) = &self.entropy {
            if matches!(self.codec, EncodeCodec::Libx264) {
                args.extend(["-coder".into(), entropy.clone()]);
            }
        }
        if matches!(self.codec, EncodeCodec::Libx265)
            && matches!(self.rate, RateControl::Bitrate { .. })
        {
            args.extend(["-x265-params".into(), "frame-threads=1:pools=1".into()]);
        }
        args
    }

    fn audio_encoder_args(&self) -> Vec<String> {
        match &self.audio {
            Some(EncodeAudio { codec: EncodeAudioCodec::Aac { aac_kbps }, .. }) => vec![
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                format!("{aac_kbps}k"),
            ],
            Some(EncodeAudio { codec: EncodeAudioCodec::Pcm { pcm_bits }, .. }) => {
                vec!["-c:a".into(), format!("pcm_s{pcm_bits}le")]
            }
            None => vec!["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()],
        }
    }

    /// The bt709 container tags, only ever written when the vf chain also performed the conversion with that matrix (the tags never lie about the pixels).
    fn colour_tag_args(&self) -> Vec<String> {
        if !self.colour_tags {
            return Vec::new();
        }
        vec![
            "-color_primaries".into(),
            "bt709".into(),
            "-color_trc".into(),
            "bt709".into(),
            "-colorspace".into(),
            "bt709".into(),
        ]
    }

    fn tail_args(&self, output_path: &str) -> Vec<String> {
        let mut args: Vec<String> = Vec::new();
        if self.codec.is_hevc() && self.codec.container_ext() == "mp4" {
            // Apple players want hvc1, not ffmpeg's default hev1.
            args.extend(["-tag:v".into(), "hvc1".into()]);
        }
        if self.faststart {
            args.extend(["-movflags".into(), "+faststart".into()]);
        }
        args.extend([
            "-flags:v".into(),
            "+bitexact".into(),
            "-fflags".into(),
            "+bitexact".into(),
            "-map_metadata".into(),
            "-1".into(),
            output_path.to_string(),
        ]);
        args
    }
}

/// The SINGLE-PASS spec export: raw RGBA over stdin (the legacy input block verbatim), the pinned vf chain, the spec's encoder lane, tags, tail.
pub(crate) fn spec_export_args(
    options: &ExportOptions,
    spec: &EncodeSpec,
    output_path: &str,
) -> Result<Vec<String>, String> {
    let mut args = raw_input_args(options);
    if let Some(audio) = &options.audio {
        args.extend(["-i".into(), audio.file.clone()]);
    }
    args.extend(["-vf".into(), spec.vf_chain(options.width, options.height, options.fps)]);
    match &options.audio {
        None => args.push("-an".into()),
        Some(audio) => {
            let extra_db = spec.audio.as_ref().map(|a| a.loudness_gain_db).unwrap_or(0.0);
            args.extend([
                "-map".into(),
                "0:v".into(),
                "-map".into(),
                "1:a:0".into(),
                "-af".into(),
                audio_filter_graph_gained(
                    audio,
                    spec.out_frames(options.total_frames, options.fps),
                    spec.fps,
                    extra_db,
                )?,
            ]);
            args.extend(spec.audio_encoder_args());
            args.extend(["-flags:a".into(), "+bitexact".into()]);
        }
    }
    args.extend(spec.encoder_args());
    args.extend(["-pix_fmt".into(), spec.pix_fmt().into()]);
    args.extend(spec.colour_tag_args());
    args.extend(["-r".into(), spec.fps.to_string()]);
    args.extend(spec.tail_args(output_path));
    Ok(args)
}

/// Stage 1 of a two-pass export: render ONCE to a lossless FFV1 mezzanine at the OUTPUT resolution/fps/pix_fmt (the vf chain runs here, so stage 2 re-encodes identical pixels; two-pass over stdin is impossible since pass 1 consumes the stream).
pub(crate) fn mezzanine_render_args(
    options: &ExportOptions,
    spec: &EncodeSpec,
    mezz_path: &str,
) -> Vec<String> {
    let mut args = raw_input_args(options);
    args.extend(["-vf".into(), spec.vf_chain(options.width, options.height, options.fps)]);
    args.extend([
        "-an".into(),
        "-c:v".into(),
        "ffv1".into(),
        "-pix_fmt".into(),
        spec.pix_fmt().into(),
        "-r".into(),
        spec.fps.to_string(),
        "-flags:v".into(),
        "+bitexact".into(),
        "-fflags".into(),
        "+bitexact".into(),
        "-map_metadata".into(),
        "-1".into(),
        mezz_path.to_string(),
    ]);
    args
}

/// One transcode pass over the mezzanine (file-to-file; no vf, the pixels are final); pass 1 analyses to the pass log and throws the video away, and pass 2 writes the real output (audio joins here since analysing it twice buys nothing).
pub(crate) fn transcode_pass_args(
    options: &ExportOptions,
    spec: &EncodeSpec,
    mezz_path: &str,
    output_path: &str,
    pass: u32,
    passlog: &str,
) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec!["-y".into(), "-i".into(), mezz_path.to_string()];
    if pass == 2 {
        if let Some(audio) = &options.audio {
            args.extend(["-i".into(), audio.file.clone()]);
        }
    }
    match (&options.audio, pass) {
        (Some(audio), 2) => {
            let extra_db = spec.audio.as_ref().map(|a| a.loudness_gain_db).unwrap_or(0.0);
            args.extend([
                "-map".into(),
                "0:v".into(),
                "-map".into(),
                "1:a:0".into(),
                "-af".into(),
                audio_filter_graph_gained(
                    audio,
                    spec.out_frames(options.total_frames, options.fps),
                    spec.fps,
                    extra_db,
                )?,
            ]);
            args.extend(spec.audio_encoder_args());
            args.extend(["-flags:a".into(), "+bitexact".into()]);
        }
        _ => args.push("-an".into()),
    }
    args.extend(spec.encoder_args());
    match spec.codec {
        EncodeCodec::Libx264 => {
            args.extend(["-pass".into(), pass.to_string(), "-passlogfile".into(), passlog.into()]);
        }
        EncodeCodec::Libx265 => {
            args.extend([
                "-x265-params".into(),
                format!("pass={pass}:stats={passlog}.x265:frame-threads=1:pools=1"),
            ]);
        }
        _ => return Err("two-pass requires libx264 or libx265".into()),
    }
    args.extend(["-pix_fmt".into(), spec.pix_fmt().into()]);
    args.extend(spec.colour_tag_args());
    args.extend(["-r".into(), spec.fps.to_string()]);
    if pass == 1 {
        // Pass 1's only product is the log; mux nothing.
        args.extend(["-f".into(), "null".into(), "/dev/null".into()]);
    } else {
        args.extend(spec.tail_args(output_path));
    }
    Ok(args)
}

/// The raw RGBA stdin input block, shared by the legacy path, the spec direct path and the mezzanine render (byte-identical to the legacy head by construction).
fn raw_input_args(options: &ExportOptions) -> Vec<String> {
    vec![
        "-y".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgba".into(),
        "-s".into(),
        format!("{}x{}", options.width, options.height),
        "-r".into(),
        options.fps.to_string(),
        "-i".into(),
        "pipe:0".into(),
    ]
}

#[cfg(test)]
mod audio_graph_tests {
    use super::*;

    fn opts(fade_in_ms: u64, fade_out_ms: u64) -> AudioOptions {
        AudioOptions {
            file: "x.mp3".into(),
            gain_db: 0.0,
            fade_in_ms,
            fade_out_ms,
            start_offset_ms: 0,
        }
    }

    /// The exact argv string is a baseline contract; any change here re-records the audio fixtures (docs/determinism.md "Audio").
    #[test]
    fn fades_are_qsin_and_anchor_at_the_timeline_end() {
        // 600 frames @60fps = 10s of video = 480000 samples, regardless of track length.
        let graph = audio_filter_graph(&opts(500, 1000), 600, 60).unwrap();
        assert!(graph.contains("apad=whole_len=480000"));
        assert!(graph.contains("afade=t=in:st=0:d=0.500:curve=qsin"));
        assert!(graph.contains("afade=t=out:st=9.000000:d=1.000:curve=qsin"));
    }

    #[test]
    fn zero_fades_emit_no_afade() {
        let graph = audio_filter_graph(&opts(0, 0), 600, 60).unwrap();
        assert!(!graph.contains("afade"));
    }

    /// A fade longer than the whole timeline clamps its start to 0, never negative.
    #[test]
    fn oversized_fade_out_clamps_to_start() {
        let graph = audio_filter_graph(&opts(0, 20_000), 600, 60).unwrap();
        assert!(graph.contains("afade=t=out:st=0.000000:d=20.000:curve=qsin"));
    }
}

#[cfg(test)]
mod legacy_argv_goldens {
    use super::*;

    fn base_options(codec: Codec, audio: Option<AudioOptions>) -> ExportOptions {
        ExportOptions {
            project_id: "launch-2026".into(),
            width: 3840,
            height: 2160,
            fps: 60,
            total_frames: 600,
            aspect: "16x9".into(),
            codec,
            project_slug: None,
            audio,
            encode: None,
            output_suffix: None,
        }
    }

    /// THE FROZEN PIN: the no-audio libx264 argv, byte-for-byte; every standing baseline was encoded through this exact vector, so a failure here means a deliberate rebase, never a refactor.
    #[test]
    fn libx264_no_audio_is_byte_frozen() {
        let args = legacy_export_args(&base_options(Codec::Libx264, None), "/out/x.mp4").unwrap();
        let expected: Vec<&str> = vec![
            "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "3840x2160", "-r", "60",
            "-i", "pipe:0", "-vf", "vflip", "-an", "-c:v", "libx264", "-preset", "medium",
            "-crf", "18", "-pix_fmt", "yuv420p", "-r", "60", "-flags:v", "+bitexact",
            "-fflags", "+bitexact", "-map_metadata", "-1", "/out/x.mp4",
        ];
        assert_eq!(args, expected);
    }

    /// The audio variant: second input, maps, the -af graph, AAC 192k, audio bitexact, all in this exact order.
    #[test]
    fn libx264_with_audio_is_byte_frozen() {
        let audio = AudioOptions {
            file: "/abs/track.mp3".into(),
            gain_db: -2.0,
            fade_in_ms: 0,
            fade_out_ms: 1000,
            start_offset_ms: 0,
        };
        let args =
            legacy_export_args(&base_options(Codec::Libx264, Some(audio)), "/out/x.mp4").unwrap();
        let graph = concat!(
            "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,",
            "atrim=start_sample=0,asetpts=PTS-STARTPTS,volume=-2.00dB,",
            "apad=whole_len=480000,atrim=end_sample=480000,asetpts=PTS-STARTPTS,",
            "afade=t=out:st=9.000000:d=1.000:curve=qsin"
        );
        let expected: Vec<&str> = vec![
            "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "3840x2160", "-r", "60",
            "-i", "pipe:0", "-i", "/abs/track.mp3", "-vf", "vflip",
            "-map", "0:v", "-map", "1:a:0", "-af", graph,
            "-c:a", "aac", "-b:a", "192k", "-flags:a", "+bitexact",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-r", "60", "-flags:v", "+bitexact",
            "-fflags", "+bitexact", "-map_metadata", "-1", "/out/x.mp4",
        ];
        assert_eq!(args, expected);
    }

    /// ProRes: .mov, pinned vendor tag, PCM audio lane untouched by presets.
    #[test]
    fn prores_no_audio_is_byte_frozen() {
        let args = legacy_export_args(&base_options(Codec::ProresKs, None), "/out/x.mov").unwrap();
        let expected: Vec<&str> = vec![
            "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "3840x2160", "-r", "60",
            "-i", "pipe:0", "-vf", "vflip", "-an", "-c:v", "prores_ks", "-profile:v", "3",
            "-vendor", "apl0", "-pix_fmt", "yuv422p10le", "-r", "60", "-flags:v",
            "+bitexact", "-fflags", "+bitexact", "-map_metadata", "-1", "/out/x.mov",
        ];
        assert_eq!(args, expected);
    }
}

#[cfg(test)]
mod spec_argv_goldens {
    use super::*;

    fn options() -> ExportOptions {
        ExportOptions {
            project_id: "launch-2026".into(),
            width: 3840,
            height: 2160,
            fps: 60,
            total_frames: 600,
            aspect: "16x9".into(),
            codec: Codec::Libx264,
            project_slug: None,
            audio: None,
            encode: None,
            output_suffix: None,
        }
    }

    /// The 30fps lane shape: the frontend renders AT the output rate, so the raw input arrives at 30 with the 30fps frame count already.
    fn options_30fps() -> ExportOptions {
        ExportOptions { fps: 30, total_frames: 300, ..options() }
    }

    fn reels_1080p30() -> EncodeSpec {
        EncodeSpec {
            codec: EncodeCodec::Libx264,
            scale_short_edge_to: Some(1080),
            fps: 30,
            rate: RateControl::Bitrate {
                target_kbps: 12_000,
                max_kbps: 16_000,
                bufsize_kbps: 24_000,
                two_pass: false,
            },
            profile: Some("high".into()),
            level: Some("4.2".into()),
            gop_seconds: Some(2.0),
            b_frames: Some(2),
            entropy: None,
            ten_bit: false,
            faststart: true,
            colour_tags: true,
            audio: None,
        }
    }

    /// The Meta-Reels-class lane: the render arrives AT 30 (no fps filter), the bt709 conversion at the scale filter, tags, VBV, faststart, the whole pinned chain.
    #[test]
    fn x264_scaled_30fps_lane_is_pinned() {
        let args = spec_export_args(&options_30fps(), &reels_1080p30(), "/out/r.mp4").unwrap();
        let expected: Vec<&str> = vec![
            "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "3840x2160", "-r", "30",
            "-i", "pipe:0", "-vf",
            "vflip,scale=1920:1080:flags=lanczos:out_color_matrix=bt709,format=yuv420p",
            "-an", "-c:v", "libx264", "-preset", "medium",
            "-b:v", "12000k", "-maxrate", "16000k", "-bufsize", "24000k",
            "-threads", "1",
            "-profile:v", "high", "-level", "4.2", "-g", "60", "-bf", "2",
            "-pix_fmt", "yuv420p",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
            "-r", "30", "-movflags", "+faststart",
            "-flags:v", "+bitexact", "-fflags", "+bitexact", "-map_metadata", "-1",
            "/out/r.mp4",
        ];
        assert_eq!(args, expected);
    }

    /// HEVC in mp4 carries the Apple hvc1 tag; 10-bit flips the pix_fmt.
    #[test]
    fn x265_ten_bit_gets_hvc1_and_p10() {
        let spec = EncodeSpec {
            codec: EncodeCodec::Libx265,
            scale_short_edge_to: None,
            fps: 60,
            rate: RateControl::Crf { crf: 22 },
            profile: None,
            level: None,
            gop_seconds: None,
            b_frames: None,
            entropy: None,
            ten_bit: true,
            faststart: false,
            colour_tags: false,
            audio: None,
        };
        let args = spec_export_args(&options(), &spec, "/out/h.mp4").unwrap();
        let expected: Vec<&str> = vec![
            "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "3840x2160", "-r", "60",
            "-i", "pipe:0", "-vf", "vflip", "-an",
            "-c:v", "libx265", "-preset", "medium", "-crf", "22",
            "-pix_fmt", "yuv420p10le", "-r", "60", "-tag:v", "hvc1",
            "-flags:v", "+bitexact", "-fflags", "+bitexact", "-map_metadata", "-1",
            "/out/h.mp4",
        ];
        assert_eq!(args, expected);
    }

    /// The two-pass stages: FFV1 mezzanine at OUTPUT res/fps, then the pass argv pair (pass 1 muxes to null; pass 2 writes the real file).
    #[test]
    fn two_pass_stages_are_pinned() {
        let mut spec = reels_1080p30();
        spec.rate = RateControl::Bitrate {
            target_kbps: 10_000,
            max_kbps: 12_000,
            bufsize_kbps: 20_000,
            two_pass: true,
        };
        assert!(spec.two_pass());
        let opts = options_30fps();
        let mezz = mezzanine_render_args(&opts, &spec, "/mezz/m.mkv");
        let expected_mezz: Vec<&str> = vec![
            "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "3840x2160", "-r", "30",
            "-i", "pipe:0", "-vf",
            "vflip,scale=1920:1080:flags=lanczos:out_color_matrix=bt709,format=yuv420p",
            "-an", "-c:v", "ffv1", "-pix_fmt", "yuv420p", "-r", "30",
            "-flags:v", "+bitexact", "-fflags", "+bitexact", "-map_metadata", "-1",
            "/mezz/m.mkv",
        ];
        assert_eq!(mezz, expected_mezz);

        let p1 = transcode_pass_args(&opts, &spec, "/mezz/m.mkv", "/out/t.mp4", 1, "/mezz/log")
            .unwrap();
        assert!(p1.ends_with(&["-f".into(), "null".into(), "/dev/null".into()]));
        assert!(p1.contains(&"-pass".to_string()) && p1.contains(&"1".to_string()));
        let p2 = transcode_pass_args(&opts, &spec, "/mezz/m.mkv", "/out/t.mp4", 2, "/mezz/log")
            .unwrap();
        assert!(p2.ends_with(&["/out/t.mp4".into()]));
        assert!(p2.contains(&"-passlogfile".to_string()));
        // The vf chain must NOT run again over the mezzanine (its pixels are final).
        assert!(!p2.contains(&"-vf".to_string()));
    }

    /// VideoToolbox: bitrate-only (no VBV flags), never two-pass.
    #[test]
    fn videotoolbox_is_bitrate_only() {
        let spec = EncodeSpec {
            codec: EncodeCodec::HevcVideotoolbox,
            scale_short_edge_to: None,
            fps: 60,
            rate: RateControl::Bitrate {
                target_kbps: 20_000,
                max_kbps: 24_000,
                bufsize_kbps: 40_000,
                two_pass: false,
            },
            profile: None,
            level: None,
            gop_seconds: None,
            b_frames: None,
            entropy: None,
            ten_bit: false,
            faststart: true,
            colour_tags: false,
            audio: None,
        };
        let args = spec_export_args(&options(), &spec, "/out/v.mp4").unwrap();
        assert!(args.contains(&"-b:v".to_string()) && args.contains(&"20000k".to_string()));
        assert!(!args.contains(&"-maxrate".to_string()));
        assert!(args.windows(2).any(|w| w == ["-tag:v", "hvc1"]));
    }

    /// The audio lane: OUTPUT-fps sample maths (30fps → 1600 samples/frame) and the loudness delta summed with the author gain into the ONE volume slot.
    #[test]
    fn audio_uses_output_fps_and_summed_gain() {
        let mut opts = options_30fps();
        opts.audio = Some(AudioOptions {
            file: "/abs/track.mp3".into(),
            gain_db: -2.0,
            fade_in_ms: 0,
            fade_out_ms: 0,
            start_offset_ms: 0,
        });
        let mut spec = reels_1080p30();
        spec.audio = Some(EncodeAudio {
            codec: EncodeAudioCodec::Aac { aac_kbps: 128 },
            loudness_gain_db: -1.5,
        });
        let args = spec_export_args(&opts, &spec, "/out/a.mp4").unwrap();
        let af = args[args.iter().position(|a| a == "-af").unwrap() + 1].clone();
        // 300 frames @30 → 300 × 1600 = 480000 samples (sample-exact at the output rate).
        assert!(af.contains("apad=whole_len=480000"), "{af}");
        assert!(af.contains("volume=-3.50dB"), "{af}");
        assert!(args.windows(2).any(|w| w == ["-b:a", "128k"]));
    }

    /// Odd totals ceil (frame 0 survives decimation); dims round to even; the decimation branch is DEFENCE since the app renders at the output rate, pinned here so a faster-than-spec input still decimates correctly.
    #[test]
    fn out_frames_and_dims_maths() {
        let spec = reels_1080p30();
        assert_eq!(spec.out_frames(601, 60), 301);
        assert_eq!(spec.out_frames(300, 30), 300); // pass-through at equal rates
        assert!(spec.vf_chain(3840, 2160, 60).contains("fps=30"));
        assert!(!spec.vf_chain(3840, 2160, 30).contains("fps="));
        assert_eq!(spec.out_dims(3840, 2160), (1920, 1080));
        assert_eq!(spec.out_dims(2160, 2700), (1080, 1350));
        assert_eq!(spec.out_dims(1080, 1350), (1080, 1350)); // never upscale
    }

    /// The spec JSON shape the frontend sends parses (serde field-name pin).
    #[test]
    fn spec_json_parses() {
        let json = r#"{
            "codec": "libx264",
            "scaleShortEdgeTo": 1080,
            "fps": 30,
            "rate": { "targetKbps": 12000, "maxKbps": 16000, "bufsizeKbps": 24000, "twoPass": true },
            "faststart": true,
            "colourTags": true,
            "audio": { "codec": { "aacKbps": 128 }, "loudnessGainDb": -1.5 }
        }"#;
        let spec: EncodeSpec = serde_json::from_str(json).unwrap();
        assert!(spec.two_pass());
        assert_eq!(spec.fps, 30);
        let crf = r#"{ "codec": "libx265", "fps": 60, "rate": { "crf": 22 } }"#;
        let spec: EncodeSpec = serde_json::from_str(crf).unwrap();
        assert!(matches!(spec.rate, RateControl::Crf { crf: 22 }));
    }
}
