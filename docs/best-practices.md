# OpenSSF Best Practices badge

The answers behind the project's entry at
[bestpractices.dev](https://www.bestpractices.dev/), one line per "passing"
criterion, so the entry can be checked against the repository and refreshed
when something changes. The entry is self-certified by the maintainer; this
file is the record of what each answer rests on.

Project page: the repository itself (README, docs, releases). Languages:
TypeScript, Rust.

## Basics

| Criterion | Status | Basis |
|---|---|---|
| description_good | Met | README opens with what the app does and the problem it solves. |
| interact | Met | README "Download", "Building from source" and "Contributing & security" cover obtaining, feedback and contributing. |
| contribution | Met | `CONTRIBUTING.md`: issues first, pull requests, the checks every change runs. |
| contribution_requirements | Met | `CONTRIBUTING.md` names the checks (`pnpm test`, `pnpm build`, `pnpm lint`) and the test policy; biome and clippy enforce the coding standard. |
| floss_license | Met | MIT OR Apache-2.0. |
| floss_license_osi | Met | Both OSI approved. |
| license_location | Met | `LICENSE-MIT` and `LICENSE-APACHE` at the repository root. |
| documentation_basics | Met | README plus `docs/` (architecture, determinism, packs, charts, stills, MDM). |
| documentation_interface | Met | External inputs and outputs are documented: the project folder format and the headless CLI (`docs/agent-kit.md`), the `.kbpack` format (`docs/packs.md`), managed preferences (`docs/mdm.md`), export presets and the release assets (`SECURITY.md`, "Release integrity"). |
| sites_https | Met | Everything is served by GitHub over HTTPS. |
| discussion | Met | GitHub Issues and Discussions, no proprietary client needed. |
| english | Met | Documentation, issues and comments are in English. |
| maintained | Met | Regular releases and merges; see the commit history. |

## Change control

| Criterion | Status | Basis |
|---|---|---|
| repo_public | Met | github.com/michael-palmes/kookaburra-cut. |
| repo_track | Met | Git history with signed commits. |
| repo_interim | Met | Every change lands through a pull request on `main` between releases. |
| repo_distributed | Met | Git. |
| version_unique | Met | Semantic versions, one per release. |
| version_semver | Met | SemVer. |
| version_tags | Met | Signed `v*` tags; a release is built from the tag by the release workflow. |
| release_notes | Met | `CHANGELOG.md` (Keep a Changelog) and the GitHub release body. |
| release_notes_vulns | Met | The changelog's "Security" sections name the advisories a release clears. |

## Reporting

| Criterion | Status | Basis |
|---|---|---|
| report_process | Met | GitHub Issues with bug and feature templates (`.github/ISSUE_TEMPLATE/`). |
| report_tracker | Met | GitHub Issues. |
| report_responses | N/A | No bug reports have been filed in the period; the maintainer answers issues as they arrive. |
| enhancement_responses | N/A | Same as above. |
| report_archive | Met | Issues and Discussions are public and searchable. |
| vulnerability_report_process | Met | `SECURITY.md`, "Reporting a vulnerability". |
| vulnerability_report_private | Met | GitHub private vulnerability reporting, linked from `SECURITY.md`. |
| vulnerability_report_response | N/A | No vulnerability reports received in the last six months. |

## Quality

| Criterion | Status | Basis |
|---|---|---|
| build | Met | `pnpm build` and `pnpm tauri build` rebuild the app from source; the release workflow does the same on a fresh runner. |
| build_common_tools | Met | pnpm, Vite, cargo, Tauri. |
| build_floss_tools | Unmet | The macOS build needs Apple's Xcode command line tools; every other tool is FLOSS. |
| test | Met | `pnpm test` (vitest, node tests, the kit suite) and `cargo test`; documented in README and `CONTRIBUTING.md`. |
| test_invocation | Met | `pnpm test` and `cargo test`. |
| test_most | Unmet | The engine, edit maths, parsers and the Rust shell are well covered; the React chrome less so. |
| test_continuous_integration | Met | `.github/workflows/ci.yml` on every pull request and push to `main`. |
| test_policy | Met | `CONTRIBUTING.md`: new functionality lands with tests. |
| tests_are_added | Met | Recent feature and fix pull requests add or extend tests beside the change. |
| tests_documented_added | Met | `CONTRIBUTING.md` and the pull request template. |
| warnings | Met | `cargo clippy -D warnings`, biome's recommended rules, strict TypeScript. |
| warnings_fixed | Met | CI fails on any warning. |
| warnings_strict | Met | Clippy denies warnings across all targets; biome runs on the whole tree. |

## Security

| Criterion | Status | Basis |
|---|---|---|
| know_secure_design | Met | The maintainer designs and reviews the app's trust boundaries (`SECURITY.md` describes them in full). |
| know_common_errors | Met | `SECURITY.md` and `docs/packs.md` work through the common classes (path traversal, zip bombs, symlinks, unsigned updates, injection through IPC) and how each is closed. |
| crypto_published | Met | Ed25519 (pack signing, via ed25519-dalek), SHA-256 digests, minisign (the updater), Apple code signing, TLS for the update check. |
| crypto_call | Met | Only library implementations are used. |
| crypto_floss | Met | ed25519-dalek, sha2, rustls and the Tauri updater's minisign are FLOSS. |
| crypto_keylength | Met | Ed25519 and SHA-256 only; nothing smaller can be configured. |
| crypto_working | Met | No MD5, SHA-1 or RSA under 2048 anywhere in the app's own cryptography. |
| crypto_weaknesses | Met | As above. |
| crypto_pfs | N/A | The app defines no key-agreement protocol; the update check speaks TLS through the platform stack. |
| crypto_password_storage | N/A | The app stores no passwords. |
| crypto_random | Met | Keys come from the OS entropy source (`getrandom`), see `src-tauri/src/pack/key.rs`. |
| delivery_mitm | Met | Releases are served over HTTPS, the app is Developer ID signed and notarised, and the in-app updater verifies a minisign signature bound to the version. |
| delivery_unsigned | Met | The updater never installs an unsigned archive; `SHA256SUMS` and the provenance bundle sit beside each release for manual checks. |
| vulnerabilities_fixed_60_days | Met | Dependabot weekly, `pnpm audit` and `cargo deny` on every pull request, CodeQL weekly. |
| vulnerabilities_critical_fixed | Met | Advisories are cleared in the next release (see the changelog's Security sections). |
| no_leaked_credentials | Met | GitHub secret scanning and push protection are on; release secrets live in a protected environment. |

## Analysis

| Criterion | Status | Basis |
|---|---|---|
| static_analysis | Met | CodeQL (JavaScript/TypeScript, Rust, Actions), clippy, biome, OpenSSF Scorecard. |
| static_analysis_common_vulnerabilities | Met | CodeQL's security queries. |
| static_analysis_fixed | Met | Open Scorecard alerts are the checks this file's own pull requests close; the one CodeQL alert points inside Tauri's `generate_context!` expansion (a hard-coded value the macro emits, not an app key or nonce) and is dismissed as a false positive. |
| static_analysis_often | Met | On every pull request and push, plus weekly. |
| dynamic_analysis | Met | The determinism gate exports every gate project twice and compares bytes before a merge; cargo-fuzz runs weekly over the untrusted-input parsers. |
| dynamic_analysis_unsafe | Unmet | The few `unsafe` blocks (objc2 bridges) are not yet run under a sanitiser; listed under "Not yet" in `SECURITY.md`. |
| dynamic_analysis_enable_assertions | Met | `cargo test` and the fuzz builds run with debug assertions on. |
| dynamic_analysis_fixed | Met | Nothing outstanding. |
