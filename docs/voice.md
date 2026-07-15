# Voice

Voice, tone and story for **Kookaburra Cut**: how the product talks, and the story it lives in.
Audience for this file: AI writing tooling (Claude Code, Cursor, Copilot) and any human collaborator.
Treat it as the source of truth for **words**. When a request conflicts with this file, surface the
conflict rather than quietly overriding it.

> Companion documents: **[design.md](./design.md)** governs how Kookaburra Cut *looks*;
> **[architecture.md](./architecture.md)** governs how it's *built* and owns the technical
> vocabulary (project, scene, toolkit, FormatContext). This file governs how it *sounds*.

---

## 0. Scope & status

- **What this governs:** every user-facing word: UI microcopy, empty states, errors, export
  messages, onboarding, the About moment, taglines, and the voice of the docs (`README`,
  `CLAUDE.md`, `SKILL.md`).
- **The bird:** Kookaburra Cut is named for the **laughing kookaburra**, the bird whose call
  carries across the quiet at dusk and dawn. The product lives in the **night studio** (design.md
  §1): a quiet room after dark where the preview is the light. The bird supplies the story and the
  palette, never a mascot.
- **Language:** **Australian English** throughout: *colour, behaviour, organise, centre, licence
  (noun)*. No US spellings in shipped copy.
- **Restraint first.** design.md's house style is "the chrome should recede." Words follow the same
  rule: the story is **punctuation, not wallpaper** (§4). When in doubt, say less.

---

## 1. The story

**A kookaburra's call carries across the quiet.** Kookaburra Cut gives new product work the same
clarity: you shaped something worth showing; the film that announces it should be clear,
unmistakable, and the same every time you play it.

> **The call** *is* **the finished cut**: new work, made heard and seen clearly.

| Brand idea | Product meaning |
|---|---|
| **The call** | Announcing a new feature or update |
| **Carries clearly** | Communicating what changed, without clutter |
| **Breaks the quiet** | Giving shipped work a moment of attention |
| **Recognisable every time** | Consistent, deterministic output |
| **The night studio** | A focused, local creative environment |

The critical distinction: **Kookaburra Cut is never loud.** The call is clear and unmistakable,
not noisy. We help the work get noticed; we don't shout on its behalf.

---

## 2. Positioning

**Core message: it's local, it's private, it's yours.** The first promise is ownership: your
machine, your files, nothing leaves your Mac. Determinism and craft are *how* we keep that promise
trustworthy.

**The voice white-space we own.** The AI-video field splits into two loud camps: **cosmic
grandeur** ("simulate the world") and **frictionless democratisation** ("as easy as typing"). The
craft/premium camp is terse and human, but **nobody owns *local + deterministic + reproducible***.
That lane is ours: a quiet, exact, craftsman's voice that makes **determinism the romance, not the
spec sheet**, working after dark, until the new thing is ready to make itself known.

**What we are / what we're not.**

| We are | We're not |
|---|---|
| Local, private, yours | Cloud, subscription, "your footage on our servers" |
| Exact, reproducible, trustworthy | "Close enough," render-roulette, surprising |
| Warm, assured, craftsmanlike | Hype-y, cosmic, or cute |
| A quiet studio after dark | A megaphone, a mascot, a meme account |

---

## 3. Voice principles

1. **Warm and assured.** Calm and professional, but less austere than the old voice. We talk *with*
   the maker, not at them.
2. **Make the work noticeable.** The product exists to give newly shipped features a clear moment.
   Copy points at *their* work, not at us.
3. **Plain while working.** Timeline, inspector, export and error language stays literal. The
   places where work happens never make someone read a sentence twice.
4. **Character at the edges.** The kookaburra and the night story appear at arrival, completion and
   identity moments only.
5. **Dry, not jokey.** A little Australian warmth is welcome; never slang-heavy, never mascot-like.
6. **Clarity over cleverness.** No bird-call puns where the user is trying to finish work. When
   flavour and clarity conflict, clarity wins, always.

---

## 4. Tone by context

Tone flexes by where the user is. The rule of thumb: **theme at thresholds, neutral at work.**

| Context | Theme? | Tone | Example |
|---|---|---|---|
| **First-run / welcome** | Yes | Welcoming, capable | "Turn your latest features into polished product films, entirely on this Mac." |
| **Empty states** | Yes | Inviting, forward-looking | "Nothing on the stage yet. Add a scene and give your latest work its moment." |
| **Export: done** | Yes | Quietly proud, exact | "Your cut is ready: identical, frame for frame." |
| **About / wordmark** | Yes | Identity, provenance, one dry aside | "Built after dark in South Australia. Runs entirely on your Mac." |
| **Working surfaces** (timeline, inspector, transport) | **No** | Neutral, terse, instrumental | "Duration", "Add scene", "1920 × 1080" |
| **Export: in progress** | No | Factual, real numbers | "Rendering: frame 412 / 900" |
| **Errors & warnings** | **No** | Warm, literal, a path forward | "That export didn't finish. Here's the log so we can sort it." |
| **Docs** (`README`, `CLAUDE.md`, `SKILL.md`) | Light | Plain, practical; story in the intro only | (story up top; reference stays literal) |

**Why thresholds.** Moments of arrival, transition and completion can carry meaning without
costing the maker speed. Work surfaces stay quiet so the work can be loud.

---

## 5. The wit rule

A **rare** dry aside is welcome, and only in safe moments: the About panel, first-run, an
occasional empty state. The ceiling is the single approved About aside:

- ✅ About aside (the maximum level of kookaburra humour): **"No early-morning wake-up call
  required."**
- ❌ **Never** in an error: ~~"That one didn't carry."~~ → "That export didn't finish. Here's the
  log."
- ❌ **Never** mid-task or in a destructive confirm. Speed and trust outrank a joke every time.

One aside per surface, maximum. If you're reaching for a second, it's already too loud.

---

## 6. Lexicon

**A literal core, one themed noun.** The everyday words stay plain and match `architecture.md`, so
authoring code and copy agree. The single flourish is **the cut**.

| Concept | We say | Notes |
|---|---|---|
| A video folder / the unit of work | **Project** | Literal; matches `project.json` and the code. |
| A unit of the video | **Scene** | Literal; matches `defineScene`. |
| The shipped primitives | **Toolkit** | Literal. |
| Rendering to a file | **Export** | Literal verb in menus, settings, status. The core action. |
| **The finished exported film** | **The cut** | The one themed noun: threshold moments only ("Your cut is ready"). Never a verb, never a menu label. |
| The preview surface | **Stage** | The lit area of the night studio; ties to "the preview is the light". |

**Retired with the old identity:** *reel* (now project), *dive / surface / the catch* (the old
export story), *colony*, salt-air texture. None of these appear in new copy.

**Literal-core principle.** If a themed name would ever make a maker (or Claude Code) hesitate
about what a thing *is*, use the literal word. The theme serves comprehension; it never competes
with it.

---

## 7. Taglines & signature lines

**Primary tagline (LOCKED):**

> **Give every feature its moment.**

**Approved alternates (use by context, never all at once):**
- *"Make what's new worth watching."*
- *"Your latest work, ready to be seen."*
- Determinism pairing: *"The same film, every time."* (support only, never the headline)

**Export-complete line (LOCKED):** *"Your cut is ready: identical, frame for frame."*

**About-panel line (LOCKED):** *"Built after dark in South Australia. Runs entirely on your Mac."*
(Optionally followed by the single aside: *"No early-morning wake-up call required."*)

**Wordmark sign-off:** *"Kookaburra Cut: a local animated-video studio for macOS."*

Keep the set small. New lines must lead with the work's moment, ownership, or determinism, never
with "AI", "magic", or "the future of video".

---

## 8. Microcopy library

Approved, on-voice lines. Copy these; extend them in the same register. *(Wired = shipping in the
app today; Library = approved, awaiting its surface.)*

**Welcome / first-run** *(wired)*
- Title: the wordmark (design.md §5.4).
- Empty-workspace body: "Turn your latest features into polished product films, entirely on this
  Mac."
- With projects: "Your video projects."
- Primary action: "New project"

**Empty states**
- No scenes in a project *(library, no surface yet)*: "Nothing on the stage yet. Add a scene and
  give your latest work its moment."
- No media *(wired)*: "Drop in footage, images or logos: everything stays on your Mac."

**Export: in progress** *(wired; factual, no theme)*
- "Rendering: frame {n} / {total}" · "Encoding {format} · {resolution}"

**Export: done** *(wired, LOCKED)*
- "Your cut is ready: identical, frame for frame." · actions "Show in Finder" · dismiss
- Verify result stays factual: per-aspect ✓/✗ + hashes (a working readout, not a threshold).

**Errors & warnings** *(warm, literal, a path forward, never themed, never witty)*
- Export failed: "That export didn't finish. Here's the log so we can sort it." · "View log"
- Missing asset: "Couldn't find {file}. It may have moved or been renamed." · "Relink…"

**Destructive confirms** *(plain, specific, calm)*
- "Delete scene "{name}"? This can't be undone." · "Delete" · "Cancel"
- (The house pattern stands: two-step arming, hints never shift layout.)

**About** *(wired: the Welcome footer carries the line; the aside rides its tooltip)*
- "Built after dark in South Australia. Runs entirely on your Mac."
- Aside (the only one): "No early-morning wake-up call required."

---

## 9. Guardrails / anti-patterns

1. **Never loud.** The call is clear, not noisy: no exclamation marks in shipped copy, no
   cheerleading, no "amazing/incredible". Reassure by being specific.
2. **No recurring bird-call language.** *Cackle, laugh, squawk, wake-up call* are banned as
   product vocabulary. The single About aside is the sole, deliberate exception. The kookaburra
   is a story source, not a running gag.
3. **No theme on working surfaces.** Timeline, inspector and transport labels stay literal and
   terse. "Night Kookaburra" is an internal art-direction phrase, never user-facing.
4. **No wit in errors, warnings, or destructive confirms.** Ever.
5. **Place is provenance, not decoration.** "Built after dark in South Australia" is the whole
   geography story; don't wave a flag, don't add outback texture.
6. **Determinism is romance, not a data dump.** Lead with the feeling ("the same film, every
   time", "identical, frame for frame"), then the spec if needed ("byte-identical").
7. **No buzzwords.** "AI-powered", "magic", "seamless", "revolutionary", "effortless", banned as
   adjectives. Show the benefit instead.
8. **Australian English**, no exceptions in shipped copy.
9. **Name availability** (trademark / app name / npm / GitHub) for "Kookaburra Cut" is a
   recorded pre-public-launch check, not a blocker.

---

## 10. Application checklist (definition of done for any new string)

Before shipping a piece of copy, confirm:

- [ ] **Right register for the context** (§4): themed only at a threshold; neutral at work.
- [ ] **In control & trusting**: does it reassure by being specific, not by hype?
- [ ] **Terse**: could a word or a whole sentence come out without losing meaning?
- [ ] **On-story (if themed)**: the call / the night studio / the cut, and only one at a time.
- [ ] **Never loud**: would it still read right whispered?
- [ ] **Errors stay warm + literal + actionable**: no theme, no wit, a clear next step.
- [ ] **No guardrail tripped** (§9): no bird-call vocabulary, no buzzwords, no flag-waving.
- [ ] **Australian English.**
- [ ] **Lexicon honoured** (§6): literal core; "the cut" only at thresholds.
