use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Emitter, Manager, State, Webview, WebviewBuilder, WebviewUrl, Window};
use url::Url;

use crate::{media, workspace};

const MAX_WEBSITE_VIEWS: usize = 8;
const WEBSITE_DATA_STORE: [u8; 16] = [
    0x9b, 0x2d, 0x4c, 0x93, 0x65, 0xe2, 0x4e, 0x4a, 0x92, 0x0b, 0x55, 0x7a, 0x34, 0xe0, 0xb7, 0x2c,
];

const WEBSITE_INIT_SCRIPT: &str = r#"
(() => {
  const postFocus = (action) => {
    try { window.webkit?.messageHandlers?.kookaburraWebsiteFocus?.postMessage(action); } catch {}
  };
  addEventListener('pointerdown', () => postFocus('acquire'), true);
  addEventListener('focusin', () => postFocus('acquire'), true);
  addEventListener('keydown', (event) => {
    if (event.shiftKey && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      postFocus('release');
    }
  }, true);
  addEventListener('dragover', (event) => event.preventDefault(), true);
  addEventListener('drop', (event) => event.preventDefault(), true);
  const hardenInputs = (root = document) => {
    if (root.matches?.('input, textarea, form')) {
      root.setAttribute('autocomplete', 'off');
      root.setAttribute('data-1p-ignore', 'true');
    }
    root.querySelectorAll?.('input, textarea, form').forEach((node) => {
      node.setAttribute('autocomplete', 'off');
      node.setAttribute('data-1p-ignore', 'true');
    });
  };
  addEventListener('DOMContentLoaded', () => {
    hardenInputs();
    new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach(hardenInputs)))
      .observe(document.documentElement, { childList: true, subtree: true });
  }, { once: true });
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition = (_ok, fail) => fail?.({ code: 1, message: 'Permission denied' });
    navigator.geolocation.watchPosition = (_ok, fail) => { fail?.({ code: 1, message: 'Permission denied' }); return 0; };
  }
  if (window.Notification) Notification.requestPermission = async () => 'denied';
})();
"#;

const PRESENT_INIT_SCRIPT: &str = r#"
addEventListener('contextmenu', (event) => event.preventDefault(), true);
"#;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WebsiteBounds {
    fn validate(self) -> Result<Self, String> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite()) {
            return Err("website bounds must be finite".into());
        }
        if !(1.0..=10_000.0).contains(&self.width) || !(1.0..=10_000.0).contains(&self.height) {
            return Err("website bounds are outside the supported size".into());
        }
        if self.x.abs() > 20_000.0 || self.y.abs() > 20_000.0 {
            return Err("website bounds are outside the supported position".into());
        }
        Ok(self)
    }

    fn position(self) -> tauri::LogicalPosition<f64> {
        tauri::LogicalPosition::new(self.x, self.y)
    }

    fn size(self) -> tauri::LogicalSize<f64> {
        tauri::LogicalSize::new(self.width, self.height)
    }

    fn rect(self) -> tauri::Rect {
        tauri::Rect {
            position: self.position().into(),
            size: self.size().into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteOpenRequest {
    pub project_path: String,
    pub scene_stem: String,
    pub url: String,
    #[serde(default)]
    pub requested_origins: Vec<String>,
    pub bounds: WebsiteBounds,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub zoom: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteOpenResponse {
    pub view_id: String,
    pub state: &'static str,
    pub origin: String,
    pub loopback: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteCaptureResponse {
    pub src: String,
    pub width: u32,
    pub height: u32,
    pub source_origin: Option<String>,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteDataRecordSummary {
    pub display_name: String,
    pub data_types: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteImportImageRequest {
    pub project_path: String,
    pub scene_stem: String,
    pub source_path: String,
    pub width: u32,
    pub height: u32,
    pub background: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebsiteOriginRequest {
    view_id: String,
    origin: String,
    loopback: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebsiteViewState {
    view_id: String,
    state: &'static str,
    origin: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebsiteFocusState {
    view_id: String,
    focused: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WebsiteAction {
    Back,
    Forward,
    Reload,
    ReturnToStart,
    Focus,
    ReleaseFocus,
}

struct WebsiteView {
    webview: Webview,
    owner: String,
    project_key: String,
    scene_stem: String,
    requested_origins: HashSet<String>,
    authored_url: Url,
    pending_url: Option<Url>,
    current_origin: Option<String>,
    bounds: WebsiteBounds,
    viewport_width: u32,
    viewport_height: u32,
    zoom: f64,
    active: bool,
    ready: bool,
    used_at: u64,
}

#[derive(Default)]
struct WebsiteRegistry {
    views: HashMap<String, WebsiteView>,
    loopback_grants: HashSet<(String, String)>,
    tick: u64,
}

#[derive(Default)]
pub struct WebsiteState(Mutex<WebsiteRegistry>);

pub fn trusted_invoke_label(label: &str) -> bool {
    matches!(
        label,
        "main" | "present" | "settings" | "render" | "editor" | "packs"
    )
}

pub fn guard_invoke<F>(handler: F) -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        if trusted_invoke_label(invoke.message.webview_ref().label()) {
            handler(invoke)
        } else {
            invoke
                .resolver
                .reject("native commands are unavailable to remote website content");
            true
        }
    }
}

fn require_caller(webview: &Webview, allowed: &[&str]) -> Result<String, String> {
    let label = webview.label();
    if allowed.contains(&label) {
        Ok(label.to_owned())
    } else {
        Err("website command is unavailable to this webview".into())
    }
}

fn validate_scene_stem(stem: &str) -> Result<(), String> {
    if stem.is_empty()
        || stem.len() > 120
        || stem.starts_with('.')
        || stem.contains('/')
        || stem.contains('\\')
        || stem.contains("..")
    {
        return Err("invalid website scene stem".into());
    }
    Ok(())
}

fn validate_import_source_dimensions(width: u32, height: u32) -> Result<(), String> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 || pixels > 100_000_000 {
        return Err("Website image source dimensions are unsafe".into());
    }
    Ok(())
}

fn has_explicit_port(input: &str) -> bool {
    let Some((_, rest)) = input.split_once("://") else {
        return false;
    };
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    if let Some(suffix) = authority
        .strip_prefix('[')
        .and_then(|value| value.split_once(']'))
    {
        return suffix.1.strip_prefix(':').is_some_and(|port| {
            !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit())
        });
    }
    authority
        .rsplit_once(':')
        .is_some_and(|(_, port)| !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()))
}

fn parse_website_url_with_policy(
    input: &str,
    require_explicit_loopback_port: bool,
) -> Result<(Url, String, bool), String> {
    let url = Url::parse(input).map_err(|_| "website URL is invalid")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("website URLs cannot contain credentials".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "website URL must have a host".to_string())?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("website URL must use HTTPS or explicit-port HTTP loopback".into()),
    }
    if loopback && require_explicit_loopback_port && !has_explicit_port(input) {
        return Err("loopback website URLs require an explicit port".into());
    }
    let origin = url.origin().ascii_serialization();
    Ok((url, origin, loopback))
}

fn parse_website_url(input: &str) -> Result<(Url, String, bool), String> {
    parse_website_url_with_policy(input, true)
}

fn parse_navigation_url(input: &str) -> Result<(Url, String, bool), String> {
    parse_website_url_with_policy(input, false)
}

fn normalise_requested_origins(values: &[String]) -> Result<HashSet<String>, String> {
    values
        .iter()
        .map(|value| parse_navigation_url(value).map(|(_, origin, _)| origin))
        .collect()
}

fn canonical_project_key(
    app: &AppHandle,
    settings: &State<'_, workspace::SettingsState>,
    project_path: &str,
) -> Result<String, String> {
    let path = workspace::confine_readable(app, settings, project_path)?;
    if !path.is_dir() {
        return Err("website project path is not a directory".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn view_id(owner: &str, project_key: &str, scene_stem: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(owner.as_bytes());
    hash.update([0]);
    hash.update(project_key.as_bytes());
    hash.update([0]);
    hash.update(scene_stem.as_bytes());
    let suffix = hex_bytes(&hash.finalize()[..12]);
    format!("website-{suffix}")
}

fn hex_bytes(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_png_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|_| "website snapshot is not a valid PNG")?;
    let output_size = reader
        .output_buffer_size()
        .ok_or_else(|| "website snapshot is too large".to_string())?;
    let mut decoded = vec![0; output_size];
    let info = reader
        .next_frame(&mut decoded)
        .map_err(|_| "website snapshot could not be decoded")?;
    if info.bit_depth != png::BitDepth::Eight {
        return Err("website snapshot has an unsupported bit depth".into());
    }
    let source = &decoded[..info.buffer_size()];
    let pixels = u64::from(info.width)
        .checked_mul(u64::from(info.height))
        .and_then(|value| value.checked_mul(4))
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| "website snapshot dimensions are too large".to_string())?;
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
        png::ColorType::Indexed => return Err("website snapshot palette was not expanded".into()),
    }
    if rgba.len() != pixels {
        return Err("website snapshot pixel data is incomplete".into());
    }
    Ok((rgba, info.width, info.height))
}

fn resize_rgba(
    source: &[u8],
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
) -> Vec<u8> {
    if source_width == width && source_height == height {
        return source.to_vec();
    }
    let mut output = vec![0; width as usize * height as usize * 4];
    let max_x = source_width.saturating_sub(1) as usize;
    let max_y = source_height.saturating_sub(1) as usize;
    for y in 0..height as usize {
        let source_y = ((y as f64 + 0.5) * source_height as f64 / height as f64 - 0.5)
            .clamp(0.0, max_y as f64);
        let y0 = source_y.floor() as usize;
        let y1 = (y0 + 1).min(max_y);
        let fy = source_y - y0 as f64;
        for x in 0..width as usize {
            let source_x = ((x as f64 + 0.5) * source_width as f64 / width as f64 - 0.5)
                .clamp(0.0, max_x as f64);
            let x0 = source_x.floor() as usize;
            let x1 = (x0 + 1).min(max_x);
            let fx = source_x - x0 as f64;
            for channel in 0..4 {
                let sample = |sample_x: usize, sample_y: usize| {
                    source[(sample_y * source_width as usize + sample_x) * 4 + channel] as f64
                };
                let top = sample(x0, y0) * (1.0 - fx) + sample(x1, y0) * fx;
                let bottom = sample(x0, y1) * (1.0 - fx) + sample(x1, y1) * fx;
                output[(y * width as usize + x) * 4 + channel] =
                    (top * (1.0 - fy) + bottom * fy).round() as u8;
            }
        }
    }
    output
}

fn normalise_png(bytes: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let (source, source_width, source_height) = decode_png_rgba(bytes)?;
    let pixels = resize_rgba(&source, source_width, source_height, width, height);
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        let mut writer = encoder
            .write_header()
            .map_err(|_| "website capture could not start PNG encoding")?;
        writer
            .write_image_data(&pixels)
            .map_err(|_| "website capture could not encode the PNG")?;
    }
    Ok(output)
}

fn store_capture(
    project_dir: &std::path::Path,
    scene_stem: &str,
    png: &[u8],
) -> Result<(String, String), String> {
    let content_hash = hex_bytes(&Sha256::digest(png));
    let assets = project_dir.join("assets").join("website");
    std::fs::create_dir_all(&assets).map_err(|error| error.to_string())?;
    let name = format!("{scene_stem}.png");
    let temporary = assets.join(format!(".{scene_stem}.{}.tmp", &content_hash[..12]));
    std::fs::write(&temporary, png).map_err(|error| error.to_string())?;
    let destination = assets.join(&name);
    if let Err(error) = std::fs::rename(&temporary, &destination) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("replacing website capture: {error}"));
    }
    workspace::touch_now(&destination);
    Ok((format!("assets/website/{name}"), content_hash))
}

fn persistent_grant(
    app: &AppHandle,
    settings: &State<'_, workspace::SettingsState>,
    project_key: &str,
    origin: &str,
) -> Result<bool, String> {
    Ok(workspace::load_settings(app, settings)?
        .website_origin_grants
        .get(project_key)
        .is_some_and(|origins| origins.iter().any(|value| value == origin)))
}

fn close_views_for_revoked_origin(
    state: &State<'_, WebsiteState>,
    project_key: &str,
    origin: &str,
) {
    let children = {
        let Ok(mut registry) = state.0.lock() else {
            return;
        };
        let ids = registry
            .views
            .iter()
            .filter(|(_, view)| {
                view.project_key == project_key
                    && (view.current_origin.as_deref() == Some(origin)
                        || view.authored_url.origin().ascii_serialization() == origin)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| registry.views.remove(&id).map(|view| view.webview))
            .collect::<Vec<_>>()
    };
    for child in children {
        let _ = child.close();
    }
}

fn origin_granted(
    app: &AppHandle,
    settings: &State<'_, workspace::SettingsState>,
    state: &State<'_, WebsiteState>,
    project_key: &str,
    origin: &str,
    loopback: bool,
) -> Result<bool, String> {
    if loopback {
        return Ok(state
            .0
            .lock()
            .map_err(|_| "website state poisoned")?
            .loopback_grants
            .contains(&(project_key.to_owned(), origin.to_owned())));
    }
    persistent_grant(app, settings, project_key, origin)
}

fn emit_to_owner<T: Serialize + Clone>(app: &AppHandle, owner: &str, event: &str, payload: T) {
    if let Some(webview) = app.get_webview(owner) {
        let _ = webview.emit(event, payload);
    }
}

fn emit_origin_request(app: &AppHandle, owner: &str, view_id: &str, origin: &str, loopback: bool) {
    emit_to_owner(
        app,
        owner,
        "kookaburra://website-origin-request",
        WebsiteOriginRequest {
            view_id: view_id.to_owned(),
            origin: origin.to_owned(),
            loopback,
        },
    );
}

fn emit_view_state(
    app: &AppHandle,
    owner: &str,
    view_id: &str,
    state: &'static str,
    origin: Option<String>,
) {
    emit_to_owner(
        app,
        owner,
        "kookaburra://website-state",
        WebsiteViewState {
            view_id: view_id.to_owned(),
            state,
            origin,
        },
    );
}

fn navigation_allowed(app: &AppHandle, view_id: &str, target: &Url) -> bool {
    if target.as_str() == "about:blank" {
        return true;
    }
    let Ok((url, origin, loopback)) = parse_navigation_url(target.as_str()) else {
        return false;
    };
    let website_state = app.state::<WebsiteState>();
    let settings_state = app.state::<workspace::SettingsState>();
    let (owner, project_key, requested) = {
        let Ok(registry) = website_state.0.lock() else {
            return false;
        };
        let Some(view) = registry.views.get(view_id) else {
            return false;
        };
        (
            view.owner.clone(),
            view.project_key.clone(),
            view.requested_origins.contains(&origin),
        )
    };
    let granted = requested
        && origin_granted(
            app,
            &settings_state,
            &website_state,
            &project_key,
            &origin,
            loopback,
        )
        .unwrap_or(false);
    if !granted {
        if let Ok(mut registry) = website_state.0.lock() {
            if let Some(view) = registry.views.get_mut(view_id) {
                view.pending_url = Some(url);
            }
        }
        if owner == "main" {
            emit_origin_request(app, &owner, view_id, &origin, loopback);
        } else {
            emit_view_state(app, &owner, view_id, "blocked", Some(origin));
        }
    }
    granted
}

fn record_load_state(
    app: &AppHandle,
    view_id: &str,
    state: &'static str,
    current_url: Option<&str>,
) {
    let website_state = app.state::<WebsiteState>();
    let origin = current_url
        .and_then(|value| parse_navigation_url(value).ok())
        .map(|(_, origin, _)| origin);
    let owner = {
        let Ok(mut registry) = website_state.0.lock() else {
            return;
        };
        let Some(view) = registry.views.get_mut(view_id) else {
            return;
        };
        view.current_origin = origin.clone();
        view.ready = state == "ready";
        view.owner.clone()
    };
    emit_view_state(app, &owner, view_id, state, origin);
}

fn parent_window(app: &AppHandle, owner: &str) -> Result<Window, String> {
    app.get_window(owner)
        .ok_or_else(|| "website owner window is unavailable".into())
}

fn next_tick(registry: &mut WebsiteRegistry) -> u64 {
    registry.tick = registry.tick.saturating_add(1);
    registry.tick
}

fn effective_page_zoom(bounds: WebsiteBounds, viewport_width: u32, zoom: f64) -> f64 {
    bounds.width / f64::from(viewport_width) * zoom
}

fn evict_if_needed(state: &State<'_, WebsiteState>) -> Result<Option<Webview>, String> {
    let mut registry = state.0.lock().map_err(|_| "website state poisoned")?;
    if registry.views.len() < MAX_WEBSITE_VIEWS {
        return Ok(None);
    }
    let id = registry
        .views
        .iter()
        .filter(|(_, view)| !view.active)
        .min_by_key(|(_, view)| view.used_at)
        .map(|(id, _)| id.clone())
        .ok_or_else(|| "all website views are active".to_string())?;
    Ok(registry.views.remove(&id).map(|view| view.webview))
}

fn make_builder(app: &AppHandle, owner: &str, id: &str) -> WebviewBuilder<tauri::Wry> {
    let navigation_app = app.clone();
    let navigation_id = id.to_owned();
    let load_app = app.clone();
    let load_id = id.to_owned();
    WebviewBuilder::new(
        id,
        WebviewUrl::External(Url::parse("about:blank").expect("valid blank URL")),
    )
    .data_store_identifier(WEBSITE_DATA_STORE)
    .disable_drag_drop_handler()
    .general_autofill_enabled(false)
    .allow_link_preview(false)
    .focused(false)
    .accept_first_mouse(true)
    .devtools(cfg!(debug_assertions) && owner == "main")
    .initialization_script(WEBSITE_INIT_SCRIPT)
    .initialization_script(if owner == "present" {
        PRESENT_INIT_SCRIPT
    } else {
        ""
    })
    .on_navigation(move |url| navigation_allowed(&navigation_app, &navigation_id, url))
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_download(|_, _event| false)
    .on_page_load(move |_, payload| {
        let state = match payload.event() {
            PageLoadEvent::Started => "loading",
            PageLoadEvent::Finished => "ready",
        };
        record_load_state(&load_app, &load_id, state, Some(payload.url().as_str()));
    })
}

#[tauri::command]
pub fn website_open(
    app: AppHandle,
    webview: Webview,
    settings: State<'_, workspace::SettingsState>,
    state: State<'_, WebsiteState>,
    request: WebsiteOpenRequest,
) -> Result<WebsiteOpenResponse, String> {
    let owner = require_caller(&webview, &["main", "present"])?;
    validate_scene_stem(&request.scene_stem)?;
    let bounds = request.bounds.validate()?;
    if !(320..=3_840).contains(&request.viewport_width) {
        return Err("website viewport width is outside the supported range".into());
    }
    if !(240..=2_160).contains(&request.viewport_height) {
        return Err("website viewport height is outside the supported range".into());
    }
    if !request.zoom.is_finite() || !(0.5..=2.0).contains(&request.zoom) {
        return Err("website zoom is outside the supported range".into());
    }
    let project_key = canonical_project_key(&app, &settings, &request.project_path)?;
    let (authored_url, origin, loopback) = parse_website_url(&request.url)?;
    let mut requested_origins = normalise_requested_origins(&request.requested_origins)?;
    requested_origins.insert(origin.clone());
    let id = view_id(&owner, &project_key, &request.scene_stem);
    let granted = origin_granted(&app, &settings, &state, &project_key, &origin, loopback)?;

    if !granted {
        if owner == "main" {
            emit_origin_request(&app, &owner, &id, &origin, loopback);
        }
        return Ok(WebsiteOpenResponse {
            view_id: id,
            state: if owner == "main" {
                "needsGrant"
            } else {
                "blocked"
            },
            origin,
            loopback,
        });
    }

    let existing = {
        let mut registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let used_at = next_tick(&mut registry);
        registry.views.get_mut(&id).map(|view| {
            let should_navigate = view.authored_url != authored_url;
            view.requested_origins = requested_origins.clone();
            view.authored_url = authored_url.clone();
            view.pending_url = None;
            view.bounds = bounds;
            view.viewport_width = request.viewport_width;
            view.viewport_height = request.viewport_height;
            view.zoom = request.zoom;
            view.active = true;
            if should_navigate {
                view.ready = false;
            }
            view.used_at = used_at;
            (view.webview.clone(), should_navigate, view.ready)
        })
    };
    if let Some((existing, should_navigate, ready)) = existing {
        existing
            .set_bounds(bounds.rect())
            .map_err(|error| error.to_string())?;
        set_native_zoom(
            &existing,
            effective_page_zoom(bounds, request.viewport_width, request.zoom),
        )?;
        if should_navigate {
            existing
                .navigate(authored_url)
                .map_err(|error| error.to_string())?;
        }
        return Ok(WebsiteOpenResponse {
            view_id: id,
            state: if ready && !should_navigate {
                "ready"
            } else {
                "loading"
            },
            origin,
            loopback,
        });
    }

    if let Some(evicted) = evict_if_needed(&state)? {
        let _ = evicted.close();
    }
    let child = parent_window(&app, &owner)?
        .add_child(
            make_builder(&app, &owner, &id),
            bounds.position(),
            bounds.size(),
        )
        .map_err(|error| error.to_string())?;
    child.hide().map_err(|error| error.to_string())?;
    if let Err(error) = harden_native_webview(
        &child,
        &app,
        &owner,
        &id,
        effective_page_zoom(bounds, request.viewport_width, request.zoom),
    ) {
        let _ = child.close();
        return Err(error);
    }
    let insertion = (|| -> Result<Vec<Webview>, String> {
        let mut registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let mut displaced = Vec::new();
        if registry.views.len() >= MAX_WEBSITE_VIEWS {
            let candidate = registry
                .views
                .iter()
                .filter(|(_, view)| !view.active)
                .min_by_key(|(_, view)| view.used_at)
                .map(|(id, _)| id.clone())
                .ok_or_else(|| "all website views are active".to_string())?;
            if let Some(view) = registry.views.remove(&candidate) {
                displaced.push(view.webview);
            }
        }
        let used_at = next_tick(&mut registry);
        let replaced = registry.views.insert(
            id.clone(),
            WebsiteView {
                webview: child.clone(),
                owner,
                project_key,
                scene_stem: request.scene_stem,
                requested_origins,
                authored_url: authored_url.clone(),
                pending_url: None,
                current_origin: None,
                bounds,
                viewport_width: request.viewport_width,
                viewport_height: request.viewport_height,
                zoom: request.zoom,
                active: true,
                ready: false,
                used_at,
            },
        );
        if let Some(view) = replaced {
            displaced.push(view.webview);
        }
        Ok(displaced)
    })();
    let displaced = match insertion {
        Ok(displaced) => displaced,
        Err(error) => {
            let _ = child.close();
            return Err(error);
        }
    };
    for displaced in displaced {
        let _ = displaced.close();
    }
    if let Err(error) = child.navigate(authored_url) {
        if let Ok(mut registry) = state.0.lock() {
            registry.views.remove(&id);
        }
        let _ = child.close();
        return Err(error.to_string());
    }
    Ok(WebsiteOpenResponse {
        view_id: id,
        state: "loading",
        origin,
        loopback,
    })
}

#[tauri::command]
pub fn website_show(
    webview: Webview,
    state: State<'_, WebsiteState>,
    view_id: String,
) -> Result<(), String> {
    let owner = require_caller(&webview, &["main", "present"])?;
    let child = {
        let mut registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let used_at = next_tick(&mut registry);
        let view = registry
            .views
            .get_mut(&view_id)
            .ok_or_else(|| "website view is unavailable".to_string())?;
        if view.owner != owner {
            return Err("website view belongs to another window".into());
        }
        if !view.ready {
            return Err("website view is not ready".into());
        }
        view.active = true;
        view.used_at = used_at;
        view.webview.clone()
    };
    child.show().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn website_grant_origin(
    app: AppHandle,
    webview: Webview,
    settings: State<'_, workspace::SettingsState>,
    state: State<'_, WebsiteState>,
    project_path: String,
    origin: String,
) -> Result<(), String> {
    require_caller(&webview, &["main"])?;
    let project_key = canonical_project_key(&app, &settings, &project_path)?;
    let (_, origin, loopback) = parse_navigation_url(&origin)?;
    if loopback {
        state
            .0
            .lock()
            .map_err(|_| "website state poisoned")?
            .loopback_grants
            .insert((project_key, origin));
        return Ok(());
    }
    let mut value = workspace::load_settings(&app, &settings)?;
    let origins = value.website_origin_grants.entry(project_key).or_default();
    if !origins.contains(&origin) {
        origins.push(origin);
        origins.sort();
    }
    workspace::save_settings(&app, &settings, value)
}

#[tauri::command]
pub fn website_revoke_origin(
    app: AppHandle,
    webview: Webview,
    settings: State<'_, workspace::SettingsState>,
    state: State<'_, WebsiteState>,
    project_path: String,
    origin: String,
) -> Result<(), String> {
    require_caller(&webview, &["main"])?;
    let project_key = canonical_project_key(&app, &settings, &project_path)?;
    let (_, origin, loopback) = parse_navigation_url(&origin)?;
    if loopback {
        state
            .0
            .lock()
            .map_err(|_| "website state poisoned")?
            .loopback_grants
            .remove(&(project_key.clone(), origin.clone()));
        close_views_for_revoked_origin(&state, &project_key, &origin);
        return Ok(());
    }
    let mut value = workspace::load_settings(&app, &settings)?;
    if let Some(origins) = value.website_origin_grants.get_mut(&project_key) {
        origins.retain(|value| value != &origin);
        if origins.is_empty() {
            value.website_origin_grants.remove(&project_key);
        }
    }
    workspace::save_settings(&app, &settings, value)?;
    close_views_for_revoked_origin(&state, &project_key, &origin);
    Ok(())
}

#[tauri::command]
pub fn website_list_grants(
    app: AppHandle,
    webview: Webview,
    settings: State<'_, workspace::SettingsState>,
    state: State<'_, WebsiteState>,
    project_path: String,
) -> Result<Vec<String>, String> {
    require_caller(&webview, &["main"])?;
    let project_key = canonical_project_key(&app, &settings, &project_path)?;
    let mut origins = workspace::load_settings(&app, &settings)?
        .website_origin_grants
        .remove(&project_key)
        .unwrap_or_default();
    origins.extend(
        state
            .0
            .lock()
            .map_err(|_| "website state poisoned")?
            .loopback_grants
            .iter()
            .filter(|(key, _)| key == &project_key)
            .map(|(_, origin)| origin.clone()),
    );
    origins.sort();
    origins.dedup();
    Ok(origins)
}

#[tauri::command]
pub fn website_resume_pending(
    app: AppHandle,
    webview: Webview,
    settings: State<'_, workspace::SettingsState>,
    state: State<'_, WebsiteState>,
    view_id: String,
    requested_origins: Vec<String>,
) -> Result<(), String> {
    require_caller(&webview, &["main"])?;
    let mut requested = normalise_requested_origins(&requested_origins)?;
    let (project_key, authored_origin, pending) = {
        let registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let view = registry
            .views
            .get(&view_id)
            .ok_or_else(|| "website view is unavailable".to_string())?;
        if view.owner != "main" {
            return Err("website view belongs to another window".into());
        }
        (
            view.project_key.clone(),
            view.authored_url.origin().ascii_serialization(),
            view.pending_url.clone(),
        )
    };
    requested.insert(authored_origin);
    if let Some(url) = pending.as_ref() {
        let (_, origin, loopback) = parse_navigation_url(url.as_str())?;
        if !requested.contains(&origin) {
            return Err("pending Website origin is not requested by this scene".into());
        }
        if !origin_granted(&app, &settings, &state, &project_key, &origin, loopback)? {
            return Err("pending Website origin is not approved for this project".into());
        }
    }
    let (child, pending) = {
        let mut registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let view = registry
            .views
            .get_mut(&view_id)
            .ok_or_else(|| "website view is unavailable".to_string())?;
        if view.owner != "main" {
            return Err("website view belongs to another window".into());
        }
        if view.pending_url != pending {
            return Err("pending Website navigation changed before approval".into());
        }
        view.requested_origins = requested;
        (view.webview.clone(), view.pending_url.take())
    };
    if let Some(url) = pending {
        child.navigate(url).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn website_set_bounds(
    webview: Webview,
    state: State<'_, WebsiteState>,
    view_id: String,
    bounds: WebsiteBounds,
) -> Result<(), String> {
    let owner = require_caller(&webview, &["main", "present"])?;
    let bounds = bounds.validate()?;
    let (child, effective_zoom) = {
        let mut registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let used_at = next_tick(&mut registry);
        let view = registry
            .views
            .get_mut(&view_id)
            .ok_or_else(|| "website view is unavailable".to_string())?;
        if view.owner != owner {
            return Err("website view belongs to another window".into());
        }
        view.bounds = bounds;
        view.used_at = used_at;
        (
            view.webview.clone(),
            effective_page_zoom(bounds, view.viewport_width, view.zoom),
        )
    };
    child
        .set_bounds(bounds.rect())
        .map_err(|error| error.to_string())?;
    set_native_zoom(&child, effective_zoom)
}

#[tauri::command]
pub fn website_set_zoom(
    webview: Webview,
    state: State<'_, WebsiteState>,
    view_id: String,
    zoom: f64,
) -> Result<(), String> {
    let owner = require_caller(&webview, &["main", "present"])?;
    if !zoom.is_finite() || !(0.5..=2.0).contains(&zoom) {
        return Err("website zoom is outside the supported range".into());
    }
    let (child, effective_zoom) = {
        let mut registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let view = registry
            .views
            .get_mut(&view_id)
            .ok_or_else(|| "website view is unavailable".to_string())?;
        if view.owner != owner {
            return Err("website view belongs to another window".into());
        }
        view.zoom = zoom;
        (
            view.webview.clone(),
            effective_page_zoom(view.bounds, view.viewport_width, zoom),
        )
    };
    set_native_zoom(&child, effective_zoom)
}

#[tauri::command]
pub fn website_action(
    webview: Webview,
    state: State<'_, WebsiteState>,
    view_id: String,
    action: WebsiteAction,
) -> Result<(), String> {
    let owner = require_caller(&webview, &["main", "present"])?;
    let (child, authored_url) = {
        let registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let view = registry
            .views
            .get(&view_id)
            .ok_or_else(|| "website view is unavailable".to_string())?;
        if view.owner != owner {
            return Err("website view belongs to another window".into());
        }
        (view.webview.clone(), view.authored_url.clone())
    };
    match action {
        WebsiteAction::Back => child.eval("history.back()"),
        WebsiteAction::Forward => child.eval("history.forward()"),
        WebsiteAction::Reload => child.reload(),
        WebsiteAction::ReturnToStart => child.navigate(authored_url),
        WebsiteAction::Focus => child.set_focus(),
        WebsiteAction::ReleaseFocus => webview.set_focus(),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn website_capture(
    app: AppHandle,
    webview: Webview,
    settings: State<'_, workspace::SettingsState>,
    state: State<'_, WebsiteState>,
    view_id: String,
) -> Result<WebsiteCaptureResponse, String> {
    require_caller(&webview, &["main"])?;
    let (child, project_key, scene_stem, width, height, source_origin) = {
        let registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let view = registry
            .views
            .get(&view_id)
            .ok_or_else(|| "website view is unavailable".to_string())?;
        if view.owner != "main" {
            return Err("website view belongs to another window".into());
        }
        if !view.active || !view.ready {
            return Err("website view must be visible and ready before capture".into());
        }
        (
            view.webview.clone(),
            view.project_key.clone(),
            view.scene_stem.clone(),
            view.viewport_width,
            view.viewport_height,
            view.current_origin
                .clone()
                .unwrap_or_else(|| view.authored_url.origin().ascii_serialization()),
        )
    };
    let native_png = capture_native_png(&child, width).await?;
    let png = normalise_png(&native_png, width, height)?;
    let project_dir = workspace::confine_readable(&app, &settings, &project_key)?;
    if !project_dir.is_dir() {
        return Err("website project path is no longer available".into());
    }
    let (src, content_hash) = store_capture(&project_dir, &scene_stem, &png)?;
    Ok(WebsiteCaptureResponse {
        src,
        width,
        height,
        source_origin: Some(source_origin),
        content_hash,
    })
}

#[tauri::command]
pub async fn website_import_image(
    app: AppHandle,
    webview: Webview,
    settings: State<'_, workspace::SettingsState>,
    request: WebsiteImportImageRequest,
) -> Result<WebsiteCaptureResponse, String> {
    require_caller(&webview, &["main"])?;
    let WebsiteImportImageRequest {
        project_path,
        scene_stem,
        source_path,
        width,
        height,
        background,
    } = request;
    validate_scene_stem(&scene_stem)?;
    if !(320..=3_840).contains(&width) || !(240..=2_160).contains(&height) {
        return Err("website image dimensions are outside the supported range".into());
    }
    let colour = background
        .strip_prefix('#')
        .filter(|value| value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| "website image background must be an sRGB hex colour".to_string())?;
    let source = std::fs::canonicalize(&source_path)
        .map_err(|error| format!("reading selected Website image: {error}"))?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err("Website image must be PNG, JPEG or WebP".into());
    }
    let metadata = std::fs::metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 250 * 1024 * 1024 {
        return Err("Website image must be a regular file no larger than 250 MB".into());
    }
    let probe = media::probe_media(&app, &source).await?;
    validate_import_source_dimensions(probe.width, probe.height)?;
    let project_dir = workspace::confine_readable(&app, &settings, &project_path)?;
    if !project_dir.is_dir() {
        return Err("website project path is no longer available".into());
    }
    let assets = project_dir.join("assets").join("website");
    std::fs::create_dir_all(&assets).map_err(|error| error.to_string())?;
    let temporary = assets.join(format!(".{scene_stem}.import-{}.png", std::process::id()));
    let filter = format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x{colour}"
    );
    let result = media::run_sidecar(
        &app,
        "ffmpeg",
        vec![
            "-y".into(),
            "-nostdin".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-i".into(),
            source.to_string_lossy().into_owned(),
            "-vf".into(),
            filter,
            "-frames:v".into(),
            "1".into(),
            "-map_metadata".into(),
            "-1".into(),
            temporary.to_string_lossy().into_owned(),
        ],
        media::SidecarPriority::Foreground,
    )
    .await;
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("normalising Website image: {error}"));
    }
    let encoded = std::fs::read(&temporary).map_err(|error| error.to_string());
    let _ = std::fs::remove_file(&temporary);
    let png = normalise_png(&encoded?, width, height)?;
    let (src, content_hash) = store_capture(&project_dir, &scene_stem, &png)?;
    Ok(WebsiteCaptureResponse {
        src,
        width,
        height,
        source_origin: None,
        content_hash,
    })
}

#[tauri::command]
pub fn website_hide(
    webview: Webview,
    state: State<'_, WebsiteState>,
    view_id: String,
) -> Result<(), String> {
    let owner = require_caller(&webview, &["main", "present"])?;
    let child = {
        let mut registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let used_at = next_tick(&mut registry);
        let view = registry
            .views
            .get_mut(&view_id)
            .ok_or_else(|| "website view is unavailable".to_string())?;
        if view.owner != owner {
            return Err("website view belongs to another window".into());
        }
        view.active = false;
        view.used_at = used_at;
        view.webview.clone()
    };
    child.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn website_close(
    webview: Webview,
    state: State<'_, WebsiteState>,
    view_id: String,
) -> Result<(), String> {
    let owner = require_caller(&webview, &["main", "present"])?;
    let child = {
        let mut registry = state.0.lock().map_err(|_| "website state poisoned")?;
        let view = registry
            .views
            .get(&view_id)
            .ok_or_else(|| "website view is unavailable".to_string())?;
        if view.owner != owner {
            return Err("website view belongs to another window".into());
        }
        registry.views.remove(&view_id).map(|value| value.webview)
    };
    if let Some(child) = child {
        child.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn close_owner(state: &State<'_, WebsiteState>, owner: &str) {
    let children = {
        let Ok(mut registry) = state.0.lock() else {
            return;
        };
        let ids: Vec<String> = registry
            .views
            .iter()
            .filter(|(_, view)| view.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| registry.views.remove(&id).map(|value| value.webview))
            .collect::<Vec<_>>()
    };
    for child in children {
        let _ = child.close();
    }
}

fn close_all(state: &State<'_, WebsiteState>) {
    let children = {
        let Ok(mut registry) = state.0.lock() else {
            return;
        };
        registry
            .views
            .drain()
            .map(|(_, value)| value.webview)
            .collect::<Vec<_>>()
    };
    for child in children {
        let _ = child.close();
    }
}

#[cfg(target_os = "macos")]
fn set_native_zoom(webview: &Webview, zoom: f64) -> Result<(), String> {
    use objc2_web_kit::WKWebView;

    webview
        .with_webview(move |platform| unsafe {
            let native = &*(platform.inner() as *mut WKWebView);
            native.setPageZoom(zoom);
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
fn set_native_zoom(_webview: &Webview, _zoom: f64) -> Result<(), String> {
    Err("website content requires macOS".into())
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::c_void;
    use std::ptr::{null_mut, NonNull};
    use std::sync::{Arc, Mutex};

    use block2::{Block, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, ProtocolObject};
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
    };
    use objc2_foundation::{
        MainThreadMarker, NSArray, NSDictionary, NSError, NSNumber, NSObjectProtocol, NSString,
        NSURLAuthenticationChallenge, NSURLAuthenticationMethodServerTrust, NSURLCredential,
        NSURLSessionAuthChallengeDisposition, NSURL, NSUUID,
    };
    use objc2_web_kit::{
        WKAudiovisualMediaTypes, WKFrameInfo, WKMediaCaptureType, WKNavigation, WKNavigationAction,
        WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationResponse,
        WKNavigationResponsePolicy, WKOpenPanelParameters, WKPermissionDecision, WKScriptMessage,
        WKScriptMessageHandler, WKSecurityOrigin, WKSnapshotConfiguration, WKUIDelegate,
        WKUserContentController, WKWebView, WKWebViewConfiguration, WKWebsiteDataRecord,
        WKWebsiteDataStore, WKWindowFeatures,
    };
    use tauri::{Manager, Webview};
    use url::Url;

    use super::{
        emit_to_owner, navigation_allowed, record_load_state, AppHandle, WebsiteDataRecordSummary,
        WebsiteFocusState, WEBSITE_DATA_STORE,
    };

    static mut WEBSITE_UI_DELEGATE_KEY: u8 = 0;
    static mut WEBSITE_NAVIGATION_DELEGATE_KEY: u8 = 0;
    const OBJC_ASSOCIATION_RETAIN_NONATOMIC: usize = 1;

    unsafe extern "C" {
        fn objc_setAssociatedObject(
            object: *const AnyObject,
            key: *const c_void,
            value: *const AnyObject,
            policy: usize,
        );
    }

    type NavigationPolicy = Box<dyn Fn(String) -> bool>;
    type LoadStateHandler = Box<dyn Fn(&WKWebView, &'static str)>;

    struct WebsiteNavigationDelegateIvars {
        allow_navigation: NavigationPolicy,
        on_state: LoadStateHandler,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = WebsiteNavigationDelegateIvars]
        struct WebsiteNavigationDelegate;

        unsafe impl NSObjectProtocol for WebsiteNavigationDelegate {}

        unsafe impl WKNavigationDelegate for WebsiteNavigationDelegate {
            #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
            fn decide_navigation_action(
                &self,
                _webview: &WKWebView,
                action: &WKNavigationAction,
                decision_handler: &Block<dyn Fn(WKNavigationActionPolicy)>,
            ) {
                let policy = unsafe {
                    if action.shouldPerformDownload() {
                        WKNavigationActionPolicy::Cancel
                    } else if action
                        .targetFrame()
                        .is_some_and(|frame| !frame.isMainFrame())
                    {
                        WKNavigationActionPolicy::Allow
                    } else {
                        action
                            .request()
                            .URL()
                            .and_then(|value| value.absoluteString())
                            .map(|value| value.to_string())
                            .filter(|value| (self.ivars().allow_navigation)(value.clone()))
                            .map_or(WKNavigationActionPolicy::Cancel, |_| {
                                WKNavigationActionPolicy::Allow
                            })
                    }
                };
                decision_handler.call((policy,));
            }

            #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
            fn decide_navigation_response(
                &self,
                _webview: &WKWebView,
                response: &WKNavigationResponse,
                decision_handler: &Block<dyn Fn(WKNavigationResponsePolicy)>,
            ) {
                let policy = unsafe {
                    if !response.canShowMIMEType() {
                        WKNavigationResponsePolicy::Cancel
                    } else {
                        WKNavigationResponsePolicy::Allow
                    }
                };
                decision_handler.call((policy,));
            }

            #[unsafe(method(webView:didStartProvisionalNavigation:))]
            fn did_start_navigation(
                &self,
                webview: &WKWebView,
                _navigation: Option<&WKNavigation>,
            ) {
                (self.ivars().on_state)(webview, "loading");
            }

            #[unsafe(method(webView:didFinishNavigation:))]
            fn did_finish_navigation(
                &self,
                webview: &WKWebView,
                _navigation: Option<&WKNavigation>,
            ) {
                (self.ivars().on_state)(webview, "ready");
            }

            #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
            fn did_fail_provisional_navigation(
                &self,
                webview: &WKWebView,
                _navigation: Option<&WKNavigation>,
                _error: &NSError,
            ) {
                (self.ivars().on_state)(webview, "unavailable");
            }

            #[unsafe(method(webView:didFailNavigation:withError:))]
            fn did_fail_navigation(
                &self,
                webview: &WKWebView,
                _navigation: Option<&WKNavigation>,
                _error: &NSError,
            ) {
                (self.ivars().on_state)(webview, "unavailable");
            }

            #[unsafe(method(webViewWebContentProcessDidTerminate:))]
            fn web_content_process_did_terminate(&self, webview: &WKWebView) {
                (self.ivars().on_state)(webview, "unavailable");
            }

            #[unsafe(method(webView:didReceiveAuthenticationChallenge:completionHandler:))]
            fn respond_to_authentication_challenge(
                &self,
                _webview: &WKWebView,
                challenge: &NSURLAuthenticationChallenge,
                completion_handler: &Block<
                    dyn Fn(NSURLSessionAuthChallengeDisposition, *mut NSURLCredential),
                >,
            ) {
                let method = challenge.protectionSpace().authenticationMethod();
                let disposition = if &*method == unsafe { NSURLAuthenticationMethodServerTrust } {
                    NSURLSessionAuthChallengeDisposition::PerformDefaultHandling
                } else {
                    NSURLSessionAuthChallengeDisposition::CancelAuthenticationChallenge
                };
                completion_handler.call((disposition, null_mut()));
            }

            #[unsafe(method(webView:authenticationChallenge:shouldAllowDeprecatedTLS:))]
            fn deny_deprecated_tls(
                &self,
                _webview: &WKWebView,
                _challenge: &NSURLAuthenticationChallenge,
                decision_handler: &Block<dyn Fn(Bool)>,
            ) {
                decision_handler.call((Bool::NO,));
            }
        }
    );

    impl WebsiteNavigationDelegate {
        fn new(
            mtm: MainThreadMarker,
            allow_navigation: NavigationPolicy,
            on_state: LoadStateHandler,
        ) -> Retained<Self> {
            let delegate = mtm.alloc::<WebsiteNavigationDelegate>().set_ivars(
                WebsiteNavigationDelegateIvars {
                    allow_navigation,
                    on_state,
                },
            );
            unsafe { msg_send![super(delegate), init] }
        }
    }

    struct WebsiteUIDelegateIvars;

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = WebsiteUIDelegateIvars]
        struct WebsiteUIDelegate;

        unsafe impl NSObjectProtocol for WebsiteUIDelegate {}

        unsafe impl WKUIDelegate for WebsiteUIDelegate {
            #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
            fn deny_file_upload(
                &self,
                _webview: &WKWebView,
                _parameters: &WKOpenPanelParameters,
                _frame: &WKFrameInfo,
                completion_handler: &Block<dyn Fn(*mut NSArray<NSURL>)>,
            ) {
                completion_handler.call((null_mut(),));
            }

            #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
            fn deny_media_capture(
                &self,
                _webview: &WKWebView,
                _origin: &WKSecurityOrigin,
                _frame: &WKFrameInfo,
                _capture_type: WKMediaCaptureType,
                decision_handler: &Block<dyn Fn(WKPermissionDecision)>,
            ) {
                decision_handler.call((WKPermissionDecision::Deny,));
            }

            #[unsafe(method(webView:requestDeviceOrientationAndMotionPermissionForOrigin:initiatedByFrame:decisionHandler:))]
            fn deny_device_orientation(
                &self,
                _webview: &WKWebView,
                _origin: &WKSecurityOrigin,
                _frame: &WKFrameInfo,
                decision_handler: &Block<dyn Fn(WKPermissionDecision)>,
            ) {
                decision_handler.call((WKPermissionDecision::Deny,));
            }

            #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
            unsafe fn reuse_panel_for_popup(
                &self,
                webview: &WKWebView,
                _configuration: &WKWebViewConfiguration,
                action: &WKNavigationAction,
                _window_features: &WKWindowFeatures,
            ) -> Option<Retained<WKWebView>> {
                webview.loadRequest(&action.request());
                None
            }
        }
    );

    impl WebsiteUIDelegate {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let delegate = mtm
                .alloc::<WebsiteUIDelegate>()
                .set_ivars(WebsiteUIDelegateIvars);
            unsafe { msg_send![super(delegate), init] }
        }
    }

    struct WebsiteMessageHandlerIvars {
        on_focus: Box<dyn Fn(bool)>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = WebsiteMessageHandlerIvars]
        struct WebsiteMessageHandler;

        unsafe impl NSObjectProtocol for WebsiteMessageHandler {}

        unsafe impl WKScriptMessageHandler for WebsiteMessageHandler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            fn receive_message(
                &self,
                _controller: &WKUserContentController,
                message: &WKScriptMessage,
            ) {
                let body = unsafe { message.body() };
                let Some(value) = body.downcast_ref::<NSString>() else {
                    return;
                };
                match value.to_string().as_str() {
                    "acquire" => (self.ivars().on_focus)(true),
                    "release" => (self.ivars().on_focus)(false),
                    _ => {}
                }
            }
        }
    );

    impl WebsiteMessageHandler {
        fn new(mtm: MainThreadMarker, on_focus: Box<dyn Fn(bool)>) -> Retained<Self> {
            let handler = mtm
                .alloc::<WebsiteMessageHandler>()
                .set_ivars(WebsiteMessageHandlerIvars { on_focus });
            unsafe { msg_send![super(handler), init] }
        }
    }

    pub fn harden(
        webview: &Webview,
        app: &AppHandle,
        owner: &str,
        view_id: &str,
        zoom: f64,
    ) -> Result<(), String> {
        let app = app.clone();
        let owner = owner.to_owned();
        let view_id = view_id.to_owned();
        webview
            .with_webview(move |platform| unsafe {
                let native = &*(platform.inner() as *mut WKWebView);
                let configuration = native.configuration();
                configuration
                    .setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes::All);
                configuration.setAllowsAirPlayForMediaPlayback(false);
                native.setPageZoom(zoom);

                let mtm = MainThreadMarker::new().expect("WKWebView runs on the main thread");
                let navigation_app = app.clone();
                let navigation_view_id = view_id.clone();
                let state_app = app.clone();
                let state_view_id = view_id.clone();
                let navigation_delegate = WebsiteNavigationDelegate::new(
                    mtm,
                    Box::new(move |raw_url| {
                        Url::parse(&raw_url).is_ok_and(|url| {
                            navigation_allowed(&navigation_app, &navigation_view_id, &url)
                        })
                    }),
                    Box::new(move |webview, state| {
                        let current_url = webview
                            .URL()
                            .and_then(|value| value.absoluteString())
                            .map(|value| value.to_string());
                        record_load_state(
                            &state_app,
                            &state_view_id,
                            state,
                            current_url.as_deref(),
                        );
                    }),
                );
                native.setNavigationDelegate(Some(ProtocolObject::from_ref(&*navigation_delegate)));
                objc_setAssociatedObject(
                    native as *const WKWebView as *const AnyObject,
                    &raw const WEBSITE_NAVIGATION_DELEGATE_KEY as *const c_void,
                    Retained::as_ptr(&navigation_delegate) as *const AnyObject,
                    OBJC_ASSOCIATION_RETAIN_NONATOMIC,
                );

                let ui_delegate = WebsiteUIDelegate::new(mtm);
                native.setUIDelegate(Some(ProtocolObject::from_ref(&*ui_delegate)));
                objc_setAssociatedObject(
                    native as *const WKWebView as *const AnyObject,
                    &raw const WEBSITE_UI_DELEGATE_KEY as *const c_void,
                    Retained::as_ptr(&ui_delegate) as *const AnyObject,
                    OBJC_ASSOCIATION_RETAIN_NONATOMIC,
                );

                let focus_app = app.clone();
                let focus_owner = owner.clone();
                let focus_view_id = view_id.clone();
                let message_handler = WebsiteMessageHandler::new(
                    mtm,
                    Box::new(move |focused| {
                        if !focused {
                            if let Some(owner_view) = focus_app.get_webview(&focus_owner) {
                                let _ = owner_view.set_focus();
                            }
                        }
                        emit_to_owner(
                            &focus_app,
                            &focus_owner,
                            "kookaburra://website-focus",
                            WebsiteFocusState {
                                view_id: focus_view_id.clone(),
                                focused,
                            },
                        );
                    }),
                );
                let controller = configuration.userContentController();
                controller.addScriptMessageHandler_name(
                    ProtocolObject::from_ref(&*message_handler),
                    &NSString::from_str("kookaburraWebsiteFocus"),
                );
            })
            .map_err(|error| error.to_string())
    }

    unsafe fn image_png(image: *mut NSImage) -> Result<Vec<u8>, String> {
        let image = image
            .as_ref()
            .ok_or_else(|| "WebKit returned no website snapshot".to_string())?;
        let tiff = image
            .TIFFRepresentation()
            .ok_or_else(|| "website snapshot has no image data".to_string())?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
            .ok_or_else(|| "website snapshot could not be converted".to_string())?;
        let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
        let data = bitmap
            .representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
            .ok_or_else(|| "website snapshot could not be encoded".to_string())?;
        let length = data.length();
        let mut bytes = vec![0; length];
        if length > 0 {
            let destination = NonNull::new(bytes.as_mut_ptr().cast::<c_void>())
                .ok_or_else(|| "website snapshot allocation failed".to_string())?;
            data.getBytes_length(destination, length);
        }
        Ok(bytes)
    }

    pub fn snapshot(
        webview: &Webview,
        width: u32,
        sender: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
    ) -> Result<(), String> {
        let sender = Arc::new(Mutex::new(Some(sender)));
        webview
            .with_webview(move |platform| unsafe {
                let native = &*(platform.inner() as *mut WKWebView);
                let mtm = MainThreadMarker::new().expect("WKWebView runs on the main thread");
                let configuration = WKSnapshotConfiguration::new(mtm);
                let snapshot_width = NSNumber::numberWithDouble(f64::from(width));
                configuration.setSnapshotWidth(Some(&snapshot_width));
                configuration.setAfterScreenUpdates(true);
                let callback_sender = sender.clone();
                let callback = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                    let result = image_png(image);
                    if let Ok(mut sender) = callback_sender.lock() {
                        if let Some(sender) = sender.take() {
                            let _ = sender.send(result);
                        }
                    }
                });
                native.takeSnapshotWithConfiguration_completionHandler(
                    Some(&configuration),
                    &callback,
                );
            })
            .map_err(|error| error.to_string())
    }

    fn website_data_store(mtm: MainThreadMarker) -> Retained<WKWebsiteDataStore> {
        let identifier = NSUUID::from_bytes(WEBSITE_DATA_STORE);
        unsafe { WKWebsiteDataStore::dataStoreForIdentifier(&identifier, mtm) }
    }

    pub fn list_data(
        sender: tokio::sync::oneshot::Sender<Result<Vec<WebsiteDataRecordSummary>, String>>,
    ) {
        let mtm = MainThreadMarker::new().expect("Website data runs on the main thread");
        let store = website_data_store(mtm);
        let types = unsafe { WKWebsiteDataStore::allWebsiteDataTypes(mtm) };
        let sender = Arc::new(Mutex::new(Some(sender)));
        let callback = RcBlock::new(move |records: NonNull<NSArray<WKWebsiteDataRecord>>| {
            let records = unsafe { records.as_ref() };
            let mut summaries = records
                .to_vec()
                .into_iter()
                .map(|record| WebsiteDataRecordSummary {
                    display_name: unsafe { record.displayName() }.to_string(),
                    data_types: unsafe { record.dataTypes() }
                        .to_vec()
                        .into_iter()
                        .map(|value| value.to_string())
                        .collect(),
                })
                .collect::<Vec<_>>();
            summaries.sort_by(|left, right| left.display_name.cmp(&right.display_name));
            if let Ok(mut sender) = sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(Ok(summaries));
                }
            }
        });
        unsafe { store.fetchDataRecordsOfTypes_completionHandler(&types, &callback) };
    }

    pub fn clear_data(
        display_name: Option<String>,
        sender: tokio::sync::oneshot::Sender<Result<(), String>>,
    ) {
        let mtm = MainThreadMarker::new().expect("Website data runs on the main thread");
        let store = website_data_store(mtm);
        let types = unsafe { WKWebsiteDataStore::allWebsiteDataTypes(mtm) };
        let fetch_store = store.clone();
        let fetch_types = types.clone();
        let sender = Arc::new(Mutex::new(Some(sender)));
        let fetch_sender = sender.clone();
        let callback = RcBlock::new(move |records: NonNull<NSArray<WKWebsiteDataRecord>>| {
            let records = unsafe { records.as_ref() };
            let selected = records
                .to_vec()
                .into_iter()
                .filter(|record| match display_name.as_ref() {
                    Some(name) => unsafe { record.displayName() }.to_string() == *name,
                    None => true,
                })
                .collect::<Vec<_>>();
            if selected.is_empty() {
                if let Ok(mut sender) = fetch_sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Ok(()));
                    }
                }
                return;
            }
            let selected = NSArray::from_retained_slice(&selected);
            let completion_sender = fetch_sender.clone();
            let completion = RcBlock::new(move || {
                if let Ok(mut sender) = completion_sender.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Ok(()));
                    }
                }
            });
            unsafe {
                fetch_store.removeDataOfTypes_forDataRecords_completionHandler(
                    &fetch_types,
                    &selected,
                    &completion,
                )
            };
        });
        unsafe { store.fetchDataRecordsOfTypes_completionHandler(&types, &callback) };
    }
}

#[cfg(target_os = "macos")]
async fn capture_native_png(webview: &Webview, width: u32) -> Result<Vec<u8>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    macos::snapshot(webview, width, sender)?;
    tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "website capture timed out".to_string())?
        .map_err(|_| "website capture was cancelled".to_string())?
}

#[tauri::command]
pub async fn website_list_data(
    app: AppHandle,
    webview: Webview,
) -> Result<Vec<WebsiteDataRecordSummary>, String> {
    require_caller(&webview, &["settings"])?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || macos::list_data(sender))
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "listing Website data timed out".to_string())?
        .map_err(|_| "listing Website data was cancelled".to_string())?
}

#[tauri::command]
pub async fn website_clear_data(
    app: AppHandle,
    webview: Webview,
    state: State<'_, WebsiteState>,
    display_name: Option<String>,
) -> Result<(), String> {
    require_caller(&webview, &["settings"])?;
    if display_name.as_ref().is_some_and(|value| value.is_empty()) {
        return Err("Website data record name cannot be empty".into());
    }
    close_all(&state);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || macos::clear_data(display_name, sender))
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "clearing Website data timed out".to_string())?
        .map_err(|_| "clearing Website data was cancelled".to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn capture_native_png(_webview: &Webview, _width: u32) -> Result<Vec<u8>, String> {
    Err("website content requires macOS".into())
}

#[cfg(target_os = "macos")]
fn harden_native_webview(
    webview: &Webview,
    app: &AppHandle,
    owner: &str,
    view_id: &str,
    zoom: f64,
) -> Result<(), String> {
    macos::harden(webview, app, owner, view_id, zoom)
}

#[cfg(not(target_os = "macos"))]
fn harden_native_webview(
    _webview: &Webview,
    _app: &AppHandle,
    _owner: &str,
    _view_id: &str,
    _zoom: f64,
) -> Result<(), String> {
    Err("website content requires macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_https_is_allowed() {
        let (_, origin, loopback) =
            parse_website_url("https://example.com/demo?q=1#slide").unwrap();
        assert_eq!(origin, "https://example.com");
        assert!(!loopback);
    }

    #[test]
    fn loopback_requires_http_or_https_and_an_explicit_port() {
        assert!(parse_website_url("http://localhost:5173/demo").is_ok());
        assert!(parse_website_url("https://127.0.0.1:8443/demo").is_ok());
        let (default_port, _, _) = parse_website_url("https://localhost:443/demo").unwrap();
        assert!(parse_navigation_url(default_port.as_str()).is_ok());
        assert!(parse_website_url("http://[::1]:3000/demo").is_ok());
        assert!(parse_website_url("http://localhost/demo").is_err());
        assert!(parse_website_url("https://localhost/demo").is_err());
        assert_eq!(
            normalise_requested_origins(&["http://localhost".into()]).unwrap(),
            HashSet::from(["http://localhost".into()])
        );
    }

    #[test]
    fn imported_image_dimensions_are_bounded_before_decode() {
        assert!(validate_import_source_dimensions(4_096, 4_096).is_ok());
        assert!(validate_import_source_dimensions(0, 900).is_err());
        assert!(validate_import_source_dimensions(20_000, 1).is_err());
        assert!(validate_import_source_dimensions(16_384, 16_384).is_err());
    }

    #[test]
    fn unsafe_schemes_remote_http_and_credentials_are_rejected() {
        for value in [
            "http://example.com",
            "file:///tmp/demo.html",
            "data:text/html,hello",
            "javascript:alert(1)",
            "https://user:secret@example.com",
        ] {
            assert!(parse_website_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn view_ids_are_stable_and_do_not_expose_paths() {
        let first = view_id("main", "/private/project", "01-intro");
        assert_eq!(first, view_id("main", "/private/project", "01-intro"));
        assert_ne!(first, view_id("present", "/private/project", "01-intro"));
        assert!(!first.contains("private"));
    }

    #[test]
    fn only_local_app_webviews_are_trusted_invokers() {
        for label in ["main", "present", "settings", "render", "editor", "packs"] {
            assert!(trusted_invoke_label(label));
        }
        assert!(!trusted_invoke_label("website-deadbeef"));
    }

    #[test]
    fn scene_stems_and_bounds_are_confined() {
        assert!(validate_scene_stem("01-intro").is_ok());
        assert!(validate_scene_stem("../escape").is_err());
        assert!(WebsiteBounds {
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 800.0,
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn page_zoom_preserves_the_authored_css_viewport() {
        let bounds = WebsiteBounds {
            x: 0.0,
            y: 0.0,
            width: 720.0,
            height: 450.0,
        };
        assert_eq!(effective_page_zoom(bounds, 1_440, 1.0), 0.5);
        assert_eq!(effective_page_zoom(bounds, 1_440, 1.5), 0.75);
    }

    #[test]
    fn capture_normalisation_outputs_exact_srgb_rgba_dimensions() {
        let mut source = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut source, 2, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[255, 0, 0, 0, 0, 255]).unwrap();
        }
        let output = normalise_png(&source, 4, 2).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(output));
        let reader = decoder.read_info().unwrap();
        assert_eq!((reader.info().width, reader.info().height), (4, 2));
        assert_eq!(reader.info().color_type, png::ColorType::Rgba);
        assert!(reader.info().srgb.is_some());
    }
}
