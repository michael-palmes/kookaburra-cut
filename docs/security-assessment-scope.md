# Security assessment scope

A brief for a third-party security assessor: what Kookaburra Cut defends
against, where each trust boundary sits in the code, what is already tested,
and how an engagement should run. Quote from it freely. Every claim it points at
is stated, with its control, in [SECURITY.md](../SECURITY.md) at the version
under test; where the two disagree, SECURITY.md wins and this file is stale.

Checked against 0.24.0, the latest release.

## The product

A macOS desktop app (macOS 26 or later, Apple Silicon) that renders and exports
product films. Tauri 2: a Rust shell (`src-tauri/`) and a React and
react-three-fiber front end in WKWebView, with ffmpeg and ffprobe sidecars.

- **A project is a folder:** `project.json`, `scenes/*.tsx` (TypeScript the app
  compiles with esbuild and runs, after a person presses Allow, in a Web Worker),
  per-scene JSON sidecars and `assets/`. It lives in the workspace,
  `~/Kookaburra Cut`, with its own git repository.
- **Sharing:** `.kbpack` files, signed zips of projects, templates, presets,
  themes, fonts, 3D objects and brands ([docs/packs.md](packs.md)).
- **Live websites:** a scene can show an approved origin in a child WKWebView
  ([docs/scene-website.md](scene-website.md)).
- **Claude Code, optional:** the app stamps a kit into each project
  (`CLAUDE.md`, `.claude/settings.json`, `./kb`), answers kb through a file-queue
  bridge, and ships a headless CLI in its own binary
  ([docs/agent-kit.md](agent-kit.md)). The app never starts Claude Code and
  holds no API key.
- **Updates:** tauri-plugin-updater against a signed manifest on GitHub, or an
  organisation's server ([docs/mdm.md](mdm.md)).
- **Distribution:** a Developer ID signed, notarised DMG and pkg from a GitHub Actions
  pipeline that keeps building, signing and verifying in separate jobs
  (SECURITY.md, "Release integrity").

## Threat model

It runs on corporate Macs holding confidential, unreleased work, opened by
people who trust what colleagues send them.

**Assets.**

- Confidential work on the Mac: projects, footage, exports, captures, decoded
  frames in the caches.
- The person's account: code execution, files outside the workspace,
  credentials (`~/.ssh`, the login Keychain, `~/.claude`).
- Consent: Allow on a project's code, website origin grants, publisher trust
  (trust on first use), bridge confirmations, the review of agent files.
- The pack signing key in the login Keychain.
- The update channel and the installed bundle.
- An organisation's policy, forced by configuration profile (`managed.rs`).

**Attackers.**

1. Whoever shares a project folder (zip, git clone, file share) a person opens.
2. Whoever builds a `.kbpack` a person imports.
3. A website a person approves for a scene, and anything it redirects to,
   frames or loads.
4. A crafted font, image, movie, glb, edit document or song a person or a pack
   brings in.
5. A coding agent misled by text planted in a project (scene copy,
   `project.json`, `BRAND.md`, pack contents), acting through kb, the bridge and
   the CLI.
6. A compromised app window reaching for commands another window holds.
7. A network attacker on the update path, or someone holding the GitHub
   account but not the signing keys.
8. Another, non-admin user on the same Mac.

**Out of scope, and why.**

- **The macOS user account itself.** A process running as the same user can
  read the same files, edit `settings.json`, write the bridge queue and drive
  the app. The controls make the app's own paths harder, not that case. A
  same-user process that gains something it could not reach alone (root
  through the updater's administrator install, another user's files) is in
  scope.
- **Claude Code and Anthropic's services.** Claude Code's behaviour, network
  use and storage are Anthropic's, under the person's account. The app bounds
  what it hands the agent, not what Claude Code does with it, and a `claude`
  typed in the person's own terminal is outside the app's gate.
- **The app's reach by design.** An approved website has a browser tab's reach,
  subresources and DNS to local services included (docs/scene-website.md,
  "Accepted residual risk"); Allow means a project's scenes run, inside the
  stage worker; a pack someone exports carries what they ticked.
- **Bugs in macOS, WebKit, ffmpeg or third-party crates.** Report them as
  dependencies. Where the app widens one (handing untrusted bytes to a decoder
  it could avoid, say), that use is in scope.
- **Known gaps.** SECURITY.md, "Not yet", lists what is deliberately deferred
  (bridge signing against same-user processes, a sealed trust store, one stage
  worker per project, an agent sandbox). A finding that only restates one is noted, not scored,
  unless it shows a wider impact than the entry admits.
- **Infrastructure.** The release pipeline's design, workflows and scripts are
  in scope to review; attacking GitHub, Apple's notary service or the
  maintainer's accounts and machines is not.

## Trust boundaries

Each row names where untrusted input enters and the files that hold the line.
Start from the SECURITY.md section named; it states the claims to test.

| Boundary | What crosses it | Entry files | SECURITY.md |
| --- | --- | --- | --- |
| Pack import | A `.kbpack` zip: manifest, signature, payload | `src-tauri/src/pack/` (`read.rs`, `paths.rs`, `limits.rs`, `key.rs`, `publisher.rs`, `commands.rs`, `apply.rs`, `conflicts.rs`, `deps.rs`, `fonts.rs`), `objects.rs`, `src/packs/packReview.ts` | Packs |
| Opening a project | A shared folder: scene code, sidecars, agent files, `.git` | `workspace.rs` (`request_project_trust`, `trust_project`, `check_project_trust`, `trust_covered_files`, `review_agent_files_for`), `native_alert.rs`, `kit.rs` (`sweep_agent_files`, `managed_allow_rules`), `real_dir.rs`, `history.rs` (`GUARDS`), `claude_app.rs`, `cli_trust.rs`, `src/stage/` | Scene code and the trust boundary; What reaches your agent |
| Claude bridge and CLI | kb requests from a possibly misled agent; project text going back to it | `bridge.rs`, `bridge_export.rs`, `bridge_range.rs`, `bridge_health.rs`, `capture_service.rs`, `clean_text.rs`, `live_edits.rs`, `cli.rs` and `cli_*.rs`, `src/render/bridgeService.ts`, `bridgeRequests.ts`, `bridgeFonts.ts`, kb's `.agents/skills/kookaburra-scene-authoring/scripts/kblib/` (`reach.py`, `hookfast.py`, `util.py`, `git.py`, `realdir.py`) | What reaches your agent |
| Websites and scene realms | An approved origin's pages; allowed scene code; asset paths from sidecars | `website.rs` (`website_open`, `website_grant_origin`, `guard_invoke`, the page-world script and its `kookaburraWebsiteFocus` handler), `src/ui/SceneWebsiteOverlay.tsx`, `src/present/PresentWebsiteOverlay.tsx`, `src/stage/realmGuard.ts`, `stageClient.ts` (`provePolicy`), `stageWorker.ts`, `asset_reach.rs`, `tauri.conf.json` (`security.csp`) | What leaves the Mac; Scene code and the trust boundary |
| Updater | A manifest and an archive from GitHub or a forced `UpdateEndpoint` | `updater.rs`, `managed.rs` (`usable_endpoint`), `tauri.conf.json` (`plugins.updater`), tauri-plugin-updater as pinned in `src-tauri/Cargo.lock` | What leaves the Mac; Release integrity |
| Untrusted parsers | Fonts, stills, movies, glb, edit documents, sidecars, CSV, terminal transcripts, CLI arguments | `fonts.rs` and `pack/fonts.rs` (SFNT, collections, allsorts instancing), `png_decode.rs`, `imagefile.rs`, `mp4box.rs`, `media_input.rs` (ffmpeg protocol and format allow-lists), three's GLTFLoader (`src/toolkit/objects/preload.ts`, `src/engine/objectThumbnail.ts`), `edit.rs`, `src/engine/sceneDocSchema.ts`, `src/toolkit/chart/csv.ts`, `src/engine/sceneTerminalTranscript.ts`, `cli.rs` | On the Mac; Scene code and the trust boundary (Stills on the way in) |
| Managed preferences | A configuration profile's forced keys | `managed.rs`, [docs/mdm.md](mdm.md) | Managed preferences |
| Window IPC | Each window's commands; events between windows | `src-tauri/capabilities/*.json`, `src-tauri/permissions/*.json`, `acl.rs`, `website.rs` (`guard_invoke`) | Scene code and the trust boundary (Per-window ACL) |

## What is already tested

Hostile inputs the repository already tests, per boundary. A finding the
assessor reproduces as a test in one of these files is the easiest to keep
fixed. The repository commits no hostile archives: pack tests build theirs in
code.

| Boundary | Where the hostile cases live |
| --- | --- |
| Pack import | `src-tauri/src/pack/tests.rs` (a `Fixture` builder; `assert_refused` snapshots the workspace before and after): traversal, absolute paths, symlink escape, depth, length, bidi and non-UTF-8 names, dotted folders, `.git`, entries outside `payload/`, ratio bomb, entry flood, oversized manifest, signature and per-kind caps, forged and oversized signatures, a key id the key does not derive, tampered and ghost entries, a scene list that isn't the staged set, disk space, cancellation. Also the unit tests in `pack/paths.rs`, `pack/apply.rs` (imported projects untrusted, agent files at any depth become notes), `pack/conflicts.rs` (`a_hostile_slug_never_resolves_to_a_path`), `pack/publisher.rs`, `pack/key.rs`; `src/packs/packReview.test.ts`, `websiteReview.test.ts` |
| Opening a project | `workspace.rs` tests (the fingerprint is content, single-use nonce, a pack landing asks again, consent sheet names, `copying_refuses_symlinks`, `validate_slug_rejects_escapes`); `kit.rs` (foreign settings stripped, a planted or linked `kb` moved aside, a linked `.claude`, instruction files to `NOTES.md`, MCP secrets redacted, credential lists agree across kb, the bridge and the deny rules); `history.rs` (a folder's own config never runs a program, a `.git` reaching elsewhere is refused); `real_dir.rs`; `cli_trust.rs`; kb's tests in `.agents/skills/kookaburra-scene-authoring/scripts/tests/` (`test_hostile_folder.py`, `test_git.py`, `test_shim.py`, `test_hooks.py`); `src/engine/projectTrust.test.ts`, `projectLoadIsolation.test.ts` |
| Claude bridge and CLI | `bridge.rs` tests (malformed and stale requests, path-safe frame names, exact-case assets, picked folders refuse roots, home and credentials, one workspace per instance, `servedBy`); `clean_text.rs` (a vector table shared with kb); `bridge_export.rs`; `capture_service.rs` (rationing, prune by age, size and owner); `live_edits.rs`; `cli.rs`, `cli_media.rs`, `src-tauri/tests/edit_cli.rs`; `src/render/bridgeService.test.ts`, `bridgeRequests.test.ts`; kb's `test_reach.py`, `test_bridge.py`, `test_capture.py`, `test_envelope.py`, `test_hooks_bash.py` (send-off asks) |
| Websites and scene realms | `website.rs` tests (unsafe schemes, remote http and credentials refused, loopback needs an explicit port, only app webviews invoke, a grant needs a request and any answer spends it); `asset_reach.rs` (a child webview is refused everything, another project is refused, hidden folders, a link out of the project, ranges); `acl.rs`; `src/stage/realmGuard.test.ts` (each network door, nested workers, install can't be undone through the prototype, asset reach, `provePolicy`, the policy names no remote host), `stageClient.test.ts`, `workerNativePort.test.ts`; `src/engine/sceneWebsite*.test.ts`, `src/ui/SceneWebsiteOverlay.test.tsx`. The packaged acceptance list in [docs/scene-website.md](scene-website.md) is run by hand |
| Updater | `managed.rs` (`update_endpoint_accepts_https_without_a_query_and_locks_on_anything_else`); `scripts/verify-release.sh` checks the updater signature and `latest.json` on every release; the plugin's own tests cover signature and version binding |
| Untrusted parsers | `fonts.rs` (`a_hostile_collection_is_refused_not_overflowed`, broken descriptors), `png_decode.rs` (a non-PNG, a header past the RGBA ceiling), `imagefile.rs` (a name that lies, a bomb refused on its header, damaged PNGs, non-images), `mp4box.rs`, `media_input.rs` (a playlist is refused), `edit.rs` (absurd rates saturate, a linked staging folder is refused, the sweep never follows a link), `objects.rs` (object paths) |
| Managed preferences | `managed.rs` (forced keys only, wrong types fail closed, malformed publisher lists allow nothing, every governed command calls its guard) |
| Window IPC | `acl.rs` (every command placed, dev sets only in dev, the trust, export, delete, website-grant and workspace commands pinned to their windows) |

## Fuzzing

`src-tauri/fuzz/` is a libFuzzer harness over the app crate's `fuzzing`
feature (`src-tauri/src/fuzz_api.rs`); `.github/workflows/fuzz.yml` runs each
target for a minute weekly, on demand and on a pull request touching the
harness, and every CI rust job runs the bodies over their seeds on stable
([src-tauri/fuzz/README.md](../src-tauri/fuzz/README.md)).

| Target | Input | Invariant held |
| --- | --- | --- |
| `pack_archive_path` | a zip entry name | `Ok` is relative, under `payload/`, plain components within the depth cap; a dropped entry never validates |
| `pack_manifest` | `manifest.json` | parse and write reach a fixed point; contents and key checks never panic |
| `pack_signature` | key, signature, message | nothing verifies without a parseable key and a 64-byte signature |
| `edit_doc` | `edits/<name>.json` | parse and write reach a fixed point; the render argv never carries a NUL |
| `sfnt_face` | a font and a PostScript name | the readers never panic; an extracted face's tables lie inside it |
| `mp4_edit_start` | a movie | the edit-list reader never panics |
| `png_decode` | a PNG | a decode fills exactly width × height RGBA8 texels; an oversized header is refused |

fast-check property tests cover the TypeScript parsers:
`src/engine/sceneDocSchema.property.test.ts`, `src/engine/editMath.property.test.ts`,
`src/theme/fontRef.property.test.ts`, `src/toolkit/chart/csv.property.test.ts`
and `src/ui/durationText.property.test.ts`.

**Not fuzzed** (SECURITY.md, "Not yet", plus what the internal review below
noted); most have example-based tests above:

- the `.kbpack` reader as a whole: inspect, stage and apply over a complete
  zip, rather than one entry name or one manifest at a time;
- `allsorts` shaping and variable-font instancing;
- glTF, which three's GLTFLoader parses in the webview;
- the still-image header readers (`imagefile.rs`);
- `asset://` URL decoding, the reach check and Range answers (`asset_reach.rs`);
- website origin parsing (`website.rs`, `src/engine/sceneWebsite.ts`);
- bridge request parsing and the Rust and Python `clean_text` pair;
- kb's path checks and file transactions, and the agent-file sweep and
  settings stripping (`kit.rs`);
- `realmGuard.ts`.

Some of what sits here, such as filesystem folding, links inside folders, races
between check and use, git's own behaviour and Claude Code's loaders, a fuzzer
cannot reach at all; those need hand-built fixtures.

## Internal review

In November 2026 the maintainer ran an internal adversarial code review of
five boundaries: pack import, opening a project (the Allow gate, kit stamping
and the agent-file sweep), the Claude bridge and CLI, the website webview and
stage worker realm, and the updater, plus the window capabilities. It read the
code as an attacker would and confirmed suspicions with throwaway hostile
fixtures. Categories covered:

- path handling: traversal, absolute paths, encodings, and case and Unicode
  folding on APFS;
- symlinks, hard links and non-regular files, in projects, packs, `.git` and
  the app's own folders;
- races between a check and its use, and files swapped between steps;
- decompression, size, count and time caps;
- signatures, key ids and trust on first use, and how publisher names compare;
- what a hostile `project.json`, sidecar, pack manifest, `.claude/settings.json`,
  `.git` or `./kb` can reach before and after Allow;
- the agent's reach through kb, the bridge and the CLI, and the escaping of
  project text on its way to the agent;
- origin parsing, redirects, frames and message handlers in the website view;
- the stage worker's realm guard and what `asset://` serves each window;
- window capabilities and events between windows;
- the updater's signature, version binding and endpoint rules;
- what the fuzz seeds and existing tests miss.

It was a code review by the people who wrote the code, with local fixtures, not
a penetration test, and it does not replace one. Its findings are tracked
privately until fixed.

## Rules of engagement

- **Build under test.** The notarised build from the latest tagged release,
  downloaded from its GitHub release and verified before install (below), with
  the source at the same tag for white-box work. A finding counts when it
  reproduces on that release build. Debug builds (`pnpm tauri dev`) carry
  dev-only capabilities (`src-tauri/capabilities/dev/`), a looser policy
  (`devCsp`) and honour `KOOKABURRA_UPDATE_ENDPOINT`; use them to explore, then
  show the release path. A risk only a debug build or a terminal autorun
  (`pnpm kookaburra:run`) carries is still worth reporting, rated for a
  developer's Mac rather than a customer's.
- **Machines.** The assessor's own Apple Silicon Macs or macOS 26 virtual
  machines, each with a dedicated user account and a fresh `~/Kookaburra Cut`,
  and a second, non-admin account for other-user tests. Install the sample
  profile from [docs/mdm.md](mdm.md) on a virtual machine to test managed
  preferences. No production fleet, no customer Macs, no real projects.
- **Claude Code.** Agent-path tests use the assessor's own Claude account. The
  app holds no key to lend, and Anthropic's services are not a target.
- **Network.** Live-website tests use origins the assessor controls; no
  third-party sites. Update tests use a manifest on the assessor's server,
  through a forced `UpdateEndpoint` on a release build or
  `KOOKABURRA_UPDATE_ENDPOINT` on a debug build. Never touch the project's GitHub
  releases.
- **Off limits.** The GitHub repository and organisation settings, the
  `release` and `signed-head` environments and their secrets, the private
  licensed-models repository, the maintainer's machines, keys and accounts,
  social engineering, and load against GitHub.
- **Reporting.** Through GitHub's private vulnerability reporting (SECURITY.md,
  "Reporting a vulnerability"), which opens a draft advisory only the
  maintainer sees. Report a critical or high finding when it is confirmed,
  without waiting for the final report. Disclosure is coordinated: nothing
  public until a fixed release ships, and no later than 90 days after the
  report unless both sides agree otherwise.

## Deliverables

- **A report** covering scope, method and coverage, and for each finding: a
  title, a CVSS v3.1 or v4.0 vector and score, the affected version and
  `file:line`, a reproduction with a minimal fixture (a script that builds the
  hostile pack, folder or page), the impact under this threat model and a
  recommended fix. Observations without a score go in their own section.
- **Fixtures** the repository can keep as regression tests: a Rust `#[test]`, a
  Vitest file or a script that builds the hostile input in code.
- **A summary for customers' security teams**: an executive summary or an
  attestation letter the maintainer may publish beside SECURITY.md.
- **One retest** of the fixed findings, within eight weeks of the report, with
  the report updated to show fixed, accepted and open.

## Size

A white-box review with source and both builds. Comparable public engagements
ran 10 to 30 person-days: X41 D-Sec spent 30 person-days with four consultants on
the Mullvad VPN apps across five platforms; Trail of Bits put three consultants
on Homebrew for two weeks; NCC Group's attestation for Sourcetree records 10
days for the macOS app. For this app, 15 to 25 person-days by two or three
consultants over two to three weeks is a reasonable starting quote. If the
budget is short, cover in this order: pack import, opening a project, the
website and stage realms with `asset://`, the bridge and kb, the updater, the
parsers.

## Vendor shortlist

Firms with public macOS desktop, Rust or Tauri work. None publishes rates, so
every figure below is indicative, from public market sources, not a quote.

| Firm | Relevant public work |
| --- | --- |
| [Radically Open Security](https://www.radicallyopensecurity.com/) (NL, non-profit) | Audited Tauri 1.0 for the Tauri Programme in 2021: every crate, the tooling and an example app on all three platforms ([Tauri](https://dev.to/tauri/tauri-feature-freeze-and-security-audit-1ml1)), so it has read the framework's IPC and webview code |
| [Trail of Bits](https://www.trailofbits.com/) (US) | Homebrew, the macOS package manager: a white-box review by three consultants, 14 to 25 August 2023, public report ([Trail of Bits](https://blog.trailofbits.com/2024/07/30/our-audit-of-homebrew/), [OTF](https://www.opentech.fund/security-safety-audits/homebrew-security-audit/)) |
| [X41 D-Sec](https://www.x41-dsec.de/) (DE) | Mullvad VPN apps, desktop daemon in Rust, macOS among five platforms: a white-box penetration test with source access, four consultants, 30 person-days, October to November 2024 ([announcement](https://www.x41-dsec.de/news/2024/12/11/mullvad/), [report](https://x41-dsec.de/static/reports/X41-Mullvad-Audit-Public-Report-2024-12-10.pdf)) |
| [Cure53](https://cure53.de/) (DE) | ExpressVPN's macOS and Linux apps: white-box penetration tests and source code audits, June to August 2022 ([ExpressVPN](https://www.expressvpn.com/news-pr/mac-linux-windows-v12-audits/)); the Obsidian apps, 2023 ([Obsidian](https://obsidian.md/blog/cure53-security-audit/)) |
| [NCC Group](https://www.nccgroup.com/) (UK) | A native application assessment of Sourcetree for macOS: two consultants, 10 days per platform, July and August 2024, per Atlassian's published [attestation letter](https://wac-cdn-bfldr.atlassian.com/K3MHR9G8/as/bxsqqmkhqwvxpvcrvp7g7psw/Attestation_Summary_Letter_-_Atlassian_-_Sourcetree_1) (read through a search index on 2026-11-09; the direct link did not load) |

**Indicative cost.** Certified testers run about US$200 to 400 an hour, or
US$1,600 to 3,200 for an eight-hour day ([Software Secured](https://www.softwaresecured.com/post/penetration-testing-cost));
a thorough manual test of a standard business application, one to two weeks of
testing, about €15,000 to 30,000 ([7ASecurity](https://7asecurity.com/blog/2026/04/the-2026-guide-to-penetration-testing-pricing-and-scoping/)).
At 15 to 25 person-days, budget roughly US$25,000 to 80,000 before the retest.
Ask each firm for a fixed quote against this file.

## What a reviewer can verify without us

Every release from 0.22.0 on carries what an install's integrity rests on
(SECURITY.md, "Release integrity"; `build-info.txt` from 0.22.1). Later
releases may add assets, and their own `SECURITY.md` lists them. From 0.23.0
(0.22.4 has no pkg, SBOM or source archives):

| Asset | What it proves |
| --- | --- |
| `KookaburraCut-<version>.dmg`, `.zip` | The signed, notarised app (the DMG holds the same bytes as the zip) |
| `KookaburraCut-<version>.pkg` | The same app as a Developer ID Installer signed, notarised pkg for MDM installs |
| `KookaburraCut-<version>-updater.app.tar.gz` and `.sig` | The archive the in-app updater installs, and its ed25519 signature bound to the version |
| `latest.json` | The updater manifest: the same signature and version |
| `KookaburraCut-<version>.cdx.json` | The CycloneDX SBOM, attested on the DMG and the pkg |
| `ffmpeg-*.tar.xz`, `x264-*.tar`, `x265_*.tar.gz` | The exact sidecar sources the build checked against its pins |
| `SHA256SUMS` | Checksums over every file above, `build-info.txt` and `SECURITY.md` |
| `build-info.txt` | The commit, toolchain pins, runner image and Xcode the build used |
| `KookaburraCut-<version>.intoto.jsonl` | GitHub's build provenance attestation over the DMG, pkg, zip, tar, `build-info.txt`, the SBOM and the source archives |
| `SECURITY.md` | The security policy as it stood at the tag |

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify KookaburraCut-<version>.dmg --repo michael-palmes/kookaburra-cut \
  --signer-workflow michael-palmes/kookaburra-cut/.github/workflows/release.yml \
  --source-ref refs/tags/v<version> --deny-self-hosted-runners
grep '^commit=' build-info.txt
git ls-remote https://github.com/michael-palmes/kookaburra-cut 'refs/tags/v<version>^{}'
codesign --verify --deep --strict -vv "/Applications/Kookaburra Cut.app"
codesign -dvv "/Applications/Kookaburra Cut.app"        # flags=0x10000(runtime), Authority=Developer ID Application
spctl -a -t exec -vv "/Applications/Kookaburra Cut.app"  # source=Notarized Developer ID
```

From the source at a tag, a reviewer can also:

- read the updater's public key in `src-tauri/tauri.conf.json` and check the
  `.sig` against it (`scripts/verify-release.sh` does it in CI);
- list every command each window can call (`src-tauri/src/acl.rs`, whose tests
  fail on a command placed nowhere);
- run the suites (`pnpm test`, and `cargo test --manifest-path src-tauri/Cargo.toml`
  after `pnpm setup:ffmpeg` and `pnpm setup:models`) and the fuzz harness
  (`src-tauri/fuzz/README.md`);
- read the CI in `.github/workflows/`: on pull requests `audit.yml`
  (`pnpm audit`, `cargo deny`), `codeql.yml`, `dependency-review.yml` and
  `signers.yml` (signed head commits); on a schedule `scorecard.yml` and
  `fuzz.yml` (which also runs on a pull request touching the harness).
