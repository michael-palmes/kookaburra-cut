# Website scene content

A **website** is singleton scene content (sidecar `website` block): a styled,
screen-locked browser panel that is live only when the user activates it in the
paused editor or while a Present slideshow holds on its scene. Timeline
playback, transitions, Present video mode, Verify and export render a manually
captured PNG. They never load a URL.

Website content is untrusted remote code. This document is both the authoring
contract and the threat model for the native child WKWebView boundary.

## Locked decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Live scope | Explicit activation in the paused editor and the holding phase of a slideshow | Native content cannot participate in deterministic WebGL composition or slide transitions |
| Export truth | A manually captured viewport PNG; an imported image is the fallback | Export remains a pure function of project bytes |
| URL policy | HTTPS, plus opt-in HTTP on exact loopback hosts with an explicit port | Remote cleartext transport is never needed; local development remains practical |
| Consent | Every top-level origin needs a local project-and-origin grant before its first request | Opening, importing and selecting a project must remain offline |
| Browser profile | One app-wide persistent Website profile, separate from Safari and the app webview | Logins work across projects without giving packs cookies or grants |
| Focus | Click to focus; Shift+Esc or the first outside click releases | Matches Terminal without stealing deck navigation |
| Permissions | Deny device access, uploads, downloads and autofill | A presentation is not a general-purpose browser |
| Popup handling | Navigate the same panel through the same origin gate | Prevents unowned native windows and keeps the trust display authoritative |
| View lifetime | Lazy views, eight process-wide, inactive least-recently-used eviction | Bounds WebContent memory while preserving active state where possible |
| Uncaptured export | Warn and render the themed empty browser frame | Missing capture is visible but does not block a legitimate export |

The application minimum is macOS 26. Website views share one named persistent
WebKit data store. Origin grants remain keyed to the canonical project path, so
copying or importing a project never inherits approval.

## The block

```jsonc
"website": {
  "url": "https://example.com/product?mode=demo#overview",
  "requestedOrigins": ["https://example.com"],
  "viewport": {
    "preset": "desktop",          // desktop, tablet, mobile or custom
    "orientation": "landscape",  // swaps a preset's dimensions
    "zoom": 1
  },
  "frame": {
    "appearance": "match-theme", // match-theme, light or dark
    "cornerRadius": 14,
    "shadow": "soft"              // none, soft or strong
  },
  "position": [0, 0],
  "size": 0.72,
  "capture": {
    "src": "assets/website/01-intro.png",
    "width": 1440,
    "height": 900,
    "source": "snapshot",
    "sourceOrigin": "https://example.com",
    "fingerprint": "v1:..."
  }
}
```

Preset CSS viewports are Desktop 1440 by 900, Tablet 1024 by 768 and Mobile
390 by 844. Custom dimensions are bounded to 320-3840 by 240-2160. Zoom is
0.5-2.0. The frame supports theme-matched, light and dark appearance, 0-32 px
corners and none, soft or strong shadow. There is no crop, free content offset,
rotation, browser-skin catalogue or second website block.

The authored URL preserves its path, query and fragment. Embedded usernames or
passwords are rejected. `requestedOrigins` is portable authoring data, not a
permission. The capture fingerprint covers the authored URL, viewport, zoom
and frame settings. Those changes retain the old capture and mark it stale;
panel position and size do not.

Parse, resolve and layout follow the Terminal degrade-not-throw pattern. An
invalid field falls back independently. Invalid content renders an empty themed
browser frame and a diagnostic rather than preventing the scene from loading.

## Origin and navigation policy

HTTPS URLs are accepted. HTTP is accepted only when the host is exactly
`localhost`, `127.0.0.1` or `[::1]` and an explicit port is present. Remote
HTTP, embedded credentials, `file:`, `data:`, `javascript:`, `blob:`, `tauri:`,
asset and other custom schemes are refused. TLS errors are never bypassed.

The native view starts at `about:blank`. All delegates and policy handlers are
installed before an approved request is issued. Saving an authored URL adds its
normalised origin to `requestedOrigins`, but no request happens until the user
activates the panel and grants that origin locally.

Persistent HTTPS grants are keyed by canonical project path and normalised
origin. Loopback grants, including loopback HTTPS, last only for the current app
session because port ownership can change. A top-level navigation to another
origin pauses before its request. The editor may approve it, adding both the
authored request and local grant. Present never prompts or mutates a project;
it denies unapproved navigation and leaves the capture visible.

New-window requests are converted to same-panel navigation. HTTP
authentication and client-certificate challenges are cancelled. Form and
cookie-based authentication is supported. Subresources retain ordinary browser
network reach once their top-level page is approved; the feature does not claim
to be an egress or LAN sandbox.

## Native boundary

One Rust adapter owns every remote child WKWebView. It is the only module that
may create, show, move, capture or destroy one.

- Remote view labels receive no Tauri capability and are never added to
  `remote.urls`.
- Every registered native command rejects callers outside the trusted local
  app-window set. Present receives only its minimum navigation and geometry
  surface.
- Remote content cannot broadcast app events. Adapter events target the owning
  local window and contain only view state and a normalised origin.
- The WebKit UI and navigation delegates deny camera, microphone, location,
  notifications and sensors; cancel file panels and downloads; enforce a user
  gesture for audio or video; and route popup navigation through the origin
  policy.
- Normal WebKit copy and paste works while the website owns focus. There is no
  app clipboard bridge. Credential, contact and payment autofill is disabled.
- Context menus are editor-only. Web Inspector is debug-editor-only and never
  present in a packaged release or Present.
- Logs never include a full URL, query, fragment, page content, cookie or
  credential.

The child WebView API and any WebKit delegate integration remain behind the one
adapter with exact dependency pins. A deliberate Tauri or Wry upgrade reruns
the packaged acceptance suite before the pins move.

## Rendering and live views

The WebGL renderer draws the browser chrome, trusted origin bar, controls,
shadow and captured content. The native child view occupies only the inner page
rectangle. Page content can therefore never spoof the app-owned origin display.

The editor shows the poster until a direct panel click activates live mode.
While live, placement is frozen and its gizmo is hidden. The Present window
shows the poster through entering and leaving transitions. During the hold it
keeps the poster visible until the approved page is ready, then swaps to the
native view. A failed load returns to the poster with a discreet app-owned
unavailable state.

The child WKWebView always sits above the editor WKWebView, so DOM stacking
cannot place app chrome over it. Mounting any `.modal-overlay` hides and
defocuses the native view, exposes the poster below it, and restores the same
view only after the final blocking overlay closes. Export applies the same
rule. Restoration remains conditional on the same scene still requesting live
mode and the view still being ready. Hiding preserves page state, but does not
pause page scripts or network activity.

One Website and one Terminal may coexist. Website is the top interactive layer
and only one block owns input. While Website is focused, deck keys stand down.
Shift+Esc releases focus; the first outside click releases without advancing.

Views are lazy and capped at eight across the process. Inactive views are
evicted least-recently-used. A surviving view preserves navigation, scroll and
form state during the current app or presentation run. An evicted view and each
new presentation start again at the authored URL.

## Capture and export

`Capture current view` snapshots only the visible configured viewport. The
native result is normalised to the configured CSS dimensions as an sRGB PNG,
metadata is stripped and the file atomically replaces
`assets/website/<scene-stem>.png`. The browser chrome is not baked into the
asset, so the deterministic renderer can restyle it.

The capture action shows an inline reminder with the current origin and states
that the PNG becomes a project asset and may travel in packs. A failed capture
leaves the previous asset untouched. `Choose image` performs the same decode
and normalisation, then contains the image inside the configured viewport with
the themed surface behind it.

Timeline playback, Verify and export never construct a remote view. Export
preflight warns once per scene for a missing or stale capture, then continues.
A stale capture remains export truth. A missing capture renders the empty
browser frame.

## Packs and local data

A pack includes the sidecar and capture PNG. It never includes cookies, WebKit
storage, local origin grants, current navigation, history, forms or scroll.
Import performs no network access and grants no origin. The post-import summary
lists every requested Website origin and calls out loopback requests before the
user configures live use in the editor.

Settings lists the dedicated Website store's WebKit site records and can clear
one record or all Website data. Clearing data signs sites out but does not edit
project origin requests.

## Packaged acceptance gate

This feature is not accepted through browser-only tests. The exact branch-built
macOS 26 app must prove:

1. A public HTTPS page with frame-blocking headers loads in the child view.
2. Preset and custom CSS viewport dimensions, Retina scaling and pointer
   coordinates remain exact while resizing, presenting fullscreen and moving
   between displays.
3. Hostile remote content cannot invoke app or plugin commands.
4. Device permissions, upload panels, downloads, autofill and autoplay sound
   are denied without private WebKit APIs.
5. Origin consent happens before the first request; editor approval and Present
   denial behave as documented.
6. App-wide cookies persist separately from Safari, project grants remain
   separate, loopback grants expire on restart and per-site clearing works.
7. Capture, failure fallback, modal occlusion, view cleanup and inactive LRU
   eviction work.
8. Public HTTPS, a controlled multi-origin authenticated SPA and an HTTP
   loopback fixture all pass.

If supported APIs plus the pinned adapter cannot meet any security boundary,
the feature does not ship with a weaker substitute.

## Accepted residual risk

- Approved pages and their subresources have browser-equivalent network reach,
  including DNS-based access to local services.
- Separately approved projects share same-origin login state through the
  app-wide Website profile.
- Captured pixels and authored query strings may contain secrets and may be
  committed or packed.
- WebKit vulnerabilities remain possible.
- Opener-dependent OAuth, protected media and non-snapshotable surfaces may not
  work; image import is the fallback.
- Native content cannot receive WebGL effects, masks or animated transforms.
- A hidden live view may continue running page scripts and network requests.
- LRU eviction loses unsaved in-page state.
