# safa.ai design documentation

This file is the source of truth for how the safa.ai web app looks, moves, and speaks. Any new UI work (by a person or an AI assistant) should follow these rules, and any deliberate deviation should update this file in the same change.

## 1. Design tokens

Defined in `app/globals.css` under `:root`. Always use the variables, never hard-coded values.

| Token | Value | Role |
|---|---|---|
| `--coral` | `#EE6C4D` | Primary accent: primary buttons, active states, user chat bubbles, progress |
| `--coral-deep` | `#DA5537` | Accent hover state, links on hover, emphasis text |
| `--ink` | `#2C211C` | Primary text |
| `--ink-soft` | `#6E5B51` | Secondary text, descriptions, labels |
| `--muted` | `#9C8B80` | Tertiary text, placeholders, section labels |
| `--line` | `rgba(44,33,28,.13)` | All hairline borders |
| `--bg` | `#FFF9F5` | App background (warm off-white) |
| `--panel` | `#FFFFFF` | Cards, panels, dialogs |
| `--hover` | `rgba(238,108,77,.08)` | Hover fill for list items and menu entries |
| `--active` | `rgba(238,108,77,.14)` | Active or selected fill |

Typography: `--display` (headings, section titles) and `--ui` (everything else). Buttons and headings use sentence case, never title case or all caps (the one exception: small uppercase section labels like RECENT PROJECTS, which use `letter-spacing` and `--muted`).

Spacing sits on a 4 px grid (4, 8, 12, 16, 20, 24, 32). Corner radii: 8 to 11 px for inputs and menu items, 14 to 20 px for cards and dialogs, 999 px for pills and chips. Elevation: shadows are warm and soft (`rgba(80,40,25,...)`), used only on floating elements (cards, dialogs, menus, the composer).

## 2. Motion

Motion is short, purposeful, and never decorative.

- Entrances (views, phases, chat bubbles, dialogs, menus): 160 to 220 ms, ease-out, small translate plus fade. Classes: `fadein`, `msgin`, `dlgin`.
- Progress bar width animates over 700 ms with a gentle cubic-bezier so milestone jumps glide.
- Loading is shown with shimmering skeletons (`sk` classes) shaped like the incoming content, never bare spinners on empty screens. Spinners are reserved for inline "working" rows that carry a text label.
- The generating card's symbol pulses slowly (2.4 s) to signal life during long waits.
- Everything respects `prefers-reduced-motion: reduce` (animations and transitions are disabled).
- Never add bounce, spin, or attention-seeking animation. One transition per interaction.

## 3. Components

- **Buttons.** Primary action: `go` (coral, white text). Secondary: `tb-btn` (white, hairline border). Destructive: `dlg-btn danger` (red, only inside confirm dialogs). A disabled primary drops to 50 percent opacity.
- **Segmented controls.** `seg` (script mode). One segment always active, white fill on the active segment. Use for small mutually exclusive choices (2 to 4 options); use a dialog or page for anything larger.
- **Slider** (`durslide`). For picking one value from a continuous range (film length). Compact 170 px track, coral fill up to the thumb, white thumb with coral ring that scales slightly on hover, and a live value label always visible beside the track (never below it, so a pointer or finger cannot cover it). Snaps in steps sized to roughly 3 percent of the range. Set the fill with the `--fill` custom property. Keep the track short (about 110 px) and the range small; anything beyond the slider's range belongs to the Custom switch.
- **Switch** (`swtch`). Apple Settings style: 40 by 24 px pill track, 20 px white knob with a soft shadow, grey when off, coral when on, 200 ms slide. Label sits to the left of the switch. Implemented as a visually hidden native checkbox inside a label, so keyboard, label-click, and screen reader behavior come free; the knob snaps under reduced motion. Use for boolean modes (the Custom length mode swaps the slider for minutes and seconds inputs in place).
- **Auto-growing fields.** The script composer starts at three lines and grows with content to a 320 px cap, then scrolls. Implemented with CSS `field-sizing: content` plus a JavaScript fallback where unsupported. Any multi-line input where users paste long content should behave this way.
- **Chips** (`chip`). Quiet rounded rectangles (11 px radius, matching the card family, not full pills): transparent fill, hairline border, 13 px medium text. Hover brings a white fill and a faint coral border, no movement. Used for starter prompts, configured in `config/starter-prompts.json`.
- **Dialogs** (`components/Dialog.tsx`). The only modal primitive. Title, optional body, optional input, Cancel plus one action. Handles focus, Escape, Enter, and overlay click. Never use `window.prompt`, `window.confirm`, or `window.alert`.
- **Dots menus** (`dots-menu`). Contextual actions for a project. Cards and sidebar rows both use them. Sidebar rows reveal the dots button on hover only. Menu order: Rename, Share, Delete (destructive action always last, styled `danger`).
- **Skeletons** (`sk`, `sk-title`, `sk-line`, `sk-tile`, `sk-card`). Match the shape of the content they replace; lists show 3 to 4 placeholder items.
- **Chat panel** (`pd-side`). Sticky right column, 384 px, full available height, input pinned at the bottom. Messages: user bubbles coral right-aligned, assistant bubbles white left-aligned, three-dot typing indicator while a reply is pending, failed sends stay visible with a retry link. Below 1180 px the panel stacks under the content.
- **Sidebar.** Fixed left panel: logo and the primary button on top, one full-height scrollable middle region (navigation plus the complete recents list, thin scrollbar), and the account block pinned at the bottom. List rows highlight across the panel's full width and reveal their options menu on hover; nested scroll containers inside the panel are not allowed (they clip menus and read as floating cards).
- **Status labels** (`lib/status.ts`). The only allowed way to display a project status. Every status maps to a label, a tone, and a polling flag. Raw status strings must never reach the UI.

## 4. Voice and copy

- No em dashes anywhere in interface text, emails, or assistant replies. Use a comma, a colon, or two sentences.
- No decorative emoji in product surfaces or transactional email.
- No trailing ellipses on labels; motion communicates ongoing work, words state what is happening ("Filming your clips", not "Working...").
- Be concrete and specific. Name the thing and the count ("Shots ready for your review", "Add at least 12 more characters").
- Errors always say what failed and what to do next.
- Honest states only: a control that does nothing must not ship. If a feature is planned, say "coming soon" plainly (see the Share dialog).

## 5. Interaction principles

- **Feedback within one frame.** Every click changes something visible immediately: optimistic chat bubbles, disabled buttons with reduced opacity, instant dialog entrances.
- **Review gates before money.** The flow always pauses for user approval before a step that spends credits or provider budget.
- **Progress never freezes silently.** Long operations show stage, percentage, and a reassurance line if nothing has moved for a minute.
- **Validation guides, never scolds.** The composer tells the user how many characters remain rather than rejecting after submit. Server-side rules mirror every client rule.
- **Destructive actions confirm in a dialog** with a specific description of what is lost, and the confirm button names the action ("Delete project", never "OK").

## 6. File map (web)

```
app/globals.css              all styling, tokens at :root, polish sections appended and labeled
app/app/page.tsx             workspace shell: sidebar, views, project detail, chat panel
components/CreateFlow.tsx    script composer and the 6-step creation flow
components/Dialog.tsx        modal primitive
lib/status.ts                status label map
lib/ratelimit.ts             in-memory per-IP/per-account rate limiter
config/starter-prompts.json  starter chips (label + script), editable without code changes
CHANGELOG.md                 every user-visible change, Keep a Changelog format
DESIGN.md                    this file
```

## 7. Key decisions (the why)

A short paragraph per major architectural choice, so future contributors (including AI assistants) extend the system the way it was intended.

- **Credits are charged at character selection, not at submit or at completion.** Submitting a script is free so users can iterate on the breakdown and characters (the cheap, fast steps) without spending anything. The credit is taken at selection because that is the point of no return: everything after it (keyframes, clips, assembly) spends real provider money. Charging at completion would let a user cancel after consuming most of the cost; charging at submit would punish exploration. Chat-triggered whole-film re-renders follow the same rule and cost one credit; single-clip tweaks are free up to a per-project cap.

- **The worker polls the database instead of using a queue service.** Jobs live in a `Job` table; the worker loops, claims the next queued job, and updates its `stage`/`progress` as it runs. This keeps the whole system to two moving parts (web app + worker) sharing one Postgres database, with no Redis, SQS, or broker to run, secure, or pay for. The web app enqueues by writing a row and reads progress by reading rows, so there is a single source of truth and the UI stays in sync by polling the same table. At this scale, database polling is simpler and cheaper than a dedicated queue; a queue becomes worth it only at much higher job volume.

- **Statuses are plain strings, funnelled through one map.** A project's `status` is a string column (`generating_shots`, `clips_review`, and so on) rather than an enum, so adding a new state never requires a database migration. To stop raw strings from leaking into the UI, `lib/status.ts` is the single source of truth: every status maps to a human label, a tone (working, waiting, done, failed), and a `polls` flag that drives auto-refresh. Nothing renders a status except through this map, so a new state is added in exactly one place and every screen and the polling loop pick it up at once.

- **The breakdown is immutable; edits are separate notes.** The generated breakdown (shots, settings, descriptions) is never mutated in place. When a user asks for a change through chat, the request is appended to a separate notes list (`globalNotes` for the whole film, per-shot `notes` for a single clip) and merged into the prompt only at render time, in a throwaway copy on disk. This keeps the original reversible and stops prompts from growing long, contradictory, and un-undoable after several edits.

- **Review gates before money.** The pipeline always pauses for user approval before any step that spends provider budget: after the breakdown, after character design, and after the clips. This is a product decision as much as a cost one, since it gives the user control at each expensive boundary rather than committing the whole spend up front.