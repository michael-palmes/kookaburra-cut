//! What ffmpeg may open. Project, library and pack bytes are untrusted, whatever their names say, so every lane that reads them takes its arguments from this table: a local file only, the demuxers and decoders the app supports. Refusing changes no pixel of a file that opens. The frame pipe and our own image sequences keep their forced `-f` and sit in `OWN_INPUT_LANES` below.

use std::path::Path;

/// Never a playlist or concat demuxer, which read other files on the disk.
pub(crate) const AV_DEMUXERS: &str = "mov,matroska,avi,mpegts,mp3,wav,aiff,flac,ogg,aac,caf";
/// ffmpeg opens most JPEGs as image2, and only an image extension reaches it.
const STILL_DEMUXERS: &str = "png_pipe,jpeg_pipe,webp_pipe,apng,gif,image2";
/// ffmpeg's decoder names, not its codec names (mp3 decodes as mp3float). ffprobe opens every stream, so the subtitles and cover art a video carries are listed too; the lanes never decode them.
pub(crate) const AV_DECODERS: &str = "h264,hevc,prores,av1,libdav1d,vp8,vp9,mpeg4,mpeg2video,mpeg1video,mjpeg,dnxhd,qtrle,png,rawvideo,\
aac,alac,mp3float,mp3,mp2float,mp2,flac,opus,libopus,vorbis,libvorbis,ac3,eac3,amrnb,amrwb,adpcm_ima_qt,adpcm_ms,\
pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_u8,pcm_alaw,pcm_mulaw,\
mov_text,webvtt,cc_dec";
const STILL_DECODERS: &str = "png,apng,mjpeg,webp,gif";

const STILL_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

fn is_still(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| STILL_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
}

/// The whitelist for `path`, chosen by its extension; ffmpeg reads it as an option of the next `-i` alone.
pub(crate) fn untrusted_input_args(path: &Path) -> Vec<String> {
    let (demuxers, decoders) = if is_still(path) {
        (STILL_DEMUXERS, STILL_DECODERS)
    } else {
        (AV_DEMUXERS, AV_DECODERS)
    };
    [
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        demuxers,
        "-codec_whitelist",
        decoders,
    ]
    .map(String::from)
    .to_vec()
}

/// The whitelist then `-i path`, the only way an ffmpeg lane opens an untrusted file.
pub(crate) fn untrusted_input(path: &Path) -> Vec<String> {
    let mut args = untrusted_input_args(path);
    args.push("-i".into());
    args.push(path.to_string_lossy().into_owned());
    args
}

/// The one line a person reads when ffmpeg refuses a file on the table.
pub(crate) fn refusal(stderr: &str) -> Option<&'static str> {
    stderr
        .contains("not on whitelist")
        .then_some("Kookaburra Cut doesn't open this kind of file, whatever its name says")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    /// Lanes that read our own bytes, by file: the raw frame pipes, the mezzanine, our image sequences, the frame just read back from the canvas. A new `-i` anywhere else fails `every_lane_takes_the_table`.
    const OWN_INPUT_LANES: [(&str, usize); 5] = [
        ("conform.rs", 2),
        ("clip_cache.rs", 1),
        ("edit.rs", 1),
        ("encode.rs", 3),
        ("media.rs", 1),
    ];

    fn source_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                source_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// A file's code above its test module.
    fn production(source: &str) -> &str {
        let mut at = 0;
        for line in source.split_inclusive('\n') {
            if line.trim() == "#[cfg(test)]" {
                let next = source[at + line.len()..].lines().next().unwrap_or("");
                if next.trim_end().ends_with('{') {
                    return &source[..at];
                }
            }
            at += line.len();
        }
        source
    }

    fn is_doc_or_comment(line: &str) -> bool {
        line.trim_start().starts_with("//")
    }

    #[test]
    fn every_lane_takes_the_table() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        source_files(&root, &mut files);
        assert!(files.len() > 20, "the walk should reach the crate");
        for file in files {
            let name = file.file_name().unwrap().to_string_lossy().into_owned();
            if name == "media_input.rs" || name.ends_with("tests.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&file).unwrap();
            let code = production(&text);
            let lines: Vec<&str> = code.lines().filter(|l| !is_doc_or_comment(l)).collect();
            let inputs = lines.iter().filter(|l| l.contains("\"-i\"")).count();
            let own = OWN_INPUT_LANES
                .iter()
                .find(|(f, _)| *f == name)
                .map_or(0, |(_, n)| *n);
            assert_eq!(
                inputs,
                own,
                "{}: an ffmpeg input goes through media_input::untrusted_input; only our own bytes may list their own -i",
                file.display()
            );
            for (i, line) in lines.iter().enumerate() {
                let spawns_probe = ((line.contains("sidecar_command(")
                    || line.contains("run_capture("))
                    && line.contains("ffprobe"))
                    || line.contains("\"ffprobe\",")
                    || (line.trim() == "ffprobe,"
                        && lines[..i]
                            .last()
                            .is_some_and(|l| l.contains("run_capture(")));
                if !spawns_probe {
                    continue;
                }
                let lane = lines[i.saturating_sub(12)..lines.len().min(i + 8)].join("\n");
                assert!(
                    lane.contains("probe_args(")
                        || lane.contains("untrusted_input_args(")
                        || lane.contains("\"-version\""),
                    "{}: an ffprobe lane takes media_input::untrusted_input_args: {line}",
                    file.display()
                );
            }
        }
    }

    #[test]
    fn kb_and_the_app_read_the_same_containers() {
        let kit = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.agents/skills/kookaburra-scene-authoring/scripts/kblib/media_input.py");
        let text = std::fs::read_to_string(kit).unwrap();
        let line = text.lines().find(|l| l.starts_with("DEMUXERS = ")).unwrap();
        let names: Vec<&str> = line.split('"').skip(1).step_by(2).collect();
        assert_eq!(names.join(","), AV_DEMUXERS);
    }

    #[test]
    fn the_table_picks_the_list_by_extension() {
        let av = untrusted_input_args(Path::new("/p/clip.MP4"));
        assert_eq!(av[..2], ["-protocol_whitelist", "file,pipe"]);
        assert!(av[3].contains("mov") && !av[3].contains("image2"));
        for playlist in [
            "concat", "ffconcat", "hls", "dash", "image2", "lavfi", "data", "tty",
        ] {
            for list in [AV_DEMUXERS, STILL_DEMUXERS] {
                assert!(
                    !list.split(',').any(|d| d == playlist)
                        || (playlist == "image2" && list == STILL_DEMUXERS),
                    "{playlist} must stay off {list}"
                );
            }
        }
        let still = untrusted_input_args(Path::new("/p/shot.JPG"));
        assert!(still[3].contains("image2") && !still[3].contains("mov"));
        let input = untrusted_input(Path::new("/p/a.mp3"));
        assert_eq!(input[input.len() - 2..], ["-i", "/p/a.mp3"]);
    }

    #[test]
    fn a_refusal_reads_as_one_line_and_nothing_else_does() {
        assert!(refusal("Format not on whitelist 'mov'\nx.mp3: Invalid argument").is_some());
        assert!(refusal("[mov_text @ 0x1] Codec (mov_text) not on whitelist 'h264'").is_some());
        assert!(refusal("x.mp4: Invalid data found when processing input").is_none());
    }

    fn tool(name: &str) -> Option<PathBuf> {
        let bin = Path::new(env!("CARGO_MANIFEST_DIR")).join("bin");
        let path = bin.join(format!("{name}-aarch64-apple-darwin"));
        path.is_file().then_some(path)
    }

    fn make(ffmpeg: &Path, args: &[&str], out: &Path) {
        let status = Command::new(ffmpeg)
            .args(["-v", "error", "-y", "-nostdin"])
            .args(args)
            .arg(out)
            .stdin(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "could not build {}", out.display());
    }

    fn opens(ffprobe: &Path, ffmpeg: &Path, file: &Path) -> Result<(), String> {
        let probe = Command::new(ffprobe)
            .args(["-v", "error"])
            .args(untrusted_input_args(file))
            .args(["-show_streams", "-show_format", "-of", "json"])
            .arg(file)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        if !probe.status.success() {
            return Err(String::from_utf8_lossy(&probe.stderr).into_owned());
        }
        let decode = Command::new(ffmpeg)
            .args(["-v", "error", "-nostdin"])
            .args(untrusted_input(file))
            .args(["-map", "0:v?", "-map", "0:a?", "-f", "null", "-"])
            .stdin(Stdio::null())
            .output()
            .unwrap();
        if !decode.status.success() {
            return Err(String::from_utf8_lossy(&decode.stderr).into_owned());
        }
        Ok(())
    }

    #[test]
    fn every_supported_kind_opens_and_a_playlist_is_refused() {
        let (Some(ffmpeg), Some(ffprobe)) = (tool("ffmpeg"), tool("ffprobe")) else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("kc-media-input-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let picture = ["-f", "lavfi", "-i", "testsrc2=s=64x64:r=30:d=0.2"];
        let tone = ["-f", "lavfi", "-i", "sine=f=440:r=48000:d=0.2"];
        let both: Vec<&str> = picture.iter().chain(tone.iter()).copied().collect();
        for name in ["a.mp4", "a.mov", "a.m4v", "a.webm"] {
            make(&ffmpeg, &both, &dir.join(name));
        }
        for name in ["a.mp3", "a.wav", "a.m4a", "a.aac", "a.flac", "a.ogg"] {
            make(&ffmpeg, &tone, &dir.join(name));
        }
        for name in ["a.png", "a.jpg", "a.jpeg"] {
            let mut args = picture.to_vec();
            args.extend(["-frames:v", "1"]);
            make(&ffmpeg, &args, &dir.join(name));
        }
        make(&ffmpeg, &picture, &dir.join("a.gif"));
        // A 1x1 lossless WebP: the dev sidecar has no WebP encoder.
        std::fs::write(
            dir.join("a.webp"),
            [
                0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
                0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00, 0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11,
                0x11, 0x88, 0x88, 0xfe, 0x07, 0x00,
            ],
        )
        .unwrap();
        std::fs::write(
            dir.join("captions.srt"),
            "1\n00:00:00,000 --> 00:00:01,000\nhi\n",
        )
        .unwrap();
        make(
            &ffmpeg,
            &[
                "-i",
                dir.join("a.mp4").to_str().unwrap(),
                "-i",
                dir.join("captions.srt").to_str().unwrap(),
                "-map",
                "0",
                "-map",
                "1",
                "-c",
                "copy",
                "-c:s",
                "mov_text",
            ],
            &dir.join("captioned.mp4"),
        );
        make(
            &ffmpeg,
            &[
                "-i",
                dir.join("a.mp3").to_str().unwrap(),
                "-i",
                dir.join("a.jpg").to_str().unwrap(),
                "-map",
                "0",
                "-map",
                "1",
                "-c",
                "copy",
                "-disposition:v",
                "attached_pic",
            ],
            &dir.join("cover.mp3"),
        );
        for name in [
            "a.mp4",
            "a.mov",
            "a.m4v",
            "a.webm",
            "a.mp3",
            "a.wav",
            "a.m4a",
            "a.aac",
            "a.flac",
            "a.ogg",
            "a.png",
            "a.jpg",
            "a.jpeg",
            "a.gif",
            "a.webp",
            "captioned.mp4",
            "cover.mp3",
        ] {
            let file = dir.join(name);
            assert_eq!(
                opens(&ffprobe, &ffmpeg, &file),
                Ok(()),
                "{name} should open"
            );
        }

        // A real concat list, safe to read, named as a song. Plain ffprobe follows it into the clip.
        let list = "ffconcat version 1.0\nfile a.mp4\n";
        for name in ["list.mp3", "list.mp4", "list.jpg"] {
            let file = dir.join(name);
            std::fs::write(&file, list).unwrap();
            let refused = opens(&ffprobe, &ffmpeg, &file).expect_err("a playlist must not open");
            assert!(refusal(&refused).is_some(), "{name}: {refused}");
        }
        let followed = Command::new(&ffprobe)
            .args(["-v", "error", "-show_streams", "-of", "json"])
            .arg(dir.join("list.mp3"))
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(
            followed.status.success(),
            "the unguarded probe follows the list, so the refusal above is the table's"
        );

        // A file's name decides its list, so a picture named as a clip is refused too.
        std::fs::copy(dir.join("a.png"), dir.join("picture.mp4")).unwrap();
        let refused = opens(&ffprobe, &ffmpeg, &dir.join("picture.mp4"))
            .expect_err("the list follows the name");
        assert!(refusal(&refused).is_some(), "{refused}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
