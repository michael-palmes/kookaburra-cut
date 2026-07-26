# Packs (`.kbpack`)

One file that carries projects, themes, fonts, 3D objects, gradient presets,
export presets and screenshots from one Mac to another. The use case is a
company or an individual handing someone a starter kit: their projects, their
brand theme, their brand font, their product model.

Format owner: `src-tauri/src/pack/`. UI: `src/packs/` in the `packs` window.

## The two rules

1. **Nothing outside `pack::apply` writes into the workspace.** Reading a pack
   extracts into a staging directory the reader created, and only a resolved
   import moves anything out of it.
2. **A payload is untrusted until every byte has been hashed against the signed
   manifest.** Not "until the signature verifies": the signature covers the
   manifest, and the manifest covers the files, so both halves are needed.

## Container

A `.kbpack` is a zip. Zip rather than tar+zstd for one reason that outweighs the
8 to 13 percent ratio zstd would win: the central directory lets import read and
verify `manifest.json` without inflating the payload, so the trust and contents
screens appear instantly on a 500 MB pack. The ratio gap is mostly theoretical
here anyway, because packs are dominated by mp4, png and glb, which generic
compressors save 1 to 3 percent on.

Per-entry method (`pack::write::method_for`):

| Entries | Method |
|---|---|
| mp4, mov, m4v, webm, png, jpg, jpeg, webp, gif, glb, mp3, m4a, aac, ogg | Stored |
| everything else (json, tsx, md, ttf, otf, hdr, exr) | Deflated |

Entry order is fixed: `manifest.json`, `manifest.sig`, then payload sorted by
path. Zip timestamps are fixed, so two packs of identical content are
byte-identical.

```
manifest.json                          deflate, entry 0
manifest.sig                           store, entry 1, 64-byte Ed25519 detached
payload/projects/<slug>/…
payload/themes/<slug>/theme.json
payload/fonts/<postscript>.ttf|otf
payload/objects/<slug>/…
payload/gradients/<slug>.json
payload/export-presets/<slug>.json
payload/screenshots/<file>
```

## Inspecting one by hand

```bash
unzip -l my-pack.kbpack                      # entry list, sizes, methods
unzip -p my-pack.kbpack manifest.json | jq   # who made it, what is in it
unzip -p my-pack.kbpack manifest.json | jq '.contents.projects[].name'
unzip -p my-pack.kbpack manifest.json | jq '.files | length'
```

## Manifest

Shapes are pinned in `src-tauri/src/pack/model.rs` and mirrored in
`src/packs/types.ts`. Changing one without the other is a silent wire break.

`files` is the security spine: nothing is written that is not listed there with
a matching SHA-256, and nothing listed there may be missing.

`contentHash` is the conflict key. It is computed over an item's own relative
paths, never including the `payload/` prefix or a workspace path, so a copy that
moved machines but did not change still compares identical. Both sides of a
comparison go through `pack::scan`, which exists to guarantee exactly that.

`modifiedAt` is a file mtime and can be wrong (a restored backup, a skewed
clock). That is why hash decides first and date is only a tiebreak.

## Signing and trust on first use

Each install generates an Ed25519 keypair on first export, stored 0600 at
`$APPDATA/pack-key/ed25519.key`. The manifest is signed detached over its exact
stored bytes, never a re-serialisation. The public key travels in the manifest,
and its `keyId` (`hex(sha256(pubkey)[0..8])`) is what the app remembers in
`AppSettings.known_publishers`.

What this proves, and what it does not. The import copy has to be honest about
the second column:

| Claim | Provable |
|---|---|
| The payload matches the manifest | Yes, per-file SHA-256 |
| The manifest was not edited after signing | Yes, Ed25519 |
| This pack came from the same install as a previous one | Yes, keyId |
| The publisher name is truthful | **No** |
| The scene code is safe | **No** |

So the trust screen renders a publisher name as self-declared, always, with the
sentence saying nothing has checked it. Verdicts:

| Signature | keyId | Name | Shown |
|---|---|---|---|
| valid | unknown | any | First time from this publisher |
| valid | known | matches | Same publisher as "<last pack>" |
| valid | known | differs | Warning: this key previously said "<stored>" |
| invalid | any | any | Refused |
| absent | any | any | Refused |

Unsigned is refused rather than softened: every producer is our own app and
always has a key, so unsigned means hand-assembled.

## Pack trust is not code trust

A pack carries `scenes/*.tsx`, which compile through esbuild-wasm and run in the
webview with IPC reach. Import writes files and never compiles. Each imported
project still hits the existing F-001 gate the first time it is opened
(`src/engine/projectTrust.ts`), because a trust grant is bound to a path and a
fingerprint and an imported project has neither. There is a test asserting an
imported project comes out untrusted.

## Extraction checklist

Implemented in `pack::read` and `pack::paths`, one test per item in
`pack::tests`. Limits live in `pack::limits`.

1. Read the central directory only. Refuse over `MAX_ENTRIES` or a declared
   total over `MAX_TOTAL_UNCOMPRESSED`, before inflating anything.
2. Inflate `manifest.json` capped at `MAX_MANIFEST_BYTES`. Refuse a wrong
   `format`, a `formatVersion` above ours, or a `minAppVersion` above ours.
3. Validate every path in `files` **and every path in `contents`**. The second
   half matters because apply joins contents paths onto the staging root, and
   `Path::join` with an absolute path discards the base.
4. Reject absolute paths, `.` and `..` components, backslashes, drive letters,
   surrounding whitespace, control characters, bidi overrides, depth over
   `MAX_PATH_DEPTH`, length over `MAX_PATH_BYTES`, anything not under
   `payload/`.
5. Reject any entry whose mode marks a symlink or a non-regular file. Never
   create a symlink. This is the CVE-2025-29787 shape: entry A a symlink, entry
   B underneath it.
6. Reject an entry not in `files`, and a `files` entry with no zip entry.
7. Per-subtree extension allowlist. `.claude/` is the only dotted directory
   accepted; `.git/` is refused.
8. Skip `__MACOSX/`, `.DS_Store`, `._*` rather than refusing.
9. Extract into a fresh `<root>/.kookaburra/import-staging/<random>/`, created
   with `create_dir` so it can never be an existing directory.
10. Count inflated bytes as they stream. Headers lie.
11. Recompute SHA-256 for every staged file and compare against `files`. One
    mismatch aborts the whole import.
12. Only then resolve and move. `StagedPack` implements `Drop`, so every failure
    path removes the tree.
13. Force `0644` on files and `0755` on directories, whatever the archive said.

## Conflicts

| State | Meaning | Default |
|---|---|---|
| `new` | nothing local with this key | import |
| `identical` | `contentHash` matches | skip |
| `theirs-newer` | differs, pack is newer | replace |
| `yours-newer` | differs, local is newer | keep mine |
| `unknown-age` | differs, no usable local mtime | keep mine |

Two per-kind overrides:

- **Fonts default to skip on any byte mismatch.** The incumbent bytes are the
  recipient's determinism contract, and `keep both` is not offered because two
  files cannot own one `(family, weight)` key in `fonts.json`.
- **Screenshots default to keep both.** That folder is a bag, not a namespace.

`keep both` suffixes `-2`, `-3`, matching the media convention. When a theme
resolves to keep-both, every project in the same import that referenced it is
rewritten to the new slug in the staging directory before anything moves.
Projects not in the import are never touched.

A replace moves the existing item to
`<root>/.kookaburra/import-backup/<runId>/` first. It never deletes inline.

A failure part way through does not roll back: it reports what landed, what did
not, and where the backups are. Rolling back a half-applied import is more
dangerous than stopping.

## What travels and what does not

Excluded, because it is generated (`pack::scan::is_excluded`, extending
`duplicate_project`'s skip-list):

`exports/**`, `assets/.emoji-cache/**`, `.git/**`, `.claude/skills/**`,
`edits/_tap_prefs.json`, `.DS_Store`, `._*`.

Included despite looking generated: `CLAUDE.md` and `.claude/settings.json`,
because both are only written when missing and users edit them.

Reviewed rather than dropped: unreferenced assets and `*-edited.mp4` flattened
renders appear in the picker with their size and a one-click drop. Nothing is
removed silently.

Fonts travel as **bytes**, not as a family name. `src-tauri/src/fonts.rs` pins
`allsorts = "=0.17.0"` exactly because variable-font instancer output
participates in export baselines, so two machines with "the same" font can
produce different glyph metrics. A pack ships the pinned file and its
`instanced` provenance, which is what makes a recipient's export hash match the
author's.

A font whose OS/2 `fsType` says Restricted is never bundled. It travels as a
name-only reference plus a message telling the recipient to install it. That
gate is a floor, not a clearance: `fsType` describes document embedding, which
is not the same question as redistribution, and the UI copy says so.

## Adding a new entity kind

1. `model.rs`: add the `ItemKind` variant, its `payload_dir()` and
   `workspace_dir()`, and its place in `APPLY_ORDER` (things that get referenced
   go before things that reference them).
2. `paths.rs`: add its extension allowlist.
3. `deps.rs`: enumerate it, resolve its references, build its `PackItemBase`.
4. `conflicts.rs`: nothing, unless it needs a per-kind default override.
5. `apply.rs`: its move and its keep-both rename.
6. `src/packs/types.ts` and `KIND_LABELS`.
7. A hostile fixture in `pack::tests` if it introduces a new path shape.
