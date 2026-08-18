# Changelog

All notable changes to safa-web are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow semantic versioning.

## [1.0.0] - 2026-07-12

The security, cost-control, and trust pass. Closes every prioritized finding from the July 2026 product review, taking the app from "impressive prototype" to launch-ready. Includes matching worker changes in `ai-film-pro`.

### Added

- Real project sharing. Each project can generate a permanent public link; a read-only page at `/p/[token]` shows the title and finished film to anyone, with a working copy button. Non-finished or unknown tokens return a 404. Replaces the previous "coming soon" placeholder.
- "Write it with AI" is now functional. A one-line idea is expanded by a single language-model call into a short screenplay, dropped into the composer for the user to review and edit before generating. Shows an animated writing state while it works, and a confirmation when the script is ready. Previously the toggle only changed the placeholder text.
- Per-clip render progress. The working screen now reports "Painting shot 2 of 6" and "Filming clip 4 of 6" with the bar moving smoothly between each, plus a live elapsed timer, instead of sitting frozen at 88 percent. (Requires the matching worker update.)
- Live character count in the composer as the script approaches the 10,000 character limit, alongside the existing short-script hint.
- Real thumbnails. The worker now extracts each clip's and the final film's first frame as a poster image; project cards and the artifacts grid show these instead of placeholder text. Unfinished projects show a clear "In progress, not completed yet" state.
- Resend-verification endpoint (`/api/verify/resend`) with a per-account cooldown, and a "Resend it" link on the login page.
- Favicon (the safa symbol) and branded custom 404 and error pages.

### Changed

- Free credit grant aligned with the pricing page: new accounts receive 3 render credits, not 30. (Schema default.)
- Signup no longer attempts an immediate auto-login. After creating an account it shows "check your inbox to confirm your email" and switches to the login tab, keeping the email filled in.

### Fixed

- Video thumbnails now render reliably across browsers. Safari would not paint a video's first frame from a media fragment alone; posters plus an explicit seek fix this everywhere.
- Modals now trap focus while open, restore focus to the triggering control on close, and close on Escape.

### Security

- **Email verification is now enforced at login.** Accounts with an unconfirmed email cannot sign in. Verification was previously decorative.
- **Google account linking hardened.** `allowDangerousEmailAccountLinking` set to `false`, closing a takeover chain where an attacker could pre-register someone's email with a password and inherit the account when they later signed in with Google.
- **Registration input is validated and normalized.** Email format is checked and lowercased/trimmed before the uniqueness check and insert; password minimum length and name length are enforced with field-specific messages. The literal string `not-an-email` is no longer accepted.
- **Chat-triggered regeneration is now metered.** A whole-film re-render costs one credit and is blocked at zero; single-clip regenerations are free but capped per project. Previously a single chat message could re-render every clip at full provider cost, without limit.
- **Rate limiting** added to the auth and generation routes (registration, chat, resend), per IP and per account.
- **Chat edits no longer corrupt the breakdown.** Change requests are stored as a separate list of notes and composed into the prompt only at render time; the original breakdown stays pristine and reversible. (Paired with the worker's `composeBreakdown`.)

## [0.9.5] - 2026-07-10

### Fixed

- Sidebar recent projects scrolled inside their own small box, which read as a card floating in the panel, clipped rows at its edges, and cut off the options menu near the bottom. The sidebar middle (navigation plus recents) is now a single full-height scroll region with a thin scrollbar; the account block stays pinned at the bottom, and the options menu always renders in full.

### Changed

- The sidebar lists all projects in recent order instead of only the first five, since the region scrolls.

## [0.9.4] - 2026-07-10

### Changed

- Custom length control is now a switch in the Apple Settings style (pill track, sliding knob, coral when on, label on the left), replacing the button-style toggle. Built on a native checkbox, so keyboard toggling, label clicks, and screen reader announcements work; the knob snaps without animation under reduced-motion preferences.
- Length slider shortened and capped at 1 minute (10 to 60 seconds in 5-second steps); longer films use the Custom switch (up to 10 minutes).
- Composer footer layout hardened: the length group flexes between the script-mode toggle and Generate, so Generate keeps its position on the same line in both slider and custom modes instead of wrapping below.

## [0.9.3] - 2026-07-10

### Added

- Custom length toggle after the slider. Toggled on, the slider is replaced by minutes and seconds inputs (up to 10 minutes) for exact values beyond the slider's range or step; toggled off, the slider returns and the value clamps back into its 10-second to 3-minute range.

## [0.9.2] - 2026-07-10

Composer redesign, following user testing of 0.9.1.

### Changed

- Film length is now a compact slider (10 to 180 seconds, snapping in 5-second steps) with a live value beside it ("30s", "2m 30s"), replacing the segmented buttons. The script-mode toggle, the length slider, and Generate sit on a single line.
- The script box grows with its content: it starts at three lines and expands downward as the user types or pastes, up to a cap, then scrolls internally. Uses the CSS `field-sizing: content` property with a JavaScript fallback for browsers that do not support it yet.
- Starter chips are slightly larger and use an 11 px corner radius to match the composer card and buttons, instead of the fully round pill shape that clashed with the squarish surfaces around them.

### Removed

- The Custom length option and its separate seconds field; the slider covers the whole range directly.

## [0.9.1] - 2026-07-10

Sidebar and composer refinements, following user testing of 0.9.0. Adds DESIGN.md.

### Added

- `DESIGN.md`: design documentation covering tokens, motion rules, the component inventory, voice and copy rules, and interaction principles. New UI work should follow it.

### Changed

- Sidebar recent-project menu now offers Rename, Share, and Delete (Share opens the coming-soon dialog; the Modify entry was removed).
- Film length is a segmented control (20s, 30s, 1 min, 2 min, 3 min, Custom) instead of a native dropdown; Custom still reveals the seconds field.
- Starter chips restyled quieter: transparent fill, hairline border, smaller type, subtle hover, no movement.

### Fixed

- Sidebar recent projects rendered as a cramped inner card and clicking a project name opened the options menu instead of the project. Cause: a legacy stylesheet rule (`.recent-list button` at full width) overrode the new dots button and stretched it across the row. The rule is now scoped, the row highlight spans the full panel width, and the three-dot button appears on hover at the row's right edge.

## [0.9.0] - 2026-07-10

Composer, generation, and navigation polish, following user testing of 0.8.0.

### Added

- Minimum script length. The composer disables Generate below 40 characters and shows how many more are needed; the projects API enforces the same rule server side (40 to 10,000 characters) so it cannot be bypassed.
- Starter prompt chips under the composer. One click fills the script area with a ready-to-film sample story. The chips are configurable by editing `config/starter-prompts.json` (label plus script, no code changes needed).
- Live project title. As soon as the shot breakdown names the film, the title replaces "New project" in the top bar; the project page top bar shows the project title as well.
- Options menu on sidebar recent projects. Hovering a recent project reveals a three-dot menu with Rename, Modify, and Delete, using the same styled dialogs as the project cards.

### Changed

- The generating screen is now a designed card: safa symbol with a gentle pulse, stage label, percentage readout, and progress bar, centered on the page, instead of a bare progress bar on an empty screen.
- The chat side panel always fills the available height, with the message area growing and the input pinned at the bottom, instead of growing only as the conversation gets longer.

## [0.8.0] - 2026-07-10

UI and interaction polish pass. No backend, API, schema, or pipeline behavior was changed, with one exception noted under Changed (chat assistant reply style). All changes are in the web app.

### Added

- Chat now shows the user's message immediately on send, with a pending style, instead of waiting for the server round trip.
- Animated typing indicator (three-dot pulse) while the assistant is replying.
- Chat auto-scrolls to the newest message whenever the conversation updates.
- Failed chat sends keep the message visible, marked "Not delivered", with a one-click Retry. Previously the text was silently lost.
- Skeleton loading states for the project page, the projects grid, the recents grid, and the artifacts grid. Replaces the plain "Loading project" text and prevents the empty state from flashing before data arrives.
- New `lib/status.ts`: single source of truth mapping every project status to a user-facing label, a tone, and a polling flag. Raw internal values such as `clips_review` can no longer appear in the UI, and pages keep auto-refreshing in every working status.
- New `components/Dialog.tsx`: styled dialog component with focus handling, Escape to close, and Enter to confirm. Replaces every `window.prompt` and `window.confirm` (project rename, project delete, character regeneration notes, clip regeneration notes).
- Reassurance line when render progress has not moved for over a minute, so long video steps do not read as a crash.
- Entrance transitions (roughly 200 ms, ease-out) on view and phase changes, chat bubbles, and dialogs. All animation is disabled for users with reduced-motion preferences.
- Accessibility: labels on icon-only buttons (project options menu, clip reorder arrows), dialog roles, and a labeled chat input.

### Changed

- Project page is now a two-column layout on wide screens: project content on the left, an always-visible sticky chat panel on the right. On narrow screens the chat stacks below as before.
- Share dialog no longer shows a placeholder link that led nowhere. It now states plainly that sharing is coming soon and suggests downloading the film. The non-functional social buttons were removed.
- Progress bar movement is eased over 700 ms so milestone jumps glide instead of teleporting.
- Copy pass across the app: em dashes removed from all interface text, decorative emoji removed from product surfaces (including the film-ready heading), trailing ellipses removed from stage labels and placeholders, and several messages rewritten as plain sentences.
- Chat assistant is instructed to avoid em dashes in its replies (one line added to the intent prompt).
- Page title separator changed from an em dash to a middle dot.

### Fixed

- Chat messages sent successfully but rendered out of view: the conversation pane did not scroll, so replies arrived invisibly below the fold.
- Projects and artifacts lists showed their "nothing yet" empty state for a moment before data loaded.
- Unknown project statuses rendered as raw internal strings.
- Pages could stop auto-refreshing in some working states because the polling list did not cover all statuses.

### Known issues (out of scope for this release)

- Server-side validation gaps (email format, script length), credit metering on chat regenerations, rate limiting, and email verification enforcement are documented in the accompanying product review and should be addressed in a backend pass.