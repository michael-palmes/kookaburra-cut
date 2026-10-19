use std::path::Path;

fn main() {
    embed_builtin_themes();
    tauri_build::build()
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
