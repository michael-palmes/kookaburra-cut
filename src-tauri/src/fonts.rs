//! System-font pinning: themes may reference any installed font family; the first reference pins it, copying (or extracting from a .ttc collection) the face into `<workspaceRoot>/fonts/` and recording it in `fonts.json`, so exports depend on the pinned bytes rather than the OS font that drifts with macOS updates; enumeration/lookup runs through Core Text, the frontend owns resolution and fallback (`src/theme/fonts.ts`), and troika only consumes ttf/otf/woff, hence the .ttc extraction.
//! Variable fonts: troika parses no `fvar`, so a pinned VF file silently renders its default instance; pinning therefore instances a true static (allsorts) at the picked descriptor's coordinates, matched by PostScript name with a `wght`-only fallback, and refuses with a readable error rather than mis-render (CFF2 flavour, GSUB feature variations, no matchable instance), with provenance landing in `fonts.json`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use core_foundation::base::TCFType;
use core_foundation::string::CFString;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::workspace::{require_root, SettingsState};

/// Recorded in provenance; bumping the pinned allsorts version can change instanced bytes, re-basing any project using the pin (`docs/determinism.md`).
const INSTANCER: &str = "allsorts 0.17.0";

const FONTS_DIR_NAME: &str = "fonts";
const MANIFEST_NAME: &str = "fonts.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedFont {
    pub family: String,
    pub weight: u32,
    pub postscript: String,
    /// File name inside the fonts dir (manifest form, path-independent, like the media cache); commands return the hydrated absolute path in `path`.
    pub file: String,
    /// Present when the source was a variable font instanced at pin time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instanced: Option<InstancedFrom>,
    #[serde(skip_deserializing)]
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstancedFrom {
    /// fvar coordinates the static was instanced at (user space, keyed by axis tag).
    pub axes: BTreeMap<String, f64>,
    pub instancer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct FontsManifest {
    version: u32,
    fonts: Vec<PinnedFont>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontListing {
    pub family: String,
    pub style: String,
    pub postscript: String,
    pub weight: u32,
    pub italic: bool,
    /// The face is a variable-font instance descriptor; pinning it instances a static.
    pub variable: bool,
}

/// CSS-ish weight from a style name (Core Text traits are awkward through the bindings, style keywords are stable); order matters, compound names before their substrings.
fn style_weight(style: &str) -> u32 {
    let s = style.to_lowercase();
    if s.contains("thin") {
        100
    } else if s.contains("extralight") || s.contains("extra light") || s.contains("ultralight") {
        200
    } else if s.contains("semibold") || s.contains("semi bold") || s.contains("demibold") || s.contains("demi bold") {
        600
    } else if s.contains("extrabold") || s.contains("extra bold") || s.contains("ultrabold") {
        800
    } else if s.contains("light") {
        300
    } else if s.contains("medium") {
        500
    } else if s.contains("heavy") || s.contains("black") {
        900
    } else if s.contains("bold") {
        700
    } else {
        400
    }
}

fn is_italic(style: &str) -> bool {
    let s = style.to_lowercase();
    s.contains("italic") || s.contains("oblique")
}

struct FaceInfo {
    family: String,
    style: String,
    postscript: String,
    path: PathBuf,
    variable: bool,
}

/// Every installed face with a resolvable file path; the core-text accessors PANIC on descriptors with null attributes, and a panic crossing this FFI boundary ABORTS the whole app, so each descriptor is read under `catch_unwind` and broken ones are skipped.
fn enumerate_faces() -> Vec<FaceInfo> {
    let collection = core_text::font_collection::create_for_all_families();
    let Some(descriptors) = collection.get_descriptors() else {
        return Vec::new();
    };
    // Named instances of variable fonts enumerate as ordinary descriptors carrying a variation attribute, present-but-empty on the default instance, absent on statics.
    let variation_key = unsafe {
        CFString::wrap_under_get_rule(core_text::font_descriptor::kCTFontVariationAttribute)
    };
    let mut faces = Vec::new();
    for descriptor in descriptors.iter() {
        let read = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let path = descriptor.font_path()?;
            Some(FaceInfo {
                family: descriptor.family_name(),
                style: descriptor.style_name(),
                postscript: descriptor.font_name(),
                variable: descriptor.attributes().find(&variation_key).is_some(),
                path,
            })
        }));
        if let Ok(Some(face)) = read {
            faces.push(face);
        }
    }
    faces
}

#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<SystemFontListing>, String> {
    let mut fonts: Vec<SystemFontListing> = enumerate_faces()
        .into_iter()
        .map(|f| SystemFontListing {
            weight: style_weight(&f.style),
            italic: is_italic(&f.style),
            variable: f.variable,
            family: f.family,
            style: f.style,
            postscript: f.postscript,
        })
        .collect();
    fonts.sort_by_key(|f| (f.family.to_lowercase(), f.weight));
    Ok(fonts)
}

fn fonts_dir(app: &AppHandle, state: &State<'_, SettingsState>) -> Result<PathBuf, String> {
    let dir = require_root(app, state)?.join(FONTS_DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_manifest(dir: &Path) -> FontsManifest {
    std::fs::read_to_string(dir.join(MANIFEST_NAME))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(FontsManifest { version: 1, fonts: Vec::new() })
}

fn save_manifest(dir: &Path, manifest: &FontsManifest) -> Result<(), String> {
    let text = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{MANIFEST_NAME}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(MANIFEST_NAME)).map_err(|e| e.to_string())
}

fn hydrate(dir: &Path, mut font: PinnedFont) -> PinnedFont {
    font.path = dir.join(&font.file).to_string_lossy().into_owned();
    font
}

/// The pinned library (manifest entries whose files still exist), absolute paths hydrated.
#[tauri::command]
pub fn list_workspace_fonts(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<Vec<PinnedFont>, String> {
    let dir = fonts_dir(&app, &state)?;
    Ok(load_manifest(&dir)
        .fonts
        .into_iter()
        .filter(|f| dir.join(&f.file).is_file())
        .map(|f| hydrate(&dir, f))
        .collect())
}

/// Pin the best-matching installed face for (family, weight): copy .ttf/.otf verbatim, extract from a .ttc/.otc collection, or instance a true static for variable fonts; idempotent, an existing pin returns untouched since the pinned bytes are the contract, except a pinned file that still contains `fvar` is a broken pre-v10 pin (troika renders its default instance) and gets re-pinned.
#[tauri::command]
pub fn pin_system_font(
    app: AppHandle,
    state: State<'_, SettingsState>,
    family: String,
    weight: u32,
) -> Result<PinnedFont, String> {
    let dir = fonts_dir(&app, &state)?;
    let mut manifest = load_manifest(&dir);

    if let Some(existing) = manifest
        .fonts
        .iter()
        .find(|f| f.family == family && f.weight == weight && dir.join(&f.file).is_file())
    {
        if !pinned_file_is_variable(&dir.join(&existing.file)) {
            return Ok(hydrate(&dir, existing.clone()));
        }
    }

    let faces = enumerate_faces();
    let candidates: Vec<&FaceInfo> = faces
        .iter()
        .filter(|f| f.family.eq_ignore_ascii_case(&family))
        .collect();
    if candidates.is_empty() {
        return Err(format!("no installed font family \"{family}\""));
    }
    let best = candidates
        .into_iter()
        .min_by_key(|f| {
            let dist = (style_weight(&f.style) as i64 - weight as i64).unsigned_abs();
            dist + if is_italic(&f.style) { 10_000 } else { 0 }
        })
        .ok_or("no candidate face")?;

    let ext = best
        .path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    let safe_name: String = best
        .postscript
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '-' })
        .collect();

    let data = std::fs::read(&best.path).map_err(|e| e.to_string())?;
    let (face_index, face_offset) = match ext.as_str() {
        "ttf" | "otf" => (0usize, 0usize),
        "ttc" | "otc" => find_collection_face(&data, &best.postscript)?,
        other => {
            return Err(format!(
                "font \"{family}\" ({}) has unsupported container \"{other}\"",
                best.postscript
            ));
        }
    };
    let (_, face) = face_tables(&data, face_offset)?;

    let (file, instanced) = if has_table(&face, b"fvar") {
        let (bytes, axes) =
            instance_pinned_face(&data, face_index, &face, &family, &best.postscript, weight)?;
        let file = format!("{safe_name}.ttf");
        std::fs::write(dir.join(&file), bytes).map_err(|e| e.to_string())?;
        (file, Some(InstancedFrom { axes, instancer: INSTANCER.to_string() }))
    } else {
        let file = match ext.as_str() {
            "ttf" | "otf" => {
                let file = format!("{safe_name}.{ext}");
                std::fs::copy(&best.path, dir.join(&file)).map_err(|e| e.to_string())?;
                file
            }
            // find_collection_face already rejected anything else.
            _ => {
                let extracted = extract_face_from_collection(&data, &best.postscript)?;
                let file = format!("{safe_name}.ttf");
                std::fs::write(dir.join(&file), extracted).map_err(|e| e.to_string())?;
                file
            }
        };
        (file, None)
    };

    let pinned = PinnedFont {
        family,
        weight,
        postscript: best.postscript.clone(),
        file,
        instanced,
        path: String::new(),
    };
    manifest
        .fonts
        .retain(|f| !(f.family == pinned.family && f.weight == pinned.weight));
    manifest.fonts.push(pinned.clone());
    save_manifest(&dir, &manifest)?;
    Ok(hydrate(&dir, pinned))
}

// - TrueType collection parsing -------------------------------------------------
// Minimal, read-only sfnt walking: find the face whose name-table PostScript name (ID 6) matches, then rebuild a standalone font with a new offset table and table directory at recomputed offsets, table bytes copied verbatim; per-table checksums stay valid but `head.checkSumAdjustment` goes stale, which every consumer we target (troika/Typr, opentype.js) ignores.

fn read_u16(data: &[u8], at: usize) -> Result<u16, String> {
    data.get(at..at + 2)
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
        .ok_or_else(|| "font data truncated".to_string())
}

fn read_u32(data: &[u8], at: usize) -> Result<u32, String> {
    data.get(at..at + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| "font data truncated".to_string())
}

struct TableRecord {
    tag: [u8; 4],
    checksum: u32,
    offset: u32,
    length: u32,
}

/// The table records of the face whose offset table starts at `face_offset`.
fn face_tables(data: &[u8], face_offset: usize) -> Result<(u32, Vec<TableRecord>), String> {
    let sfnt_version = read_u32(data, face_offset)?;
    let num_tables = read_u16(data, face_offset + 4)? as usize;
    let mut tables = Vec::with_capacity(num_tables);
    for i in 0..num_tables {
        let at = face_offset + 12 + i * 16;
        let tag_bytes = data
            .get(at..at + 4)
            .ok_or("font data truncated")?;
        tables.push(TableRecord {
            tag: [tag_bytes[0], tag_bytes[1], tag_bytes[2], tag_bytes[3]],
            checksum: read_u32(data, at + 4)?,
            offset: read_u32(data, at + 8)?,
            length: read_u32(data, at + 12)?,
        });
    }
    Ok((sfnt_version, tables))
}

/// The face's PostScript name (name table ID 6; Windows UTF-16BE or Mac Roman).
fn face_postscript_name(data: &[u8], tables: &[TableRecord]) -> Option<String> {
    name_string(data, tables, 6)
}

/// The first decodable name-table string with the given ID (Windows UTF-16BE or Mac Roman).
fn name_string(data: &[u8], tables: &[TableRecord], want_id: u16) -> Option<String> {
    let name = tables.iter().find(|t| &t.tag == b"name")?;
    let base = name.offset as usize;
    let count = read_u16(data, base + 2).ok()? as usize;
    let string_offset = read_u16(data, base + 4).ok()? as usize;
    for i in 0..count {
        let rec = base + 6 + i * 12;
        let platform = read_u16(data, rec).ok()?;
        let name_id = read_u16(data, rec + 6).ok()?;
        if name_id != want_id {
            continue;
        }
        let length = read_u16(data, rec + 8).ok()? as usize;
        let offset = read_u16(data, rec + 10).ok()? as usize;
        let bytes = data.get(base + string_offset + offset..base + string_offset + offset + length)?;
        let value = match platform {
            3 | 0 => String::from_utf16(
                &bytes
                    .chunks_exact(2)
                    .map(|c| u16::from_be_bytes([c[0], c[1]]))
                    .collect::<Vec<_>>(),
            )
            .ok()?,
            _ => bytes.iter().map(|&b| b as char).collect(),
        };
        return Some(value);
    }
    None
}

/// Extract the face matching `postscript` from a ttc/otc into a standalone font.
fn extract_face_from_collection(data: &[u8], postscript: &str) -> Result<Vec<u8>, String> {
    if data.get(0..4) != Some(b"ttcf") {
        return Err("not a TrueType collection".into());
    }
    let num_fonts = read_u32(data, 8)? as usize;
    for i in 0..num_fonts {
        let face_offset = read_u32(data, 12 + i * 4)? as usize;
        let (sfnt_version, tables) = face_tables(data, face_offset)?;
        let name = face_postscript_name(data, &tables);
        if name.as_deref() != Some(postscript) {
            continue;
        }

        // Rebuild: header + directory + table data (original order, 4-byte aligned).
        let num_tables = tables.len() as u16;
        let mut search_range: u16 = 1;
        let mut entry_selector: u16 = 0;
        while (search_range * 2) as usize <= tables.len() {
            search_range *= 2;
            entry_selector += 1;
        }
        search_range *= 16;
        let range_shift = num_tables * 16 - search_range;

        let mut out = Vec::with_capacity(data.len() / num_fonts.max(1));
        out.extend_from_slice(&sfnt_version.to_be_bytes());
        out.extend_from_slice(&num_tables.to_be_bytes());
        out.extend_from_slice(&search_range.to_be_bytes());
        out.extend_from_slice(&entry_selector.to_be_bytes());
        out.extend_from_slice(&range_shift.to_be_bytes());

        // Directory placeholder, then data; offsets fixed up as we append.
        let dir_start = out.len();
        out.resize(dir_start + tables.len() * 16, 0);
        let mut sorted: Vec<usize> = (0..tables.len()).collect();
        sorted.sort_by_key(|&i| tables[i].offset); // append in original data order
        for &i in &sorted {
            let t = &tables[i];
            while out.len() % 4 != 0 {
                out.push(0);
            }
            let new_offset = out.len() as u32;
            let bytes = data
                .get(t.offset as usize..(t.offset + t.length) as usize)
                .ok_or("table out of bounds")?;
            out.extend_from_slice(bytes);
            let rec = dir_start + i * 16;
            out[rec..rec + 4].copy_from_slice(&t.tag);
            out[rec + 4..rec + 8].copy_from_slice(&t.checksum.to_be_bytes());
            out[rec + 8..rec + 12].copy_from_slice(&new_offset.to_be_bytes());
            out[rec + 12..rec + 16].copy_from_slice(&t.length.to_be_bytes());
        }
        return Ok(out);
    }
    Err(format!("face \"{postscript}\" not found in the collection"))
}

// - Variable-font instancing ----------------------------------------------------
// troika parses no `fvar`, so a pinned VF renders its default instance; pinning a variable face instances a true static via allsorts at the descriptor's coordinates.

fn has_table(tables: &[TableRecord], tag: &[u8; 4]) -> bool {
    tables.iter().any(|t| &t.tag == tag)
}

/// A previously pinned file that still contains `fvar` is a broken pre-v10 pin; unreadable/unparseable files count as static since the untouched-pin contract wins.
fn pinned_file_is_variable(path: &Path) -> bool {
    let Ok(data) = std::fs::read(path) else { return false };
    match face_tables(&data, 0) {
        Ok((_, tables)) => has_table(&tables, b"fvar"),
        Err(_) => false,
    }
}

/// The (index, offset-table offset) of the collection face matching `postscript`, by its own PostScript name first, then by its fvar named-instance names (Core Text descriptors for VF instances carry the instance's PostScript name).
fn find_collection_face(data: &[u8], postscript: &str) -> Result<(usize, usize), String> {
    if data.get(0..4) != Some(b"ttcf") {
        return Err("not a TrueType collection".into());
    }
    let num_fonts = read_u32(data, 8)? as usize;
    let offsets: Vec<usize> = (0..num_fonts)
        .map(|i| read_u32(data, 12 + i * 4).map(|o| o as usize))
        .collect::<Result<_, _>>()?;
    for (i, &off) in offsets.iter().enumerate() {
        let (_, tables) = face_tables(data, off)?;
        if face_postscript_name(data, &tables).as_deref() == Some(postscript) {
            return Ok((i, off));
        }
    }
    for (i, &off) in offsets.iter().enumerate() {
        let (_, tables) = face_tables(data, off)?;
        if !has_table(&tables, b"fvar") {
            continue;
        }
        let (_, instances) = parse_fvar(data, &tables)?;
        for inst in &instances {
            let matched = inst
                .postscript_name_id
                .and_then(|id| name_string(data, &tables, id))
                .as_deref()
                == Some(postscript);
            if matched {
                return Ok((i, off));
            }
        }
    }
    Err(format!("face \"{postscript}\" not found in the collection"))
}

struct VarAxis {
    tag: [u8; 4],
    min: f32,
    default: f32,
    max: f32,
}

struct VarInstance {
    postscript_name_id: Option<u16>,
    coords: Vec<f32>,
}

fn read_fixed(data: &[u8], at: usize) -> Result<f32, String> {
    Ok(read_u32(data, at)? as i32 as f32 / 65536.0)
}

fn parse_fvar(data: &[u8], tables: &[TableRecord]) -> Result<(Vec<VarAxis>, Vec<VarInstance>), String> {
    let fvar = tables.iter().find(|t| &t.tag == b"fvar").ok_or("no fvar table")?;
    let base = fvar.offset as usize;
    let axes_offset = read_u16(data, base + 4)? as usize;
    let axis_count = read_u16(data, base + 8)? as usize;
    let axis_size = read_u16(data, base + 10)? as usize;
    let instance_count = read_u16(data, base + 12)? as usize;
    let instance_size = read_u16(data, base + 14)? as usize;

    let mut axes = Vec::with_capacity(axis_count);
    for i in 0..axis_count {
        let at = base + axes_offset + i * axis_size;
        let tag = data.get(at..at + 4).ok_or("font data truncated")?;
        axes.push(VarAxis {
            tag: [tag[0], tag[1], tag[2], tag[3]],
            min: read_fixed(data, at + 4)?,
            default: read_fixed(data, at + 8)?,
            max: read_fixed(data, at + 12)?,
        });
    }

    // postScriptNameID is optional, present only when the record is wide enough.
    let has_ps_ids = instance_size >= 4 + axis_count * 4 + 2;
    let instances_base = base + axes_offset + axis_count * axis_size;
    let mut instances = Vec::with_capacity(instance_count);
    for i in 0..instance_count {
        let at = instances_base + i * instance_size;
        let mut coords = Vec::with_capacity(axis_count);
        for j in 0..axis_count {
            coords.push(read_fixed(data, at + 4 + j * 4)?);
        }
        let postscript_name_id = if has_ps_ids {
            match read_u16(data, at + 4 + axis_count * 4)? {
                0xFFFF => None,
                id => Some(id),
            }
        } else {
            None
        };
        instances.push(VarInstance { postscript_name_id, coords });
    }
    Ok((axes, instances))
}

/// GSUB v1.1+ with a non-zero featureVariationsOffset means glyph substitutions change along the axes, which the instancer cannot bake, so refuse rather than mis-render.
fn has_gsub_feature_variations(data: &[u8], tables: &[TableRecord]) -> bool {
    let Some(gsub) = tables.iter().find(|t| &t.tag == b"GSUB") else {
        return false;
    };
    let base = gsub.offset as usize;
    let (Ok(major), Ok(minor)) = (read_u16(data, base), read_u16(data, base + 2)) else {
        return false;
    };
    major == 1 && minor >= 1 && read_u32(data, base + 10).map(|o| o != 0).unwrap_or(false)
}

/// The design-space coordinates to pin: the named instance whose PostScript name matches the picked descriptor, else `wght`-only at the requested weight (other axes default).
fn pick_instance_coords(
    data: &[u8],
    tables: &[TableRecord],
    axes: &[VarAxis],
    instances: &[VarInstance],
    postscript: &str,
    weight: u32,
) -> Result<Vec<f32>, String> {
    for inst in instances {
        let matched = inst
            .postscript_name_id
            .and_then(|id| name_string(data, tables, id))
            .as_deref()
            == Some(postscript);
        if matched && inst.coords.len() == axes.len() {
            return Ok(inst.coords.clone());
        }
    }
    if let Some(w) = axes.iter().position(|a| &a.tag == b"wght") {
        let mut coords: Vec<f32> = axes.iter().map(|a| a.default).collect();
        coords[w] = (weight as f32).clamp(axes[w].min, axes[w].max);
        return Ok(coords);
    }
    Err(format!(
        "variable face \"{postscript}\" has no matching named instance and no weight axis — pick a static face instead"
    ))
}

/// Refusal checks, coordinate pick, and the allsorts instancing call; returns the static font bytes and the pinned user-space coordinates (for provenance).
fn instance_pinned_face(
    data: &[u8],
    face_index: usize,
    tables: &[TableRecord],
    family: &str,
    postscript: &str,
    weight: u32,
) -> Result<(Vec<u8>, BTreeMap<String, f64>), String> {
    if has_table(tables, b"CFF2") {
        return Err(format!(
            "\"{family}\" is a CFF2-flavoured variable font, which Kookaburra Cut can't pin as a static instance — pick a static face instead"
        ));
    }
    if has_gsub_feature_variations(data, tables) {
        return Err(format!(
            "\"{family}\" changes glyph substitutions across its variation axes (GSUB feature variations), which can't be pinned faithfully — pick a static face instead"
        ));
    }
    let (axes, instances) = parse_fvar(data, tables)?;
    let coords = pick_instance_coords(data, tables, &axes, &instances, postscript, weight)?;
    let bytes = instance_variable_font(data, face_index, &coords)
        .map_err(|e| format!("instancing \"{family}\" ({postscript}) failed: {e}"))?;
    let axes_map: BTreeMap<String, f64> = axes
        .iter()
        .zip(&coords)
        .map(|(a, &c)| (String::from_utf8_lossy(&a.tag).into_owned(), f64::from(c)))
        .collect();
    Ok((bytes, axes_map))
}

fn instance_variable_font(data: &[u8], face_index: usize, coords: &[f32]) -> Result<Vec<u8>, String> {
    use allsorts::binary::read::ReadScope;
    use allsorts::font_data::FontData;
    use allsorts::tables::Fixed;

    let scope = ReadScope::new(data);
    let font_file = scope.read::<FontData>().map_err(|e| e.to_string())?;
    let provider = font_file.table_provider(face_index).map_err(|e| e.to_string())?;
    let tuple: Vec<Fixed> = coords.iter().map(|&c| Fixed::from(c)).collect();
    let (bytes, _) = allsorts::variations::instance(&provider, &tuple).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Best-effort: exercises the extractor against a real system collection when present.
    #[test]
    fn extracts_a_face_from_a_system_ttc() {
        let path = Path::new("/System/Library/Fonts/Helvetica.ttc");
        if !path.is_file() {
            return; // machine without it, the runtime path is gated by verify runs
        }
        let data = std::fs::read(path).unwrap();
        let num_fonts = read_u32(&data, 8).unwrap() as usize;
        assert!(num_fonts > 0);
        let first_offset = read_u32(&data, 12).unwrap() as usize;
        let (_, tables) = face_tables(&data, first_offset).unwrap();
        let ps = face_postscript_name(&data, &tables).expect("postscript name");
        let out = extract_face_from_collection(&data, &ps).unwrap();
        // The standalone face parses as an sfnt with the same table count.
        assert_eq!(read_u16(&out, 4).unwrap() as usize, tables.len());
        // And its name table still reports the same PostScript name.
        let (_, out_tables) = face_tables(&out, 0).unwrap();
        assert_eq!(face_postscript_name(&out, &out_tables).as_deref(), Some(ps.as_str()));
    }

    /// The dev machine has descriptors that PANIC the core-text accessors; enumeration must survive them (the abort that killed the first sysfont gate runs).
    #[test]
    fn enumeration_survives_broken_descriptors() {
        let faces = enumerate_faces();
        assert!(faces.len() > 100, "expected a real font library, got {}", faces.len());
    }

    #[test]
    fn style_weights_map_compound_names_first() {
        assert_eq!(style_weight("Regular"), 400);
        assert_eq!(style_weight("Semibold"), 600);
        assert_eq!(style_weight("Bold"), 700);
        assert_eq!(style_weight("Extra Bold"), 800);
        assert_eq!(style_weight("UltraLight"), 200);
        assert_eq!(style_weight("Light Italic"), 300);
        assert_eq!(style_weight("Black"), 900);
    }

    /// Synthetic GSUB headers: v1.0 (no field), v1.1 zero offset, v1.1 non-zero offset.
    #[test]
    fn gsub_feature_variations_detector() {
        let gsub_at = |minor: u16, fv_offset: u32| {
            let mut data = vec![0u8; 16];
            data[0..2].copy_from_slice(&1u16.to_be_bytes());
            data[2..4].copy_from_slice(&minor.to_be_bytes());
            data[10..14].copy_from_slice(&fv_offset.to_be_bytes());
            let tables = vec![TableRecord { tag: *b"GSUB", checksum: 0, offset: 0, length: 16 }];
            has_gsub_feature_variations(&data, &tables)
        };
        assert!(!gsub_at(0, 0x1234)); // v1.0 has no featureVariationsOffset field
        assert!(!gsub_at(1, 0));
        assert!(gsub_at(1, 0x1234));
    }

    /// Best-effort against the dev machine's SF Pro: the named-instance match must land on Apple's odd Semibold coordinates (wdth 100, opsz 28, wght 590, not 600).
    #[test]
    fn sf_pro_semibold_matches_named_instance() {
        let path = Path::new("/Library/Fonts/SF-Pro.ttf");
        if !path.is_file() {
            return;
        }
        let data = std::fs::read(path).unwrap();
        let (_, tables) = face_tables(&data, 0).unwrap();
        assert!(has_table(&tables, b"fvar"));
        let (axes, instances) = parse_fvar(&data, &tables).unwrap();
        assert_eq!(axes.iter().map(|a| a.tag).collect::<Vec<_>>(), [*b"wdth", *b"opsz", *b"wght"]);
        let coords =
            pick_instance_coords(&data, &tables, &axes, &instances, "SFPro-Semibold", 600).unwrap();
        assert_eq!(coords, vec![100.0, 28.0, 590.0]);
    }

    /// Best-effort: a full instancing round-trip on an installed variable font; the output must be a static sfnt (no fvar/gvar) that still parses and keeps glyf.
    #[test]
    fn instancing_produces_a_parseable_static() {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = PathBuf::from(home).join("Library/Fonts/Nunito-VariableFont_wght.ttf");
        if !path.is_file() {
            return;
        }
        let data = std::fs::read(&path).unwrap();
        let (_, tables) = face_tables(&data, 0).unwrap();
        let (bytes, axes) =
            instance_pinned_face(&data, 0, &tables, "Nunito", "Nunito-SemiBold", 600).unwrap();
        assert_eq!(axes.get("wght"), Some(&600.0));
        let (_, out_tables) = face_tables(&bytes, 0).unwrap();
        assert!(!has_table(&out_tables, b"fvar"));
        assert!(!has_table(&out_tables, b"gvar"));
        assert!(has_table(&out_tables, b"glyf"));
        // And the heal detector agrees the OUTPUT is static while the SOURCE is not.
        let (_, src_tables) = face_tables(&data, 0).unwrap();
        assert!(has_table(&src_tables, b"fvar"));
    }

    /// wght-only fallback: unknown PostScript name on a wght-axis font pins the CSS weight clamped to the axis range.
    #[test]
    fn unmatched_instance_falls_back_to_wght() {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = PathBuf::from(home).join("Library/Fonts/Nunito-VariableFont_wght.ttf");
        if !path.is_file() {
            return;
        }
        let data = std::fs::read(&path).unwrap();
        let (_, tables) = face_tables(&data, 0).unwrap();
        let (axes, instances) = parse_fvar(&data, &tables).unwrap();
        let coords =
            pick_instance_coords(&data, &tables, &axes, &instances, "NoSuchName-Zzz", 100).unwrap();
        // Nunito's wght axis is [200..1000], 100 clamps to 200.
        assert_eq!(coords, vec![200.0]);
    }
}
