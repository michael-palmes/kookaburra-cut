# Accessibility

Kookaburra Cut aims for WCAG 2.2 level AA in its own interface: every window, panel, dialog and
menu around the preview. Today it **partially conforms**. This file is the statement, the keyboard
map, how to report a problem, and the Accessibility Conformance Report (ACR) for procurement.

## Statement

- **What we aim for:** WCAG 2.2 A and AA across the app chrome, judged on macOS with the platform's
  own assistive technology (VoiceOver, Keyboard navigation, Reduce motion, Zoom).
- **Where it stands:** most of the chrome is reachable and named, dialogs manage focus, text and
  field borders meet AA contrast, text can be enlarged in Settings, and single-key shortcuts can be
  turned off. Gaps remain: several timeline and reorder edits need a pointer, and text size stops at
  150%. The report below names each one.
- **What it does not cover:** the films you export. Their pixels, captions and contrast are your
  content, built in your theme. The app helps where it can: every export runs a flash check against
  WCAG 2.3.1 and ITU-R BT.1702 and flags stretches to fix.

## Keyboard

Turn on **System Settings › Keyboard › Keyboard navigation** first. Kookaburra Cut's interface runs
in WebKit, so, as in Safari, Tab only reaches text fields and lists until that setting is on.

| Keys | What they do |
| --- | --- |
| Tab, ⇧Tab | Move between controls. In a dialog, focus starts in the dialog and wraps inside it |
| Esc | Close the top-most dialog, menu, popover or picker; focus returns to the control that opened it |
| Return, Space | Press the focused button, card or row; Space or Return selects a row in Project › Scenes |
| ⇧F10 or the menu key | Open a row's right-click menu (Scenes list, scene overview rows, text elements) |
| ↑ ↓ Home End | Move through menus, the command palette results and card grids |
| ⌘K | Find an action (command palette) |
| ⌘, | Settings |
| ⌘/ | Keyboard shortcuts sheet |
| ⌥⌘E | Edit with Claude |
| Space | Play or pause the preview (when focus is not in a text field, or on a button, tab, option or card, which Space presses instead) |
| ← → (⇧ for 10) | Step the preview one frame; with a camera key selected, nudge it |
| ⌫ | Delete the selected keyframe or segment in the animation lane |
| O P Z, M F L T | Camera tools while animating (Orbit mode, Free mode) |
| S F T M | Video editor window: split, freeze, tap tool, mask tool |

The sheet behind ⌘/ lists the full set, grouped by window. **Settings › Accessibility ›
Single-key shortcuts** turns off every shortcut that is one letter or symbol with no modifier (the
O P Z, M F L T and S F T M rows above, and / to search); the sheet then marks those rows off. Every
action they reach keeps its button.

**Settings › Accessibility › Text size** (Default, Large, Larger) enlarges the words and controls in
every window by up to 150%. It never changes the preview or an export.

## Report a problem

Open an issue at <https://github.com/michael-palmes/kookaburra-cut/issues/new> with "Accessibility"
in the title. Include the app version (the welcome screen shows it), your macOS version, the
assistive technology and settings you use, and the steps that went wrong. If the details include
unreleased work you cannot share publicly, use the private route in [SECURITY.md](../SECURITY.md)
instead.

## Accessibility Conformance Report

VPAT® 2.5 Rev, WCAG edition (International Version layout, WCAG 2.2 tables only).

| | |
| --- | --- |
| Product | Kookaburra Cut (macOS, Apple Silicon) |
| Version | 0.23.0 (pending release; evaluated on the development build of 9 November 2026) |
| Report date | 9 November 2026, updated 12 November 2026 |
| Description | A local, deterministic studio for animated product films: a Tauri 2 app whose interface is React in WKWebView, with every exported pixel drawn by one WebGL canvas |
| Contact | <https://github.com/michael-palmes/kookaburra-cut/issues> |
| Standard | WCAG 2.2, Level A and Level AA. Level AAA was not evaluated |
| Interpretation | WCAG2ICT for non-web software: a window counts as a page, and criteria about sets of pages apply to sets of software, so they do not apply to one app |

### Scope

Evaluated: the main window (welcome screen, first-run dialog, New project steps, editor titlebar,
stage controls, inspector tabs and drill-ins, playback bar and animation lane, command palette,
Export, Present, Shortcuts, content and theme pickers), the Settings window, the video editor window
and the pack export window. The theme editor window shares the chrome's components but was reviewed
in code only. Out of scope: exported films and the WebGL preview's pixels, which are the author's
content; the Claude desktop app reached through Edit with Claude.

### Evaluation methods

| Mark | Method |
| --- | --- |
| A | axe-core 4.10.3 (rules tagged wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) run inside the app's own WKWebView on macOS 27.2, on each surface above, before and after the fixes |
| S | Scripted checks in the same webview: computed tab order, accessible names and roles, focus indicators, 24 px target size with the spacing test, controls that are focusable while hidden, dialog focus on open, Tab wrap and restore on close |
| N | The macOS accessibility API (System Events) on the running app: window titles, native dialogs and their buttons |
| T | Contrast computed from the chrome tokens in `src/styles.css` with the WCAG formula; held by `src/ui/accessibility.test.tsx` |
| C | Code review of keyboard handlers, drag interactions, live regions and timing across `src/ui`, `src/editor`, `src/settings` and `src/packs` |
| R | Reflow at Larger text: the real Settings, welcome, editor, Export, palette, shortcuts and packs windows rendered in a browser with native calls stubbed, at each window's minimum size, scanned for clipped or overflowing elements (Chromium, not WKWebView) |

Not yet done, and listed as open below: an end-to-end VoiceOver pass, a physical keyboard pass with
Keyboard navigation on, Voice Control, and a text spacing override across every surface (the live
run was inconclusive).

### Terms

- **Supports:** the functionality meets the criterion without known defects, or with an equivalent
  facilitation.
- **Partially Supports:** some functionality does not meet the criterion.
- **Does Not Support:** the majority of functionality does not meet the criterion.
- **Not Applicable:** the criterion is not relevant to the product.

### Table 1: Success Criteria, Level A

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 1.1.1 Non-text Content | Partially Supports | Icon-only controls carry names; decorative SVGs are hidden; card thumbnails sit beside their text names (A, S). Fixed in 0.23.0: video editor glyph buttons now read Play, Pause, Zoom in, Zoom out; camera tools read Orbit, Pan, Zoom and so on. Fixed in 0.23.0: the preview stage is a landmark named with the scene on screen and the time, such as "Preview: Highlights, scene 2 of 4, at 0:04" (C) |
| 1.2.1 Audio-only and Video-only (Prerecorded) | Supports | The chrome's only video is silent option previews (text motion, looks, backgrounds); each card's visible name says what it shows (C). Imported media is the author's content |
| 1.2.2 Captions (Prerecorded) | Not Applicable | The chrome has no prerecorded audio with video. Captions for exported films are the author's content |
| 1.2.3 Audio Description or Media Alternative (Prerecorded) | Not Applicable | As 1.2.2 |
| 1.3.1 Info and Relationships | Supports | Dialogs have headings; option groups are named fieldsets or radio groups; inspector tabs are a tab list; card grids are list boxes or radio groups; every field has a programmatic label. axe-core found no label, list or heading violations (A, S). Fixed in 0.23.0: the stage is the editor's `main` landmark, and the content picker's Add button points at the picker only while it is open (C) |
| 1.3.2 Meaningful Sequence | Supports | Reading and focus order match the layout: titlebar, stage controls, inspector, playback bar (S) |
| 1.3.3 Sensory Characteristics | Supports | Instructions name the action and the control, never shape or position alone (C) |
| 1.4.1 Use of Color | Supports | Action rows mark selection with a 2 px edge, switches with a moving thumb, errors with an icon and words (C). Fixed in 0.23.0: selected chips, cards and export rows draw a solid accent border at 3.6:1 or better against both the surface and their own fill, so the state no longer rests on a fill tint (T). Every selected state is exposed as pressed or selected to assistive technology |
| 1.4.2 Audio Control | Supports | Sound plays only after the author presses Play, and the playback bar mutes it; option previews are muted (C) |
| 2.1.1 Keyboard | Partially Supports | Menus, dialogs, the inspector, the palette, the timeline slider and card grids work from the keyboard (S, C). Fixed in 0.23.0: Project › Scenes rows select with Space or Return and open their menu with ⇧F10. Pointer only: reordering scenes, library items, themes and editor clips; moving, easing, resizing or duplicating animation keys and segments; beat and tap markers; mask edges and zoom keys; decoration stacking order; chart column insert and delete; the theme card menu (finding H2). Fixed in 0.23.0: Space on a focused button, tab, option or card presses it and no longer also plays the preview (C) |
| 2.1.2 No Keyboard Trap | Supports | Modal dialogs hold Tab by design and close with Esc; everywhere else Tab or Esc moves on (S, C) |
| 2.1.4 Character Key Shortcuts | Supports | Single-key shortcuts work only in the animation mode, the video editor window and pickers (/ to search), never while typing in a field. Fixed in 0.23.0: Settings › Accessibility › Single-key shortcuts turns them all off in every window; the shortcuts sheet says so (C) |
| 2.2.1 Timing Adjustable | Supports | No task has a time limit. Plain confirmation toasts clear after 4 s and are also announced; errors and toasts with an action wait for the author. The two-step scene delete disarms after 3 s and can be repeated (C) |
| 2.2.2 Pause, Stop, Hide | Supports | Fixed in 0.23.0: a selected option card plays its clip once and holds the last frame; hovering or focusing the card plays it again. The transition preview has a pause button and starts paused under Reduce motion. With Reduce motion on, option cards hold a still unless hovered or focused (C, S). The stage moves only when the author presses Play |
| 2.3.1 Three Flashes or Below Threshold | Supports | The chrome does not flash (C). Exports are checked for flashes, as above |
| 2.4.1 Bypass Blocks | Not Applicable | WCAG2ICT applies this to sets of software. Landmarks still name the titlebar, inspector and timeline |
| 2.4.2 Page Titled | Supports | Each window is titled with the app and the window's name, for example the Settings window (S, N) |
| 2.4.3 Focus Order | Supports | Tab follows the layout. Fixed in 0.23.0: every modal dialog that closes with Esc (all but a wordless busy notice) now takes focus when they open, keep Tab inside and return focus to the control that opened them; the collapsed animation lane and camera tools no longer take focus while invisible (S). Verified with scripted key events in the running app; not yet with a physical keyboard and VoiceOver |
| 2.4.4 Link Purpose (In Context) | Supports | The few links name their destination, such as "What leaves your Mac" (C) |
| 2.5.1 Pointer Gestures | Supports | No multipoint or path gesture is needed; pinch and scroll zoom have Zoom out, Fit and Zoom in buttons, and timelines seek on a click (C) |
| 2.5.2 Pointer Cancellation | Supports | Actions fire on release; a press only starts a drag or a selection, both reversible (C) |
| 2.5.3 Label in Name | Supports | Names start with the visible label; icon-only controls use their tooltip's words (A, S) |
| 2.5.4 Motion Actuation | Not Applicable | No device motion input |
| 3.1.1 Language of Page | Supports | Every window declares English (S) |
| 3.2.1 On Focus | Supports | Focus never changes context; its only effect is replaying an option card's preview (C, S) |
| 3.2.2 On Input | Supports | Changing a control updates the live preview, as an editor should, but never opens a window or submits on its own (C) |
| 3.2.6 Consistent Help | Supports | Help sits in the same place in every view: Keyboard Shortcuts in the Project menu (⌘/), Find an Action in the titlebar (⌘K), and "What leaves your Mac" in Settings (C) |
| 3.3.1 Error Identification | Supports | Errors appear as words beside the field or in the dialog, in an alert region, with an icon (C, A) |
| 3.3.2 Labels or Instructions | Supports | Fields have visible labels and format hints, such as m:ss lengths and http or https for the website (C, S) |
| 3.3.7 Redundant Entry | Not Applicable | No process asks for something already entered; the New project steps keep earlier choices on Back |
| 4.1.1 Parsing | Supports | Removed from WCAG 2.2 and listed for 2.0 and 2.1 claims. React generates the DOM; axe-core found no duplicate IDs |
| 4.1.2 Name, Role, Value | Partially Supports | Custom controls expose role and state: card buttons answer Return and Space, the timeline is a slider with a spoken time, toggles report pressed, tabs and grids report selected (A, S). Fixed in 0.23.0: controls hidden from assistive technology but still focusable (now inert), the unnamed command palette dialog, glyph-named buttons. Remaining: animation keys and segments, beat markers and tap markers are unnamed and unfocusable (finding H2); not yet confirmed end to end with VoiceOver |

### Table 2: Success Criteria, Level AA

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| 1.2.4 Captions (Live) | Not Applicable | No live media |
| 1.2.5 Audio Description (Prerecorded) | Not Applicable | As 1.2.2 |
| 1.3.4 Orientation | Supports | Windows resize freely and nothing locks to one orientation (C) |
| 1.3.5 Identify Input Purpose | Supports | The only fields about the user, Settings' pack publisher name, organisation and website, declare their purpose. Fixed in 0.23.0 (C, T) |
| 1.4.3 Contrast (Minimum) | Supports | Fixed in 0.23.0: the tertiary text token rose from 3.1 to 4.1:1 to 4.7 to 6.3:1 on every surface tier; two labels moved off the disabled grey (2.2:1); danger text on dialogs and menus now reads 5.4:1. Every axe-core contrast failure before the fix (about 80 elements across the surfaces tested) traced to these tokens (A, T). Also fixed: tertiary hints inside a hovered or selected row (font picker, collections, action and toggle rows, template and text motion cards) lift to the secondary tier, 4.6:1 or better on every wash (T) |
| 1.4.4 Resize Text | Partially Supports | Fixed in 0.23.0: Settings › Accessibility › Text size enlarges every window's text and control heights to 125% or 150%, live and without a restart; dialogs scroll when they outgrow the window, and the inspector widens with the text (R). It stops short of the 200% the criterion names; beyond 150%, macOS Zoom magnifies the screen (finding H3) |
| 1.4.5 Images of Text | Supports | All chrome text, including the wordmark, is live text (C) |
| 1.4.10 Reflow | Partially Supports | The stage, timeline and inspector are a two-dimensional editing layout the exception covers; scene labels in the playback bar shorten with their scene's length. At Larger text and each window's minimum size, Settings, the welcome screen, Export, the palette, the shortcuts sheet and the packs window reflow without clipping or sideways scroll (R). Not yet checked at that size: the video editor and theme editor windows, and any window in WKWebView itself. A 320 px equivalent is out of reach without zoom (finding H3) |
| 1.4.11 Non-text Contrast | Supports | The focus ring (5.3 to 7.0:1), accent fills (4.8 to 5.4:1) and switch thumbs clear 3:1 (T). Fixed in 0.23.0: field and select outlines use `--border-control` (white at 34%, 3.0 to 3.1:1 on every tier) and selected borders solid accent (3.6:1 or better) (T) |
| 1.4.12 Text Spacing | Partially Supports | Not confirmed live: the override run was inconclusive. By code review, 57 rules hold labels to one line with an ellipsis in fixed widths, so wider spacing truncates those labels rather than overlapping them (finding L5) |
| 1.4.13 Content on Hover or Focus | Supports | Tooltips are the system's own; no custom pop-up appears on hover or focus without a click (C) |
| 2.4.5 Multiple Ways | Not Applicable | WCAG2ICT applies this to sets of software. Commands are reachable from the menus and the ⌘K palette as well |
| 2.4.6 Headings and Labels | Supports | Headings and labels describe their purpose (A, S) |
| 2.4.7 Focus Visible | Supports | One global rule draws a 2 px blue ring on every focused control, and the only overrides draw a replacement (C, T). Fixed in 0.23.0: three text fields that hid it (palette search, slider value, chart series name). Rings inside scrolling panels were not checked for clipping with a physical keyboard |
| 2.4.11 Focus Not Obscured (Minimum) | Supports | The window never scrolls; panels scroll inside fixed frames with pinned footers outside the scroll area, and popovers open beside their control (C) |
| 2.5.7 Dragging Movements | Partially Supports | Every stage gizmo and camera move has numeric fields, sliders take a click, playheads seek on a click, and clip trims have Split and Remove (C). No single-pointer way exists to reorder scenes, library items, themes or editor clips; move an animation segment or retime a key; move a mask, zoom key or tap marker; or orbit and pan a screenshot stack (finding H2) |
| 2.5.8 Target Size (Minimum) | Supports | Controls are 28 px or larger; smaller ones (22 px chips, 20 px steppers, checkboxes with clickable labels) pass the 24 px spacing test on every surface measured (S). Stage gizmo handles are drawn in WebGL and not measured; the inspector fields are their equivalent |
| 3.1.2 Language of Parts | Supports | The chrome is English throughout; authors' copy is their content |
| 3.2.3 Consistent Navigation | Not Applicable | WCAG2ICT applies this to sets of software. The titlebar and inspector keep one order in every view |
| 3.2.4 Consistent Identification | Not Applicable | As 3.2.3. The same function keeps the same icon and name across windows |
| 3.3.3 Error Suggestion | Partially Supports | Name clashes and failed imports say what to change (C). Fixed in 0.23.0: the inspector's scene length and the transition length say why a typed value reverted, beside the field ("Use m:ss, like 0:04"). Scene lengths typed in the playback bar or Project › Scenes still revert without a word (finding L2) |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Supports | No legal or financial transactions. Deleting scenes takes two steps and is recoverable from the Trash; edits have Undo (C) |
| 3.3.8 Accessible Authentication (Minimum) | Not Applicable | There is no sign-in |
| 4.1.3 Status Messages | Supports | Toasts, project loading, Claude activity and New project results use status or polite live regions; errors use alerts (C, A). Fixed in 0.23.0: an always-present polite region speaks export, stills and Verify progress every 10%, each encoding pass, and how the run ended (C). Not yet heard end to end with VoiceOver |

### Legal disclaimer

This report describes the product as evaluated on the date above, by the maintainer, with the
methods listed. It is not a certification. VPAT is a registered trademark of the Information
Technology Industry Council (ITI).

## Open findings

Severity follows the effect on a task: **High** blocks a task for some people, **Medium** makes one
much harder, **Low** is friction. "Decision" marks a change that alters the look or behaviour and
needs the maintainer's call.

| ID | Severity | Criteria | Finding | Proposed approach | Decision |
| --- | --- | --- | --- | --- | --- |
| H2 | High | 2.1.1, 2.5.7, 4.1.2 | Timeline and reorder edits need a pointer (the 2.1.1 list) | Short term: Move up and Move down in the scene, theme and library menus (a click alternative and a keyboard one). Then a keyboard model for the animation lane and the video editor timeline: roving focus over keys and segments, arrows to move, ⇧F10 for the menu | Yes, for the lane model |
| H3 | Medium | 1.4.4, 1.4.10 | Text size stops at 150%; the criterion names 200% | Add a Largest step at 200% after a reflow pass of every window at that size | Yes |
| L2 | Low | 3.3.3 | A scene length typed in the playback bar or Project › Scenes reverts without a word | Show `SCENE_LENGTH_HINT` beside those fields, as the inspector does (after the H2 work in those files lands) | No |
| L5 | Low | 1.4.12 | Text spacing unverified; ellipsis labels truncate | Run the spacing override across every surface; allow two lines where a label truncates | No |

### Closed in 0.23.0

| ID | Criteria | What changed |
| --- | --- | --- |
| H1 | 1.4.4, 1.4.10 | Settings › Accessibility › Text size scales every text and control-height token in every window, live; the preview and exports never read it. 200% is still open as H3 |
| M1 | 2.1.1 | The transport's Space handler stands down on a focused button, tab, option or card |
| M2 | 2.1.4 | Settings › Accessibility › Single-key shortcuts, on by default, turns every bare letter or symbol shortcut off; the shortcuts sheet says so |
| M3 | 1.4.11, 1.4.1 | Field and select outlines at white 34% (3:1 on every tier); selected borders solid accent |
| M4 | 2.2.2 | A selected option preview plays once and holds; hover or focus plays it again; the transition preview has a pause |
| M5 | 4.1.3 | A polite live region speaks export progress every 10% and the outcome |
| L1 | 1.4.3 | Tertiary hints lift to secondary inside hovered and selected rows |
| L2 (part) | 3.3.3 | The inspector's scene length and the transition length say why an entry reverted |
| L3 | 1.1.1 | The stage is named with the scene on screen and the time |
| L6 | 1.3.1 | The stage is the `main` landmark; the content picker's `aria-controls` exists only while it is open |

Verification still owed: a VoiceOver walk through New project, editing a scene and Export,
including the export progress announcements; a physical keyboard pass with Keyboard navigation on;
the theme editor window live; Text size at Larger in the app itself (WKWebView), the video editor
and theme editor windows included; the Single-key shortcuts switch in the animation lane and the
video editor; the text spacing override (L5).
