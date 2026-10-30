//! Workspace brands: `<workspaceRoot>/brands/<slug>/` holds `brand.json`, `guidelines.md` and `images/<category>/…`, built by an agent skill (no builder UI). The brand's themes, fonts and gradients live in their usual workspace folders and are only referenced here. Parsing is lenient: a bad field is dropped with a warning, and only an unreadable file or a missing name skips the brand.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, State};

use crate::live_edits::{self, FileWrite};
use crate::media::{self, MediaMeta};
use crate::workspace::{self, SettingsState, MANIFEST_FILENAME};

/// The brands folder inside the workspace root.
pub const BRANDS_DIR_NAME: &str = "brands";
const BRAND_FILENAME: &str = "brand.json";
const DEFAULT_GUIDELINES: &str = "guidelines.md";
const IMAGES_DIR: &str = "images";
/// The project-side copy of the applied brand's guidelines, rewritten on every apply.
pub const PROJECT_BRAND_DOC: &str = "BRAND.md";
const BRAND_ID_PREFIX: &str = "ws:";

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandTypography {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandFont {
    pub family: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandColour {
    pub name: String,
    pub hex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandSummary {
    pub slug: String,
    /// `ws:<slug>`, the value a project's `brand` key holds.
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub themes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_theme: Option<String>,
    pub typography: BrandTypography,
    pub colors: Vec<BrandColour>,
    pub gradients: Vec<String>,
    pub fonts: Vec<BrandFont>,
    pub has_guidelines: bool,
    /// Whether `images/` holds at least one listable image (the Library only offers a brand that does).
    pub has_images: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrandImage {
    /// Absolute path: the webview previews it via the asset protocol, and copy-on-use imports it.
    pub path: String,
    /// Relative to the brand's `images/`, always `/`-separated.
    pub rel: String,
    /// The first folder under `images/` (logos, backgrounds…); empty for a file directly inside it.
    pub category: String,
    pub name: String,
    pub bytes: u64,
    pub modified_ms: u64,
}

/// A parsed brand.json plus the guidelines file it names (relative to the brand folder).
#[derive(Debug, Clone, PartialEq)]
struct ParsedBrand {
    summary: BrandSummary,
    guidelines: String,
}

pub(crate) fn brands_root(
    app: &AppHandle,
    state: &State<'_, SettingsState>,
) -> Result<PathBuf, String> {
    Ok(workspace::require_root(app, state)?.join(BRANDS_DIR_NAME))
}

/// `ws:<slug>` to its validated slug.
fn brand_slug_of(id: &str) -> Result<&str, String> {
    let slug = id
        .strip_prefix(BRAND_ID_PREFIX)
        .ok_or_else(|| format!("brand ids look like ws:<slug>, got {id:?}"))?;
    workspace::validate_slug(slug).map_err(|_| format!("invalid brand id: {id:?}"))?;
    Ok(slug)
}

fn opt_string(doc: &Value, key: &str, slug: &str) -> Option<String> {
    match doc.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Some(Value::String(_)) => None,
        Some(_) => {
            log::warn!("brand {slug}: `{key}` isn't a string, ignored");
            None
        }
    }
}

fn string_list(doc: &Value, key: &str, slug: &str) -> Vec<String> {
    match doc.get(key) {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item.as_str().map(str::trim) {
                Some(s) if !s.is_empty() => Some(s.to_owned()),
                _ => {
                    log::warn!("brand {slug}: a `{key}` entry isn't a string, skipped");
                    None
                }
            })
            .collect(),
        Some(_) => {
            log::warn!("brand {slug}: `{key}` isn't an array, ignored");
            Vec::new()
        }
    }
}

fn is_hex_colour(hex: &str) -> bool {
    let Some(digits) = hex.strip_prefix('#') else {
        return false;
    };
    matches!(digits.len(), 3 | 6 | 8) && digits.chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_colours(doc: &Value, slug: &str) -> Vec<BrandColour> {
    let Some(items) = doc.get("colors").and_then(Value::as_array) else {
        if doc.get("colors").is_some_and(|v| !v.is_null()) {
            log::warn!("brand {slug}: `colors` isn't an array, ignored");
        }
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let hex = item.get("hex").and_then(Value::as_str).map(str::trim)?;
            if !is_hex_colour(hex) {
                log::warn!("brand {slug}: colour {hex:?} isn't a #hex value, skipped");
                return None;
            }
            let name = opt_string(item, "name", slug).unwrap_or_else(|| hex.to_owned());
            Some(BrandColour {
                name,
                hex: hex.to_owned(),
                role: opt_string(item, "role", slug),
                note: opt_string(item, "note", slug),
            })
        })
        .collect()
}

fn parse_fonts(doc: &Value, slug: &str) -> Vec<BrandFont> {
    let Some(items) = doc.get("fonts").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let family = item.get("family").and_then(Value::as_str).map(str::trim)?;
            if family.is_empty() {
                log::warn!("brand {slug}: a font has no family, skipped");
                return None;
            }
            let weight = item
                .get("weight")
                .and_then(Value::as_u64)
                .and_then(|w| u32::try_from(w).ok());
            Some(BrandFont {
                family: family.to_owned(),
                weight,
            })
        })
        .collect()
}

/// A guidelines name that stays inside the brand folder.
fn safe_relative(rel: &str) -> bool {
    let path = Path::new(rel);
    !rel.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

fn parse_brand(slug: &str, text: &str) -> Result<ParsedBrand, String> {
    let doc: Value =
        serde_json::from_str(text).map_err(|e| format!("brand.json isn't valid JSON: {e}"))?;
    if !doc.is_object() {
        return Err("brand.json must be a JSON object".into());
    }
    let name = opt_string(&doc, "name", slug).ok_or("brand.json needs a name")?;
    match doc.get("version").and_then(Value::as_u64) {
        Some(1) => {}
        other => log::warn!("brand {slug}: version {other:?} isn't 1, reading it as v1"),
    }
    let typography = doc
        .get("typography")
        .filter(|t| t.is_object())
        .map(|t| BrandTypography {
            headline: opt_string(t, "headline", slug),
            body: opt_string(t, "body", slug),
        })
        .unwrap_or_default();
    let guidelines = match opt_string(&doc, "guidelines", slug) {
        Some(rel) if safe_relative(&rel) => rel,
        Some(rel) => {
            log::warn!("brand {slug}: guidelines path {rel:?} leaves the brand folder, ignored");
            DEFAULT_GUIDELINES.to_owned()
        }
        None => DEFAULT_GUIDELINES.to_owned(),
    };
    Ok(ParsedBrand {
        summary: BrandSummary {
            slug: slug.to_owned(),
            id: format!("{BRAND_ID_PREFIX}{slug}"),
            name,
            description: opt_string(&doc, "description", slug),
            themes: string_list(&doc, "themes", slug),
            default_theme: opt_string(&doc, "defaultTheme", slug),
            typography,
            colors: parse_colours(&doc, slug),
            gradients: string_list(&doc, "gradients", slug),
            fonts: parse_fonts(&doc, slug),
            has_guidelines: false,
            has_images: false,
        },
        guidelines,
    })
}

fn parse_brand_at(dir: &Path, slug: &str) -> Result<ParsedBrand, String> {
    let text = std::fs::read_to_string(dir.join(BRAND_FILENAME))
        .map_err(|e| format!("reading {BRAND_FILENAME}: {e}"))?;
    parse_brand(slug, &text)
}

/// Read one brand folder: its parsed brand.json with the on-disk facts (guidelines present, any image) filled in.
fn read_brand(dir: &Path, slug: &str) -> Result<ParsedBrand, String> {
    let mut parsed = parse_brand_at(dir, slug)?;
    parsed.summary.has_guidelines = dir.join(&parsed.guidelines).is_file();
    parsed.summary.has_images = has_listable_image(&dir.join(IMAGES_DIR));
    Ok(parsed)
}

fn list_brands_in(root: &Path) -> Vec<BrandSummary> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new(); // no brands folder yet; an empty list, not an error
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Some(slug) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if workspace::validate_slug(&slug).is_err() || !entry.path().is_dir() {
            continue;
        }
        if !entry.path().join(BRAND_FILENAME).is_file() {
            continue;
        }
        match read_brand(&entry.path(), &slug) {
            Ok(parsed) => out.push(parsed.summary),
            Err(e) => log::warn!("skipping brand {slug}: {e}"),
        }
    }
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.slug.cmp(&b.slug))
    });
    out
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn walk_images(base: &Path, dir: &Path, out: &mut Vec<BrandImage>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        // Symlinks are skipped so the walk can never leave the brand folder.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if name.starts_with('.') || kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            walk_images(base, &path, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !workspace::IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            continue;
        }
        let Ok(rel_path) = path.strip_prefix(base) else {
            continue;
        };
        let parts: Vec<String> = rel_path
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect();
        let category = if parts.len() > 1 {
            parts[0].clone()
        } else {
            String::new()
        };
        let meta = entry.metadata().ok();
        out.push(BrandImage {
            path: path.to_string_lossy().into_owned(),
            rel: parts.join("/"),
            category,
            name,
            bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified_ms: meta.as_ref().map(modified_ms).unwrap_or(0),
        });
    }
}

/// Whether `dir` holds a listable image at any depth (the `walk_images` rules), stopping at the first.
fn has_listable_image(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let Ok(kind) = entry.file_type() else {
            return false;
        };
        if entry.file_name().to_string_lossy().starts_with('.') || kind.is_symlink() {
            return false;
        }
        let path = entry.path();
        if kind.is_dir() {
            return has_listable_image(&path);
        }
        path.extension()
            .and_then(|e| e.to_str())
            .is_some_and(|ext| workspace::IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
    })
}

/// Every listable image under `<brand>/images/`, sorted by category then path.
fn list_images_in(brand_dir: &Path) -> Vec<BrandImage> {
    let base = brand_dir.join(IMAGES_DIR);
    let mut out = Vec::new();
    walk_images(&base, &base, &mut out);
    out.sort_by(|a, b| a.category.cmp(&b.category).then_with(|| a.rel.cmp(&b.rel)));
    out
}

fn read_manifest(project: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(project.join(MANIFEST_FILENAME))
        .map_err(|e| format!("reading project.json: {e}"))?;
    let manifest: Value =
        serde_json::from_str(&text).map_err(|e| format!("project.json isn't valid JSON: {e}"))?;
    if !manifest.is_object() {
        return Err("project.json must be a JSON object".into());
    }
    Ok(manifest)
}

/// project.json's tracked write (the `set_project_theme` contract: atomic, stamped, hashed).
fn write_manifest(project: &Path, manifest: &Value) -> Result<FileWrite, String> {
    let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    let landed = live_edits::write_bytes_checked(
        &project.join(MANIFEST_FILENAME),
        MANIFEST_FILENAME,
        (text + "\n").as_bytes(),
        None,
    )?;
    Ok(FileWrite {
        file: MANIFEST_FILENAME.to_string(),
        hash: landed.hash,
        before: landed.before,
        stamp: landed.stamp,
    })
}

/// The manifest half of applying a brand: the `brand` key, the default theme, and the headline/body faces (other typography slots kept).
fn apply_brand_to_manifest(manifest: &mut Value, brand: &BrandSummary) {
    manifest["brand"] = json!(brand.id);
    if let Some(theme) = &brand.default_theme {
        manifest["themeId"] = json!(theme);
    }
    let faces = [
        ("headline", &brand.typography.headline),
        ("body", &brand.typography.body),
    ];
    if faces.iter().all(|(_, v)| v.is_none()) {
        return;
    }
    let mut block = manifest
        .get("typography")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    for (slot, value) in faces {
        if let Some(v) = value {
            block.insert(slot.into(), json!(v));
        }
    }
    manifest["typography"] = Value::Object(block);
}

fn remove_brand_doc(project: &Path) -> Result<(), String> {
    let doc = project.join(PROJECT_BRAND_DOC);
    if doc.is_file() {
        std::fs::remove_file(&doc).map_err(|e| format!("removing {PROJECT_BRAND_DOC}: {e}"))?;
    }
    Ok(())
}

/// BRAND.md lands only after the manifest write succeeds, so a failed apply never pairs one brand's guidelines with another's manifest.
pub(crate) fn apply_brand_at(
    project: &Path,
    brand_dir: &Path,
    brand_slug: &str,
) -> Result<FileWrite, String> {
    let parsed = parse_brand_at(brand_dir, brand_slug)?;
    let mut manifest = read_manifest(project)?;
    let guidelines = brand_dir.join(&parsed.guidelines);
    let doc = project.join(PROJECT_BRAND_DOC);
    let staged = doc.with_extension("md.tmp");
    if guidelines.is_file() {
        std::fs::copy(&guidelines, &staged)
            .map_err(|e| format!("reading {}: {e}", guidelines.display()))?;
    }
    apply_brand_to_manifest(&mut manifest, &parsed.summary);
    let write = match write_manifest(project, &manifest) {
        Ok(write) => write,
        Err(e) => {
            let _ = std::fs::remove_file(&staged);
            return Err(e);
        }
    };
    if guidelines.is_file() {
        std::fs::rename(&staged, &doc).map_err(|e| e.to_string())?;
    } else {
        remove_brand_doc(project)?; // never leave the previous brand's guidelines behind
    }
    Ok(write)
}

pub(crate) fn clear_brand_at(project: &Path) -> Result<FileWrite, String> {
    let mut manifest = read_manifest(project)?;
    if let Some(obj) = manifest.as_object_mut() {
        obj.remove("brand");
    }
    let write = write_manifest(project, &manifest)?;
    remove_brand_doc(project)?;
    Ok(write)
}

/// Every workspace brand with a readable brand.json, sorted by name.
#[tauri::command]
pub fn list_brands(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<BrandSummary>, String> {
    Ok(list_brands_in(&brands_root(&app, &state)?))
}

/// The brand's png/jpg/webp images (svg originals beside them are skipped).
#[tauri::command]
pub fn list_brand_images(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
) -> Result<Vec<BrandImage>, String> {
    workspace::validate_slug(&slug)?;
    let dir = brands_root(&app, &state)?.join(&slug);
    if !dir.join(BRAND_FILENAME).is_file() {
        return Err(format!("no brand named \"{slug}\""));
    }
    Ok(list_images_in(&dir))
}

/// Card metadata and a cached poster for one brand image (the shared content-hash media cache), so the grid never decodes multi-MB originals.
#[tauri::command]
pub async fn brand_image_meta(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    rel: String,
) -> Result<MediaMeta, String> {
    workspace::validate_slug(&slug)?;
    if !safe_relative(&rel) {
        return Err(format!("invalid brand image path: {rel:?}"));
    }
    let base = brands_root(&app, &state)?.join(&slug).join(IMAGES_DIR);
    let abs = workspace::confine_to_roots(
        &base.join(&rel).to_string_lossy(),
        std::slice::from_ref(&base),
    )?;
    if !abs.is_file() {
        return Err(format!("brand image not found: {rel}"));
    }
    media::ensure_media_cache(&app, &abs, &rel).await
}

/// Apply (`ws:<slug>`) or clear (null) a project's brand: the `brand` key, the default theme and headline/body fonts, and `BRAND.md` (the guidelines copy). Clearing leaves theme and fonts as they are.
#[tauri::command]
pub fn set_project_brand(
    app: AppHandle,
    state: State<'_, SettingsState>,
    slug: String,
    brand: Option<String>,
) -> Result<FileWrite, String> {
    workspace::restamping_trust(&app, &state, &slug, || {
        let project = workspace::project_dir_mut(&app, &state, &slug)?;
        match brand.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            Some(id) => {
                let brand_slug = brand_slug_of(id)?;
                let dir = brands_root(&app, &state)?.join(brand_slug);
                if !dir.join(BRAND_FILENAME).is_file() {
                    return Err(format!("no brand named \"{brand_slug}\""));
                }
                apply_brand_at(&project, &dir, brand_slug)
            }
            None => clear_brand_at(&project),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kookaburra-brands-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const ACME: &str = r##"{
      "version": 1,
      "name": "Acme",
      "description": "One-line summary.",
      "guidelines": "guidelines.md",
      "themes": ["ws:acme-dark", "ws:acme-light", 7],
      "defaultTheme": "ws:acme-dark",
      "typography": { "headline": "Acme Serif@400", "body": "Acme Sans@500" },
      "fonts": [{ "family": "Acme Serif", "weight": 400 }, { "family": "Acme Sans" }, { "weight": 9 }],
      "colors": [
        { "name": "Ink", "hex": "#151E29", "role": "primary", "note": "Default background." },
        { "name": "Broken", "hex": "blue" },
        { "hex": "#fff" }
      ],
      "gradients": ["acme-ink-glow"]
    }"##;

    fn acme_brand(root: &Path) -> PathBuf {
        let dir = root.join(BRANDS_DIR_NAME).join("acme");
        std::fs::create_dir_all(dir.join("images/logos/mono")).unwrap();
        std::fs::create_dir_all(dir.join("images/backgrounds")).unwrap();
        std::fs::create_dir_all(dir.join("images/.hidden")).unwrap();
        std::fs::write(dir.join(BRAND_FILENAME), ACME).unwrap();
        std::fs::write(dir.join("guidelines.md"), "# Acme\n\nUse Ink.\n").unwrap();
        for rel in [
            "images/logos/acme.png",
            "images/logos/acme.svg",
            "images/logos/mono/acme-white.PNG",
            "images/backgrounds/ink.jpg",
            "images/backgrounds/notes.txt",
            "images/loose.webp",
            "images/.hidden/secret.png",
        ] {
            std::fs::write(dir.join(rel), b"img").unwrap();
        }
        dir
    }

    fn project(root: &Path) -> PathBuf {
        let dir = root.join("product-tour");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(MANIFEST_FILENAME),
            r#"{"id":"product-tour","name":"Product tour","themeId":"kookaburra-default","formats":["16:9"],"scenes":[],"typography":{"chart":"Mono@400"},"custom":{"keep":true}}"#,
        )
        .unwrap();
        dir
    }

    #[test]
    fn lists_brands_leniently_and_skips_invalid_ones() {
        let root = scratch("list");
        acme_brand(&root);
        let brands = root.join(BRANDS_DIR_NAME);
        std::fs::create_dir_all(brands.join("broken")).unwrap();
        std::fs::write(brands.join("broken").join(BRAND_FILENAME), "{ nope").unwrap();
        std::fs::create_dir_all(brands.join("nameless")).unwrap();
        std::fs::write(
            brands.join("nameless").join(BRAND_FILENAME),
            r#"{"version":1}"#,
        )
        .unwrap();
        std::fs::create_dir_all(brands.join("empty-folder")).unwrap();
        std::fs::create_dir_all(brands.join("beta")).unwrap();
        std::fs::write(
            brands.join("beta").join(BRAND_FILENAME),
            r#"{"name":"Beta"}"#,
        )
        .unwrap();

        let list = list_brands_in(&brands);
        assert_eq!(
            list.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(),
            ["ws:acme", "ws:beta"]
        );
        let acme = &list[0];
        assert_eq!(acme.name, "Acme");
        assert_eq!(acme.themes, ["ws:acme-dark", "ws:acme-light"]);
        assert_eq!(acme.default_theme.as_deref(), Some("ws:acme-dark"));
        assert_eq!(acme.typography.headline.as_deref(), Some("Acme Serif@400"));
        assert_eq!(
            acme.colors
                .iter()
                .map(|c| c.hex.as_str())
                .collect::<Vec<_>>(),
            ["#151E29", "#fff"]
        );
        assert_eq!(acme.colors[0].note.as_deref(), Some("Default background."));
        assert_eq!(acme.colors[1].name, "#fff");
        assert_eq!(acme.fonts.len(), 2);
        assert_eq!(acme.fonts[1].weight, None);
        assert_eq!(acme.gradients, ["acme-ink-glow"]);
        assert!(acme.has_guidelines);
        assert!(acme.has_images);
        let beta = &list[1];
        assert!(beta.themes.is_empty() && beta.colors.is_empty() && !beta.has_guidelines);
        assert!(!beta.has_images);
        assert!(list_brands_in(&root.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lists_raster_images_by_category_then_path() {
        let root = scratch("images");
        let dir = acme_brand(&root);
        let images = list_images_in(&dir);
        assert_eq!(
            images
                .iter()
                .map(|i| (i.category.as_str(), i.rel.as_str()))
                .collect::<Vec<_>>(),
            [
                ("", "loose.webp"),
                ("backgrounds", "backgrounds/ink.jpg"),
                ("logos", "logos/acme.png"),
                ("logos", "logos/mono/acme-white.PNG"),
            ]
        );
        assert_eq!(images[2].name, "acme.png");
        assert_eq!(images[2].bytes, 3);
        assert!(Path::new(&images[2].path).is_absolute());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn applying_sets_brand_theme_fonts_and_brand_doc() {
        let root = scratch("apply");
        let brand = acme_brand(&root);
        let project = project(&root);
        let write = apply_brand_at(&project, &brand, "acme").unwrap();
        assert_eq!(write.file, MANIFEST_FILENAME);
        let manifest = read_manifest(&project).unwrap();
        assert_eq!(manifest["brand"], "ws:acme");
        assert_eq!(manifest["themeId"], "ws:acme-dark");
        assert_eq!(manifest["typography"]["headline"], "Acme Serif@400");
        assert_eq!(manifest["typography"]["body"], "Acme Sans@500");
        assert_eq!(manifest["typography"]["chart"], "Mono@400");
        assert_eq!(manifest["custom"]["keep"], true);
        assert_eq!(
            std::fs::read_to_string(project.join(PROJECT_BRAND_DOC)).unwrap(),
            "# Acme\n\nUse Ink.\n"
        );

        // A brand without guidelines, theme or fonts swaps in cleanly and drops the stale doc.
        let bare = root.join(BRANDS_DIR_NAME).join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        std::fs::write(bare.join(BRAND_FILENAME), r#"{"version":1,"name":"Bare"}"#).unwrap();
        apply_brand_at(&project, &bare, "bare").unwrap();
        let manifest = read_manifest(&project).unwrap();
        assert_eq!(manifest["brand"], "ws:bare");
        assert_eq!(manifest["themeId"], "ws:acme-dark");
        assert!(!project.join(PROJECT_BRAND_DOC).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_removes_the_key_and_doc_but_keeps_theme_and_fonts() {
        let root = scratch("clear");
        let brand = acme_brand(&root);
        let project = project(&root);
        apply_brand_at(&project, &brand, "acme").unwrap();
        clear_brand_at(&project).unwrap();
        let manifest = read_manifest(&project).unwrap();
        assert!(manifest.get("brand").is_none());
        assert_eq!(manifest["themeId"], "ws:acme-dark");
        assert_eq!(manifest["typography"]["headline"], "Acme Serif@400");
        assert!(!project.join(PROJECT_BRAND_DOC).exists());
        // Clearing an unbranded project is a harmless no-op.
        clear_brand_at(&project).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ids_and_paths_refuse_traversal() {
        assert_eq!(brand_slug_of("ws:acme").unwrap(), "acme");
        assert!(brand_slug_of("acme").is_err());
        assert!(brand_slug_of("ws:../etc").is_err());
        assert!(brand_slug_of("ws:").is_err());
        assert!(safe_relative("logos/acme.png"));
        assert!(!safe_relative("../acme.png"));
        assert!(!safe_relative("/etc/passwd"));
        assert!(!safe_relative(""));
        let parsed = parse_brand("acme", r#"{"name":"Acme","guidelines":"../x.md"}"#).unwrap();
        assert_eq!(parsed.guidelines, DEFAULT_GUIDELINES);
    }
}
