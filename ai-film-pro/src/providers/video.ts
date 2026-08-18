import { fal } from "../falClient";
import { config, runtime } from "../config";
import { isBillingOrAuthError, reportBillingOrAuthError } from "../lib/opsAlert";
import { withTimeout } from "../util";

// fal.subscribe() has no built-in timeout — see util.ts's withTimeout() for
// the confirmed real hang this guards against. Video generation legitimately
// runs longer than a still image, so this gets a longer budget than image.ts's.
const VIDEO_TIMEOUT_MS = 10 * 60_000;

export interface RenderShotOpts {
  firstImageUrl: string;
  /** Present ⇒ Seedance's OPTIONAL end-frame field is included on the SAME
   *  endpoint (see below) — unlike Veo, there is no separate flf endpoint. */
  lastImageUrl?: string;
  prompt: string;
  /** No native negative_prompt field on Seedance — folded into the main
   *  prompt as an explicit "AVOID: ..." suffix, see renderShot() below. */
  negativePrompt: string;
  seconds: number;
  /** Native camera_fixed boolean field — sent as-is, no prompt-text workaround needed. */
  cameraFixed?: boolean;
  /** Deterministic seed; a QA re-render passes a nudged value for a fresh roll. */
  seed?: number;
}

/**
 * SEEDANCE 1.5 PRO (via fal.ai) — reverted back from Veo 3.1, 2026-07-28.
 *
 * Provider history on this project: Seedance 1.5 Pro -> Veo 3.1 Lite -> Kling
 * 3.0 Turbo -> Veo 3.1 Lite -> Veo 3.1 "Quality" tier -> back to Seedance 1.5
 * Pro. The Veo Quality tier's $0.40/s (with audio) led directly to a $50
 * render that never finished; Seedance 1.5 Pro is confirmed via research at
 * ~$0.052/s @720p with audio (from a published $0.26-for-a-5s-720p-clip
 * figure) — roughly 8x cheaper, and the tier this whole pipeline was
 * originally built and tuned against before any of the later migrations.
 *
 * REAL DIFFERENCES FROM VEO, confirmed via research (not guessed):
 *   1. ONE ENDPOINT, not two. Unlike Veo (which split i2v/flf into separate
 *      endpoints with different rules), Seedance's image-to-video endpoint
 *      takes an OPTIONAL end-frame field on the SAME endpoint — no forced
 *      8-second-minimum quirk Veo's flf endpoint had, and no separate model
 *      id to route between. 5-videos.ts and everything upstream is
 *      unchanged regardless of which provider is live.
 *   2. duration is NOT locked to a narrow enum like Veo's 4s/6s/8s. Confirmed
 *      step values are 4/6/8/10/12 seconds, sent as a bare numeric string
 *      ("5"), not Veo's suffixed "8s". Snapped to the nearest of that wider
 *      set, rounding DOWN on an exact tie — never render longer than planned.
 *   3. NO negative_prompt field (confirmed absent from the documented
 *      parameter list — matches this codebase's own historical comment about
 *      the ORIGINAL Seedance integration, before Veo added a native one).
 *      Folded into the main prompt as an explicit "AVOID: ..." clause.
 *   4. camera_fixed IS a real native boolean field — no prompt-text
 *      workaround needed, unlike Veo which had no camera-control field at all.
 *   5. aspect_ratio supports more than Veo did, including native "1:1" (Veo
 *      had to fall back to "auto" for square) — still only sending what the
 *      product UI exposes (16:9/9:16/1:1), just without Veo's fallback hack.
 *   6. RESOLUTION IS NOT LOCKED — "480p" | "720p" | "1080p" all real tiers
 *      (Veo only ever had 720p/1080p, no 480p). See config.ts.
 *   7. "no_media_generated" (a fal error type distinct from a clean
 *      content_policy_violation) is still treated as a content refusal — see
 *      isContentPolicyError() in image.ts. Kept from the Veo integration;
 *      nothing suggests this fal-level behavior is provider-specific.
 *   8. UNVERIFIED, STATED HONESTLY: the exact end-frame field name. fal.ai's
 *      own API reference page could not be fetched (429, rate-limited) to
 *      confirm it directly — Segmind's wrapper of the same underlying model
 *      uses first_frame_url/last_frame_url, but that's a different platform,
 *      not necessarily fal's own naming. Best guess below: image_url (start)
 *      + end_image_url (end), matching fal's own "optionally provided end
 *      frame" description. Same discipline as every other UNVERIFIED
 *      integration in this file's history: a rejection's full error body is
 *      logged below, so a wrong guess surfaces the real field name on first
 *      use exactly the way Veo's own duration-enum quirk was originally found.
 *   9. Output shape is also a best guess (r.data.video.url, matching the
 *      general fal video-model convention already confirmed for Veo) with
 *      video_url/url fallbacks checked too, for the same reason.
 */

type SeedanceDuration = 4 | 6 | 8 | 10 | 12;

/** Round DOWN on a tie (5→4, 7→6, 9→8, 11→10) — never render LONGER than
 *  planned. Explicit branches, not a generic loop — this exact shape (Veo's
 *  original nearestVeoDuration) is easy to verify by inspection; a "clever"
 *  generic version of this same idea silently rounded 5 UP to 6 instead of
 *  down during a first draft here, exactly the bug this discipline avoids. */
function nearestSeedanceDuration(seconds: number): SeedanceDuration {
  const n = Math.round(seconds);
  if (n <= 5) return 4;
  if (n <= 7) return 6;
  if (n <= 9) return 8;
  if (n <= 11) return 10;
  return 12;
}

function seedanceAspectRatio(aspect: string): "16:9" | "9:16" | "1:1" {
  return aspect === "9:16" ? "9:16" : aspect === "1:1" ? "1:1" : "16:9";
}

/**
 * KLING 3.0 (via fal.ai) — evaluated 2026-08-05 as a possible alternative to
 * Seedance 1.5 Pro after Seedance 2.0 was confirmed to reject this pipeline's
 * AI-generated character images outright (real-person-likeness content
 * filter, tested twice, two different characters, both rejected). Kling 3.0
 * accepted the SAME images cleanly in real smoke tests, with genuinely better
 * identity-hold and motion quality than Seedance 1.5 Pro was producing.
 *
 * REAL DIFFERENCES FROM SEEDANCE, confirmed via research + real test calls,
 * not guessed:
 *   1. image_url / end_image_url / prompt / generate_audio are the SAME field
 *      names Seedance already uses — confirmed via fal.ai's own docs.
 *   2. duration accepts any integer 3-15 (not Seedance's fixed 4/6/8/10/12
 *      set) — finer-grained snapping below, same "round down, never longer
 *      than planned" philosophy as Seedance's own function.
 *   3. NO confirmed camera_fixed field. Rather than silently drop the
 *      background-stability fix this pipeline depends on for static/close-up
 *      shots, the SAME instruction is folded into the prompt text instead —
 *      degraded gracefully, not silently dropped.
 *   4. NO resolution input field — confirmed via fal.ai's own model listing,
 *      resolution/quality tier is selected by WHICH MODEL ID you call
 *      (e.g. .../v3/standard/... vs .../v3/pro/... vs .../v3/4k/...), not a
 *      runtime parameter. config.videoModel already carries this; sending a
 *      "resolution" field here would just be an unrecognized extra key.
 *   5. aspect_ratio IS a real field, but a REAL TEST showed it did not
 *      override a portrait-shaped input image's own framing — likely because
 *      i2v mode inherits the input image's own dimensions the way Seedance
 *      does too. Sent anyway as a hint (harmless either way); the actual
 *      guarantee of correct framing is what it always was — the KEYFRAME
 *      passed in (4-images.ts's real output) is already generated at
 *      runtime.aspectRatio, not this parameter.
 *   6. seed: UNVERIFIED whether Kling honors it — sent optimistically, same
 *      "let a wrong guess surface in the real error" discipline as every
 *      other unverified field in this file's history.
 *   7. Response shape CONFIRMED IDENTICAL to Seedance's via a real test call
 *      — { video: { url, content_type, file_name, file_size } } — the same
 *      r?.data?.video?.url extraction below already handles both providers,
 *      no branching needed there.
 *   8. REAL COST, confirmed via the user's own fal.ai billing (not a
 *      published rate card): ~$0.093/s on the standard tier used in testing
 *      — roughly 1.8x Seedance 1.5 Pro's $0.052/s. A real, moderate increase,
 *      not a repeat of the Veo Quality tier's $0.40/s budget disaster.
 *   9. `prompt` HAS a hard 2500-char server-side limit — CONFIRMED via a real
 *      422 on "The Package 5" (2026-08-05), unlike Seedance which has never
 *      hit one despite the SAME prompt-building code. `negative_prompt` IS a
 *      real native field here (confirmed via fal's own published example
 *      payload) — Seedance has no such field and keeps folding negatives
 *      into `prompt` via " AVOID: ...". Both are capped defensively; see
 *      KLING_FIELD_MAX / truncateForKling() below.
 */
function isKlingModel(model: string): boolean {
  return /kling/i.test(model);
}

/** CONFIRMED via a real 422 (2026-08-05, "The Package 5", project
 *  cmsfoxtaf...): Kling's own server validates `prompt` at a hard max of
 *  2500 chars — {"type":"string_too_long","loc":["body","prompt"],"msg":
 *  "String should have at most 2500 characters"}. This pipeline's real
 *  compiled prompts (shot.description + setting + action + camera + the
 *  identity-lock/background-lock/continuous-take reinforcement clauses)
 *  routinely ran 5,000-16,000 chars in the actual failing render — Seedance
 *  has no such limit and this text was never budgeted with one in mind.
 *  Applying the SAME cap defensively to negative_prompt too: unconfirmed
 *  whether fal validates it identically, but it comes from the same
 *  request body and negativeFor() (compiler.ts) can itself produce several
 *  thousand chars, so there's no reason to assume it's exempt. Truncates at
 *  a word boundary rather than mid-word. Seedance's own prompt (which folds
 *  negatives into the SAME string, see below) is completely unaffected —
 *  this only ever runs on the Kling branch. */
const KLING_FIELD_MAX = 2500;
function truncateForKling(text: string, label: string): string {
  if (text.length <= KLING_FIELD_MAX) return text;
  const cut = text.slice(0, KLING_FIELD_MAX - 1).replace(/\s+\S*$/, "");
  console.log(`   ✂️ Kling ${label} truncated ${text.length} → ${cut.length + 1} chars (server hard limit is 2500)`);
  return `${cut}…`;
}

/** Same "never render longer than planned" philosophy as
 *  nearestSeedanceDuration() above, at Kling's finer 1s granularity
 *  (confirmed integer range 3-15, not Seedance's 4/6/8/10/12 set). */
function nearestKlingDuration(seconds: number): number {
  return Math.max(3, Math.min(15, Math.floor(seconds)));
}

/**
 * SEEDANCE 2.5 (via fal.ai) — added 2026-08-13 as an opt-in alternative to
 * 1.5 Pro, switchable back and forth purely via VIDEO_MODEL (see config.ts);
 * nothing else in the pipeline changes either way — continuity lives in the
 * character/prop/location reference sheets and keyframe-chaining (steps 1-4),
 * not in this file. Whichever provider renders here just animates the two
 * already-correct frames it's handed.
 *
 * CONFIRMED VIA FAL.AI'S OWN PUBLISHED API DOCS (WebFetch, 2026-08-13) —
 * NOT YET VIA A REAL TEST CALL. Same "state it honestly, let a wrong guess
 * surface in the real error" discipline as every other unverified field in
 * this file's history (see Seedance 1.5's own #8/#9 above) — but one level
 * more cautious: Kling's own comment block above was verified with real
 * render calls before being trusted; this hasn't been yet. Watch the first
 * few real renders' console output closely.
 *
 * REAL DIFFERENCES FROM SEEDANCE 1.5 PRO, per fal's docs:
 *   1. image_url / end_image_url / prompt / generate_audio — SAME field
 *      names 1.5 already uses. No change needed for these.
 *   2. duration: no fixed 4/6/8/10/12 set — accepts "auto" or a much wider
 *      4-30s range. Sent as an explicit number below (never "auto") to keep
 *      this pipeline's own per-shot timing plan authoritative, same as 1.5
 *      and Kling. See nearestSeedance25Duration() below.
 *   3. NO aspect_ratio field — fal's docs say this endpoint is always "auto",
 *      inferring the frame shape from the input image. Not sent at all
 *      below. This should be harmless: the keyframe passed in (4-images.ts's
 *      real output) is already generated at runtime.aspectRatio, exactly
 *      the same guarantee 1.5's own aspect_ratio param comment already
 *      relies on for correct framing.
 *   4. NO camera_fixed field (not in fal's documented parameter list).
 *      Same degrade-gracefully treatment as Kling's #3 above: the same
 *      static-camera instruction is folded into the prompt text instead of
 *      silently dropped.
 *   5. NO seed INPUT — seed is output-only per fal's docs. A QA re-roll's
 *      seed nudge (see 5-videos.ts's renderOnce()) is silently not sent for
 *      this model; the re-roll still gets a genuinely different render
 *      because 5-videos.ts already sends a fresh, more insistent corrective
 *      PROMPT on every re-roll attempt (retryPrompt, not just a nudged
 *      seed) — seed was always the secondary lever there, not the only one.
 *   6. resolution: fal's docs list only 480p/720p for this endpoint (1.5
 *      supports up to 1080p/4k-via-upscale). In practice this pipeline
 *      generates at 480p almost always (config.upscaleEnabled defaults to
 *      true, and generationResolutionFor() only ever asks for 480p or,
 *      for a "4k" delivery tier, 1080p — see config.ts). The ONE real edge
 *      case is that 4k-delivery path, which asks for 1080p generation —
 *      outside 2.5's documented range. Clamped to 720p below with a log
 *      line, rather than silently sending a value 2.5 might reject.
 *   7. Pricing NOT published on fal's docs page — unlike Kling's #8 above
 *      (confirmed via real billing), this is genuinely unknown until a real
 *      render's fal.ai billing line is checked.
 *   8. Response shape ASSUMED identical to 1.5/Kling's confirmed
 *      { video: { url, ... } } shape (fal's own general convention) — the
 *      same r?.data?.video?.url extraction below already covers this, no
 *      branching needed there. Unverified for THIS model specifically.
 */
function isSeedance25Model(model: string): boolean {
  return /seedance[-/]?2\.5/i.test(model);
}

/**
 * SEEDANCE 2.5 REFERENCE-TO-VIDEO — added 2026-08-14 as an EXPERIMENTAL
 * alternate to the image-to-video endpoint above, specifically to test
 * against a REAL, LIVE finding: the image-to-video endpoint rejected a
 * completely ordinary keyframe (two named characters talking in a kitchen,
 * nothing remotely sensitive) with content_policy_violation /
 * "partner_validation_failed" — "images... may contain likenesses of real
 * people." This pipeline's OWN prior research already documented the exact
 * same failure for Seedance 2.0, tested on two different characters — so
 * this looks systemic to this pipeline's photorealistic AI-generated faces,
 * not specific to one shot.
 *
 * THE HYPOTHESIS THIS BRANCH TESTS: reference-to-video's entire documented
 * purpose is accepting reference images of people/characters to preserve
 * their identity across a generated clip ("character-consistent series").
 * A filter that blocks any photorealistic face as "a real person" would
 * defeat that endpoint's own premise, so its moderation may plausibly be
 * tuned differently than image-to-video's. UNCONFIRMED — this is a real
 * test, not a known fix. Report back what actually happens.
 *
 * A SECOND, INDEPENDENT RISK, per fal's docs (WebFetch, 2026-08-14): this
 * endpoint takes `image_urls` (a reference-image ARRAY) rather than a
 * strict first-frame/end-frame pair, and is positioned around "subject
 * appearance, motion style, composition, and rhythm" — i.e. it may treat
 * these images as STYLE/IDENTITY references rather than "start exactly
 * from this exact frame." If so, a clip's opening frame could drift from
 * the keyframe 4-images.ts generated, breaking this pipeline's shot-to-shot
 * continuity in a way that has nothing to do with content moderation.
 * WATCH FOR THIS SPECIFICALLY when reviewing a real test clip.
 *
 * REAL DIFFERENCES FROM THE image-to-video ENDPOINT ABOVE, per fal's docs:
 *   1. image_urls (array) instead of image_url + end_image_url. Populated
 *      below as [start] or [start, end] — UNCONFIRMED whether the second
 *      element is honored as a true end-frame the way image-to-video's
 *      end_image_url is.
 *   2. aspect_ratio IS a real, settable field here (unlike image-to-video's
 *      auto-only) — sent as an explicit hint, same as 1.5 Pro/Kling.
 *   3. seed IS a real INPUT field here (unlike image-to-video's output-only
 *      seed) — sent when the caller provides one, restoring the QA re-roll
 *      path's seed-nudge lever that the image-to-video branch above lost.
 *   4. video_urls / audio_urls also exist on this endpoint (multi-reference
 *      inputs) — not used here, this pipeline only ever has a still image.
 */
function isSeedance25ReferenceModel(model: string): boolean {
  return isSeedance25Model(model) && /reference-to-video/i.test(model);
}

/** Same "never render longer than planned" philosophy as the other two
 *  duration snappers — fal's docs describe a much wider 4-30s range here
 *  (vs 1.5's fixed 4/6/8/10/12 set), so this just clamps rather than
 *  snapping to a small discrete set. */
function nearestSeedance25Duration(seconds: number): number {
  return Math.max(4, Math.min(30, Math.floor(seconds)));
}

/** See difference #6 above: fal's docs only list 480p/720p for this
 *  endpoint. Only the 4k-delivery path (which asks for 1080p generation)
 *  can actually exceed that today — clamp defensively rather than send a
 *  value that isn't documented as accepted, and log it so a clamp is never
 *  silent. */
function seedance25Resolution(generationResolution: string): string {
  if (generationResolution === "480p" || generationResolution === "720p") return generationResolution;
  console.log(`   ↻ resolution ${generationResolution} → 720p (Seedance 2.5's image-to-video endpoint only documents 480p/720p)`);
  return "720p";
}

export async function renderShot(o: RenderShotOpts): Promise<string> {
  const hasEndFrame = !!o.lastImageUrl;
  const model = config.videoModel;
  const usingKling = isKlingModel(model);
  const usingSeedance25 = isSeedance25Model(model);
  const usingSeedance25Reference = isSeedance25ReferenceModel(model);

  const durationSec = usingKling
    ? nearestKlingDuration(o.seconds)
    : usingSeedance25
      ? nearestSeedance25Duration(o.seconds)
      : nearestSeedanceDuration(o.seconds);
  if (durationSec !== Math.round(o.seconds)) {
    const range = usingKling ? "Kling accepts 3-15s" : usingSeedance25 ? "Seedance 2.5 accepts 4-30s" : "Seedance accepts 4/6/8/10/12s";
    console.log(`   ↻ duration ${o.seconds}s → ${durationSec}s (${range})`);
  }

  // NEGATIVE PROMPT — neither Seedance version has a confirmed native field
  // (see #3 in 1.5's comment above, #2 in 2.5's), so both fold it into the
  // main prompt. Kling DOES have a real native negative_prompt field
  // (confirmed via fal.ai's own published example payload, 2026-08-05) —
  // sent separately below instead of being folded in, which also matters
  // for staying under Kling's 2500-char prompt cap (see KLING_FIELD_MAX
  // above).
  let prompt = usingKling || !o.negativePrompt ? o.prompt : `${o.prompt} AVOID: ${o.negativePrompt}`;
  // CAMERA_FIXED — Kling and Seedance 2.5 both have no native field (see
  // Kling's #3 and 2.5's #4 above), so the same intent this boolean carries
  // for Seedance 1.5's native camera_fixed field is folded into the prompt
  // text instead of silently lost.
  if ((usingKling || usingSeedance25) && o.cameraFixed) {
    prompt = `${prompt} Camera holds perfectly static and locked-off for this entire shot — no camera movement, no drift, no pan, no zoom.`;
  }
  if (usingKling) prompt = truncateForKling(prompt, "prompt");

  const input: Record<string, any> = usingKling
    ? {
        prompt,
        negative_prompt: o.negativePrompt ? truncateForKling(o.negativePrompt, "negative_prompt") : undefined,
        duration: `${durationSec}`,
        aspect_ratio: seedanceAspectRatio(runtime.aspectRatio), // hint only — see #5 above
        generate_audio: runtime.audio,
        image_url: o.firstImageUrl,
      }
    : usingSeedance25Reference
      ? {
          prompt,
          // image_urls, NOT image_url/end_image_url — see this branch's own
          // comment above for the two things this specifically tests: does
          // it get past the identity filter that rejected image-to-video,
          // and does the second array element actually behave as an end frame.
          image_urls: hasEndFrame ? [o.firstImageUrl, o.lastImageUrl] : [o.firstImageUrl],
          duration: `${durationSec}`,
          aspect_ratio: seedanceAspectRatio(runtime.aspectRatio), // real field here — see #2 above
          resolution: seedance25Resolution(runtime.generationResolution),
          generate_audio: runtime.audio,
          // seed IS a real input field here (see #3 above) — send it when
          // the caller provides one (a QA re-roll's nudge), unlike the
          // image-to-video branch below which has nothing to send it to.
          ...(typeof o.seed === "number" && Number.isFinite(o.seed) ? { seed: o.seed } : {}),
        }
      : usingSeedance25
        ? {
            prompt,
            duration: `${durationSec}`,
            // NO aspect_ratio — see #3 above, this endpoint always infers it
            // from image_url. NO camera_fixed — folded into prompt above.
            resolution: seedance25Resolution(runtime.generationResolution),
            generate_audio: runtime.audio,
            image_url: o.firstImageUrl,
          }
        : {
          prompt,
          duration: `${durationSec}`,
          // GENERATION resolution, not delivery — see runtime.generationResolution's
          // own comment in config.ts. When upscaling is enabled this is always
          // "480p" regardless of what tier the project is actually delivered at;
          // reaching a higher delivery tier happens via a real upscale pass in
          // 5-videos.ts, not by asking Seedance to render at that resolution.
          resolution: runtime.generationResolution,
          aspect_ratio: seedanceAspectRatio(runtime.aspectRatio),
          camera_fixed: !!o.cameraFixed,
          // Seedance's own default is presumably true, but stated explicitly so
          // runtime.audio (the project's paid audio toggle / VIDEO_AUDIO in .env)
          // is never silently overridden by whatever fal's own default happens to be.
          generate_audio: runtime.audio,
          image_url: o.firstImageUrl,
        };

  // Reference-to-video has no end_image_url field — its own branch above
  // already puts the end frame inside image_urls instead.
  if (hasEndFrame && !usingSeedance25Reference) input.end_image_url = o.lastImageUrl;
  // NO seed input on the plain Seedance 2.5 image-to-video endpoint
  // (output-only, see #5 above). The caller still passes one in on a QA
  // re-roll (renderOnce() in 5-videos.ts) — not sending it here, rather
  // than sending a key fal's docs say it ignores, keeps this call honest
  // about what actually influences the result. The reference-to-video
  // branch above already sends it inline (a real input field there).
  if (typeof o.seed === "number" && Number.isFinite(o.seed) && !usingSeedance25) input.seed = o.seed;

  try {
    const r: any = await withTimeout(fal.subscribe(model, { input: input as any }), VIDEO_TIMEOUT_MS, `video generation (${model})`);
    const url = r?.data?.video?.url ?? r?.data?.video_url ?? r?.data?.url;
    if (typeof url !== "string" || !url) {
      throw new Error(`Unexpected response shape from ${model}: ${JSON.stringify(r?.data ?? r).slice(0, 500)}`);
    }
    return url;
  } catch (e: any) {
    console.error(`\n❌ ${model} rejected the request. Actual reason:`);
    console.error(JSON.stringify(e?.body ?? e?.response?.data ?? e?.message ?? e, null, 2));
    const resolutionNote = usingKling ? "" : `resolution: ${input.resolution} (delivery: ${runtime.resolution}) | `;
    const aspectNote = usingSeedance25 && !usingSeedance25Reference ? "aspect: auto (from input image)" : `aspect: ${input.aspect_ratio}`;
    console.error(`   sent → duration: "${durationSec}" | ${resolutionNote}${aspectNote} | endFrame: ${hasEndFrame} | audio: ${runtime.audio} | prompt: ${prompt.length} chars\n`);
    // PASSIVE PROVIDER-HEALTH SIGNAL — see lib/opsAlert.ts.
    if (isBillingOrAuthError(e)) reportBillingOrAuthError("fal", e);
    throw e;
  }
}
