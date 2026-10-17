//! Black-box tests of the headless `edit` CLI through the real binary. The `#[ignore]`d ones need the dev ffmpeg sidecar (`pnpm setup:ffmpeg`): `cargo test --test edit_cli -- --ignored`.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_kookaburra-cut");

/// A scratch folder holding a project and a private HOME, so the CLI never reads the real app data.
struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(tag: &str) -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let root = std::env::temp_dir().join(format!(
            "kc-edit-cli-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("project/assets")).unwrap();
        std::fs::create_dir_all(root.join("home")).unwrap();
        std::fs::write(root.join("project/project.json"), "{}").unwrap();
        Self { root }
    }

    fn project(&self) -> PathBuf {
        self.root.join("project")
    }

    fn p(&self) -> String {
        self.project().to_string_lossy().into_owned()
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(BIN);
        cmd.arg("edit")
            .args(args)
            .env("HOME", self.root.join("home"));
        cmd
    }

    /// Run to completion; returns the exit code and every stdout line as JSON.
    fn run(&self, args: &[&str], stdin: Option<&[u8]>) -> (i32, Vec<Value>) {
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        if let Some(bytes) = stdin {
            input.write_all(bytes).unwrap();
        }
        drop(input);
        let out = child.wait_with_output().unwrap();
        let lines = String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("not JSON ({e}): {l}")))
            .collect();
        (out.status.code().unwrap_or(-1), lines)
    }

    /// One-object commands: exactly one stdout line.
    fn one(&self, args: &[&str], stdin: Option<&[u8]>) -> (i32, Value) {
        let (code, mut lines) = self.run(args, stdin);
        assert_eq!(lines.len(), 1, "{args:?} printed {lines:?}");
        (code, lines.remove(0))
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn ffmpeg() -> PathBuf {
    Path::new(BIN).with_file_name("ffmpeg")
}

fn ffmpeg_run(args: &[&str]) {
    let out = Command::new(ffmpeg())
        .args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

/// Decoded frame count of a file (no container shortcuts).
fn decoded_frames(path: &Path) -> u32 {
    let out = Command::new(ffmpeg())
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-map", "0:v", "-f", "null", "-", "-progress", "pipe:1"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("frame="))
        .next_back()
        .and_then(|v| v.trim().parse().ok())
        .unwrap()
}

fn sha256(path: &Path) -> String {
    let out = Command::new("shasum")
        .args(["-a", "256"])
        .arg(path)
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .unwrap()
        .to_owned()
}

#[test]
fn edit_cli_usage_errors_exit_two_with_one_json_line() {
    let sb = Sandbox::new("usage");
    let p = sb.p();
    for args in [
        vec![],
        vec!["bogus"],
        vec!["probe"],
        vec!["create", "--project", "relative"],
        vec!["create", "--project", &p, "--source", "/etc/passwd"],
        vec![
            "save",
            "--project",
            &p,
            "--name",
            "cut",
            "--doc",
            "-",
            "--base",
            "nope",
        ],
        vec!["validate", "--project", &p, "--name", "x", "--stray"],
    ] {
        let (code, line) = sb.one(&args, None);
        assert_eq!(code, 2, "{args:?}: {line}");
        assert_eq!(line["ok"], false);
        assert_eq!(line["code"], "usage");
        assert!(line["error"].as_str().is_some_and(|e| !e.is_empty()));
    }
    let (code, line) = sb.one(&["render", "--project", &p, "--doc", "-"], None);
    assert_eq!(
        (code, &line["event"], &line["code"]),
        (2, &json!("error"), &json!("usage"))
    );
}

#[test]
fn edit_cli_caps_reports_the_contract_keys() {
    let sb = Sandbox::new("caps");
    let (code, caps) = sb.one(&["caps"], None);
    assert_eq!(code, 0);
    assert_eq!(caps["ok"], true);
    assert_eq!(caps["cli"], 1);
    assert_eq!(
        caps["commands"],
        json!(["caps", "probe", "create", "validate", "save", "render"])
    );
    assert_eq!(
        caps["exe"],
        Path::new(BIN).canonicalize().unwrap().to_str().unwrap()
    );
    assert_eq!(caps["ffmpeg"]["path"], ffmpeg().to_str().unwrap());
    assert_eq!(caps["tap"]["defaultStyle"], "target");
    assert_eq!(caps["hardwareVideo"], true);
}

#[test]
fn edit_cli_save_is_base_checked_and_validate_reports() {
    let sb = Sandbox::new("save");
    let p = sb.p();
    std::fs::write(sb.project().join("assets/a.mp4"), b"x").unwrap();
    let doc = json!({
        "version": 1, "name": "cut",
        "sources": [{"id": "s1", "rel": "assets/a.mp4", "width": 320, "height": 240, "fps": 30, "durationMs": 2000}],
        "settings": {"width": 320, "height": 240, "fps": 30},
        "clips": [{"id": "c1", "sourceId": "s1", "inMs": 0, "outMs": 1000, "speed": 1, "startMs": 0}]
    });
    let bytes = serde_json::to_vec(&doc).unwrap();
    let save = |base: &str, body: &[u8]| {
        sb.one(
            &[
                "save",
                "--project",
                &p,
                "--name",
                "cut",
                "--doc",
                "-",
                "--base",
                base,
            ],
            Some(body),
        )
    };
    let (code, first) = save("absent", &bytes);
    assert_eq!(code, 0, "{first}");
    let on_disk = std::fs::read(sb.project().join("edits/cut.json")).unwrap();
    assert_eq!(first["bytes"], on_disk.len());
    let (code, again) = save("absent", &bytes);
    assert_eq!((code, &again["code"]), (1, &json!("conflict")));
    assert_eq!(again["hash"], first["hash"]);
    let base = first["hash"].as_str().unwrap().to_owned();
    let mut longer = doc.clone();
    longer["clips"][0]["outMs"] = 1500.into();
    let (code, second) = save(&base, &serde_json::to_vec(&longer).unwrap());
    assert_eq!(code, 0, "{second}");
    let (code, stale) = save(&base, &bytes);
    assert_eq!((code, &stale["code"]), (1, &json!("conflict")));
    assert_eq!(stale["hash"], second["hash"]);
    let base = second["hash"].as_str().unwrap().to_owned();
    let fractional = String::from_utf8(bytes.clone())
        .unwrap()
        .replace("\"outMs\":1000", "\"outMs\":999.5");
    let (code, corrupt) = save(&base, fractional.as_bytes());
    assert_eq!((code, &corrupt["code"]), (1, &json!("corrupt")));
    let mut renamed = doc.clone();
    renamed["name"] = "other".into();
    let (code, mismatch) = save(&base, &serde_json::to_vec(&renamed).unwrap());
    assert_eq!((code, &mismatch["code"]), (1, &json!("invalid")));

    let (code, report) = sb.one(&["validate", "--project", &p, "--name", "cut"], None);
    assert_eq!(code, 0);
    assert_eq!(report["ok"], true);
    assert_eq!(report["totalFrames"], 45);
    assert_eq!(report["hash"], second["hash"]);
    assert_eq!(
        report["clips"][0],
        json!({"id": "c1", "startMs": 0.0, "endMs": 1500.0, "startFrame": 0, "frames": 45})
    );
    let (code, broken) = sb.one(&["validate", "--project", &p, "--doc", "-"], Some(b"{nope"));
    assert_eq!(code, 0);
    assert_eq!(
        (&broken["ok"], &broken["errors"][0]["code"]),
        (&json!(false), &json!("corrupt"))
    );
    let (code, missing) = sb.one(&["validate", "--project", &p, "--name", "ghost"], None);
    assert_eq!((code, &missing["code"]), (1, &json!("missing")));
}

/// A two-second 320x240 30 fps recording plus a still, in a fresh sandbox.
fn media_sandbox(tag: &str, seconds: u32) -> Sandbox {
    let sb = Sandbox::new(tag);
    let assets = sb.project().join("assets");
    let rec = assets.join("rec.mp4");
    let src = format!("testsrc2=s=320x240:r=30:d={seconds}");
    ffmpeg_run(&[
        "-f",
        "lavfi",
        "-i",
        &src,
        "-pix_fmt",
        "yuv420p",
        rec.to_str().unwrap(),
    ]);
    let still = assets.join("still.png");
    ffmpeg_run(&[
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=200x300:r=1:d=1",
        "-frames:v",
        "1",
        still.to_str().unwrap(),
    ]);
    sb
}

#[test]
#[ignore = "runs the dev ffmpeg sidecar (pnpm setup:ffmpeg)"]
fn edit_cli_end_to_end_create_validate_render_both_lanes() {
    let sb = media_sandbox("e2e", 2);
    let p = sb.p();
    let (code, probe) = sb.one(
        &["probe", "--project", &p, "--source", "assets/rec.mp4"],
        None,
    );
    assert_eq!(code, 0, "{probe}");
    assert_eq!(
        (&probe["width"], &probe["fps"], &probe["nbFrames"]),
        (&json!(320), &json!(30.0), &json!(60))
    );
    assert_eq!(probe["editFps"], 30.0);

    let (code, created) = sb.one(
        &["create", "--project", &p, "--source", "assets/rec.mp4"],
        None,
    );
    assert_eq!(code, 0, "{created}");
    assert_eq!(created["name"], "rec");
    let mut doc = created["doc"].clone();
    // Add the still and a tap so both extra paths render.
    doc["sources"].as_array_mut().unwrap().push(json!({"id": "s2", "rel": "assets/still.png", "kind": "image", "width": 200, "height": 300, "fps": 0, "durationMs": 0}));
    doc["clips"][0]["outMs"] = 1500.into();
    doc["clips"].as_array_mut().unwrap().push(json!({"id": "c2", "sourceId": "s2", "inMs": 0, "outMs": 0, "speed": 1, "startMs": 1500, "holdMs": 500}));
    doc["taps"] = json!([{"id": "t1", "sourceId": "s1", "sourceMs": 400, "pos": [0.3, 0.6]}]);
    let base = created["hash"].as_str().unwrap().to_owned();
    let (code, saved) = sb.one(
        &[
            "save",
            "--project",
            &p,
            "--name",
            "rec",
            "--doc",
            "-",
            "--base",
            &base,
        ],
        Some(&serde_json::to_vec(&doc).unwrap()),
    );
    assert_eq!(code, 0, "{saved}");
    let (_, report) = sb.one(&["validate", "--project", &p, "--name", "rec"], None);
    assert_eq!(report["ok"], true, "{report}");
    let total = report["totalFrames"].as_u64().unwrap() as u32;
    assert_eq!(total, 45 + 15);

    let output = sb.project().join("assets/rec-edited.mp4");
    for lane_flags in [vec!["--software"], vec![]] {
        let mut args = vec!["render", "--project", &p, "--name", "rec"];
        args.extend(lane_flags.iter().copied());
        let (code, lines) = sb.run(&args, None);
        assert_eq!(code, 0, "{lines:?}");
        assert_eq!(lines[0]["event"], "start");
        assert_eq!(lines[0]["total"], total);
        let done = lines.last().unwrap();
        assert_eq!(done["event"], "done", "{done}");
        assert_eq!(done["rel"], "assets/rec-edited.mp4");
        assert_eq!(done["frames"], total);
        assert_eq!(done["docHash"], saved["hash"]);
        if lane_flags.is_empty() {
            // VideoToolbox may still refuse a tiny frame; the software retry then owns the render.
            assert!(done["lane"] == "hardware" || lines.iter().any(|l| l["event"] == "retry"));
        } else {
            assert_eq!(done["lane"], "software");
        }
        assert_eq!(decoded_frames(&output), total);
        let record: Value = serde_json::from_slice(
            &std::fs::read(sb.project().join("edits/.renders/rec.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(record["docHash"], saved["hash"]);
        assert_eq!(record["lane"], done["lane"]);
        assert!(!sb.project().join("assets/.kc-render").exists());
    }

    // A review draft lands outside assets/ at half size, with no record change.
    let record_before = std::fs::read(sb.project().join("edits/.renders/rec.json")).unwrap();
    let draft = sb.root.join("drafts/rec.mp4");
    let draft_args = [
        "render",
        "--project",
        &p,
        "--doc",
        "-",
        "--out",
        draft.to_str().unwrap(),
        "--draft",
    ];
    let (code, lines) = sb.run(&draft_args, Some(b""));
    assert_eq!((code, &lines[0]["code"]), (1, &json!("corrupt")));
    let (code, lines) = sb.run(&draft_args, Some(&serde_json::to_vec(&doc).unwrap()));
    assert_eq!(code, 0, "{lines:?}");
    let done = lines.last().unwrap();
    assert_eq!(
        (&done["rel"], &done["width"], &done["height"]),
        (&Value::Null, &json!(160), &json!(120))
    );
    assert_eq!(decoded_frames(&draft), total);
    assert_eq!(
        std::fs::read(sb.project().join("edits/.renders/rec.json")).unwrap(),
        record_before
    );

    // A document that passes validation but fails in ffmpeg (odd output size) keeps the good render.
    let good = sha256(&output);
    let (_, current) = sb.one(&["validate", "--project", &p, "--name", "rec"], None);
    let mut bad = doc.clone();
    bad["settings"]["width"] = 321.into();
    bad["settings"]["height"] = 241.into();
    let (code, _) = sb.one(
        &[
            "save",
            "--project",
            &p,
            "--name",
            "rec",
            "--doc",
            "-",
            "--base",
            current["hash"].as_str().unwrap(),
        ],
        Some(&serde_json::to_vec(&bad).unwrap()),
    );
    assert_eq!(code, 0);
    let (code, lines) = sb.run(
        &["render", "--project", &p, "--name", "rec", "--software"],
        None,
    );
    let last = lines.last().unwrap();
    assert_eq!(
        (code, &last["event"], &last["code"]),
        (1, &json!("error"), &json!("ffmpeg")),
        "{lines:?}"
    );
    assert_eq!(sha256(&output), good);
    assert!(!sb.project().join("assets/.kc-render").exists());
    let (code, stale) = sb.one(
        &[
            "render",
            "--project",
            &p,
            "--name",
            "rec",
            "--expect-hash",
            &"0".repeat(64),
        ],
        None,
    );
    assert_eq!((code, &stale["code"]), (1, &json!("conflict")));
}

#[test]
#[ignore = "runs the dev ffmpeg sidecar (pnpm setup:ffmpeg)"]
fn edit_cli_sigterm_interrupts_and_keeps_the_good_output() {
    let sb = media_sandbox("sigterm", 60);
    let p = sb.p();
    let (code, _) = sb.one(
        &["create", "--project", &p, "--source", "assets/rec.mp4"],
        None,
    );
    assert_eq!(code, 0);
    let output = sb.project().join("assets/rec-edited.mp4");
    std::fs::write(&output, b"GOOD").unwrap();
    let mut child = sb
        .command(&["render", "--project", &p, "--name", "rec", "--software"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut events = Vec::new();
    for line in lines.by_ref() {
        let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let progress = value["event"] == "progress";
        events.push(value);
        if progress {
            unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
            break;
        }
    }
    for line in lines {
        events.push(serde_json::from_str(&line.unwrap()).unwrap());
    }
    let status = child.wait().unwrap();
    assert_eq!(status.code(), Some(130), "{events:?}");
    let last = events.last().unwrap();
    assert_eq!(
        (&last["event"], &last["code"]),
        (&json!("error"), &json!("interrupted"))
    );
    assert_eq!(std::fs::read(&output).unwrap(), b"GOOD");
    assert!(!sb.project().join("assets/.kc-render").exists());
    assert!(!sb.project().join("edits/.renders/rec.json").exists());
}
