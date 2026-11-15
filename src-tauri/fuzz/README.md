# Fuzz harness

libFuzzer targets over the parsers that read untrusted bytes, reached through the app crate's `fuzzing` feature (`src/fuzz_api.rs`). Each target body is a `pub fn` in `src/lib.rs` with the invariant it holds; `fuzz_targets/` wraps them for libFuzzer.

| Target | Input | Invariant |
| --- | --- | --- |
| `pack_archive_path` | a zip entry name | `Ok` is relative, kept as written, under `payload/`, plain components within the depth cap; a dropped entry never validates |
| `pack_manifest` | `manifest.json` | parse, write, parse, write is a fixed point; contents and key checks never panic |
| `pack_signature` | key length, key, 64-byte signature, message | nothing verifies without a parseable key and a 64-byte signature; a key seeded from the input verifies exactly what it signed |
| `edit_doc` | `edits/<name>.json` | parse, write, parse, write is a fixed point; the render argv never carries a NUL |
| `sfnt_face` | a font, then a PostScript name and its length byte | the readers never panic; a face extracted from a collection has a directory whose tables lie inside it |
| `mp4_edit_start` | a movie | the edit-start reader never panics |
| `png_decode` | a PNG | a decode fills exactly width × height RGBA8 texels, and a header past the RGBA ceiling is refused; images the app allows but a fuzz loop cannot afford (over a quarter of the ceiling) are skipped |

## Running

Stable keeps the harness honest: `cargo test --manifest-path fuzz/Cargo.toml` (from `src-tauri`, with `CARGO_TARGET_DIR=target` to share the app's build) runs every body over its seeds and checks that `seeds/`, `fuzz_targets/` and the bodies agree. CI runs it on every rust job.

Fuzzing needs the dated nightly in `nightly-toolchain` and cargo-fuzz, from `src-tauri`:

```bash
export NIGHTLY="$(cat fuzz/nightly-toolchain)" RUSTFLAGS='-Clink-arg=-Wl,-undefined,dynamic_lookup'
rustup toolchain install "$NIGHTLY" --profile minimal
cargo install --locked cargo-fuzz@0.13.2
cargo +"$NIGHTLY" fuzz build -s none
cargo +"$NIGHTLY" fuzz run -s none edit_doc fuzz/corpus/edit_doc fuzz/seeds/edit_doc -- -max_total_time=60 -rss_limit_mb=2048 -max_len=65536
```

The linker flag is for rten (via beat-this), which also declares a cdylib that cargo builds for a dependency and nothing links: under sancov that link misses a generic instance the fuzz binaries themselves carry, so undefined symbols are deferred rather than fatal.

`.github/workflows/fuzz.yml` runs every target for a minute weekly, on demand, and on a PR touching the harness; a crash lands under `artifacts/` and fails the job.

### Moving the nightly

`nightly-toolchain` is the one place the date lives; the workflow reads it and refuses anything but `nightly-YYYY-MM-DD`. A floating nightly once broke the job with an internal compiler error, so move it on purpose: install a newer dated nightly, run the build above with `NIGHTLY` set to it, and if every target builds, write its name to the file. The pull request touches `fuzz/**`, so `fuzz.yml` runs on it with the new compiler. `nightly-2026-11-13` and later fail on `pathfinder_geometry` 0.5.1 under sancov; check that first.

## Seeds

`seeds/<target>/` holds plain text, JSON, a font, a tiny collection, two small movies and one PNG, never a zip (scanners flag hostile archives; the pack tests build theirs in code). The corpus libFuzzer grows lives in `corpus/`, gitignored.
