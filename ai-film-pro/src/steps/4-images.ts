import { config, keyframeAspect, runtime } from "../config";
import { distillEndState } from "../lib/compiler";
import { editFromReferences, isContentPolicyError } from "../providers/image";
import { readJson, readJsonOr, writeJson, downloadToFile, fileExists, isMain } from "../util";
import { ContentRefusedError } from "../lib/refusal";
import { JobCancelledError } from "../lib/cancel";
import { checkIdentity, checkKeyframe, qaConfig } from "../providers/qa-runtime";
import { withCorrection, hasCriticalDefect, CRITICAL_KINDS } from "../providers/qa";
import type { Breakdown, Character, CharacterRefs, Prop, PropRefs, LocationRefs, LocationSelections, Shot } from "../types";
import { mapLimit, CONCURRENCY } from "../concurrency";

/**
 * CACHE FORMAT: `first` is the keyframe; `last` exists only for method "flf"
 * (state-change beats, rendered by generating motion between two fixed frames).
 */
export type ShotImages = Record<string, { first: string; last?: string }>;

// PER-CHARACTER REFERENCE BUDGET — CONFIRMED BUG, NOT A HYPOTHETICAL.
//
// 3-sheet.ts's ANGLES array holds several images per character. editFromReferences()
// (image.ts) hard-caps the total reference list at 14 (Nano Banana's real
// limit) via referenceUrls.slice(0, 14), which keeps the FIRST 14 and drops
// everything after. refUrls used to be built as a flat
// inFrameIds.flatMap(id => sheet[id]) — every angle of every named character,
// in cast order, no budget at all.
//
// Simulated with real numbers: a SOLO shot sends 10 images, fine. A
// TWO-character shot sends 20 — the second character (whoever isn't first in
// the cast list) silently loses 7 of their 10 identity photos to truncation.
// A THREE-character shot sends 30 — the third character gets ZERO reference
// images at all, while the prompt text (identityOrderNote, below) still
// confidently tells the model to match that person's face against "their
// reference set" — actively misleading the model about someone it has no
// photo of, which is very likely worse than omitting the instruction
// entirely. This is a strong candidate root cause for the "secondary
// character rendered as a different person" failures this file's other
// comments describe as "confirmed on camera" — none of the existing
// mitigations (identityOrderNote, appearanceReinforce, the periodic identity
// re-anchor audit) address the reference images themselves being silently
// gone before the model ever sees the prompt.
//
// FIX: every named character gets a GUARANTEED, roughly-equal share of a
// fixed identity budget (14 minus 2 reserved for the continuity refs added
// later — the previous shot's frame and the scene anchor), and within that
// share, the HIGHEST identity-value angles are kept first — never a blind
// first-N-in-array-order slice, which would keep low-value angles (full
// body, back of the head) for the first character while a later character
// loses even their highest-value front/close-up shots.
const ANGLE_PRIORITY = [0, 8, 1, 3, 6, 2, 4, 7, 5, 9]; // indices into 3-sheet.ts's ANGLES, best-for-identity first
function budgetedRefs(urls: string[], perCharacterCap: number): string[] {
  return ANGLE_PRIORITY.filter((i) => i < urls.length)
    .slice(0, perCharacterCap)
    .map((i) => urls[i]);
}

const REALISM =
  "Photorealistic cinematic film still, shot on 35mm film with a real camera and lens, natural imperfect " +
  "skin texture with visible pores and fine detail, realistic lighting and shadows, true-to-life human " +
  "anatomy and proportions, shallow depth of field, subtle film grain, cinematic color grade, indistinguishable " +
  "from a frame captured on a real film set with real actors. " +
  "Faces show genuine human asymmetry — no face is perfectly mirrored left to right — with real moisture and " +
  "catchlight reflection in the eyes, natural under-eye and skin-tone variation, and an expression that reads " +
  "as one specific caught instant, not a posed, generic, or airbrushed-smooth mask. " +
  "Live-action, NOT cartoon, NOT anime, NOT 3D render, NOT CGI, NOT video-game graphics, NOT illustration, " +
  "NOT digital painting, NOT airbrushed or over-smoothed skin, NOT a mannequin or wax-figure look.";

const IDENTITY_LOCK =
  "IDENTITY LOCK (critical): the people MUST be the EXACT same as the reference images - identical faces, " +
  "eyes, nose, jawline, skin tone, hair, and clothing. Do NOT change their identity. Only change pose, action, framing, and background.";

// CLOSE-UPS ARE WHERE IDENTITY DIES. A face-filling shot gives the image model an
// order of magnitude more facial pixels to "improve" - and it invents a beard, ages
// him, reshapes the jaw. The character sheet grip is weakest exactly here, so a
// close-up needs a HARDER leash than a wide shot.
const CLOSEUP_LOCK =
  "EXTREME IDENTITY LOCK - THIS IS A CLOSE-UP: the face fills the frame and MUST be byte-for-byte the " +
  "same person as the reference images. Same exact face shape, jawline, nose, eyes, skin tone, hairline. " +
  "Do NOT add a beard. Do NOT add stubble. Do NOT age him. Do NOT change his facial hair from the reference " +
  "in any way. If the reference is clean-shaven, he is clean-shaven here. Reproduce the reference face " +
  "precisely; only the expression may change.";

const isCloseUp = (t: string) => /\b(close[- ]?up|tight (?:on|shot)|extreme close|face fills|CU\b|ecu\b)/i.test(t || "");

/** Renders one keyframe via the Nano Banana reference-image path.
 *  UNVERIFIED: isContentPolicyError() was written against Nano Banana/Veo's error
 *  shapes — kept as the one relevant caveat now that this is the only path. */
async function renderKeyframe(promptText: string, refs: string[], aspect: string): Promise<string> {
  return editFromReferences(promptText, refs, aspect);
}


/** Same-place test — fuzzy, matching the compiler. An exact string compare failed
 *  whenever the LLM reworded the setting slightly, which silently switched the
 *  pixel-level chaining off and produced disconnected clips. */
const sceneToks = (s: { scene?: string; setting?: string }) =>
  new Set((`${s.scene ?? ""} ${s.setting ?? ""}`).toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []);

export function sameScene(a: { scene?: string; setting?: string }, b: { scene?: string; setting?: string }): boolean {
  const sa = (a.scene || "").trim().toLowerCase();
  const sb = (b.scene || "").trim().toLowerCase();
  if (sa && sb && sa === sb) return true;
  const A = sceneToks(a), B = sceneToks(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.4;
}

export async function runImages(
  onProgress?: (done: number, total: number) => void,
  // Checked once per shot, only when that shot is actually about to do real
  // paid work (never for a cache hit — no reason to interrupt something free).
  // Throws JobCancelledError, caught by worker.ts's tick() the same way
  // ContentRefusedError/BudgetCapExceededError already are. See lib/cancel.ts.
  isCancelled?: () => Promise<boolean>,
): Promise<ShotImages> {
  const breakdown = await readJson<Breakdown>(`${runtime.outDir}/breakdown.json`);
  const sheet = await readJson<CharacterRefs>(`${runtime.outDir}/characters.json`);
  const charById: Record<string, Character> = Object.fromEntries(breakdown.characters.map((c) => [c.id, c]));
  // Gap A — prop reference sheet, same shape/loading as the character sheet
  // above. readJsonOr, not readJson: props.json is written even for a film
  // with zero tracked props (an empty {} — see 3b-props.ts), but a
  // breakdown compiled before this feature existed has no such file at all.
  const propSheet = await readJsonOr<PropRefs>(`${runtime.outDir}/props.json`, {});
  const propById: Record<string, Prop> = Object.fromEntries((breakdown.props ?? []).map((p) => [p.id, p]));
  // Location reference sheets (3c-locations.ts) — same readJsonOr fallback
  // reasoning as propSheet above: only a genuinely revisited location gets an
  // entry at all (most locationIds have none), and a breakdown compiled
  // before this feature existed has no locations.json file whatsoever.
  const locationSheet = await readJsonOr<LocationRefs>(`${runtime.outDir}/locations.json`, {});
  // CONFIRMED REAL GAP, FIXED — a NON-revisited location (most locations in
  // most short scripts) had NO visual reference feeding shot generation at
  // all: locationSheet only ever has entries for genuinely revisited places
  // (3c-locations.ts's own scoping), so locationRef below was unconditionally
  // empty for everything else. locationSelections (2b-location-options.ts) —
  // the user's chosen look, made for EVERY location, not just revisited ones
  // — is read here as the fallback anchor for exactly that gap.
  const locationSelections = await readJsonOr<LocationSelections>(`${runtime.outDir}/location-selections.json`, {});
  const existing = await readJsonOr<ShotImages>(`${runtime.outDir}/images.json`, {});

  // SEQUENTIAL, ON PURPOSE. Keyframes used to render 3-at-once — which meant every
  // shot's world was invented in ISOLATION, and the stonework, light, and street
  // quietly changed between cuts. Now each shot's FIRST keyframe takes the previous
  // shot's FINAL image as its leading reference: the world is handed forward,
  // pixel to pixel, shot to shot. Slower step, dramatically more coherent film.
  console.log(`🎨 Generating shot keyframes (sequential — each shot chains from the last)...`);

  const total = breakdown.shots.length;
  let done = 0;

  const pairs: Array<readonly [string, { first: string; last?: string }]> = [];

  // FLAGGED SHOTS — see #4 in the long-form consistency plan: at 10-30 minute
  // scale (100s of shots), nobody should have to scrub the whole film to find
  // the handful that need a look. Every shot the identity audit confirms as
  // still-drifted (even after its one retry) gets recorded here with WHY, and
  // written out for worker.ts to attach to clipsJson so the review screen can
  // surface it directly instead of it only ever reaching a console log.
  const flags: Record<string, string[]> = {};
  const flag = (shotId: string, reason: string) => {
    (flags[shotId] ??= []).push(reason);
  };

  // Chain state: the last visual of the previous shot, and where/who it was.
  // NOW DECLARED PER SCENE RUN, inside the mapLimit() callback below — see the
  // SCENE-RUN PARALLELISM comment there. These were process-wide `let`s when the
  // whole pass was one sequential loop; they are per-run now because that is
  // exactly the scope they always semantically had (every read of them is gated
  // on `chains`/`anchorHolds`, both of which require sameScene()).

  // SCENE ANCHOR — fights DRIFT ACCUMULATION over a long scene. Chaining only from
  // the immediately previous shot is a game of telephone: each edit is a faithful
  // copy of the one before it, but small reinterpretations compound, and by shot 12
  // of a 14-shot scene (the nursery hallway, the monitor's position, the wall decor)
  // has quietly wandered from where it started even though every single HANDOFF
  // looked fine in isolation. The fix is to also keep a reference to the ORIGINAL
  // establishing frame of the current scene and feed it forward alongside the
  // immediate-previous frame for every shot in that scene — a fixed ground truth the
  // chain cannot wander away from, not just a copy of a copy.
  // (declared per scene run below, alongside the chain state)

  // PERIODIC IDENTITY RE-ANCHOR STATE — see config.identityReanchorInterval.
  // Counts CHAINED shots since identity was last given priority over the
  // continuity chain. A new scene already resets this naturally (chains=false
  // there uses only the character sheet, no world reference to compete with
  // it), so this only matters for a long run of many consecutive shots within
  // ONE scene — exactly the case a long-form film has far more of.
  // (declared per scene run below — a new scene already reset it to 0, so
  // per-run scoping is identical to the old behaviour at every scene boundary)

  // COST ACCOUNTING — EXACT, not approximate. Previously this counted one
  // "image unit" per SHOT, which undercounts any shot needing more than one
  // real generation call: a two-endpoint (flf) shot's end frame, a content-
  // policy refusal's softened retry, or an identity-correction retry. Each of
  // those is a real, separately-billed fal call, so each is counted here
  // individually, at the exact moment renderKeyframe() is actually invoked —
  // never inferred from shot count after the fact.
  let nanoBananaImageCalls = 0;
  const renderKeyframeCounted: typeof renderKeyframe = (promptText, refs, aspect) => {
    nanoBananaImageCalls++;
    return renderKeyframe(promptText, refs, aspect);
  };

  // ⏱ TEMPORARY TIMING INSTRUMENTATION — see the matching summary printed at
  // the end of this function. Added to find out exactly where keyframe-phase
  // wall-clock time actually goes (base render vs identity-check vs
  // composition-check vs the retry renders each can trigger), the same way
  // 1-breakdown.ts's own (now-removed) instrumentation found the real repair-
  // loop bottleneck earlier. Pure measurement, zero behavior change — safe to
  // delete once the real bottleneck here is found and fixed.
  let timeBaseRenderMs = 0;
  let timeIdentityCheckMs = 0;
  let timeIdentityCorrectionRenderMs = 0;
  let timeCompositionCheckMs = 0;
  let timeCompositionRetryRenderMs = 0;
  let timeEndFrameRenderMs = 0;
  const since = (t0: number) => Date.now() - t0;

  // PRIORITY 2 — PRE-VIDEO-GENERATION KEYFRAME VALIDATION FILTER stats. Real
  // evidence for whether this filter is actually saving render spend, not
  // just theoretical: how many keyframes were checked, and what fraction
  // failed on their FIRST attempt (before any keyframe-regeneration retry) —
  // each one of those is a paid video-generation call this filter prevented
  // from ever being made against a known-bad frame. Written to
  // keyframe-qa-stats.json alongside image-shots.json below.
  let keyframesChecked = 0;
  let keyframesFailedFirstAttempt = 0;
  let keyframesUnverified = 0;

  // ── SCENE-RUN PARALLELISM ────────────────────────────────────────────────
  // This pass used to be ONE sequential loop over every shot in the film, on the
  // grounds that "each shot chains from the last". That is true — but only
  // WITHIN a scene. `chains` (below) requires sameScene(shot, prevShotMeta), and
  // every other cross-shot value (sceneAnchorUrl, shotsSinceIdentityReanchor) is
  // read only behind `chains`/`anchorHolds`, which carry the same requirement. So
  // at every scene boundary the chain already reset to nothing: two different
  // scenes never shared a single pixel of reference.
  //
  // Running the whole film sequentially therefore serialised work that had no
  // dependency at all. MEASURED on a real 86-shot film: 9 contiguous same-scene
  // runs of 7/11/12/9/9/15/12/9/2 shots. Sequentially that is 86 shots
  // end-to-end; run-parallel the floor is the LONGEST run, 15 — a 5.7x
  // reduction in wall-clock for byte-identical output, since 140 image renders
  // plus their per-shot identity/composition QA calls all still happen, just not
  // one after another.
  //
  // The runs are CONTIGUOUS same-scene groups, not "all shots grouped by scene":
  // a scene the film cuts away from and returns to is two separate runs, exactly
  // as the old sequential pass treated it (prevShotMeta only ever held the
  // immediately preceding shot). Continuity within a run is untouched — the loop
  // body below is unchanged and still strictly sequential inside its own run.
  //
  // Everything shared across runs is an order-independent accumulator (`pairs`,
  // fed to Object.fromEntries and keyed by shot id; the timing/`nanoBanana`/
  // `keyframes*` counters; `done`, a plain count). JavaScript is single-threaded,
  // so `+=` and `.push()` from concurrent callbacks cannot interleave mid-update.
  const sceneRuns: Shot[][] = [];
  for (const shot of breakdown.shots) {
    const currentRun = sceneRuns[sceneRuns.length - 1];
    if (currentRun && sameScene(shot, currentRun[currentRun.length - 1])) currentRun.push(shot);
    else sceneRuns.push([shot]);
  }
  console.log(
    `   ${sceneRuns.length} scene run(s) of ${sceneRuns.map((r) => r.length).join("/")} shot(s) — ` +
    `runs render in parallel, shots within a run stay sequential for continuity.`,
  );

  await mapLimit(sceneRuns, CONCURRENCY, async (runShots) => {
    // Per-run continuity state. Starts empty for every run, which is precisely
    // what the old single loop did on entering a new scene.
    let prevLastUrl: string | undefined;
    // CONFIRMED REAL GAP, FIXED (background/prop "pop" at the cut, reported
    // on camera): chainClause below unconditionally tells the model prevLastUrl
    // "is the final frame of the PREVIOUS shot" — true only when that shot
    // was method="flf" and actually got a real end-keyframe rendered (see
    // `needsEnd`/`lastUrl` below). For an ordinary i2v shot (no endFrame —
    // the common case), `prevLastUrl = lastUrl ?? firstUrl` silently falls
    // back to that shot's own OPENING keyframe, and the model is still told
    // it's the ending one. Whatever that shot's own motion text moved,
    // repositioned, or revealed is invisible to this reference image, so the
    // NEXT shot's world is anchored to a moment before the previous shot's
    // motion happened — while the actual rendered CLIP plays that motion out
    // first. The mismatch is invisible comparing keyframe stills (each new
    // keyframe faithfully matches the one before it) and only shows up at
    // the cut, in the rendered video, exactly the "background glitched a
    // little going into the next clip" symptom. Tracked here so the chain
    // clause can be honest about which case it's in instead of always
    // asserting "final frame" — see prevEndDistilled/endStateHint below.
    let prevShotEndUnknown = false;
    let prevShotForHint: Shot | undefined;
    let prevShotMeta: { scene?: string; setting?: string } | null = null;
    let prevChars: string[] = [];
    let sceneAnchorUrl: string | undefined;
    let sceneAnchorMeta: { scene?: string; setting?: string } | null = null;
    let shotsSinceIdentityReanchor = 0;

  for (const shot of runShots) {
    const destA = `${runtime.outDir}/images/${shot.id}.png`;
    const destB = `${runtime.outDir}/images/${shot.id}-end.png`;
    const needsEnd = shot.method === "flf" && !!shot.endFrame.trim();

    // Would this shot chain from the previous one? Same scene, AND the cast is
    // "compatible" — either shot has NOBODY in frame (an insert: a monitor screen,
    // a crib, an object), or they actually share a character.
    //
    // BUG THIS FIXES: the old check was `shot.characters.some(id => prevChars.includes(id))`
    // with no exception for an empty cast. Two consecutive shots of the SAME monitor
    // sitting on the SAME table — zero characters in either — have `[].some(...)`,
    // which is ALWAYS false regardless of what prevChars contains. So back-to-back
    // insert shots (a monitor screen, then the monitor screen again from a different
    // angle) NEVER chained, and each was painted as an independent world: the
    // hallway behind the monitor changed, the baby on the screen changed, the
    // monitor's own position on the table changed. This is exactly the reported
    // "background completely changed" / "completely different babies" failure —
    // it was not a rendering fluke, it was this line refusing to chain a shot with
    // itself because an empty array has no overlap with anything, including itself.
    const castCompatible =
      shot.characters.length === 0 ||
      prevChars.length === 0 ||
      shot.characters.some((id) => prevChars.includes(id));
    const chains =
      !!prevLastUrl &&
      !!prevShotMeta &&
      sameScene(shot, prevShotMeta) &&
      castCompatible;

    // Is this shot still inside the SAME scene run as the current anchor? (No
    // character-overlap requirement here — an anchor is about the WORLD, not who is
    // in frame, so an empty insert shot in the same room still belongs to the run.)
    const anchorHolds = !!sceneAnchorUrl && !!sceneAnchorMeta && sameScene(shot, sceneAnchorMeta);

    // CACHE — a cached shot still feeds the chain: the NEXT shot must anchor to
    // this one's final image whether or not we just paid to render it.
    const cached = existing[shot.id];
    if (cached?.first && (await fileExists(destA)) && (!needsEnd || (cached.last && (await fileExists(destB))))) {
      console.log(`   ↻ ${shot.id} (cached)`);
      done++; onProgress?.(done, total);
      pairs.push([shot.id, cached] as const);
      prevLastUrl = cached.last ?? cached.first;
      prevShotEndUnknown = !cached.last;
      prevShotForHint = shot;
      prevShotMeta = { scene: shot.scene, setting: shot.setting };
      prevChars = shot.characters;
      if (!anchorHolds) { sceneAnchorUrl = cached.first; sceneAnchorMeta = { scene: shot.scene, setting: shot.setting }; }
      // Keep the re-anchor counter in sync even for a cache hit — it wasn't
      // regenerated this run, but shot progression still counts toward the
      // NEXT shot's re-anchor decision.
      shotsSinceIdentityReanchor = chains ? shotsSinceIdentityReanchor + 1 : 0;
      continue;
    }

    // STOP HERE, ONLY BEFORE REAL PAID WORK — never in place of a cache hit
    // above (that costs nothing, no reason to interrupt it). worker.ts's
    // finally-wrapped bank of runtime.outDir/images still picks up every
    // shot rendered before this point, so a resume redoes only what wasn't
    // done yet, same as a genuine crash-and-retry already does.
    if (isCancelled && (await isCancelled())) throw new JobCancelledError();

    // ── CAST ────────────────────────────────────────────────────────────────
    // THE OLD "SAFETY NET" WAS THE PHANTOM-MAN GENERATOR:
    //
    //   if (refUrls.length === 0 && allRefs.length > 0) {
    //     refUrls = allRefs.slice(0, 6);
    //     inFrameIds = breakdown.characters.slice(0, 2).map(c => c.id);   // ← !!
    //   }
    //
    // Any shot whose cast failed to resolve was silently turned into a
    // TWO-CHARACTER shot. It never dropped a reference — it invented a cast.
    //
    // A shot with NO people is completely legitimate: the aftermath insert of
    // oranges rolling across the ground has no one in it. Render it empty.
    // Never guess at who belongs in a frame.
    const inFrameIds = shot.characters.filter((id) => sheet[id]);
    const missing = shot.characters.filter((id) => !sheet[id]);
    if (missing.length) {
      throw new Error(
        `Shot ${shot.id} names character(s) [${missing.join(", ")}] with no character sheet. ` +
        `Refusing to substitute someone else — that is how a radio voice ends up standing in the market. ` +
        `Re-run step 3, or fix this shot's cast.`,
      );
    }
    // See budgetedRefs()'s own comment above for why this is capped at all.
    // Floor of 1, NOT a higher minimum: the actual bug being fixed is a
    // character getting ZERO reference images, not "fewer than some ideal
    // count" — a floor of 3 was tried first and INVERTED for 5+ simultaneously
    // named characters (5 × 3 = 15, back over the 12-image identity budget,
    // reintroducing a milder version of the very truncation this exists to
    // prevent). Floor of 1 guarantees the total never exceeds budget at any
    // cast size while still guaranteeing every named character gets at least
    // their single highest-value (front-facing) photo — for the common
    // 1-4-character case this produces the exact same 10/6/4/3-per-character
    // split either way; it only differs, and only helps, once a shot names 5+
    // people at once.
    // productImageReserve: when this shot has product photos to anchor (ad
    // mode), 2 of the 12-image identity pool are set aside so the productRefs
    // slice(0, 2) below always actually has room — see productRefs' own
    // comment for the concrete arithmetic this fixes.
    const productImageReserve = runtime.productImages.length > 0 ? 2 : 0;
    // propImageReserve: CONFIRMED REAL GAP, FIXED — this shot's tracked props
    // (propRefs, computed further below) were never budgeted for here, only
    // product images were. On a busy shot (2+ named characters, chained
    // continuity already at 12, plus a tracked prop) the reference list could
    // exceed editFromReferences()'s hard 14-image cap and silently drop the
    // prop reference entirely, while propText above still confidently told
    // the model to match it. Same reservation mechanism as productImageReserve,
    // sized to what propRefs itself is capped at (2 images per tracked prop,
    // "most shots track at most one or two props anyway" per its own comment)
    // — moved up here from its original spot further below so it's available
    // for this budget math; inFramePropIds is reused as-is down there.
    const inFramePropIds = (shot.props ?? []).filter((id) => propSheet[id]?.length);
    const propImageReserve = inFramePropIds.length > 0 ? Math.min(inFramePropIds.length * 2, 4) : 0;
    // locationImageReserve: same reservation mechanism as productImageReserve/
    // propImageReserve, sized to what locationRef itself is capped at below (a
    // single image — the location sheet's fixed-geometry anchor is one "is
    // this the same room" ground truth, not a per-character-style identity
    // pool, so it doesn't need more than one reference photo).
    // FALLBACK TO THE CHOSEN LOOK — CONFIRMED REAL GAP, FIXED: locationSheet
    // only has entries for genuinely revisited locations, so every OTHER
    // shot (most shots, in most films) got no location reference at all.
    // When there's no multi-angle sheet for this locationId, fall back to
    // the user's single chosen look (locationSelections) instead of nothing
    // — costs no new generation (the image already exists), gives every shot
    // with a resolved location SOME visual anchor rather than none.
    const sheetRefs = shot.locationId ? (locationSheet[shot.locationId] ?? []) : [];
    const chosenLocationInfo = shot.locationId ? locationSelections[shot.locationId] : undefined;
    const chosenLocationFallback = !sheetRefs.length && chosenLocationInfo
      ? chosenLocationInfo.options[(chosenLocationInfo.chosen || 1) - 1] ?? chosenLocationInfo.options[0]
      : undefined;
    const locationRef = budgetedRefs(sheetRefs.length ? sheetRefs : (chosenLocationFallback ? [chosenLocationFallback] : []), 1);
    const locationImageReserve = locationRef.length > 0 ? 1 : 0;
    const perCharacterRefCap = Math.max(1, Math.min(10, Math.floor((12 - productImageReserve - propImageReserve - locationImageReserve) / Math.max(1, inFrameIds.length))));
    // Kept as separate per-character lists (not just the flattened refUrls below)
    // so identityOrderNote can state an EXPLICIT NUMBERED RANGE per person ("photos
    // 1-4 are X, photos 5-8 are Y") instead of only prose ordering — the same
    // unambiguous reference-tagging discipline a real shot-list uses (@img1/@img2/
    // @img3 style role tags), scoped to this labeled subset so it stays correct
    // regardless of whether a world/continuity reference is prepended or appended
    // elsewhere in the final image list for this call.
    const perCharacterRefLists = inFrameIds.map((id) => budgetedRefs(sheet[id] ?? [], perCharacterRefCap));
    const refUrls = perCharacterRefLists.flat();

    const displayName = (id: string) => charById[id]?.name ?? id;

    // ── COMPOSITION ─────────────────────────────────────────────────────────
    // The old code did this, unconditionally, for any 2+ cast:
    //
    //   composition = `TWO-SHOT: ${who} together in the SAME frame,
    //                  every face clearly visible, facing each other.`
    //
    // "facing each other." Combined with the earpiece VOICE being parsed as a
    // character, that line IS the phantom-man screenshot. It rendered the prompt
    // perfectly.
    // CROWD-AWARE. "Any humans present are distant, blurred background figures" is
    // correct for a market street — it is a standing INVITATION to add a stranger
    // in a private house at 2am with a cast of two. Confirmed on camera: a woman
    // with no story reason to exist appeared in the hallway behind a character in
    // exactly this kind of shot. When shot.crowd is false, say the harder thing:
    // there is nobody else here at all, not even blurred, not even distant.
    let composition: string;
    if (inFrameIds.length === 0) {
      composition = shot.crowd
        ? "NO PEOPLE in the foreground. Any humans present are distant, blurred, out-of-focus background " +
          "figures at correct human scale. "
        : "NO PEOPLE anywhere in this frame — foreground or background. This location is completely empty " +
          "of people right now. Do NOT add anyone, even distant or blurred. ";
    } else if (inFrameIds.length === 1) {
      const who = displayName(inFrameIds[0]);
      composition = shot.crowd
        ? `SINGLE SUBJECT: ${who} is the ONLY person in the foreground. ` +
          `Do NOT add a second figure. Do NOT place anyone facing him. Do NOT add a conversation partner. ` +
          `Every other human is a blurred, out-of-focus background figure at correct human scale. `
        : `SINGLE SUBJECT: ${who} is the ONLY person anywhere in this frame — foreground AND background. ` +
          `Do NOT add a second figure, not even blurred or distant. Do NOT place anyone facing him. Do NOT ` +
          `add a conversation partner, a bystander, or anyone visible through a doorway, window, or hallway. ` +
          `There is nobody else in this location at all. `;
    } else {
      const who = inFrameIds.map((id) => displayName(id)).join(" and ");
      composition = shot.crowd
        ? `${inFrameIds.length}-SHOT: ${who} together in the SAME frame, every face clearly visible. ` +
          `EXACTLY ${inFrameIds.length} people in the foreground and no others. `
        : `${inFrameIds.length}-SHOT: ${who} together in the SAME frame, every face clearly visible. ` +
          `EXACTLY ${inFrameIds.length} people appear anywhere in this frame, foreground or background, and ` +
          `no others — nobody else in this location at all, not even blurred or distant. `;
    }

    // Crowd is BACKGROUND. Scale was never constrained — hence the tiny people.
    // Confirmed real (QA finding background_identity_bleed, qa.ts): a background vendor at
    // one stall and an unrelated background vendor at a different stall both rendered with
    // the SAME face as a named cast member established elsewhere in the film — as if a
    // principal's identity got reused for a stranger who was never supposed to be them.
    // inFrameIds already keeps named-character reference photos out of a shot they're not
    // in, but a chained scene-anchor/continuity image CAN still contain a named character's
    // face (from an earlier shot in the same scene), so the model needs an explicit
    // instruction not to lift a face out of ANY reference image for an unnamed extra.
    const crowdText = shot.crowd
      ? "Background: MANY people going about their own business (walking, shopping, vendors, talking) — but they are " +
        "BACKGROUND ONLY: out of focus, at CORRECT HUMAN SCALE relative to the subject, receding naturally into the " +
        "distance. None of them approach, face, or interact with the subject. Every one of these background people " +
        "must have their OWN distinct, invented face — never the face of any named character shown in this " +
        "prompt's reference images, whether that character is the subject of this shot or not. "
      : "";

    // CLOSED-SET CONSTRAINT — CONFIRMED REAL GAP: a real render put a door
    // mid-footpath and a staircase inside a throne room, neither word present
    // anywhere in the script or this shot's own setting text — the renderer
    // filling a gap with plausible-looking invented set dressing rather than
    // rendering only what was actually described. Nothing previously told it
    // NOT to add architecture/objects; UNMOTIVATED MOVES-style negatives
    // existed for invented ACTIONS (see llm.ts) but not for invented SET
    // DRESSING. This won't fully close a generative model's tendency to fill
    // gaps, but an explicit closed-set instruction is the same category of
    // mitigation as every other "state it or the model invents it" fix in
    // this file.
    const settingText = shot.setting
      ? `Setting and background: ${shot.setting}. Render ONLY the location and objects described in this ` +
        `setting — do not add a door, window, staircase, furniture, device, or any other object or ` +
        `architectural feature that isn't explicitly mentioned here. `
      : "";

    // ── FRAMING ─────────────────────────────────────────────────────────────
    // The old code framed for `charById[shot.speaker]` with no check that the
    // speaker was actually IN the shot. For the earpiece beat, shot.speaker was
    // the VOICE — so it asked for "Voice's face clearly visible, toward camera,
    // mid-sentence." A radio operator. Face to camera. Mid-sentence. Rendered.
    const speakerOnScreen =
      !!shot.speaker && !shot.offscreenSpeaker && inFrameIds.includes(shot.speaker);

    let framing = shot.camera || "well-composed cinematic shot";
    if (shot.dialogue && speakerOnScreen) {
      framing = `${shot.camera || "medium close-up"}; ${charById[shot.speaker!].name}'s face clearly visible, toward camera, mid-sentence`;
    } else if (shot.dialogue && shot.offscreenSpeaker) {
      // The fix that turns the worst shot in the sequence into the best one.
      framing =
        `${shot.camera || "tight close-up"}; the subject LISTENS. The speaker is NOT PRESENT — the line comes ` +
        `through an earpiece from somewhere else entirely. His mouth is CLOSED. NOBODY is talking to him. ` +
        `There is NO second person in this frame.`;
    }

    const lightingText = shot.lighting ? `Lighting: ${shot.lighting}.` : "Lighting: cinematic, dramatic.";

    // COLOR PALETTE — locked ONCE for the whole project by compileBreakdown()
    // (see pickColorPalette() in compiler.ts) and applied to EVERY shot here,
    // uniformly, so the whole film holds one consistent grade instead of each
    // shot's image model quietly picking its own. Empty for any project
    // compiled before this feature existed -- simply omitted, no fallback text.
    const paletteText = breakdown.colorPalette ? ` Color grade: ${breakdown.colorPalette}` : "";

    // Is this a close-up? Check the resolved framing + the shot camera/description.
    const closeUp = isCloseUp(framing) || isCloseUp(shot.camera) || isCloseUp(shot.description);

    // FACE TEXT-ANCHOR. Previously only applied to a SOLO close-up, where there is
    // no ambiguity (one person, one identity reference block). The identity-
    // SUBSTITUTION bug — confirmed on camera: a shopkeeper rendered as a
    // completely different, unrelated person for several shots, then correctly
    // as himself later — showed up specifically in MULTI-person shots, which
    // never got any text reinforcement at all and relied purely on reference-
    // image ORDER to convey "this image block is Farid, that one is Amir". That
    // is a weak signal on its own, and weaker still once a chained world/
    // continuity reference (which may itself contain a face) is also in the
    // mix. Pure hands-only inserts had no face in frame to conflict with and
    // were unaffected — consistent with this being the actual gap. Extending
    // this to EVERY shot with named characters, not just solo close-ups, gives
    // the model an explicit NAME -> APPEARANCE mapping in text for each person
    // in frame, not just image position.
    const appearanceReinforce = inFrameIds.length
      ? " " +
        inFrameIds
          .map((id) => {
            const c = charById[id];
            if (!c) return "";
            const appearance = c.appearance.trim().replace(/\.+$/, "");
            return `${displayName(id)}'s exact appearance, which MUST be reproduced faithfully and is not open to reinterpretation: ${appearance}.`;
          })
          .filter(Boolean)
          .join(" ")
      : "";

    const lock = refUrls.length
      ? ` ${closeUp ? CLOSEUP_LOCK : IDENTITY_LOCK}${appearanceReinforce}`
      : "";

    // PRODUCT ANCHORING ("ad mode") — see Project.productImages.
    //
    // CAPPED, NOT "however many happen to fit" — same lesson as the
    // budgetedRefs() fix above, verified with the same kind of concrete
    // arithmetic: a 2-character shot with a scene anchor already uses
    // refUrls(12) + continuity(2) = 14, the FULL cap, before product images
    // are even considered. Appending all up to 4 uploaded product photos
    // after that (the previous behaviour) meant EVERY one of them silently
    // dropped in that realistic combination — not graceful degradation, a
    // total, silent feature failure for exactly the ad-mode-with-people case
    // a real customer is likely to use. Reserving 2 guaranteed slots here
    // (perCharacterRefCap above already accounts for this via
    // productImageReserve) means at least one product photo always survives.
    // GENERALIZED WORDING, SAME MECHANISM. This started as literal product
    // photography (a bottle, a box — where "packaging, label text" is exactly
    // right), but the identical anchoring need applies to any real hero
    // OBJECT a project uploads a reference photo of and needs pixel-identical
    // in every shot — a specific car, a specific prop — where "packaging,
    // label text" would read oddly. "Shape, materials, colors, distinguishing
    // marks (badges, decals, packaging or label text where applicable)" covers
    // both without a separate code path or a second runtime.* list.
    const productRefs = runtime.productImages.slice(0, 2);
    const productText = productRefs.length
      ? ` REFERENCE OBJECT ACCURACY (critical): the LAST ${productRefs.length === 1 ? "reference image is" : `${productRefs.length} reference images are`} ` +
        `the exact real object${productRefs.length === 1 ? "" : "s"} that must appear in this shot. Reproduce ` +
        `${productRefs.length === 1 ? "its" : "their"} shape, materials, colors, distinguishing marks (badges, decals, ` +
        `packaging or label text where applicable), and proportions EXACTLY as shown — do not redesign, restyle, ` +
        `recolor, or invent a different object.`
      : "";

    // PROP ANCHORING (Gap A) — the exact same mechanism as PRODUCT ANCHORING
    // just above, but per-SHOT (shot.props) and per-PROP (propSheet[id]),
    // not project-wide. Capped at 2 reference angles per prop for the same
    // "the pool has a real ceiling" reason perCharacterRefCap exists —
    // most shots track at most one or two props anyway.
    // (inFramePropIds itself now computed earlier, alongside propImageReserve.)
    const propRefs = inFramePropIds.flatMap((id) => budgetedRefs(propSheet[id] ?? [], 2));
    const propText = inFramePropIds.length
      ? ` PROP APPEARANCE ACCURACY (critical): the reference image(s) for ` +
        `${inFramePropIds.map((id) => propById[id]?.name ?? id).join(", ")} show the exact real object${inFramePropIds.length === 1 ? "" : "s"} ` +
        `that must appear in this shot. Reproduce ${inFramePropIds.length === 1 ? "its" : "their"} shape, materials, colors, size, proportions, ` +
        `and any distinguishing markings EXACTLY as shown — same object every time it appears, never redesigned, restyled, resized, or reshaped.`
      : "";

    // LOCATION GEOMETRY ANCHORING — same mechanism as PROP ANCHORING just
    // above, for the room/place itself rather than an object in it. Present
    // for effectively every shot with a resolved locationId now (locationRef
    // falls back to the user's chosen location look when there's no
    // multi-angle sheet — see that fallback's own comment above), not only a
    // genuinely revisited one — additive to sceneAnchorUrl, not a
    // replacement: sceneAnchorUrl covers tight within-scene continuity, this
    // covers a location's fixed identity across the WHOLE film, revisited or
    // not.
    const locationText = locationRef.length
      ? ` LOCATION GEOMETRY ACCURACY (critical): the reference image for this location shows the fixed layout ` +
        `of this exact room/place — reproduce the exact position of its key landmarks, walls, and fixed ` +
        `furniture EXACTLY as shown, never a different arrangement or orientation, even though this is a ` +
        `different camera angle or moment than the reference photo.`
      : "";

    const build = (sceneText: string) =>
      `${REALISM} ${composition}${crowdText}${settingText}Scene: ${sceneText}. Framing: ${framing}. ${lightingText}${paletteText}${lock}${productText}${propText}${locationText}`;

    // ── RENDER: FIRST FRAME, CHAINED TO THE PREVIOUS SHOT ───────────────────
    // The character sheet locks his FACE. It locks nothing about the wall, the
    // street, or the sun — which is why the stonework drifted between cuts. The
    // previous shot's final image, passed as the LEADING reference (edit models
    // weight the first reference most heavily), locks THE WORLD.
    const firstScene = shot.startFrame.trim() || shot.description;
    // THE CHAIN REFERENCE IS FOR THE *WORLD*, NOT FOR THE PEOPLE.
    //
    // BUG THIS FIXES: the previous shot's final frame contains the subject. If we
    // only say "continue from this frame", the edit model keeps the person IN that
    // reference AND adds the subject from the character sheet — two copies of the
    // same man. Staged close together they overlap and merge into one body with a
    // second head/shoulder behind it. That is the doubled character.
    //
    // So we scope the reference explicitly: take the STREET from it, take the
    // PERSON from the character sheet, and state the headcount as a hard number.
    // CONFIRMED REAL GAP, FIXED (a shorter/older/stooped named character
    // rendered visibly too small for the room — "tiny person" defect): the
    // BACKGROUND-crowd version of this exact failure was already fixed
    // elsewhere in this file ("Crowd is BACKGROUND. Scale was never
    // constrained — hence the tiny people.") — but that fix only ever
    // anchored CROWD figures to "correct human scale," never the named
    // foreground subject(s) headcount governs. A character's own appearance
    // text (age/build/height/posture — e.g. "shorter, stooped") flows
    // straight into the prompt with nothing telling the model that a
    // shorter or stooped ADULT is still full adult scale, not a smaller,
    // more distant-looking, or child/doll-sized figure. Folded directly into
    // headcount (not a separate variable) so it rides along everywhere
    // headcount already does, at zero extra cost and no new call sites.
    const scaleLock =
      " Every person in this frame renders at correct, full real-world ADULT HUMAN SCALE relative to the room, " +
      "furniture, doorways, and any other people or objects around them — exactly as large as a real person " +
      "of ordinary adult height actually standing there, never smaller, more distant-looking, or doll/child-" +
      "sized. This holds regardless of how a person's build, height, or posture is described — a shorter, " +
      "stockier, or stooped physique is still ordinary adult human size, not a miniature figure.";
    const headcount =
      inFrameIds.length === 0
        ? "There are NO people in the foreground of this frame."
        : inFrameIds.length === 1
        ? `There is EXACTLY ONE person in this frame — ${displayName(inFrameIds[0])} — and he/she appears ONCE. Do NOT paint a second copy of this person. Do NOT place anyone behind, beside, or overlapping them. Any person visible in the first reference image IS this same single person, not an additional one.${scaleLock}`
        : (() => {
            // Same fix as the solo case just above, extended to 2+ people: a bare
            // total-count constraint ("exactly 2, each appears once") is a much
            // weaker signal against duplication than naming each individual and
            // forbidding THEIR OWN second copy — confirmed on camera, a 2-person
            // market shot rendered one of its two named people (the shopkeeper)
            // twice in the same frame despite the old, generic "each appears once."
            const who = inFrameIds.map((id) => displayName(id));
            return (
              `There are EXACTLY ${inFrameIds.length} people in this frame and no others: ${who.join(", ")}. ` +
              `Each of them appears EXACTLY ONCE — do NOT paint a second copy of ${who.join(" or ")}. ` +
              `Do NOT duplicate, double, or repeat any of them anywhere in the frame, foreground or background. ` +
              `Any person visible in the first reference image IS one of these same people, not an additional one.${scaleLock}`
            );
          })();

    // Only worth adding the scene anchor when it is a DIFFERENT image than the
    // immediate-previous frame — on shot 2 of a scene they are the same picture.
    // Also skip it when the reference list is already near the edit model's
    // 14-image cap — identity references for the actual people in frame matter
    // more than one extra background-grounding image, and editFromReferences()
    // silently truncates the TAIL of the list. refUrls is now budgeted (see
    // budgetedRefs() above) so this should rarely trigger for a typical
    // (1-4 named character) shot, but stays as a real guard for a large
    // simultaneously-named cast where the identity budget itself is already tight.
    const useAnchor =
      chains && anchorHolds && !!sceneAnchorUrl && sceneAnchorUrl !== prevLastUrl && refUrls.length + 2 <= 14;

    // PERIODIC IDENTITY CHECKPOINT — see config.identityReanchorInterval. Every
    // this-many CHAINED shots in a row, run the whole-film identity audit
    // below regardless of provider. On the Nano Banana path this ALSO
    // deliberately favours the character sheet over the continuity chain for
    // THIS one shot: identity references go FIRST (editFromReferences()
    // weights the first reference(s) most heavily) instead of last. On the
    // Only applies when there's a named character to check — an empty/object-
    // only insert shot has nothing to drift.
    //
    // ALSO due, regardless of the periodic counter or chain state, on ANY
    // shot with 2+ named characters — a 2-person shot is the single
    // highest-risk case for visible drift, whether or not it happens to land
    // on a periodic checkpoint. A real render's worst face-drift complaints
    // landed specifically on its multi-character shots (an embrace, a
    // reunion) — none of which happened to coincide with the periodic
    // schedule. The audit itself is cheap (one still keyframe vs. the
    // reference sheet, no frame sampling) — worth spending on every
    // multi-character shot rather than gambling on the schedule for exactly
    // the riskiest case.
    //
    // ALSO due on a FRESH, NON-CHAINED entrance (!chains) — CONFIRMED REAL GAP
    // from a real render ("The Package"): chains itself requires cast overlap
    // with the immediately previous shot (see castCompatible above), so a
    // character's first solo appearance in a NEW scene, or a solo character
    // re-entering after being absent from the immediately preceding shot,
    // NEVER satisfies chains — which means the periodic-interval clause above
    // can mathematically never fire for them, no matter how high or low
    // config.identityReanchorInterval is set. Worked through with the exact
    // numbers from that render: a 6-shot solo-heavy interior scene under the
    // default interval of 5 never reached the threshold even once, and the
    // ONE new character who entered that scene alone (partway through, with
    // no shared cast in the immediately preceding shot) was — by this exact
    // logic — mathematically guaranteed never to get a single identity check
    // for the entire scene. That is exactly the confirmed defect: her face no
    // longer matched her reference by the time she appeared. A fresh,
    // non-chained entrance has no pixel-continuity anchor to lean on at all
    // (unlike a chained shot, which at least inherits the previous frame's
    // likely-correct face) — it is precisely the case with the LEAST existing
    // protection, so it must never depend on hitting a periodic countdown.
    const dueForIdentityCheck =
      inFrameIds.length > 0 &&
      ((chains && shotsSinceIdentityReanchor >= config.identityReanchorInterval) || inFrameIds.length >= 2 || !chains);
    const isIdentityReanchor = dueForIdentityCheck && chains;

    // WHICH REFERENCE IMAGE IS WHOM. refUrls is built as inFrameIds.flatMap(id
    // => sheet[id]) — i.e. grouped by person, in inFrameIds order — but nothing
    // ever told the model that ordering explicitly. With 2+ named people, that
    // left "the people come from the other reference images" to be resolved by
    // guesswork, especially with a chained world reference ALSO in the mix that
    // may itself contain a face. Confirmed on camera: exactly this situation
    // (a 2-person shot, chained) is where a secondary character rendered as a
    // completely different, unrelated person.
    const identityOrderNote =
      inFrameIds.length >= 2
        ? (() => {
            // EXPLICIT NUMBERED RANGE PER PERSON, not just relative ordering — a
            // direct index ("photos 1-4 are X's") is a stronger, less ambiguous
            // anchor for the model than "X's set, then Y's set" alone, especially
            // once 3+ named people are in one shot and the group boundaries get
            // harder to track from prose alone.
            let offset = 1;
            const ranges = inFrameIds.map((id, i) => {
              const count = perCharacterRefLists[i]?.length ?? 0;
              const name = displayName(id);
              const label = count <= 1 ? `photo ${offset}` : `photos ${offset}-${offset + count - 1}`;
              offset += count;
              return `${label} = ${name}`;
            });
            return ` Among ONLY the named identity reference photos in this prompt (counting them 1, 2, 3... in ` +
              `the order they appear, and NOT counting any world/continuity reference photo): ${ranges.join("; ")}. ` +
              `Match each name in this scene to ITS OWN numbered range using the appearance description stated ` +
              `for that name — never by a face that happens to appear in a world/continuity reference image, ` +
              `even if one is visible there.`;
          })()
        : "";

    // See prevShotEndUnknown's own comment (declared with the other per-run
    // chain state, above). When true, prevLastUrl is really the previous
    // shot's OWN opening frame wearing a "final frame" label — distill what
    // that shot's own motion/description says happens, so the model is told
    // the truth and can extrapolate the background/props forward instead of
    // copying a moment that came BEFORE the previous shot's action played
    // out. Empty when there's nothing to distill (e.g. a static insert shot
    // with no motion text) — same "no false claim, no hollow instruction
    // either" standard the rest of this prompt already holds itself to.
    const prevEndDistilled =
      chains && prevShotEndUnknown && prevShotForHint ? distillEndState(prevShotForHint) : "";
    const endStateHint = prevEndDistilled
      ? ` NOTE: this reference image is the previous shot's OWN OPENING frame — its true ending look was ` +
        `never separately rendered. Before treating it as ground truth, first mentally advance it by what ` +
        `that shot's own action already did: ${prevEndDistilled} Depict the background, architecture, props, ` +
        `and lighting as they would look AFTER that has happened, not exactly as shown in the reference image.`
      : "";
    const chainClause = !chains
      ? ` ${headcount}${identityOrderNote}`
      : isIdentityReanchor
      ? // Reference order is FLIPPED for a re-anchor shot (see firstRefs below):
        // identity photos first, world/continuity references after. The text
        // has to describe that actual order, not the normal chained order.
        ` IDENTITY RE-ANCHOR — USE THE FIRST REFERENCE IMAGES FOR IDENTITY: they are ` +
        `${inFrameIds.map((id) => charById[id]?.name ?? id).join(" and ")}'s ORIGINAL identity reference ` +
        `photos. This scene has run several shots in a row — before continuing, deliberately re-compare ` +
        `against these ORIGINAL photos (not the previous shot's rendered frame) and correct any drift back ` +
        `to match them exactly, even if this shot's face ends up looking very slightly different from the ` +
        `shot right before it. These reference photos are the permanent ground truth for what each person ` +
        `looks like; the previous shot is not. The reference image(s) AFTER those are the previous shot's ` +
        `final frame${useAnchor ? " and this scene's establishing frame" : ""} — use them ONLY for the ` +
        `location, architecture, background details, props, lighting and time of day; do NOT take anyone's ` +
        `face from them.${endStateHint} ${headcount}${identityOrderNote} Background figures, if any, stay far in the ` +
        `distance, out of focus, and NEVER touch, overlap, merge with, or walk into the subject. Each ` +
        `background figure must be a distinct, invented stranger — never a copy of any named character's face ` +
        `from any reference image, including this one, unless that character is actually named as present.`
      : " CONTINUITY — USE THE FIRST REFERENCE FOR THE SETTING ONLY: it is the final frame of the " +
        "PREVIOUS shot. Copy its LOCATION, architecture, background details, props, lighting and time " +
        "of day exactly." +
        endStateHint +
        (useAnchor
          ? " A SECOND reference image right after it is the ESTABLISHING frame from EARLIER in this " +
            "SAME scene (not the previous shot — further back). Use it to confirm the fixed background, " +
            "architecture, and prop placement has not quietly drifted since the scene began; if it and " +
            "the previous-shot reference disagree on some background detail, trust this earlier " +
            "establishing frame as the ground truth for the ROOM ITSELF."
          : "") +
        " Do NOT copy the people out of either reference image — the people come from the other " +
        "reference images. " + headcount + identityOrderNote +
        " Background figures, if any, stay far in the distance, out of focus, and NEVER touch, overlap, " +
        "merge with, or walk into the subject. Each background figure must be a distinct, invented stranger " +
        "— never a copy of any named character's face from any reference image, including this one, unless " +
        "that character is actually named as present.";
    const firstRefs = (
      !chains
        ? refUrls
        : isIdentityReanchor
        ? [...refUrls, prevLastUrl!, ...(useAnchor ? [sceneAnchorUrl!] : [])]
        : [prevLastUrl!, ...(useAnchor ? [sceneAnchorUrl!] : []), ...refUrls]
      // propRefs/locationRef BEFORE productRefs — CONFIRMED REAL GAP, FIXED:
      // productText above tells the model "the LAST reference image(s) are
      // the exact product," which was only true when a shot had no tracked
      // props (the old order appended propRefs after productRefs, silently
      // making the product text's own positional claim false whenever both
      // were present). locationText makes no positional claim of its own
      // (same as propText), so locationRef slots in beside propRefs, still
      // ahead of productRefs.
    ).concat(propRefs, locationRef, productRefs);
    let firstUrl: string;
    const tBaseRender = Date.now();
    try {
      firstUrl = await renderKeyframeCounted(build(firstScene) + chainClause, firstRefs, keyframeAspect());
    } catch (e) {
      if (!isContentPolicyError(e)) throw e;
      // The provider refused this prompt on content grounds. ONE fallback on the
      // plainer `description` — the flagged wording is usually in the more literal
      // keyframe text. This produces a genuinely less explicit image, not a disguise,
      // and there is no second attempt: refused again, the run stops and names the
      // shot so the user can rewrite that beat.
      const canSoften = shot.description.trim() && shot.description !== firstScene;
      if (!canSoften) throw new ContentRefusedError(shot.id, "keyframe", firstScene);
      console.warn(`   ⚠️  ${shot.id}: keyframe prompt refused — retrying once with the plainer description.`);
      try {
        firstUrl = await renderKeyframeCounted(build(shot.description) + chainClause, firstRefs, keyframeAspect());
      } catch (e2) {
        if (!isContentPolicyError(e2)) throw e2;
        throw new ContentRefusedError(shot.id, "keyframe", firstScene);
      }
    }
    timeBaseRenderMs += since(tBaseRender);
    await downloadToFile(firstUrl, destA);

    // WHOLE-FILM IDENTITY AUDIT — see checkIdentityConsistency() in qa.ts.
    // Runs ONLY at the periodic re-anchor checkpoint above (the point where
    // we've just tried hardest to correct drift), to verify that correction
    // actually worked. Compares THIS keyframe directly against each named
    // character's ORIGINAL reference sheet — not the shot's own intent, and
    // not whatever the previous-shot chain has become. One retry, feeding
    // back the vision model's own stated reason for the mismatch; if it still
    // fails, keep the image and flag it for human review rather than looping
    // or blocking the render. Note: a retry regenerates the WHOLE keyframe
    // (there's no way to correct just one person's face in isolation), so on
    // a multi-character shot, fixing one person's drift could, in rare cases,
    // shift the other's rendering too — accepted as a real limitation of
    // whole-image regeneration, not something worth a second check pass over.
    // CONFIRMED-BAD FLAG — see the chain-containment logic below (#3). Set
    // true only when the identity audit fails EVEN AFTER the one retry above,
    // i.e. this keyframe is a known, uncorrected drift — never set from a
    // check we didn't run or one that got fixed.
    let confirmedBad = false;

    if (dueForIdentityCheck) {
      for (const id of inFrameIds) {
        const c = charById[id];
        if (!c) continue;
        const tIdentityCheck = Date.now();
        const check = await checkIdentity(c.name, sheet[id], firstUrl);
        timeIdentityCheckMs += since(tIdentityCheck);
        // QA-CALL RELIABILITY (world-state wiring audit, Finding B) — same
        // fix as 5-videos.ts's inspectClip() call: `unverified` means the
        // identity check itself failed after its own internal retries, not
        // that this keyframe was confirmed correct. Previously indistinguishable
        // from check.pass=true (a genuine match) — flagged visibly here so a
        // human reviewer can tell "confirmed fine" apart from "never actually
        // checked". Deliberately does NOT trigger the correction-retry path
        // below — that path is for a CONFIRMED drift, not an API failure, and
        // spending an image-generation call chasing an availability problem
        // wouldn't fix anything.
        if (check.unverified) {
          flag(shot.id, `${c.name}'s identity check could not be completed after retries (API/network error) — NEVER VERIFIED, not confirmed matching.`);
          continue;
        }
        if (check.pass) continue;
        console.warn(`   ⚠️  ${shot.id}: identity drift confirmed for ${c.name} — ${check.detail || "no longer matches the reference sheet"}. Retrying once.`);
        const correctionPrompt =
          `${build(firstScene)}${chainClause} IDENTITY CORRECTION: a review just found ${c.name}'s face in the ` +
          `previous attempt no longer matched their reference photos (${check.detail || "noticeable drift"}). ` +
          `Reproduce ${c.name}'s face EXACTLY as shown in their reference images this time — do not reinterpret it.`;
        try {
          const tCorrectionRender = Date.now();
          const corrected = await renderKeyframeCounted(correctionPrompt, firstRefs, keyframeAspect());
          timeIdentityCorrectionRenderMs += since(tCorrectionRender);
          const tRecheck = Date.now();
          const recheck = await checkIdentity(c.name, sheet[id], corrected);
          timeIdentityCheckMs += since(tRecheck);
          if (recheck.pass) {
            firstUrl = corrected;
            await downloadToFile(firstUrl, destA);
            console.log(`   ✓ ${shot.id}: identity correction succeeded for ${c.name}.`);
          } else {
            confirmedBad = true;
            flag(shot.id, `${c.name}'s face drifted from their reference photos (${check.detail || "noticeable drift"}) and a retry didn't fix it`);
            console.warn(`   ⚠️  ${shot.id}: identity drift for ${c.name} persisted after one retry — keeping this render, flagged for human review. It will NOT be used as the next shot's reference (see chain containment).`);
          }
        } catch (e) {
          if (!isContentPolicyError(e)) throw e;
          console.warn(`   ⚠️  ${shot.id}: identity-correction retry refused on content grounds — keeping the original render.`);
        }
      }
    }

    // ── PRIORITY 2: PRE-VIDEO-GENERATION KEYFRAME VALIDATION FILTER ────────
    // Runs for EVERY shot with a named character or a tracked prop (unlike
    // the periodic identity re-anchor audit just above) — a wrong headcount,
    // a swapped identity, or a missing tracked prop can happen on any shot,
    // not just drift-prone ones. Reuses runQA() (qa.ts) exactly as
    // 5-videos.ts's post-render QA already does — same findings
    // (extra_people, identity_swap, background_identity_bleed,
    // environment_changed), same CRITICAL_KINDS/withCorrection retry
    // machinery — just against this STATIC keyframe, before any paid video
    // generation call, instead of only ever catching these after the video
    // was already rendered and paid for. See checkKeyframe()'s own comment
    // (qa-runtime.ts) for why this needed no new detection logic at all,
    // only a new call site.
    if (inFrameIds.length > 0 || (shot.props ?? []).length > 0) {
      const keyframeCharacterRefs = inFrameIds
        .map((id) => ({ name: charById[id]?.name ?? id, url: sheet[id]?.[0] }))
        .filter((r): r is { name: string; url: string } => !!r.url);
      const keyframePropRefs = (shot.props ?? [])
        .map((id) => ({ name: propById[id]?.name ?? id, url: propSheet[id]?.[0] }))
        .filter((r): r is { name: string; url: string } => !!r.url);

      for (let attempt = 1; qaConfig.enabled; attempt++) {
        if (attempt === 1) keyframesChecked++;
        const tCompCheck = Date.now();
        const { pass, result, unverified } = await checkKeyframe(shot, firstUrl, keyframeCharacterRefs, keyframePropRefs);
        timeCompositionCheckMs += since(tCompCheck);
        if (unverified) {
          keyframesUnverified++;
          flag(shot.id, `Keyframe composition check could not be completed after retries (API/network error) — this keyframe was NEVER VERIFIED for headcount/composition before video generation.`);
          break;
        }
        if (pass || !result) break;
        if (attempt === 1) keyframesFailedFirstAttempt++;
        const critical = hasCriticalDefect(result);
        const criticalKinds = result.findings.filter((f) => CRITICAL_KINDS.has(f.kind)).map((f) => f.kind);
        const criticalLabel = criticalKinds.length ? ` — CRITICAL: ${[...new Set(criticalKinds)].join(", ")} persists` : "";
        const limit = critical ? qaConfig.criticalMaxRetries : qaConfig.maxRetries;
        if (attempt > limit) {
          // NEVER SEND A FAILED KEYFRAME INTO PAID VIDEO GENERATION, per this
          // priority's own explicit requirement — but this codebase's
          // consistent discipline elsewhere is graceful degradation over a
          // hard render failure for a QA-tier finding, never turning one
          // troublesome shot into "the whole film failed to render" (see
          // identity-check's own "keep, flag for human review" fallback just
          // above). Honored here as "retry hard against the real detection
          // infrastructure, then proceed with the least-bad attempt, flagged
          // with maximum visibility" rather than a hard failure — a
          // deliberate policy call, not a silent compromise; flagged loudly
          // enough that it cannot be mistaken for a clean pass.
          flag(
            shot.id,
            `Keyframe composition still failing after ${attempt - 1} regeneration attempt(s): ` +
            `${result.findings.map((f) => `${f.kind}(${f.severity.toFixed(2)})`).join(", ")}${criticalLabel} — ` +
            `proceeding to video generation with the least-bad attempt rather than blocking the whole render ` +
            `over one shot. Flagged for human review.`,
          );
          console.warn(`   ⚠️  ${shot.id}: keyframe composition still failing after ${attempt - 1} attempt(s)${criticalLabel} — proceeding, flagged.`);
          break;
        }
        console.warn(
          `   ⚠️  ${shot.id}: keyframe composition — ${result.findings.map((f) => `${f.kind}(${f.severity.toFixed(2)})`).join(", ")}` +
          ` — regenerating keyframe ${attempt}/${limit}${criticalLabel} BEFORE any paid video generation.`,
        );
        try {
          const retryPrompt = withCorrection(`${build(firstScene)}${chainClause}`, result);
          const tCompRetry = Date.now();
          firstUrl = await renderKeyframeCounted(retryPrompt, firstRefs, keyframeAspect());
          timeCompositionRetryRenderMs += since(tCompRetry);
          await downloadToFile(firstUrl, destA);
        } catch (e) {
          if (!isContentPolicyError(e)) throw e;
          console.warn(`   ⚠️  ${shot.id}: keyframe composition retry refused on content grounds — keeping the previous render.`);
          break;
        }
      }
    }

    let lastUrl: string | undefined;
    if (needsEnd) {
      try {
        // The second endpoint. This is what stops the model stalling: it cannot
        // hold a pose to burn frames when it knows exactly where it has to land.
        // ANCHOR THE END FRAME TO THE START FRAME, not just the character sheet.
        // Generated independently, the two endpoints are two DIFFERENT WORLDS and
        // the scene morphs mid-action. firstUrl goes FIRST: scene continuity
        // matters more here than another angle of his face.
        const endPrompt =
          `${build(shot.endFrame)} CONTINUITY: this is the SAME shot, moments later. The background, ` +
          `wall, lighting, camera position and framing are IDENTICAL to the first reference image. ` +
          `ONLY the subject's body position changes. ${headcount}${identityOrderNote} The people in the ` +
          `first reference image are the SAME people shown here, moved to a new position — never a second ` +
          `copy standing alongside, and never swapped for someone else.`;
        const tEndRender = Date.now();
        lastUrl = await renderKeyframeCounted(endPrompt, [firstUrl, ...refUrls, ...productRefs], keyframeAspect());
        timeEndFrameRenderMs += since(tEndRender);
        await downloadToFile(lastUrl, destB);

        // CONFIRMED REAL GAP, FIXED (both named characters drifting on the
        // LAST shot(s) of a film): the identity audit above (dueForIdentityCheck)
        // only ever checked firstUrl. This endpoint — the shot's actual FINAL,
        // fully-in-frame image, and per ENTRANCE_ENDPOINTS_AUTOFILLED (compiler.ts)
        // often the FIRST clearly-visible view of a re-entering character's face,
        // since their own startFrame is deliberately only "one shoulder, arm, and
        // leg... partially visible" — was never verified at all. Since lastUrl
        // becomes both the literal final frame the audience sees (5-videos.ts's
        // lastImageUrl) AND the next shot's own continuity reference (prevLastUrl
        // below), an uncaught drift here is exactly what reads as "changed in the
        // last shot" — and propagates forward into whatever follows. Mirrors
        // firstUrl's own check immediately above: one retry, confirmedBad + flag
        // (which already gates chain containment below) on a persisting failure,
        // never a hard block.
        if (dueForIdentityCheck) {
          for (const id of inFrameIds) {
            const c = charById[id];
            if (!c) continue;
            const tEndIdentityCheck = Date.now();
            const endCheck = await checkIdentity(c.name, sheet[id], lastUrl);
            timeIdentityCheckMs += since(tEndIdentityCheck);
            if (endCheck.unverified) {
              flag(shot.id, `${c.name}'s identity check on the END keyframe could not be completed after retries (API/network error) — NEVER VERIFIED, not confirmed matching.`);
              continue;
            }
            if (endCheck.pass) continue;
            console.warn(`   ⚠️  ${shot.id}: identity drift confirmed for ${c.name} on the END keyframe — ${endCheck.detail || "no longer matches the reference sheet"}. Retrying once.`);
            const endCorrectionPrompt =
              `${endPrompt} IDENTITY CORRECTION: a review just found ${c.name}'s face in the previous attempt ` +
              `no longer matched their reference photos (${endCheck.detail || "noticeable drift"}). Reproduce ` +
              `${c.name}'s face EXACTLY as shown in their reference images this time — do not reinterpret it.`;
            try {
              const tEndCorrectionRender = Date.now();
              const correctedEnd = await renderKeyframeCounted(
                endCorrectionPrompt,
                [firstUrl, ...refUrls, ...productRefs],
                keyframeAspect(),
              );
              timeIdentityCorrectionRenderMs += since(tEndCorrectionRender);
              const tEndRecheck = Date.now();
              const endRecheck = await checkIdentity(c.name, sheet[id], correctedEnd);
              timeIdentityCheckMs += since(tEndRecheck);
              if (endRecheck.pass) {
                lastUrl = correctedEnd;
                await downloadToFile(lastUrl, destB);
                console.log(`   ✓ ${shot.id}: identity correction succeeded for ${c.name} on the END keyframe.`);
              } else {
                confirmedBad = true;
                flag(shot.id, `${c.name}'s face drifted from their reference photos on the END keyframe (${endCheck.detail || "noticeable drift"}) and a retry didn't fix it`);
                console.warn(`   ⚠️  ${shot.id}: identity drift for ${c.name} on the END keyframe persisted after one retry — keeping this render, flagged for human review. It will NOT be used as the next shot's reference (see chain containment).`);
              }
            } catch (e) {
              if (!isContentPolicyError(e)) throw e;
              console.warn(`   ⚠️  ${shot.id}: identity-correction retry on the END keyframe refused on content grounds — keeping the original render.`);
            }
          }
        }
      } catch (e) {
        if (!isContentPolicyError(e)) throw e;
        // A refused END frame is not fatal: drop to a single endpoint and carry on.
        // 5-videos.ts tolerates method="flf" with no end keyframe.
        console.warn(`   ⚠️  ${shot.id}: END keyframe refused — rendering this beat from its start frame only. The film continues.`);
        lastUrl = undefined;
      }
    }

    done++; onProgress?.(done, total);
    const tags = [
      inFrameIds.length === 0 ? "empty" : inFrameIds.length >= 2 ? `${inFrameIds.length}-shot` : "solo",
      shot.crowd ? "crowd" : "",
      needsEnd ? "flf ×2" : "",
      chains ? "chained" : "",
      isIdentityReanchor ? "identity re-anchor" : dueForIdentityCheck ? "identity check" : "",
      confirmedBad ? "CONTAINED — not chained forward" : "",
      shot.offscreenSpeaker ? "reaction" : "",
    ].filter(Boolean).join(", ");
    console.log(`   ✓ ${shot.id} (${tags})`);

    pairs.push([shot.id, { first: firstUrl, last: lastUrl }] as const);

    // CHAIN CONTAINMENT (#3) — a shot confirmed bad by the identity audit
    // above still gets SAVED (never lose or block on a QA finding — same
    // philosophy as everywhere else in this pipeline), but it must not become
    // the next shot's world reference: chaining forward from a known-drifted
    // frame would just teach the NEXT shot to match the drift, not the
    // original character, spreading the mistake through the rest of the
    // scene instead of containing it to this one shot. So prevLastUrl simply
    // does NOT advance past a confirmed-bad shot — the next shot chains from
    // the same reference this one did, as if the bad shot were skipped for
    // chaining purposes (though its own file is still kept and used for its
    // own clip). Scene/cast bookkeeping (prevShotMeta/prevChars) still
    // advances normally; only the PIXEL reference is contained.
    if (!confirmedBad) {
      prevLastUrl = lastUrl ?? firstUrl;
      prevShotEndUnknown = !lastUrl;
      prevShotForHint = shot;
    } else {
      console.warn(`   ⚠️  ${shot.id}: this shot's frame will NOT be used as the next shot's continuity reference — the next shot chains from the same reference ${shot.id} itself used, skipping this one.`);
    }
    prevShotMeta = { scene: shot.scene, setting: shot.setting };
    prevChars = shot.characters;
    // A new scene run starts here — plant the anchor. Otherwise keep the existing
    // anchor: it stays the EARLIEST frame of this scene, on purpose, for every
    // shot in the run, rather than sliding forward like prevLastUrl does. If the
    // very FIRST shot of a new scene is itself confirmed bad, there is no better
    // alternative yet (no earlier frame in this scene to fall back to) — anchor
    // to it anyway, but the warning above already flags that this scene's
    // anchor is itself suspect.
    if (!anchorHolds) {
      sceneAnchorUrl = firstUrl;
      sceneAnchorMeta = { scene: shot.scene, setting: shot.setting };
    }
    // Reset after a checkpoint shot (identity was just audited, and on the Nano
    // Banana path pulled back to ground truth) or a new scene (chains=false
    // already means no world reference competed with identity this shot);
    // otherwise count this chained shot toward the next checkpoint. A
    // confirmed-bad shot does NOT reset the counter early — it wasn't a
    // successful correction, so the next shot is still "due" for one on the
    // same schedule it already was.
    shotsSinceIdentityReanchor = !chains || (dueForIdentityCheck && !confirmedBad) ? 0 : shotsSinceIdentityReanchor + 1;
  }
  }); // end scene run

  const images: ShotImages = Object.fromEntries(pairs);
  await writeJson(`${runtime.outDir}/images.json`, images);
  await writeJson(`${runtime.outDir}/identity-flags.json`, flags);
  await writeJson(`${runtime.outDir}/image-shots.json`, { nanoBananaImageCalls });
  // PRIORITY 2 — real evidence for whether the keyframe validation filter is
  // actually saving render spend: every one of keyframesFailedFirstAttempt
  // is a shot that would previously have gone straight to paid video
  // generation with a known-bad keyframe (wrong headcount, swapped
  // identity, missing tracked prop) and only been caught afterward.
  if (keyframesChecked > 0) {
    const failRate = (keyframesFailedFirstAttempt / keyframesChecked) * 100;
    console.log(
      `   🛡️  keyframe validation filter: ${keyframesChecked} checked, ${keyframesFailedFirstAttempt} failed on ` +
      `first attempt (${failRate.toFixed(1)}%) and were regenerated before video generation, ${keyframesUnverified} unverified.`,
    );
  }
  await writeJson(`${runtime.outDir}/keyframe-qa-stats.json`, { keyframesChecked, keyframesFailedFirstAttempt, keyframesUnverified });
  if (Object.keys(flags).length) {
    console.log(`   🚩 ${Object.keys(flags).length} shot(s) flagged for review: ${Object.keys(flags).join(", ")}`);
  }
  console.log(`✅ ${pairs.length} keyframe(s) ready.`);

  // ⏱ TEMPORARY TIMING INSTRUMENTATION — see the accumulator comment near the
  // top of this function. Safe to delete once the real keyframe-phase
  // bottleneck is found and fixed.
  const timeTotalMs = timeBaseRenderMs + timeIdentityCheckMs + timeIdentityCorrectionRenderMs + timeCompositionCheckMs + timeCompositionRetryRenderMs + timeEndFrameRenderMs;
  console.log(`⏱ KEYFRAME PHASE TIMING BREAKDOWN (${breakdown.shots.length} shots, sequential):`);
  console.log(`   base renders (first frame):      ${(timeBaseRenderMs / 1000).toFixed(1)}s`);
  console.log(`   end-frame renders (flf shots):    ${(timeEndFrameRenderMs / 1000).toFixed(1)}s`);
  console.log(`   identity checks (vision calls):   ${(timeIdentityCheckMs / 1000).toFixed(1)}s`);
  console.log(`   identity-correction re-renders:   ${(timeIdentityCorrectionRenderMs / 1000).toFixed(1)}s`);
  console.log(`   composition checks (vision calls):${(timeCompositionCheckMs / 1000).toFixed(1)}s`);
  console.log(`   composition-retry re-renders:     ${(timeCompositionRetryRenderMs / 1000).toFixed(1)}s`);
  console.log(`   SUM (tracked, not wall-clock — this step is sequential so sum ≈ wall-clock): ${(timeTotalMs / 1000 / 60).toFixed(2)} min`);

  return images;
}

if (isMain(import.meta.url)) {
  runImages().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}