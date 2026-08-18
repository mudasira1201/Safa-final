import { z } from "zod";

export const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  appearance: z.string(),
  /**
   * Voice archetype, chosen by the director from the character's age/gender.
   *
   * LOAD-BEARING (comment corrected 2026-08-04 — a prior version of this
   * comment claimed it was unused; that stopped being true once genderLock()
   * (steps/2-options.ts) started reading it as the PRIMARY signal to lock a
   * character's gender in image-generation prompts, fixing a real confirmed
   * bug — "Woman Courier" rendered as a man because a trench coat and
   * briefcase read male to the model with nothing contradicting it). Audio
   * itself still comes from the video model's native generate_audio, which
   * casts its own voices — this field's job is the gender-lock signal, not
   * TTS casting.
   */
  voice: z
    .enum(["male_young", "male_adult", "male_old", "female_young", "female_adult", "female_old", "child", "narrator"])
    .default("narrator"),
});

/**
 * ONE character's psychology for ONE scene — see llm.ts's own "CHARACTER
 * PSYCHOLOGY" section for what breakdownScript() is asked to populate here
 * and why. Additive field (see Breakdown.characterSceneStates below): a
 * breakdown compiled before this existed simply has an empty array, and
 * every consumer (directorReadThrough()'s psychology check) treats that as
 * "nothing to check" rather than an error — the same backward-compatibility
 * discipline domainPack already established for this schema.
 */
export const CharacterSceneStateSchema = z.object({
  characterId: z.string(),
  /** Matches a Shot.scene value — the same grouping key sameScene()-adjacent
   *  logic in compiler.ts already keys scene runs off. */
  sceneKey: z.string(),
  objective: z.string(),
  emotionalStateEntering: z.string(),
  /** null when the emotional state did NOT change across the scene — not an
   *  empty string, so "unspecified" and "explicitly unchanged" can never be
   *  confused by a downstream consumer. */
  emotionalStateExiting: z.string().nullable().default(null),
  /** otherCharacterId -> a short phrase for how this character regards them
   *  right now. Only characters actually present with them in this scene. */
  relationshipStance: z.record(z.string(), z.string()).default({}),
});
export type CharacterSceneState = z.infer<typeof CharacterSceneStateSchema>;

/**
 * Estimated DIEGETIC (story-time) duration for ONE scene — additive field,
 * same backward-compatibility discipline as CharacterSceneStateSchema just
 * above: a breakdown compiled before this existed has an empty array, and
 * compiler.ts's WORLD_STATE_TIME_DRIFT check treats that as "nothing to
 * validate against" and falls back to its original qualitative-only check,
 * never as an error. Distinct from Shot.screenSeconds, which is RENDER
 * time — a 5-second shot can represent a story moment lasting anywhere from
 * an instant to hours; this field is the breakdown LLM's own estimate of the
 * latter, only useful in aggregate at the SCENE level (a single shot's
 * story-time span isn't a meaningful unit here).
 */
export const SceneDurationSchema = z.object({
  /** Matches a Shot.scene value — same convention as
   *  CharacterSceneStateSchema.sceneKey above. */
  sceneKey: z.string(),
  /** Best estimate of how much story time this scene's events span, in
   *  MINUTES — not render/screen time. A quick exchange in a doorway might
   *  be 1-2; a stakeout or a slow meal might be 60+. */
  estimatedMinutes: z.number(),
});
export type SceneDuration = z.infer<typeof SceneDurationSchema>;

/**
 * Per-character action attribution — ADDITIVE, optional (defaults to []
 * for old data / when the breakdown LLM omits it). `motion` remains the
 * holistic beat-by-beat timeline the renderer actually reads; this field
 * exists so compileBreakdown()'s action-precondition/effect validation
 * (WORLD_STATE_ACTION_CONTRADICTION) can attribute a shot's actions to
 * specific characters when 2+ are present, instead of skipping every
 * multi-character shot for lack of attribution. For a single-character
 * shot this is safely omittable — the compiler falls back to `motion`.
 */
export const CharacterActionSchema = z.object({
  characterId: z.string(),
  /** This character's own physical action in the shot, in their own words —
   *  a subset/rephrasing of `motion`, not a duplicate of the whole field. */
  action: z.string(),
});
export type CharacterAction = z.infer<typeof CharacterActionSchema>;

/**
 * Structured intended direction of travel for this shot's motion —
 * additive, optional (null when no clear directional intent applies, e.g.
 * a static gesture or dialogue beat). Confirmed real gap: a script stating
 * a character "crosses the road toward camera" rendered them walking AWAY
 * instead, with nothing checking the render against the script's own
 * stated direction other than the vision QA pass inferring it from loose
 * prose. This field gives that same existing QA check (qa.ts's
 * reversed_motion finding kind, already built) an unambiguous signal to
 * verify against instead of relying purely on inference, and lets
 * compileBreakdown() reassert it as an explicit prompt constraint the same
 * way anatomy negatives are reasserted every render call.
 */
export const MotionDirectionSchema = z.enum([
  "toward_camera", "away_from_camera", "left_to_right", "right_to_left", "forward", "backward",
]);
export type MotionDirection = z.infer<typeof MotionDirectionSchema>;

/**
 * Gap A — a STORY-SIGNIFICANT prop as a first-class entity, the same
 * structural upgrade characters already got over plain name strings. Before
 * this, every prop (a ball, a bat, a letter, a parcel, a phone) existed only
 * as free text inside shot.description/motion — compiler.ts's PROP_NOUNS
 * regex list could remind a shot "the same object as established earlier"
 * but had no reference IMAGE to lock appearance against (the mechanism
 * characters have always had via characters.json's reference sheet) and no
 * structured way to validate introduction/persistence deterministically.
 * Deliberately NOT every incidental object in a script — only ones
 * significant enough that appearance/continuity actually matters to the
 * story (a wedding ring, a getaway car's license plate, a specific weapon),
 * the same selectivity discipline characterActions already uses for which
 * shots get per-character attribution.
 */
export const PropSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Real-world appearance: shape, size, material, color, distinguishing
   *  marks — the same role Character.appearance plays for a face. */
  description: z.string(),
});
export type Prop = z.infer<typeof PropSchema>;

export const ShotSchema = z.object({
  id: z.string(),
  scene: z.string(),
  description: z.string(),
  setting: z.string().default(""),
  characters: z.array(z.string()).default([]),
  characterActions: z.array(CharacterActionSchema).default([]),
  motionDirection: MotionDirectionSchema.nullable().default(null),
  /** Which Breakdown.props ids are visibly present in this shot — additive,
   *  same "id list, not embedded objects" convention `characters` already
   *  uses. Empty for the vast majority of shots (most props aren't
   *  story-significant enough to track this way); see PropSchema above. */
  props: z.array(z.string()).default([]),
  crowd: z.preprocess((v) => v === true || v === "true", z.boolean()).default(false),
  speaker: z.string().nullable().default(null),
  dialogue: z.string().default(""),
  camera: z.string().default(""),
  lighting: z.string().default(""),
  motion: z.string().default(""),

  // ── NEW · emitted by the LLM ──────────────────────────────────────────────
  /**
   * The speaker is HEARD but not SEEN (earpiece, phone, radio, VO).
   * Their id must NOT appear in `characters`, and they must NOT appear in the
   * top-level cast — a voice has no body. This one boolean is the difference
   * between a reaction shot and a stranger materialising in your market.
   */
  offscreenSpeaker: z.boolean().default(false),

  /** Physical description of the FIRST frame. "" for ordinary shots. */
  startFrame: z.string().default(""),

  /**
   * Physical description of the LAST frame. Non-empty ⇒ render by interpolating
   * between two fixed images (first-last-frame). Use for every airborne beat:
   * the model cannot stall, because it knows where it has to land.
   */
  endFrame: z.string().default(""),

  // ── NEW · written by compileBreakdown(), never by the LLM ─────────────────
  method: z.enum(["i2v", "flf"]).default("i2v"),
  negativePrompt: z.string().default(""),

  /**
   * A STABLE identity for "which physical location is this," shared by every
   * shot recognized as the same place — including a REVISIT much later in
   * the shot list, not just a contiguous run of the same scene. Derived from
   * that location's own richest setting text (see compileBreakdown()'s
   * assignment pass), so it stays stable across a later regen_shot/
   * delete_shot/insert_shot recompile as long as the location's own
   * description doesn't change, unlike a shot-index-based id would.
   * "" (default) for a location visited only once — see 3c-locations.ts's
   * own comment for why only a genuinely revisited location gets a
   * generated reference sheet at all.
   */
  locationId: z.string().default(""),

  /**
   * WAS: z.coerce.number().default(0)
   * If the LLM ever omitted duration you silently got a ZERO-SECOND SHOT.
   * Clamped to 4-8 by the compiler (the video provider rejects anything under 4); see the note there about why "longer for
   * action" is backwards for AI video.
   */
  duration: z.coerce.number().default(4),

  /**
   * INTENDED on-screen time for this shot, in seconds — MAY be authored by
   * the LLM as a fractional value under Seedance's real 4-second generation
   * floor (e.g. 1.3) for a rapid-cut sequence. 0 (default) means "not
   * specified, use the full rendered clip" — the ordinary, unchanged
   * behavior for every existing script.
   *
   * REAL PROVIDER CONSTRAINT, CONFIRMED BY DIRECT TESTING (not assumed):
   * Seedance 1.5 Pro cannot render a native sub-4s clip, AND does not honor
   * "Shot 1... cut to Shot 2..." labeling as an editorial hard cut within one
   * generation — a live test render (empty table -> "cut to" confetti
   * already settled) came back as a smooth, physically continuous confetti
   * explosion animated over ~1 second, not an edit. So a beat shorter than
   * 4s has exactly one path to a real hard cut: render at Seedance's 4s
   * floor (see compileBreakdown()'s R5, which forces `duration` to 4 the
   * moment this field is under 4), then TRIM the rendered clip down to this
   * many seconds in 6-assemble.ts before concatenation. This costs more per
   * second of final footage than an ordinary shot (paying for a full 4s
   * render to keep a fraction of it) — deliberate, not a bug: the
   * alternative is either no sub-4s cuts at all, or trusting the model to
   * "cut" internally, which the test above just disproved.
   */
  screenSeconds: z.coerce.number().default(0),

  /**
   * Per-shot SFX/room-tone direction for the video model's native audio
   * (generate_audio) — never by the LLM, always by compileBreakdown() (see
   * AMBIENCE_LIBRARY.json / ambienceFor() in compiler.ts). A shot that never
   * says anything about its soundscape defaults to dead silence or a guess,
   * which is one of the more obvious "not a real production" tells; this
   * makes the ambience an explicit, deterministic per-shot decision keyed
   * off the shot's own setting/description text, the same "compiler
   * discipline over LLM guessing" reasoning as colorPalette.
   */
  ambience: z.string().default(""),

  /**
   * RUNNING TIMECODE — never authored by the LLM, always computed by
   * compileBreakdown() as the LAST step, after every shot's real
   * duration/screenSeconds has been finalized. A cumulative sum of
   * screenSeconds (the real ON-SCREEN time, correctly reflecting a trimmed
   * rapid-cut beat — see screenSeconds's own comment) across the shot list
   * in order, formatted "MM:SS" (or "HH:MM:SS" once the film runs past an
   * hour). timecodeStart is where this shot begins in the final assembled
   * film; timecodeEnd is timecodeStart + this shot's own screenSeconds. This
   * is DISPLAY/REVIEW information — nothing downstream (5-videos.ts,
   * 6-assemble.ts) reads it for rendering, since actual assembly order and
   * duration are already fully determined by the shot list order and
   * screenSeconds/duration themselves; this only makes that same timeline
   * legible to a human reviewing the plan, matching a real shot list's
   * "00:00–00:04, 00:04–00:06, ..." convention.
   */
  timecodeStart: z.string().default(""),
  timecodeEnd: z.string().default(""),

  /**
   * SONG VIDEOS ONLY — which song section (see LyricsSectionSchema below)
   * this shot's visuals belong to, e.g. "verse-1", "chorus-1". Additive,
   * same lifecycle discipline as characterSceneStates/sceneDurations: null
   * for every ordinary narrative-film shot, never read by anything outside
   * the song-video path. Used as this shot's `scene` grouping key so
   * 4-images.ts's existing sameScene()-chained keyframe continuity works
   * unchanged within one section, and so a section's real audio duration
   * (from SongResult.sections) can drive this section's shots' total
   * screenSeconds instead of freeform narrative pacing.
   */
  songSection: z.string().nullable().default(null),
});

/**
 * ONE section of an AI-generated song's lyrics (verse/chorus/bridge/etc) —
 * see generateLyrics() in llm.ts. `tag` matches the structure tags
 * fal-ai/minimax-music/v2's lyrics_prompt field understands (confirmed via
 * a real test call, 2026-08-05): Intro, Verse, Pre Chorus, Chorus, Post
 * Chorus, Hook, Bridge, Interlude, Transition, Build Up, Break, Inst, Solo,
 * Outro. `lines` are the actual sung words for this section — joined with
 * the tag into the flat `[tag]line1\nline2...` string the song model's API
 * actually expects (see song.ts's own prompt-building comment for why this
 * schema stays structured rather than storing that flat string directly:
 * the breakdown step needs each section's own line COUNT to estimate a
 * proportional share of the song's real total duration, since the song
 * model's response has no section-timing metadata of its own — confirmed
 * via the same real test call).
 */
export const LyricsSectionSchema = z.object({
  tag: z.enum([
    "Intro", "Verse", "Pre Chorus", "Chorus", "Post Chorus", "Hook", "Bridge",
    "Interlude", "Transition", "Build Up", "Break", "Inst", "Solo", "Outro",
  ]),
  lines: z.array(z.string()).default([]),
});
export type LyricsSection = z.infer<typeof LyricsSectionSchema>;

/**
 * Full output of generateLyrics() (llm.ts) — everything needed to call
 * song.ts's generateSong() and, once that returns real audio duration, to
 * plan a song-video Breakdown timed against these sections.
 */
export const LyricsResultSchema = z.object({
  title: z.string(),
  /** Goes into the song model's `prompt` (style) field — mood/genre/
   *  instrumentation only, NEVER a real artist/band name (see generateLyrics()'s
   *  own system-prompt instruction, the compliance guard against
   *  requesting "sounds like [real artist]"). */
  stylePrompt: z.string(),
  sections: z.array(LyricsSectionSchema),
});
export type LyricsResult = z.infer<typeof LyricsResultSchema>;

export const BreakdownSchema = z.object({
  title: z.string(),
  characters: z.array(CharacterSchema),
  shots: z.array(ShotSchema),

  /**
   * Locked ONCE for the whole film by compileBreakdown() (never by the LLM —
   * see pickColorPalette() in compiler.ts), so every shot's keyframe holds the
   * same color grade instead of each one quietly picking its own. Empty until
   * the first compile; stays locked afterward even across shot repairs/edits.
   */
  colorPalette: z.string().default(""),

  /**
   * The SAME locked palette's real ffmpeg -vf filter chain (see
   * COLOR_PALETTES.json's ffmpegFilter field), applied deterministically to
   * every clip in 6-assemble.ts. colorPalette above is a PROMPT hint the
   * generation model may or may not follow consistently across dozens of
   * independent renders; this is a real pixel transform that doesn't depend
   * on model compliance. Empty string = no post-process grade (the
   * naturalistic_neutral palette's own filter, or any project compiled
   * before this field existed).
   */
  colorGradeFilter: z.string().default(""),

  /**
   * The real-world domain/genre pack (see llm.ts's DOMAIN_PACKS/getDomainPack)
   * detected for this film, if any — e.g. cricket, courtroom, house-horror.
   * Set ONCE by breakdownScript() (never re-derived by a shot regen/insert/
   * repair pass, which all edit an EXISTING breakdown and so just carry this
   * field forward unchanged). Persisted here — not just used to build the
   * planning prompt and discarded — so compileBreakdown() can deterministically
   * fold pack.negatives/physicsRules into every shot's negativePrompt at
   * render time too, not just at planning time. Optional: most films have no
   * special domain ("general"), and older breakdowns compiled before this
   * field existed simply have none.
   */
  domainPack: z
    .object({
      key: z.string(),
      correctEquipment: z.array(z.string()).default([]),
      requiredWardrobe: z.array(z.string()).default([]),
      roleRules: z.array(z.string()).default([]),
      negatives: z.array(z.string()).default([]),
      physicsRules: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),

  /**
   * See CharacterSceneStateSchema's own comment. Set ONCE by breakdownScript()
   * (same lifecycle as domainPack — never re-derived by a shot regen/insert/
   * repair pass, which all carry it forward unchanged), consumed by
   * directorReadThrough()'s psychology-contradiction check. Empty array for
   * any breakdown compiled before this field existed, or if the LLM simply
   * returned none — every consumer treats an empty array as "nothing to
   * check," never as a missing-data error.
   */
  characterSceneStates: z.array(CharacterSceneStateSchema).default([]),

  /**
   * See SceneDurationSchema's own comment. Same lifecycle as
   * characterSceneStates above — set once by breakdownScript(), carried
   * forward unchanged by every later pass, empty array for any breakdown
   * compiled before this field existed. Consumed by compiler.ts's
   * WORLD_STATE_TIME_DRIFT check to upgrade from a qualitative-only
   * day/night contradiction check to a quantified one wherever a scene's
   * duration is known.
   */
  sceneDurations: z.array(SceneDurationSchema).default([]),

  /** See PropSchema's own comment. Same lifecycle as characters — set once
   *  by breakdownScript(), carried forward unchanged by shot regen/insert/
   *  repair passes, empty array for any breakdown compiled before this
   *  field existed or when the LLM found no story-significant props. */
  props: z.array(PropSchema).default([]),

  /**
   * The film's SPOKEN language as an ISO 639-1 code (see lib/languages.ts) —
   * which language every `Shot.dialogue` is written in, and which language the
   * video model is told to speak. Defaults to "en", so any breakdown created
   * before this field existed behaves exactly as it always did.
   *
   * ONLY dialogue is affected. Every other field stays English because they are
   * prompts for the image/video models, not prose — see lib/languages.ts's own
   * comment for the full rule.
   *
   * Written by runBreakdown() from the script's "[Language: ...]" tag, NEVER by
   * the LLM (same discipline as colorPalette/domainPack above: the LLM echoing
   * a field it doesn't own is how a value silently drifts). Every later pass —
   * shot regen, insert, repair — reads it back off the breakdown rather than
   * re-parsing the script, which is what keeps a regenerated shot from quietly
   * reverting to English.
   */
  language: z.string().default("en"),
});

export type Character = z.infer<typeof CharacterSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type Breakdown = z.infer<typeof BreakdownSchema>;

// charId -> list of reference-image URLs (the multi-angle character sheet)
export type CharacterRefs = Record<string, string[]>;

// propId -> list of reference-image URLs (the prop sheet — see PropSchema
// and steps/3b-props.ts's runPropSheet()). Same shape as CharacterRefs on
// purpose: every consumer that already knows how to read a *Refs map
// (4-images.ts's ref-budgeting, qa.ts's runQA()) needs no new logic, just a
// second map passed alongside the character one.
export type PropRefs = Record<string, string[]>;

// locationId -> list of reference-image URLs (the location sheet — see
// Shot.locationId, compileBreakdown()'s LOCATION IDENTITY pass, and
// steps/3c-locations.ts's runLocationSheet()). Same shape as CharacterRefs/
// PropRefs on purpose, same reason. Only genuinely revisited locations get
// an entry — see 3c-locations.ts for that scoping decision.
export type LocationRefs = Record<string, string[]>;

// charId -> { name, chosen (1-based), options: option image URLs }
export type Selections = Record<string, { name: string; chosen: number; options: string[] }>;

// locationId -> { name, chosen (1-based), options: option image URLs }. Same
// shape as Selections on purpose, same reason (every consumer that already
// knows how to read one needs no new logic) — see 2b-location-options.ts's
// runLocationOptions(). Unlike LocationRefs above (the locked multi-angle
// SHEET, revisited-locations-only), this exists for EVERY distinct location
// in the film — the user's initial "which look for this place" pick, made
// alongside character casting, before any revisit-consistency question
// applies at all.
export type LocationSelections = Record<string, { name: string; chosen: number; options: string[] }>;