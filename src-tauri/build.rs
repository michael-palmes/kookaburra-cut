use std::path::Path;

fn main() {
    embed_builtin_themes();
    // The app ACL (permissions/*.json, one set per window role) gates every #[tauri::command] per window. Dev-only commands are registered under cfg(debug_assertions), so the capabilities granting them live in capabilities/dev/ and only a debug profile reads that folder.
    println!("cargo:rerun-if-changed=permissions");
    println!("cargo:rerun-if-changed=capabilities");
    let debug = std::env::var("PROFILE").is_ok_and(|p| p == "debug");
    let capabilities = if debug {
        "./capabilities/**/*.json"
    } else {
        "./capabilities/*.json"
    };
    tauri_build::try_build(tauri_build::Attributes::new().capabilities_path_pattern(capabilities))
        .expect("failed to run tauri-build");
}

/// Embeds the bundled theme documents so theme variants of them resolve natively (packs, moves) as they do in the app.
fn embed_builtin_themes() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/theme/builtin");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    let mut out = String::from("pub static BUILTIN_THEME_DOCS: &[(&str, &str)] = &[\n");
    for path in files {
        let id = path.file_stem().unwrap().to_string_lossy().into_owned();
        let abs = path.canonicalize().unwrap();
        out.push_str(&format!(
            "    ({id:?}, include_str!({:?})),\n",
            abs.display().to_string()
        ));
    }
    out.push_str("];\n");
    let target = Path::new(&std::env::var("OUT_DIR").unwrap()).join("builtin_themes.rs");
    std::fs::write(target, out).unwrap();
}
