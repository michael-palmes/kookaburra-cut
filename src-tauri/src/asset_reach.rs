//! What an `asset://` URL may serve: the app's caches, the workspace's shared libraries and, per window, the one project that window loaded. The app registers the scheme itself (Tauri then skips its own handler) because Tauri's scope can allow a folder but never take it back, and a closed project must stop being readable.

use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use http_range::HttpRange;
use tauri::http::{header::*, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

/// Workspace folders every window may read: the libraries shared across projects, and the welcome snapshots and scene thumbs of every project (the rest of `.kookaburra`, import backups included, stays out). Projects are never on this list.
const SHARED_DIRS: [&str; 8] = [
    ".kookaburra/snapshots",
    ".kookaburra/scene-thumbs",
    crate::library::TEMPLATES_DIR_NAME,
    crate::library::PRESETS_DIR_NAME,
    crate::fonts::FONTS_DIR_NAME,
    crate::objects::OBJECTS_DIR_NAME,
    crate::brands::BRANDS_DIR_NAME,
    crate::global_screenshots::SCREENSHOTS_DIR,
];

#[derive(Default)]
struct Reach {
    caches: Option<PathBuf>,
    workspace: Option<PathBuf>,
    shared: Vec<PathBuf>,
    files: HashSet<PathBuf>,
    projects: HashMap<String, PathBuf>,
}

#[derive(Default)]
pub(crate) struct AssetReach(Mutex<Reach>);

fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))
}

fn canonical_or_lexical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

impl Reach {
    /// The real file behind `path` when `label`'s window may read it (`check` over the canonical path).
    #[cfg(test)]
    fn resolve(&self, label: &str, path: &Path) -> Result<PathBuf, String> {
        self.check(label, &canonical(path)?, path)
    }

    /// Whether `label`'s window may read `real` (already canonical; `shown` is the path as requested, for the message): inside one of its roots with no hidden folder below the root (the Tauri rule `requireLiteralLeadingDot`, kept here), or a file allowed by name.
    fn check(&self, label: &str, real: &Path, shown: &Path) -> Result<PathBuf, String> {
        let path = shown;
        let real = real.to_path_buf();
        if self.files.contains(&real) {
            return Ok(real);
        }
        let project = self.projects.get(label);
        let roots = self
            .caches
            .iter()
            .chain(self.shared.iter())
            .chain(project);
        for root in roots {
            let Ok(below) = real.strip_prefix(root) else {
                continue;
            };
            let hidden = below.components().any(|part| match part {
                Component::Normal(name) => name.to_string_lossy().starts_with('.'),
                _ => false,
            });
            if hidden {
                return Err(format!("hidden folders are not served: {}", path.display()));
            }
            return Ok(real);
        }
        Err(match project {
            Some(_) => format!(
                "outside the open project and the libraries: {}",
                path.display()
            ),
            None => format!(
                "no project is open in the {label} window: {}",
                path.display()
            ),
        })
    }
}

/// The app's caches are readable from boot (`$APPDATA/cache`: media posters, clip previews, theme previews).
pub(crate) fn init(app: &AppHandle) {
    let Ok(data) = app.path().app_data_dir() else {
        return;
    };
    let cache = data.join("cache");
    let _ = std::fs::create_dir_all(&cache);
    let reach = app.state::<AssetReach>();
    reach.0.lock().unwrap().caches = Some(canonical_or_lexical(&cache));
}

/// The workspace's shared libraries follow its root; a root that has not changed costs one comparison.
pub(crate) fn set_workspace(app: &AppHandle, root: &Path) {
    let Some(reach) = app.try_state::<AssetReach>() else {
        return;
    };
    let root = canonical_or_lexical(root);
    let mut reach = reach.0.lock().unwrap();
    if reach.workspace.as_deref() == Some(root.as_path()) {
        return;
    }
    reach.shared = SHARED_DIRS.iter().map(|name| root.join(name)).collect();
    reach.workspace = Some(root);
}

/// `label`'s window now reads `dir` (a project folder, or a bundled item's assets in a dev build) in place of whatever it read before.
pub(crate) fn open_project(app: &AppHandle, label: &str, dir: &Path) {
    let Some(reach) = app.try_state::<AssetReach>() else {
        return;
    };
    let dir = canonical_or_lexical(dir);
    reach
        .0
        .lock()
        .unwrap()
        .projects
        .insert(label.to_owned(), dir);
}

/// `label`'s window reads no project any more (back to the welcome screen, a bundled project, or the window closed).
pub(crate) fn close_project(app: &AppHandle, label: &str) {
    let Some(reach) = app.try_state::<AssetReach>() else {
        return;
    };
    reach.0.lock().unwrap().projects.remove(label);
}

/// One file every window may read by its exact path (a dev checkout's bundled library previews).
pub(crate) fn allow_file(app: &AppHandle, path: &Path) {
    let Some(reach) = app.try_state::<AssetReach>() else {
        return;
    };
    reach
        .0
        .lock()
        .unwrap()
        .files
        .insert(canonical_or_lexical(path));
}

/// Where the page itself is served from, for the CORS header a cross-origin `fetch` of an `asset://` URL needs.
fn window_origin(app: &AppHandle) -> String {
    if tauri::is_dev() {
        if let Some(url) = &app.config().build.dev_url {
            return url.origin().ascii_serialization();
        }
    }
    "tauri://localhost".into()
}

/// The `asset` scheme handler: Tauri's own byte-range serving, with the reach above in place of Tauri's scope.
pub(crate) fn handler(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let label = ctx.webview_label().to_owned();
    tauri::async_runtime::spawn(async move {
        let origin = window_origin(&app);
        // The realpath syscall runs before the lock, so concurrent requests never queue behind disk latency.
        let allow = |path: &Path| {
            let real = canonical(path)?;
            app.state::<AssetReach>()
                .0
                .lock()
                .unwrap()
                .check(&label, &real, path)
        };
        match get_response(&allow, request, &origin).await {
            Ok(response) => responder.respond(response),
            Err(e) => responder.respond(
                Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .header(CONTENT_TYPE, "text/plain")
                    .header("Access-Control-Allow-Origin", &origin)
                    .body(e.to_string().into_bytes())
                    .unwrap(),
            ),
        }
    });
}

async fn get_response(
    allow: &(dyn Fn(&Path) -> Result<PathBuf, String> + Sync),
    request: Request<Vec<u8>>,
    origin: &str,
) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error>> {
    let raw = request.uri().path();
    let path = percent_encoding::percent_decode(raw.strip_prefix('/').unwrap_or(raw).as_bytes())
        .decode_utf8_lossy();
    let mut resp = Response::builder().header("Access-Control-Allow-Origin", origin);
    let file_path = match allow(Path::new(path.as_ref())) {
        Ok(path) => path,
        Err(reason) => {
            log::warn!("[assets] refused: {reason}");
            return resp
                .status(StatusCode::FORBIDDEN)
                .body(Vec::new())
                .map_err(Into::into);
        }
    };

    let mut file = match File::open(&file_path).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return resp
                .status(StatusCode::NOT_FOUND)
                .body(Vec::new())
                .map_err(Into::into);
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return resp
                .status(StatusCode::FORBIDDEN)
                .body(Vec::new())
                .map_err(Into::into);
        }
        Err(e) => return Err(e.into()),
    };

    let len = file.metadata().await?.len();
    let (mime_type, read_bytes) = {
        let nbytes = len.min(8192);
        let mut magic_buf = Vec::with_capacity(nbytes as usize);
        (&mut file).take(nbytes).read_to_end(&mut magic_buf).await?;
        file.rewind().await?;
        (
            tauri::utils::mime_type::MimeType::parse(&magic_buf, &path),
            if len < 8192 { Some(magic_buf) } else { None },
        )
    };
    resp = resp.header(CONTENT_TYPE, &mime_type);

    let response = if let Some(range_header) =
        request.headers().get(RANGE).and_then(|r| r.to_str().ok())
    {
        resp = resp.header(ACCEPT_RANGES, "bytes");
        resp = resp.header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range");
        let not_satisfiable = || {
            Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .map_err(Into::into)
        };
        let Ok(ranges) = HttpRange::parse(range_header, len) else {
            return not_satisfiable();
        };
        let ranges: Vec<(u64, u64)> = ranges
            .iter()
            .map(|r| (r.start, r.start + r.length - 1))
            .collect();
        // The most one range answer carries, as Tauri serves it.
        const MAX_LEN: u64 = 1000 * 1024;
        if ranges.len() == 1 {
            let &(start, mut end) = ranges.first().unwrap();
            if start >= len || end >= len || end < start {
                return not_satisfiable();
            }
            end = start + (end - start).min(len - start).min(MAX_LEN - 1);
            let nbytes = end + 1 - start;
            let mut buf = Vec::with_capacity(nbytes as usize);
            file.seek(SeekFrom::Start(start)).await?;
            file.take(nbytes).read_to_end(&mut buf).await?;
            resp = resp.header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
            resp = resp.header(CONTENT_LENGTH, nbytes);
            resp = resp.status(StatusCode::PARTIAL_CONTENT);
            resp.body(buf)
        } else {
            let ranges: Vec<(u64, u64)> = ranges
                .iter()
                .filter_map(|&(start, mut end)| {
                    if start >= len || end >= len || end < start {
                        None
                    } else {
                        end = start + (end - start).min(len - start).min(MAX_LEN - 1);
                        Some((start, end))
                    }
                })
                .collect();
            let boundary = random_boundary();
            let boundary_sep = format!("\r\n--{boundary}\r\n");
            let boundary_closer = format!("\r\n--{boundary}--\r\n");
            if let Some(headers) = resp.headers_mut() {
                headers.insert(
                    CONTENT_TYPE,
                    HeaderValue::from_str(&format!("multipart/byteranges; boundary={boundary}"))?,
                );
            }
            let mut buf = Vec::new();
            for (start, end) in ranges {
                buf.write_all(boundary_sep.as_bytes()).await?;
                buf.write_all(format!("{CONTENT_TYPE}: {mime_type}\r\n").as_bytes())
                    .await?;
                buf.write_all(format!("{CONTENT_RANGE}: bytes {start}-{end}/{len}\r\n").as_bytes())
                    .await?;
                buf.write_all(b"\r\n").await?;
                let nbytes = end + 1 - start;
                buf.reserve(nbytes as usize);
                file.seek(SeekFrom::Start(start)).await?;
                (&mut file).take(nbytes).read_to_end(&mut buf).await?;
            }
            buf.write_all(boundary_closer.as_bytes()).await?;
            resp = resp.status(StatusCode::PARTIAL_CONTENT);
            resp.body(buf)
        }
    } else if request.method() == tauri::http::Method::HEAD {
        resp = resp.header(CONTENT_LENGTH, len);
        resp.body(Vec::new())
    } else {
        let buf = match read_bytes {
            Some(b) => b,
            None => {
                let mut local_buf = Vec::with_capacity(len as usize);
                file.read_to_end(&mut local_buf).await?;
                local_buf
            }
        };
        resp = resp.header(CONTENT_LENGTH, len);
        resp.body(buf)
    };
    response.map_err(Into::into)
}

fn random_boundary() -> String {
    let mut x = [0_u8; 30];
    getrandom::fill(&mut x).expect("failed to get random bytes");
    x.iter().map(|b| format!("{b:x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kc-reach-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn write(path: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    /// A workspace with two projects, a shared library and a cache, as the app registers them.
    fn studio() -> (PathBuf, Reach) {
        let base = scratch();
        let root = base.join("Kookaburra Cut");
        write(&root.join("alpha/assets/hero.png"), b"a");
        write(&root.join("alpha/assets/.emoji-cache/1f600@256.png"), b"e");
        write(&root.join("beta/assets/hero.png"), b"b");
        write(&root.join(".kookaburra/snapshots/alpha.png"), b"s");
        write(&root.join("templates/launch/poster.png"), b"t");
        write(&base.join("cache/media/abc/poster.jpg"), b"c");
        write(
            &root.join(".kookaburra/import-backup/beta/assets/hero.png"),
            b"b",
        );
        write(&base.join("elsewhere/secret.png"), b"x");
        let mut reach = Reach {
            caches: Some(base.join("cache")),
            workspace: Some(root.clone()),
            shared: SHARED_DIRS.iter().map(|name| root.join(name)).collect(),
            ..Default::default()
        };
        reach.projects.insert("main".into(), root.join("alpha"));
        (base, reach)
    }

    #[test]
    fn a_window_reads_its_project_the_libraries_and_the_caches() {
        let (base, reach) = studio();
        let root = base.join("Kookaburra Cut");
        for path in [
            root.join("alpha/assets/hero.png"),
            root.join(".kookaburra/snapshots/alpha.png"),
            root.join("templates/launch/poster.png"),
            base.join("cache/media/abc/poster.jpg"),
        ] {
            assert_eq!(reach.resolve("main", &path).unwrap(), path);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn another_project_is_refused_from_the_open_one() {
        let (base, reach) = studio();
        let root = base.join("Kookaburra Cut");
        let err = reach
            .resolve("main", &root.join("beta/assets/hero.png"))
            .unwrap_err();
        assert!(err.contains("outside the open project"), "{err}");
        let err = reach
            .resolve("present", &root.join("alpha/assets/hero.png"))
            .unwrap_err();
        assert!(
            err.contains("no project is open in the present window"),
            "{err}"
        );
        let err = reach
            .resolve("main", &base.join("elsewhere/secret.png"))
            .unwrap_err();
        assert!(err.contains("outside"), "{err}");
        let err = reach
            .resolve(
                "main",
                &root.join(".kookaburra/import-backup/beta/assets/hero.png"),
            )
            .unwrap_err();
        assert!(err.contains("outside"), "{err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn closing_takes_the_project_back_and_reopening_restores_it() {
        let (base, mut reach) = studio();
        let hero = base.join("Kookaburra Cut/alpha/assets/hero.png");
        assert!(reach.resolve("main", &hero).is_ok());
        reach.projects.remove("main");
        assert!(reach.resolve("main", &hero).is_err());
        reach
            .projects
            .insert("main".into(), base.join("Kookaburra Cut/alpha"));
        assert!(reach.resolve("main", &hero).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn hidden_folders_below_a_root_are_not_served() {
        let (base, reach) = studio();
        let root = base.join("Kookaburra Cut");
        let err = reach
            .resolve(
                "main",
                &root.join("alpha/assets/.emoji-cache/1f600@256.png"),
            )
            .unwrap_err();
        assert!(err.contains("hidden"), "{err}");
        assert!(reach
            .resolve("main", &root.join(".kookaburra/snapshots/alpha.png"))
            .is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_link_out_of_the_project_fails_closed() {
        let (base, reach) = studio();
        let root = base.join("Kookaburra Cut");
        std::os::unix::fs::symlink(base.join("elsewhere"), root.join("alpha/assets/out")).unwrap();
        std::os::unix::fs::symlink(
            root.join("beta/assets/hero.png"),
            root.join("alpha/assets/theirs.png"),
        )
        .unwrap();
        let err = reach
            .resolve("main", &root.join("alpha/assets/out/secret.png"))
            .unwrap_err();
        assert!(err.contains("outside"), "{err}");
        let err = reach
            .resolve("main", &root.join("alpha/assets/theirs.png"))
            .unwrap_err();
        assert!(err.contains("outside"), "{err}");
        let err = reach
            .resolve("main", &root.join("alpha/assets/missing.png"))
            .unwrap_err();
        assert!(err.contains("missing.png"), "{err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    fn serve(allow_file: &Path, uri: &str, headers: &[(&str, &str)]) -> Response<Vec<u8>> {
        serve_with(tauri::http::Method::GET, allow_file, uri, headers)
    }

    fn serve_with(
        method: tauri::http::Method,
        allow_file: &Path,
        uri: &str,
        headers: &[(&str, &str)],
    ) -> Response<Vec<u8>> {
        let allowed = allow_file.to_path_buf();
        let allow = move |path: &Path| -> Result<PathBuf, String> {
            let real = canonical(path)?;
            (real == allowed)
                .then_some(real)
                .ok_or_else(|| "outside".to_owned())
        };
        let mut request = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let request = request.body(Vec::new()).unwrap();
        tauri::async_runtime::block_on(get_response(&allow, request, "tauri://localhost")).unwrap()
    }

    fn encoded(path: &Path) -> String {
        percent_encoding::percent_encode(
            path.to_string_lossy().as_bytes(),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string()
    }

    /// The ported serving: whole files with their type, single and multipart ranges as Tauri answers them, HEAD, and 403 or 404 for what the reach refuses or cannot find.
    #[test]
    fn serves_files_and_ranges_as_tauri_did() {
        let base = scratch();
        let file = base.join("clip.bin");
        std::fs::write(&file, vec![b'a'; 1000]).unwrap();
        let uri = format!("asset://localhost/{}", encoded(&file));

        let whole = serve(&file, &uri, &[]);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.headers()[CONTENT_LENGTH], "1000");
        assert_eq!(
            whole.headers()["Access-Control-Allow-Origin"],
            "tauri://localhost"
        );
        assert_eq!(whole.body().len(), 1000);

        let head = serve_with(tauri::http::Method::HEAD, &file, &uri, &[]);
        assert_eq!(head.headers()[CONTENT_LENGTH], "1000");
        assert!(head.body().is_empty());

        let one = serve(&file, &uri, &[("range", "bytes=10-19")]);
        assert_eq!(one.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(one.headers()[CONTENT_RANGE], "bytes 10-19/1000");
        assert_eq!(one.headers()[CONTENT_LENGTH], "10");
        assert_eq!(one.body().len(), 10);

        let many = serve(&file, &uri, &[("range", "bytes=0-9, 20-29")]);
        assert_eq!(many.status(), StatusCode::PARTIAL_CONTENT);
        let content_type = many.headers()[CONTENT_TYPE].to_str().unwrap().to_owned();
        let boundary = content_type
            .strip_prefix("multipart/byteranges; boundary=")
            .unwrap();
        assert!(many
            .body()
            .ends_with(format!("\r\n--{boundary}--\r\n").as_bytes()));

        let beyond = serve(&file, &uri, &[("range", "bytes=2000-2010")]);
        assert_eq!(beyond.status(), StatusCode::RANGE_NOT_SATISFIABLE);

        let other = base.join("other.bin");
        std::fs::write(&other, b"x").unwrap();
        let refused = serve(
            &file,
            &format!("asset://localhost/{}", encoded(&other)),
            &[],
        );
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        let empty = serve(&file, "asset://localhost", &[]);
        assert_eq!(empty.status(), StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_file_allowed_by_name_reads_from_any_window() {
        let (base, mut reach) = studio();
        let preview = base.join("elsewhere/secret.png");
        reach.files.insert(preview.clone());
        assert_eq!(reach.resolve("library", &preview).unwrap(), preview);
        let _ = std::fs::remove_dir_all(&base);
    }
}
