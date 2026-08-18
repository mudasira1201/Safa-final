import { promises as fs } from "node:fs";
import { config, runtime } from "../config";
import { renderShot } from "../providers/video";
import { readJson, readJsonOr, writeJson, downloadToFile, fileExists, isMain, muxReplaceAudio } from "../util";
import { synthesizeSpeech } from "../providers/tts";
import { applyLipSync } from "../providers/lipsync";
import { uploadFile } from "../storage";
import { mapLimit, CONCURRENCY } from "../concurrency";
import type { Breakdown, Character, CharacterRefs, Shot, Prop, PropRefs, LocationRefs } from "../types";
import type { ShotImages } from "./4-images";
import { sameScene } from "./4-images";
import { inspectClip, qaConfig } from "../providers/qa-runtime";
import { withCorrection, hasCriticalDefect, CRITICAL_KINDS } from "../providers/qa";
import { isContentPolicyError } from "../providers/image";
import { ContentRefusedError } from "../lib/refusal";
import { JobCancelledError } from "../lib/cancel";
import { isTranslated, languageName, languageNative } from "../lib/languages";
import { costOfClip, costOfUpscale, BudgetCapExceededError } from "../spend";
import { upscaleVideo } from "../providers/upscale";

export type ClipList = string[];
function seedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2147483647;
}
const CLOSEUP_RE = /\b(close[- ]?up|tight (?:on|shot)|extreme close|face fills|CU\b|ecu\b)/i;
// Expanded for CAMERA_MOVE_LIBRARY.json's richer named-move vocabulary
// (compiler.ts) -- a shot enriched with e.g. "whip pan" or "jib up" must
// still correctly compute as NOT static below. Deliberately excludes moves
// that are NOT actual camera motion (turntable/timelapse hold the camera
// fixed by definition; dutch_angle/static_glam/rack_focus/fisheye are
// framing/lens/focus choices, not movement) -- adding those would wrongly
// flip camera_fixed for a shot that's supposed to stay locked off.
const CAMERA_MOVE_RE = /\b(track|dolly|push|pull|pan|tilt|crane|jib|handheld|follow|orbit|arc|steadicam|zoom|whip|crash|sweep|rise|fpv|drone|hyperlapse|snorricam)\b/i;
// Priority 8 — the specific, confirmed-real background-instability risk
// pattern: a subject moving substantially TOWARD or AWAY FROM a camera that
// was never stated to move. Deliberately narrow (not "no camera-movement
// words -> assume fixed" generally) — see its two use sites below.
const APPROACHES_CAMERA_RE =
  /\b(toward(?:s)?\s+(?:the\s+)?camera|approaches?\s+the\s+camera|runs?\s+(?:toward|at|straight at)\s+(?:the\s+)?camera|charges?\s+toward\s+(?:the\s+)?camera|sprints?\s+toward\s+(?:the\s+)?camera)\b/i;
// Priority 10 — accessories (glasses especially) confirmed appearing/
// disappearing between shots with nothing describing them being removed.
// Pulled out of each present character's own authored `appearance` text so
// the identity-lock reinforcement below names the SPECIFIC accessory this
// character actually has, not a generic reminder.
//
// CONFIRMED REAL GAP: this list had no helmet/armor/military-gear terms at
// all, so a character like Commander Thane ("armor dented, cloak torn")
// never got his gear reinforced shot to shot the way glasses/hats already
// were — armor pieces, cloak, and combat gear were free to silently drift
// or vanish between cuts.
const ACCESSORY_RE =
  /\b(glasses|eyeglasses|spectacles|sunglasses|[a-z-]*\s?hat|cap|beanie|turban|hijab|earrings?|necklace|bracelet|ring|wristwatch|watch|beard|mustache|moustache|nose\s?ring|piercing|scar|helmets?|armou?r|breastplates?|chainmail|gauntlets?|pauldrons?|(?:body|tactical|flak)\s?vests?|holsters?|cloaks?|capes?|masks?|visors?|bandoliers?|epaulettes?|sashes?|headbands?|backpacks?|satchels?|badges?|medals?|insignia)\b/gi;
function accessoryPhrase(appearance: string | undefined): string {
  if (!appearance) return "";
  const found = [...new Set([...appearance.matchAll(ACCESSORY_RE)].map((m) => m[0].trim().toLowerCase()))];
  return found.join(", ");
}

export async function runVideos(
  // AWAITABLE, NOT FIRE-AND-FORGET — see both call sites below. A cache-hit
  // shot (fileExists(dest) true — the common case on a re-run, since
  // restoreCachedArtifacts() already re-downloaded most/all clips into
  // outDir before this loop starts) resolves near-instantly, so mapLimit's
  // CONCURRENCY-many workers race through the cached shots far faster than
  // real generation ever would. If onProgress fired-and-forgot (the old
  // signature), each of those near-instant resolutions kicked off an
  // unawaited setJob() DB write with NOTHING bounding how many could be in
  // flight at once — CONFIRMED REAL, LIVE FAILURE (2026-08-13): on an
  // 86-shot film with 85 cached clips, that produced a burst of ~85
  // concurrent writes competing for Prisma's connection pool (limit 17),
  // which starved the ONE call in this same loop that's actually awaited —
  // isCancelled()'s prisma.job.findUnique() — until it timed out waiting
  // for a free connection. Every failed render_clips attempt on that
  // project died there, always late (69-95% through), always the same
  // "Timed out fetching a new connection from the connection pool" error.
  // Awaiting onProgress here caps concurrent progress writes at the same
  // CONCURRENCY the rest of this loop already respects, instead of letting
  // the cache-hit fast path bypass it entirely.
  onProgress?: (done: number, total: number) => void | Promise<void>,
  // BANK EACH CLIP THE MOMENT IT FINISHES, not after the whole batch. Without this,
  // a crash (a dropped DB connection, a killed process, an OOM) partway through an
  // 18-clip render loses every clip rendered so far: they sit as local files, but
  // handleShots() in worker.ts calls rmrf(runtime.outDir) on every retry BEFORE it has
  // a chance to upload them, and restoreCachedArtifacts() can only pull back clips
  // that were already uploaded. This callback lets the caller (the worker) upload and
  // persist a clip to durable storage as soon as it exists locally, so a crash after
  // clip 12 of 18 means the retry redoes 6 clips, not 18. Only called for a FRESHLY
  // rendered clip — a cache-hit clip was already banked by whichever earlier run
  // produced it, so re-notifying here would just create a duplicate artifact record.
  //
  // costUsd: THIS SHOT'S real cost (base render + every QA re-roll, at whichever
  // rate its tier billed at) — see the caller's own comment (worker.ts) for why
  // this must be logged and cap-checked the moment it's known, not batched until
  // the whole render finishes. Confirmed real failure: a stuck/slow render spent
  // real money for over an hour with ZERO of it visible to our own Spend table or
  // checkCaps(), because the old batched logSpend("clip", ...) call only ever ran
  // after runVideos() returned in full.
  onClipDone?: (shot: Shot, localPath: string, costUsd: number) => void | Promise<void>,
  // Same contract as 4-images.ts's runImages() — checked once per shot, only
  // before real paid work (never in place of the cache hit below), throws
  // JobCancelledError. Clips already bank the instant they finish (onClipDone
  // above), so a cancellation here loses nothing already rendered — the
  // in-flight renders under this call's concurrency limit finish and bank
  // normally; only shots that hadn't started yet are skipped.
  isCancelled?: () => Promise<boolean>,
): Promise<ClipList> {
  const breakdown = await readJson<Breakdown>(`${runtime.outDir}/breakdown.json`);
  const images = await readJson<ShotImages>(`${runtime.outDir}/images.json`);
  // LOCATION REFERENCE FOR QA (Priority 7) — reuses 4-images.ts's own SCENE
  // ANCHOR concept (that step's `sceneAnchorUrl`: the run's own earliest
  // keyframe, already fed forward there to fight background/landmark drift
  // across a scene) as a canonical "this location's fixed appearance" photo
  // for QA's environment_changed check — mirroring characterRefs/propRefs.
  // No new generation step needed: this keyframe already exists in
  // images.json by the time this step runs; the only real gap was that QA
  // never received it. Recomputed here (not read back from 4-images.ts,
  // which doesn't persist its own anchor choice anywhere) using the exact
  // same "holds while sameScene(), resets otherwise" rule that function
  // uses, so the shot picked as each run's anchor matches what 4-images.ts
  // itself actually anchored to.
  const sceneAnchorForShot: Record<string, string> = {};
  {
    let anchorUrl: string | undefined;
    let anchorMeta: { scene?: string; setting?: string } | null = null;
    for (const s of breakdown.shots) {
      const holds = !!anchorUrl && !!anchorMeta && sameScene(s, anchorMeta);
      if (!holds) {
        anchorUrl = images[s.id]?.first;
        anchorMeta = { scene: s.scene, setting: s.setting };
      }
      if (anchorUrl) sceneAnchorForShot[s.id] = anchorUrl;
    }
  }
  const charById: Record<string, Character> = Object.fromEntries(breakdown.characters.map((c) => [c.id, c]));
  // PRIORITY 3 — CONFIRMED REAL GAP: characterSceneStates (per-character,
  // per-scene objective + emotional state, populated by the breakdown LLM —
  // see llm.ts's own prompt and types.ts's CharacterSceneStateSchema) was
  // captured into every breakdown.json but never actually READ anywhere in
  // the real pipeline — not here, not in compiler.ts, not in qa.ts — despite
  // the system prompt itself claiming it's "a machine-readable fact the
  // render pipeline checks a shot's actual performance against." That claim
  // was false; this is the fix. There is no separate TTS/voice-generation
  // step in this pipeline at all (confirmed: dialogue audio comes entirely
  // from Seedance's native generate_audio, driven by this SAME text prompt
  // that also drives the visuals) — so "direct the voice" here means
  // strengthening the actual render prompt's emotional-delivery instruction
  // with this structured fact, not calling a separate voice API that
  // doesn't exist. Keyed on BOTH the raw sceneKey (llm.ts instructs the
  // scene-state pass to use "the exact scene value") and a normalized form
  // (matching compiler.ts's own sceneKey() trim/lowercase/60-char-slice
  // convention) as a resilience fallback, since an LLM matching two
  // separately-generated fields exactly is not fully reliable.
  const normalizeSceneKey = (s: string) => (s || "").trim().toLowerCase().slice(0, 60);
  const sceneStateByCharAndScene = new Map<string, { objective: string; emotionalStateEntering: string; emotionalStateExiting: string | null }>();
  for (const st of breakdown.characterSceneStates ?? []) {
    sceneStateByCharAndScene.set(`${st.characterId}::${st.sceneKey}`, st);
    sceneStateByCharAndScene.set(`${st.characterId}::${normalizeSceneKey(st.sceneKey)}`, st);
  }
  // characters.json's angle-0 slot is the literal casting photo (see 3-sheet.ts) — the SAME reference
  // used to anchor every keyframe. Fed into inspectClip() below so identity_drift is judged against
  // that ground truth, not just this clip's own (possibly already-drifted) keyframe. readJsonOr, not
  // readJson: a product-only ad-mode render can have no character sheet at all.
  const sheet = await readJsonOr<CharacterRefs>(`${runtime.outDir}/characters.json`, {});
  // Gap A — same reasoning as the character sheet just above, for tracked
  // props (see 3b-props.ts). readJsonOr: most films have no props.json at
  // all (zero tracked props, or compiled before this feature existed).
  const propSheet = await readJsonOr<PropRefs>(`${runtime.outDir}/props.json`, {});
  const propById: Record<string, Prop> = Object.fromEntries((breakdown.props ?? []).map((p) => [p.id, p]));
  // Location reference sheets (3c-locations.ts) — the durable, REVISIT-aware
  // counterpart to sceneAnchorForShot above. sceneAnchorForShot only holds
  // within one contiguous same-scene run and resets the moment the scene
  // changes, so on a REVISIT (the exact case a location sheet exists for)
  // QA's environment_changed was still judging drift against the wrong
  // contiguous run's own anchor instead of the location's true, persistent
  // reference. readJsonOr: only a genuinely revisited location gets an entry
  // at all, and a breakdown compiled before this feature existed has no
  // locations.json.
  const locationSheet = await readJsonOr<LocationRefs>(`${runtime.outDir}/locations.json`, {});

  // SPOKEN LANGUAGE. All audio in this pipeline is the video model's own native
  // generate_audio — there is no TTS stage and fal's Seedance schema exposes no
  // separate dialogue track, and no language/locale parameter of any kind
  // (confirmed by reading providers/video.ts's real request body: prompt,
  // generate_audio, image URLs, duration, resolution, camera_fixed, seed —
  // nothing else). So prompt text is not just the best lever, it is the ONLY
  // one that exists.
  //
  // CONFIRMED REAL FAILURE (2026-08-15): a quiet, mid-sentence " in Hindi"
  // suffix — buried after "speaks the line" in an already dense, multi-clause
  // prompt — was not enough. A real Hindi render came back with the dialogue
  // spoken in ENGLISH despite shot.dialogue itself being correct, real Hindi
  // text (confirmed in breakdown.json) and despite everything else in the
  // clip — motion, camera, identity — rendering correctly. The model was
  // reading the Devanagari text as content but not reliably treating "in
  // Hindi" as an instruction to actually PERFORM it in that language rather
  // than default to English.
  //
  // languageDirective below is deliberately louder and redundant where the
  // old spokenIn suffix was quiet and singular: stated as its own emphatic
  // sentence (not a trailing clause), names the language BOTH in English and
  // in its own native script/endonym (languageNative() — a model that
  // doesn't treat the English word "Hindi" as a real constraint may still
  // recognise "हिन्दी" itself as a stronger signal, and the two cost nothing
  // to say together), and states the failure mode as an explicit negative
  // ("NEVER in English") — the same "name the specific wrong behavior
  // already observed" discipline this file already uses everywhere else
  // (IDENTITY_LOCK, CAST LOCK, BACKGROUND LOCK, etc.), now applied to the one
  // dimension none of those covers. Repeated at both dialogue call sites
  // below (offscreen + on-screen) rather than said once, for the same
  // "redundant emphasis beats a single quiet mention" reasoning the accessory
  // and identity-lock text elsewhere in this file already relies on. Empty
  // string for an English film, so its prompt is completely unchanged.
  const languageDirective = isTranslated(breakdown.language)
    ? ` CRITICAL — SPOKEN LANGUAGE: every word of spoken dialogue in this clip is performed OUT LOUD in ${languageName(breakdown.language).toUpperCase()} (${languageNative(breakdown.language)}) — real ${languageName(breakdown.language)} pronunciation and mouth shapes for the exact ${languageName(breakdown.language)} words given below, NEVER in English and NEVER translated back into English or any other language, no matter what language the rest of this instruction is written in.`
    : "";
  // Kept for the shorter inline mention inside each dialogue clause below —
  // redundant with languageDirective above on purpose (see its own comment).
  const spokenIn = isTranslated(breakdown.language) ? ` in ${languageName(breakdown.language)} (${languageNative(breakdown.language)})` : "";

  console.log(`🎬 Rendering clips @ ${config.videoResolution} (up to ${CONCURRENCY} at once)...`);

  // EXACT BASE SECONDS — worker.ts used to sum EVERY shot's clamped duration
  // straight from the breakdown, with no idea which shots were cache hits.
  // That's the same class of bug the image-cost tracking had (see 4-images.ts's
  // renderKeyframeCounted): a crash-retry with every clip restored from cache
  // made zero real renderShot() calls, yet still got billed for the WHOLE
  // film's seconds again. Tracked here, incremented only when a real render
  // actually happens (never for a cache hit), so a fully-cached retry now
  // correctly costs nothing.
  let baseRenderedSeconds = 0;

  // COST TRACKING GAP: every QA re-roll is a FULL second render at the same
  // duration as the original — real money, billed by the provider — but worker.ts's
  // renderedSeconds sum only ever counted each shot's listed duration ONCE, from the
  // breakdown, with no idea a retry ever happened. That undercounts logSpend (and
  // therefore checkCaps' daily/monthly budget enforcement) by exactly the retried
  // seconds, every time QA re-rolls a shot. Tracked here and written out so the worker
  // can add it to the real total instead of silently eating the gap.
  let extraRerollSeconds = 0;

  // FLAGGED SHOTS — see #4 in the long-form consistency plan: a shot that
  // still fails QA after its retry budget is exhausted gets kept (never lose
  // work over a flagged defect) but recorded here with WHY, written out for
  // worker.ts to attach to clipsJson so the review screen can point straight
  // at the handful that need attention instead of this only reaching a
  // console log nobody re-reads once the render finishes.
  const flags: Record<string, string[]> = {};
  const flag = (shotId: string, reason: string) => {
    (flags[shotId] ??= []).push(reason);
  };

  const total = breakdown.shots.length;
  let done = 0;

  // ⏱ TEMPORARY TIMING INSTRUMENTATION — see the matching summary printed
  // after mapLimit() below. Shots render CONCURRENTLY here (unlike
  // 4-images.ts's sequential pass), so these sums are TOTAL compute time
  // across all shots, not wall-clock — useful for seeing the relative WEIGHT
  // of each phase (e.g. "QA re-rolls are 40% of all render time") even though
  // they don't add up to the actual duration of this step. Pure measurement,
  // zero behavior change — safe to delete once the real bottleneck is found.
  let timeBaseRenderMs = 0;
  let timeQaCheckMs = 0;
  let timeRerollRenderMs = 0;
  let timeUpscaleMs = 0;
  const since = (t0: number) => Date.now() - t0;
  const stepStartedAt = Date.now();

  const clips = await mapLimit(breakdown.shots, CONCURRENCY, async (shot, i) => {
    const dest = `${runtime.outDir}/clips/${String(i + 1).padStart(2, "0")}-${shot.id}.mp4`;

    if (await fileExists(dest)) {
      console.log(`   ↻ clip ${i + 1} (${shot.id}, cached)`);
      done++; await onProgress?.(done, total);
      return dest;
    }

    if (isCancelled && (await isCancelled())) throw new JobCancelledError();

    const img = images[shot.id];
    if (!img?.first) throw new Error(`No keyframe for ${shot.id}. Run step 4 first.`);
    // No longer fatal: step 4 degrades a refused end frame to a single endpoint.
    if (shot.method === "flf" && !img.last) {
      console.warn(`   ⚠️  ${shot.id}: no end keyframe — rendering from the start frame only.`);
    }

    // ── DURATION ────────────────────────────────────────────────────────────
    // compileBreakdown() already picked the right duration for THIS shot; this
    // is a safety backstop against a corrupted value, not a second opinion.
    // UPDATED for the Seedance revert: Seedance accepts 4/6/8/10/12s uniformly
    // for both i2v and end-framed shots (video.ts snaps to the nearest of
    // those) — unlike Veo, there's no separate, tighter i2v-only enum and no
    // flf-locked-to-exactly-8s quirk, so the two methods no longer need
    // different caps here.
    const want = shot.duration > 0 ? Math.round(shot.duration) : config.shotDuration;
    const seconds = Math.min(Math.max(want, 4), config.maxDuration);

    // ── PROMPT ──────────────────────────────────────────────────────────────
    const crowdText = shot.crowd
      ? " Background: many people moving naturally at correct human scale, out of focus, none of them approaching or facing the subject. SFX: distant ambient crowd murmur and footsteps, low in the mix."
      : "";

    // AMBIENCE — see compiler.ts's ambienceFor()/shot.ambience. Complementary
    // to crowdText above, not a replacement for it: crowdText is PEOPLE noise
    // specific to a crowd scene, this is the ENVIRONMENT's own sound (rain,
    // wind, room tone, fire, traffic) and applies to every shot, crowd or
    // not — a shot with no explicit ambience match still gets the library's
    // neutral room-tone fallback, never silence by default.
    const ambienceText = shot.ambience ? ` AMBIENCE: ${shot.ambience}` : "";

    // IDENTITY LOCK FOR THE VIDEO PROMPT — CONFIRMED GAP, NOT A HYPOTHETICAL.
    // 4-images.ts builds an explicit IDENTITY_LOCK/CLOSEUP_LOCK clause into every
    // KEYFRAME prompt, but the VIDEO prompt built here (motionPrompt) had NO
    // identity-consistency instruction at all — it told the model the scene,
    // the action, and the camera, and left "does this face stay the same face
    // for the full clip" entirely to the keyframe image's own conditioning
    // strength, with zero textual reinforcement. Priority-2 investigation
    // (real render evidence: a face changing twice within one clip's own few
    // seconds) found this gap directly by reading this file — the keyframe can
    // be perfectly correct and the video model can still let a face drift
    // across the clip's duration with nothing in the prompt telling it not to.
    // Applied to every render, not just retries — this is a baseline fix, not
    // only a retry-time correction (see the escalated version inside the QA
    // retry loop below for identity-critical re-rolls specifically).
    const presentNames = shot.characters.map((id) => charById[id]?.name).filter((n): n is string => !!n);
    // Priority 10 — accessories are part of IDENTITY, not changeable wardrobe
    // (see qa.ts's identity_drift definition, extended the same way this
    // session). Confirmed real: a character's glasses appeared in some shots
    // and were simply absent in others. Named per-character, only when their
    // own appearance text actually mentions one — never invented.
    const accessoryClause = shot.characters
      .map((id) => {
        const c = charById[id];
        const acc = c ? accessoryPhrase(c.appearance) : "";
        return acc ? `${c!.name} must keep wearing/showing their ${acc} in every frame` : "";
      })
      .filter(Boolean)
      .join("; ");
    const identityLockText = presentNames.length
      ? ` IDENTITY LOCK: ${presentNames.join(" and ")} must be the EXACT SAME person — same face shape, eyes, ` +
        `nose, jawline, skin tone, and hair — in every single frame of this clip, from the very first frame to ` +
        `the very last, with zero drift at any point during the motion. The face established in the starting ` +
        `image is the ONLY correct face for this entire clip.` +
        (accessoryClause ? ` ACCESSORIES ARE PART OF IDENTITY, NOT OPTIONAL WARDROBE: ${accessoryClause} — ` +
          `never omitted, added, or changed partway through the clip.` : ``)
      : "";

    // CAST LOCK FOR THE VIDEO PROMPT — CONFIRMED REAL GAP, same shape as
    // identityLockText above: 4-images.ts's keyframe prompt gets an explicit,
    // dedicated "exactly N people, none duplicated" clause, but motionPrompt
    // here never did — the only anti-duplication instruction reaching the
    // VIDEO model was whatever sentence happened to survive inside
    // shot.description's own long paragraph, with none of the standalone
    // prominence IDENTITY LOCK/BACKGROUND LOCK/CONTINUOUS TAKE get. extra_people
    // is confirmed (QaEvent history, 2026-08-09 audit) the single most
    // frequently recurring CRITICAL QA finding across real renders, including
    // shots that failed on it identically across every retry attempt — this
    // doesn't guarantee eliminating it (video generation keeps its own
    // stochastic ceiling no prompt text fully closes), but it gives this
    // specific, dominant failure mode the same dedicated treatment that
    // already works for identity and background. Skipped for a crowd shot —
    // crowdText already explicitly allows background people there, and this
    // clause's own wording would directly contradict it.
    const castCountText = presentNames.length && !shot.crowd
      ? ` CAST LOCK: ${presentNames.join(" and ")} appear${presentNames.length === 1 ? "s" : ""} EXACTLY ONCE ` +
        `each in this clip, in every single frame from first to last — never duplicated, cloned, doubled, or ` +
        `shown twice at the same time anywhere in frame, even briefly, even partially, even in the background. ` +
        `No other person appears anywhere in this clip, foreground or background, however brief or out of focus.`
      : "";

    // BACKGROUND STABILITY FOR A STATIC-CAMERA APPROACH SHOT — Priority 8,
    // confirmed real: background buildings visibly slid/shifted backward
    // while a character ran TOWARD a camera that was never meant to move at
    // all — a static-element rendering-stability failure, distinct from
    // Gap G's character pop-in (that was about the SUBJECT's own entrance;
    // this is about everything BEHIND them staying put). Narrowly scoped to
    // the confirmed-risk pattern (substantial toward/away-from-camera
    // subject motion with no camera movement stated) rather than assuming
    // every wordless-camera shot is meant to be locked off — see cameraFixed
    // below for the matching API-level lever (Seedance's real, confirmed
    // camera_fixed field), applied together with this text reinforcement.
    const staticCameraCandidate =
      !CAMERA_MOVE_RE.test(shot.camera || "") && APPROACHES_CAMERA_RE.test(`${shot.motion} ${shot.description}`);
    const backgroundStabilityText = staticCameraCandidate
      ? ` BACKGROUND LOCK: the camera position is completely static and does not move, pan, drift, or track at ` +
        `all — every fixed background element (buildings, walls, architecture, parked objects, the horizon) ` +
        `stays perfectly still and in the exact same position in frame for the ENTIRE clip. Only the subject ` +
        `moves; the world behind them does not shift, slide, warp, or drift even slightly as they approach.`
      : "";

    // ONE CONTINUOUS TAKE, NEVER AN INTERNAL CUT — Track B4 (real render:
    // "The Package"), confirmed real: a single generated clip visibly
    // contained what read as TWO stitched-together shots — a head position
    // snapping from one side of frame to the other with no motion in
    // between, TWICE in the same clip. This is a request Seedance treats as
    // one video generation call, but nothing in the prompt told it that
    // explicitly; without it, the model is free to interpret the shot as a
    // sequence of distinct beats and render a hard cut between them instead
    // of one unbroken take. Applied to EVERY render (not conditional) — the
    // instruction costs nothing to include and the failure mode has no
    // narrower trigger pattern worth gating on.
    const continuousTakeText =
      ` ONE CONTINUOUS, UNBROKEN TAKE: this entire clip is a SINGLE continuous shot, filmed in one unbroken take — ` +
      `there is NO internal edit, NO cut, NO scene change, and NO camera or subject position jumping partway ` +
      `through. Any change in head position, body position, or camera angle must happen as smooth, continuous ` +
      `motion the viewer can actually see happening — never as a sudden jump from one position directly to a ` +
      `different one with nothing in between, which reads as two separate shots spliced together.`;

    // CLOSED-SET CONSTRAINT — same fix, same reasoning, as 4-images.ts's own
    // (a real render put a door mid-footpath and a staircase inside a throne
    // room, neither ever described): applied here too since the invented
    // object can appear or be interacted with during MOTION, not just sit in
    // a still keyframe.
    const closedSetText = shot.setting
      ? " Render ONLY the location and objects described in this setting — do not add a door, window, " +
        "staircase, furniture, device, or any other object or architectural feature that isn't explicitly " +
        "mentioned here."
      : "";

    // CONFIRMED REAL GAP, FIXED (action loops/reverses on camera: lifts the
    // object, puts it back, lifts it again) — the blanket "never freezes or
    // holds a pose" sentence below is unconditional for every shot, but
    // compiler.ts's R7.6c ACTION_DURATION_EXCESS_LIBRARY autofix can append
    // its OWN, opposite instruction to shot.motion ("HOLD AFTER COMPLETING:
    // ... hold that exact completed position") for a shot whose action
    // finishes well before the render floor's forced minimum duration runs
    // out. Sending BOTH sentences to the model — hold the pose, and also
    // never hold a pose — is exactly the kind of contradiction this
    // pipeline's own prompts elsewhere go out of their way to avoid; when
    // that marker is present, this general sentence is dropped so the
    // shot-specific hold instruction isn't immediately undercut by the
    // generic one appended after it.
    const holdsAfterCompleting = shot.motion.includes("HOLD AFTER COMPLETING:");
    let motionPrompt =
      `${shot.description}. ` +
      (shot.setting ? `Setting: ${shot.setting}. ` : "") +
      closedSetText +
      `Action: ${shot.motion || "the character moves naturally with clear, visible body movement"}. ` +
      `Camera: ${shot.camera || "cinematic, well-composed shot"}.` +
      crowdText +
      ambienceText +
      identityLockText +
      castCountText +
      backgroundStabilityText +
      continuousTakeText +
      (holdsAfterCompleting
        ? ""
        : ` Clearly visible, continuous motion throughout — the subject never freezes or holds a pose.`);

    // ── DIALOGUE ────────────────────────────────────────────────────────────
    // The old code did this unconditionally:
    //
    //   motionPrompt += ` ${speakerName} speaks the line: "${shot.dialogue}"
    //                     - mouth clearly moving in sync`
    //
    // For the earpiece beat, speakerName was the VOICE. So you explicitly asked
    // the video model to animate a mouth, in sync, for a character who has no
    // body. That was the fourth and final layer that built the phantom man.
    const speakerOnScreen =
      !!shot.speaker && !shot.offscreenSpeaker && shot.characters.includes(shot.speaker);

    if (shot.dialogue?.trim()) {
      if (shot.offscreenSpeaker) {
        // 6-assemble.ts has NO audio stage — it just concats clips. All dialogue comes
        // from the video model's native audio (generate_audio). So if we don't name the line here, the earpiece
        // beat renders SILENT and the VOICE is simply lost from the film.
        //
        // Naming the voice is safe now in a way it was not before: the keyframe already
        // locks this shot to one man, and image-to-video cannot easily add a person who
        // is not in the start frame. The keyframe is the strongest constraint we have.
        motionPrompt +=
          languageDirective +
          ` AUDIO: a voice comes through his earpiece — urgent, compressed, radio-quality —` +
          ` saying${spokenIn} "${shot.dialogue}". It is NOT spoken by anyone on camera.` +
          ` The subject LISTENS: mouth CLOSED, jaw tightening, eyes narrowing.` +
          ` NOBODY is speaking to him on camera. There is NO second person in frame.`;
      } else if (speakerOnScreen) {
        const name = charById[shot.speaker!].name;
        // PRIORITY 3 — the ONE lever this pipeline actually has for directing
        // per-line delivery (see the sceneStateByCharAndScene comment above):
        // fold the structured, already-built emotional state directly into
        // the SAME prompt that drives Seedance's native audio, instead of a
        // generic "expression matching the emotion" with nothing concrete
        // behind it. Falls back to the existing generic phrasing when no
        // scene-state entry matches (old data, or a domain/ad-mode render
        // with no characterSceneStates at all) — never a regression from
        // today's baseline.
        const psychState = sceneStateByCharAndScene.get(`${shot.speaker}::${shot.scene}`)
          ?? sceneStateByCharAndScene.get(`${shot.speaker}::${normalizeSceneKey(shot.scene || "")}`);
        const emotionDirective = psychState?.emotionalStateEntering
          ? ` Deliver this line as someone who is, right now, ${psychState.emotionalStateEntering}${psychState.objective ? ` and wants ${psychState.objective}` : ""} — let that drive the actual DELIVERY of the line (pace, breath, tone, where the voice catches or hardens), not just the face.`
          : "";
        motionPrompt +=
          languageDirective +
          ` ${name} speaks the line${spokenIn}: "${shot.dialogue}" — the exact ${isTranslated(breakdown.language) ? languageName(breakdown.language) : "English"} words above, mouth clearly moving in sync with them, expression matching the emotion.` +
          emotionDirective;
      }
    }

    const baseSeed = seedFromId(shot.id);
    const closeUp = CLOSEUP_RE.test(shot.camera || "") || CLOSEUP_RE.test(shot.description || "");
    // Priority 8 — Seedance's real camera_fixed field (confirmed present in
    // video.ts's actual request object during the Priority-2 investigation)
    // was previously ONLY ever set true for close-ups, an arbitrary scope
    // that had nothing to do with why a locked camera actually helps: it
    // stabilizes the WHOLE frame's background against drift, which matters
    // most for exactly the shot type the real defect hit — a wide/medium
    // shot of a subject moving substantially toward/away from a camera that
    // was never meant to move. staticCameraCandidate (built above, feeding
    // backgroundStabilityText) is the SAME confirmed-risk signal reused here
    // for the API-level lever, not just the text-level one.
    // IDENTITY-CRITICAL STATIC CANDIDATE — same "lock the camera when
    // nothing asked it to move" safety condition as staticCameraCandidate
    // above, extended to the OTHER place identity drift shows up worst in
    // practice: a shot with 2+ named on-screen characters, or one carrying
    // dialogue. Camera-driven micro-motion (the thing camera_fixed exists to
    // suppress) destabilizes MORE faces at once in a multi-character shot,
    // and a viewer's eye is fixed on exactly the thing most sensitive to it
    // — a face mid-line — during dialogue. Previously camera_fixed's scope
    // was close-ups and substantial toward/away-from-camera motion only;
    // this was a real gap, not a hypothetical — a static two-person
    // conversation, camera never stated to move, got no stabilization at
    // all under the old conditions. Same guard as everywhere else in this
    // function: only forces static when the shot's OWN camera direction
    // never asked for movement in the first place, never overriding an
    // actually-intended pan/track/dolly.
    const identityCriticalCandidate =
      !CAMERA_MOVE_RE.test(shot.camera || "") && (shot.characters.length >= 2 || !!shot.dialogue?.trim());
    const cameraFixed = (closeUp && !CAMERA_MOVE_RE.test(shot.camera || "")) || staticCameraCandidate || identityCriticalCandidate;

    const renderOnce = (prompt: string, seed: number) =>
      renderShot({
        firstImageUrl: img.first,
        lastImageUrl: shot.method === "flf" ? img.last : undefined,
        prompt,
        negativePrompt: shot.negativePrompt,
        seconds,
        cameraFixed,
        seed,
      });
    // THIS SHOT'S OWN seconds (base + every re-roll) — separate from the
    // shared baseRenderedSeconds/extraRerollSeconds totals above, which sum
    // across every shot in the film. onClipDone needs a per-shot figure to
    // log and cap-check incrementally (see that param's own comment).
    let shotSeconds = 0;

    // ── RENDER ──────────────────────────────────────────────────────────────
    // The video model runs its OWN content checker, entirely separate from the image
    // model's. A keyframe can pass and the clip still be refused. That refusal is
    // deterministic — identical text is refused identically forever — so it is not
    // retried. It is raised as a ContentRefusedError, which parks the project in
    // "needs_edit" naming this shot, refunds the credit, and leaves every other
    // keyframe and clip banked so the re-run resumes from exactly here.
    let finalUrl: string;
    const tBaseRender = Date.now();
    try {
      finalUrl = await renderOnce(motionPrompt, baseSeed);
      timeBaseRenderMs += since(tBaseRender);
      baseRenderedSeconds += seconds;
      shotSeconds += seconds;
    } catch (e) {
      if (!isContentPolicyError(e)) throw e;
      throw new ContentRefusedError(shot.id, "clip", shot.description || shot.motion || shot.id);
    }

    // ── POST-RENDER QA (no-op unless QA_ENABLED) ────────────────────────────
    // The video model still bakes audio into each clip; we just inspect what came back
    // and re-roll a genuinely broken shot with a corrective note + a fresh seed.
    // Capped, so it never loops -- EXCEPT a duplicated/merged person gets a much
    // higher cap (qaConfig.criticalMaxRetries) than an ordinary defect
    // (qaConfig.maxRetries), because that specific failure is a dealbreaker for the
    // whole product, not an imperfection a user will tolerate. The limit is decided
    // fresh on EACH check, from whatever this attempt's own findings actually were —
    // an ordinary defect that happens to follow a critical one still only gets the
    // normal budget; only an ACTIVE critical finding extends it.
    // Same-photo-every-time identity ground truth for this shot's cast (see 3-sheet.ts's angle-0
    // reuse and qa.ts's runQA() comment) — one canonical reference per named character, not the
    // full 10-angle sheet, to keep the QA vision call a reasonable size.
    const presentIds = new Set(shot.characters);
    const characterRefs = shot.characters
      .map((id) => ({ name: charById[id]?.name ?? id, url: sheet[id]?.[0] }))
      .filter((r): r is { name: string; url: string } => !!r.url);
    // background_identity_bleed (qa.ts) needs a NOT-present named character's own
    // reference photo to check a background/crowd extra against — without it, QA
    // has nothing to compare the extra's face to and can never catch a vendor at
    // one stall quietly wearing a different, named vendor's face. Only worth the
    // extra vision-call size for an actual crowd shot; a private, cast-only scene
    // has no incidental strangers to check in the first place. Capped at 4 so a
    // large-cast film doesn't balloon the QA image list — this only needs to cover
    // characters who plausibly could have been mistaken for a background figure in
    // THIS same scene, not the whole film's cast.
    const MAX_ABSENT_CAST_REFS = 4;
    const absentSceneCastRefs = shot.crowd
      ? [
          ...new Set(
            breakdown.shots
              .filter((other) => other.id !== shot.id && sameScene(shot, other))
              .flatMap((other) => other.characters)
              .filter((id) => !presentIds.has(id)),
          ),
        ]
          .slice(0, MAX_ABSENT_CAST_REFS)
          .map((id) => ({ name: charById[id]?.name ?? id, url: sheet[id]?.[0] }))
          .filter((r): r is { name: string; url: string } => !!r.url)
      : [];
    // Gap A — same idea as characterRefs above, for this shot's tracked
    // props (Shot.props, see types.ts's PropSchema): one canonical
    // reference photo per prop present in this shot.
    const propRefs = (shot.props ?? [])
      .map((id) => ({ name: propById[id]?.name ?? id, url: propSheet[id]?.[0] }))
      .filter((r): r is { name: string; url: string } => !!r.url);
    // Priority 7 — passed as QA's locationRef so environment_changed has a
    // fixed ground truth to judge location/landmark drift against. PREFERS
    // the durable location reference sheet (keyed by shot.locationId) over
    // sceneAnchorForShot whenever one exists — the location sheet survives a
    // REVISIT to a non-contiguous scene, which sceneAnchorForShot cannot
    // (see its own comment above); sceneAnchorForShot remains the fallback
    // for a location seen only once, which never gets its own sheet.
    const locationSheetUrl = shot.locationId ? locationSheet[shot.locationId]?.[0] : undefined;
    const locationRef = locationSheetUrl
      ? { name: shot.scene || shot.setting || "this location", url: locationSheetUrl }
      : sceneAnchorForShot[shot.id]
      ? { name: shot.scene || shot.setting || "this location", url: sceneAnchorForShot[shot.id] }
      : undefined;

    for (let attempt = 1; qaConfig.enabled; attempt++) {
      const tQaCheck = Date.now();
      const { pass, result, unverified } = await inspectClip(shot, finalUrl, img.first, [...characterRefs, ...absentSceneCastRefs], propRefs, locationRef);
      timeQaCheckMs += since(tQaCheck);
      // QA-CALL RELIABILITY (world-state wiring audit, Finding B) — unverified
      // means the QA call itself failed after its own internal retries, NOT
      // that this clip was judged clean. Previously indistinguishable from a
      // genuine pass (both returned pass:true, result:null) — surfaced here as
      // a real, visible flag so a human reviewer (or a future re-QA pass) can
      // tell "checked and fine" apart from "never actually checked" instead of
      // this shot silently looking identical to every shot that passed
      // cleanly. Deliberately does NOT re-render — inspectClip() already
      // retried the QA CALL itself; retrying the VIDEO because the QA
      // INFRASTRUCTURE failed would spend real render money chasing an
      // API-availability problem, not a content defect.
      if (unverified) {
        flag(shot.id, `QA could not be completed after retries (API/network error) — this shot was NEVER VERIFIED, not confirmed passing.`);
      }
      if (pass || !result) break;
      const critical = hasCriticalDefect(result);
      // Describe WHICH critical kind(s) actually fired, not a hardcoded "duplicate
      // person" label — reads directly off qa.ts's own CRITICAL_KINDS export so this
      // can never drift out of sync with it again (see that export's own comment).
      const criticalKinds = result.findings
        .filter((f) => CRITICAL_KINDS.has(f.kind))
        .map((f) => f.kind);
      const criticalLabel = criticalKinds.length ? ` — CRITICAL: ${[...new Set(criticalKinds)].join(", ")} persists` : "";
      const limit = critical ? qaConfig.criticalMaxRetries : qaConfig.maxRetries;
      if (attempt > limit) {
        flag(
          shot.id,
          `QA still failing after ${attempt - 1} retry attempt(s): ` +
          `${result.findings.map((f) => `${f.kind}(${f.severity.toFixed(2)})`).join(", ")}` +
          criticalLabel,
        );
        console.warn(
          `   ⚠️  QA ${shot.id}: still failing after ${attempt - 1} attempt(s)` +
          `${criticalLabel} — keeping the last render, flagged for human review.`,
        );
        break;
      }
      console.warn(
        `   ⚠️  QA ${shot.id}: ${result.findings.map((f) => `${f.kind}(${f.severity.toFixed(2)})`).join(", ")}` +
        ` — re-rolling ${attempt}/${limit}${criticalLabel}`,
      );
      try {
        let retryPrompt = withCorrection(motionPrompt, result);
        // ESCALATING IDENTITY REINFORCEMENT — Priority 2 fix: varying the RETRY
        // STRATEGY for an identity-critical failure specifically, not just the
        // seed. Checked first whether Seedance's real API surface (video.ts's
        // actual input object: prompt/duration/resolution/aspect_ratio/
        // camera_fixed/generate_audio/image_url/end_image_url/seed) exposes any
        // reference-image-strength or conditioning-weight parameter to turn up
        // on retry — it does not; that specific lever genuinely does not exist
        // at the provider level, confirmed by reading the real request body,
        // not assumed. What DOES exist is the text prompt, and identityLockText
        // above (baked into every attempt) was a flat, unescalating instruction.
        // On an identity-critical retry specifically, add a materially stronger,
        // fully explicit clause — the same "close-up needs a harder leash"
        // escalation 4-images.ts already uses for keyframes (IDENTITY_LOCK ->
        // CLOSEUP_LOCK), applied here to the video prompt, and scaled by attempt
        // number so a shot on its second re-roll gets a more insistent
        // correction than its first.
        const identityCritical = criticalKinds.some(
          (k) => k === "identity_drift" || k === "identity_swap" || k === "background_identity_bleed",
        );
        if (identityCritical && presentNames.length) {
          const appearanceText = shot.characters
            .map((id) => charById[id])
            .filter((c): c is Character => !!c)
            .map((c) => `${c.name}: ${c.appearance.trim().replace(/\.+$/, "")}`)
            .join(". ");
          retryPrompt +=
            ` EXTREME IDENTITY LOCK (retry ${attempt} — this is now the single most important instruction in ` +
            `this prompt): the previous attempt let ${presentNames.join(" and ")}'s face drift or stop matching ` +
            `their true appearance. Their exact, non-negotiable appearance for THIS ENTIRE CLIP, start to finish: ` +
            `${appearanceText}. Reproduce this precisely in EVERY frame — do not reinterpret, age, or restyle any ` +
            `feature at any point, even briefly, even for one frame.`;
        }
        const tReroll = Date.now();
        finalUrl = await renderOnce(retryPrompt, baseSeed + attempt);
        timeRerollRenderMs += since(tReroll);
        extraRerollSeconds += seconds; // this re-roll is a second full render at the same duration — real, additional cost
        shotSeconds += seconds;
      } catch (e) {
        if (!isContentPolicyError(e)) throw e;
        // A refused RE-ROLL is NOT fatal. The QA pass is an optional improvement on a
        // clip we already have in hand — killing the whole film because the corrective
        // rewording tripped the checker would be strictly worse than shipping the
        // original take. Keep what we have and move on.
        console.warn(`   ⚠️  ${shot.id}: QA re-roll refused on content grounds — keeping the original clip.`);
        break;
      }
    }

    // ── DELIVERY UPSCALE ────────────────────────────────────────────────────
    // See runtime.generationResolution's own comment in config.ts and
    // providers/upscale.ts's own comment for the confirmed real integration.
    // Deliberately the LAST thing before download — runs exactly ONCE per
    // shot, on the FINAL accepted clip only, after every QA re-roll has
    // already happened. Upscaling before QA settled would mean paying to
    // upscale a defective take that's about to be discarded and re-rendered;
    // this way a shot that needed 2 re-rolls is still only ever upscaled once.
    let upscaleCostUsd = 0;
    if (config.upscaleEnabled && runtime.resolution !== runtime.generationResolution) {
      try {
        const tUpscale = Date.now();
        const upscaled = await upscaleVideo(finalUrl);
        timeUpscaleMs += since(tUpscale);
        finalUrl = upscaled.url;
        upscaleCostUsd = costOfUpscale(shotSeconds, runtime.resolution);
        console.log(`   ⬆️  ${shot.id}: upscaled ${runtime.generationResolution} → ${runtime.resolution} (factor ${upscaled.upscaleFactor}, +$${upscaleCostUsd.toFixed(3)})`);
      } catch (e) {
        // A failed upscale is NOT fatal — the 480p generation is still a complete,
        // correct clip. Same "polish feature, never lose work over it" philosophy
        // as everywhere else in this pipeline (title cards, end fade, dissolve).
        // Ships at generation resolution for this one shot rather than failing
        // the whole render; 6-assemble.ts's own normalize/pad pass still brings
        // it to the DELIVERY frame size, just without the real added detail an
        // upscale would have provided.
        console.warn(`   ⚠️  ${shot.id}: upscale to ${runtime.resolution} failed, shipping this shot at ${runtime.generationResolution} instead: ${(e as Error)?.message}`);
      }
    }

    await downloadToFile(finalUrl, dest);

    // ── SPOKEN-LANGUAGE DUB (translated films only) ──────────────────────
    // CONFIRMED REAL FAILURE (2026-08-15): Seedance's own native audio does
    // not reliably speak a translated dialogue line in the requested
    // language, even with the emphatic languageDirective above — a real
    // Hindi render still came back in English. A real TTS engine, unlike an
    // implicit side-channel of a video-diffusion model, is built to comply
    // with "speak this text in this language," so it succeeds where prompt
    // engineering the video model could not (see providers/tts.ts's own
    // comment for a real, live-tested confirmation of this).
    //
    // Scoped narrowly: only a shot with dialogue, an ON-SCREEN speaker (the
    // offscreen-earpiece case stays on Seedance's native audio for now —
    // rarer, and its "voice with no visible mouth to match" framing makes
    // the lip-sync trade-off below moot anyway), in a translated film.
    // REPLACES the clip's entire audio track (muxReplaceAudio) rather than
    // mixing the TTS voice on top of Seedance's own audio — mixing would
    // layer a correct-language voice OVER Seedance's own wrong-language
    // mumble, which is worse than either alone. The video itself — motion,
    // camera, faces — is completely untouched.
    //
    // THE TRADE-OFF, STATED HONESTLY: the character's mouth was animated by
    // Seedance for whatever it internally intended to say, not for this new
    // audio — lip-sync precision is traded for spoken-language correctness.
    // This only activates when that trade has been explicitly requested
    // (isTranslated(breakdown.language) is false for every English/default
    // film, so nothing changes there at all).
    //
    // Non-fatal: a TTS/mux failure keeps Seedance's own (wrong-language, but
    // real and already-paid-for) audio rather than losing the clip — same
    // "never lose work over a polish-tier failure" discipline as the
    // upscale pass just above, even though getting this right is the whole
    // point here, not a polish feature.
    if (isTranslated(breakdown.language) && shot.dialogue?.trim() && speakerOnScreen) {
      const speakerChar = charById[shot.speaker!];
      let voicePath: string | undefined;
      try {
        const voiceBuf = await synthesizeSpeech(shot.dialogue, speakerChar?.voice, breakdown.language);
        voicePath = `${runtime.outDir}/clips/${shot.id}-voice.mp3`;
        await fs.writeFile(voicePath, voiceBuf);
      } catch (e) {
        console.warn(`   ⚠️  ${shot.id}: ${languageName(breakdown.language)} TTS failed (${(e as Error)?.message}) — keeping Seedance's own audio for this clip.`);
      }

      if (voicePath) {
        // REAL LIP SYNC, best-effort — see providers/lipsync.ts's own
        // comment for the real, confirmed sync-lipsync endpoint and why
        // sync_mode "remap" specifically. Requires uploading this clip and
        // the new voice line to R2 first (fal.subscribe() needs public
        // URLs, same as every other fal.ai call in this pipeline) — if R2
        // isn't configured (a bare local CLI run with no worker/R2 set up)
        // or the API call fails for any reason, this degrades to the plain
        // audio-replace-only dub (muxReplaceAudio, no visual re-sync)
        // rather than losing the clip or blocking the render.
        let lipSynced = false;
        try {
          const [videoUrl, audioUrl] = await Promise.all([
            uploadFile(dest, `tmp/lipsync/${shot.id}-${Date.now()}.mp4`),
            uploadFile(voicePath, `tmp/lipsync/${shot.id}-${Date.now()}.mp3`),
          ]);
          const syncedUrl = await applyLipSync(videoUrl, audioUrl);
          await downloadToFile(syncedUrl, dest);
          lipSynced = true;
          console.log(`   🗣️  ${shot.id}: lip-synced with real ${languageName(breakdown.language)} speech.`);
        } catch (e) {
          console.warn(`   ⚠️  ${shot.id}: lip-sync failed (${(e as Error)?.message}) — falling back to audio-only dub (no visual re-sync).`);
        }

        if (!lipSynced) {
          try {
            const dubbedPath = `${runtime.outDir}/clips/${shot.id}-dubbed.mp4`;
            await muxReplaceAudio(dest, voicePath, dubbedPath);
            await fs.rename(dubbedPath, dest);
            console.log(`   🗣️  ${shot.id}: dubbed with real ${languageName(breakdown.language)} speech (audio only, Seedance's own audio replaced).`);
          } catch (e) {
            console.warn(`   ⚠️  ${shot.id}: audio-only dub also failed (${(e as Error)?.message}) — keeping Seedance's own audio for this clip.`);
          }
        }
      }
    }

    // Bank it BEFORE advancing progress/logging, so a crash right after this line still
    // leaves the clip durably stored — the whole point of this callback existing.
    const shotCostUsd = costOfClip(shotSeconds) + upscaleCostUsd;
    try {
      await onClipDone?.(shot, dest, shotCostUsd);
    } catch (e) {
      // BudgetCapExceededError is the caller (worker.ts) deliberately aborting the
      // render because this job's own real spend just exceeded its safety ceiling —
      // that must propagate and stop new clips from starting, not be swallowed as
      // if it were an ordinary storage hiccup. See spend.ts's own comment: this is
      // already classified as a PERMANENT failure everywhere else it's thrown.
      if (e instanceof BudgetCapExceededError) throw e;
      // Everything else: never let a storage/DB hiccup on ONE clip's banking kill an
      // otherwise-successful render — the clip is still on disk and will simply be
      // re-banked (or re-rendered, worst case) on the next attempt. Losing progress
      // on a genuinely failed upload is the old behaviour; failing the whole film
      // over it would be worse.
      console.warn(`   ⚠️  ${shot.id}: failed to bank clip immediately (${(e as Error)?.message}). Will retry on next attempt if needed.`);
    }
    done++; await onProgress?.(done, total);
    console.log(`   ✓ clip ${i + 1}/${total} (${shot.id}, ${seconds}s, ${shot.method})`);
    return dest;
  });

  await writeJson(`${runtime.outDir}/clips.json`, clips);
  await writeJson(`${runtime.outDir}/qa-reroll-seconds.json`, { baseRenderedSeconds, extraRerollSeconds });
  await writeJson(`${runtime.outDir}/qa-flags.json`, flags);
  if (extraRerollSeconds > 0) {
    console.log(`   💸 QA re-rolls added ${extraRerollSeconds}s of extra billed render time this run.`);
  }
  if (Object.keys(flags).length) {
    console.log(`   🚩 ${Object.keys(flags).length} clip(s) flagged for review: ${Object.keys(flags).join(", ")}`);
  }
  console.log(`✅ ${clips.length} clip(s) ready.`);

  // ⏱ TEMPORARY TIMING INSTRUMENTATION — see the accumulator comment above.
  // Safe to delete once the real clip-phase bottleneck is found and fixed.
  const wallClockMs = Date.now() - stepStartedAt;
  const timeTotalMs = timeBaseRenderMs + timeQaCheckMs + timeRerollRenderMs + timeUpscaleMs;
  console.log(`⏱ CLIP PHASE TIMING BREAKDOWN (${breakdown.shots.length} shots, up to ${CONCURRENCY}-way concurrent):`);
  console.log(`   wall-clock for this whole step:      ${(wallClockMs / 1000 / 60).toFixed(2)} min`);
  console.log(`   base renders (sum across all shots):  ${(timeBaseRenderMs / 1000).toFixed(1)}s  (avg ${(timeBaseRenderMs / 1000 / breakdown.shots.length).toFixed(1)}s/shot)`);
  console.log(`   QA checks (sum, vision calls):        ${(timeQaCheckMs / 1000).toFixed(1)}s`);
  console.log(`   QA re-roll renders (sum):             ${(timeRerollRenderMs / 1000).toFixed(1)}s`);
  console.log(`   upscales (sum):                       ${(timeUpscaleMs / 1000).toFixed(1)}s`);
  console.log(`   SUM of tracked compute (NOT wall-clock — shots overlap): ${(timeTotalMs / 1000 / 60).toFixed(2)} min`);

  return clips;
}

if (isMain(import.meta.url)) {
  runVideos().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}