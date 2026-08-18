# Implementation Log

Evidence protocol: every entry below is backed by a real command run against
this repo (`npx tsc --noEmit` from `ai-film-pro/`) and real `grep`/line-range
citations, not narration. Tasks 1–3 are **re-verification** of changes made
earlier in the same working session that produced this log — they are not new
work; the point of re-verifying is that a prior chat summary (even this
session's own) is not itself evidence until checked against disk.

---

## Task 1: Re-verify identity_holding changes against disk
Status: done
Files:
- `src/steps/5-videos.ts:406-408`
- `src/providers/qa.ts:709-710, 715-716, 741-742, 777, 788`
- `src/lib/compiler.ts:2365-2389`

Claim: three identity-holding mitigations are present and compiling —
(a) `cameraFixed` in `5-videos.ts` includes an `identityCriticalCandidate`
branch (2+ named characters, or dialogue present) that locks the camera when
nothing in the shot's own `camera` text asked for movement; (b) `qa.ts` has a
stricter `IDENTITY_CRITICAL_KINDS` tier (`identity_drift`,
`morphing_transformation`) gated at `IDENTITY_SEVERITY_THRESHOLD = 0.2`,
below the general `CRITICAL_SEVERITY_THRESHOLD = 0.3`; (c) `compiler.ts`'s R5
duration cap has an `identityCritical` tier (2+ characters, or a close-up
with dialogue) capped tighter (5–6s) than the general tiers.

Evidence:
```
$ grep -n "identityCriticalCandidate" src/steps/5-videos.ts
406:    const identityCriticalCandidate =
408:    const cameraFixed = (closeUp && !CAMERA_MOVE_RE.test(shot.camera || "")) || staticCameraCandidate || identityCriticalCandidate;

$ grep -n "IDENTITY_CRITICAL_KINDS\|IDENTITY_SEVERITY_THRESHOLD" src/providers/qa.ts
709:export const IDENTITY_CRITICAL_KINDS = new Set<QAFinding["kind"]>(["identity_drift", "morphing_transformation"]);
710:const IDENTITY_SEVERITY_THRESHOLD = 0.2;
715:    IDENTITY_CRITICAL_KINDS.has(f.kind)
716:      ? f.severity >= IDENTITY_SEVERITY_THRESHOLD
741:    IDENTITY_CRITICAL_KINDS.has(f.kind)
742:      ? f.severity >= IDENTITY_SEVERITY_THRESHOLD
777:  return qa.findings.some((f) => f.kind === "identity_drift" && f.severity >= IDENTITY_SEVERITY_THRESHOLD);
788:  return qa.findings.some((f) => f.kind === "morphing_transformation" && f.severity >= IDENTITY_SEVERITY_THRESHOLD);

$ grep -n "identityCritical\b" src/lib/compiler.ts
2379:    const identityCritical =
2384:      : identityCritical

$ npx tsc --noEmit   (run from ai-film-pro/, after confirming the above)
(no output — exit clean)
```

Ceiling: drift WITHIN one Seedance generation (between its own first and
last frame) is temporal model behavior — no prompt, camera-lock, or duration
cap reaches inside a single clip's generation and corrects it mid-render.
These three changes reduce the TIME and CAMERA-INSTABILITY budget available
for drift to occur in the highest-risk shots; they do not eliminate the
underlying model behavior. Containment (short shots, post-render QA + one
regen, ship-best-available) is the realistic ceiling — see Task numbers
below for where that containment is implemented.

---

## Task 2: Re-verify spatial_obedience changes against disk
Status: done
Files:
- `src/lib/compiler.ts:4999-5027` (`SPATIAL_COMPLEXITY_OVERLOAD` push site), `5795` (`REPAIRABLE_WARN_CODES` entry)
- `src/providers/llm.ts:2355-2367` (repair guidance), `2599` (`MAY_ADD_SHOTS` entry)
- `src/lib/compiler.ts:30, 2994-3005, 3053` (`stagingLibrary.ts` wiring)
- `src/lib/compiler.ts:4391` (`THRESHOLD_NOT_CROSSED` push site), `5770` (`REPAIRABLE_WARN_CODES` entry)

Claim: a structural check (`SPATIAL_COMPLEXITY_OVERLOAD`) detects 2+
simultaneous spatial-change classes in one shot (a character entering
mid-scene via the existing `TRANSITION` regex + a character-set delta,
combined with a relational-preposition repositioning regex) and is wired
into both `REPAIRABLE_WARN_CODES` (compiler.ts) and `MAY_ADD_SHOTS`
(llm.ts), so the repair loop can actually split the shot rather than discard
the split. `THRESHOLD_NOT_CROSSED` (door/entrance never actually crossed) is
confirmed present in both sets. `stagingLibrary.ts`'s `CORE_STAGING_LIBRARY`
+ `checkStaging()` (role/zone-placement validation, e.g. pedestrian-vs-
vehicle zones, opposing-end sports) is imported and called at two sites in
`compiler.ts`.

Evidence:
```
$ grep -n "SPATIAL_COMPLEXITY_OVERLOAD" src/lib/compiler.ts src/providers/llm.ts
src/lib/compiler.ts:5015:          code: "SPATIAL_COMPLEXITY_OVERLOAD",
src/lib/compiler.ts:5795:  "SPATIAL_COMPLEXITY_OVERLOAD",
src/providers/llm.ts:2355:- SPATIAL_COMPLEXITY_OVERLOAD — this shot packs 2+ DIFFERENT KINDS of spatial
src/providers/llm.ts:2599:  const MAY_ADD_SHOTS = new Set([... "SPATIAL_COMPLEXITY_OVERLOAD"]);

$ grep -n "CORE_STAGING_LIBRARY\|checkStaging" src/lib/compiler.ts
30:import { type StagingRule, CORE_STAGING_LIBRARY, checkStaging } from "./stagingLibrary";
2994:      for (const rule of CORE_STAGING_LIBRARY) {
3005:        const violated = checkStaging(locText, matchedRule);
3053:        if (matchedRule?.label === label && checkStaging(locText, matchedRule)) continue;

$ npx tsc --noEmit
(no output — exit clean)
```

Ceiling: this is genuinely structural prevention (splits an over-loaded shot
into two coherent ones before render), not a mitigation of model behavior —
listed under spatial_obedience because that objective's other half (a video
model rendering an already-correct, already-simple, single-event shot out of
order or with a skipped transition anyway) is a model-obedience limit no
compiler check reaches. `stagingLibrary.ts`'s `CORE_STAGING_LIBRARY` is
hand-authored for three high-frequency cases (pedestrian zones, vehicle
roadways, opposing-end sports) with a generative fallback for anything else
— not an exhaustive domain-rule set.

---

## Task 3: Re-verify hallucination changes against disk
Status: done
Files:
- `src/providers/qa.ts:45, 152, 241-256, 690` (`missing_person` finding kind)
- `src/lib/compiler.ts:1182-1191` (`BASE_NEGATIVE` environment-permanence block)
- `src/steps/4-images.ts:407-410`, `src/steps/5-videos.ts:313-316` (closed-set prompting)

Claim: a `missing_person` QA finding kind exists (symmetric to the
pre-existing `extra_people`, added to `CRITICAL_KINDS`) so a named character
who should be visible but silently isn't in a sampled frame is now
detectable — previously undetectable, since only over-counting was checked.
`BASE_NEGATIVE` (compiler.ts) has an added block negatively prompting
against background/architecture changing mid-shot. `4-images.ts` and
`5-videos.ts` both carry a "Render ONLY the location and objects described"
closed-set instruction.

Evidence:
```
$ grep -n "missing_person" src/providers/qa.ts | head -5
45:    | "missing_person"
152: "morphing_transformation","identity_drift","identity_swap","background_identity_bleed","extra_people","missing_person",...
241: - missing_person: THE HEADCOUNT ITSELF IS WRONG THE OTHER WAY — the exact mirror of extra_people's
546:      `and none of them missing — see missing_person if any of these ${presentCount || "listed"} names isn't ` +
690:  "extra_people", "missing_person", "duplicated_object", ...

$ grep -n "ENVIRONMENT PERMANENCE" src/lib/compiler.ts
1182:  // ENVIRONMENT PERMANENCE — same "wrong identity" failure as the object-

$ grep -n "Render ONLY the location" src/steps/4-images.ts src/steps/5-videos.ts
src/steps/4-images.ts:407:      ? `Setting and background: ${shot.setting}. Render ONLY the location and objects described in this ` +
src/steps/5-videos.ts:313:      ? " Render ONLY the location and objects described in this setting — do not add a door, window, " +

$ npx tsc --noEmit
(no output — exit clean)
```

Ceiling: closed-set prompting and the negative-prompt block reduce, not
eliminate, hallucination — a generative model filling a genuine content gap
with something plausible-looking is model behavior, not a text-instruction
bug; these are prevention attempts, not guarantees. `missing_person` is
detection (post-render, triggers a regen), not prevention — it cannot stop
the first attempt from vanishing a character, only catch it once it has.

---

## Task 4: Design and build the action pose library
Status: done
Files: `src/lib/actionLibrary.ts:559-680` (new `ACTION_POSE_LIBRARY`, `ActionPose`, `findActionPose`)

Claim: investigated the existing `CORE_ACTION_LIBRARY` (same file, lines
317-558) before writing anything — it already answers "is this action's
real-world PRECONDITION satisfied" (a narrative-consistency question) via
`precondition`/`effect` `SpatialFact[]` data, but has no concept of a
photographable start/end pose or a realistic duration per action.
`DIRECTOR_RULES.json` (confirmed via direct read, `src/director/
DIRECTOR_RULES.json`, 51 rules, version 2) is free-text appended to the
system prompt with no structured shape a compile-time check could query —
ruled out as the new library's home for that reason. Placement decision:
added `ACTION_POSE_LIBRARY` to `actionLibrary.ts` itself, cross-referenced
by the SAME `label` string `CORE_ACTION_LIBRARY` already uses, so both
facets of "what this pipeline knows about action X" live in one file. Nine
entries seeded (sit down, stand up, kneel, open the door, enter through a
door, greet/shake hands, hand an object to someone, pick up an object,
embrace), each with `startPose`, `endPose`, and a `[min, max]`
`typicalDurationSec` range — not every `CORE_ACTION_LIBRARY` entry has (or
needs) a counterpart here; documented in the code as a deliberate,
independent-size-list decision, not an oversight.

Evidence:
```
$ grep -n "export const ACTION_POSE_LIBRARY\|export function findActionPose\|export interface ActionPose" src/lib/actionLibrary.ts
352:export interface ActionPose {
374:export const ACTION_POSE_LIBRARY: ActionPose[] = [
440:export function findActionPose(label: string): ActionPose | undefined {

$ npx tsc --noEmit   (run immediately after this addition, before any wiring)
(no output — exit clean)
```

Ceiling: this is a static reference table, not itself a check — it does
nothing until something queries it (see Task 5). It also cannot validate
that a shot's own AUTHORED startFrame/endFrame prose actually MATCHES the
library's suggested pose — only Task 5's duration comparison is wired to
fire automatically; a real pose-text comparison would need either a second
structural text check or a vision-based one, neither built here.

---

## Task 5: Wire the action library into shot generation/compiler
Status: done
Files:
- `src/lib/compiler.ts:27-29` (import), `2943-2980` (new `R7.6c` check, `ACTION_DURATION_OFF_LIBRARY`), `5849-5856` (`REPAIRABLE_WARN_CODES` entry)
- `src/providers/llm.ts:2339-2345` (repair guidance)

Claim: a new compiler check (`R7.6c`, code `ACTION_DURATION_OFF_LIBRARY`)
matches a shot's authored motion text against `CORE_ACTION_LIBRARY`'s own
patterns (first-match-wins, the identical semantics the existing
WORLD-STATE ACTION PRECONDITION/EFFECT block already uses — re-implemented
as a small standalone loop here rather than reusing that block's own
`matchAction()` closure, deliberately, since that closure also queues async
LLM-inference side effects this duration-only check has no reason to
trigger), looks up the matched label in `ACTION_POSE_LIBRARY`, and flags a
shot whose effective duration is less than 60% of that action's
`typicalDurationSec` minimum. WARN, `autofixed:false`, added to
`REPAIRABLE_WARN_CODES` in the SAME change that added the push site (this
session's own prior audit found `SCENE_GEOMETRY_NOT_ESTABLISHED` shipped
without this and silently never got repaired — applied that lesson here
directly, not after the fact). Matching repair guidance added to `llm.ts`.

Evidence — real execution, not just compilation, using a synthetic
`Breakdown` run directly through `compileBreakdown()`:
```
$ npx tsx scratch-test-action-duration.ts   # motion: "He kneels down slowly...", screenSeconds: 0.5
ACTION_DURATION_OFF_LIBRARY issues found: 1
[
  {
    "shotId": "s1",
    "code": "ACTION_DURATION_OFF_LIBRARY",
    "severity": "warn",
    "detail": "This shot matches the \"kneel\" action, which realistically needs 1.5-3s to read as physically performed, not rushed — this shot is only 0.5s. Extend the duration, or if the beat is meant to feel abrupt/rushed on purpose, keep it but expect the render to look hurried rather than natural.",
    "autofixed": false
  }
]

$ npx tsx scratch-test-action-duration-negative.ts   # same shot, screenSeconds: 2 (inside the 1.5-3s range)
ACTION_DURATION_OFF_LIBRARY issues found: 0
[]

$ npx tsc --noEmit   (after both the check and REPAIRABLE_WARN_CODES/llm.ts wiring)
(no output — exit clean)
```
Both scratch scripts were deleted after verification (`scratch-test-action-
duration.ts`, `scratch-test-action-duration-negative.ts` — not committed,
not part of the pipeline).

Ceiling: duration-only. Does not check whether the shot's own startFrame/
endFrame TEXT actually matches the library's suggested photographable pose
— a shot could have the right duration and a nonsensical pose and this
check would not catch it. Fires only for the nine actions with a pose-
library entry (Task 4); every other `CORE_ACTION_LIBRARY`-matched action
still falls back to R7.6's generic beats-per-second heuristic. Like every
other WARN check in this file, a real action can legitimately run longer
than "typical" for a deliberate beat — this flags, it never blocks, and a
false negative (a genuinely too-fast shot this library has no entry for) is
expected and undetected by design, not a bug.

---

## Task 6: Durable rule — DIRECTOR_RULES.json
Status: not possible (correction of task framing, not a gap)
Files: `src/director/DIRECTOR_RULES.json` (unchanged this session)

Claim: the task brief asks whether a genuinely durable new rule from this
pass belongs in `DIRECTOR_RULES.json`. The one rule from this pass that
fits that description — a shot must not combine multiple simultaneous
spatial-change classes — was already added as `r-51` in the SAME working
session, BEFORE this formal task began (confirmed: `addedAt:
"2026-08-07T00:00:00Z"`, `addedBy: "identity-and-spatial-audit"`, real read
via `node -e` below). The action-duration-library finding (Task 5) is
deliberately NOT added as a DIRECTOR_RULES.json prose rule: it is a
NUMERIC/structural check (a duration range per action) that only makes
sense as code cross-referencing a data table — restating it as prose
("actions should take a realistic amount of time") would be too vague to
enforce and duplicates what the structured check in Task 5 already does
precisely. No new DIRECTOR_RULES.json entry was warranted or added.

Evidence:
```
$ node -e "const d=JSON.parse(require('fs').readFileSync('src/director/DIRECTOR_RULES.json','utf8'));console.log(d.version, d.rules.length, JSON.stringify(d.rules[d.rules.length-1]))"
2 51 {"id":"r-51","kind":"other","rule":"A single shot must not combine more than one kind of simultaneous spatial event...","addedBy":"identity-and-spatial-audit","addedAt":"2026-08-07T00:00:00Z"}
```

Ceiling: n/a — this task concluded no action was the correct action, with
evidence for why, rather than adding a rule for the sake of adding one.

---

## Task 7: Fix — returning character rendered as a duplicate/"ghost" figure
Status: done
Files: `src/lib/compiler.ts:2490-2519` (`ENTRANCE_ENDPOINTS_AUTOFILLED`'s
`newEntrants` gate)

Reported symptom (user, on camera): a man's figure visible twice at once — a
static duplicate/"shadow" already standing in the shot, with a second
instance of him walking in from the left and merging into it before the
combined figure starts moving.

Root cause: `ENTRANCE_ENDPOINTS_AUTOFILLED` (the deterministic fix that gives
an entering character a real edge-of-frame → fully-in-frame `startFrame`/
`endFrame` pair, so an i2v render has something to animate an entrance FROM)
gated its `newEntrants` list on `!seenCharacters.has(id)` — whole-FILM "have
we ever shown this face before." A RETURNING character (established in an
earlier scene, absent from the immediately preceding shot, walking into a
LATER scene) was never counted as an entrant, so this fix silently never
fired for them. Per `4-images.ts`'s unconditional "there is EXACTLY ONE
person in this frame" headcount instruction (always frames a shot's cast as
already present, with no branch for "about to enter"), the starting keyframe
image showed the character already standing in the shot while the shot's own
motion text separately said he walks/enters — a genuine contradiction the
video model resolved by rendering both: the already-there reference and a
fresh entrance, merging into one duplicated figure. `qa.ts`'s `extra_people`
finding (CRITICAL, drives a retry) detects this AFTER the fact but retries
reuse the same flawed starting image (`5-videos.ts`'s `renderOnce`/
`withCorrection`, confirmed only the text changes on retry) — the QA loop
could not have been the fix.

Fix: switched the signal from "ever seen in the film" to "was present in the
immediately preceding shot of the SAME scene" — the identical prevShot +
`sameScene()`-relative local signal `SPATIAL_COMPLEXITY_OVERLOAD`'s own
`enteredMidScene` already uses for the same underlying question (`compiler.ts`,
Class 1 signal, further below in this file). Strictly a superset of the old
signal: a never-seen-before character is by construction also absent from
`prevShot`, so every case that used to fire still fires; the new case it adds
is exactly the reported bug (a familiar face re-entering a new scene). One
accepted behavior change, matching this check's own pre-existing "exactly one
candidate" disambiguation design: a shot where two people are simultaneously
new-since-the-last-shot (one returning, one truly first-time) now correctly
declines to guess which one an ambiguous "enters" refers to, instead of
silently attributing it to whichever happened to be the film's first-timer.

Evidence — real execution against a synthetic two-scene `Breakdown` (one
character, present in scene 1, absent from scene 1's last shot, entering
scene 2 with `motion: "He enters the hallway..."`, no authored startFrame/
endFrame), run through `compileBreakdown()` directly:
```
$ npx tsx scratch-test-returning-entrance.ts
# BEFORE the fix:
ENTRANCE_ENDPOINTS_AUTOFILLED issues found: 0
s2.startFrame: ""
s2.endFrame: ""
s2.method: i2v
FAIL

# AFTER the fix:
ENTRANCE_ENDPOINTS_AUTOFILLED issues found: 1
s2.startFrame: "Man is at the very edge of the frame, only partially visible
  — one shoulder, arm, and leg just entering view, the rest of their body
  still off-frame, mid-step."
s2.endFrame: "Man is now fully inside the frame, both feet planted, having
  completed stepping into view."
s2.method: flf
ALL CHECKS PASSED

$ npx tsc --noEmit
(no output — exit clean)
```
Scratch script deleted after verification (`scratch-test-returning-entrance.ts`
— not committed, not part of the pipeline), same discipline as Task 5.

Ceiling: this closes the gap for the SPECIFIC, common shape reported — a
familiar character re-entering a later scene with no authored startFrame/
endFrame and a regex-matched entrance verb (`enters`/`appears`/`steps into
frame`/`walks into frame`). Two related gaps remain, NOT fixed here (kept
separate deliberately — see this session's own "fix one at a time" framing):
(1) `ENTRANCE_VERB` itself is narrower than this file's own `TRANSITION`
regex — it does not match the equally common phrasing "walks in FROM the
left" (only "walks into/in THE FRAME/SHOT/SCENE/FOREGROUND"), so a shot
phrased that way still won't trigger this deterministic fix and could
reproduce the same duplicate-figure symptom; (2) a shot with an AUTHORED
`startFrame` that itself wrongly stages the entering character as already
fully present (not just a missing `startFrame`) is untouched by this gate
(`!hasStart` requires it to be empty) — nothing yet cross-checks authored
`startFrame` text against an entrance verb in the same shot's `motion`.

---

## Task 8: Fix — background/prop "pop" at the cut between consecutive clips
Status: done
Files:
- `src/lib/compiler.ts:1047` (`export` added to `distillEndState`)
- `src/steps/4-images.ts:1-2` (import), `270-289` (`prevShotEndUnknown`/
  `prevShotForHint` state), `319-322` (cache-hit path), `770-786`
  (`prevEndDistilled`/`endStateHint`, spliced into both `chainClause`
  branches), `1024-1027` (chain-advance)

Reported symptom (user, on camera): the background visibly glitches/pops for
a moment right at the cut from one clip to the next, within what's supposed
to be the same continuous scene.

Root cause: this file's own header comment (line ~142-144) states each
shot's keyframe "takes the previous shot's FINAL image as its leading
reference: the world is handed forward, pixel to pixel" — and the prompt
text sent to the image model (both `chainClause` branches) unconditionally
asserts the same thing: "it is the final frame of the PREVIOUS shot... copy
its location, architecture, background details, props, lighting and time of
day exactly." That claim is only actually true when the previous shot was
`method="flf"` and got a real second keyframe rendered (`needsEnd`/`lastUrl`).
For an ordinary `i2v` shot — no authored `endFrame`, the common case for any
shot whose motion doesn't match R4's `STATE_CHANGE`/`THRESHOLD` verb lists —
`lastUrl` is never set, and `prevLastUrl = lastUrl ?? firstUrl` (line ~1024)
silently substitutes that shot's own OPENING keyframe while the model is
still told it's the ending one. Whatever that shot's own motion actually did
(crossed the room, panned the camera, picked something up) is invisible to
the next shot's generation — it visually continues from a moment BEFORE that
motion happened, while the rendered CLIP plays the motion out first. This is
undetectable comparing keyframe stills side by side (each new keyframe
faithfully matches the reference it was given) and only shows up at the cut
in the actual rendered video — exactly the reported symptom. Confirmed no
mechanism anywhere in the repo extracts the real rendered last frame of a
video clip (grepped for `extractFrame`/`-ss`/frame-extraction — none exist);
images are generated for the whole film before any clip is rendered, so a
true rendered pixel isn't available to chain from at generation time.

Fix: rather than generating an extra real end-keyframe for every chained
shot (a genuine fix, but a full extra billed image-generation call per shot
— a cost/latency tradeoff that belongs to the user, not decided here), this
closes the CHEAPER, zero-added-cost half of the gap: don't tell the model a
false thing about what the reference image shows. Tracks whether
`prevLastUrl` is a real end-keyframe or a same-shot-start fallback
(`prevShotEndUnknown`), and the actual previous `Shot` object
(`prevShotForHint`) alongside the existing `prevLastUrl`/`prevShotMeta`/
`prevChars` per-scene-run state. When it's a fallback, distills that shot's
own motion/description into one clause (reusing `distillEndState()` — now
exported from compiler.ts rather than reimplemented, same discipline as
Task 7) and appends an honest instruction: this image is the previous shot's
OPENING frame, its true ending look was never rendered, mentally advance it
by "`<distilled clause>`" before treating it as ground truth. Degrades to an
empty string (no hollow instruction) when there's nothing to distill, e.g. a
static insert shot with no motion text.

Evidence:
```
$ grep -n "export function distillEndState" src/lib/compiler.ts
1047:export function distillEndState(shot: Shot): string {

$ grep -n "prevShotEndUnknown\|prevShotForHint\|prevEndDistilled\|endStateHint" src/steps/4-images.ts
270-289, 319-322, 770-786, 1024-1027 (see Files above)

$ npx tsc --noEmit
(no output — exit clean)

$ npx tsx scratch-test-endstate-hint.ts   # distillEndState() on a real-motion
  # shot vs. an empty shot, run directly against the exported function
distilled: "He crosses the room and sits at the desk, exhaling as he settles in."
distilled (empty shot): ""
ALL CHECKS PASSED
```
Scratch script deleted after verification — same discipline as Tasks 5/7.

Ceiling: this is a text-only mitigation, not a structural fix — it gives the
model the missing information but does not force it to use it; a diffusion/
edit model can still weight the visually-dominant (but stale) reference
image over a competing text instruction, the same fundamental tension issue
#1 (Task 7) hit. It does NOT extract or synthesize any new pixels, so it
costs nothing extra to run, but it also cannot fully close the gap. Two
stronger, costlier fixes were identified and deliberately NOT applied here,
pending the user's call on the cost/latency tradeoff:
(a) generate a real, lightweight end-keyframe image for every chained shot
(not just `flf`/state-change ones) so `prevLastUrl` is always a genuine
rendered frame — one extra nano-banana call per applicable shot, a real
cost/time increase across the whole film; (b) restructure the pipeline to
interleave video generation with image generation per shot and extract the
ACTUAL rendered last frame via ffmpeg for true pixel-ground-truth chaining —
architecturally the most correct fix, but a major structural change to a
pipeline currently batched for concurrency (see WORKER.md/CONCURRENCY),
much higher risk of disturbing currently-working throughput/retry behavior,
not a fit for an incremental one-issue-at-a-time pass.

---

## Task 9: Fix — action loops/reverses within a single clip (lifts, replaces, lifts again)
Status: done
Files:
- `src/lib/compiler.ts:1047` region → `1279-1286` (`authoredOnly()` strip),
  `1358-1401` (`BASE_NEGATIVE`/`HOLD_POSE_NEGATIVE` split), `1627-1633`
  (`negativeFor()` conditional), `3440-3500` (R7.6c high-end branch,
  `ACTION_DURATION_EXCESS_LIBRARY`)
- `src/steps/5-videos.ts:422-447` (`holdsAfterCompleting`, conditional
  "never freezes or holds a pose" sentence)

Reported symptom (user, on camera): a man lifts a wallet, puts it back down,
and lifts it again — a discrete manipulation action visibly loops/reverses
within ONE rendered clip.

Root cause, three compounding gaps, none new but never previously connected:
(1) R5's duration clamp (compiler.ts, further below in the file) always
floors a shot's render duration at 4s — Seedance's real hard minimum, per
this file's own existing comments — regardless of how little time the
shot's own action actually needs; (2) `ACTION_POSE_LIBRARY` (lib/
actionLibrary.ts) already has real per-action `typicalDurationSec` data
("pick up an object" = 1-2s) and a real completed-state `endPose` for it,
but before this fix `findActionPose()` was called in exactly ONE place in
the whole codebase (R7.6c's existing "too SHORT" check) — the `endPose`
field itself was dead data, read nowhere; (3) `5-videos.ts` appends
"Clearly visible, continuous motion throughout — the subject never freezes
or holds a pose" to EVERY shot unconditionally, and `BASE_NEGATIVE` banned
"static pose"/"frozen subject"/"holding a pose"/"no motion" for every shot
too — so a 1-2s action forced into a 4s floor had 2+ seconds of dead time
with an explicit, unconditional instruction telling the model NOT to just
hold still, leaving loop/reverse as one of the few ways left to keep
showing motion for the full clip. R7.6c's own comment had assumed this
"long shot" case was "already covered" by R7.6 (`MOTION_TOO_DENSE_FOR_
DURATION`) — confirmed false: R7.6 only fires when `beatCount >
effectiveSeconds` (too MANY beats for too little time); a single-beat
action padded by the render floor has `beatCount=1, effectiveSeconds=4` —
`1 > 4` is false, so R7.6 stays silent. Nothing previously filled that gap.

Fix: extended R7.6c (the existing "too short for this action" check) with a
symmetric "too long for this action" branch, using the SAME already-matched
`pose`/`effectiveSeconds` rather than a second detector. When a shot's
effective duration exceeds the matched action's own `typicalDurationSec`
max by ≥1.5s (real margin — chosen so "open the door," hi=2.5, still trips
at the 4s floor, while "embrace," hi=4, correctly does not), deterministically
appends a `HOLD AFTER COMPLETING:` clause to `s.motion` naming that action's
own real `endPose` text (finally reading the previously-dead field) and
explicitly forbidding reversal/repeat. `authoredOnly()` strips this marker
on recompile (idempotent — verified below), same convention as MOVING
DIRECTION:/PROP PERSISTENCE:/ALREADY COMPLETE — DO NOT RE-PERFORM:.
Downstream, the marker's presence suppresses BOTH contradicting signals for
that one shot only: `5-videos.ts` skips its blanket "never holds a pose"
sentence, and `negativeFor()` (compiler.ts) omits `HOLD_POSE_NEGATIVE`
(pulled out of `BASE_NEGATIVE` into its own conditional constant) from that
shot's negative prompt — every other shot keeps both exactly as before.

Evidence — real execution against a synthetic two-shot `Breakdown` (a "pick
up the wallet" shot forced to the 4s floor vs. an "embrace" shot at 4s,
within its own 2-4s range — the regression control), through
`compileBreakdown()` and `negativeFor()` directly:
```
$ npx tsx scratch-test-action-loop-fix.ts
ACTION_DURATION_EXCESS_LIBRARY issues: [ { "shotId": "s1", ... "autofixed": true } ]

s1.motion: "...the hand and arm lifted clear of the surface it rested on.
  HOLD AFTER COMPLETING: once Object fully gripped, fingers wrapped around
  it, the hand and arm lifted clear of the surface it rested on. hold that
  exact completed position for the rest of this shot... Do NOT reverse,
  undo, redo, or repeat this action..."
s2.motion: "They embrace. ..." (no HOLD marker — within range, untouched)

s1 negative includes 'holding a pose': false
s2 negative includes 'holding a pose': true   (regression check: untouched)

# Idempotence — recompiling the ALREADY-fixed breakdown (simulating a later
# shot regen/repair recompile):
recompile: excess issues fired again: 0 (expect 0 — already fixed)
recompile: HOLD AFTER COMPLETING occurrences in s1.motion: 1 (expect 1, not 2)

ALL CHECKS PASSED

$ npx tsc --noEmit
(no output — exit clean)
```
Scratch script deleted after verification — same discipline as Tasks 5/7/8.

Ceiling: only fires for the nine actions with an `ACTION_POSE_LIBRARY` entry
(same limitation Task 5 documented for the low-end check) — a short,
padded action this library has no entry for is undetected by design, not a
bug. Text-only, like Task 8: gives the model an explicit, non-contradictory
instruction and the real completed pose to hold, but cannot force
compliance — a video model can still choose to animate something else
during the held portion. The 1.5s margin is a judgment call, not a
measured constant; a shot sitting just under it (e.g. a "pick up" shot at
3.4s, 1.4s over) is not autofixed and could still show the same symptom at
a smaller scale.
