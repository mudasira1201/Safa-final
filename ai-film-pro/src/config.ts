import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`\n❌ Missing required env var: ${name}\n   Copy .env.example to .env and fill it in.\n`);
  }
  return v.trim();
}
// UNLOCKED AGAIN, 2026-07-28: reverted from Veo 3.1 (locked to 720p — no 480p
// tier existed there) back to Seedance 1.5 Pro, which genuinely supports all
// three of these. Defaults to "480p" — the cheapest tier, chosen deliberately
// after a $50 Veo Quality-tier render — but every value is real and honored,
// not silently overridden the way the Veo-era lock did.
// "4k" ADDED 2026-08-02 — see targetDimensions()/runtime.generationResolution
// below for the real math this unlocks: Topaz's own documented upscale_factor
// range is 1-4x linear (providers/upscale.ts), and 480p (the generation base
// EVERY other tier uses) to 4K's 2160px height is a 4.5x jump — over that
// cap. Confirmed this would have been a SILENT under-delivery, not an error:
// computeUpscaleFactor() clamps to 4 rather than throwing, which would have
// quietly shipped a 1920px-tall "4K" file. generationResolution below now
// special-cases 4k delivery to generate at 1080p instead of 480p (1080->2160
// is exactly 2x, comfortably inside Topaz's range) rather than just adding
// the tier name and letting the existing math silently misbehave.
const RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
export type VideoResolution = (typeof RESOLUTIONS)[number];

function resolveResolution(): VideoResolution {
  const v = process.env.VIDEO_RESOLUTION;
  if (v && (RESOLUTIONS as readonly string[]).includes(v)) return v as VideoResolution;
  if (v) console.warn(`⚠️  VIDEO_RESOLUTION="${v}" is not one of ${RESOLUTIONS.join("/")} — defaulting to 480p.`);
  return "480p";
}

/** GENERATION resolution for a given DELIVERY tier — one canonical place
 *  for this decision so the module-level default and applyProjectSettings()
 *  below can't drift apart.
 *
 *  CHANGED (explicit product decision, superseding the previous "every tier
 *  through 1080p generates at 480p and gets upscaled" default): 480p, 720p,
 *  and 1080p now each generate NATIVELY at their own selected tier — a user
 *  who picks 720p gets a real 720p Seedance render, not a 480p render
 *  upscaled to 720p-sized pixels. This is a genuine cost increase at 720p/
 *  1080p (a real per-second price jump, not the free-lunch the upscale path
 *  was) — a deliberate tradeoff the product owner chose explicitly, aware of
 *  it, over the cheaper upscale-based delivery this function used to return
 *  unconditionally.
 *
 *  "4k" remains the ONE exception, and MUST: Seedance has no native 4k tier
 *  at all (RESOLUTIONS above tops out at "1080p" as a real generation
 *  option), so a 4k delivery is only reachable via upscale — generating at
 *  1080p and upscaling keeps that upscale at a clean 2x (1080->2160),
 *  comfortably inside Topaz's documented 1-4x upscale_factor range
 *  (providers/upscale.ts). Generating at 480p for a 4k request instead would
 *  be a 4.5x jump — over Topaz's cap, which computeUpscaleFactor() would
 *  otherwise silently CLAMP to 4x rather than error: a real, confirmed
 *  under-delivery bug (a "4K" file that's actually 1920px tall), which is
 *  exactly why this special case existed before this change and still does.
 *
 *  The upscale invocation itself (5-videos.ts, worker.ts) is already gated
 *  on `runtime.resolution !== runtime.generationResolution`, so returning
 *  the SAME value as `delivery` for 480p/720p/1080p correctly and
 *  automatically skips the upscale pass entirely for those tiers — no
 *  wasted Topaz call, no code change needed there. */
function generationResolutionFor(delivery: string): string {
  return delivery === "4k" ? "1080p" : delivery;
}


export const config = {
  falKey: required("FAL_KEY"),
  llmApiKey: required("LLM_API_KEY"),
  llmBaseUrl: process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1",
  llmModel: process.env.LLM_MODEL?.trim() || "gpt-4.1-mini",
  // The director/breakdown call plans the WHOLE film in one shot -- it is where
  // story logic, causal chains and continuity live or die. Falls back to llmModel
  // if unset, so this is a strict opt-in upgrade, never a silent downgrade.
  breakdownModel: process.env.BREAKDOWN_MODEL?.trim() || process.env.LLM_MODEL?.trim() || "gpt-4.1-mini",

  // The REPAIR call is a different job than the breakdown call: it does not plan
  // the film, it applies ONE of ~15 pre-written, prescriptive fixes to a SMALL
  // number of already-flagged shots ("give this beat two endpoints", "add a
  // notice-cue beat") -- mechanical text edits against an explicit rulebook, not
  // open-ended story reasoning. Defaults to breakdownModel (zero behaviour change
  // until you opt in), but this is the single biggest cost lever available: the
  // repair loop can run up to MAX_REPAIRS times per film on the SAME flagship
  // model as the one planning call that actually needs it. Point this at a
  // cheaper/faster model once you've confirmed repairs stay correct -- the
  // compiler re-validates every repaired shot afterward regardless, so a bad
  // repair is caught, not shipped silently.
  repairModel: process.env.REPAIR_MODEL?.trim() || process.env.BREAKDOWN_MODEL?.trim() || process.env.LLM_MODEL?.trim() || "gpt-4.1-mini",

  // SAFETY CAP for a single repair request. OpenAI's per-minute token limit is a HARD
  // ceiling on ONE request, not a "wait and it clears" throttle -- a request bigger than
  // the account's TPM limit for that model will 429 with "Request too large" every single
  // time, no matter how long you wait. When a repair round has many flagged shots, the
  // batch is split until each request's estimated size fits under this number. Default is
  // conservative (accounts on a low usage tier have seen limits as low as 30,000 TPM for
  // gpt-4.1); raise it if your account's rate-limit page shows more headroom.
  repairMaxInputTokens: parseInt(process.env.REPAIR_MAX_INPUT_TOKENS ?? "24000", 10) || 24000,

  // DIRECTOR'S READ-THROUGH — one extra LLM call, AFTER the compile→repair loop
  // already produced a blocker-free shot list, that reads the WHOLE film once
  // more the way a director watches an animatic before the crew shoots: not
  // checking individual shots against the rulebook (the compiler already did
  // that), but judging the SEQUENCE — is anyone doing something with no
  // motivation, does the geography/timing actually hold together across shots,
  // is a beat there only to pad the count. This is real judgment a regex check
  // structurally cannot do, so it costs one more paid call per render (see
  // config.repairModel — same cheaper/faster model as repairs, since the
  // compiler re-validates and recompiles afterward regardless of what this
  // pass changes). ON by default; set to "false" to skip it and save that call.
  directorReviewEnabled: (process.env.DIRECTOR_REVIEW_ENABLED ?? "true") === "true",

  imageModel: process.env.IMAGE_MODEL?.trim() || "fal-ai/nano-banana-2",
  imageEditModel: process.env.IMAGE_EDIT_MODEL?.trim() || "fal-ai/nano-banana-2/edit",

  // MIGRATED: Seedance 1.5 Pro -> Veo 3.1 Lite -> Kling 3.0 Turbo -> Veo 3.1
  // Lite -> Veo 3.1 FULL "Quality" tier -> Seedance 1.5 Pro, all hosted on
  // fal.ai — same FAL_KEY throughout, no new credential needed. REVERTED
  // 2026-07-28: the Veo Quality tier's $0.40/s led to a $50 render that never
  // finished; Seedance 1.5 Pro is ~8x cheaper (see spend.ts's
  // USD_PER_VIDEO_SECOND) and was this pipeline's original baseline before
  // any of the later migrations. ONE endpoint handles both i2v and flf shots
  // (Seedance's end-frame field is optional on the same call, unlike Veo's
  // two separate endpoints) — video.ts includes it only when the shot has an
  // end keyframe, so nothing calling renderShot() needs to know or care.
  videoModel: process.env.VIDEO_MODEL?.trim() || "fal-ai/bytedance/seedance/v1.5/pro/image-to-video",

  videoResolution: resolveResolution(),
  shotDuration: parseInt(process.env.SHOT_DURATION ?? "4", 10) || 4,
  maxDuration: parseInt(process.env.MAX_DURATION ?? "6", 10) || 6,

  // DELIVERY-RESOLUTION UPSCALING — see runtime.generationResolution's own
  // comment in this file and providers/upscale.ts. REAL, CONFIRMED PROVIDER
  // (not guessed): fal-ai/topaz/upscale/video, verified via a live test call
  // against a real Seedance 480p output — correct 2.25x pixel math, correct
  // H264 output, correct duration, and a visually convincing result (real
  // added texture detail, no warping/artifacts) on direct inspection.
  // DISCLOSED, ON PURPOSE: 720p/1080p tiers are reached by upscaling a 480p
  // generation rather than rendering natively at that resolution — this is a
  // real, deliberate product decision (see safa-web's resolution picker
  // copy), not something hidden from users. A real rollback lever, matching
  // this codebase's own established pattern for behavior toggles (compare
  // sceneDissolveEnabled/titleCardEnabled/cinematicBarsEnabled) — set to
  // false to revert to native per-tier generation (the pre-upscale behavior,
  // costing more per render but with no upscale pass at all).
  upscaleEnabled: (process.env.UPSCALE_ENABLED ?? "true") === "true",
  upscaleModel: process.env.UPSCALE_MODEL?.trim() || "fal-ai/topaz/upscale/video",

  // PERIODIC IDENTITY RE-ANCHOR — for LONG scenes (many consecutive chained
  // shots), aimed at long-form (10-30 min) films specifically. The existing
  // scene anchor (4-images.ts) fights drift in the ROOM over a long scene, but
  // it anchors to a RENDERED frame, not the true character sheet — small face
  // drift can still compound shot to shot for as long as one scene runs.
  // Every this-many CHAINED shots, 4-images.ts deliberately re-prioritizes the
  // character sheet over the continuity chain for one shot, accepting a small
  // risk of the environment wobbling in exchange for pulling identity back
  // toward the true reference instead of letting it keep drifting.
  identityReanchorInterval: parseInt(process.env.IDENTITY_REANCHOR_INTERVAL ?? "5", 10) || 5,

  // DEFAULT OFF, ON PURPOSE. 6-assemble.ts used to dissolve (350ms alpha cross-
  // fade) between every pair of clips inside one continuous scene. A dissolve
  // literally superimposes the outgoing clip's last frames on the incoming
  // clip's first frames — and because every clip here is an INDEPENDENTLY
  // generated render, not real continuous footage, the character's pose never
  // lines up between them. For that whole 350ms window you get two semi-
  // transparent, misaligned copies of the same person on screen: a real,
  // deterministic (100% of the time, not a probabilistic model glitch) source
  // of exactly the "merged/duplicate person" defect that is priority one to
  // eliminate. A hard cut between two clips of a continuous scene is completely
  // normal, unremarkable film grammar — the dissolve was a polish feature, not
  // a correctness one. Opt back in only after confirming it looks right on a
  // scene where consecutive shots' poses genuinely align.
  sceneDissolveEnabled: (process.env.SCENE_DISSOLVE_ENABLED ?? "false") === "true",

  // FILM GRAIN — see 6-assemble.ts / util.ts's normalizeClip(). Same reasoning
  // as colorGradeFilter: the REALISM prompt text already asks every keyframe
  // for "subtle film grain", but that is a suggestion the generation model may
  // render inconsistently (or not at all) across independent clips. A real,
  // deterministic ffmpeg noise pass applied uniformly to every clip guarantees
  // the texture is actually there and actually consistent. Luma-only (c0
  // component in YUV = Y/luma; c1/c2 = chroma, deliberately left untouched) —
  // real photochemical grain is predominantly a luminance phenomenon, and
  // adding noise to chroma too reads as colored static, not film grain.
  // UNVERIFIED strength, kept deliberately conservative: one real published
  // ffmpeg recipe for a deliberately heavy VINTAGE look used c0s=60; 6 here is
  // a fraction of that for "subtle," not "vintage." Tune after a real render —
  // this is exactly the kind of thing that's easy to judge on a real face but
  // impossible to calibrate blind.
  filmGrainEnabled: (process.env.FILM_GRAIN_ENABLED ?? "true") === "true",
  filmGrainStrength: parseInt(process.env.FILM_GRAIN_STRENGTH ?? "6", 10) || 6,

  // FINAL EXPORT ENCODE QUALITY — CONFIRMED REAL GAP, NOT A HYPOTHETICAL.
  // Every libx264 call in util.ts (normalizeClip, buildTitleCard/
  // applyEndFade, xfadeMerge) previously set NO -crf and NO -preset at all,
  // which means every one of them silently fell back to libx264's own
  // built-in defaults: CRF 23 ("reasonable web quality", not a mastering
  // target) and preset "medium" (tuned for a balance with ENCODE SPEED,
  // which matters for a live stream and does not matter at all for this
  // pipeline's export step — a local ffmpeg pass at the end of the render,
  // not a paid API call, so trading encode TIME for encode QUALITY here is
  // free). This is exactly the gap between "a video that plays fine" and
  // "Netflix-grade" delivery: CRF 23 visibly compresses fine texture
  // (specifically the film grain this same pipeline deliberately adds —
  // see filmGrainEnabled above — which is exactly the kind of high-
  // frequency detail a higher CRF crushes into blocking/banding first).
  // CRF 16 is the real-world "visually transparent / archival master"
  // range (x264's own documentation places "visually lossless" around
  // 17-18; 16 is deliberately a shade below that, not a wild guess) —
  // still a real, finite file size (nowhere near lossless numerically),
  // just past the point a viewer can tell it apart from the source.
  // "slow" preset buys several more percent efficiency at the same CRF
  // over "medium" for zero runtime-cost tradeoff that matters here — NOT
  // "veryslow", whose real, published gains over "slow" are small enough
  // not to justify its much larger time cost for a one-time local export.
  videoCrf: parseInt(process.env.VIDEO_CRF ?? "16", 10) || 16,
  videoPreset: process.env.VIDEO_PRESET?.trim() || "slow",
  // AUDIO EXPORT BITRATE — same reasoning: 128k AAC (the previous hardcoded
  // value) is a common consumer-streaming default, not a premium-delivery
  // one. 256k AAC-LC is the tier real streaming platforms' own "high
  // quality" stereo profiles commonly target — a real, achievable step up
  // with no compatibility risk (still plain stereo AAC, same container,
  // same decoder support as before).
  audioBitrate: process.env.AUDIO_BITRATE?.trim() || "256k",

  // LENS VIGNETTE — same reasoning as film grain: a real camera lens
  // naturally darkens toward the frame corners, and the REALISM prompt
  // already claims "shot on 35mm film with a real camera and lens" — this
  // makes that claim actually, deterministically true instead of hoping the
  // generation model renders it. Visually verified (real ffmpeg output,
  // reviewed by eye): ffmpeg's own DEFAULT angle (PI/5) already reads as a
  // fairly noticeable vignette; PI/6 here is the deliberately milder choice.
  vignetteEnabled: (process.env.VIGNETTE_ENABLED ?? "true") === "true",
  vignetteAngle: process.env.VIGNETTE_ANGLE?.trim() || "PI/6",

  // CINEMATIC LETTERBOX BARS — unlike film grain/vignette (photorealism aids,
  // on by default because their ABSENCE is what reads as "obviously AI"),
  // this is a pure stylistic choice, not a correctness fix — a full-frame
  // 16:9 video is equally legitimate. DEFAULT OFF, same reasoning as
  // sceneDissolveEnabled: opt in once you've confirmed you want the look, not
  // a silent default every existing project suddenly inherits. Only applies
  // when runtime.aspectRatio is 16:9 (see normalizeClip()) — bars painted
  // onto an already-vertical 9:16 or square 1:1 frame make no visual sense
  // and would just crop into the image. Bars are drawn WITHIN the existing
  // target canvas (see targetDimensions()), not by changing output
  // dimensions, so nothing else in the pipeline (aspect math, keyframe
  // generation, resolution tiers) needs to know this exists.
  cinematicBarsEnabled: (process.env.CINEMATIC_BARS_ENABLED ?? "false") === "true",
  // Fraction of the frame HEIGHT each bar (top and bottom) occupies. 0.115
  // approximates a 2.39:1 scope frame inside a 16:9 canvas. UNVERIFIED exact
  // value — same "tune after a real render" caveat as filmGrainStrength.
  cinematicBarsRatio: parseFloat(process.env.CINEMATIC_BARS_RATIO ?? "0.115"),

  // SCENE-TRANSITION DISSOLVE — a DIFFERENT feature from sceneDissolveEnabled
  // above, not a rename of it. sceneDissolveEnabled dissolves BETWEEN two
  // shots of the SAME continuous scene (an angle change) — still off, for
  // the real ghosting reason documented on it. This one dissolves at a
  // GENUINE detected time-skip (a day/night flip, or an explicit "later that
  // night"/"the next morning" phrase — see 6-assemble.ts's own
  // isGenuineTimeSkip(), which reuses the identical signal
  // TIME_OF_DAY_JUMP_NO_SKIP already validates in compiler.ts) — the
  // classic, traditionally-motivated use of a dissolve as a passage-of-time
  // cue, not a seam-smoothing trick. The underlying mechanism is the SAME
  // xfadeMerge() cross-fade, so the same "two independently-rendered clips
  // briefly superimposed" ghosting risk technically still applies — but
  // practically much lower here: a time-skip boundary is, by definition, a
  // real scene/location change, so the two frames being blended are visually
  // distinct (different setting, lighting, likely different subjects)
  // rather than the same person's face in near-identical framing, which is
  // what made the same-scene case read as a duplicate-person glitch.
  // Filter graph and truncation/padding behavior REAL-TESTED locally against
  // synthetic clips of mismatched lengths before shipping this flag as
  // default-on (see xfadeMerge() itself, already proven in production by the
  // (currently unused) same-scene feature above).
  sceneTransitionDissolveEnabled: (process.env.SCENE_TRANSITION_DISSOLVE_ENABLED ?? "true") === "true",

  // SOFT-CUT AUDIO — see softCutAssemble()'s own comment (util.ts) for the
  // full mechanism and its honest limits. Before this, 6-assemble.ts's
  // concatClips() left a true, simultaneous hard stop/start on AUDIO at
  // every boundary between scene runs — a run's own internal joins got audio
  // treatment via xfadeMerge()'s acrossfade, but only when
  // sceneDissolveEnabled/sceneTransitionDissolveEnabled turned that run into
  // a visual dissolve in the first place. Everywhere else (most of a real
  // film, since sceneDissolveEnabled defaults off) had zero audio treatment
  // at the cut at all.
  // hardCutAudioFadeSec: a short in-place fade-to-meet at a genuine scene
  // change (different location, likely different cast) — just enough to
  // avoid a click/pop and an instant full-volume jump, same "couple of
  // frames" a real editor leaves even on an otherwise-hard cut.
  hardCutAudioFadeSec: parseFloat(process.env.HARD_CUT_AUDIO_FADE_SEC ?? "0.08"),
  // sameSceneSoftCutFadeSec: a longer in-place fade at a same-scene cut that
  // ISN'T also getting a full visual dissolve (the common case, since
  // sceneDissolveEnabled above defaults off for the real ghosting reason
  // documented on it) — the honest, achievable approximation of a J-cut/
  // L-cut's "linger" feel without ever letting two independently-generated
  // clips be audible at the same instant (see softCutAssemble()'s own
  // comment for why a TRUE overlapping pre-lap isn't safely possible with
  // fixed-length clips that have no extra handle footage to borrow from).
  sameSceneSoftCutFadeSec: parseFloat(process.env.SAME_SCENE_SOFT_CUT_FADE_SEC ?? "0.30"),
  // SOUND-MASKED CUTS — if the outgoing clip's own tail is already loud right
  // where the cut happens (a footstep, a slam, a line landing hard), that
  // transient already masks the seam on its own; softening it with the full
  // fade above would blunt the very thing doing the masking. Best-effort
  // only: 6-assemble.ts's chooseBoundaryFade() measures tail loudness via
  // util.ts's measureTailLoudnessDb() (ffmpeg astats) and shortens the fade
  // toward hardCutAudioFadeSec when the tail reads notably louder than the
  // clip's own steady level; never blocks assembly if the measurement fails.
  soundMaskedCutsEnabled: (process.env.SOUND_MASKED_CUTS_ENABLED ?? "true") === "true",

  // TITLE CARD — a film with no title reads as "a pile of clips," not a
  // produced piece, which is why this defaults ON. But it's a PER-PROJECT
  // preference, not a deployment-wide mandate — see runtime.titleCardEnabled
  // below, which is what 6-assemble.ts actually reads. This config value is
  // only the fallback used when a project doesn't specify (e.g. run.ts's
  // single-user local CLI path, which never calls applyProjectSettings()).
  // NON-FATAL BY CONSTRUCTION either way (see buildTitleCard()/6-assemble.ts's
  // own try/catch): drawtext depends on the host's fontconfig setup, which we
  // cannot guarantee across every deployment target, so a failure here must
  // degrade to "no title card," never fail the render.
  // titleCardFont: a fontconfig FAMILY NAME (not a file path) — resolved via
  // libfontconfig at render time. REAL-TESTED on this box: an unresolvable
  // family name does NOT error, fontconfig silently substitutes an available
  // font (confirmed by rendering with a deliberately bogus family name and
  // getting a clean exit + valid output). "sans-serif" is the generic alias
  // fontconfig is built to always resolve, so this works unconfigured on any
  // fontconfig-enabled ffmpeg build (Linux and this Windows dev box both
  // qualify — this ffmpeg was built with --enable-fontconfig).
  titleCardEnabled: (process.env.TITLE_CARD_ENABLED ?? "true") === "true",
  titleCardFont: process.env.TITLE_CARD_FONT?.trim() || "sans-serif",
  titleCardDurationSec: parseFloat(process.env.TITLE_CARD_DURATION_SEC ?? "2.5"),

  // END FADE — a hard stop on the last frame reads as "the render ended,"
  // not "the story ended." A fade to black/silence over the final second is
  // the one-line difference between those two impressions. Applied to the
  // FINAL assembled file (once), not per-clip, so it can't fire in the
  // middle of the film. Default ON, same "absence reads as unproduced"
  // reasoning as the title card; non-fatal for the same reason.
  endFadeEnabled: (process.env.END_FADE_ENABLED ?? "true") === "true",
  endFadeDurationSec: parseFloat(process.env.END_FADE_DURATION_SEC ?? "1.0"),

  // LOUDNESS NORMALIZATION — every clip is an INDEPENDENT generation (like
  // everything else in this pipeline), so nothing guarantees consistent
  // perceived volume shot to shot; a quiet ambient beat cutting to a loud
  // dialogue beat reads as a jarring, amateur audio jump. -16 LUFS matches
  // common streaming-video targets (not the quieter -24 LUFS EBU R128
  // broadcast standard, which is calibrated for controlled listening
  // environments this content won't have — phone speakers, laptop speakers).
  // CONFIRMED FRAGILE, HANDLE WITH CARE: real-tested against ffmpeg, this
  // filter CRASHES the encoder on a perfectly, digitally silent audio track
  // (measured, not guessed) — normalizeClip() below must retry WITHOUT this
  // filter on failure, never let a loudness polish pass take down a render.
  loudnormEnabled: (process.env.LOUDNORM_ENABLED ?? "true") === "true",
  loudnormTargetLufs: parseFloat(process.env.LOUDNORM_TARGET_LUFS ?? "-16"),

  // INSTRUMENTAL SCORE (see providers/music.ts) — a real, separate paid
  // fal.ai endpoint (cassetteai/music-generator), generating one instrumental
  // bed sized to the finished film and mixed in under its existing dialogue/
  // ambience track. DEFAULT OFF, UNLIKE the other cinematic-polish flags in
  // this file (film grain, vignette): those are deterministic local ffmpeg
  // passes, verified by a real local test run. This is a NEW EXTERNAL PAID
  // ENDPOINT this pipeline has never called — its input/output shape is
  // confirmed against fal's own OpenAPI schema (fetched directly, the same
  // "raw schema over the rate-limited docs page" approach upscale.ts's own
  // comment describes) and its blog announcement, but NOT yet confirmed via
  // a live test call the way upscale.ts's Topaz integration was before IT
  // defaulted on. The MIXING side (ffmpeg amix/volume/afade) IS real-tested
  // locally against synthetic audio of both a longer and a shorter bed than
  // the film, confirming correct truncation/padding either way — only the
  // fal.ai call itself is unverified. Flip to true after running one real
  // project and confirming the result sounds right; this is exactly the kind
  // of thing that's easy to judge on a real render but impossible to
  // calibrate blind (same discipline this file already applies to film grain
  // strength and the vignette angle).
  musicEnabled: (process.env.MUSIC_ENABLED ?? "false") === "true",
  musicModel: process.env.MUSIC_MODEL?.trim() || "cassetteai/music-generator",
  // How far below the film's existing (dialogue + ambience) track the score
  // sits, in dB. -18dB is a conservative "clearly present but never
  // competing with dialogue" starting point, NOT a real mixing-engineer
  // decision — there is no dynamic ducking keyed to actual speech here (that
  // would need real per-shot voice-activity data this pipeline doesn't
  // collect), just one constant attenuation for the whole bed. Tune after
  // listening to a real render; if dialogue ever feels crowded, lower this
  // further (more negative).
  musicVolumeDb: parseFloat(process.env.MUSIC_VOLUME_DB ?? "-18"),
  musicFadeSec: parseFloat(process.env.MUSIC_FADE_SEC ?? "1.5"),

  // DIALOGUE/AMBIENCE-VS-SCORE DUCKING (see mixMusicBed() in util.ts for the
  // full real-tested mechanism and why sidechaincompress against the film's
  // own baked audio is used instead of a separate VAD pass — Seedance has no
  // separate audio stream to run VAD against, and a VAD pass on the muxed
  // mix would only approximate "something loud is happening" the same way
  // sidechain energy already does, just as a binary per-segment gate instead
  // of a continuous one). duckThreshold is LINEAR amplitude (0-1, not dB) —
  // ffmpeg's own sidechaincompress convention. Both real-tested against
  // synthetic audio (confirmed near-zero effect when the film is quiet,
  // confirmed real ~4-6dB reduction when it's loud) but UNVERIFIED against a
  // human ear on real dialogue — tune after a real render, same discipline
  // as every other DSP constant in this file.
  musicDuckThreshold: parseFloat(process.env.MUSIC_DUCK_THRESHOLD ?? "0.05"),
  musicDuckRatio: parseFloat(process.env.MUSIC_DUCK_RATIO ?? "6"),

  // SCENE AMBIENCE BED — see util.ts's synthesizeAmbienceBed()/
  // mixAmbienceBed(). Every clip's ambience (room tone, wind, crowd murmur)
  // is currently baked in independently by Seedance per SHOT (see
  // 5-videos.ts's ambienceText / shot.ambience), so its exact character can
  // shift subtly clip to clip even within one continuous scene, the same
  // "independently generated, so nothing guarantees consistency" problem
  // this pipeline fights everywhere else. DEFAULT OFF, same "new mixing
  // layer, judge it on a real render first" discipline as musicEnabled — and
  // for a stronger reason here: this does NOT call any external generation
  // model (no verified fal.ai sound-design/foley endpoint exists in this
  // pipeline's provider set — cassetteai/music-generator, the one music
  // endpoint that IS integrated, is confirmed instrumental-music-only by
  // fal's own announcement). It synthesizes a low-level, filtered-noise
  // texture per scene run (keyed off the same AMBIENCE_LIBRARY.json category
  // compiler.ts already picks — see AMBIENCE_CATEGORY_FILTERS in util.ts) and
  // mixes it under that run's own audio, ducked under dialogue via the
  // identical sidechain mechanism already proven for the instrumental score.
  ambienceBedEnabled: (process.env.AMBIENCE_BED_ENABLED ?? "false") === "true",
  // Deliberately much lower than musicVolumeDb above — this is meant to read
  // as "the room has air in it," not as its own audible layer. UNVERIFIED
  // against a real human ear, same "tune after a real render" caveat as
  // every other DSP constant in this file.
  ambienceBedVolumeDb: parseFloat(process.env.AMBIENCE_BED_VOLUME_DB ?? "-30"),
  ambienceBedDuckThreshold: parseFloat(process.env.AMBIENCE_BED_DUCK_THRESHOLD ?? "0.05"),
  ambienceBedDuckRatio: parseFloat(process.env.AMBIENCE_BED_DUCK_RATIO ?? "4"),

  // AI SONG VIDEOS (see providers/song.ts) — a full VOCAL song (lyrics +
  // music), genuinely different from musicModel above (instrumental-only).
  // fal-ai/minimax-music/v2's real input shape (prompt + lyrics_prompt) IS
  // confirmed via a real test call (2026-08-05, experiments/
  // test-minimax-music-v2-smoketest.mjs) — unlike musicModel above, this one
  // has actually been exercised for real before being wired into the
  // pipeline. Real cost per fal.ai's own product page: $0.035/generation
  // (flat per call, not per-second) — VERIFY against actual billing before
  // relying on this figure, same as every other unverified cost constant in
  // this codebase's history.
  songModel: process.env.SONG_MODEL?.trim() || "fal-ai/minimax-music/v2",

  // BROADCAST-SPEC AUDIO EXPORT (see util.ts's exportBroadcastAudio()/
  // upmixTo51()) — an ADDITIONAL delivery artifact alongside the existing
  // consumer MP4 (H.264/AAC, -16 LUFS), not a replacement: real uncompressed
  // 48kHz/24-bit LPCM WAV, loudness-normalized via an accurate 2-pass
  // loudnorm to the target below. REAL-TESTED (see util.ts's own comments):
  // independently re-measuring the output confirmed it lands within spec
  // tolerance and is genuine 24-bit PCM. DEFAULT OFF — same discipline as
  // MUSIC_ENABLED: this is a real, working new capability, but whether -27
  // LUFS actually sounds right for YOUR delivery target is something to
  // confirm by listening to a real export, not assume from a spec number
  // alone. Full IMF/JPEG2000/MXF packaging is NOT attempted — see this
  // session's own report for why that's a fundamentally different
  // deliverable type from what this flag produces.
  broadcastExportEnabled: (process.env.BROADCAST_EXPORT_ENABLED ?? "false") === "true",
  broadcastLoudnessLufs: parseFloat(process.env.BROADCAST_LOUDNESS_LUFS ?? "-27"),
  broadcastTruePeakDb: parseFloat(process.env.BROADCAST_TRUE_PEAK_DB ?? "-2"),
  // 5.1 upmix is a SEPARATE, further opt-in on top of broadcastExportEnabled
  // — see upmixTo51()'s own comment: this is an HONEST technical upmix from
  // a stereo source (L/R carry the real signal, Center is a derived sum,
  // LFE/surrounds are genuinely silent, not fabricated), not authored
  // discrete surround content. Off by default so a stereo delivery isn't
  // silently accompanied by a 5.1 file implying more than it is.
  broadcast51Enabled: (process.env.BROADCAST_51_ENABLED ?? "false") === "true",

  optionsCount: parseInt(process.env.OPTIONS_COUNT ?? "4", 10) || 4,
  // Separate knob from optionsCount (not reused) — a location's "options" are
  // generated for EVERY distinct location in the film, unconditionally, not
  // gated per-named-character the way OPTIONS_COUNT already is, so this can
  // be tuned down independently if a multi-location script makes the options
  // stage's spend too high without touching character casting at all.
  locationOptionsCount: parseInt(process.env.LOCATION_OPTIONS_COUNT ?? "4", 10) || 4,

  scriptPath: process.env.SCRIPT_PATH?.trim() || "scripts/sample.txt",
  outDir: "output",
};

/**
 * PER-PROJECT RENDER SETTINGS.
 *
 * `config` is built once at import time from .env, which is right for defaults
 * but wrong for a multi-tenant worker: every project can now choose its own
 * resolution, orientation and audio, and we charge for exactly that. The worker
 * calls applyProjectSettings() before running any paid step, and the providers
 * read from `runtime` instead of the frozen env values.
 */
export const runtime = {
  // DELIVERY resolution — what the project is priced on and what the user
  // actually receives. Read by targetDimensions() (assembly's final
  // scale/pad/grain/vignette pass, title cards, letterbox bars) — i.e.
  // everything downstream of generation. UNCHANGED semantics from before
  // upscaling existed: this is still "the resolution the finished film is
  // delivered at."
  resolution: config.videoResolution as string,
  // GENERATION resolution — what's actually sent to Seedance (see video.ts).
  // When config.upscaleEnabled, always "480p": every tier generates at the
  // cheapest resolution, and 720p/1080p delivery is reached by upscaling the
  // FINAL accepted clip (see 5-videos.ts) rather than generating natively at
  // that tier. A 480p delivery request needs no upscale at all — generation
  // and delivery resolution are simply identical for it, so nothing about
  // that path changes. See applyProjectSettings() below and
  // providers/upscale.ts for the real fal-ai/topaz/upscale/video integration
  // this enables. Set by applyProjectSettings() per-project; this default
  // only matters for run.ts's single-user local CLI path, which never calls
  // that function.
  generationResolution: (config.upscaleEnabled ? generationResolutionFor(config.videoResolution) : config.videoResolution) as string,
  aspectRatio: "16:9" as string,
  audio: (process.env.VIDEO_AUDIO ?? "true") !== "false",
  // Per-project — see applyProjectSettings() below. Defaults to config's own
  // deployment-wide default so run.ts's single-user local CLI path (which
  // never calls applyProjectSettings()) still gets a title card unless the
  // operator's own .env opts out.
  titleCardEnabled: config.titleCardEnabled as boolean,
  productImages: [] as string[],
  // Same reasoning/reset discipline as productImages below — see
  // applyProjectSettings()'s own comment.
  characterImages: [] as string[],
  // PER-JOB LOCAL SCRATCH DIR — defaults to config.outDir (the old shared
  // "output" directory) so run.ts/server.ts (single-process, single-user
  // local tools) are completely unaffected. worker.ts overrides this to a
  // job-id-namespaced subdirectory (see setJobOutDir()) before any file I/O,
  // because config.outDir is a single hardcoded path shared by every job —
  // and claimJob()'s own comment explicitly says its atomic DB claim "is what
  // lets you run more than one worker". That's true at the DATABASE level
  // (updateMany with a status guard genuinely prevents two workers rendering
  // the same job), but every handler ALSO calls rmrf(config.outDir) at its
  // own start — with an unnamespaced shared directory, a second worker
  // claiming ANY other job would delete the first worker's in-progress local
  // files (keyframes, clips, breakdown.json) out from under it mid-render,
  // the moment more than one worker process ever actually runs.
  outDir: config.outDir as string,
};

/** Call at the very start of every worker.ts job handler, before any file I/O
 *  (rmrf, mkdir, download, ...) — see runtime.outDir's own comment for why. */
export function setJobOutDir(jobId: string): void {
  runtime.outDir = `${config.outDir}/job-${jobId}`;
}

export function applyProjectSettings(p: {
  resolution?: string | null;
  aspectRatio?: string | null;
  audioEnabled?: boolean | null;
  titleCardEnabled?: boolean | null;
  productImages?: string[] | null;
  characterImages?: string[] | null;
}) {
  // Resolution IS taken from the project again, 2026-07-28 — reverted from
  // Veo (which forced 720p regardless of what was stored) back to honoring
  // the real per-project value, now that Seedance genuinely supports
  // 480p/720p/1080p(/4k via upscale, see generationResolutionFor() above). A
  // project saved with a value outside that set (there shouldn't be one, but
  // stay defensive) falls back to config's own default rather than sending
  // Seedance something it might reject. Reads the SAME RESOLUTIONS array
  // resolveResolution() above validates VIDEO_RESOLUTION against — this used
  // to be an independent literal list that "4k" would have silently failed
  // to unlock even after being added everywhere else.
  if (p?.resolution && (RESOLUTIONS as readonly string[]).includes(p.resolution)) {
    runtime.resolution = p.resolution;
  } else {
    if (p?.resolution) console.warn(`   ⚠️  project requested resolution "${p.resolution}" — not a valid tier, using ${config.videoResolution} instead.`);
    runtime.resolution = config.videoResolution;
  }
  // See runtime.generationResolution's own comment above. Reset every call
  // (not just set-when-present), same reasoning as productImages below — a
  // 1080p project followed by a 480p project must not leave the previous
  // project's generation resolution behind on this shared runtime singleton.
  runtime.generationResolution = config.upscaleEnabled ? generationResolutionFor(runtime.resolution) : runtime.resolution;
  if (p?.aspectRatio) runtime.aspectRatio = p.aspectRatio;
  if (typeof p?.audioEnabled === "boolean") runtime.audio = p.audioEnabled;
  // Same pattern as audioEnabled just above: a real project row always has a
  // real boolean here (NOT NULL column, DB default true), so this only ever
  // falls through to config.titleCardEnabled for a caller that isn't a real
  // DB-backed project (e.g. run.ts's local CLI path, which never calls this
  // function at all and so never reaches here in the first place).
  if (typeof p?.titleCardEnabled === "boolean") runtime.titleCardEnabled = p.titleCardEnabled;
  // MUST be reset every call, not just set-when-present: unlike aspectRatio/audio
  // (which only ever have one project's value at a time within a single call),
  // an ad-mode project with photos followed by a plain project with none would
  // otherwise leave the PREVIOUS project's product photos anchored in this
  // shared runtime singleton for the next project's render.
  runtime.productImages = Array.isArray(p?.productImages) ? p.productImages : [];
  // Uploaded character casting photos — see runOptions() (2-options.ts) for
  // how these bypass AI-generated look options, matched by array order.
  runtime.characterImages = Array.isArray(p?.characterImages) ? p.characterImages : [];
  console.log(`   ⚙️  render settings → ${runtime.resolution} · ${runtime.aspectRatio} · audio ${runtime.audio ? "ON" : "OFF"}${runtime.productImages.length ? ` · ${runtime.productImages.length} product photo(s)` : ""}${runtime.characterImages.length ? ` · ${runtime.characterImages.length} character photo(s)` : ""}`);
}

/**
 * The actual pixel frame the user asked for. Seedance's image-to-video output
 * follows the INPUT KEYFRAME's shape, and ffmpeg assembly then has to match it,
 * so resolution + orientation must agree in three places or the film silently
 * comes out 16:9 720p regardless of what was picked (and paid for).
 *
 * `resolution` defaults to runtime.resolution (DELIVERY) — every existing
 * caller (assembly's normalize pass, title cards, letterbox bars) means
 * "the final output frame" and is completely unaffected by upscaling
 * existing. Pass an explicit override (e.g. runtime.generationResolution) to
 * compute a DIFFERENT tier's dimensions instead — see providers/upscale.ts,
 * which needs both the generation and delivery pixel sizes at once to
 * compute a real upscale_factor.
 */
// Explicit lookup, not a ternary chain — the ternary version silently fell
// through to 720 for ANY unrecognized string, including "4k" before this was
// added (no error, no warning, just a quietly wrong frame size). An unknown
// value still falls back to 720 here, but as a deliberate, visible default in
// one place, not an accident of ternary ordering.
const RESOLUTION_SHORT_SIDE: Record<string, number> = { "480p": 480, "720p": 720, "1080p": 1080, "4k": 2160 };
export function targetDimensions(resolution: string = runtime.resolution): { w: number; h: number } {
  const short = RESOLUTION_SHORT_SIDE[resolution] ?? 720;
  switch (runtime.aspectRatio) {
    case "9:16": return { w: short, h: Math.round((short * 16) / 9 / 2) * 2 };
    case "1:1":  return { w: short, h: short };
    default:     return { w: Math.round((short * 16) / 9 / 2) * 2, h: short };
  }
}

/** Nano Banana aspect string for keyframes — must match the video orientation. */
export function keyframeAspect(): string {
  return runtime.aspectRatio === "9:16" ? "9:16" : runtime.aspectRatio === "1:1" ? "1:1" : "16:9";
}