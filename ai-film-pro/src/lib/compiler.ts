/**
 * src/lib/compiler.ts
 * ---------------------------------------------------------------------------
 * The deterministic gate between the LLM plan and everything you pay for.
 * Runs at the END of step 1, BEFORE step 2 (options) and step 3 (sheet).
 *
 * GOVERNING LAW:
 *   The renderer does not "perform an action." It generates the motion BETWEEN
 *   TWO STILL IMAGES. Give it two good photographs and it invents the physics.
 *   Give it one and it extrapolates blind — so it holds a pose to burn frames.
 *
 * SEVERITY DISCIPLINE (this is what was breaking the pipeline):
 *   - STRUCTURAL FACTS block. "Does this shot have an endFrame or not" has zero
 *     false positives, so it is safe to halt a paid run on it.
 *   - FUZZY TEXT GUESSES only WARN. A regex guessing whether a sentence describes
 *     an un-photographable pose WILL misfire, and a misfire that halts the run is
 *     worse than no check at all. It logs, the human sees it, the run proceeds.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config";
import type { Breakdown, Shot, MotionDirection } from "../types";
import {
  type SpatialFact, type ActionRule,
  CORE_ACTION_LIBRARY, checkPrecondition, applyEffect, resolveReferentPlaceholders,
  resolveInstanceReferents, findActionPose,
} from "./actionLibrary";
import { type StagingRule, CORE_STAGING_LIBRARY, checkStaging } from "./stagingLibrary";
import {
  createWorldState, getHolding, setHolding, type WorldState,
  HELD_OBJECT_RE, HELD_OBJECT_CLEARED_RE, PROP_ACQUISITION_RE, HELD_OBJECT_ESTABLISH_RE, PASSIVE_CARRY_RE,
  OBJECT_ALREADY_HELD_RE,
  getOrCreateLocation,
  OVERTAKE_WORDS, extractAheadPair,
  getSpatialState, setSpatialState,
} from "./worldState";

// ── ACTION PRECONDITION/EFFECT INFERENCE CACHE ───────────────────────────────
// NOT the same system as ACTION_LIBRARY.json below (that one enriches MOTION
// TEXT with biomechanical detail — how a run looks). This is
// lib/actionLibrary.ts's CORE_ACTION_LIBRARY plus this cache: whether an
// action's PHYSICAL PRECONDITIONS are satisfied given a character's tracked
// spatial state (see the WORLD-STATE CHARACTER SPATIAL STATE block, further
// below, for where CORE_ACTION_LIBRARY + this cache are actually matched).
//
// Module-level (not inside compileBreakdown()) so it persists across EVERY
// compileBreakdown() call for the lifetime of this Node process — repair
// rounds within one runBreakdown(), and even separate projects handled by
// the same long-running worker, all benefit from an action inferred once.
// HONEST LIMIT: this is IN-MEMORY ONLY, not persisted to a file or the
// database — a worker process restart loses every previously-inferred
// action, which then simply gets re-inferred (and re-cached) the next time
// it's encountered. compileBreakdown() itself stays fully SYNCHRONOUS (many
// existing callers depend on that, same reasoning ACTION_LIBRARY.json's own
// comment below states) — an action neither in CORE_ACTION_LIBRARY nor this
// cache is NOT inferred inline; it's collected into compileBreakdown()'s
// returned `pendingActionInferences` list for the CALLER (1-breakdown.ts) to
// resolve asynchronously via providers/llm.ts's inferActionRule(), cache via
// cacheInferredAction() below, then recompile — the exact same
// "compile -> async work -> recompile" shape repairShots()/
// directorReadThrough() already use, not a new pattern.
const actionInferenceCache = new Map<string, ActionRule>();

/** Normalizes raw shot text into the cache key both the cache-check (during
 *  compile) and the cache-write (after inference) use — lowercased,
 *  whitespace-collapsed, trimmed. Two shots with LITERALLY identical authored
 *  text (a recompile of the same unchanged shot, or two genuinely identical
 *  phrasings) hit the same cache entry; two different phrasings of what a
 *  human would call "the same action" do NOT — a real, stated limitation of
 *  text-key caching without deeper NLP matching, not a silently accepted one. */
export function normalizeActionKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Called by 1-breakdown.ts after a successful providers/llm.ts inferActionRule()
 *  call, to make that inference available to every subsequent compile — including
 *  the recompile 1-breakdown.ts performs immediately afterward. */
export function cacheInferredAction(key: string, rule: ActionRule): void {
  actionInferenceCache.set(key, rule);
}

// Gap B — DOMAIN/STAGING PLAUSIBILITY. Same "collect during sync compile,
// resolve async in the caller, recompile" shape as the action-inference
// cache just above — see lib/stagingLibrary.ts's own top-of-file comment
// for the full picture. Keyed by sceneKey() (staging is a SCENE/DOMAIN-level
// fact, not a per-shot one, unlike action rules).
const stagingInferenceCache = new Map<string, StagingRule>();
export function cacheInferredStaging(key: string, rule: StagingRule): void {
  stagingInferenceCache.set(key, rule);
}

// ── ACTION LIBRARY ──────────────────────────────────────────────────────────
// The LLM breakdown writes a generic verb ("he walks over and hands her the
// parcel") and leaves the video model to improvise the actual physical
// mechanics from scratch — exactly where AI video looks least human. This
// loads a curated library (src/director/ACTION_LIBRARY.json) of common
// physical actions, each with a real, biomechanically-specific description of
// how it looks performed naturally, plus action-specific negative-prompt
// terms. Loaded once, synchronously, at module scope — compileBreakdown() is
// a SYNC function (many callers depend on that), so this can't be an async
// file read the way loadDirectorRules() in llm.ts is. Missing/malformed file
// degrades to an empty library (a no-op), same tolerance as director rules.
interface ActionLibraryEntry {
  key: string;
  triggerPattern: string;
  marker: string;
  description: string;
  negatives: string[];
}
function loadActionLibrary(): (ActionLibraryEntry & { re: RegExp })[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "director", "ACTION_LIBRARY.json"), "utf8");
    const parsed = JSON.parse(raw) as { actions?: ActionLibraryEntry[] };
    return (parsed.actions ?? []).map((a) => ({ ...a, re: new RegExp(a.triggerPattern, "i") }));
  } catch {
    return [];
  }
}
const ACTION_LIBRARY = loadActionLibrary();
// Cap how many distinct action enrichments land on ONE shot — a shot that
// happens to match several triggers (rare, but "he walks over, sits down and
// hands her the parcel" could) still only gets the two most relevant, so the
// prompt doesn't grow without bound as the library grows over time.
const MAX_ACTIONS_PER_SHOT = 2;

/** Which library entries apply to this text, in library order, capped. Called
 *  independently by the injection step and by negativeFor() — both derive the
 *  same result from the same (authored) text rather than passing state between them. */
function matchActions(text: string): (ActionLibraryEntry & { re: RegExp })[] {
  return ACTION_LIBRARY.filter((a) => a.re.test(text)).slice(0, MAX_ACTIONS_PER_SHOT);
}


// ── LIGHTING LIBRARY ─────────────────────────────────────────────────────────
// Same architecture as ACTION_LIBRARY above, applied to LIGHT instead of
// MOTION (src/director/LIGHTING_LIBRARY.json) — the LLM writes a generic mood
// word ("dramatic lighting") and leaves the image model to improvise the
// actual optical behavior, which is where AI images default to a flat,
// evenly-lit look. Unlike actions (capped at 2 — can coexist), only the
// SINGLE best match applies here: two lighting moods on one shot are far more
// likely to contradict each other than two simultaneous physical actions.
interface LightingLibraryEntry {
  key: string;
  triggerPattern: string;
  marker: string;
  description: string;
  negatives: string[];
}
function loadLightingLibrary(): (LightingLibraryEntry & { re: RegExp })[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "director", "LIGHTING_LIBRARY.json"), "utf8");
    const parsed = JSON.parse(raw) as { moods?: LightingLibraryEntry[] };
    return (parsed.moods ?? []).map((m) => ({ ...m, re: new RegExp(m.triggerPattern, "i") }));
  } catch {
    return [];
  }
}
const LIGHTING_LIBRARY = loadLightingLibrary();
const MAX_LIGHTING_PER_SHOT = 1;

function matchLighting(text: string): (LightingLibraryEntry & { re: RegExp })[] {
  return LIGHTING_LIBRARY.filter((m) => m.re.test(text)).slice(0, MAX_LIGHTING_PER_SHOT);
}

// ── REACTION LIBRARY ─────────────────────────────────────────────────────────
// Same architecture as LIGHTING_LIBRARY above, applied to FACIAL/BODY REACTION
// PHYSIOLOGY instead of light (src/director/REACTION_LIBRARY.json). The LLM
// breakdown writes a generic reaction label ("he looks shocked") and leaves
// the video model to default to the single most common AI-video reaction
// tell: an instant, perfectly symmetric expression that snaps into place on
// frame one, with no anticipation and no asymmetry. Only the SINGLE best
// match applies (a shot has one dominant reaction beat, not several).
interface ReactionLibraryEntry {
  key: string;
  triggerPattern: string;
  marker: string;
  description: string;
  negatives: string[];
}
function loadReactionLibrary(): (ReactionLibraryEntry & { re: RegExp })[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "director", "REACTION_LIBRARY.json"), "utf8");
    const parsed = JSON.parse(raw) as { reactions?: ReactionLibraryEntry[] };
    return (parsed.reactions ?? []).map((r) => ({ ...r, re: new RegExp(r.triggerPattern, "i") }));
  } catch {
    return [];
  }
}
const REACTION_LIBRARY = loadReactionLibrary();
const MAX_REACTION_PER_SHOT = 1;

function matchReaction(text: string): (ReactionLibraryEntry & { re: RegExp })[] {
  return REACTION_LIBRARY.filter((r) => r.re.test(text)).slice(0, MAX_REACTION_PER_SHOT);
}

// ── PACE LIBRARY ─────────────────────────────────────────────────────────────
// Same architecture as LIGHTING_LIBRARY above, applied to a shot's EMOTIONAL
// TEMPO instead of its optics (src/director/PACE_LIBRARY.json). Lighting and
// color are already locked per-mood; motion speed/sharpness was not — a tense
// chase and a quiet funeral got the same generic "clear, visible body
// movement" framing regardless of tone. Only the SINGLE best match applies
// (tempos contradict each other, same reasoning as lighting moods), and it
// seasons TWO fields from that one match: `motion` (how the character moves)
// and `camera` (how the camera moves) — one shared source so the two can
// never disagree about how urgent or unhurried a shot feels.
interface PaceLibraryEntry {
  key: string;
  triggerPattern: string;
  marker: string;
  description: string;
  cameraMarker: string;
  cameraNote: string;
  negatives: string[];
}
function loadPaceLibrary(): (PaceLibraryEntry & { re: RegExp })[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "director", "PACE_LIBRARY.json"), "utf8");
    const parsed = JSON.parse(raw) as { paces?: PaceLibraryEntry[] };
    return (parsed.paces ?? []).map((p) => ({ ...p, re: new RegExp(p.triggerPattern, "i") }));
  } catch {
    return [];
  }
}
const PACE_LIBRARY = loadPaceLibrary();
const MAX_PACE_PER_SHOT = 1; // tempos contradict each other, like lighting moods -- never combine two.

function matchPace(text: string): (PaceLibraryEntry & { re: RegExp })[] {
  return PACE_LIBRARY.filter((p) => p.re.test(text)).slice(0, MAX_PACE_PER_SHOT);
}

// ── FACELESS-AD BODY-MECHANICS TEXTS ─────────────────────────────────────────
// Every compiler-injected sentence that describes a HUMAN BODY — limbs, face,
// breath, weight. Used two ways, both AD MODE ONLY (see ACTION LIBRARY
// INJECTION's own comment for the failure and for why the film path is
// deliberately left alone): compileBreakdown() skips producing these for an ad
// shot with an empty cast, and stripBodyMechanics() below removes any that an
// EARLIER compile already baked into a stored ad breakdown.
//
// Deliberately NOT the same list as LIBRARY_INJECTED_TEXTS further below, which
// exists for a different question (what authoredOnly() must discount when
// measuring authored richness) and so also covers LIGHTING/LENS/CAMERA_MOVE —
// none of which describe a body, and all of which a product-only shot still
// legitimately wants. PACE contributes only its `description` here for exactly
// that reason: its `cameraNote` is camera language, injected into shot.camera,
// and must survive.
const BODY_MECHANICS_TEXTS: string[] = [
  ...ACTION_LIBRARY.map((a) => a.description),
  ...REACTION_LIBRARY.map((r) => r.description),
  ...PACE_LIBRARY.map((p) => p.description),
  // The two fixed, non-library sentences injected inline by compileBreakdown()
  // (ground contact, and the TENSE_HOSTILE emotion lock) — literal, unvarying
  // strings, so they strip exactly like the library descriptions do.
  "Both feet make firm, visible contact with the ground throughout.",
  "The subject's expression stays hard and intense throughout — no smiling, no relaxing, no softening.",
].filter(Boolean);

/** Removes any body-mechanics sentence already injected into a shot's text.
 *  AD MODE ONLY at every call site.
 *
 *  Exported because two callers need it for two different reasons:
 *  compileBreakdown() cleans the STORED breakdown (permanent), and worker.ts's
 *  writeBreakdown() cleans the RENDER-TIME COPY — the clip-regen path
 *  (handleRegenClip) never recompiles, so without the render-side call an ad
 *  already in the database would keep rendering hands no matter how many times
 *  the user hit Regenerate, which is exactly the reported symptom.
 *
 *  Exact string removal, not fuzzy matching: every one of these is a direct,
 *  deterministic append and is always byte-identical to its source — the same
 *  reasoning LIBRARY_INJECTED_TEXTS relies on in authoredOnly() below. */
export function stripBodyMechanics(text: string): string {
  let out = String(text || "");
  for (const t of BODY_MECHANICS_TEXTS) {
    if (!out.includes(t)) continue;
    out = out.split(t).join(" ");
  }
  return out.replace(/\s+([.,;])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

// ── LENS LIBRARY ─────────────────────────────────────────────────────────────
// Unlike the three libraries above, this one is NOT regex-triggered off authored
// text -- it's keyed by the shot's FINAL framing family (framingFamily() below:
// xcu/cu/mcu/med/wide/other), because a real cinematographer picks a lens for
// what the shot's SIZE needs, not because the script happened to contain a magic
// word. Injected into shot.camera in a dedicated pass AFTER the narrative pass
// (REPEATED_FRAMING / CAMERA_CONTINUITY_CHAINED / COVERAGE_MONOTONY) so it keys
// off each shot's truly final camera text -- injecting any earlier would mean a
// later pass's wholesale camera rewrite (REPEATED_FRAMING's `nxt.camera =
// replacement`) silently discards it, same trap PACE LIBRARY INJECTION's own
// comment already documents avoiding for its cameraNote.
interface LensLibraryEntry {
  family: string;
  marker: string;
  description: string;
  negatives: string[];
}
function loadLensLibrary(): LensLibraryEntry[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "director", "LENS_LIBRARY.json"), "utf8");
    const parsed = JSON.parse(raw) as { lenses?: LensLibraryEntry[] };
    return parsed.lenses ?? [];
  } catch {
    return [];
  }
}
const LENS_LIBRARY = loadLensLibrary();
const LENS_BY_FAMILY = new Map(LENS_LIBRARY.map((l) => [l.family, l]));

// ── CAMERA MOVE LIBRARY ──────────────────────────────────────────────────────
// Same architecture as PACE_LIBRARY above, but deliberately injected with LENS
// LIBRARY's timing, not pace's: pace's cameraNote is a short, generic tempo
// phrase, cheap to lose if REPEATED_FRAMING/CAMERA_CONTINUITY_CHAINED later
// wholesale-reassigns `nxt.camera = replacement` (both run in a LATER pass,
// well after the per-shot loop pace injects in). A named camera-move
// description (src/director/CAMERA_MOVE_LIBRARY.json) is much richer and
// specific — losing it to that same overwrite would be a real regression, so
// this injects in the SAME final pass as LENS LIBRARY INJECTION, right before
// it, for the identical "everything above can still rewrite s.camera" reason
// that comment documents.
interface CameraMoveLibraryEntry {
  key: string;
  name: string;
  family: string;
  triggerPattern: string;
  marker: string;
  description: string;
  negatives: string[];
}
function loadCameraMoveLibrary(): (CameraMoveLibraryEntry & { re: RegExp })[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "director", "CAMERA_MOVE_LIBRARY.json"), "utf8");
    const parsed = JSON.parse(raw) as { moves?: CameraMoveLibraryEntry[] };
    return (parsed.moves ?? []).map((m) => ({ ...m, re: new RegExp(m.triggerPattern, "i") }));
  } catch {
    return [];
  }
}
const CAMERA_MOVE_LIBRARY = loadCameraMoveLibrary();
const MAX_CAMERA_MOVE_PER_SHOT = 1; // named moves contradict each other, like pace/lighting moods -- never combine two.

function matchCameraMoves(text: string): (CameraMoveLibraryEntry & { re: RegExp })[] {
  return CAMERA_MOVE_LIBRARY.filter((c) => c.re.test(text)).slice(0, MAX_CAMERA_MOVE_PER_SHOT);
}

/** Exported so callers outside this file (llm.ts's breakdownAd(), for the
 *  user-facing "signature camera style" picker) can look up a move's name/
 *  description by key without a second, independent JSON-parsing copy of
 *  CAMERA_MOVE_LIBRARY.json — this module already loaded and parsed it once. */
export function getCameraMoveByKey(key: string): { name: string; description: string } | undefined {
  const move = CAMERA_MOVE_LIBRARY.find((c) => c.key === key);
  return move ? { name: move.name, description: move.description } : undefined;
}

/** `cam` should be the shot's FINAL camera text -- see this library's own note
 *  above for why injection is deferred until after the narrative pass. */
function lensFor(cam: string): LensLibraryEntry | undefined {
  return LENS_BY_FAMILY.get(framingFamily(cam));
}

// ── AMBIENCE LIBRARY ─────────────────────────────────────────────────────────
// See AMBIENCE_LIBRARY.json's own note. Unlike ACTION/LIGHTING/PACE/REACTION
// (append to an existing field, and may coexist with each other), this is a
// single ASSIGNMENT per shot into the dedicated shot.ambience field, always
// freshly recomputed from the shot's own authored setting+description text
// (via authoredOnly(), same discipline as matchActions()/matchLighting()) so
// a repair round that changes a shot's setting correctly changes its
// ambience too, rather than a stale value surviving a recompile.
interface AmbienceLibraryEntry {
  key: string;
  triggerPattern: string;
  description: string;
}
function loadAmbienceLibrary(): (AmbienceLibraryEntry & { re: RegExp | null })[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "director", "AMBIENCE_LIBRARY.json"), "utf8");
    const parsed = JSON.parse(raw) as { ambiences?: AmbienceLibraryEntry[] };
    return (parsed.ambiences ?? []).map((a) => ({ ...a, re: a.triggerPattern ? new RegExp(a.triggerPattern, "i") : null }));
  } catch {
    return [];
  }
}
const AMBIENCE_LIBRARY = loadAmbienceLibrary();

/** First real (non-fallback) match wins, in library order; the designated
 *  fallback entry (empty triggerPattern) always applies otherwise — see
 *  AMBIENCE_LIBRARY.json's own note for why a shot should never end up with
 *  no ambience direction at all. */
function ambienceFor(text: string): string {
  for (const a of AMBIENCE_LIBRARY) {
    if (a.re && a.re.test(text)) return a.description;
  }
  return AMBIENCE_LIBRARY.find((a) => !a.re)?.description ?? "";
}

/** Same matching as ambienceFor() just above, but returns the library entry's
 *  KEY rather than its rendered description — used by 6-assemble.ts to pick
 *  a matching synthesized ambience-bed texture (see util.ts's
 *  AMBIENCE_CATEGORY_FILTERS) without re-deriving the category from
 *  shot.ambience's free-text description. */
export function ambienceCategoryFor(text: string): string {
  for (const a of AMBIENCE_LIBRARY) {
    if (a.re && a.re.test(text)) return a.key;
  }
  return AMBIENCE_LIBRARY.find((a) => !a.re)?.key ?? "quiet_room_tone_default";
}

// ── ACOUSTIC SPACE LIBRARY ───────────────────────────────────────────────────
// A DIFFERENT axis from AMBIENCE_LIBRARY just above: ambience is WHAT sound is
// present (rain, crowd, fire); this is the physical SPACE that sound happens
// IN (how much it reverberates/echoes). The two are orthogonal — a rainstorm
// can be heard from inside a tight stone room or across an open field, and
// each needs the same content rendered with a different acoustic character.
// Without this, Seedance's native audio independently guesses each shot's
// room acoustics on its own — exactly the kind of per-shot, independently-
// generated inconsistency this file exists to close (see AMBIENCE_LIBRARY's
// own note): two shots of the SAME small room can come back with visibly
// different reverb character purely because they were rendered separately,
// with nothing telling the model "this is the same acoustic space as the
// last shot." Matched against the shot's own SETTING text only (the space
// itself, not what's happening in it) — first match in library order wins,
// same discipline as ambienceFor().
interface AcousticSpaceEntry {
  key: string;
  re: RegExp;
  description: string;
}
const ACOUSTIC_SPACE_LIBRARY: AcousticSpaceEntry[] = [
  {
    key: "tight_reverberant_interior",
    re: /\b(bathroom|stairwell|stone (?:hall|corridor|chamber)|cave|tunnel|underpass|parking garage|empty warehouse|cathedral|church interior|vault|crypt)\b/i,
    description: "Acoustic space: a hard-surfaced, reverberant room — every voice and footstep carries a short, audible echo/slap-back off close stone, tile, or concrete walls.",
  },
  {
    key: "open_interior_hall",
    re: /\b(gymnasium|ballroom|lobby|atrium|warehouse interior|auditorium|hangar|great hall|large hall)\b/i,
    description: "Acoustic space: a large, mostly-empty interior — voices and sound carry with a light, airy reverberant tail, distinctly more open than a small furnished room.",
  },
  {
    key: "vehicle_interior",
    re: /\b(inside the car|car interior|driver'?s seat|passenger seat|dashboard|cockpit|cabin of the (?:plane|ship|truck))\b/i,
    description: "Acoustic space: a tight, damped vehicle cabin — voices sound close and boxy, with road/engine/wind noise as the dominant bed rather than any room reverb.",
  },
  {
    key: "small_furnished_interior",
    re: /\b(bedroom|living room|kitchen|office|closet|small room|apartment|nursery)\b/i,
    description: "Acoustic space: a small, furnished, acoustically dry interior — soft furnishings damp any echo, voices sound close and direct with no audible reverb tail.",
  },
  {
    key: "outdoor_open",
    re: /\b(field|meadow|forest|woods|beach|shore|ocean|desert|mountain|open (?:sky|plain)|countryside|rooftop)\b/i,
    description: "Acoustic space: a fully open outdoor area — no reverb or echo at all, sound disperses freely with only natural distance softening it.",
  },
  {
    key: "outdoor_street_urban",
    re: /\b(street|alley|downtown|city block|sidewalk|urban)\b/i,
    description: "Acoustic space: an outdoor urban corridor — buildings on either side add a subtle slap-back echo to loud, close sounds, while ambient city noise otherwise disperses openly.",
  },
];

/** No fallback entry in the library itself (unlike AMBIENCE_LIBRARY) — an
 *  unrecognized setting gets this literal neutral description rather than
 *  silently matching the wrong physical space. */
const ACOUSTIC_SPACE_DEFAULT = "Acoustic space: a neutral, unremarkable room with no notable echo or reverb.";

function acousticFor(settingText: string): string {
  for (const a of ACOUSTIC_SPACE_LIBRARY) {
    if (a.re.test(settingText)) return a.description;
  }
  return ACOUSTIC_SPACE_DEFAULT;
}

// ── COLOR PALETTE (locked once per project) ─────────────────────────────────
// Same "chosen once, locked forever" spirit as PIPELINE_VERSION, but per-
// PROJECT rather than per-codebase-version: without this, each shot's
// keyframe independently guesses at a color grade, and a 10-30 minute film
// visibly shifts hue/contrast scene to scene even when every individual shot
// looks fine in isolation. Scored deterministically (keyword count across the
// WHOLE script), not asked of the LLM — same "compiler discipline over LLM
// guessing" reasoning this file uses throughout.
interface ColorPaletteEntry {
  key: string;
  triggerPattern: string;
  description: string;
  ffmpegFilter: string;
}
function loadColorPalettes(): (ColorPaletteEntry & { re: RegExp | null })[] {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "director", "COLOR_PALETTES.json"), "utf8");
    const parsed = JSON.parse(raw) as { palettes?: ColorPaletteEntry[] };
    return (parsed.palettes ?? []).map((p) => ({ ...p, re: p.triggerPattern ? new RegExp(p.triggerPattern, "i") : null }));
  } catch {
    return [];
  }
}
const COLOR_PALETTES = loadColorPalettes();

/** Highest keyword-match count across the whole script wins; a palette with no
 *  triggerPattern (the neutral default) never scores and only wins if every
 *  scored palette comes back at zero. Ties keep the earlier library entry.
 *  Returns BOTH the prompt-text description (4-images.ts) and the real
 *  ffmpeg filter chain for the SAME chosen palette (6-assemble.ts) — one
 *  scoring decision, two different enforcement mechanisms downstream. */
function pickColorPalette(bd: Breakdown): { description: string; ffmpegFilter: string } {
  const wholeScript = [bd.title, ...bd.shots.flatMap((s) => [s.scene, s.setting, s.description])].join(" ");
  let best: (ColorPaletteEntry & { re: RegExp | null }) | null = null;
  let bestScore = 0;
  for (const p of COLOR_PALETTES) {
    if (!p.re) continue;
    const hits = wholeScript.match(new RegExp(p.re.source, "gi"))?.length ?? 0;
    if (hits > bestScore) { bestScore = hits; best = p; }
  }
  const fallback = COLOR_PALETTES.find((p) => !p.re);
  const chosen = best ?? fallback;
  return { description: chosen?.description ?? "", ffmpegFilter: chosen?.ffmpegFilter ?? "" };
}

// ── Framings that require a second body in frame ───────────────────────────
const TWO_PERSON_FRAMINGS: [RegExp, string][] = [
  [/over[- ]the[- ]shoulder|\bOTS\b/i, "medium close-up, camera tracking alongside them in profile"],
  [/\btwo[- ]shot\b|\b2[- ]shot\b/i, "medium shot, single subject centred"],
  [/reverse[- ](shot|angle)|shot\s*\/\s*reverse/i, "medium shot on the subject, camera static"],
  [/\bPOV\b|point[- ]of[- ]view/i, "tight close-up on the subject, camera locked to their face"],
  [/\bgroup shot\b|coverage of both/i, "medium shot, single subject centred"],
];

const TWO_PERSON_PHRASES =
  /\b(facing him|facing her|opposite him|opposite her|across from (?:him|her)|in conversation with|looking at each other|making eye contact with)\b/gi;

// A DIFFERENT shape of the same "implies a second body" failure TWO_PERSON_
// PHRASES already guards: not a reciprocal RELATION word (facing/opposite/
// eye contact), but a GENERIC ROLE NOUN's own body part acting — "the
// vendor's hand reaches out", "another hand takes it", "a stranger's arm
// blocks the door". CULLED_CHARACTER_STILL_IN_PROSE (R1, above) already
// catches a cast member's own NAME appearing uncredited in the text, but a
// role reference ("the vendor") never matches a character's proper name at
// all, so that check can't see it — this is the gap CULLED_CHARACTER_STILL_
// IN_PROSE structurally cannot close. Confirmed real: a solo-locked shot's
// own text depicted "the vendor's hand... reaching out to accept" an object
// while that SAME shot's cast-lock text asserted "the ONLY person... do NOT
// add a second figure" — a direct, undetected self-contradiction between
// the shot's own narrative action and its own hard render constraint.
// Deliberately NOT autofixed (unlike TWO_PERSON_PHRASES' safe deletions
// above): removing "the vendor's hand reaches out to accept the apple"
// usually leaves a dangling, nonsensical sentence fragment behind, so this
// is flagged for a repair pass to rewrite properly, not silently stripped.
const SECOND_BODY_ROLE_NOUN =
  /\b(?:the|a|another)\s+(?:vendor|shopkeeper|clerk|waiter|waitress|stranger|passerby|bystander|customer|officer|guard|driver|attendant|cashier|receptionist|nurse|doctor)('s)?\s+(?:hand|hands|arm|arms|face|voice|shadow|reflection|silhouette)\b/i;

// ── Sound leaking into a prompt for a model that cannot hear ────────────────
const AUDIO_LEAK: RegExp[] = [
  /\b(?:and\s+)?(?:the|a)\s+voice\s+(?:speaks?|says?|replies|responds?|crackles?)[^.,;]*/gi,
  /\bspeak(?:s|ing)?\s+urgently\s+in\s+(?:his|her|their)\s+ear\b/gi,
  /\b(?:in|into)\s+(?:his|her|their)\s+ear\b[^.,;]*/gi,
  /\bwe\s+hear\b[^.,;]*/gi,
  /\bvoice(?:\s?over|-over)?\s+(?:says?|speaks?|replies)[^.,;]*/gi,
  /\bover\s+the\s+(?:radio|comms|earpiece)\b[^.,;]*/gi,
];

// ── ACTIONS THAT CHANGE THE WORLD — VERB FORMS ONLY ────────────────────────
// The old version had bare `open\w*` and `close[sd]?`, so "staring at a CLOSED
// laptop" — someone standing perfectly still — was flagged as a world-changing
// action. Adjectives are not events. Every entry here is a conjugated verb.
// CONFIRMED REAL GAP, FIXED (2026-08-08, "The Last Stand of Isolde" test):
// kneeling and descending were both completely absent from this list. A shot
// whose only action was "kneels before the queen" or "steps down from the
// dais" was never recognized as changing the world at all, so it never got
// forced to two endpoints — reproduced exactly on camera: a kneel/rise/
// descend that "just happens" between one frame and the next with no visible
// transition, because the model had only ONE frame and no instruction that
// it needed to show the motion completing. kneels/kneeling/knelt, steps
// down/stepping down, descends/descending, and rises/rising (NOT bare "rose"
// — too easily a flower, not a verb) added on the same "conjugated verb
// only" discipline as everything else in this list.
const STATE_CHANGE =
  /\b(jumps?|jumping|jumped|leaps?|leaping|leapt|vaults?|vaulting|vaulted|hurdles?|hurdling|dives?|diving|climbs?|climbing|falls?|falling|fell|lands?|landing|landed|throws?|throwing|threw|tosses|tossing|hurls?|hurling|flings?|catches|catching|caught|grabs?|grabbing|snatches|picks?\s+up|picking\s+up|lifts?|lifting|drops?|dropping|opens|opening|opened|closes|closing|shuts|shutting|sits?\s+down|sitting\s+down|stands?\s+up|standing\s+up|kneels?|kneeling|knelt|rises?|rising|steps?\s+down|stepping\s+down|descends?|descending|turns?|turning|spins?|spinning|shoves?|shoving|crashes|crashing|slams?|slamming|knocks?|knocking|smashes|smashing|breaks?|breaking|broke|shatters|scatters|spills?|spilling|topples?|collides?|tackles?|pushes|pushing|pulls?|pulling|kicks?|kicking|punches|punching|strikes?|enters|entering|exits|exiting|unlocks?|draws|drawing|hands?\s+(?:over|him|her|it))\b/i;
  // Expression is a STATE too: a shot whose point is a face CHANGING (angry → hurt)
// needs both endpoints as much as a physical action — the endFrame pins the TARGET
// expression so the model lands it instead of drifting to neutral or a smile.
const EMOTION_SHIFT =
  /\b(expression\s+(?:shift\w*|chang\w*|soften\w*|harden\w*|falls|crumples)|softening|hardening|shifts?\s+from\s+\w+\s+(?:to|into)\s+\w+|from\s+(?:anger|angry|rage|joy|fear|grief|hurt|shock|calm|neutral)\s+(?:to|into)\s+\w+|face\s+(?:falls|hardens|softens|crumples))\b/i;

// HOISTED to module scope (was a per-loop-iteration local inside R9's
// MISSING_HANDOFF_SHOT block) so the standalone, no-shared-character
// MISSING_HANDOFF_SHOT block further down (outside R9's nesting) can use
// the SAME definition instead of a second, driftable copy.
const HANDOFF_TRANSFER_VERB =
  /\b(hands?\s+(?:over|off|him|her|it|them)|gives?|giving|passes?|passing|pays?|paying|handed|exchanges?|exchanging)\b/i;

// ── COMPLETION-BEAT VERBS — a discrete, "done or not done" action a shot's
// endFrame can claim is already finished. DELIBERATELY its own list, not a
// reuse/extension of STATE_CHANGE above — the two confirmed real verbs that
// motivated this ("sets ... down", "flips") aren't in STATE_CHANGE at all,
// and adding broad, extremely common motion words like "reaches" to THAT
// shared regex would inflate R4's own blocking rate across many ordinary,
// already-fine shots. Module-scope (not per-shot-loop-local) because TWO
// checks share it: ENDFRAME_ACTION_NOT_IN_MOTION (this shot's endFrame
// claims a completion its OWN motion never depicts) and
// MOTION_REDEPICTS_COMPLETED_ACTION (the mirror image — this shot's motion
// re-depicts a completion the PREVIOUS shot's endFrame already claimed,
// which R9's CONTINUITY chain then carries into this shot as an already-done
// starting state).
const ENDSTATE_UNDEPICTED_VERBS =
  /\b(sets?\s+(?:it\s+)?down|setting\s+down|drops?\s+off|dropping\s+off|drops?|dropping|hands?\s+(?:over|off|him|her|it)|flips?|flipping|picks?\s+up|picking\s+up|opens?|opening|closes?|closing|unlocks?|enters?|entering|exits?|exiting|embraces?|hugs?|hugging|kisses?|sits?\s+down|stands?\s+up|throws?|catches?|grabs?)\b/gi;
// ── KEYFRAMES A CAMERA GENUINELY CANNOT TAKE ───────────────────────────────
// REMOVED from the old list: "blurred" (a photography term — every good keyframe
// says "background blurred"), "mid-stride" (sprinters are shot mid-stride all the
// time, and the GOOD example in the prompt literally uses it), "in motion" (too
// vague — it caught "motion blur in the background"). Only truly-impossible poses
// remain, and even these only WARN, never block.
const UNPHOTOGRAPHABLE =
  /\b(mid[- ]?air|airborne|at the (?:top|peak|apex) of the arc|suspended in (?:mid[- ]?air|the air)|shards? (?:flying|scattering)|shattering outward|exploding outward)\b/i;

// ── POINTLESS BUSINESS ─────────────────────────────────────────────────────
// A shot that opens AND closes the same thing, with nothing happening between,
// is a character fidgeting for the camera. (Real failure: a man opened a door
// and closed it again for no reason — a bridging beat that carried no story.)
const SELF_CANCELLING =
  /\b(opens?[^.]{0,40}\b(?:then\s+)?closes?|closes?[^.]{0,40}\b(?:then\s+)?opens?|picks?\s+up[^.]{0,40}puts?\s+(?:it\s+)?(?:back|down)|sits?\s+down[^.]{0,40}stands?\s+(?:back\s+)?up)\b/i;

// A door/threshold beat only earns its place if the character actually goes
// THROUGH it — otherwise it is business, not story.
const THRESHOLD = /\b(door|gate|entrance|doorway|shutter)\b/i;
const GOES_THROUGH = /\b(steps?\s+(?:in|inside|through|out)|walks?\s+(?:in|inside|through|out)|enters?|exits?|passes?\s+through|cross(?:es|ing)?\s+the\s+threshold|now\s+inside|now\s+outside)\b/i;
// Used ONLY by THRESHOLD_TRANSITION_SKIPPED (further below) to establish that a
// shot leaves a character on the OUTSIDE of a threshold specifically — not yet
// crossed — as opposed to THRESHOLD/GOES_THROUGH's job of detecting whether a
// crossing IS depicted at all.
// Broadened after 3+ independently-confirmed real cases where a character was
// left just short of a threshold in phrasing this list didn't recognize at
// all (reaching for a door handle, key in hand about to unlock) — the shot
// AFTER always jumped straight to already-inside, with the actual crossing
// never depicted anywhere, exactly the failure this whole check exists to
// catch, just silently missed because the trigger vocabulary was too narrow.
const OUTSIDE_OF_THRESHOLD =
  /\b(outside|approaching|approaches|nearing|at the (?:door|gate|entrance|doorway)|on the (?:porch|doorstep|steps?)|about to (?:enter|go in|knock|unlock)|reach(?:es|ing)?\s+for\s+the\s+(?:door|handle|gate)|hand\s+(?:on|reaching\s+for)\s+the\s+(?:door|handle)|key\s+in\s+hand|unlocking\s+the\s+door)\b/i;

// ── REFLECTIVE SURFACES ────────────────────────────────────────────────────
// A mirror or screen is two pictures at once. A shot that names one without
// saying WHICH the camera is framing gets rendered as the person, every time —
// which is how "her eyes flick to the rearview mirror" became a close-up of her
// face with the mirror as scenery and the headlights nowhere in shot.
const REFLECTIVE = /\b(rearview mirror|mirror|monitor|screen|reflection|reflected)\b/i;
const FRAME_SPECIFIED =
  /\b(fills the frame|filling the frame|occupies (?:most|the majority) of|in the (?:mirror|glass|reflection|screen)|inside the (?:mirror|glass|screen)|reflected in the|seen in the (?:mirror|glass|screen)|framed by the|through the (?:glass|mirror))\b/i;

// ── A REACTIVE STIMULUS WITH NOBODY SHOWN NOTICING IT ──────────────────────
// A monitor/screen/mirror that silently changes content between one shot and
// the next, with the characters simply already staring at the new content, is
// a gap the viewer has to fill in themselves: who noticed it, and when? (Real
// failure: parents staring into an empty crib cut straight to a close-up of the
// monitor already showing the baby, with no shot of them turning toward it or
// anything drawing their eyes there first.)
const SURFACE_CONTENT_CHANGES =
  /\b(now shows?|now display\w*|changes? to|clears? to reveal|reveals?|replaces? the|becomes? clear|resolves? into|stabiliz\w* (?:on|into)|the feed changes|the (?:image|picture|display) changes|static clears|interference clears)\b/i;
const NOTICE_CUE =
  /\b(turns? toward|turning toward|glances?|eyes? (?:cut|dart|flick|snap|widen|turn)|looks? toward|looks? at|stares? at|drawn to|reaches? for|hears? (?:a|the|one)|notices?|attention (?:shifts|turns|snaps)|head snaps|head turns)\b/i;

// ── NARRATIVE COMPLETENESS ─────────────────────────────────────────────────
// An offered hand with nobody taking is the most obvious "AI video" tell. These
// find an action that STARTS but is never shown to FINISH anywhere in the film.
// PAST TENSE, NOT JUST PRESENT. Confirmed real gap: real shot text reads "has
// just accepted the six coins" and "closes his right hand securely around the
// parcel" — "accepted" (past) and "closes his ... hand" (not the narrower
// "closes ... fingers"/"hand closes" this used to require) matched NEITHER
// verb form, so a real completed hand-off never registered as complete at
// all. That silently broke REDUNDANT_HANDOFF's own tracking for exactly the
// scene it was built to catch, and (see DEPARTURE_NEVER_SEPARATES below)
// leaves a stale, wrong exchange as the "last completed one" for anything
// checking against it.
const GIVES = /\b(hands?\s+(?:over|him|her|it|the)|gives?|gave|given|offers?|offered|holds?\s+out|held\s+out|passes?\s+(?:him|her|it|the|over)|passed\s+(?:him|her|it|the|over)|extends?\s+(?:his|her|the)|extended\s+(?:his|her|the))\b/i;
const TAKES = /\b(takes?|took|taken|accepts?|accepted|receives?|received|grasps?|grasped|grabs?|grabbed|collects?|collected|pockets?|pocketed|closes?\s+(?:his|her)?\s*(?:fingers|hand)|closed\s+(?:his|her)?\s*(?:fingers|hand)|hand\s+closes?|hand\s+closed)\b/i;

// A DEPARTURE THAT NEVER ACTUALLY DEPARTS — see the check itself, further
// below, for the full real-failure writeup this was built from.
const DEPARTS =
  /\b(walks?\s+away|walking\s+away|departs?|departing|leaves?\s+the|leaving\s+the|heads?\s+off|heading\s+off|turns?\s+(?:and\s+)?(?:goes?|walks?|heads?)|steps?\s+back\s+into\s+the\s+crowd|continuing\s+(?:on\s+)?(?:his|her|their)\s+way|moving\s+on\b|moves?\s+on\b)/i;
const RECIPROCAL_INTERACTION = /\b(returning|returns|waves?|waving|glances?\s+back|looks?\s+back|watches?|watching|calls?\s+out|responds?|responding)\b/i;
const SEPARATION_ESTABLISHED =
  /\b(further\s+away|farther\s+away|growing\s+distance|now\s+behind\s+(?:him|her|them)|shrinking|several\s+(?:metres|meters|feet|steps|strides)\s+(?:now\s+)?(?:separate|between|back)|putting\s+(?:distance|space)\s+between|distance\s+(?:growing|widening)|receding\s+into\s+the\s+distance)\b/i;

// A throw AT a person implies a catch; a throw with no stated recipient
// (thrown at a wall, into a lake, or "throws his hands up" idiomatically) does
// not — so this only fires on the narrower "thrown TO someone" phrasing,
// unlike GIVES above which fires on any hand-off verb. Deliberately does not
// reuse TAKES: closing a fist around a handed object and catching something
// airborne read as different physical beats to a viewer.
const THROWN_TO_PERSON = /\b(?:throws?|throwing|threw|tosses?|tossing|tossed|hurls?|hurling|hurled|flings?|flinging|flung)\s+(?:it\s+|him\s+|her\s+|them\s+|the\s+\w+\s+)?(?:to|toward|towards)\s+(?:him|her|them|\w+)\b/i;
const CAUGHT = /\b(catches?|catching|caught)\b/i;

// Entering or leaving a space. Without one of these between two different
// locations, the character teleports across the cut.
// INTENT-ONLY PHRASING DOES NOT COUNT AS A BRIDGE. Confirmed real failure: a
// shot ending "...his body tenses as he prepares to exit" satisfied this check
// on the word "exit" alone, even though nobody is ever shown actually getting
// out of the car, crossing the street, or reaching the building — the very
// next shot opens with him already outside gripping the door handle. "Prepares
// to X" / "about to X" describes an intention, not a completed crossing, so a
// transition verb immediately after one of these phrases must not satisfy the
// bridge on its own.
const TRANSITION = /\b(?<!(?:prepares?\s+to|about\s+to|getting\s+ready\s+to|starts?\s+to|begins?\s+to)\s+)(enters?|entering|steps?\s+(?:in|into|out|through)|walks?\s+(?:in|into|out|through|up\s+to)|approach\w*|arrives?|reaches?\s+the|pushes?\s+(?:open|through)|exits?|leaves?|emerges?)\b/i;

/** Two dialogue lines are "the same line spoken twice" — near-verbatim, ignoring
 *  case/punctuation/whitespace. Interview PDF failure: shot 5 and shot 6 both
 *  delivered "But I wouldn't trade any of it." — the breakdown split one line of
 *  dialogue across two shots instead of advancing to the next line or going silent. */
function sameDialogue(a: string, b: string): boolean {
  const norm = (x: string) => (x || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B) return true;
  const toks = (x: string) => new Set(x.split(" ").filter((w) => w.length > 2));
  const ta = toks(A), tb = toks(B);
  if (ta.size < 3 || tb.size < 3) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.85;
}

// Framing family, for the "two shots in a row look identical" check.
function framingFamily(cam: string): string {
  const c = (cam || "").toLowerCase();
  if (/extreme close|ecu\b/.test(c)) return "xcu";
  if (/close[- ]?up|\bcu\b|tight on/.test(c)) return "cu";
  if (/medium close/.test(c)) return "mcu";
  if (/wide|establishing|long shot/.test(c)) return "wide";
  if (/medium|\bms\b/.test(c)) return "med";
  return "other";
}
const VARY: Record<string, string> = {
  wide: "medium shot, camera pushing slowly in",
  med: "close-up, camera drifting slightly",
  mcu: "wide shot, camera craning back to reveal the space",
  cu: "medium shot, camera tracking with the subject",
  xcu: "medium shot, camera easing back",
  other: "medium shot, camera tracking with the subject",
};

// ── COARSE SIZE BUCKET — the shot-rhythm twin of framingFamily() above ──────
// framingFamily()/VARY only ever compare ADJACENT shots and only ever fire on
// an EXACT repeat (cu, cu). A scene that alternates cu / mcu / cu / mcu forever
// never trips that check -- every pair looks "varied" by its stricter test --
// but the viewer still never sees a wide shot establish where anyone actually
// is, and the scene reads as an unbroken wall of close coverage. Bucketing
// cu/mcu/xcu together as one "close" size (and leaving wide/med their own
// buckets) is what lets COVERAGE_MONOTONY below catch a RUN, not just a pair.
function coarseBucket(fam: string): "wide" | "med" | "close" | "other" {
  if (fam === "wide") return "wide";
  if (fam === "med") return "med";
  if (fam === "cu" || fam === "mcu" || fam === "xcu") return "close";
  return "other";
}
// What to cut TO when a bucket has run too long -- the opposite end of the
// scale, not just "something different": a scene stuck in close-ups needs
// geography (wide), and a scene stuck wide needs an emotional beat (close).
const BUCKET_BREAKOUT: Record<"wide" | "med" | "close", string> = {
  close: "wide shot, camera pulling back to re-establish the space",
  wide: "medium close-up, camera pushing in for emotional detail",
  med: "close-up, camera moving in on the subject's reaction",
};

const RUNNING = /\b(run|runs|running|sprint\w*|chas\w*|fle(?:e|es|eing)|walk\w*|jog\w*)\b/i;

// LOCOMOTION FALSE-POSITIVE GUARD — CONFIRMED REAL, not hypothetical. RUNNING
// just above matches ANY occurrence of its word list anywhere in a shot's
// text, with no regard for negation or for a non-human subject. A real
// render's own shot text — "No kitchen appliances are running, and there is
// no visible food preparation" (a clarifying NEGATIVE detail about a stove or
// kettle, not a person) — matched RUNNING anyway. That forced a TRACKING
// camera rewrite (CAMERA MUST MOVE ON LOCOMOTION, below) and injected "He
// covers real ground and physically MOVES through the scene... the world
// moves past him" directly into s.motion (DISPLACEMENT, below), for a shot
// whose actual, authored action was a character standing still. This is not
// a one-off: AMBIENCE_LIBRARY.json's own "running_water_indoor" category
// (triggered by "running water", a faucet/shower/sink) is the identical
// failure mode for any bathroom/kitchen scene whose own ambience text
// happens to reach this same check.
//
// Two narrow, targeted exclusions rather than a general negation parser —
// same "specific, confirmed phrase, not a speculative general fix"
// discipline as TRANSITION's own negative lookbehind above — checked per
// CLAUSE (split on sentence/clause boundaries) rather than via a fixed-width
// lookbehind immediately before the match, since a real negation ("No
// kitchen appliances are running") can sit several words before the verb
// that a short lookbehind window would miss entirely.
const LOCOMOTION_NEGATION = /\b(no|not|never|isn'?t|aren'?t|wasn'?t|weren'?t|without|nobody|no\s+one)\b/i;
const LOCOMOTION_NON_HUMAN_SUBJECT =
  /\b(?:water|tap|faucet|shower|sink|engine|motor|appliances?|machines?|kettle|dishwasher|dryer|washer|fridge|refrigerator|heater|generator|ac|air\s?conditioner)\s+(?:is\s+|are\s+|was\s+|were\s+)?running\b|\brunning\s+water\b/i;

/** Genuine human locomotion only — see LOCOMOTION_NEGATION/
 *  LOCOMOTION_NON_HUMAN_SUBJECT's own comment above for exactly which false
 *  positives this excludes and why. Drop-in replacement for a bare
 *  RUNNING.test(text) call. */
function hasGenuineLocomotion(text: string): boolean {
  const clauses = String(text || "").split(/[.;\n]/);
  for (const clause of clauses) {
    if (!RUNNING.test(clause)) continue;
    if (LOCOMOTION_NON_HUMAN_SUBJECT.test(clause)) continue;
    const m = clause.match(RUNNING);
    if (m && m.index !== undefined && LOCOMOTION_NEGATION.test(clause.slice(0, m.index))) continue;
    return true;
  }
  return false;
}

// ── SLOW MOTION — same trigger wording as PACE_LIBRARY's own
// "cinematic_slow_motion" entry (deliberately kept as two independent
// regexes testing the same phrases, not a shared import — the same
// duplication pattern already used for isCloseUp/CLOSEUP_RE across this file,
// 4-images.ts and 5-videos.ts). Drives R5's duration cap below: a beat
// explicitly written as slow motion needs more seconds to actually let the
// motion breathe, not the same tight budget as ordinary real-time action.
const SLOW_MOTION_CUE = /\b(slow motion|slow-motion|everything slows|time seems to slow|the world slows down|time (?:stood|stands) still|time slows)\b/i;

// Same duplication-not-import convention as SLOW_MOTION_CUE's own comment
// describes — 4-images.ts and 5-videos.ts each already have their own
// CLOSEUP_RE for their own purposes; this one drives R5's identity-critical
// duration ceiling just below, nothing else.
const CLOSEUP_RE = /\b(close[- ]?up|tight (?:on|shot)|extreme close|face fills|CU\b|ecu\b)/i;

// ── TENSE/HOSTILE ACTION — narrower than isAction on purpose ────────────────
// isAction (below) is deliberately BROAD: it drives duration budget and video-
// tier routing, where "sits down" and "picks up a gift" legitimately deserve
// the same slightly-larger allowance as "runs" or "punches" (all are real
// physical motion, harder for the model than a static talking head). But one
// consumer of isAction — the "expression stays hard and intense, no smiling"
// lock a few hundred lines down — was written for a genuinely different case
// ("one model SMILED mid-chase") and has no business firing on a calm sit-
// down, a friendly hand-off, or a joyful reunion hug. Confirmed on camera in
// this project's own testing: expanding the action library to cover ordinary
// life (walking to greet a friend, picking up fruit at a market, hugging
// while crying happy tears) made isAction true for scenes that are the
// OPPOSITE of hostile, and the lock told the model "no smiling" during a
// joyful reunion. This narrower check is what that ONE consumer should
// actually gate on: real danger/conflict vocabulary, not any physical motion.
const TENSE_HOSTILE =
  /\b(chas\w*|fle(?:e|es|eing)|sprints?|sprinting|dashes?|dashing|punches?|punching|punched|kicks?|kicking|kicked|slaps?|slapping|slapped|strikes?|striking|struck|shoves?|shoving|shoved|tackles?|tackling|crashes?|crashing|slams?|slamming|fights?|fighting|fought|attacks?|attacking|attacked|struggles?|struggling|escapes?|escaping|threatens?|threatening)\b/i;
// Explicit override even if TENSE_HOSTILE somehow also matches (defense in
// depth) — a scene that is textually warm/joyful should never be told to
// suppress smiling.
const POSITIVE_EMOTION =
  /\b(laughs?|laughing|laughed|smiles?|smiling|smiled|joy\w*|happ(?:y|ily)|delight\w*|embraces?|embracing|embraced|hugs?|hugging|hugged|kisses?|kissing|kissed|celebrat\w*)\b/i;

// ── STATE BEATS — things a camera cannot film ──────────────────────────────
// "Hiding behind a wall" is a STATE, not an action. A renderer animates CHANGE;
// hand it a state and it manufactures motion to fill the time — which is exactly
// how a hide-behind-cover beat became a man doing a lean-and-push against a wall.
// A static beat must either gain an entry/exit (become a change) or be cut.
const STATIC_STATE =
  /\b(hid(?:e|es|ing)|hidden behind|takes? cover|taking cover|waits?|waiting|lurk(?:s|ing)?|stands? guard|ducks? behind|crouch(?:es|ed|ing)? behind)\b/i;

// ── DAY/NIGHT CONTINUITY — see TIME_OF_DAY_JUMP_NO_SKIP below ───────────────
// Deliberately narrow, unambiguous words only. "Evening" is NOT included on
// either side — genuinely ambiguous (either side of dusk), and including it
// would false-fire on ordinary scene-setting language constantly.
const DAY_SIGNAL = /\b(daylight|broad daylight|bright sun\w*|sunny|midday|noon|morning|afternoon)\b/i;
const NIGHT_SIGNAL = /\b(night|nighttime|midnight|moonlit|moonlight|pitch dark|streetlights?|starlit)\b/i;
const TIME_SKIP_PHRASE =
  /\b(later that (?:night|evening|day|morning|afternoon)|hours later|the next (?:day|morning|night)|by (?:nightfall|morning)|as (?:the sun|evening|night) (?:set|sets|fell|falls|falling)|meanwhile|some time later|a while later)\b/i;

// ── 180-DEGREE RULE — see SCREEN_POSITION_FLIPPED below ─────────────────────
// A camera move explicitly earns the right to cross the axis of action — the
// prompt already tells the LLM this ("Only cross this 180-degree line with a
// deliberate, camera-move shot that visibly repositions around them").
const CAMERA_REPOSITION_MOVE =
  /\b(circles?|circling|arcs? around|swings? around|repositions?|crosses? (?:to|around)|moves? around|orbits?|wheels? around)\b/i;

/** Which screen side (if any) this text explicitly states `name` occupies.
 *  Deliberately narrow — only a literal "<name> ... screen-left/-right" (or
 *  reversed) mention counts; a shot that never states a screen position at
 *  all returns null and never contradicts anything. */
function screenSide(text: string, name: string): "left" | "right" | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const near = (side: "left" | "right") =>
    new RegExp(`\\b${esc}\\b[^.]{0,25}\\bscreen-${side}\\b|\\bscreen-${side}\\b[^.]{0,25}\\b${esc}\\b`, "i");
  if (near("left").test(text)) return "left";
  if (near("right").test(text)) return "right";
  return null;
}

// ── EYELINE MATCH — see EYELINE_HEIGHT_MISMATCH in R7 below ────────────────
// A shot that names TWO characters at different physical heights (one
// seated, one standing; one kneeling, one on their feet) and ALSO describes
// them making eye contact needs a compensating gaze direction stated
// explicitly — left to its own devices, the renderer defaults to two level,
// straight-ahead stares that don't match the bodies underneath them. Every
// scripted conversation across a genuine height difference (a parent
// kneeling to a child, someone seated across a desk from someone standing)
// is exposed to this. Deterministic and proximity-scoped exactly like
// screenSide() above: only fires when the shot's OWN text states WHICH
// named character is at which level, never guessed from cast alone.
const EYE_CONTACT_CUE =
  /\b(eye contact|looks? (?:at|into) (?:his|her|their|\w+'s) eyes|meets? (?:his|her|their|\w+'s) (?:gaze|eyes)|look(?:s|ing)? at each other|gazes? at (?:each other|him|her|them)|stares? (?:at each other|into (?:his|her|their) eyes))\b/i;
const GAZE_DIRECTION_STATED =
  /\b(looks? up at|looking up at|looks? down at|looking down at|tilts? (?:his|her|their) (?:head|chin|gaze) (?:up|down)|gaze (?:tilts?|angles?) (?:up|down)|eyeline)\b/i;
// A shot can explicitly state the two are NOT looking at each other — this
// is a different, real intent (see embarrassment_shame/guilt in
// REACTION_LIBRARY.json) and must suppress the default-engagement
// assumption the dialogue-exchange trigger below makes, not be overridden by it.
const GAZE_AVERSION_CUE =
  /\b(avoid(?:s|ing|ed)? eye contact|looks? away|looking away|won'?t meet (?:his|her|their) (?:gaze|eyes)|can'?t meet (?:his|her|their) (?:gaze|eyes)|refuses? to look at|eyes? (?:fixed|glued) elsewhere)\b/i;
const LOW_POSTURE_FRAGMENT = "sits?|sitting|seated|kneels?|kneeling|knelt|crouches?|crouching|crouched";
const HIGH_POSTURE_FRAGMENT = "stands?|standing|stood|towers?\\s+over|looms?\\s+over";

/** Is `name` stated near a low- or high-posture cue in this text? Only an
 *  EXPLICIT posture statement close to that person's own name counts — a
 *  shot that never states either character's posture returns null for both
 *  and never triggers the eyeline fix.
 *
 *  REAL BUG, CAUGHT BY TESTING AGAINST compileBreakdown() DIRECTLY (not just
 *  assumed correct): a naive bidirectional "posture word within N chars of
 *  the name, either order" check — the same technique screenSide() above
 *  uses — cross-contaminates the moment TWO names and TWO different posture
 *  words share one sentence, which is exactly this rule's normal case. In
 *  "Sarah kneels beside the bed while Mark stands in the doorway", "kneels"
 *  sits well within a 40-character window of "Mark" too (just further along
 *  the same sentence), so the old bidirectional-window check classified
 *  BOTH names as "low". screenSide() never had this problem because it's
 *  normally checked against one screen-side statement at a time, not two
 *  competing cues in the same breath. The fix: don't ask "is a low/high word
 *  within N chars of this name" — ask "of every low/high word in this whole
 *  shot, which one is NEAREST to this specific name's own mention", and
 *  require that nearest word to be genuinely closer than the alternative,
 *  not just within some fixed radius. */
function heightState(text: string, name: string): "low" | "high" | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const positionsOf = (re: RegExp): number[] => {
    const out: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m.index);
    return out;
  };
  const namePositions = positionsOf(new RegExp(`\\b${esc}\\b`, "gi"));
  if (!namePositions.length) return null;
  const lowPositions = positionsOf(new RegExp(`\\b(?:${LOW_POSTURE_FRAGMENT})\\b`, "gi"));
  const highPositions = positionsOf(new RegExp(`\\b(?:${HIGH_POSTURE_FRAGMENT})\\b`, "gi"));

  const nearestDistance = (cuePositions: number[]): number => {
    let best = Infinity;
    for (const np of namePositions) for (const cp of cuePositions) best = Math.min(best, Math.abs(np - cp));
    return best;
  };
  const lowDist = nearestDistance(lowPositions);
  const highDist = nearestDistance(highPositions);
  const MAX_DISTANCE = 60; // genuine proximity, not "anywhere in the shot"
  if (lowDist <= MAX_DISTANCE && lowDist < highDist) return "low";
  if (highDist <= MAX_DISTANCE && highDist < lowDist) return "high";
  return null; // tied, both out of range, or neither present — don't guess
}

// ── CROSSINGS — the same-side-landing bug ──────────────────────────────────
// "Vaults the wall and lands on the far side" is ambiguous when the wall runs
// ALONGSIDE the path: the model hops it sideways and lands where it started.
// (That exact clip shipped.) If a shot crosses an obstacle, the endFrame must
// pin WHICH side he ends on — deterministically, here, not by hoping.
const CROSSING =
  /\b(vault|leap|jump|hurdle|climb|dive)\w*\s+(?:clean(?:ly)?\s+|straight\s+)?(?:over|across)\b/i;
const FAR_SIDE =
  /\b(far side|other side|opposite side|beyond the|past the|back to (?:the )?(?:wall|fence|barrier|gate|it)|away from (?:the )?(?:wall|fence|barrier|gate|obstacle|it))\b/i;

// ── RE-CROSSING THE SAME OBSTACLE — a chase re-running its own footage ─────
// A chase with several distinct obstacles (an archway, a corner, a wall) can
// end up describing the SAME one two or three times in a row if the film
// runs out of new ground to cover: each shot independently claims to start
// "before" the obstacle and end "past" it, as if the character had not
// already crossed it in the shot immediately before. This is the same failure
// RULE 3 / r-23 exist to prevent, just spread across separate shots instead of
// split within one. (Real failure: three consecutive shots in a chase each
// began "before the sharp stone corner" and ended "past it, in the new alley
// branch" — the character re-crossed the identical corner three times.)
const OBSTACLE_NOUN = /\b(corner|archway|arch\b|doorway|threshold|ledge|wall|fence|barrier|gate)\b/i;
const CROSSES_SOMETHING = (text: string): boolean => CROSSING.test(text) || (OBSTACLE_NOUN.test(text) && GOES_THROUGH.test(text));

// A module-level tokenOverlapRatio() used to live here. DEAD CODE, REMOVED:
// compileBreakdown() (below) declares its own LOCAL tokenOverlapRatio() —
// and because JS hoists a function declaration to the top of its enclosing
// function's scope, that local one shadowed this one for compileBreakdown's
// entire body, including every real call site, which all live inside it.
// This one was never actually reachable from anywhere.

/**
 * Two keyframes that say the same thing give the model no journey — it holds the
 * pose. BUT both frames legitimately share the character block and the setting
 * (same person, same room), so overlap is ALWAYS high. Threshold is 0.9 and we
 * ignore short frames, so this only fires on near-verbatim copies. WARN only.
 */
function tooSimilar(a: string, b: string): boolean {
  const tok = (x: string) => new Set(x.toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []);
  const A = tok(a);
  const B = tok(b);
  if (A.size < 5 || B.size < 5) return false;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.9;
}

/**
 * Distil a shot's END STATE into one short clause the NEXT shot can open from.
 * Prefers endFrame (the cleanest statement of where things stand when the shot
 * closes); falls back to motion, then description. Strips the clauses we append
 * ourselves (cast lock, feet, expression, earlier CONTINUITY notes) so chaining
 * never snowballs its own boilerplate shot after shot.
 */
/**
 * LAST-RESORT deterministic endFrame for a state-changing shot the repair loop
 * could not fix — see runBreakdown()'s rescue pass (steps/1-breakdown.ts) for
 * the only caller and the full reasoning.
 *
 * STATE_CHANGE_NEEDS_ENDFRAME is a genuine structural blocker: a world-changing
 * beat rendered from ONE keyframe has no idea where the action ends, so the
 * model stalls on a held pose. The right fix is a real authored endFrame, and
 * the repair LLM stays the primary path. But the CONSEQUENCE of the repair
 * failing was catastrophically out of proportion: runBreakdown() threw, and
 * because the throw happens before the project row is written, the ENTIRE
 * breakdown was discarded — a real 83-shot film, half an hour of LLM work,
 * deleted over one missing sentence on one shot. Confirmed twice in the job
 * history ("1 shot(s) still cannot be rendered", breakdownJson NOT SAVED).
 *
 * This applies the same discipline the ENTRANCE_ENDPOINTS_AUTOFILLED case
 * (Gap G) already established: where the compiler can write a defensibly
 * correct endpoint itself, "good enough and shipped" beats "perfect and
 * thrown away". distillEndState() already knows how to reduce a shot's own
 * authored text to a resulting state — reused here rather than reinvented, so
 * the synthesized frame is grounded in what the shot actually says instead of
 * being boilerplate.
 */
export function synthesizeEndFrame(shot: Shot): string {
  const distilled = distillEndState(shot);
  const base = distilled
    ? `The action described above is now COMPLETE and visibly finished: ${distilled}`
    : "The action described above is now COMPLETE and visibly finished.";
  return (
    `${base} Everything the beat set in motion has arrived at its final position and come to rest — ` +
    `whatever moved has finished moving, whatever opened is fully open, whatever was picked up is held ` +
    `securely. This is the settled state AFTER the action, not the moment during it.`
  );
}

export function distillEndState(shot: Shot): string {
  let src = authoredOnly(shot.endFrame?.trim() || shot.motion?.trim() || shot.description?.trim() || "");
  // Cut at a SENTENCE boundary, never mid-word. The old version sliced at 180
  // characters and left fragments like "...her face serious and focused, eyes."
  // dangling in the prompt, which reads as noise to the model and to anyone
  // reviewing the shot list.
  if (src.length > 200) {
    const stop = src.slice(0, 200).lastIndexOf(". ");
    if (stop > 60) {
      src = src.slice(0, stop + 1);
    } else {
      const comma = src.slice(0, 200).lastIndexOf(", ");
      src = comma > 60 ? src.slice(0, comma) : src.slice(0, src.slice(0, 200).lastIndexOf(" "));
    }
  }
  if (src && !/[.!?…]$/.test(src)) src += ".";
  return src;
}

/**
 * Strip every clause the compiler itself appends (cast lock, ground contact,
 * emotional lock, CONTINUITY chain). CRITICAL for idempotence: after a repair
 * round the breakdown is RECOMPILED, and our own appended words must never
 * trigger our own rules. "…no smiling, no relaxing, no breaking" contains
 * "breaking" — a STATE_CHANGE verb — and one recompile turned a clean sprint
 * into a blocker, which the repair loop then "fixed" by giving EVERY shot
 * endpoints. Detection runs on authored text only.
 */
// Every R7 castLock variant (crowd and non-crowd, empty/solo/multi, and the
// indirect-presence rewording) starts with one of these phrases, and castLock is
// ALWAYS the tail of `description` — nothing authored comes after it except a
// possible later-appended crowd-separation sentence or CONTINUITY clause, both
// of which are themselves tail-appends. So instead of hand-matching every one of
// the ~7 exact sentence shapes (fragile: a new phrasing variant silently stops
// matching, exactly what happened when the non-crowd solo/multi/indirect-presence
// wording was added here without updating this list), truncate the string at the
// FIRST marker found — that removes it and everything appended after it in one
// move, regardless of how many sentences the tail spans or how it's worded.
export const CASTLOCK_TAIL_MARKERS = [
  "is the ONLY person in the foreground",
  "is the ONLY person anywhere in this frame",
  "people in the foreground:",
  "people appear anywhere in this frame",
  "No people in the foreground",
  "No people appear anywhere in this frame",
  "No named character is physically present",
  "All background people remain FAR behind the subject",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Four of the eight castLock sentence shapes (buildCastLock's solo and
// multi-name branches, crowd and non-crowd) open with a variable SUBJECT — a
// character name, or "Exactly N" — directly before the fixed marker text
// above. A plain indexOf-based cut lands AFTER that subject, stranding it in
// the "authored" text: confirmed via a failed idempotence test, this used to
// leave "Amir" behind from "Amir is the ONLY person anywhere in this
// frame...". Each pattern below optionally eats a preceding name-run or
// "Exactly N" so the cut lands at the true start of castLock's own sentence,
// whichever of the eight shapes it turns out to be — built FROM
// CASTLOCK_TAIL_MARKERS rather than a second hand-maintained list, so the two
// can't drift apart the way authoredOnly()'s old strip regexes drifted from
// buildCastLock()'s actual wording.
const CASTLOCK_TAIL_PATTERNS: RegExp[] = CASTLOCK_TAIL_MARKERS.map(
  (marker) =>
    new RegExp(
      "(?:[A-Z][A-Za-z'-]*(?:\\s+[A-Z][A-Za-z'-]*)*\\s+)?(?:Exactly \\d+\\s+)?" +
        escapeRegExp(marker)
    )
);

function stripCastLockTail(x: string): string {
  let cut = x.length;
  for (const re of CASTLOCK_TAIL_PATTERNS) {
    const m = re.exec(x);
    if (m && m.index < cut) cut = m.index;
  }
  return x.slice(0, cut).trimEnd();
}

// The single source of truth for castLock's text — used both here (R7, where
// it's injected) and by stripCastLockTail() above (via CASTLOCK_TAIL_MARKERS,
// where it's stripped back out for authoredOnly()). Exported so a test can
// enumerate all 8 real variants and assert authoredOnly() removes each one
// completely, instead of asserting against a hand-copied string that only
// happens to match today's wording.
export function buildCastLock(
  names: string[],
  crowd: boolean,
  hasIndirectPresence: boolean,
  namedNoDupe: string
): string {
  return crowd
    ? names.length === 0
      ? hasIndirectPresence
        ? "No named character is physically present in the foreground. If a reflection, shadow, silhouette, or partial glimpse is described above, that is the only trace of a person in this shot — do not add any additional person, body, or figure beyond what is already stated."
        : "No people in the foreground."
      : names.length === 1
      ? `${names[0]} is the ONLY person in the foreground. Do NOT add a second figure. Every other human is a blurred, out-of-focus background figure at plausible human scale. Nobody approaches, faces, or speaks to them.`
      : `Exactly ${names.length} people in the foreground: ${names.join(", ")}. No other foreground figures.${namedNoDupe}`
    : names.length === 0
    ? hasIndirectPresence
      ? "No named character is physically present anywhere in this room right now. If a reflection, shadow, silhouette, or partial glimpse is described above, that is the only trace of a person in this shot — do not add any additional person, body, or figure beyond what is already stated."
      : "No people appear anywhere in this frame, foreground or background — this location is otherwise completely empty right now."
    : names.length === 1
    ? `${names[0]} is the ONLY person anywhere in this frame — foreground AND background. Do NOT add a second figure, not even blurred or distant. There is nobody else in this location at all: no background figures, no bystanders, nobody glimpsed through a doorway, window, or hallway.`
    : `Exactly ${names.length} people appear anywhere in this frame — foreground AND background: ${names.join(", ")}. There is nobody else in this location at all: no background figures, no bystanders, nobody else glimpsed anywhere in the shot.${namedNoDupe}`;
}

// REAL BUG, CONFIRMED VIA A FAILED IDEMPOTENCY TEST: authoredOnly() strips the
// compiler's OWN boilerplate (cast-lock, continuity, ground-contact, emotion-
// lock) but was never extended to strip ACTION_LIBRARY / LIGHTING_LIBRARY /
// PACE_LIBRARY injections. Those ARE equally "not authored by the LLM" — but
// unlike the boilerplate above (which an LLM repair pass sometimes rewords,
// hence the fuzzy regexes), a library injection is a direct, deterministic
// string append (see the injection loops below) and is ALWAYS byte-identical
// to its source JSON, so an exact string removal is safe and precise here —
// no fuzzy matching needed. Without this, a second compile pass sees the
// FIRST pass's already-injected text as if the LLM had authored it: confirmed
// on camera, a shot whose injected stair-mechanics text happens to contain
// the word "lifts" (a STATE_CHANGE trigger) spuriously gained a brand new
// STATE_CHANGE_NEEDS_ENDFRAME issue on the SECOND compile that never fired on
// the first — the exact "recompile changes behavior" class of bug this whole
// idempotence design exists to prevent, just via a library this function
// never knew to account for.
const LIBRARY_INJECTED_TEXTS: string[] = [
  ...ACTION_LIBRARY.map((a) => a.description),
  ...LIGHTING_LIBRARY.map((m) => m.description),
  ...PACE_LIBRARY.flatMap((p) => [p.description, p.cameraNote]),
  ...LENS_LIBRARY.map((l) => l.description),
  ...CAMERA_MOVE_LIBRARY.map((c) => c.description),
  ...REACTION_LIBRARY.map((r) => r.description),
  // TWO-BODY CONTACT INJECTION's fixed clause (below) — a literal, unvarying
  // string like the *_LIBRARY descriptions above, just not sourced from a
  // JSON array.
  "Physical contact stays precise: both people remain two separate, complete bodies — one head and two arms " +
  "each — with a visible seam or gap where they touch and nowhere else; no blending of hair, skin tone, or " +
  "clothing along the contact line.",
  // COUNTER / SHOP GEOMETRY REMINDER's fixed clause (below) — same reasoning.
  "The counter separates them: the customer stays on the public side of the counter, facing it; the " +
  "shopkeeper stays BEHIND the counter on the service side, shelves and stock behind them, facing the " +
  "customer. Both are fully inside the shop — neither crosses to the other's side, and neither is ever " +
  "shown outside while the other is inside.",
].filter(Boolean);

// PROP APPEARANCE / PLACEMENT LOCK (much further below in this file) appends
// a fixed-shape reminder sentence to s.setting rather than a fixed literal
// string (the prop noun and its canonical descriptor vary per shot), so it
// can't just be added to LIBRARY_INJECTED_TEXTS above like the *_LIBRARY
// description arrays. Stripped here by pattern instead — same reasoning as
// every other regex-based strip below: if authoredOnly() doesn't know about
// it, SCENE SETTING LOCK's richest-wins comparison (which calls authoredOnly()
// to measure richness) would see the injected reminder as if it were genuine
// authored richness and start prepending IT onto other shots, growing a
// little more every recompile — confirmed happening in testing before this
// was added.
const PROP_REMINDER_RE =
  /The [a-z ]+ here is the SAME object as established earlier in this scene:[^.]*\. Same size, same color, same shape as before — it has not changed appearance or scale\./gi;

// WORLD-STATE PROP CARRY (much further below, alongside R9) injects this
// fixed-shape reminder into s.motion when a character established carrying
// an object in an EARLIER, non-adjacent shot (possibly a different scene)
// reappears without any mention of it. Same reasoning as PROP_REMINDER_RE
// just above: the object noun varies per shot, so this can't be a fixed
// LIBRARY_INJECTED_TEXTS string, and without stripping it here, a later
// compile pass extracting "what is this character currently holding" from
// s.motion would read its OWN reminder text back as if it were a fresh,
// authored holding statement — confirmed while designing this: the reminder
// sentence itself contains "carrying the X", which the same holding-verb
// regex used to DETECT a held object would otherwise happily re-match.
const WORLD_STATE_CARRY_RE =
  /Still carrying the [a-z][a-z '-]*? established earlier in the film, unless this shot explicitly shows it being set down, handed off, or replaced\.?/gi;

// CONFIRMED REAL, LIVE FAILURE, FIXED: lockSceneField() (below) prepends the
// "richest" same-scene shot's setting/lighting text onto every thinner shot
// in that scene run, so a camera-angle change doesn't lose fixed scene
// detail. That injection was NEVER marked, so authoredOnly() (this function)
// had no way to strip it back out — every later compileBreakdown() pass
// (regen_shot, delete_shot, insert_shot, a repair round) saw the ALREADY-
// enriched field as "authored" content, computed a NEW (now even longer)
// richText from it, and prepended AGAIN on top. Confirmed on a real render:
// one shot's keyframe prompt grew past 50,000 characters — fal.ai's hard
// limit — from the SAME setting/lighting sentence duplicated dozens of times
// over repeated compiles of one persisted project. Stripping this marker
// here (so `ownAuthored` always reflects only genuine original text) is what
// makes lockSceneField()'s rebuild idempotent — see its own comment.
//
// Delimited with non-printable control characters (\x02/\x03), not visible
// text like "[SCENE-LOCK]" — 4-images.ts/5-videos.ts read shot.setting/
// .lighting RAW (no authoredOnly() pass) to build the real render prompt, so
// a visible tag would leak literal bracket text into what's actually sent to
// the image/video model. Control characters carry the same content through
// untouched (the richText itself still reaches the model, which is the
// point) while staying invisible everywhere the raw field is read or
// displayed. Same technique already used in this codebase for exactly this
// "needs an unambiguous machine marker, must never visibly leak" reason —
// see lib/fingerprint.ts's own join separator.
const SCENE_LOCK_OPEN = "\x02";
const SCENE_LOCK_CLOSE = "\x03";
const SCENE_LOCK_RE = new RegExp(`^${SCENE_LOCK_OPEN}[\\s\\S]*?${SCENE_LOCK_CLOSE}\\s*`);

export function authoredOnly(x: string): string {
  let stripped = (x || "").replace(SCENE_LOCK_RE, "");
  for (const injected of LIBRARY_INJECTED_TEXTS) {
    if (injected) stripped = stripped.split(injected).join("");
  }
  return stripCastLockTail(stripped)
    .replace(PROP_REMINDER_RE, "")
    .replace(WORLD_STATE_CARRY_RE, "")
    .replace(/CONTINUITY:[\s\S]*$/i, "")
    // Gap D's directional reassertion (see just below negativeFor()) is
    // always appended LAST to s.motion, same tail-of-string shape as
    // CONTINUITY: above — same truncate-from-marker strip, so a recompile
    // doesn't read its own injected sentence back as authored motion text
    // (which would otherwise inflate word/beat counts and pollute richness
    // comparisons that call authoredOnly() on s.motion).
    .replace(/\s*MOVING DIRECTION:[\s\S]*$/i, "")
    // Gap A's persistence reinforcement (see the GAP A · PROP APPEARANCE
    // block) — same tail-of-string shape and same reasoning as MOVING
    // DIRECTION: above. A separate, explicit strip (not just relying on
    // MOVING DIRECTION:'s own greedy tail-strip to catch it too) because a
    // shot can have a tracked prop with NO motionDirection set — the far
    // more common case — leaving this as the ONLY tail marker present.
    .replace(/\s*PROP PERSISTENCE:[\s\S]*$/i, "")
    // R9's redepiction guard (MOTION_REDEPICTS_COMPLETED_ACTION, see the R9
    // block above) — same tail-of-string shape and reasoning as MOVING
    // DIRECTION:/PROP PERSISTENCE: above, and its own separate strip for the
    // same reason: a shot can have this marker with neither of those two
    // present, so it can't rely on either of their greedy tail-strips to
    // catch it incidentally.
    .replace(/\s*ALREADY COMPLETE — DO NOT RE-PERFORM:[\s\S]*$/i, "")
    // R7.6c's excess-duration autofix (ACTION_DURATION_EXCESS_LIBRARY, see
    // that push site further below) — same tail-of-string shape and same
    // reasoning as MOVING DIRECTION:/PROP PERSISTENCE:/ALREADY COMPLETE
    // above: a recompile must not read our own appended hold instruction
    // back as authored motion text, or it would inflate beat counts and
    // pollute the very duration-vs-content comparisons this check is for.
    .replace(/\s*HOLD AFTER COMPLETING:[\s\S]*$/i, "")
    .replace(/[^.]*ONLY person in the foreground[^.]*\./gi, "")
    .replace(/[^.]*people in the foreground:[^.]*\./gi, "")
    .replace(/[^.]*No people in the foreground\.?/gi, "")
    .replace(/[^.]*No other foreground figures\.?/gi, "")
    // The director REWORDS our boilerplate rather than copying it, so matching
    // the exact appended sentence was not enough. "Both feet make firm, visible
    // contact" came back as "both feet making firm contact with the wet ground",
    // and the expression lock as "eyes hard and focused throughout — no smiling,
    // no relaxing". Those variants slipped through, and the continuity handoff
    // ended up describing our own safety clauses instead of the story beat: the
    // next shot was told she had been "brow furrowed, jaw set" rather than
    // walking with the briefcase having just checked her watch.
    .replace(/[^.]*\bboth feet\b[^.]*\.?/gi, "")
    .replace(/[^.]*\bexpression stays\b[^.]*\.?/gi, "")
    .replace(/[^.,]*\bno smil(?:e|ing)[^.]*\.?/gi, "")
    .replace(/[^.,]*\bno relax(?:ing)?\b[^.]*\.?/gi, "")
    .replace(/[^.,]*\b(?:brow furrowed|jaw set|eyes hard and focused)\b[^.]*\.?/gi, "")
    .replace(/\s*[—–-]\s*(?=[.,]|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;])/g, "$1")
    .replace(/(?:^|\s)([.,;])+/g, "$1")
    .trim();
}

/** Two shots are "the same place" when their scene labels (or settings) match. */
const sceneKey = (s: Shot) => (s.scene || s.setting || "").trim().toLowerCase().slice(0, 60);

/**
 * SAME PLACE? — fuzzy, on purpose.
 *
 * This used to be an exact string compare on the first 60 characters of the
 * scene/setting. The LLM rewords its setting slightly between shots even when
 * told not to ("a narrow stone lane" vs "the narrow stone lane, cobbles"), so
 * the compare failed, the continuity chain never fired, and the film came out as
 * three unrelated clips bolted together. Token overlap is forgiving of wording
 * drift while still catching a genuine location change.
 */
function sameScene(a: Shot, b: Shot): boolean {
  const norm = (x: string) => (x || "").toLowerCase().match(/\b[a-z]{4,}\b/g) ?? [];
  const sa = (a.scene || "").trim().toLowerCase();
  const sb = (b.scene || "").trim().toLowerCase();
  if (sa && sb && sa === sb) return true;              // explicit same scene label
  const A = new Set(norm(`${a.scene} ${a.setting}`));
  const B = new Set(norm(`${b.scene} ${b.setting}`));
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.4;     // 40% overlap = same place
}

/**
 * Counts distinct action "beats" in a motion string — used by MOTION_TOO_
 * DENSE_FOR_DURATION (the inverse of MOTION_TOO_THIN_FOR_NATURAL: too MUCH
 * action for too little time, not too little text). Matches this codebase's
 * own authoring convention (llm.ts's "First ... then ... finally ..."
 * guidance) by splitting on BOTH sentence boundaries and explicit
 * sequencing connectors — motion text sometimes writes one beat per
 * sentence, sometimes chains several beats in one sentence with these
 * connector words. Tiny fragments (under 3 words) are dropped — a trailing
 * clause like "then goes" isn't a real, independently-timeable beat.
 */
export function countMotionBeats(text: string): number {
  const normalized = (text || "").trim();
  if (!normalized) return 0;
  return normalized
    .split(/[.!?]+\s+|\s*,?\s+(?:then|next|finally|afterward|after that|before that)\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).filter(Boolean).length >= 3).length;
}

// ── Negatives (folded into the Seedance 1.5 Pro prompt as an "AVOID: ..." clause — Seedance has no native negative_prompt field; see video.ts) ─
const BASE_NEGATIVE = [
  // PHOTOREALISM. The image/video models default toward a glossy, over-smooth,
  // slightly animated look unless told explicitly not to — this is what reads
  // to a viewer as "obviously AI" before any continuity error is even noticed.
  "cartoon", "anime", "3D render", "CGI", "video game graphics", "illustration",
  "digital painting", "concept art", "stylized", "low-poly", "claymation",
  "plastic skin", "waxy skin", "wax figure", "mannequin skin", "uncanny valley",
  "airbrushed skin", "over-smoothed skin", "video game cutscene", "unreal engine render",
  "floating", "levitating", "feet not touching the ground", "hovering",
  "distorted limbs", "extra limbs", "deformed hands", "morphing", "warping",
  "duplicate person", "duplicated", "double subject", "clone", "inconsistent scale", "miniature people", "tiny background people",
  // NAMED-SUBJECT SCALE — "inconsistent scale"/"miniature people"/"tiny
  // background people" just above are the CROWD-scoped version of this guard
  // (4-images.ts's own headcount/scaleLock text is the positive-side fix for
  // the named subject; this is its negative-side counterpart, previously
  // missing entirely — the crowd fix's own comment literally says "hence the
  // tiny people," but never extended the same protection to the foreground
  // lead). Confirmed real: a shorter, stooped older character rendered
  // visibly smaller than the room and furniture around him.
  "the main subject rendered smaller than a real person relative to their surroundings",
  "a named character looking miniature, doll-sized, or child-sized despite being an adult",
  "the foreground person appearing shrunken or distant while the room around them stays full-sized",
  // MOTION-LEVEL REPETITION. Distinct from the STATIC duplication guards below
  // (a second body in the same frame) — these are VIDEO-ONLY artifacts where
  // the clip's own motion repeats or mirrors itself. Real reported failure: a
  // chase shot where the runner visibly passed a landmark, then the SAME
  // stretch of street and the SAME running cycle played again within the one
  // clip, reading as if the render had looped back to its own start rather
  // than continuing forward.
  "mirrored action", "repeating loop", "motion looping back to repeat an earlier position",
  "the clip appearing to restart partway through", "the same movement cycle playing twice in one shot",
  "character re-crossing ground they already covered earlier in the same shot",
  // DIRECTION-LEVEL FAILURE. A different artifact from the repetition guards
  // just above: not the motion repeating, but running the WRONG WAY — real
  // reported failure: a shot describing someone walking toward camera / coming
  // closer instead reads as them receding or moving backward, sometimes with
  // the walk cycle itself looking undone (heel striking before toe, weight
  // recoiling instead of settling forward), as if the footage were playing in
  // reverse.
  "walking backward when approaching or coming closer is intended", "reversed walk cycle",
  "footage appearing to play in reverse", "moving away from camera when the shot describes approaching it",
  "receding when the shot describes drawing closer",
  // "static pose"/"frozen subject"/"holding a pose"/"no motion" USED to live
  // in this array unconditionally — moved out to HOLD_POSE_NEGATIVE (below)
  // and applied conditionally by negativeFor() instead. CONFIRMED REAL GAP,
  // FIXED: R7.6c's ACTION_DURATION_EXCESS_LIBRARY autofix (compiler.ts, see
  // that push site) tells the model to hold a quick action's completed pose
  // for the remainder of a shot padded out by Seedance's render floor — the
  // exact behavior these four terms banned. Sent together, the model was
  // told "hold the pose" in the positive prompt and "no static pose/holding
  // a pose" in the negative prompt for the SAME shot, which is how a 1-2s
  // pick-up action padded into a 4s clip ends up looping (lift, replace,
  // lift again) instead of settling: with holding banned outright, looping
  // the gesture was one of the few ways left to keep showing motion.
  "stiff robotic movement", "unnatural motion", "jerky animation", "mannequin",
  "lifeless face", "blank expression", "dead eyes", "puppet-like",
  // REACTION REALISM. The single most common AI-video "tell" in a face isn't
  // a bad texture, it's TIMING: an expression that is fully formed on the
  // very first frame with no anticipation, both sides of the face moving in
  // perfect lockstep, and eyes that never blink because the model found no
  // reason to move them. Real human faces are asymmetric and always blinking
  // on their own schedule, reaction or not.
  "character never blinking throughout the shot", "perfectly symmetric mirrored facial expression",
  "instant fully-formed reaction with no anticipation or build", "robotic identical-speed blinking",
  "expression appearing before any cause is shown", "frozen unmoving face during dialogue or reaction",
  "sliding feet", "gliding without steps", "feet skating on the ground",
  "limbs passing through the body", "body parts detaching", "melting anatomy",
  "rubber limbs", "impossible joint bend", "head turning too far",
  // ENVIRONMENT-CLIPPING PHYSICS. qa.ts's post-render vision check explicitly
  // watches for "bodies/hands pass through walls, furniture, or each other" as
  // a physics_violation finding (see QA_SYSTEM in providers/qa.ts) -- but until
  // now nothing here told the model to avoid it on the FIRST attempt, so every
  // occurrence relied entirely on a paid re-roll to catch after the fact. Same
  // failure category as "limbs passing through the body" just above, extended
  // to the environment instead of just other people.
  "hand or body passing through a wall", "limbs clipping through furniture",
  "body passing through a solid object", "hand sinking into a surface it should rest on",
  "speed ramping", "sudden teleport", "figure popping into frame",
  "smiling during action", "neutral expression during action",
  "text", "watermark", "subtitles", "logo",
  // NO SCORE. generate_audio (video.ts) renders whatever audio the model
  // decides to add, and 6-assemble.ts has no separate audio mixing stage to
  // strip anything unwanted back out afterward — a music bed baked into ONE
  // clip cannot be cleanly removed downstream, and clips are stitched with
  // simple concat, so an inconsistent score across independently-generated
  // clips (different key, tempo, instrumentation shot to shot) would be one
  // of the most obviously "not a real production" tells in the finished film.
  // Diegetic sound only (dialogue, ambience, foley) is exactly what the rest
  // of this prompt already asks for; this is the negative-side backstop.
  "background music", "musical score", "soundtrack", "non-diegetic music",

  // THESE MUST APPLY TO EVERY SHOT, NOT JUST SOLO ONES. They used to live in
  // SOLO_NEGATIVE, which the compiler only attaches when a shot has ONE
  // character — so any two-character shot (customer + shopkeeper) went out with
  // no duplicate protection at all, and the lead was rendered twice, overlapping.
  "two copies of the same person", "duplicate of a character", "cloned person",
  "the same face appearing twice", "a person overlapping another person",
  "figures merging together", "two heads on one body", "ghost double",
  // HAND-OFF PHYSICS. Confirmed on camera: coins passed hand-to-hand scattered
  // and fell mid-exchange instead of transferring as a closed handful, and a
  // parcel held out looked stuck or glued flat against an open palm with no
  // fingers actually wrapped around it — no grip, no weight, like a sticker.
  "coins spilling", "coins scattering", "coins falling during a handoff",
  "money dropping to the ground", "object floating against an open palm",
  "item stuck or glued to the hand", "no visible grip on the object",
  "fingers not wrapped around the object", "object with no weight or contact",
  // OBJECT PERMANENCE ACROSS A CHAIN. Confirmed on camera: car keys held in a
  // character's hand across a continuity chain became a phone in the next shot
  // with no on-screen pickup, hand-off, or put-down to explain it — the exact
  // same "wrong identity" failure as a face changing, but for a prop.
  "a held object changing into a different object between frames",
  "keys turning into a phone or any other item with no hand-off shown",
  "an object in the hand silently swapping for a different object",
  "a prop's identity changing across the shot with no pickup or put-down shown",
  // ENVIRONMENT PERMANENCE — same "wrong identity" failure as the object-
  // permanence guards just above, applied to the SETTING ITSELF instead of a
  // held prop. qa.ts's environment_changed finding (and this session's
  // SCENE_GEOMETRY_NOT_ESTABLISHED check / location reference sheets) catch
  // this AFTER the fact; nothing previously told the model to avoid it on
  // the first attempt at all — a real, confirmed gap, not a hypothetical.
  "background architecture changing partway through the shot", "walls or furniture rearranging mid-clip",
  "a building or landmark changing shape or position during the shot", "the room's fixed layout shifting between frames",
  "background details appearing or disappearing with nothing explaining it", "the setting silently becoming a different place mid-shot",
  // OWL-NECK. Confirmed on camera: a character walking away kept their body and
  // legs facing forward while their head rotated a full 360 degrees on its own,
  // independent of the shoulders — a cartoon-physics failure, not a look-back.
  "head rotating 360 degrees", "head spinning independently of the body",
  "impossible neck rotation", "owl-like head turn", "head twisting past the shoulders",
  // ACTION COMPLETENESS — the bar for this whole product: a viewer should feel a
  // real human performed the action, not a synthetic approximation cut short.
  // "stiff robotic movement"/"unnatural motion"/"jerky animation" above cover HOW
  // the motion moves; these cover whether it actually FINISHES and takes the real
  // amount of time a human body needs, applied to every shot the same way the
  // hand-off/object-permanence negatives above are, not just to specific
  // ACTION_LIBRARY entries.
  "action left unfinished or cut short", "motion frozen partway through the action",
  "the described action not reaching its natural completion by the last frame",
  "action compressed into an implausibly short time", "action stretched out implausibly slowly",
  "movement that skips or jumps between poses instead of flowing continuously between them",
].join(", ");

// Pulled out of BASE_NEGATIVE — see that array's own comment at "static
// pose"/"frozen subject"/"holding a pose"/"no motion" for why: applied
// UNCONDITIONALLY it directly contradicts R7.6c's ACTION_DURATION_EXCESS_
// LIBRARY autofix, which deliberately tells the model to hold a quick
// action's completed pose for the rest of a render-floor-padded shot.
// negativeFor() below applies this everywhere EXCEPT that one case.
const HOLD_POSE_NEGATIVE = ["static pose", "frozen subject", "holding a pose", "no motion"].join(", ");

const SOLO_NEGATIVE = [
  "second person in the foreground", "another person facing the subject",
  "two people talking", "over-the-shoulder framing", "conversation partner",
  "a person standing in front of the subject",
  // Solo-only extras (the universal duplicate guards now live in BASE_NEGATIVE).
  "a second identical man", "a person emerging from behind the subject",
  "a background person walking into the subject", "person passing in front of the subject",
].join(", ");

// ── AN INDIRECT PRESENCE IS STILL A PRESENCE ───────────────────────────────
// "characters" correctly lists only who is PHYSICALLY in the room — a reflection,
// shadow, or silhouette of someone is not physically there, so the array is
// legitimately empty. But the castLock text below used to always say "this
// location is otherwise completely empty right now" whenever the array was
// empty, with no check for what the shot's OWN description already says.
// Confirmed on camera, independently, in three different scripts: a mirror
// shot describing "Sarah stands just inside the nursery" IN THE REFLECTION,
// a shadow shot describing "the faint shadow of a person (Arjun) is visible",
// and a photo-insert shot describing "the edge of Sarah's hand" — each one
// then flatly asserted "No people appear anywhere in this frame... completely
// empty" in the very same paragraph. A shot cannot both describe a person's
// trace and deny anyone is there; the renderer gets contradictory instructions
// and a human reader spots the contradiction immediately.
const INDIRECT_PRESENCE =
  /\b(reflection|reflected|mirror|shadow of a person|silhouette|silhouetted|handprint|footprint|outline of a person|a hand (?:is visible|lies|slams|presses|appears|reaches)|pale hand|small hand|edge of \w+'s hand)\b/i;

// A shot with ZERO people should render zero people — not "zero people in the
// foreground, and whatever the model feels like in the background." Confirmed on
// camera: a bare foot/leg kicking a table in a shot whose own text said "No
// people in the foreground." The positive prompt already said nobody is there;
// this is the negative-side backstop for the same rule.
const EMPTY_CAST_NEGATIVE = [
  "any person", "human body part", "hand", "foot", "leg", "arm", "human silhouette",
  "person walking into frame", "someone entering the shot",
].join(", ");

// Applies whenever the scene is NOT a deliberate crowd (market, stadium, street) —
// i.e. most interiors, most two- or three-hander drama. Confirmed on camera: a
// woman with no story reason to exist standing in the hallway behind a character
// in exactly this kind of private-house shot.
const NO_STRANGERS_NEGATIVE = [
  "unscripted extra person", "unnamed stranger", "background stranger",
  "someone visible through a doorway who was not described", "an uncredited extra",
  "a person who does not belong in this scene",
].join(", ");

// CROWD scenes are the one place NO_STRANGERS_NEGATIVE does NOT apply (strangers are
// the whole point of a market/stadium/street), which left exactly zero negative-side
// protection against the crowd's most damaging failure: a background figure painted
// with the SAME identity as the named lead, reading as the character duplicating
// themselves. Confirmed on camera: a market scene's one named character appeared to
// duplicate himself in the crowd. Distance-only guards (CROWD SEPARATION, above)
// don't touch this — a duplicate ten feet away is still a duplicate.
const CROWD_IDENTITY_NEGATIVE = [
  "background figure with the same face as the named character", "duplicate of the lead in the crowd",
  "a crowd member who looks like the subject", "cloned identity in the background",
  "repeated identical face among background people",
].join(", ");

/**
 * Reflective surfaces (mirror, glass, screen, window) are how a scripted shot
 * gets its reveal — and how an UNSCRIPTED one gets a spontaneous duplicate of the
 * subject. Confirmed on camera: a mirror appeared, with a second copy of the lead
 * standing in it, in a shot whose own description never mentioned a mirror at
 * all. If THIS shot's own text does not call for a reflective surface, forbid one
 * outright — a shot that legitimately wants a mirror describes it explicitly (see
 * the MIRRORS/MONITORS rule) and is unaffected by this negative.
 */
function reflectionGuardFor(shot: Shot): string {
  const ownText = `${shot.description} ${shot.setting} ${shot.camera} ${shot.startFrame} ${shot.endFrame}`;
  if (REFLECTIVE.test(ownText)) return "";
  return [
    "mirror", "reflective glass", "reflection of the subject", "duplicate reflection",
    "unintended mirror", "glass panel doubling the subject", "second copy of the subject in glass or a mirror",
  ].join(", ");
}

/**
 * SINGLE-INSTANCE PROPS — the object-duplication twin of the person-duplication
 * guard above. Confirmed on camera: a nursery scene with exactly one crib in every
 * shot's own text rendered with TWO cribs in frame; a market stall's one wrapped
 * parcel and a station commuter's one bag flickered in and out of existence across
 * cuts. The existing r-4 rule ("a single-instance object appears exactly once...")
 * is a prompt-level ask the model doesn't reliably follow; this is the deterministic
 * backstop, mirroring the person-duplication guard: if a shot's own text names one
 * of these common single-instance props WITHOUT a plural/counted qualifier ("two",
 * "several", a number > 1) right next to it, forbid a second one outright.
 */
const SINGLE_INSTANCE_PROPS = [
  "crib", "cradle", "bassinet",
  "parcel", "package",
  "wallet", "purse",
  "backpack", "duffel", "duffel bag", "handbag", "bag",
  "phone", "smartphone",
  "mirror", // in addition to reflectionGuardFor's own-mirror-scoped check, guard against a SECOND mirror when one is already named
];
function singleInstancePropGuard(shot: Shot): string {
  const ownText = `${shot.description} ${shot.setting} ${shot.startFrame} ${shot.endFrame}`.toLowerCase();
  const found = new Set<string>();
  for (const noun of SINGLE_INSTANCE_PROPS) {
    if (!ownText.includes(noun)) continue;
    // Skip nouns the shot's own text already pluralizes/counts (e.g. "two coins",
    // "several bags") -- those legitimately want more than one and this guard would
    // otherwise contradict the shot's own description.
    const pluralOrCounted = new RegExp(`\\b(?:two|three|four|five|six|several|multiple|a few|many|both)\\s+(?:\\w+\\s+){0,2}${noun}s?\\b`, "i");
    if (pluralOrCounted.test(ownText)) continue;
    found.add(noun);
  }
  if (!found.size) return "";
  return [...found].map((n) => `duplicate ${n}, two ${n}s, a second ${n} appearing anywhere in the frame`).join(", ");
}

// domainNegatives: bd.domainPack?.negatives (see types.ts's own comment on
// that field) — llm.ts's DOMAIN_PACKS carries domain-specific "never render
// this" facts (a cricket scoreboard animating, a coach on the pitch) that used
// to reach ONLY the planning prompt, with nothing enforcing them once shots
// existed — neither compiler.ts nor qa.ts had any domain-specific category at
// all. Applied universally like BASE_NEGATIVE (not content-matched per shot):
// an extra, irrelevant domain negative is harmless on an unrelated shot, the
// same reasoning BASE_NEGATIVE itself already relies on. domainPack's OTHER
// fields (roleRules, physicsRules) are deliberately NOT folded in here — they
// are phrased as positive facts ("a ball hit for six lands outside the
// boundary"), and pasting a positive claim into an "AVOID:" clause reads
// backwards to the model. Those remain planning-time-only guidance.
// Gap D — DIRECTIONAL MOTION CONSISTENCY. Reasserted every render call the
// same way BASE_NEGATIVE's anatomy constraints are — a model that ignores a
// stated direction once in the positive motion text still has this as a
// second, explicit negative constraint working against the same failure.
// Confirmed real: a shot scripted as "crosses the road toward camera"
// rendered the subject walking away instead. Paired with qa.ts's own
// reversed_motion finding (already built, prior session) which now also
// receives this same structured field as an unambiguous signal instead of
// inferring direction from loose prose alone.
export const DIRECTION_LABEL: Record<MotionDirection, string> = {
  toward_camera: "toward the camera, getting closer with every step",
  away_from_camera: "away from the camera, receding with every step",
  left_to_right: "from screen-left to screen-right",
  right_to_left: "from screen-right to screen-left",
  forward: "forward, toward their destination",
  backward: "backward, away from their starting point",
};
const DIRECTION_NEGATIVE: Record<MotionDirection, string> = {
  toward_camera: "walking or moving away from camera, receding, backward travel",
  away_from_camera: "walking or moving toward camera, approaching, backward travel",
  left_to_right: "moving right-to-left, reversed direction of travel",
  right_to_left: "moving left-to-right, reversed direction of travel",
  forward: "moving backward, receding, reversed direction of travel",
  backward: "moving forward, reversed direction of travel",
};

export function negativeFor(shot: Shot, domainNegatives?: string[]): string {
  const parts = [BASE_NEGATIVE];
  // See HOLD_POSE_NEGATIVE's own comment — omitted for exactly the shots
  // R7.6c's autofix appended a "hold the completed pose" instruction to,
  // so the negative prompt doesn't immediately contradict that instruction.
  if (!shot.motion.includes("HOLD AFTER COMPLETING:")) parts.push(HOLD_POSE_NEGATIVE);
  if (domainNegatives?.length) parts.push(domainNegatives.join(", "));
  if (shot.motionDirection) parts.push(DIRECTION_NEGATIVE[shot.motionDirection]);
  if ((shot.characters?.length ?? 0) <= 1) parts.push(SOLO_NEGATIVE);
  if ((shot.characters?.length ?? 0) === 0) parts.push(EMPTY_CAST_NEGATIVE);
  if (!shot.crowd) parts.push(NO_STRANGERS_NEGATIVE);
  if (shot.crowd && (shot.characters?.length ?? 0) > 0) parts.push(CROWD_IDENTITY_NEGATIVE);
  const reflectionGuard = reflectionGuardFor(shot);
  if (reflectionGuard) parts.push(reflectionGuard);
  const propGuard = singleInstancePropGuard(shot);
  if (propGuard) parts.push(propGuard);
  // ACTION LIBRARY — re-derives the same match this shot's motion enrichment
  // used (see the per-shot loop), rather than threading extra state through:
  // the enrichment only ever APPENDS text, so matching again against the
  // (now-enriched) motion/description still finds the same triggers.
  const actionNegatives = matchActions(`${authoredOnly(shot.motion)} ${authoredOnly(shot.description)}`)
    .flatMap((a) => a.negatives);
  if (actionNegatives.length) parts.push(actionNegatives.join(", "));
  // LIGHTING LIBRARY — re-derives the same match this shot's lighting
  // enrichment used above, same reasoning as the action negatives just above.
  const lightingNegatives = matchLighting(`${authoredOnly(shot.lighting)} ${authoredOnly(shot.setting)} ${authoredOnly(shot.description)}`)
    .flatMap((m) => m.negatives);
  if (lightingNegatives.length) parts.push(lightingNegatives.join(", "));
  // PACE LIBRARY — same re-derivation reasoning as action/lighting above.
  const paceNegatives = matchPace(`${authoredOnly(shot.motion)} ${authoredOnly(shot.description)}`)
    .flatMap((p) => p.negatives);
  if (paceNegatives.length) parts.push(paceNegatives.join(", "));
  // LENS LIBRARY — keyed by framingFamily of the shot's (by now final) camera
  // text, not a re-derived text match like the three libraries above. Only
  // meaningful once negativeFor() is called AFTER the lens injection pass —
  // see compileBreakdown()'s final negativePrompt recompute for why it's
  // called twice (once early at R8, once again at the very end).
  const lensEntry = lensFor(shot.camera);
  if (lensEntry?.negatives?.length) parts.push(lensEntry.negatives.join(", "));
  // REACTION LIBRARY — re-derives the same match this shot's motion
  // enrichment used (see the per-shot injection loop), same reasoning as
  // action/lighting/pace negatives above.
  const reactionNegatives = matchReaction(`${authoredOnly(shot.motion)} ${authoredOnly(shot.description)}`)
    .flatMap((r) => r.negatives);
  if (reactionNegatives.length) parts.push(reactionNegatives.join(", "));
  return parts.filter(Boolean).join(", ");
}

export interface CompileIssue {
  shotId: string;
  code: string;
  severity: "error" | "warn";
  detail: string;
  autofixed: boolean;
}

/** Extracts every quoted line of dialogue from the ORIGINAL SCRIPT text and
 *  verifies each one survives into SOME shot's own "dialogue" field in the
 *  final breakdown — catching content silently DROPPED during breakdown,
 *  not just malformed content already in the breakdown (which the rest of
 *  this file's checks validate). Confirmed real, repeatedly, across many
 *  independently-tested scripts: a script's line of dialogue simply never
 *  appears anywhere in the generated shots, often replaced by a vague
 *  physical description ("mouth open in a shout") instead of the actual
 *  words. compileBreakdown() itself never sees the raw script (by design —
 *  it validates the breakdown's own internal consistency, not fidelity to
 *  an external document), so this is a deliberately SEPARATE function,
 *  called explicitly by 1-breakdown.ts's orchestration after each compile,
 *  not folded into compileBreakdown()'s own per-shot loop.
 *
 *  Match is intentionally loose (normalized substring, not exact-verbatim):
 *  fuzzy enough that a shot which genuinely DOES carry the line (perhaps
 *  with different surrounding punctuation) isn't wrongly flagged, but
 *  strict enough that a shot merely describing the ACT of speaking, without
 *  the actual words, still counts as a miss — which is exactly the
 *  confirmed real failure mode. */
export function checkScriptDialogueCoverage(shots: Shot[], script: string): CompileIssue[] {
  const issues: CompileIssue[] = [];
  if (!shots.length) return issues;

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  const allDialogue = shots.map((s) => normalize(s.dialogue || "")).join(" ¦ ");

  const QUOTED_LINE_RE = /"([^"]{3,300})"/g;
  const seen = new Set<string>(); // de-dupe an identical line quoted more than once in the script
  let m: RegExpExecArray | null;
  while ((m = QUOTED_LINE_RE.exec(script))) {
    const raw = m[1].trim();
    const normLine = normalize(raw);
    if (normLine.length < 3 || seen.has(normLine)) continue;
    seen.add(normLine);
    if (allDialogue.includes(normLine)) continue;

    // TITLE FALSE-POSITIVE — CONFIRMED REAL (2026-08-05, "The Package"
    // series): scripts are conventionally written with the title itself
    // wrapped in quotes on its own line near the top ("[Target length: 1
    // min]\n\"The Package 3\"\n\nCHARACTERS:..."). QUOTED_LINE_RE has no
    // concept of "is this actually spoken dialogue" vs "just a quoted
    // title" — it flagged the title as a dropped line every single time,
    // and the repair model dutifully inserted "The Package 3" as literal
    // spoken dialogue into shot1, which then got spoken aloud by the video
    // model's native audio. Real dialogue is never the ENTIRE content of
    // its own line with nothing else around it (no action, no attribution)
    // this early in the document — a title is exactly that shape, so this
    // narrow signature catches the title without needing scene-heading
    // parsing (some scripts here are prose with no INT./EXT. sluglines at
    // all, so that convention can't be relied on generally).
    const lineStart = script.lastIndexOf("\n", m.index) + 1;
    const lineEnd = script.indexOf("\n", m.index);
    const wholeLine = script.slice(lineStart, lineEnd === -1 ? script.length : lineEnd).trim();
    const isBareQuoteLine = wholeLine === m[0];
    const isNearTop = m.index < 300;
    if (isBareQuoteLine && isNearTop) continue;

    // Anchor the issue to the shot whose position in the shot list roughly
    // matches this line's position in the script — a deliberately crude
    // heuristic (this pipeline has no scene-to-shot alignment map), good
    // enough to point the repair at approximately the right neighborhood
    // rather than always defaulting to the first or last shot.
    const fraction = script.length > 0 ? m.index / script.length : 0;
    const anchorIdx = Math.max(0, Math.min(shots.length - 1, Math.round(fraction * (shots.length - 1))));
    issues.push({
      shotId: shots[anchorIdx].id,
      code: "SCRIPT_DIALOGUE_LINE_DROPPED",
      severity: "warn",
      detail:
        `The script contains this line of dialogue: "${raw}" — it does not appear, verbatim or close to it, in ` +
        `any shot's "dialogue" field anywhere in the breakdown. This is real content the script asked for that ` +
        `never made it into the film. Add it to whichever shot actually depicts this moment (this shot is the ` +
        `closest positional match in the script, but move it to the correct one if that's not here) — or add a ` +
        `new shot for it if no existing shot covers this moment at all.`,
      autofixed: false,
    });
  }

  return issues;
}

/**
 * The TRANSLATED-FILM counterpart to checkScriptDialogueCoverage() above.
 *
 * That check works by string-matching each quoted script line against the
 * shots' dialogue, after normalising both to `[a-z0-9\s]`. When the film is
 * performed in Kannada (or Hindi/Tamil/Malayalam/Urdu) and the script is
 * written in English, that comparison is meaningless in BOTH directions at
 * once: the translated dialogue normalises away to nothing, so every single
 * line in the script looks dropped, and the repair loop's only way to satisfy
 * it is to paste the English back in — undoing the translation.
 *
 * Skipping it outright was the first attempt and it was wrong: a REAL Kannada
 * test run then silently dropped one of the script's two spoken lines with
 * nothing to catch it. The question "did we lose a line?" is still perfectly
 * answerable across languages — just by COUNT rather than by content. A
 * translation may reword, merge clauses, or reorder, but it does not change
 * how many times somebody speaks.
 *
 * Deliberately reports ONE issue for the whole film rather than one per line:
 * without content matching there is no way to say WHICH line went missing, and
 * inventing a specific claim the check cannot actually support would send the
 * repair loop after the wrong shot.
 */
export function checkTranslatedDialogueCoverage(shots: Shot[], script: string): CompileIssue[] {
  if (!shots.length) return [];

  const QUOTED_LINE_RE = /"([^"]{3,300})"/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = QUOTED_LINE_RE.exec(script))) {
    const raw = m[1].trim();
    const norm = raw.toLowerCase().replace(/\s+/g, " ");
    if (norm.length < 3) continue;

    // TITLE FALSE-POSITIVE GUARD — CONFIRMED REAL, same defect as
    // checkScriptDialogueCoverage()'s own guard just above (see its comment
    // for the actual incident: a quoted title inserted as literal spoken
    // dialogue), but this function was missing the guard entirely — it only
    // ever filtered on length, so EVERY translated film with a conventionally
    // quoted title (the norm for scripts in this pipeline) over-counted
    // scriptLines by one and reported a real spoken line as "dropped" when
    // nothing was actually missing. REPRODUCED LIVE (2026-08-15): a real
    // Hindi test render — 1 script title + 1 real spoken line, both quoted —
    // came back "2 spoken line(s) in script, 1 shot(s) with dialogue," a
    // false positive that sent the repair loop chasing a line that was never
    // dropped. Ported verbatim (same isBareQuoteLine/isNearTop signature) so
    // the two checks can't drift out of sync on what counts as a title again.
    const lineStart = script.lastIndexOf("\n", m.index) + 1;
    const lineEnd = script.indexOf("\n", m.index);
    const wholeLine = script.slice(lineStart, lineEnd === -1 ? script.length : lineEnd).trim();
    const isBareQuoteLine = wholeLine === m[0];
    const isNearTop = m.index < 300;
    if (isBareQuoteLine && isNearTop) continue;

    seen.add(norm);
  }
  const scriptLines = seen.size;
  const spokenShots = shots.filter((s) => String(s.dialogue || "").trim().length > 0).length;
  if (scriptLines === 0 || spokenShots >= scriptLines) return [];

  return [
    {
      shotId: shots[shots.length - 1].id,
      code: "SCRIPT_DIALOGUE_LINE_DROPPED",
      severity: "warn",
      detail:
        `The script contains ${scriptLines} spoken line(s), but only ${spokenShots} shot(s) in this breakdown ` +
        `have any dialogue at all — ${scriptLines - spokenShots} line(s) the script asked for never made it into ` +
        `the film. This film is performed in a language other than the script's, so the missing line cannot be ` +
        `named by matching text; re-read the script, find which spoken beat(s) no shot covers, and add the ` +
        `translated line to whichever shot depicts that moment (or add a shot for it if none does). Keep every ` +
        `existing translated line exactly as it is — do NOT replace any dialogue with the script's original ` +
        `language.`,
      autofixed: false,
    },
  ];
}

function stripAudio(s: string): { clean: string; hits: string[] } {
  const hits: string[] = [];
  let clean = s;
  for (const re of AUDIO_LEAK) {
    clean = clean.replace(re, (m) => {
      hits.push(m.trim());
      return "";
    });
  }
  clean = clean.replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").replace(/,\s*\./g, ".").trim();
  return { clean, hits };
}

/** "MM:SS", or "HH:MM:SS" once the running total passes an hour — matches
 *  a real shot list's own timecode convention. See Shot.timecodeStart/
 *  timecodeEnd's own comment in types.ts for why this exists and what it's
 *  computed from (a cumulative sum of screenSeconds, never rendered seconds). */
function formatTimecode(totalSeconds: number): string {
  const whole = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ═══════════════════════════════════════════════════════════════════════════

/** `opts.isAd` marks this as an ADVERTISEMENT compile rather than a narrative
 *  film. Optional and defaulting to false purely so the change stays scoped: every
 *  existing film call site keeps its exact current behavior without being touched.
 *  Breakdown itself carries no type discriminator (the project row owns it, as
 *  `project.type`), so it has to be passed in. Currently gates one rule — see
 *  ACTION LIBRARY INJECTION's own comment. */
export function compileBreakdown(bd: Breakdown, opts: { isAd?: boolean } = {}): {
  breakdown: Breakdown;
  issues: CompileIssue[];
  /** Actions found in a SOLO shot that matched neither CORE_ACTION_LIBRARY
   *  nor the inference cache — see the WORLD-STATE ACTION PRECONDITION/
   *  EFFECT block for where these are collected. Every EXISTING caller
   *  destructures only `{ breakdown, issues }` and simply ignores this extra
   *  field — additive, not a breaking change to any existing call site. */
  pendingActionInferences: { key: string; sceneContext: string }[];
  /** Same idea as pendingActionInferences, for Gap B's staging-rule
   *  inference — see the R7.7 block for where these are collected. */
  pendingStagingInferences: { key: string; sceneText: string }[];
} {
  const issues: CompileIssue[] = [];
  const isAd = opts.isAd === true;

  // ── R0 · CULL BODILESS CHARACTERS ─────────────────────────────────────────
  const heardOnly = new Set(
    bd.shots.filter((s) => s.offscreenSpeaker && s.speaker).map((s) => s.speaker as string),
  );
  const seenAnywhere = new Set(bd.shots.flatMap((s) => s.characters));

  const characters = bd.characters.filter((c) => {
    if (heardOnly.has(c.id) && !seenAnywhere.has(c.id)) {
      issues.push({
        shotId: "—",
        code: "BODILESS_CHARACTER_HAD_A_FACE",
        severity: "error",
        detail:
          `"${c.name}" is only ever heard (earpiece/radio/VO) but was given a physical appearance. ` +
          `Culled BEFORE step 2 — otherwise you pay to build a five-angle character sheet for a voice ` +
          `with no body, and step 4 then locks that face into a keyframe.`,
        autofixed: true,
      });
      return false;
    }
    return true;
  });

  // ── R0.6 · CHARACTER APPEARANCE MUST OPEN WITH SEX+AGE, AND STATE FACIAL HAIR ──
  // Both are already emphatic MUSTs in the director prompt (see llm.ts's own
  // CHARACTERS section) — this is that section's real, documented failure
  // mode, not a hypothetical: "Woman Courier" with an appearance beginning
  // "30s, dark trench coat, soaked" (no sex word at all) rendered as a MAN,
  // because nothing in the string contradicted what the trench coat read as.
  // appearance is pasted BYTE-IDENTICAL into every shot's prompt — it is the
  // one thing holding a character's face together across the whole film, so
  // a missing sex word or an unstated facial-hair state doesn't just risk one
  // bad shot, it risks the character's face/gender drifting for the ENTIRE
  // film. Blocking (not autofixed): this file cannot safely invent the
  // correct sex or facial-hair state on the character's behalf — only a real
  // rewrite (by a human or the repair loop) can.
  const SEX_WORD = /\b(man|woman|boy|girl|male|female|lady|gentleman)\b/i;
  const MALE_PRESENTING = /\b(man|boy|male|gentleman)\b/i;
  const FACIAL_HAIR_STATED =
    /\b(clean[- ]shaven|no\s+(?:facial\s+hair|beard|stubble|mustache|moustache)|full\s+beard|beard|goatee|stubble|mustache|moustache|sideburns|five\s*o'?clock\s+shadow)\b/i;
  for (const c of characters) {
    const appearance = (c.appearance || "").trim();
    // Only the first clause/sentence counts as "beginning with" — a sex word
    // buried three clauses in (e.g. describing a companion) doesn't satisfy
    // "MUST BEGIN WITH", the exact gap that let "30s, dark trench coat..."
    // through in the real failure.
    const opening = appearance.split(/[.,;]/)[0] || appearance;
    if (!SEX_WORD.test(opening)) {
      issues.push({
        shotId: "—",
        code: "APPEARANCE_MISSING_SEX_AGE_PREFIX",
        severity: "error",
        detail:
          `"${c.name}"'s appearance ("${appearance.slice(0, 60)}${appearance.length > 60 ? "…" : ""}") doesn't ` +
          `open with a sex+age statement ("A woman in her early 30s...", "A man in his 40s..."). Confirmed real ` +
          `failure: a character whose appearance opened with just an age and clothing, no sex word, was rendered ` +
          `as the wrong gender because nothing in the text contradicted what the clothing read as. Rewrite the ` +
          `opening clause to state sex and age explicitly.`,
        autofixed: false,
      });
    }
    if (!FACIAL_HAIR_STATED.test(appearance) && (MALE_PRESENTING.test(opening) || !SEX_WORD.test(opening))) {
      issues.push({
        shotId: "—",
        code: "APPEARANCE_MISSING_FACIAL_HAIR",
        severity: "error",
        detail:
          `"${c.name}"'s appearance never states a facial-hair condition ("clean-shaven with no beard and no ` +
          `stubble", "short trimmed beard", etc.). Left unstated, the renderer invents a beard on close-ups and ` +
          `the face changes between shots — this string is the only thing holding this character's face together ` +
          `across cuts. Add an explicit facial-hair statement.`,
        autofixed: false,
      });
    }
  }

  const shots: Shot[] = [];
  let prevDir: "L" | "R" | null = null;
  let prevShot: Shot | null = null;
  // WORLD-STATE: PROP CARRY — MIGRATED (world-state migration, step 1) from a
  // local heldByCharacter Map to the shared worldState.ts module. Same
  // persistence-across-scene-boundaries behavior as before (see the WORLD-
  // STATE PROP CARRY block inside R9 below for the full "why this exists
  // alongside R9's own scene-scoped clause" reasoning, unchanged) — this is a
  // RELOCATION of working logic into the shared module every other migrated
  // tracker will eventually live in too, not a behavior change. HELD_OBJECT_RE/
  // HELD_OBJECT_CLEARED_RE/PROP_ACQUISITION_RE/HELD_OBJECT_ESTABLISH_RE/
  // PASSIVE_CARRY_RE are now imported from ./worldState (same regexes,
  // verbatim) instead of declared locally, so this file and worldState.ts
  // can never quietly drift apart on "what counts as holding something".
  const worldState: WorldState = createWorldState();
  // Gap A's own signal for PROP_VANISHED_WITHIN_SHOT — a shot's own text
  // showing a tracked prop legitimately LEAVING (set down, handed off,
  // thrown and caught, or explicitly leaving the frame), distinct from
  // PROP_ACQUISITION_RE (gaining one) and HELD_OBJECT_CLEARED_RE (that
  // one's specifically about a CHARACTER no longer holding something, not
  // about a prop leaving the FRAME entirely, which is this check's concern).
  // NOT part of the world-state migration — this is PROP_VANISHED_WITHIN_
  // SHOT's own single-shot signal, not persistent cross-shot state.
  const PROP_REMOVAL_RE =
    /\b(sets?\s+down|puts?\s+(?:down|away)|hands?\s+(?:over|off)|gives?|drops?|pockets?|throws?|hits?|catches?|leaves?\s+(?:the\s+)?frame|out\s+of\s+frame|off[- ]camera|out\s+of\s+sight|disappears?\s+(?:into|behind|beyond))\b/i;
  // Characters seen in any EARLIER shot — a character's very first
  // appearance in the film is exempt from WORLD_STATE_PROP_NO_ORIGIN below:
  // opening already-holding-something is a normal way to introduce a
  // character's baseline inventory, not a defect. Populated at the end of
  // each shot's processing (see `prevShot = s;` further below), so it never
  // includes THIS shot's own characters while THIS shot is being checked.
  const seenCharacters = new Set<string>();
  // CRICKET_ROLE_ACTION_MISMATCH's own tracking — see that check, further
  // below, for why this is domain-scoped rather than a general system.
  const cricketRoles = new Map<string, "batsman" | "bowler">();
  // Gap A — PROP_APPEARS_WITHOUT_INTRODUCTION's own tracking. seenProps is
  // whole-film (a prop's absolute first mention anywhere is exempt — same
  // "baseline world-state, no origin story needed" reasoning as
  // seenCharacters above); propsEstablishedByScene is per-scene (once a
  // prop is established ANYWHERE in a scene run, later shots of that SAME
  // scene referencing it again are fine without re-justifying it).
  const seenProps = new Set<string>();
  const propsEstablishedByScene = new Map<string, Set<string>>();

  // WORLD-STATE: CHARACTER SPATIAL STATE — see lib/actionLibrary.ts's own
  // top-of-file comment for the full picture. Persists across scene
  // boundaries exactly like heldByCharacter just above (a character's
  // threshold side, posture, near-object, and vehicle occupancy don't reset
  // just because the scene grouping changed) — updated only by matching a
  // shot's own text against CORE_ACTION_LIBRARY or the inference cache; see
  // the WORLD-STATE ACTION PRECONDITION/EFFECT block, further below in this
  // same per-shot loop, for where the actual matching happens. Lives on
  // worldState (getSpatialState/setSpatialState) since Migration Step 5, not
  // a locally-scoped Map — see worldState.ts's own CharacterWorldState.
  // spatial/spatialConfidence field comments.
  // Collected here, returned by compileBreakdown() (see its own return
  // statement) for 1-breakdown.ts to resolve via an async inferActionRule()
  // call and a recompile — compileBreakdown() itself stays synchronous.
  const pendingActionInferences: { key: string; sceneContext: string }[] = [];
  const seenPendingKeys = new Set<string>(); // de-dupe within ONE compile pass

  // Shared action-text matcher — extracted so the ATTRIBUTED per-character
  // path and the Migration Step 5 INFERRED-SHARED multi-character fallback
  // (further below) run the exact same detection (core library, then the
  // inference cache, then queueing a genuine miss for async resolution),
  // never two independently-drifting copies of it. Returns null when
  // nothing matched — including "queued for inference," which resolves on
  // a LATER recompile, never this one (compileBreakdown stays synchronous).
  function matchAction(actionText: string, sceneContext: string): {
    precondition: SpatialFact[]; effect: SpatialFact[]; label: string;
    coreRule: ActionRule | null; coreMatch: RegExpMatchArray | null;
  } | null {
    let matchedPrecondition: SpatialFact[] | null = null;
    let matchedEffect: SpatialFact[] | null = null;
    let matchedLabel = "";
    let coreRule: ActionRule | null = null;
    let coreMatch: RegExpMatchArray | null = null;
    for (const rule of CORE_ACTION_LIBRARY) {
      if (!rule.pattern) continue;
      const m = actionText.match(rule.pattern);
      if (m) {
        matchedPrecondition = resolveReferentPlaceholders(rule.precondition, m);
        matchedEffect = resolveReferentPlaceholders(rule.effect, m);
        matchedLabel = rule.label;
        coreRule = rule;
        coreMatch = m;
        break;
      }
    }
    const key = normalizeActionKey(actionText);
    if (!coreRule) {
      const cached = actionInferenceCache.get(key);
      if (cached) {
        matchedPrecondition = cached.precondition;
        matchedEffect = cached.effect;
        matchedLabel = cached.label;
      } else {
        // Genuinely unrecognized. Queue for async inference rather than
        // silently skipping OR blocking this synchronous compile — only
        // for text substantial enough to plausibly BE a real action (same
        // "thin text" floor MOTION_TOO_THIN_FOR_NATURAL already uses), so
        // a bare "he waits" doesn't burn an inference call on nothing.
        const wordCount = (actionText.match(/\b\w+\b/g) ?? []).length;
        if (wordCount >= 6 && !seenPendingKeys.has(key)) {
          seenPendingKeys.add(key);
          pendingActionInferences.push({ key, sceneContext });
        }
      }
    }
    if (!matchedPrecondition || !matchedEffect) return null;
    return { precondition: matchedPrecondition, effect: matchedEffect, label: matchedLabel, coreRule, coreMatch };
  }

  // Gap B's own pending list — same shape, same reason, scene-scoped instead
  // of shot-scoped (see cacheInferredStaging() above).
  const pendingStagingInferences: { key: string; sceneText: string }[] = [];
  const seenStagingKeys = new Set<string>();
  // Priority 12 — checkStaging() (stagingLibrary.ts) requires BOTH a rule's
  // trigger AND its contradicts phrase in the SAME text, and the R7.7 block
  // below only ever calls it on ONE shot's own combined text — confirmed by
  // reading both files directly: a "pedestrian-only" trigger established in
  // shot 1 and a "car passing" contradiction appearing in shot 2 of the SAME
  // scene never gets compared against each other at all, because shot 2's
  // own text alone never contains the trigger phrase itself. This tracker
  // extends the SAME sameScene()-grouped "survives scene boundaries" pattern
  // WORLD_STATE_LOCATION_CONTRADICTION (door/light/window) already uses to
  // staging rules specifically: once a rule's trigger is established ANYWHERE
  // in a scene run, every LATER shot in that same run is checked against its
  // contradicts phrase too, not just its own.
  // PER-INSTANCE REFERENT DISAMBIGUATION (two doors, two cars, etc — see
  // resolveInstanceKey()/resolveInstanceReferents() in actionLibrary.ts for
  // the actual resolution logic). Location-scoped the SAME way
  // WORLD_STATE_LOCATION_CONTRADICTION's knownLocations is: grouped by
  // sameScene(), not scene number, so a location revisited later in the film
  // is still recognized as the one location and keeps its known instances.
  interface KnownReferentLocation { representative: Shot; instances: Map<string, Set<string>> }
  const referentLocations: KnownReferentLocation[] = [];
  const findReferentLocation = (s: Shot): Map<string, Set<string>> => {
    let loc = referentLocations.find((l) => sameScene(l.representative, s));
    if (!loc) {
      loc = { representative: s, instances: new Map() };
      referentLocations.push(loc);
    }
    return loc.instances;
  };

  for (const raw of bd.shots) {
    const s: Shot = { ...raw };

    // ── R0.5 · DANGLING PUNCTUATION FROM A REMOVED CLAUSE ───────────────────
    // Confirmed on camera in several different scripts: "...both feet firmly
    // planted, . Same location..." and "...screen-right, , his hood..." — an
    // empty clause left behind (usually from the model dropping a phrase
    // without fixing the surrounding punctuation). Harmless to the renderer,
    // but a human reading the shot list notices it immediately. Pure text
    // cleanup: never removes meaningful content, only a stray ", ." or ", ,".
    for (const f of ["description", "motion", "setting", "startFrame", "endFrame", "camera", "lighting"] as const) {
      if (s[f]) {
        s[f] = s[f].replace(/,\s*,/g, ",").replace(/,\s*\.(?=\s|$)/g, ".").replace(/\s{2,}/g, " ").trim();
      }
    }

    // ── R1 · A SPEAKER WHO ISN'T IN THE ROOM ────────────────────────────────
    if (s.offscreenSpeaker && s.speaker && s.characters.includes(s.speaker)) {
      issues.push({
        shotId: s.id,
        code: "OFFSCREEN_SPEAKER_LISTED_ON_SCREEN",
        severity: "error",
        detail: `"${s.speaker}" speaks over an earpiece but was listed as physically in frame. Removed from this shot's cast. The line still plays over the listener's face — a reaction shot.`,
        autofixed: true,
      });
      s.characters = s.characters.filter((c) => c !== s.speaker);
    }

    // ── R1.5 · A SPEAKER WHO'S IN THE ROOM BUT NOBODY TOLD THE CAST LIST ────
    // The MIRROR of R1 above, and just as dangerous in a different way. Both
    // 4-images.ts's speakerOnScreen and 5-videos.ts's speakerOnScreen compute
    // the identical check: !!shot.speaker && !shot.offscreenSpeaker &&
    // characters.includes(shot.speaker). R1 already guards the offscreen
    // direction (a speaker wrongly left IN the cast list gets removed). But
    // NOTHING guarded this direction: a speaker marked on-screen
    // (offscreenSpeaker: false) who the LLM simply forgot to add to
    // `characters`. When that happens, BOTH speakerOnScreen checks come back
    // false (offscreenSpeaker is false, so the earpiece branch doesn't fire
    // either), so NEITHER branch in 5-videos.ts's dialogue handling ever
    // executes — and because 6-assemble.ts has no separate audio stage (all
    // dialogue comes from the video model's own generate_audio), the line is
    // never mentioned in the video prompt at all. The scripted dialogue is
    // SILENTLY DROPPED from the finished film: no error, no QA flag, nothing
    // — a viewer just never hears a line the script clearly intended someone
    // to say. Confirmed reachable: nothing upstream guarantees `characters`
    // and `speaker` stay consistent when offscreenSpeaker is false. Autofix
    // is safe and symmetric with R1: this character is already confirmed to
    // exist (see the culled-character check just below), and is confirmed
    // meant to be visible (offscreenSpeaker is false) — the only missing
    // piece is a list membership the compiler can just correct.
    if (s.speaker && !s.offscreenSpeaker && s.dialogue?.trim() && !s.characters.includes(s.speaker)) {
      const validSpeaker = characters.some((c) => c.id === s.speaker);
      if (validSpeaker) {
        issues.push({
          shotId: s.id,
          code: "ONSCREEN_SPEAKER_MISSING_FROM_CAST",
          severity: "error",
          detail: `"${s.speaker}" has a line in this shot and is not marked as an offscreen voice, but was missing from the cast list — their dialogue would have silently never reached the render prompt. Added to this shot's cast.`,
          autofixed: true,
        });
        s.characters = [...s.characters, s.speaker];
      } else {
        // speaker references a character id that doesn't exist at all. NOT the
        // same treatment as SHOT_REFERENCED_A_CULLED_CHARACTER below, on
        // purpose: that one safely autofixes by DROPPING the dangling
        // reference, but dropping here wouldn't actually fix anything —
        // s.dialogue would remain, s.speaker would still be invalid, and the
        // exact same silent-dialogue-loss failure this rule exists to catch
        // would just recur via a different trigger. A real block (goes to the
        // repair loop like any other structural blocker, then genuinely fails
        // rather than silently dropping the line) is the only safe response
        // when the compiler can't confidently guess who was meant to speak.
        issues.push({
          shotId: s.id,
          code: "SPEAKER_UNKNOWN_CHARACTER",
          severity: "error",
          detail: `Shot ${s.id}'s speaker "${s.speaker}" is not a character in this film's cast. Fix the speaker id or the character list.`,
          autofixed: false,
        });
      }
    }

    // ── R1.6 · DIALOGUE WITH NO SPEAKER AT ALL ──────────────────────────────
    // A third trigger for the exact same silent-dialogue-loss failure R1.5
    // exists to catch — `speaker` and `dialogue` are independent, uncorrelated
    // schema fields (speaker: nullable, dialogue: defaults to ""), so a shot
    // can structurally have real dialogue text with speaker left null and
    // offscreenSpeaker left false. When that happens, speakerOnScreen is
    // false (no speaker to be on-screen) AND the offscreen branch doesn't
    // fire either (offscreenSpeaker is false) — the line vanishes the same
    // way. Unlike R1.5, there is no safe autofix here: with speaker null,
    // there is no identity to add to the cast and no way to guess who was
    // meant to say the line, so this can only be a real block, resolved by
    // the repair loop (which can infer a speaker from context, remove the
    // line, or mark it a genuine off-screen voice) rather than a human
    // watching the finished film wonder why a written line was never said.
    if (!s.speaker && !s.offscreenSpeaker && s.dialogue?.trim()) {
      issues.push({
        shotId: s.id,
        code: "DIALOGUE_WITH_NO_SPEAKER",
        severity: "error",
        detail: `Shot ${s.id} has dialogue ("${s.dialogue.trim().slice(0, 60)}${s.dialogue.trim().length > 60 ? "…" : ""}") but no speaker is set and it is not marked as an offscreen voice — this line would never reach the render prompt and would silently never be spoken. Assign a speaker, or mark offscreenSpeaker true for a genuine off-screen voice.`,
        autofixed: false,
      });
    }

    const dropped = s.characters.filter((id) => !characters.some((c) => c.id === id));
    if (dropped.length) {
      s.characters = s.characters.filter((id) => characters.some((c) => c.id === id));
      issues.push({
        shotId: s.id,
        code: "SHOT_REFERENCED_A_CULLED_CHARACTER",
        severity: "error",
        detail: `Removed ${dropped.join(", ")} — no body, no sheet, no keyframe.`,
        autofixed: true,
      });
    }
    const castCount = s.characters.length;

    // ── CULLED (OR NEVER-LISTED) CHARACTER STILL IN PROSE ───────────────────
    // Deliberately INDEPENDENT of `dropped` above, not keyed off it: a
    // dangling id that got dropped is, by definition, not a valid id — trying
    // to look up ITS name to check the prose is circular and fails exactly
    // when it matters most (confirmed while testing this: a mistyped
    // "Farid"-vs-"farid" id can never be looked up by id once it's already
    // known not to match anything). Instead this scans the shot's own text
    // for any REAL character's NAME (from the full, unfiltered bd.characters)
    // who ISN'T in this shot's (already-cleaned) s.characters — catching the
    // dropped-id case AND the simpler case of an LLM just never listing a
    // character it went on to describe, both being the same underlying bug.
    // Confirmed real failure: a repair-loop shot-split referenced a character
    // id that no longer matched bd.characters — silently dropped, but the
    // description/motion text still said "Farid, [doing something]...".
    // castLock (R7, below) builds its "ONLY N people are in this frame"
    // instruction purely from s.characters.length, so the render was told
    // "only Amir is present" while its OWN prose still narrated a second
    // person — a direct contradiction baked into one prompt. The render
    // becomes a coin flip: either an uncredited, sheet-less "Farid" appears
    // (registers as extra_people/identity_drift in QA, exactly what was
    // observed) or the model just ignores half its own prompt.
    {
      // s.setting is DELIBERATELY EXCLUDED here — SCENE_SETTING_LOCKED (far
      // below) copies whichever shot in the same scene run has the richest
      // setting text into EVERY shot in that run, specifically so spatial
      // geography (walls, landmarks) survives a camera-angle change. That
      // richest text can legitimately anchor itself to a person's earlier
      // position ("the near-side footpath where Arjun stood") even in a shot
      // where Arjun is correctly excluded from the cast — and because the
      // lock reruns on EVERY compile, scanning s.setting here created an
      // unwinnable loop: no repair could ever satisfy this check, because the
      // very next compile just re-injected the same name right back into
      // s.setting regardless of what description/motion said. Confirmed real
      // failure: a departure/crossing scene's shot got permanently blocked on
      // this exact mechanism, quoting the LOCKED setting text verbatim as the
      // "offending" text. description/motion/startFrame/endFrame are where a
      // shot's own AUTHORED action lives — that's the only place a genuine
      // undisclosed-presence claim belongs.
      const ownText = `${s.description} ${s.motion} ${s.startFrame} ${s.endFrame}`;
      // A bare name mention is not, by itself, a presence claim: "Amir walks
      // toward Farid Nassar's stall" names Farid only to identify WHOSE
      // location it is, the same way a script says "the Smith house" without
      // implying a Smith is standing there. Confirmed real false positive: an
      // establishing/approach shot before a vendor is ever introduced named
      // their stall, got flagged as if the vendor were undisclosed-present,
      // and no repair could ever satisfy it without deleting the destination
      // from the shot (the location genuinely IS that character's stall).
      // Every occurrence of the name has to be checked, not just the first —
      // one shot can legitimately both name a location ("...toward Farid's
      // stall...") AND separately describe that person acting in it.
      const LOCATION_ONLY_AFTER = /^(?:'s)?(?:\s+[\w']+){0,3}?\s+(stall|shop|stand|counter|house|home|door|cart|tent|table|shopfront|storefront|register|till|store|booth|workshop|garage|yard|apartment|room|office|desk)\b/i;
      // The OTHER confirmed real false positive: asked to "genuinely remove"
      // a name, a repair rewrite instead wrote an explicit NEGATION sentence
      // ("No mention or appearance of Arjun in this shot") — which still
      // contains the bare name, so the regex above still matched it, even
      // though the sentence says the exact opposite of "present". Checked
      // against the text immediately BEFORE the name match.
      const NEGATED_BEFORE = /\bno\s+(mention|reference|appearance|sign|trace)(\s+(?:or|nor)\s+(?:mention|reference|appearance|sign|trace))?\s+(of|to)\s*$/i;
      const uncredited: { id: string; name: string; excerpt: string }[] = [];
      for (const c of bd.characters) {
        if (s.characters.includes(c.id)) continue;
        const nameRe = new RegExp(`\\b${c.name.split(" ")[0]}\\b`, "gi");
        const matches = [...ownText.matchAll(nameRe)];
        if (!matches.length) continue;
        // Find the first occurrence that ISN'T a "name's <location noun>"
        // reference — that's the actual presence claim worth quoting back;
        // logged so a future permanent failure shows exactly what tripped
        // this instead of only the character name (a real gap: the DB never
        // persists a breakdown that fails before completion, so without this
        // excerpt the offending text is unrecoverable after the fact).
        const offending = matches.find((m) => {
          const after = ownText.slice(m.index! + m[0].length, m.index! + m[0].length + 40);
          const before = ownText.slice(Math.max(0, m.index! - 40), m.index!);
          return !LOCATION_ONLY_AFTER.test(after) && !NEGATED_BEFORE.test(before);
        });
        if (!offending) continue;
        const start = Math.max(0, offending.index! - 30);
        const excerpt = ownText.slice(start, offending.index! + offending[0].length + 30).trim();
        uncredited.push({ id: c.id, name: c.name, excerpt });
      }
      if (uncredited.length) {
        // AUTOFIX, not just flag: every real failure of this code seen so far
        // (across 4 permanent-failure renders, 2 different scripts) had the
        // SAME correct resolution — the character genuinely does something in
        // the text, so add them to this shot's cast. That is now done here,
        // deterministically, instead of raising a blocker and waiting on an
        // LLM repair round that keeps re-deriving the same answer. castLock
        // (R7, below, later in this same per-shot loop) reads s.characters
        // AFTER this point, so its "ONLY N people in this frame" render
        // instruction will correctly reflect the addition — the prose and the
        // cast-lock text agree instead of contradicting each other.
        // RESIDUAL RISK, noted honestly: a name used only as a SIMILE or a
        // MEMORY ("she moved like Meera used to", "he remembered Arjun's
        // laugh") would also match here and get wrongly added to the cast —
        // no real render has shown this shape yet, so no exemption regex has
        // been written for it (this file's own discipline: fix confirmed
        // failures, don't pre-invent speculative ones). If this shape shows
        // up in a real log, add a THIRD exemption here alongside
        // LOCATION_ONLY_AFTER and NEGATED_BEFORE, the same way those two were
        // added.
        for (const u of uncredited) {
          if (!s.characters.includes(u.id)) s.characters.push(u.id);
        }
        const names = uncredited.map((u) => u.name);
        const excerpts = uncredited.map((u) => `"${u.name}": "…${u.excerpt}…"`).join("; ");
        issues.push({
          shotId: s.id,
          code: "CULLED_CHARACTER_STILL_IN_PROSE",
          // DOWNGRADED from "error" to "warn" — this exact code has now
          // permanently failed FOUR real renders across two different
          // scripts, each time from a DIFFERENT root cause (a possessive
          // location reference, a repair-prompt contradiction, a scene-
          // setting-lock/self-flagging deadlock, a negation sentence — all
          // fixed as found), which is a real pattern: a regex heuristic
          // scanning open-ended LLM prose cannot be proven to have zero
          // remaining false-positive shapes, only asymptotically fewer of
          // them. Blocking on it meant every NEW shape found cost the user a
          // full, wasted repair cycle and a hard failure before anyone even
          // saw a frame. NOW AUTOFIXED (see above) instead of merely
          // downgraded — severity stays "error" (this WAS a real structural
          // contradiction between the cast-lock instruction and the shot's
          // own prose, the same convention used by this section's sibling
          // autofixes: ONSCREEN_SPEAKER_MISSING_FROM_CAST, SHOT_REFERENCED_A_
          // CULLED_CHARACTER, FRAMING_IMPLIES_ABSENT_CHARACTER), but
          // autofixed:true means blockingErrors() never sees it regardless.
          severity: "error",
          detail:
            `${names.join(", ")} ${names.length > 1 ? "are" : "is"} described DOING something in this shot's ` +
            `own text, but ${names.length > 1 ? "were" : "was"} missing from its cast list — the cast-lock ` +
            `instruction and the shot's own prose would have directly contradicted each other. Offending text: ` +
            `${excerpts}. Auto-added ${names.length > 1 ? "them" : names[0]} to this shot's cast so the render ` +
            `prompt matches its own prose.`,
          autofixed: true,
        });
      }
    }

    // ── R2 · CAMERA GRAMMAR ─────────────────────────────────────────────────
    if (castCount < 2 && s.camera) {
      for (const [re, safe] of TWO_PERSON_FRAMINGS) {
        if (re.test(s.camera)) {
          issues.push({
            shotId: s.id,
            code: "FRAMING_IMPLIES_ABSENT_CHARACTER",
            severity: "error",
            detail: `camera="${s.camera}" requires a second body in frame, but ${castCount} character(s) are present. Rewrote to "${safe}".`,
            autofixed: true,
          });
          s.camera = safe;
          break;
        }
      }
      for (const f of ["camera", "description", "motion"] as const) {
        if (s[f] && TWO_PERSON_PHRASES.test(s[f])) {
          s[f] = s[f].replace(TWO_PERSON_PHRASES, "").replace(/\s{2,}/g, " ").trim();
          issues.push({
            shotId: s.id,
            code: "BLOCKING_IMPLIES_ABSENT_CHARACTER",
            severity: "error",
            detail: `Two-person phrasing removed from "${f}".`,
            autofixed: true,
          });
        }
      }
      // SECOND_BODY_ROLE_NOUN — see its own module-scope comment. Checked on
      // the AUTHORED text only (authoredOnly), same discipline as R4 below,
      // so the compiler's OWN injected cast-lock text ("the ONLY person...")
      // is never mistaken for the contradiction it exists to catch.
      for (const f of ["description", "motion", "startFrame", "endFrame"] as const) {
        const m = authoredOnly(s[f] ?? "").match(SECOND_BODY_ROLE_NOUN);
        if (m) {
          issues.push({
            shotId: s.id,
            code: "SOLO_SHOT_IMPLIES_SECOND_BODY",
            severity: "warn",
            detail:
              `This shot has only ${castCount} character(s) in its cast, but its own "${f}" text describes ` +
              `"${m[0]}" — a second person's body part acting, which directly contradicts the shot's own "ONLY ` +
              `person in this frame, do NOT add a second figure" render instruction. Either add that role as a ` +
              `real character to this shot's "characters" (if they genuinely share the frame), or rewrite the ` +
              `text so no second body is implied at all.`,
            autofixed: false,
          });
        }
      }
    }

    // ── R3 · AUDIO LEAK ─────────────────────────────────────────────────────
    for (const f of ["description", "motion", "setting"] as const) {
      const { clean, hits } = stripAudio(s[f] ?? "");
      if (hits.length) {
        s[f] = clean;
        issues.push({
          shotId: s.id,
          code: "AUDIO_LEAKED_INTO_VISUAL_PROMPT",
          severity: "error",
          detail: `A video model cannot render sound, so it renders a SPEAKER instead. Stripped from "${f}": ${hits.join(" | ")}`,
          autofixed: true,
        });
      }
    }

    // ── R4 · THE TWO-ENDPOINT LAW ───────────────────────────────────────────
    // Scan the AUTHOR'S text only — never our own appended clauses (see authoredOnly).
    // CONFIRMED REAL GAP, FIXED — caught live on "THE OATH OF DUNCARROW" test
    // render: this used to be motion+description ONLY, never endFrame. A
    // repair LLM naturally tends to put the resulting-state language IN the
    // endFrame (that's literally what an endFrame is for), so a shot whose
    // ONLY textual evidence of a state change lived in endFrame (e.g. "his
    // hand is now closed around the hilt") computed changesState=false here
    // — invisible to the very check meant to require an endFrame for exactly
    // this case. That let FLF_NOT_NEEDED (below) wrongly strip the endFrame
    // as unnecessary; the next repair round then added motion text that DID
    // trip changesState, but by then the endFrame was already gone, so
    // STATE_CHANGE_NEEDS_ENDFRAME fired instead — an unstable flip-flop
    // between "strip the endFrame" and "demand one back" that burned the
    // whole 2-round repair budget without ever converging, permanently
    // failing a shot (shot-3aa) before a single frame was rendered. Including
    // endFrame's own text here is safe: for a shot with no endFrame yet
    // (hasEnd=false), it's an empty string and changes nothing; for a shot
    // that already has one, its content correctly counts as evidence the
    // world changes in this shot, same as motion/description always did.
    const text = `${authoredOnly(s.motion)} ${authoredOnly(s.description)} ${authoredOnly(s.endFrame)}`;
    // STATE_CHANGE's verb list catches "opens"/"enters"/"exits" but NOT the far
    // more common natural phrasings of a threshold crossing — "walks in",
    // "steps through", "comes inside", "heads out" — none of which are in that
    // list. A shot phrased that way slipped past R4 entirely: no endFrame was
    // ever required, so the model was left to freely extrapolate from ONE
    // keyframe with no idea where the crossing actually ends. Confirmed on
    // camera: exactly this shape of shot rendered as the character already
    // standing inside the moment the door opens, or opening and closing the
    // door again without ever visibly moving. THRESHOLD/GOES_THROUGH (used by
    // THRESHOLD_NOT_CROSSED below, which only checks the WRITTEN text) are
    // reused here as a SECOND trigger for the same real, structural fix R4
    // already applies to every other world-changing beat: force two real
    // endpoints so the model interpolates an actual crossing instead of
    // guessing at one from a single frame.
    const changesState = STATE_CHANGE.test(text) || (THRESHOLD.test(text) && GOES_THROUGH.test(text));
    let hasStart = s.startFrame.trim().length > 0;
    let hasEnd = s.endFrame.trim().length > 0;

    // ── DETERMINISTIC ENTRANCE ENDPOINTS (Gap G) ────────────────────────────
    // STATE_CHANGE_NEEDS_ENDFRAME (just below) blocks any state-changing beat
    // with no endFrame authored, then relies entirely on the repair LLM to
    // invent one — reasonable for most state changes (opens/jumps/throws),
    // but for the SPECIFIC, common, well-understood case of a character
    // ENTERING a shot they were not present in a moment ago, the compiler
    // can write a genuinely correct pair deterministically instead of
    // hoping the repair LLM does. Confirmed real: a character "popping into
    // existence" within a clip's first frames — a one-endpoint i2v render
    // conditioned on a single ALREADY-FULLY-PRESENT keyframe has nothing to
    // animate FROM, which is exactly what an unrepaired STATE_CHANGE_NEEDS_
    // ENDFRAME shot renders as if the repair round doesn't land a good pair.
    // CONFIRMED REAL GAP, FIXED (2026-08-08, "The Last Stand of Isolde" test):
    // was solo-shots-only ("a bare regex match on multi-character text can't
    // reliably say WHICH person is entering") — but that excluded the single
    // most common entrance shape in a two-hander: one NEW character walking
    // into a shot where the OTHER character is already established and just
    // standing there (Thane entering to a still-waiting Isolde). That's not
    // actually ambiguous — seenCharacters already tells us exactly which one
    // is new — so the same attribution-confidence discipline this file uses
    // elsewhere (WORLD_STATE_PROP_NO_ORIGIN, action-precondition
    // ESTABLISHING) is preserved by requiring EXACTLY ONE unseen character in
    // the shot, not by requiring the shot to be solo. Reproduced on camera:
    // without this, Thane's entrance fell through to the repair LLM instead
    // of this deterministic fix, and rendered him popping into view mid-frame
    // instead of walking in from the edge.
    const ENTRANCE_VERB = /\benters?\b|\bappears?\b|\bsteps?\s+(?:into|in)\s+(?:the\s+)?(?:frame|shot|scene|foreground)\b|\bwalks?\s+(?:into|in)\s+(?:the\s+)?(?:frame|shot|scene|foreground)\b/i;
    // CONFIRMED REAL GAP, FIXED (duplicate/"ghost" figure on camera): this used
    // to gate on `!seenCharacters.has(id)` — whole-FILM "have we ever shown
    // this face before." That wrongly excludes a RETURNING character: same
    // person, absent from the immediately preceding shot, walking into a
    // LATER scene. For them this deterministic endpoint fix never fired, so
    // startFrame fell through to 4-images.ts's unconditional "there is
    // EXACTLY ONE person in this frame" headcount instruction (always frames
    // them as already present) while THIS shot's own motion text separately
    // says they walk/enter in — the starting keyframe shows them already
    // standing there AND the video model is told to animate an arrival,
    // rendering as two overlapping figures that merge into one.
    // Fixed by switching the signal from "ever seen in the film" to "was in
    // the immediately preceding shot" — the same prevShot-relative (not
    // seenCharacters-relative) local signal SPATIAL_COMPLEXITY_OVERLOAD's own
    // `enteredMidScene` already uses for the identical question, further
    // below in this file. Strictly a superset of the old signal (a
    // never-seen-before character is by construction also absent from
    // prevShot, since prevShot's own cast was already folded into
    // seenCharacters by the time this shot is reached) — every case that
    // used to fire still fires. One behavior change: a shot where TWO people
    // are simultaneously new-since-the-last-shot (one returning, one truly
    // first-time) now correctly declines to guess which one the entrance
    // text means, instead of silently attributing it to whichever happened
    // to be the film's first-timer — consistent with this check's own
    // "exactly one candidate" disambiguation design (see comment above).
    const newEntrants = s.characters.filter(
      (id) => !prevShot || !sameScene(s, prevShot) || !prevShot.characters.includes(id),
    );
    if (changesState && !hasStart && !hasEnd && newEntrants.length === 1 && ENTRANCE_VERB.test(text)) {
      const charId = newEntrants[0];
      const name = characters.find((c) => c.id === charId)?.name ?? charId;
      s.startFrame = `${name} is at the very edge of the frame, only partially visible — one shoulder, arm, and leg just entering view, the rest of their body still off-frame, mid-step.`;
      s.endFrame = `${name} is now fully inside the frame, both feet planted, having completed stepping into view.`;
      hasStart = true;
      hasEnd = true;
      issues.push({
        shotId: s.id,
        code: "ENTRANCE_ENDPOINTS_AUTOFILLED",
        severity: "warn",
        detail:
          `"${charId}" enters this shot with no prior presence and no authored startFrame/endFrame — a ` +
          `single-keyframe (i2v) render has nothing to animate an entrance FROM, which is how a character ` +
          `"pops into existence" instead of walking in. Auto-filled a real edge-of-frame → fully-in-frame ` +
          `endpoint pair so this renders as a genuine two-endpoint (flf) interpolation instead.`,
        autofixed: true,
      });
    }

    s.method = hasEnd ? "flf" : "i2v";

    // (a) STRUCTURAL FACT → may block. A world-changing beat with no endFrame will
    //     make the model extrapolate blind and stall. This has no false positives:
    //     endFrame is either present or it isn't.
    if (changesState && !hasEnd) {
      issues.push({
        shotId: s.id,
        code: "STATE_CHANGE_NEEDS_ENDFRAME",
        severity: "error",
        detail:
          "This beat changes the world (something moves, opens, is picked up, breaks). With only one " +
          "frame the model has no idea where the action ENDS, so it stalls and holds a pose. Give it " +
          "both endpoints as ONE shot: startFrame (before) and endFrame (after).",
        autofixed: false,
      });
    }

    // ── ENDFRAME ACTION NOT DEPICTED IN MOTION ──────────────────────────────
    // Confirmed real, twice: a shot's endFrame — which distillEndState() (R9,
    // further below) carries VERBATIM into the NEXT shot's own CONTINUITY
    // clause — described a real action (dropping a bag, flipping a light
    // switch, an embrace already completed) that never appears anywhere in
    // THIS shot's own motion text. Nothing in the shot's instructions ever
    // actually told the model to PERFORM that action — only that it's
    // already done by the last frame — so the model has to invent HOW the
    // world got there. Confirmed on camera: reversed motion, teleporting,
    // and hallucinated beats exactly where this gap exists.
    // Verb list is ENDSTATE_UNDEPICTED_VERBS, module scope above — shared with
    // MOTION_REDEPICTS_COMPLETED_ACTION further below (R9), see that constant's
    // own comment for why the two checks intentionally use the same list.
    if (hasEnd) {
      const endStateText = authoredOnly(s.endFrame);
      const motionText = authoredOnly(s.motion);
      const endVerbs = [...endStateText.matchAll(ENDSTATE_UNDEPICTED_VERBS)].map((m) => m[1].toLowerCase());
      const undepicted = [...new Set(endVerbs)].filter((v) => !new RegExp(`\\b${v}\\b`, "i").test(motionText));
      if (undepicted.length) {
        issues.push({
          shotId: s.id,
          code: "ENDFRAME_ACTION_NOT_IN_MOTION",
          severity: "warn",
          detail:
            `This shot's endFrame describes "${undepicted.join(", ")}" as already having happened, but the ` +
            `shot's own motion text never depicts ${undepicted.length === 1 ? "this action" : "these actions"} ` +
            `taking place — the model is told the END result but never told HOW to get there, which is exactly ` +
            `what leads to invented, reversed, or teleporting motion to bridge the gap. Either add the missing ` +
            `beat(s) to motion so this shot actually shows them happening, or move the action to its own ` +
            `dedicated shot instead of skipping straight to its result.`,
          autofixed: false,
        });
      }
    }

    // (b) FUZZY GUESS → WARN ONLY. This regex cannot reliably tell a real
    //     un-photographable pose from an innocent word. A misfire must never halt
    //     a paid run, so it logs and the run proceeds.
    for (const f of ["startFrame", "endFrame"] as const) {
      if (s[f] && UNPHOTOGRAPHABLE.test(s[f])) {
        issues.push({
          shotId: s.id,
          code: "KEYFRAME_MAYBE_NOT_PHOTOGRAPHABLE",
          severity: "warn",
          detail:
            `"${f}" may describe a mid-motion moment a still-image model can't render well ` +
            `(e.g. "mid-air"). If the clip looks wrong, rewrite it as a pose a body can hold. ` +
            `Not blocking — proceeding.`,
          autofixed: false,
        });
      }
    }

    // (c) FUZZY GUESS → WARN ONLY. Both frames share the character + setting text,
    //     so this can misjudge. Warn, never block.
    if (hasStart && hasEnd && tooSimilar(s.startFrame, s.endFrame)) {
      issues.push({
        shotId: s.id,
        code: "ENDPOINTS_MAYBE_TOO_SIMILAR",
        severity: "warn",
        detail:
          "startFrame and endFrame look very similar. If the subject holds a pose in the clip, make " +
          "the endFrame a more different position/world state. Not blocking — proceeding.",
        autofixed: false,
      });
    }

    // (d) STATE, NOT ACTION → WARN, and sent to the repair loop. "Hiding" cannot
    //     be filmed — a camera films CHANGE. The repair either gives the beat an
    //     entry/exit (making it a change with two endpoints) or cuts it outright.
    if (STATIC_STATE.test(text) && !changesState && !hasEnd) {
      issues.push({
        shotId: s.id,
        code: "STATIC_STATE_BEAT",
        severity: "warn",
        detail:
          "This beat is a STATE (hiding/waiting/lurking), not an action. A renderer animates change; " +
          "given a state it invents motion to fill the time — that is how 'hides behind the wall' " +
          "became a man leaning-and-pushing on it. Convert it to a change with an entry and an exit " +
          "(e.g. 'presses flat against the wall, then breaks from cover and runs', with startFrame " +
          "and endFrame), or cut the beat.",
        autofixed: false,
      });
    }

    // (e) CROSSING GEOMETRY. A crossing (vault/jump/climb OVER something) is the
    //     single most-failed beat in this whole project, in two ways:
    //       1. Rendered as i2v with ONE frame → he bounces in place / hops sideways
    //          and lands where he started. (This is why the pin used to miss it:
    //          it required hasEnd, but the broken shot had no endFrame at all.)
    //       2. Even with two frames, if the endFrame does not say WHICH side, the
    //          model stages the wall alongside the path and he never crosses.
    //     So: a crossing with no endFrame is a STRUCTURAL BLOCK (needs two real
    //     endpoints), and a crossing WITH an endFrame gets the far side pinned.
    const isCrossing = CROSSING.test(text);
    if (isCrossing && !hasEnd) {
      issues.push({
        shotId: s.id,
        code: "CROSSING_NEEDS_TWO_SIDES",
        severity: "error",
        detail:
          "This shot crosses an obstacle (vault/jump/climb OVER), but has only one frame — so the model " +
          "animates him bouncing IN PLACE or hopping sideways and landing where he started. A crossing MUST " +
          "be ONE shot with startFrame on the NEAR side (facing the obstacle) and endFrame on the FAR side " +
          "(back to the obstacle, moving away). Also confirm the obstacle BLOCKS the path (runs across it), " +
          "not alongside it. If there is no real obstacle to cross, remove the crossing and just have him run.",
        autofixed: false,
      });
    }
    // ── FLF REDUCTION — THE KEYFRAME COST LEVER ─────────────────────────────
    // Every two-endpoint shot generates TWO keyframes instead of one, so each
    // unnecessary FLF costs an extra image. On a 1-minute film that is the
    // difference between 12 and 18 keyframes.
    //
    // The two-endpoint law exists because a WORLD-CHANGING beat needs both
    // endpoints or the model stalls. It does NOT apply to a shot that merely
    // has an endFrame the LLM added out of habit — a man walking, listening or
    // speaking changes nothing, so the second frame buys nothing. Those drop to
    // one keyframe with no quality loss.
    //
    // State changes and crossings KEEP both frames. Downgrading those is what
    // brings back the man hanging on the wall.
    //
    // PRIORITY 8 INVESTIGATION (background-parallax/static-element
    // instability — buildings visibly sliding while a character runs toward
    // camera): considered adding "a static-camera approach shot" as a FOURTH
    // reason to keep both endpoints here, on the theory that flf's two fixed
    // frames constrain the WHOLE image (not just the subject) the same way
    // they already stabilize a character's entrance (ENTRANCE_ENDPOINTS_
    // AUTOFILLED/Gap G), which should in principle reduce background drift
    // too. NOT applied: unlike Gap G (where the two endpoints are cheap to
    // author deterministically — an edge-of-frame pose and a fully-in-frame
    // pose), forcing a SECOND keyframe onto every static-camera approach
    // shot is a real, recurring cost with no real-render evidence yet that
    // it actually fixes background drift specifically (as opposed to the
    // camera_fixed API parameter + BACKGROUND LOCK prompt text applied in
    // 5-videos.ts, which are free and target the same failure directly).
    // The right test: render the SAME static-camera approach shot once
    // i2v-with-camera_fixed and once flf-with-camera_fixed, and compare
    // background stability directly — real render spend, not run this
    // session. Left as i2v for now; revisit if the cheaper fixes above
    // don't resolve it on the next real test render.
    if (hasEnd && !changesState && !isCrossing && !EMOTION_SHIFT.test(text)) {
      issues.push({
        shotId: s.id,
        code: "FLF_NOT_NEEDED",
        severity: "warn",
        detail:
          "This beat has two keyframes but nothing about the world changes in it, so the second frame " +
          "adds nothing the model can use. Dropped to a single keyframe — one less paid image, same result.",
        autofixed: true,
      });
      s.endFrame = "";
      s.method = "i2v";
    }

    if (isCrossing && hasEnd && !FAR_SIDE.test(s.endFrame)) {
      s.endFrame =
        s.endFrame.trim().replace(/[.\s]+$/, "") +
        ". He has LANDED on the FAR SIDE of the obstacle — the wall/barrier is now fully BEHIND him in the " +
        "frame, his back to it, running away from it down the path. He is on the OPPOSITE side from where he " +
        "started, clearly across the obstacle, not beside it.";
      issues.push({
        shotId: s.id,
        code: "CROSSING_SIDE_PINNED",
        severity: "warn",
        detail: "endFrame did not pin which side he lands on. Forced to the FAR side, obstacle behind him, moving away.",
        autofixed: true,
      });
    }

    // ── R5 · DURATION ────────────────────────────────────────────────────────
    // Every second here is billed. Two endpoints → the model can't stall, so it
    // gets a BIT more room than one endpoint — but "more room" is a cost lever,
    // not a free one: a previous pass pushed these caps to 12/6/8 (up to double
    // the old 6/4/6) on the theory that fewer, longer shots would look more
    // continuous, and it raised a single 1.4-minute film's bill from ~$6 to
    // $17.49 without fixing the actual defects (those were composition/logic
    // bugs, not duration bugs). Settled here at a modest bump over the original,
    // not a ceiling-maxing one.
    //
    // These values don't need to land exactly on a valid provider duration —
    // Seedance 1.5 Pro only accepts 4/6/8/10/12s (video.ts snaps to the
    // nearest one, rounding down on a tie, and 5-videos.ts's own methodCap
    // already keeps the common cases exact).
    // This clamp is about PACING (how long a beat deserves), not about the
    // provider's API shape; that adaptation happens downstream, deliberately
    // kept separate so this logic doesn't need to know which provider is live.
    const isAction = changesState || hasGenuineLocomotion(text);
    // Capture the AUTHORED intent BEFORE this rule's own clamping overwrites
    // s.duration below — needed to tell a genuine sub-4s rapid-cut request
    // (screenSeconds set, or duration itself authored under 4) apart from an
    // ordinary shot that simply omitted duration and fell back to the schema
    // default. See Shot.screenSeconds's own comment in types.ts.
    const authoredScreenSeconds =
      Number.isFinite(s.screenSeconds) && s.screenSeconds > 0
        ? s.screenSeconds
        : Number.isFinite(s.duration) && s.duration > 0 && s.duration < 4
        ? s.duration
        : 0;
    // SLOW MOTION gets the full deployment ceiling regardless of the other
    // tiers below — a beat explicitly written as slow motion needs the room
    // to let exaggerated weight/hang-time (see PACE_LIBRARY's own
    // cinematic_slow_motion entry, seasoned into this shot's motion/camera a
    // few lines below in R7) actually read on screen; the same tight 5-7s
    // budget that's correct for REAL-TIME action would just truncate it.
    const wantsSlowMotion = SLOW_MOTION_CUE.test(text);
    // IDENTITY-CRITICAL DURATION CEILING — drift that happens between a
    // single Seedance generation's first and last frame is temporal model
    // behavior; no prompt or compiler rule can reach inside a clip and
    // correct it mid-render (see 5-videos.ts's identityCriticalCandidate for
    // the matching camera-stabilization lever — same audit, same finding).
    // What IS controllable is how much TIME a single generation has to
    // drift in. A shot carrying 2+ named characters, or a close-up
    // delivering dialogue, is exactly where that drift is most visible and
    // most damaging — a duplicated/swapped identity or a face drifting
    // mid-line reads far worse than a background element sliding a few
    // pixels, which the general tiers below are already tuned for. Exempt
    // from SLOW_MOTION — an explicitly slow beat still needs its own room
    // to breathe even when it's also identity-critical, same as every other
    // tier here defers to it.
    const identityCritical =
      !wantsSlowMotion &&
      (s.characters.length >= 2 || ((CLOSEUP_RE.test(s.camera || "") || CLOSEUP_RE.test(text)) && !!s.dialogue?.trim()));
    const cap = wantsSlowMotion
      ? config.maxDuration
      : identityCritical
      ? Math.min(config.maxDuration, hasEnd ? 6 : 5)
      : hasEnd
      ? Math.min(config.maxDuration, 8)
      : isAction
      ? Math.min(config.maxDuration, 5)
      : Math.min(config.maxDuration, 7);
    const want =
      Number.isFinite(s.duration) && s.duration > 0
        ? Math.round(s.duration)
        : wantsSlowMotion
        ? config.maxDuration
        : 5;
    const clamped = Math.min(Math.max(want, 4), cap);
    if (clamped !== s.duration) {
      issues.push({
        shotId: s.id,
        code: "DURATION_CLAMPED",
        severity: "warn",
        detail: `${s.duration}s → ${clamped}s. ${wantsSlowMotion ? "Slow motion needs room to breathe." : hasEnd ? "Two endpoints, room to work." : "A one-endpoint model holds a pose to fill extra frames."}`,
        autofixed: true,
      });
      s.duration = clamped;
    }

    // ── SCREEN SECONDS — see Shot.screenSeconds's own comment in types.ts ──
    if (authoredScreenSeconds > 0 && authoredScreenSeconds < 4) {
      // A genuine sub-4s intended beat: never pay for more than Seedance's
      // real floor when the plan is to trim away everything past
      // screenSeconds anyway — rendering 6/8/10/12s to keep 1.3s of it would
      // waste more money for zero benefit. Overrides whatever the tiered cap
      // above picked.
      if (s.duration !== 4) {
        issues.push({
          shotId: s.id,
          code: "SCREEN_SECONDS_FLOORED",
          severity: "warn",
          detail: `Intended screen time ${authoredScreenSeconds}s is under Seedance's 4s generation floor — rendering at exactly 4s and trimming to ${authoredScreenSeconds}s in assembly, instead of the ${s.duration}s this shot's own tier would otherwise have picked.`,
          autofixed: true,
        });
      }
      s.duration = 4;
      s.screenSeconds = Math.max(0.3, Math.round(authoredScreenSeconds * 10) / 10);
    } else if (authoredScreenSeconds > 0 && authoredScreenSeconds < s.duration) {
      // An explicit trim target that's still >= 4s (e.g. a shot whose full
      // render naturally runs longer than the beat needs on screen) — honor
      // it as a real trim rather than discarding it.
      s.screenSeconds = Math.round(authoredScreenSeconds * 10) / 10;
    } else {
      // No trim requested, or the requested value wouldn't actually shorten
      // anything. screenSeconds always ends up populated with a real number
      // (the full render length) so 6-assemble.ts never needs an "is this
      // set" branch, only a plain comparison against the clip's real length.
      s.screenSeconds = s.duration;
    }

    // ── R6 · SCREEN DIRECTION ───────────────────────────────────────────────
    const dir = /left[- ]to[- ]right/i.test(text) ? "L"
              : /right[- ]to[- ]left/i.test(text) ? "R"
              : null;
    if (dir && prevDir && dir !== prevDir && isAction) {
      issues.push({
        shotId: s.id,
        code: "SCREEN_DIRECTION_FLIP",
        severity: "warn",
        detail: `Direction flips ${prevDir}→${dir} between cuts. Insert a "toward camera" shot to reset, or keep the direction.`,
        autofixed: false,
      });
    }
    if (dir) prevDir = dir;

    // ── R7 · LOCK THE CAST, THE GROUND, AND THE FACE ────────────────────────
    const names = s.characters.map((id) => characters.find((c) => c.id === id)?.name ?? id);

    // ── BREAKDOWN HEADCOUNT SELF-CONTRADICTION (Track B / B1) ────────────────
    // Confirmed real, straight from a real breakdown: Shot 5's own text said
    // "The shopkeeper stands behind the counter, shelves of goods behind him,
    // visible through the door's glass" — describing a THIRD person, present
    // and visible — in the SAME shot whose castLock text (just below) then
    // asserts "Exactly 2 people appear anywhere in this frame." That shipped
    // straight to generation: a direct, deterministically-checkable
    // self-contradiction in the breakdown's OWN text, not a rendering fluke.
    // SECONDARY_ROLE_NOUN is a curated list (same discipline as this file's
    // other role-noun lists) of common named-but-not-in-CHARACTERS roles a
    // script naturally introduces — deliberately NOT a generic person-
    // detector, which would false-positive constantly on ordinary prose.
    // OUT_OF_FRAME_ESCAPE is the correct way to mention such a role WITHOUT a
    // contradiction (Shot 7, the very same real script, correctly wrote "The
    // shopkeeper stands behind the counter on the service side, out of
    // frame." — nearby "out of frame" language means the shot is deliberately
    // EXCLUDING them from the headcount, not contradicting it).
    {
      const SECONDARY_ROLE_NOUN =
        /\b(shopkeeper|waiter|waitress|clerk|cashier|receptionist|bartender|barista|attendant|guard|driver|conductor|usher|vendor|merchant|shop\s?assistant|doctor|nurse|teacher|chef|cook|host|hostess|bellboy|porter|officer|secretary|manager)\b/gi;
      const OUT_OF_FRAME_ESCAPE =
        /\b(out of frame|off[- ]frame|off[- ]screen|not visible|not in (?:this |the )?frame|elsewhere|not (?:physically )?present|unseen)\b/i;
      const ownDescription = authoredOnly(s.description);
      const roleMatches = [...new Set([...ownDescription.matchAll(SECONDARY_ROLE_NOUN)].map((m) => m[0].toLowerCase()))];
      const describedButUncounted = roleMatches.filter((role) => {
        // Look at the text around EACH mention of this role — a shot could
        // legitimately mention the same role noun twice, once excluded
        // ("out of frame") and once not; only flag if NO mention of it is
        // paired with the out-of-frame escape.
        const re = new RegExp(`\\b${role}\\b`, "gi");
        let m: RegExpExecArray | null;
        let everExcluded = false;
        while ((m = re.exec(ownDescription))) {
          const nearby = ownDescription.slice(Math.max(0, m.index - 60), Math.min(ownDescription.length, m.index + role.length + 60));
          if (OUT_OF_FRAME_ESCAPE.test(nearby)) { everExcluded = true; break; }
        }
        return !everExcluded;
      });
      if (describedButUncounted.length) {
        issues.push({
          shotId: s.id,
          code: "BREAKDOWN_HEADCOUNT_CONTRADICTION",
          severity: "warn",
          detail:
            `This shot's own description names ${describedButUncounted.join(", ")} as present and visible, ` +
            `but this shot's exact-headcount lock only counts ${names.length ? names.join(", ") : "nobody"} — a ` +
            `direct self-contradiction in the shot's own text, not a rendering fluke. Either add ` +
            `${describedButUncounted.length === 1 ? "this person" : "these people"} to this shot's tracked ` +
            `characters (if they act or are named as present), or explicitly state they are out of frame/off-` +
            `screen (if the shot only implies the space, not that person, is visible) — never leave both ` +
            `assertions standing at once.`,
          autofixed: false,
        });
      }

      // ── NPC MISSING A REAL CHARACTER ENTRY (Track B / B3) ──────────────────
      // Deterministic backstop for the prompt guidance just added ("A SECONDARY
      // CHARACTER WITH A REAL ROLE BELONGS IN THE characters ARRAY TOO" in
      // llm.ts) — prompt-only compliance is well-established in this codebase
      // as unreliable (see e.g. SCENE_SETTING_LOCK's own comment on this exact
      // point), so this actually VERIFIES the LLM followed it, rather than
      // trusting it did. Confirmed real: the shopkeeper had NO entry anywhere
      // in bd.characters at all, so the reference-lock system (3-sheet.ts,
      // 4-images.ts, 5-videos.ts) — which is entirely generic per-character-id
      // and would have worked for him automatically if he'd been added — never
      // ran for him, because there was no id to run it FOR. This does not
      // auto-generate the missing entry (that would need a real LLM call this
      // compile pass can't make synchronously — see the two-pass pattern used
      // elsewhere for exactly that reason); it makes the omission IMPOSSIBLE
      // to ship unnoticed instead of silently ignored.
      for (const role of describedButUncounted) {
        const hasEntry = characters.some(
          (c) => c.id.toLowerCase().includes(role) || c.name.toLowerCase().includes(role),
        );
        if (!hasEntry) {
          issues.push({
            shotId: s.id,
            code: "NPC_MISSING_CHARACTER_ENTRY",
            severity: "warn",
            detail:
              `"${role}" is described as present and acting in this shot, but has no entry anywhere in the ` +
              `breakdown's own "characters" array — meaning no reference photo and no identity lock exist for ` +
              `them at all. Without one, the renderer has no separate identity to draw from and typically ` +
              `substitutes an already-established lead into this person's position instead. Add a real ` +
              `"characters" entry for "${role}" (id, name/role label, a depictable "appearance" description, ` +
              `voice) and list their id in every shot they actually appear in.`,
            autofixed: false,
          });
        }
      }
    }

    // CROWD-AWARE. The old wording — "every other human is a blurred background
    // figure" — is correct for a market or a stadium, where strangers belong in
    // the world. It is WRONG for a private house at 2am with a cast of two: that
    // phrasing does not forbid a background person, it explicitly PERMITS one, as
    // long as it is blurred and distant. Confirmed on camera: a woman with no
    // story reason to exist appeared in the hallway behind Mark in this exact kind
    // of scene. When `crowd` is false, the correct instruction is not "keep
    // strangers far away" — it is "there are no strangers, anywhere in frame."
    const hasIndirectPresence = names.length === 0 && INDIRECT_PRESENCE.test(s.description);
    // MULTI-CHARACTER SHOTS ONLY EVER GOT A TOTAL-COUNT CONSTRAINT ("Exactly 2
    // people in the foreground"), never the explicit per-person "do not duplicate
    // THIS one" instruction the solo case has always had. A total headcount is a
    // weak signal against duplication — the renderer doesn't literally count
    // heads against a number, it pattern-matches phrases, and "exactly 2" reads
    // far less forcefully than "do NOT add a second figure" does in the solo
    // branch below. Confirmed on camera: in a 2-person market shot (a buyer and
    // a shopkeeper), the SHOPKEEPER — one of only two named people — appeared
    // twice in the same frame. Naming each person explicitly and forbidding
    // THEIR OWN duplication (not just capping the total) is the fix.
    const namedNoDupe = names.length
      ? ` Each of them — ${names.join(", ")} — appears EXACTLY ONCE in this frame. None of them is duplicated, doubled, cloned, or shown twice anywhere in the shot, foreground or background, even briefly.`
      : "";
    const castLock = buildCastLock(names, s.crowd, hasIndirectPresence, namedNoDupe);

    // IDEMPOTENCE. This guard only checked the SOLO wording, so multi-character
    // shots ("Exactly 3 people in the foreground") and empty ones ("No people in
    // the foreground") never matched and were re-appended on EVERY recompile.
    // Three compile rounds produced three identical copies, which is what turned
    // real shot descriptions into walls of repeated boilerplate.
    if (!CASTLOCK_TAIL_MARKERS.some((m) => s.description.includes(m))) {
      s.description = `${s.description} ${castLock}`.trim();
    }

    // CROWD SEPARATION. Background figures that drift close to the lead are how a
    // passer-by ends up merged into the subject's body. Demand real distance.
    // IDENTITY, NOT JUST DISTANCE: distance alone doesn't stop a background figure
    // from being painted with the SAME face as the named lead — a known failure
    // mode when a strongly-referenced character identity bleeds into how the model
    // renders everyone else nearby. Confirmed on camera: a market scene's single
    // named character appeared to duplicate himself in the crowd. Distance and
    // identity are two separate asks; say both.
    if (s.crowd && !/clear separation/i.test(s.description)) {
      const distinctFrom = names.length ? ` None of them share ${names.join("'s or ")}'s face, hair, or clothing — every background person is a visibly different individual.` : "";
      s.description =
        `${s.description} All background people remain FAR behind the subject with clear separation — ` +
        `at least several metres back, out of focus, never crossing in front of, touching, or overlapping ` +
        `the subject at any point.${distinctFrom}`.trim();
    }

    // ── EYELINE MATCH ────────────────────────────────────────────────────────
    // See EYE_CONTACT_CUE/heightState()'s own comment above. Scoped to
    // non-crowd 2-named-character shots — a crowd scene's background figures
    // are never the subject of an eye-contact beat, and a 3+-named shot
    // would need to know WHICH pair is making eye contact, not just that a
    // height differential exists somewhere in the cast. Runs on the shot's
    // still-mostly-authored text (before ACTION/PACE/REACTION library
    // injection below), so it reads the writer's actual intent, not
    // boilerplate this compiler is about to add.
    //
    // TWO WAYS IN, not just an explicit "look at each other" phrase: a
    // face-to-face DIALOGUE EXCHANGE between the two named people implies
    // visual engagement by default in ordinary film blocking, even when the
    // shot never spells out "eye contact" — a scripted conversation between
    // a seated and a standing character is exactly the case this exists for,
    // and requiring the writer to also add "they look at each other" every
    // single time would mean this almost never fires on real scripts.
    //
    // GAZE AVERSION IS A REAL, DIFFERENT INTENT — never overridden. A shot
    // that explicitly says a character avoids eye contact, looks away, or
    // won't meet the other's gaze (REACTION_LIBRARY's embarrassment_shame
    // and guilt entries both describe exactly this) means they are NOT
    // looking at each other, which is the opposite of what this rule assumes
    // by default — checked first and skips the whole rule if present.
    //
    // BODY POSTURE IS DELIBERATELY LEFT ALONE. Only the GAZE angle is
    // asserted here, never "the tall one leans down" or any other torso
    // change — whether a standing character looms imposingly or stoops to
    // the other's level is a directorial choice (see llm.ts's own "POWER AND
    // VULNERABILITY ARE AN ANGLE, NOT AN ACCIDENT" rule), and forcing a body
    // change here could silently undo a deliberate power-dynamic staging.
    // The eye-level gap itself is not optional — anatomy fixes it regardless
    // of staging intent — so only that gets stated as fact.
    if (names.length === 2 && !s.crowd) {
      const eyeContactText = `${s.description} ${s.motion}`;
      const alreadyStated = GAZE_DIRECTION_STATED.test(eyeContactText);
      const aversionStated = GAZE_AVERSION_CUE.test(eyeContactText);
      const dialogueExchange =
        !!s.dialogue?.trim() && !s.offscreenSpeaker && !!s.speaker && s.characters.includes(s.speaker);
      if ((EYE_CONTACT_CUE.test(eyeContactText) || dialogueExchange) && !alreadyStated && !aversionStated) {
        const postureText = `${s.description} ${s.startFrame} ${s.motion}`;
        const heights = names.map((n) => heightState(postureText, n));
        const lowIdx = heights.indexOf("low");
        const highIdx = heights.indexOf("high");
        if (lowIdx !== -1 && highIdx !== -1 && lowIdx !== highIdx) {
          const lowName = names[lowIdx];
          const highName = names[highIdx];
          s.description =
            `${s.description} EYELINE: ${lowName} is physically lower than ${highName} in this shot, so their ` +
            `gazes meet at an angle, not level, for the ENTIRE shot, not just one frame — ${lowName}'s head ` +
            `tilts up and their gaze holds toward ${highName}'s face throughout, while ${highName}'s head tilts ` +
            `down and their gaze holds toward ${lowName}'s throughout. Neither one ever looks straight ahead as ` +
            `if they were the same height, and the angle stays consistent through every moment of the exchange, ` +
            `including while either of them is speaking or reacting.`.trim();
          issues.push({
            shotId: s.id,
            code: "EYELINE_HEIGHT_MISMATCH",
            severity: "warn",
            detail:
              `${lowName} and ${highName} are at different physical heights in this shot (one seated/kneeling, ` +
              `one standing) and are ${dialogueExchange && !EYE_CONTACT_CUE.test(eyeContactText) ? "in dialogue with each other" : "making eye contact"} ` +
              `with no stated gaze angle. Added an explicit, sustained up/down eyeline so the renderer doesn't ` +
              `default to two level, straight-ahead stares.`,
            autofixed: true,
          });
        }
      }
    }

    // ── ACTION LIBRARY INJECTION ────────────────────────────────────────────
    // Runs BEFORE the running-specific checks just below on purpose: those
    // checks look for phrases like "covers real ground" / "background
    // streams" and skip their own append if already present. The library's
    // own running/walking entry deliberately uses that same compatible
    // vocabulary, so when both apply to one shot they reinforce each other
    // instead of appending two redundant, slightly different versions of the
    // same instruction.
    //
    // AD MODE, EMPTY CAST — SKIPPED ENTIRELY. Every entry in this library
    // describes how a HUMAN BODY performs an action (the library's own note:
    // "how each common action actually looks performed") — legs, arms, hands,
    // torso, weight. A faceless product ad's shot has no body to perform
    // anything, so none of it can apply. Confirmed on camera, and the reason
    // this gate exists: a macro shot — "the bottle's spiraled glass texture and
    // the gold-thread label catching the light" — matched the `catching` entry
    // on the bare word "catching" (an idiom about LIGHT, not a person catching
    // a thrown object) and had "the hands rise and open to meet its trajectory,
    // fingers closing around it" appended to its motion. That same shot's
    // castLock (R7) said "No people appear anywhere in this frame" and its
    // EMPTY_CAST_NEGATIVE forbade "hand"/"arm" — so the render was handed a flat
    // self-contradiction, and a positive, biomechanically-detailed sentence
    // beats a one-word negative every time. Result: visible hands, QA
    // extra_people at 0.90, and a regenerate loop that could never converge
    // because every re-roll rebuilt the identical contradictory prompt.
    //
    // DELIBERATELY NOT APPLIED TO FILMS. An empty-cast film shot has the same
    // theoretical exposure, but the film path is long-established and tuned
    // against this library; scoping the change to ads keeps it to the surface
    // that actually reported the bug. isAd is the only thing gating it — remove
    // that condition to extend it everywhere.
    // Gates FIVE separate body-mechanics injections in this pass (action
    // library here, ground contact, the TENSE_HOSTILE emotion lock, pace
    // library, reaction library) — every one of them derives from this single
    // flag rather than re-deriving the condition, so they can never disagree
    // about what "a faceless ad shot" means.
    const facelessAdShot = isAd && s.characters.length === 0;
    if (!facelessAdShot) {
      for (const action of matchActions(`${authoredOnly(s.motion)} ${authoredOnly(s.description)}`)) {
        if (s.motion.includes(action.marker)) continue; // idempotent across recompiles
        s.motion = `${s.motion} ${action.description}`.trim();
      }
    }

    // ── TWO-BODY CONTACT INJECTION ───────────────────────────────────────────
    // llm.ts's own "TWO BODIES IN CONTACT" section: a hug, handshake, grapple,
    // collision, or carry is the renderer's single most common way to fuse two
    // people into one many-limbed mass — real cited failure: "two figures
    // meeting at speed rendered as a single many-limbed mass." That section is
    // advisory (asks the LLM to state exactly where they touch, every time) —
    // only a blanket, content-blind negative-prompt phrase backed it up before
    // this. This detects a genuine two-named-character contact beat and
    // appends the same precision instruction deterministically, same
    // idempotent marker-guard pattern as the trigger libraries above.
    const CONTACT_VERBS =
      /\b(hugs?|hugging|hugged|embraces?|embracing|embraced|handshakes?|shakes?\s+hands|grapples?|grappling|wrestles?|wrestling|collides?|collision|colliding|tackles?|tackling|wraps?\s+(?:his|her|their)?\s*arms?\s+around|hand\s+on\s+(?:his|her|their)?\s*shoulder|holds?\s+(?:him|her|them)\s+close|carries?\s+(?:him|her|them)|carrying\s+(?:him|her|them))\b/i;
    const CONTACT_MARKER = "Physical contact stays precise";
    if ((s.characters?.length ?? 0) >= 2 && CONTACT_VERBS.test(`${authoredOnly(s.motion)} ${authoredOnly(s.description)}`) && !s.motion.includes(CONTACT_MARKER)) {
      s.motion =
        `${s.motion} ${CONTACT_MARKER}: both people remain two separate, complete bodies — one head and two arms ` +
        `each — with a visible seam or gap where they touch and nowhere else; no blending of hair, skin tone, or ` +
        `clothing along the contact line.`.trim();
    }

    // ── COUNTER / SHOP GEOMETRY REMINDER ─────────────────────────────────────
    // llm.ts's own "COUNTERS, SHOPS AND SERVED SPACES" section — real cited
    // failure: "the customer was rendered inside while the shopkeeper appeared
    // outside the shop — the geometry was never stated, so it was invented."
    // Detecting the VIOLATION itself isn't reliably regexable (would need to
    // tell indoor from outdoor per-character from prose), so — same choice as
    // the two-body contact injection above — this detects the SCENE (a
    // counter, two people present) and deterministically states the correct
    // geometry every time, rather than trying to catch it after the fact.
    // Written to s.setting so SCENE SETTING LOCK (below) naturally carries it
    // to every other shot of the same counter scene, not just this one.
    const COUNTER_RE = /\b(counter|shop counter|register|till|checkout)\b/i;
    const COUNTER_MARKER = "The counter separates them";
    if ((s.characters?.length ?? 0) >= 2 && COUNTER_RE.test(`${authoredOnly(s.setting)} ${authoredOnly(s.description)}`) && !s.setting.includes(COUNTER_MARKER)) {
      s.setting =
        `${s.setting} ${COUNTER_MARKER}: the customer stays on the public side of the counter, facing it; the ` +
        `shopkeeper stays BEHIND the counter on the service side, shelves and stock behind them, facing the ` +
        `customer. Both are fully inside the shop — neither crosses to the other's side, and neither is ever ` +
        `shown outside while the other is inside.`.trim();
      issues.push({
        shotId: s.id,
        code: "COUNTER_GEOMETRY_REMINDER",
        severity: "warn",
        detail:
          "A counter/shop scene with two people present but no stated geometry — added the standard customer/" +
          "shopkeeper counter geometry so the two sides, and indoor/outdoor state, aren't left for the model to invent.",
        autofixed: true,
      });
    }

    // ── FINE HAND MANIPULATION → FORCE CLOSE/INSERT FRAMING ─────────────────
    // llm.ts's own "HANDS AND FINE MANIPULATION" section: buttoning, tying a
    // lace, opening a jar, turning a key, threading a needle, thumbing a
    // phone — the model's hands are a known weak spot, and it says plainly
    // that any such beat MUST be framed close/insert, never wide, or the
    // fingers render at ten pixels tall. Advisory only before this — nothing
    // stopped a wide/medium shot from being assigned to exactly this kind of
    // beat. Autofixed: this is a deterministic framing correction, the same
    // kind of camera rewrite REPEATED_FRAMING/COVERAGE_MONOTONY already make
    // elsewhere in this file.
    const FINE_MANIPULATION =
      /\b(buttons?|buttoning|buttoned|unbuttons?|unbuttoning|ties?\s+(?:a|his|her|their)\s+(?:lace|shoelace|knot|tie)|tying\s+(?:a|his|her|their)?\s*(?:lace|shoelace|knot|tie)|unscrews?|unscrewing|opens?\s+(?:a|the)\s+jar|threads?\s+a\s+needle|threading\s+a\s+needle|turns?\s+(?:a|the)\s+key|turning\s+(?:a|the)\s+key|thumbs?\s+(?:his|her|their)?\s*(?:phone|screen)|typing\s+on\s+(?:his|her|their)?\s*phone|fingers?\s+the\s+(?:strings|keys|instrument)|fingering\s+the\s+(?:strings|keys|instrument))\b/i;
    if (FINE_MANIPULATION.test(`${authoredOnly(s.motion)} ${authoredOnly(s.description)}`)) {
      const fam = framingFamily(s.camera);
      if (fam !== "cu" && fam !== "xcu" && fam !== "mcu") {
        const before = s.camera;
        s.camera = "close-up insert on the hands, camera static";
        issues.push({
          shotId: s.id,
          code: "FINE_MANIPULATION_NEEDS_CLOSE_FRAMING",
          severity: "warn",
          detail:
            `This shot's point is fine hand manipulation (buttoning, a lace, a key, a jar, a phone...), but the ` +
            `camera was "${before || "unset"}" — a wide/medium framing where the fingers render at ten pixels ` +
            `tall, exactly what produces melted or extra fingers. Forced to a close-up insert on the hands.`,
          autofixed: true,
        });
      }
    }

    // ── LIGHTING LIBRARY INJECTION ──────────────────────────────────────────
    // Same idempotence pattern as the action library above, applied to
    // s.lighting instead of s.motion. Matches against the shot's own lighting
    // AND setting/description text, since a mood word ("by candlelight") often
    // shows up in the scene description rather than the lighting field itself.
    for (const mood of matchLighting(`${authoredOnly(s.lighting)} ${authoredOnly(s.setting)} ${authoredOnly(s.description)}`)) {
      if (s.lighting.includes(mood.marker)) continue;
      s.lighting = `${s.lighting} ${mood.description}`.trim();
    }

    // Ground contact — NOT on a state-change beat, where leaving the ground may
    // be the point, and NOT on a driving beat: the ACTION LIBRARY INJECTION
    // above runs first, so a driving shot's motion already carries "Natural
    // driving mechanics:" by this point — someone seated in a car has their
    // feet on the pedals, not "the ground" (which usually isn't even in frame
    // for a vehicle-interior shot), so this instruction would be contradictory
    // rather than merely redundant.
    // AND NOT on an ad's faceless shot: "both feet" is an instruction about a
    // HUMAN BODY, and a product-only ad shot has none — the identical
    // contradiction (and identical extra_people failure) as the ACTION LIBRARY
    // gate above, from a second source. Ad-scoped for the same reason, and the
    // `skipActionLibrary` flag is reused rather than re-derived so the two
    // rules can never disagree about what "a faceless ad shot" means.
    if (!hasEnd && !facelessAdShot && !/both feet/i.test(s.motion) && !s.motion.includes("Natural driving mechanics:")) {
      s.motion = `${s.motion} Both feet make firm, visible contact with the ground throughout.`.trim();
    }

    // CAMERA MUST MOVE ON LOCOMOTION. "He walks" + a locked-off camera renders a
    // man treading in place against a frozen background — there is nothing in the
    // frame to prove he covered ground. A tracking/dolly camera makes the world
    // stream past him, which is what reads as real movement.
    // Expanded for CAMERA_MOVE_LIBRARY.json's richer named-move vocabulary --
    // kept identical to steps/5-videos.ts's own separate copy of this same
    // vocabulary (two independently maintained regexes, not a shared
    // constant -- update both together).
    if (hasGenuineLocomotion(authoredOnly(text)) && !/track|dolly|follow|pan|tilt|steadicam|handheld|push|pull|crane|jib|orbit|arc|zoom|whip|crash|sweep|rise|fpv|drone|hyperlapse|snorricam/i.test(s.camera || "")) {
      const moved = `${s.camera || "medium shot"}, camera TRACKING alongside the subject at their pace, moving continuously so the background streams past behind them`;
      issues.push({
        shotId: s.id,
        code: "STATIC_CAMERA_ON_MOVEMENT",
        severity: "warn",
        detail: `Locked-off camera on a walking/running beat renders a treadmill (subject moves, background frozen). Camera changed to a tracking move.`,
        autofixed: true,
      });
      s.camera = moved;
    }

    // ── FLAT/CENTERED STATIC-WIDE DEFAULT — THE "AI GENERIC" TELL ──────────
    // A locked-off, dead-center wide shot with no compositional device and no
    // camera movement is the single most recognizable "under-specified
    // prompt" look in AI video — real cinematography rarely defaults to it
    // because it's the least interesting choice available, not because it's
    // forbidden (a deliberately locked-off wide IS legitimate coverage; an
    // establishing shot often should be static). Text-level detection only —
    // this file cannot see the rendered pixels, only the prompt driving it:
    // flags a WIDE shot (framingFamily() below, the same classifier
    // REPEATED_FRAMING/COVERAGE_MONOTONY/LENS_LIBRARY already use) whose
    // camera text has NEITHER a movement verb NOR a stated compositional
    // device (an angle, a depth layer, a foreground element, an off-center
    // choice) — the same "thin text -> generic result" signal
    // MOTION_TOO_THIN_FOR_NATURAL already relies on for motion, applied to
    // composition instead. WARN, not autofixed: unlike STATIC_CAMERA_ON_
    // MOVEMENT just above (one clearly correct mechanical fix — add
    // movement), there is no single correct fix for flat composition — a low
    // angle, a foreground element, and a tracking move are all equally
    // valid, so this goes to the repair loop (see REPAIRABLE_WARN_CODES)
    // rather than this file injecting one canned phrase onto every flagged
    // shot, which would just trade one generic default for another.
    const CAMERA_COMPOSITION_DEVICE =
      /\b(track(?:ing)?|dolly(?:ing)?|push(?:ing)?|pull(?:ing)?|pan(?:ning)?|crane|craning|handheld|steadicam|follow(?:ing)?|orbit(?:ing)?|arcs?|arcing|zoom(?:ing)?|circl(?:e|es|ing)|sweep(?:ing)?|drift(?:ing)?|rack focus|tilts?|tilting|dutch|low angle|high angle|over-the-shoulder|foreground|through the|framed (?:by|through)|off-?center|rule of thirds|leading lines|depth|layered|silhouett|reflection|negative space|symmetr|frame within a frame)\b/i;
    if (s.camera && framingFamily(s.camera) === "wide" && !CAMERA_COMPOSITION_DEVICE.test(s.camera)) {
      issues.push({
        shotId: s.id,
        code: "FLAT_GENERIC_WIDE_FRAMING",
        severity: "warn",
        detail:
          `camera="${s.camera}" is a wide shot with no camera movement and no stated compositional device (an ` +
          `angle, a foreground element, a depth layer, an off-center placement) — this is the single most ` +
          `recognizable "generic AI video" default, the flat/centered/static look a real cinematographer almost ` +
          `never reaches for without a reason. Either give it a deliberate compositional choice (a low/high/dutch ` +
          `angle, a foreground element, an off-center subject placement) or a motivated camera movement — or, if a ` +
          `genuinely static, plain wide IS the right call for this beat (a calm establishing shot), that's a valid ` +
          `choice too, just not the unexamined default.`,
        autofixed: false,
      });
    }

    // DISPLACEMENT. A running/walking shot with one frame renders a man jogging IN
    // PLACE — the treadmill effect you saw. Demand real ground covered: the camera
    // tracks, the background streams past, he ENDS somewhere he did not start.
    if (hasGenuineLocomotion(authoredOnly(text)) && !/covers (real )?ground|background (rushes|streams|races)/i.test(s.motion)) {
      s.motion =
        `${s.motion} He covers real ground and physically MOVES through the scene — the camera tracks with him, ` +
        `the background streams past behind him, and he ends the shot at a clearly DIFFERENT position along the ` +
        `street than he began. He does NOT run in place; the world moves past him.`.trim();
    }

    // Emotional continuity — one model SMILED mid-chase. Forbid the drift.
    // Scoped to TENSE_HOSTILE, NOT the broad isAction used above for duration/
    // tier routing — see TENSE_HOSTILE's own comment for why. A calm sit-down,
    // a friendly hand-off, or a joyful reunion hug must never be told "no
    // smiling."
    // ...and never on an ad's faceless shot: "the subject's expression" and "no
    // smiling" presuppose a FACE, which a product-only shot does not have.
    if (TENSE_HOSTILE.test(text) && !POSITIVE_EMOTION.test(text) && !facelessAdShot && !/expression stays/i.test(s.motion)) {
      s.motion = `${s.motion} The subject's expression stays hard and intense throughout — no smiling, no relaxing, no softening.`.trim();
    }

    // ── PACE LIBRARY INJECTION ──────────────────────────────────────────────
    // Deliberately AFTER the camera-movement structural fixes above (CAMERA
    // MUST MOVE ON LOCOMOTION / DISPLACEMENT), never before: those fixes key
    // off whether s.camera ALREADY contains a movement word, and a pace note
    // written first (e.g. "a slow, creeping push") could satisfy that check
    // by accident and silently skip a structural fix the shot actually needed.
    // Pace only ever seasons an already-correct camera instruction on top.
    for (const pace of matchPace(text)) {
      // The tempo's CAMERA note (below) is safe for any shot, but its motion
      // `description` is written in body language ("shoulders", "breathing",
      // "fingers") — so a faceless ad shot takes the camera half only.
      if (!facelessAdShot && !s.motion.includes(pace.marker)) s.motion = `${s.motion} ${pace.description}`.trim();
      // NOT s.camera || "medium shot": inventing a framing default here is not
      // pace's job, and "medium shot" collides with framingFamily() below (the
      // "two shots in a row framed the same" autofix) -- confirmed on a real
      // run: it classified an untouched empty-camera shot as the SAME family
      // as its neighbor and overwrote this entire seasoning away. An empty
      // camera field just gets the tempo note verbatim; anything already
      // authored gets it appended.
      if (!(s.camera || "").includes(pace.cameraMarker)) s.camera = s.camera ? `${s.camera}, ${pace.cameraNote}` : pace.cameraNote;
    }

    // ── REACTION LIBRARY INJECTION ───────────────────────────────────────────
    // Same idempotence pattern as the libraries above. Matches against the
    // shot's own motion AND description text, since a reaction is often
    // stated in the description ("she realizes what's happened") rather than
    // spelled out in the motion field. Deliberately AFTER pace injection: a
    // reaction beat's PHYSIOLOGY (this library) and its TEMPO (pace) are
    // different, compatible questions — a shock reaction can be urgent-tempo
    // or quiet-dread-tempo — so both may legitimately season the same shot,
    // unlike lighting/pace/reaction against each other within their own
    // single-best-match libraries.
    // Skipped entirely for an ad's faceless shot: this library is PURE human
    // physiology — every single entry describes eyes, breath, jaw, shoulders or
    // hands — so none of it can apply to a product-only frame.
    if (!facelessAdShot) {
      for (const reaction of matchReaction(`${authoredOnly(s.motion)} ${authoredOnly(s.description)}`)) {
        if (s.motion.includes(reaction.marker)) continue;
        s.motion = `${s.motion} ${reaction.description}`.trim();
      }
    }

    // ── RETROACTIVE HEAL (faceless ad shots) ────────────────────────────────
    // Placed after the LAST body-mechanics injection in this pass so one call
    // covers all five sources. Every gate above is a SKIP, not a removal — so
    // for an ad compiled before those gates existed, the stale sentences would
    // otherwise survive forever, and worse, each rule's own idempotence marker
    // ("Natural catching mechanics:", /both feet/, "expression stays") would
    // keep reading them as already-satisfied. This is the only place that
    // actually takes them back out.
    if (facelessAdShot) s.motion = stripBodyMechanics(s.motion);

    // ── R7.5 · NATURAL-MOTION FLOOR ─────────────────────────────────────────
    // Stiff, "AI-looking" motion comes from thin motion text — the model animates
    // only the detail it is given. If the authored motion is too short to describe
    // real physical movement, flag it for enrichment (weight, secondary motion,
    // micro-behaviour). Warn only; the repair loop rewrites it richer.
    //
    // CONFIRMED REAL GAP, and the specific mechanism behind a "breakdown never
    // says what any character actually does" complaint: this used to require
    // `motionWords > 0` to fire at all, which means a shot whose "motion" came
    // back COMPLETELY EMPTY from breakdownScript() — not thin, EMPTY — was
    // silently exempted from the one check that exists to catch exactly this.
    // Empty is the worse case, not a case outside this rule's scope: with
    // motion carrying zero authored action, 5-videos.ts's motionPrompt falls
    // straight back to its own hardcoded generic default ("the character moves
    // naturally with clear, visible body movement") for that shot's entire
    // "Action:" clause — completely disconnected from anything the script
    // actually asked for, and never flagged for the repair loop to fix because
    // this rule never fired. motionWords === 0 now flags too, worded to make
    // clear to the repair LLM that this is a full rewrite, not a top-up.
    const authoredMotion = authoredOnly(s.motion);
    const motionWords = (authoredMotion.match(/\b\w+\b/g) ?? []).length;
    if (motionWords < 14) {
      issues.push({
        shotId: s.id,
        code: "MOTION_TOO_THIN_FOR_NATURAL",
        severity: "warn",
        detail:
          motionWords === 0
            ? "This shot's \"motion\" is completely empty — there is no authored physical action for this shot " +
              "at all, which means the render prompt falls back to a generic default with no connection to what " +
              "any character actually does here. Write a real beat-by-beat action timeline: what each character " +
              "present in this shot physically does, in order, for the shot's full duration."
            : "The motion description is too brief to render as natural movement — the model will produce " +
              "stiff, robotic motion. Enrich it: describe weight and force (how the body drives the move), " +
              "secondary motion (hair, fabric, breath), how the body settles, and one piece of micro-behaviour. " +
              "Describe the face in specific muscles, not a label.",
        autofixed: false,
      });
    }

    // ── R7.6 · MOTION DENSITY vs DURATION ───────────────────────────────────
    // Inverse of R7.5 just above: that catches too LITTLE motion text for
    // natural movement; this catches too MUCH — more distinct action beats
    // than the shot's own duration can plausibly hold. llm.ts's own
    // authoring convention is roughly one beat per 1-2 seconds ("a 5-second
    // shot needs 3-4 beats"); at the ABSOLUTE fastest a real beat can still
    // read as physically distinct on screen (about one beat per second), a
    // shot describing MORE beats than it has seconds cannot possibly finish
    // all of them. Confirmed real: a shot whose door-opening action never
    // actually completed on screen because there simply wasn't time left
    // for everything the motion text described. screenSeconds (the intended
    // ON-SCREEN time, possibly shorter than the rendered clip for a rapid
    // cut) is preferred over duration when authored, since that's the real
    // window the beats have to read in.
    const effectiveSeconds = s.screenSeconds > 0 ? s.screenSeconds : s.duration;
    const beatCount = countMotionBeats(authoredMotion);
    if (beatCount > 0 && effectiveSeconds > 0 && beatCount > effectiveSeconds) {
      issues.push({
        shotId: s.id,
        code: "MOTION_TOO_DENSE_FOR_DURATION",
        severity: "warn",
        detail:
          `This shot's motion describes roughly ${beatCount} distinct action beats, but the shot is only ` +
          `${effectiveSeconds}s long — even at the fastest natural pace (about one beat per second), that ` +
          `doesn't leave enough time for every beat to actually complete on screen, which is exactly how an ` +
          `action ends up reading as never finishing. Either cut the motion down to what ${effectiveSeconds}s ` +
          `can really hold, or extend the shot's duration to match how much it describes.`,
        autofixed: false,
      });
    }

    // ── R7.6c · ACTION DURATION vs ACTION POSE LIBRARY ──────────────────────
    // A DIFFERENT reference than R7.6 just above. R7.6 estimates a GENERIC
    // beats-per-second budget for whatever this shot's own prose describes;
    // this checks the shot's duration against a REAL per-action reference
    // (lib/actionLibrary.ts's ACTION_POSE_LIBRARY) for the SPECIFIC action
    // this shot matches, when one exists — "grounding shot generation in a
    // library instead of letting every action be reinvented per shot,"
    // extending the same two-endpoint discipline R4 already applies to
    // every shot's startFrame/endFrame. Matches via the SAME CORE_ACTION_
    // LIBRARY patterns the WORLD-STATE ACTION PRECONDITION/EFFECT block
    // below already matches shot text against (first-match-wins, identical
    // semantics) — not a second, independently-drifting detector. Only
    // fires when a match exists AND that matched action has a pose-library
    // entry (most CORE_ACTION_LIBRARY entries have no useful universal
    // duration to assert — see ACTION_POSE_LIBRARY's own comment for which
    // ones do). Fuzzy, WARN-only: a real action can legitimately run longer
    // than "typical" for a deliberate, savored beat — this flags, it never
    // blocks.
    {
      let matchedLabel: string | null = null;
      for (const rule of CORE_ACTION_LIBRARY) {
        if (rule.pattern && rule.pattern.test(authoredMotion)) { matchedLabel = rule.label; break; }
      }
      const pose = matchedLabel ? findActionPose(matchedLabel) : undefined;
      if (pose && effectiveSeconds > 0) {
        const [lo, hi] = pose.typicalDurationSec;
        // Only flag a real MISS, not a near-miss — 40% slack on the low end
        // (a shot can legitimately be a bit brisker).
        if (effectiveSeconds < lo * 0.6) {
          issues.push({
            shotId: s.id,
            code: "ACTION_DURATION_OFF_LIBRARY",
            severity: "warn",
            detail:
              `This shot matches the "${pose.label}" action, which realistically needs ${lo}-${hi}s to read as ` +
              `physically performed, not rushed — this shot is only ${effectiveSeconds}s. Extend the duration, ` +
              `or if the beat is meant to feel abrupt/rushed on purpose, keep it but expect the render to look ` +
              `hurried rather than natural.`,
            autofixed: false,
          });
        }
        // ── HIGH END — CONFIRMED REAL GAP, FIXED (action loops/reverses on
        // camera: lifts the object, puts it back, lifts it again). The
        // comment this replaced assumed a shot running long for its action
        // was "already covered" by R7.6 (MOTION_TOO_DENSE_FOR_DURATION) —
        // false: R7.6 only fires when beatCount > effectiveSeconds, i.e. too
        // MANY beats for too little time. A single-beat library action (pick
        // up an object, hi=2s) padded out to Seedance's hard 4s render floor
        // (R5's duration clamp further below, `Math.max(want, 4)`) has
        // beatCount=1, effectiveSeconds=4 — 1 > 4 is false, so R7.6 stays
        // silent. Nothing else fills that leftover time, and 5-videos.ts
        // appends "continuous motion throughout — the subject never freezes
        // or holds a pose" to EVERY shot unconditionally — actively banning
        // the one behavior (holding the completed pose) that would absorb
        // the excess cleanly, leaving loop/reverse as one of the few ways
        // left for the model to keep showing motion for the full clip.
        // Fix: deterministically autofilled, not just flagged — same
        // "compiler writes a defensibly correct answer itself" discipline as
        // ENTRANCE_ENDPOINTS_AUTOFILLED (Gap G, above) and the pose library's
        // own `endPose` field (previously dead data — read here for the
        // first time anywhere in the codebase). Appends an explicit HOLD
        // instruction naming the action's own real completed pose; see
        // authoredOnly()'s matching strip (idempotent on recompile, same
        // convention as MOVING DIRECTION:/PROP PERSISTENCE:) and 5-videos.ts
        // (skips the contradicting "never holds a pose" sentence when this
        // marker is present). 1.5s margin, not `> hi`: chosen so an action
        // whose own top-of-range already sits near the render floor (e.g.
        // "open the door", hi=2.5, on a 4s shot) still trips it, while a
        // longer-range action (e.g. "embrace", hi=4) at the same 4s floor
        // does not — mirrors the 0.6 slack factor above in spirit (real
        // margin, not a hair-trigger on the boundary itself).
        const EXCESS_MARGIN_SEC = 1.5;
        if (effectiveSeconds - hi >= EXCESS_MARGIN_SEC && !s.motion.includes("HOLD AFTER COMPLETING:")) {
          const excess = (effectiveSeconds - hi).toFixed(1);
          s.motion =
            `${s.motion} HOLD AFTER COMPLETING: once ${pose.endPose} hold that exact completed position for ` +
            `the rest of this shot, with only small natural idle motion — a breath, a slight weight shift, a ` +
            `blink — never a repeat of the action. Do NOT reverse, undo, redo, or repeat this action, and do ` +
            `NOT return the hand or object to where it started.`.trim();
          issues.push({
            shotId: s.id,
            code: "ACTION_DURATION_EXCESS_LIBRARY",
            severity: "warn",
            detail:
              `This shot matches the "${pose.label}" action (realistically ${lo}-${hi}s), but renders for ` +
              `${effectiveSeconds}s — ${excess}s longer than the action needs, most likely because Seedance's ` +
              `render floor forces at least 4s even for a quick, discrete action. Left alone, the model has ` +
              `${excess}s of dead time and an explicit instruction (this pipeline's own "continuous motion ` +
              `throughout, never holds a pose") telling it NOT to just sit still, which is how a quick pick-up/ ` +
              `put-down ends up looping. Auto-appended a HOLD instruction naming the action's own completed end ` +
              `pose, so the extra time reads as a natural pause instead of a repeated gesture.`,
            autofixed: true,
          });
        }
      }
    }

    // ── R7.6b · DIALOGUE TIMING vs DURATION (Priority 3 — lip-sync plausibility) ──
    // TRUE lip-sync validation (matching generated mouth shapes to real
    // phonemes) is not achievable here, and this is stated honestly rather
    // than faked: Seedance's generate_audio is a black box with no
    // phoneme/word-timing data exposed at all (confirmed — see util.ts's
    // mixMusicBed() own comment: "generate_audio is a bare boolean, output
    // is one muxed file, no modular audio option exists"). What IS
    // catchable, deterministically, at compile time: whether the shot's own
    // duration gives enough time for its dialogue to be SPOKEN at a natural
    // pace at all. A line that needs more time than the shot has is a GROSS
    // mismatch, not a frame-perfect sync question — either the mouth has to
    // move at an unnaturally fast, robotic clip, or the line visibly never
    // finishes. ~3.3 words/second is a fast-but-still-natural spoken pace —
    // same "fastest possible, not average" asymmetric-confidence discipline
    // MOTION_TOO_DENSE_FOR_DURATION just above already uses, so this only
    // fires on a real, gross mismatch, never an ordinary line at a normal pace.
    if (s.dialogue?.trim()) {
      const dialogueWordCount = (s.dialogue.match(/\b[\w'-]+\b/g) ?? []).length;
      const WORDS_PER_SECOND_FAST = 3.3;
      const minSecondsNeeded = dialogueWordCount / WORDS_PER_SECOND_FAST;
      const effectiveDialogueSeconds = s.screenSeconds > 0 ? s.screenSeconds : s.duration;
      if (dialogueWordCount > 0 && effectiveDialogueSeconds > 0 && minSecondsNeeded > effectiveDialogueSeconds) {
        issues.push({
          shotId: s.id,
          code: "DIALOGUE_TIMING_MISMATCH",
          severity: "warn",
          detail:
            `This shot's dialogue is ${dialogueWordCount} words, which needs at least ${minSecondsNeeded.toFixed(1)}s ` +
            `to speak even at a fast natural pace, but the shot is only ${effectiveDialogueSeconds}s long — the ` +
            `line will either get visibly cut off or force an unnaturally fast delivery that won't read as real ` +
            `speech. Either shorten the line to fit ${effectiveDialogueSeconds}s, or extend the shot's duration ` +
            `to give it room.`,
          autofixed: false,
        });
      }
    }

    // ── R7.7 · DOMAIN/STAGING PLAUSIBILITY (Gap B) ──────────────────────────
    // TEXT-LEVEL ONLY, deliberately — this catches a shot's OWN words
    // contradicting themselves, not a render inserting a vehicle the script
    // never mentioned at all (that's a render-execution failure, outside
    // what a text-level compiler check can catch; the real lever there is
    // post-render QA, not this). See lib/stagingLibrary.ts's own comment for
    // the full picture: CORE_STAGING_LIBRARY first (deterministic, matches
    // this scene's setting against known domain patterns), falling through
    // to the (durably cached) generative-inference result for a scene whose
    // domain the core library doesn't recognize — same hybrid shape as the
    // action-precondition system, not a new pattern.
    {
      const locText = `${authoredOnly(s.setting)} ${authoredOnly(s.description)} ${authoredOnly(s.motion)}`;
      let matchedRule: StagingRule | null = null;
      for (const rule of CORE_STAGING_LIBRARY) {
        if (rule.pattern && rule.pattern.test(locText)) {
          matchedRule = rule;
          break;
        }
      }
      const sKey = sceneKey(s);
      if (!matchedRule) {
        matchedRule = stagingInferenceCache.get(sKey) ?? null;
      }
      if (matchedRule) {
        const violated = checkStaging(locText, matchedRule);
        if (violated) {
          issues.push({
            shotId: s.id,
            code: "STAGING_RULE_VIOLATION",
            severity: "warn",
            detail:
              `This shot's own text contradicts an established staging rule for "${matchedRule.label}": ` +
              `${violated} This is a real self-contradiction in the shot's own wording, not just an ` +
              `unfortunate render — fix the text so it no longer disagrees with itself.`,
            autofixed: false,
          });
        }
      } else {
        // Genuinely unrecognized domain/setting. Queue for async inference,
        // once per distinct scene (staging is a scene-level fact) — only
        // for a setting substantial enough to plausibly imply a real
        // location/domain, so an empty or one-word setting doesn't burn an
        // inference call on nothing.
        const settingWords = (authoredOnly(s.setting).match(/\b\w+\b/g) ?? []).length;
        if (settingWords >= 4 && !seenStagingKeys.has(sKey)) {
          seenStagingKeys.add(sKey);
          pendingStagingInferences.push({
            key: sKey,
            sceneText: `${authoredOnly(s.setting)}. ${authoredOnly(s.description)}`.trim(),
          });
        }
      }

      // ── STAGING RULE VIOLATION — SCENE-WIDE (Priority 12) ─────────────────
      // Everything above only ever checks ONE shot's own combined text against
      // itself. This extends the SAME rule (core or inferred — matchedRule,
      // resolved above) across the WHOLE scene run: once a rule's trigger
      // phrase is established by ANY shot in a sameScene() run, every LATER
      // shot in that run is checked against its contradicts phrase too — a
      // vehicle rendered on a footpath a much EARLIER shot in the scene
      // established as pedestrian-only, with this shot's own text never
      // repeating "pedestrian-only" itself, is exactly the confirmed real gap
      // this closes. A separate issue code (not STAGING_RULE_VIOLATION above)
      // so it's clear from the flag alone which shot ACTUALLY wrote the
      // contradicting phrase versus which shot merely inherited the
      // constraint from an earlier one in the same scene.
      const loc = getOrCreateLocation(worldState, s, sameScene);
      if (matchedRule && matchedRule.trigger.test(locText) && !loc.staging.has(matchedRule.label)) {
        loc.staging.set(matchedRule.label, { rule: matchedRule, shotId: s.id });
      }
      for (const [label, known] of loc.staging) {
        if (known.shotId === s.id) continue; // established BY this shot — same-shot check above already covers it
        if (matchedRule?.label === label && checkStaging(locText, matchedRule)) continue; // already reported above, don't double-flag
        if (known.rule.contradicts.test(locText) && !known.rule.permits?.test(locText)) {
          issues.push({
            shotId: s.id,
            code: "STAGING_RULE_VIOLATION_SCENE_WIDE",
            severity: "warn",
            detail:
              `This shot contradicts a staging rule for "${label}" that shot "${known.shotId}" established ` +
              `earlier in this SAME scene — not by repeating the rule's own trigger phrase here, but simply by ` +
              `containing the contradicting action. ${known.rule.facts.map((f) => f.description).join(" ")} Either ` +
              `keep this shot's staging consistent with what "${known.shotId}" already established for this ` +
              `scene, or make the change explicit (why the constraint no longer applies here).`,
            autofixed: false,
          });
        }
      }
    }

    // ── DOMAIN-SCOPED: CRICKET ROLE-ACTION CONSISTENCY ──────────────────────
    // Confirmed real, twice: a bowler was described performing an action
    // that narratively belongs only to the batsman (swinging at the ball),
    // and separately a bowler was shown holding a bat at all — equipment
    // and actions that belong EXCLUSIVELY to whichever character the script
    // has already established as the batsman. Domain-scoped (cricket only,
    // gated on bd.domainPack?.key) rather than a new general-purpose
    // system: "role-appropriate action" has no meaningful GENERIC
    // definition across every possible script domain the way spatial
    // preconditions (actionLibrary.ts) do — this is real-world cricket
    // knowledge, not a general physics/spatial rule, so it lives here as a
    // domain-specific text pattern rather than an invented abstraction.
    // Attribution: prefers characterActions (per-character attributed text,
    // see types.ts) when available — cricket scenes are almost always
    // 2-character (bowler + batsman) — falling back to solo-shot-only text
    // when it isn't, same attribution-confidence discipline as every other
    // per-character check in this file.
    if (bd.domainPack?.key === "cricket") {
      const BATSMAN_ACTION_RE = /\bswings?\s+(?:his|her|their)?\s*bat\b|\bstrikes?\s+the\s+ball\b|\bhits?\s+the\s+ball\b/i;
      const BOWLER_ACTION_RE = /\bbowls?\s+the\s+ball\b|\bdelivers?\s+the\s+ball\b|\breleas(?:es?|ing)\s+the\s+(?:red|white)?\s*(?:leather\s+)?(?:cricket\s+)?ball\b/i;
      const HOLDS_BAT_RE = /\b(?:holding|holds?|carries|carrying|carried)\s+(?:the|a|an|his|her|their)\s+bat\b/i;

      const attributedForRole = (s.characterActions ?? []).filter(
        (ca) => s.characters.includes(ca.characterId) && authoredOnly(ca.action).trim()
      );
      const perCharacterTexts: { charId: string; text: string }[] = attributedForRole.length
        ? attributedForRole.map((ca) => ({ charId: ca.characterId, text: authoredOnly(ca.action) }))
        : s.characters.length === 1
        ? [{ charId: s.characters[0], text: `${authoredOnly(s.motion)} ${authoredOnly(s.description)}` }]
        : [];

      for (const { charId, text } of perCharacterTexts) {
        const existingRole = cricketRoles.get(charId);
        const thisAction: "batsman" | "bowler" | null = BATSMAN_ACTION_RE.test(text)
          ? "batsman"
          : BOWLER_ACTION_RE.test(text)
          ? "bowler"
          : null;

        if (thisAction && existingRole && existingRole !== thisAction) {
          issues.push({
            shotId: s.id,
            code: "CRICKET_ROLE_ACTION_MISMATCH",
            severity: "warn",
            detail:
              `"${charId}" was already established as the ${existingRole} earlier in the film, but this shot ` +
              `describes them performing a ${thisAction}-only action. In cricket, the batsman and bowler are ` +
              `always two different people — reattribute this action to the character actually established as ` +
              `the ${thisAction}, or correct the earlier shot if "${charId}" was misidentified there.`,
            autofixed: false,
          });
        } else if (thisAction && !existingRole) {
          cricketRoles.set(charId, thisAction);
        }

        if (HOLDS_BAT_RE.test(text) && existingRole === "bowler") {
          issues.push({
            shotId: s.id,
            code: "CRICKET_ROLE_ACTION_MISMATCH",
            severity: "warn",
            detail:
              `"${charId}" was already established as the bowler earlier in the film, but this shot describes ` +
              `them holding a bat — only the batsman ever carries a bat; a bowler's equipment ends at the ball.`,
            autofixed: false,
          });
        }
      }

      // MULTI-CHARACTER, UNATTRIBUTED FALLBACK — same Finding-A-shaped gap
      // this file has repeatedly found and closed elsewhere: no attribution
      // meant `perCharacterTexts` above was simply EMPTY for any multi-
      // character cricket shot, so the whole check silently did nothing —
      // even though the comment right above this block says cricket scenes
      // are "almost always 2-character," i.e. this WAS the dominant real
      // case, not an edge case. Can't say WHO performed the action among 2+
      // people without attribution, so this stays deliberately conservative
      // (same zero-candidates discipline as Migration Step 5's inferred-
      // shared fallback): only flags when EVERY present character's already-
      // established role rules them out entirely — nobody present could
      // validly be doing what the text describes — never guesses which one.
      if (!attributedForRole.length && s.characters.length > 1) {
        const wholeText = `${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;
        const knownRoles = s.characters
          .map((id) => cricketRoles.get(id))
          .filter((r): r is "batsman" | "bowler" => !!r);

        const thisAction: "batsman" | "bowler" | null = BATSMAN_ACTION_RE.test(wholeText)
          ? "batsman"
          : BOWLER_ACTION_RE.test(wholeText)
          ? "bowler"
          : null;
        if (thisAction && knownRoles.length === s.characters.length && knownRoles.every((r) => r !== thisAction)) {
          issues.push({
            shotId: s.id,
            code: "CRICKET_ROLE_ACTION_MISMATCH",
            severity: "warn",
            detail:
              `This shot's own text describes a ${thisAction}-only action, but every character present ` +
              `(${s.characters.join(", ")}) was already established as the OPPOSITE role earlier in the film — ` +
              `nobody present could validly be doing this. Unattributed since this shot has ${s.characters.length} ` +
              `people and no characterActions attribution says who specifically. Either attribute this action to ` +
              `a specific character so it can be checked precisely, or correct whichever earlier shot ` +
              `established these roles.`,
            autofixed: false,
          });
        }

        if (HOLDS_BAT_RE.test(wholeText) && knownRoles.length === s.characters.length && knownRoles.every((r) => r === "bowler")) {
          issues.push({
            shotId: s.id,
            code: "CRICKET_ROLE_ACTION_MISMATCH",
            severity: "warn",
            detail:
              `This shot's own text describes someone holding a bat, but every character present ` +
              `(${s.characters.join(", ")}) was already established as the bowler earlier in the film — a ` +
              `bowler's equipment ends at the ball, so nobody present could validly be holding one. Unattributed ` +
              `since this shot has ${s.characters.length} people and no characterActions attribution says who.`,
            autofixed: false,
          });
        }
      }
    }

    // ── DIRECTIONAL MOTION REASSERTION (positive side) ──────────────────────
    // See DIRECTION_LABEL/DIRECTION_NEGATIVE (Gap D) just above negativeFor()
    // for the negative-side reassertion, applied below via s.negativePrompt.
    // This is the positive counterpart, injected directly into the motion
    // text itself — the same "state it twice, once as instruction and once
    // as prohibition" belt-and-suspenders pattern this file already uses for
    // ground contact / emotional continuity. Idempotence marker checked on
    // the RAW field (same discipline as every other injected reminder in
    // this file), since authoredOnly() may strip it for other comparisons.
    if (s.motionDirection && !s.motion.includes("MOVING DIRECTION:")) {
      s.motion = `${s.motion} MOVING DIRECTION: this motion moves ${DIRECTION_LABEL[s.motionDirection]} — unmistakably, not the reverse.`.trim();
    }

    // ── GAP A · PROP APPEARANCE/INTRODUCTION/PERSISTENCE ────────────────────
    // Structured, using Breakdown.props/Shot.props (see types.ts's PropSchema)
    // rather than free-text guessing — the same structural upgrade
    // characters already got over plain name strings. Two distinct checks:
    if (s.props?.length) {
      const sKey = sceneKey(s);
      let establishedThisScene = propsEstablishedByScene.get(sKey);
      if (!establishedThisScene) {
        establishedThisScene = new Set();
        propsEstablishedByScene.set(sKey, establishedThisScene);
      }
      const introText = `${authoredOnly(s.startFrame)} ${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;

      for (const propId of s.props) {
        const prop = bd.props?.find((p) => p.id === propId);
        // (1) INTRODUCTION: a prop appearing with no earlier shot in THIS
        // scene establishing it, and no introduction action (picked up,
        // unwrapped, revealed, etc.) shown here either. A prop's absolute
        // FIRST mention anywhere in the whole film is exempt — same
        // baseline-world-state reasoning seenCharacters uses above; once
        // established anywhere in THIS scene, later shots of the same
        // scene referencing it again don't need re-justifying.
        if (!establishedThisScene.has(propId)) {
          const isFirstEverMention = !seenProps.has(propId);
          if (!isFirstEverMention && !PROP_ACQUISITION_RE.test(introText)) {
            issues.push({
              shotId: s.id,
              code: "PROP_APPEARS_WITHOUT_INTRODUCTION",
              severity: "warn",
              detail:
                `The prop "${prop?.name ?? propId}" appears in this shot with no earlier shot in this scene ` +
                `establishing it, and no introduction action (picked up, unwrapped, revealed, or similar) ` +
                `shown here either. Either show it being introduced, or confirm an earlier shot in this scene ` +
                `already established it.`,
              autofixed: false,
            });
          }
          establishedThisScene.add(propId);
        }

        // (2) WITHIN-SHOT PERSISTENCE: an object present at shot START with
        // no scripted removal/handoff must still be present at shot END —
        // catches the vanishing-mid-clip case. Only meaningful when this
        // shot actually HAS two authored endpoints (a single i2v keyframe
        // has no separate "end state" text to compare against) — real,
        // stated scope limit, not an oversight.
        if (prop && hasStart && hasEnd) {
          const bareName = prop.name.replace(/^the\s+/i, "").trim();
          const nameRe = new RegExp(`\\b${bareName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
          const inStart = nameRe.test(s.startFrame);
          const inEnd = nameRe.test(s.endFrame);
          const removalText = `${authoredOnly(s.motion)} ${authoredOnly(s.description)} ${authoredOnly(s.endFrame)}`;
          if (inStart && !inEnd && !PROP_REMOVAL_RE.test(removalText)) {
            issues.push({
              shotId: s.id,
              code: "PROP_VANISHED_WITHIN_SHOT",
              severity: "warn",
              detail:
                `The prop "${prop.name}" is present in this shot's startFrame but absent from its endFrame, ` +
                `with nothing in the shot's own text showing it being set down, handed off, thrown, or ` +
                `otherwise leaving — an object present at the start of a shot must still be accounted for at ` +
                `the end. Either keep it visible through endFrame, or add text showing why it's gone.`,
              autofixed: false,
            });
          }
        }
      }

      // (3) PERSISTENCE REINFORCEMENT, REGARDLESS OF i2v/flf — confirmed real:
      // a book present at a shot's START vanished by its END in exactly an
      // i2v (single-keyframe) shot, which check (2) above can never validate
      // — there is no separate endFrame text to compare against at all when
      // only one keyframe exists. Same "state it as a positive instruction
      // since there's nothing deterministic to verify against" pattern
      // MOVING DIRECTION: (Gap D) already uses for exactly this reason —
      // this doesn't replace check (2), it covers the i2v gap (2) cannot.
      // Idempotence marker checked on the RAW field (same discipline as
      // every other injected reminder in this file); stripped by
      // authoredOnly() below so it never pollutes word/beat-count checks.
      const trackedNames = s.props.map((id) => bd.props?.find((p) => p.id === id)?.name).filter((n): n is string => !!n);
      if (trackedNames.length && !s.motion.includes("PROP PERSISTENCE:")) {
        const verb = trackedNames.length === 1 ? "remains" : "remain";
        const pronoun = trackedNames.length === 1 ? "it does" : "they do";
        s.motion =
          `${s.motion} PROP PERSISTENCE: ${trackedNames.join(" and ")} ${verb} visible and physically ` +
          `unchanged throughout this ENTIRE shot, first frame to last — ${pronoun} not disappear, move on ` +
          `its own, or change appearance at any point unless explicitly shown being set down, handed off, or ` +
          `otherwise removed.`.trim();
      }
    }

    // ── R8 · NEGATIVES ──────────────────────────────────────────────────────
    s.negativePrompt = negativeFor(s, bd.domainPack?.negatives);

    // ── R9 · THE CONTINUITY CHAIN ───────────────────────────────────────────
    // The #1 remaining quality gap: every shot was staged in ISOLATION, so the
    // world quietly reset between cuts — new stonework, new light, the character
    // back where he started. The rule: if two consecutive shots share the scene
    // and a character, shot N+1 OPENS in the exact state shot N CLOSED in. We
    // enforce that here in TEXT (and step 4 enforces it again in PIXELS by
    // feeding the previous shot's final keyframe in as a reference image).
    if (
      prevShot &&
      sameScene(prevShot, s) &&
      prevShot.characters.some((id) => s.characters.includes(id))
    ) {
      const prevEnd = distillEndState(prevShot);
      if (prevEnd) {
        // OBJECT PERMANENCE — llm.ts's own "OBJECT PERMANENCE ACROSS A
        // CONTINUITY CHAIN" section: an object established in a character's
        // hand carries forward into the NEXT chained shot exactly like their
        // face does. Real cited failure: car keys held while starting the
        // car became a phone in the very next shot, with no moment showing
        // the keys set down and a phone picked up. This chain already
        // carries forward location/lighting/wardrobe state; extend the SAME
        // clause to the one class of drift it didn't yet track. Fuzzy
        // (natural-language object extraction), so this only adds a
        // reminder — never blocks — and only when the next shot neither
        // repeats the SAME object nor shows any hand-off/put-down at all.
        const heldMatch = `${authoredOnly(prevShot.endFrame)} ${authoredOnly(prevShot.motion)} ${authoredOnly(prevShot.description)}`.match(
          HELD_OBJECT_RE,
        );
        let objectClause = "";
        if (heldMatch) {
          const obj = heldMatch[1].trim();
          const nextText = `${authoredOnly(s.description)} ${authoredOnly(s.motion)} ${authoredOnly(s.startFrame)}`;
          const sameObjMentioned = new RegExp(`\\b${obj.replace(/\s+/g, "\\s+")}\\b`, "i").test(nextText);
          const handedOff = HELD_OBJECT_CLEARED_RE.test(nextText);
          if (!sameObjMentioned && !handedOff) {
            objectClause = ` Still holding the ${obj} from the previous shot, unless this shot explicitly shows it being set down, handed off, or replaced.`;
          }
        }
        const clause =
          ` CONTINUITY: this shot begins exactly where the previous shot ended — ${prevEnd} ` +
          `Same location, same lighting, same wardrobe, no time skip.${objectClause}`;
        // THE DIRECTOR MAY HAVE WRITTEN THE HANDOFF ALREADY. The prompt asks each
        // shot to open by restating the previous end state, and when it obeys,
        // appending our own mechanical clause says the same thing twice — the
        // description carried the identical beat in both the opening line and
        // the CONTINUITY note. If a handoff is already there, leave it alone.
        const ALREADY_HANDED_OFF =
          /\b(has just|had just|continuing (?:his|her|their|the)|begins exactly where|picking up (?:from|where)|still (?:mid|in))\b/i;
        const authored = s.description.slice(0, 220);
        let appended = false;
        if (!s.description.includes("CONTINUITY:") && !ALREADY_HANDED_OFF.test(authored)) {
          s.description = `${s.description}${clause}`.trim();
          appended = true;
        }
        if (s.startFrame.trim() && !s.startFrame.includes("CONTINUITY:")) {
          s.startFrame = `${s.startFrame}${clause}`.trim(); appended = true;
        }
        if (appended) issues.push({
          shotId: s.id,
          code: "CONTINUITY_CHAINED",
          severity: "warn",
          detail: "Opens exactly where the previous shot ended (end-state carried into this shot's prompt).",
          autofixed: true,
        });

        // ── MOTION REDEPICTS A CONTINUITY-COMPLETED ACTION ────────────────
        // Mirror-image of ENDFRAME_ACTION_NOT_IN_MOTION further up: THAT check
        // catches a shot's OWN endFrame claiming a completion its OWN motion
        // never showed. THIS catches the opposite direction ACROSS the shot
        // boundary the CONTINUITY clause just above establishes: s.description
        // and s.startFrame both just got prevEnd's completed action folded in
        // as this shot's OPENING state (and step 4 chains the previous shot's
        // final keyframe in as a reference image on top of that) — but
        // s.motion, the literal "Action:" instruction actually fed to the
        // video model (see 5-videos.ts's motionPrompt), is NEVER touched by
        // that injection. If the breakdown LLM's own authored motion for THIS
        // shot independently re-describes the SAME completed beat from
        // scratch — because the story action got accidentally split across a
        // shot cut instead of continued from one — the video model is told,
        // in the same prompt, "you already did this" (description/startFrame)
        // AND "Action: do this" (motion), and confirmed real evidence across
        // five separate test scripts shows it resolves that conflict by
        // literally re-performing the action: a sit-down, a hug, or a handoff
        // completes once via the seeded keyframe and then plays out AGAIN via
        // this shot's own motion. This is the single most frequently reported
        // defect across two full render rounds. Shares ENDSTATE_UNDEPICTED_
        // VERBS (module scope) with ENDFRAME_ACTION_NOT_IN_MOTION on purpose —
        // it's the same "discrete, done-or-not-done" class of beat either way.
        const completedVerbs = [
          ...new Set([...prevEnd.matchAll(ENDSTATE_UNDEPICTED_VERBS)].map((m) => m[1].toLowerCase())),
        ];
        if (completedVerbs.length && !s.motion.includes("ALREADY COMPLETE")) {
          const ownMotion = authoredOnly(s.motion);
          const redepicted = completedVerbs.filter((v) => new RegExp(`\\b${v}\\b`, "i").test(ownMotion));
          if (redepicted.length) {
            s.motion =
              `${s.motion} ALREADY COMPLETE — DO NOT RE-PERFORM: ${redepicted.join(", ")} already happened ` +
              `before this shot begins (carried in from the previous shot — see CONTINUITY above). This shot's ` +
              `action continues FROM that already-completed state; do not show ${redepicted.length === 1 ? "it" : "them"} ` +
              `happening again from the start.`.trim();
            issues.push({
              shotId: s.id,
              code: "MOTION_REDEPICTS_COMPLETED_ACTION",
              severity: "warn",
              detail:
                `This shot's own motion text describes "${redepicted.join(", ")}" as if it is about to happen, but ` +
                `the PREVIOUS shot's endFrame already completed it and R9's CONTINUITY chain carries that completed ` +
                `state into this shot's own opening (description/startFrame/keyframe) — re-performing it in motion ` +
                `duplicates the action across the cut, exactly the "sits down, then sits down again" / repeated-` +
                `handoff / repeated-embrace failure confirmed on camera across multiple test renders.`,
              autofixed: true,
            });
          }
        }

        // ── DESCRIPTION ALSO REDEPICTS A COMPLETED ACTION ───────────────────
        // Confirmed real, distinct from the motion check just above: the LLM's
        // own AUTHORED description text (checked via authoredOnly() — NEVER
        // the R9-injected CONTINUITY clause itself, which is SUPPOSED to
        // restate prevEnd, that's its entire job) can independently re-narrate
        // the same just-completed beat as if it's still happening — "he
        // presents the parcel, hand closing around it" written fresh in THIS
        // shot's own description, even though a much earlier acquisition
        // already completed it. Same ENDSTATE_UNDEPICTED_VERBS vocabulary,
        // same idempotence discipline, checked as a genuinely separate
        // trigger from motion (a shot can redepict in one field, both, or
        // neither) rather than folded into the motion branch above.
        if (completedVerbs.length && !s.description.includes("ALREADY COMPLETE")) {
          const ownDescription = authoredOnly(s.description);
          const redepictedInDescription = completedVerbs.filter((v) => new RegExp(`\\b${v}\\b`, "i").test(ownDescription));
          if (redepictedInDescription.length) {
            s.description =
              `${s.description} ALREADY COMPLETE — DO NOT RE-PERFORM: ${redepictedInDescription.join(", ")} already ` +
              `happened before this shot begins (carried in from the previous shot — see CONTINUITY above). This ` +
              `shot continues FROM that already-completed state; do not depict ` +
              `${redepictedInDescription.length === 1 ? "it" : "them"} happening again from the start.`.trim();
            issues.push({
              shotId: s.id,
              code: "MOTION_REDEPICTS_COMPLETED_ACTION",
              severity: "warn",
              detail:
                `This shot's own AUTHORED description text (not the injected CONTINUITY restatement) describes ` +
                `"${redepictedInDescription.join(", ")}" as if it is still happening, but the PREVIOUS shot's ` +
                `endFrame already completed it — re-narrating it in description duplicates the action across the ` +
                `cut just as surely as re-performing it in motion does, exactly the same "sits down, then sits ` +
                `down again" class of defect, just authored in a different field.`,
              autofixed: true,
            });
          }
        }

        // ── MISSING HANDOFF SHOT (Track B / B2) ────────────────────────────
        // Confirmed real: the previous shot's own end-state (prevEnd, just
        // used above) asserted a handoff object's NEW resting state ("coins
        // now on the counter", "package now under his arm") as already
        // having happened — but NEITHER shot's own authored text (this
        // shot's or the previous shot's own motion/description) ever
        // depicted the actual transfer action (a hand giving, another hand
        // receiving) taking place AT ALL. The object simply teleported into
        // its new state via a continuity assertion, with no real shot ever
        // instructing the video model to show it moving — the entire
        // "shopkeeper hands him the package" beat the script described was
        // compressed into this one continuity phrase instead of getting its
        // own shot. DIFFERENT from MOTION_REDEPICTS_COMPLETED_ACTION just
        // above (which is about the SAME action being shown TWICE) — this
        // is about it never being shown even ONCE. The "now" requirement
        // (an object noun near the word "now") is deliberately narrow: it is
        // what actually distinguishes "the coins JUST changed hands" from a
        // continuity clause merely restating an object's UNCHANGED, already-
        // established state ("he still holds the package") — ordinary
        // continued possession is not this defect and must not be flagged.
        const HANDOFF_STATE_NOUN = "(?:coins?|money|cash|parcel|package|wallet|purse|keys?|tickets?|envelopes?|letters?|boxes?|gifts?)";
        const HANDOFF_JUST_CHANGED =
          new RegExp(`\\b${HANDOFF_STATE_NOUN}\\b[^.]{0,20}\\bnow\\b|\\bnow\\b[^.]{0,20}\\b${HANDOFF_STATE_NOUN}\\b`, "i");
        // HANDOFF_TRANSFER_VERB is now module-scope (see its own comment) —
        // shared with the standalone MISSING_HANDOFF_SHOT block below.

        // SECOND TRIGGER — HOLDER-AWARE, generalizing past the "now" requirement
        // above. Confirmed real gap: a handoff can be asserted as a new resting
        // state with no "now" anywhere near it at all — "Daniel's hand holds the
        // letter" reads as an ordinary possession statement, not a JUST-changed
        // one, so HANDOFF_JUST_CHANGED never fires on it — while worldState
        // (Migration Step 1's own heldByCharacter relocation) still tracks a
        // DIFFERENT character as that object's holder from several shots earlier.
        // That disagreement between what prevEnd claims and what worldState
        // already knows IS the signal, independent of phrasing — reusing the
        // SAME "what counts as holding something" vocabulary WORLD_STATE_PROP_
        // CARRY already imports from worldState.ts, not a new detector.
        const possessionMatch =
          prevEnd.match(HELD_OBJECT_ESTABLISH_RE) ?? prevEnd.match(PASSIVE_CARRY_RE) ?? prevEnd.match(OBJECT_ALREADY_HELD_RE) ?? prevEnd.match(HELD_OBJECT_RE);
        let holderMismatchObj: string | null = null;
        let holderMismatchOldHolderName = "";
        let holderMismatchNewHolderName = "";
        if (possessionMatch) {
          const obj = possessionMatch[1].trim();
          const objRe = new RegExp(`\\b${obj.replace(/\s+/g, "\\s+")}\\b`, "i");
          const trackedHolderId = s.characters.find(
            (id) => getHolding(worldState, id)?.toLowerCase() === obj.toLowerCase(),
          );
          if (trackedHolderId && objRe.test(prevEnd)) {
            const claimantId = s.characters.find((id) => {
              if (id === trackedHolderId) return false;
              const name = characters.find((c) => c.id === id)?.name;
              if (!name) return false;
              const first = name.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              return new RegExp(`\\b${first}\\b`, "i").test(prevEnd);
            });
            if (claimantId) {
              holderMismatchObj = obj;
              holderMismatchOldHolderName = characters.find((c) => c.id === trackedHolderId)?.name ?? trackedHolderId;
              holderMismatchNewHolderName = characters.find((c) => c.id === claimantId)?.name ?? claimantId;
            }
          }
        }

        if (HANDOFF_JUST_CHANGED.test(prevEnd) || holderMismatchObj) {
          const bothShotsOwnText =
            `${authoredOnly(prevShot.motion)} ${authoredOnly(prevShot.description)} ${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;
          if (!HANDOFF_TRANSFER_VERB.test(bothShotsOwnText)) {
            const trigger = holderMismatchObj
              ? `${holderMismatchNewHolderName} is now described holding "${holderMismatchObj}", which was tracked as ${holderMismatchOldHolderName}'s`
              : `an object just changed hands or location ("${prevEnd.match(HANDOFF_JUST_CHANGED)?.[0]}")`;
            issues.push({
              shotId: s.id,
              code: "MISSING_HANDOFF_SHOT",
              severity: "warn",
              detail:
                `The previous shot's own end-state asserts ${trigger} but neither that shot nor this one ever ` +
                `actually DEPICTS the transfer — no hand giving, no hand receiving, anywhere in either shot's own ` +
                `authored text. The handoff was compressed into a continuity assertion instead of getting its own ` +
                `real shot, leaving the renderer nothing to draw the actual transfer action from. Add a dedicated ` +
                `shot between these two (or extend one of them) that actually shows the object changing hands.`,
              autofixed: false,
            });
          }
        }
      }
    }

    // ── MISSING HANDOFF SHOT, NO SHARED CHARACTER (E3.pdf, "The Package 3") ──
    // R9 just above (and everything nested inside it, including MISSING_
    // HANDOFF_SHOT's other two triggers) is gated on prevShot and s sharing
    // AT LEAST ONE character — CONFIRMED, by direct testing, to be exactly
    // why the real failing case never got caught by that code: a shot with
    // ONLY Arjun holding the package, immediately followed by a shot with
    // ONLY Mira and the package, shares ZERO characters, so R9's block never
    // even runs. That's precisely the shape of a full cast swap with an
    // object silently following — the case most worth catching, not an edge
    // case to exclude. Independent block, no shared-character requirement,
    // same scene only. Matches by the object's BARE NAME reappearing rather
    // than a possession verb — a first attempt here required an explicit
    // holding verb (HELD_OBJECT_ESTABLISH_RE/PASSIVE_CARRY_RE) and never
    // fired on the real E3.pdf text, because real breakdown text
    // overwhelmingly describes a prop's new resting place with plain
    // proximity language ("wrapped package in front of her") rather than a
    // holding verb.
    if (prevShot && sameScene(prevShot, s) && s.characters.length > 0) {
      const ownPossessionText = `${authoredOnly(s.startFrame)} ${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;
      for (const heldCharId of prevShot.characters) {
        if (s.characters.includes(heldCharId)) continue; // the tracked holder is still present -- not a reassignment
        const held = getHolding(worldState, heldCharId);
        if (!held) continue;
        const bareName = held.replace(/^(?:the|a|an)\s+/i, "").trim();
        if (!bareName) continue;
        const nameRe = new RegExp(`\\b${bareName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i");
        if (!nameRe.test(ownPossessionText)) continue;
        const bothShotsOwnText =
          `${authoredOnly(prevShot.motion)} ${authoredOnly(prevShot.description)} ${ownPossessionText}`;
        if (HANDOFF_TRANSFER_VERB.test(bothShotsOwnText)) continue;
        const priorName = characters.find((c) => c.id === heldCharId)?.name ?? heldCharId;
        const newHolderNames = s.characters.map((id) => characters.find((c) => c.id === id)?.name ?? id).join(" and ");
        issues.push({
          shotId: s.id,
          code: "MISSING_HANDOFF_SHOT",
          severity: "warn",
          detail:
            `This shot's own text mentions "${held}" again, now in ${newHolderNames}'s scene, but the previous ` +
            `shot ("${prevShot.id}") had ${priorName} holding it — and ${priorName} isn't even present in this ` +
            `shot to have handed it over on-screen. Neither shot depicts the actual transfer (no hand giving, no ` +
            `hand receiving). Add a dedicated shot showing the object actually changing hands, or keep ` +
            `${priorName} present in this shot if they're the one bringing it.`,
          autofixed: false,
        });
        break;
      }
    }

    // ── WORLD-STATE PROP CARRY — extends R9 across scene boundaries ────────
    // R9 just above only fires within ONE scene run (sameScene(prevShot, s))
    // — the moment a scene changes, or a character's own shots are separated
    // by an intervening shot of someone else, that mechanism goes silent. A
    // character who picked up a parcel in a market scene and reappears in a
    // NEW street scene two shots later has nothing tracking that they should
    // still be carrying it. worldState (declared before this loop) is
    // that persistent fix, checked here for every shot regardless of scene.
    for (const charId of s.characters) {
      const carrying = getHolding(worldState, charId);
      if (!carrying) continue;
      // R9 above already reminded this exact case (same character, same
      // scene, immediately adjacent shot) — skip so it isn't reminded twice
      // in two different clauses on the same shot.
      if (prevShot && sameScene(prevShot, s) && prevShot.characters.includes(charId)) continue;
      // IDEMPOTENCE, checked on the RAW field, not authoredOnly(s.motion) —
      // authoredOnly() deliberately STRIPS this exact reminder sentence (see
      // WORLD_STATE_CARRY_RE) so a later richness/extraction comparison
      // elsewhere doesn't mistake it for genuine authored content. That is
      // correct for THOSE comparisons but wrong for this one: checking
      // "already reminded" against text that has the reminder stripped out
      // by construction always reads as "not yet reminded" and re-injects a
      // second copy on every recompile — confirmed happening before this
      // plain string check was added. Same fix R9 above already uses for its
      // own idempotence (s.description.includes("CONTINUITY:")): a direct
      // substring check on the raw field, not a stripped one.
      if (s.motion.includes("Still carrying the ")) continue;
      const ownText = `${authoredOnly(s.description)} ${authoredOnly(s.motion)} ${authoredOnly(s.startFrame)}`;
      const stillMentioned = new RegExp(`\\b${carrying.replace(/\s+/g, "\\s+")}\\b`, "i").test(ownText);
      if (stillMentioned || HELD_OBJECT_CLEARED_RE.test(ownText)) continue;
      s.motion =
        `${s.motion} Still carrying the ${carrying} established earlier in the film, unless this shot ` +
        `explicitly shows it being set down, handed off, or replaced.`.trim();
      issues.push({
        shotId: s.id,
        code: "WORLD_STATE_PROP_CARRY",
        severity: "warn",
        detail:
          `"${charId}" was established carrying "${carrying}" earlier in the film — a different scene, or a ` +
          `non-adjacent shot, so R9's own same-scene continuity clause never covers this case — and this shot ` +
          `neither mentions it nor shows it being set down or handed off. Reminded so it doesn't silently vanish ` +
          `across the cut.`,
        autofixed: true,
      });
    }
    // Update the map from THIS shot's own final text — must run AFTER every
    // other mutation to s above (including the reminder just injected), so
    // it reads the settled prose, not a pre-injection snapshot.
    // CLEARING runs for every shot, any number of characters: a clearing verb
    // anywhere in the text is treated the same low-precision way R9's own
    // handedOff check already does (this file's established level of
    // confidence for this signal, not a new, unproven one).
    // ESTABLISHING a new hold is deliberately restricted to SOLO shots only
    // — attributing "who, of two or more people in this frame, is the one
    // now holding it" from a bare regex match is not reliable enough to
    // trust; a solo shot has no such ambiguity. This means a hold FIRST
    // established during a multi-character handoff shot isn't picked up
    // here — R9's own same-scene clause and the separate GIVES/TAKES-based
    // handoffSeen tracking (narrative pass, below) already cover THAT
    // specific moment; this map's job is the LATER, non-adjacent reappearance.
    for (const charId of s.characters) {
      const ownText = `${authoredOnly(s.endFrame)} ${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;
      if (getHolding(worldState, charId) !== null && HELD_OBJECT_CLEARED_RE.test(ownText)) {
        setHolding(worldState, charId, null);
        continue;
      }
      if (s.characters.length === 1) {
        const m = ownText.match(HELD_OBJECT_ESTABLISH_RE) ?? ownText.match(PASSIVE_CARRY_RE) ?? ownText.match(OBJECT_ALREADY_HELD_RE);
        if (m) {
          const obj = m[1].trim();
          // ── WORLD-STATE PROP INTRODUCED WITHOUT ORIGIN ──────────────────
          // Inverse of this whole map's usual job: that guards a prop
          // silently DISAPPEARING once established (further below); nothing
          // previously guarded the other direction — a prop APPEARING in a
          // character's hand with no earlier shot ever showing them acquire
          // it, and no acquisition verb in THIS shot either. Confirmed real:
          // a phone appeared in a character's hand mid-film with no prior
          // shot establishing it and no on-screen pickup. Solo shots only,
          // same attribution-confidence reason as ESTABLISHING itself (see
          // the comment above this block) — a bare regex match on
          // multi-character text can't reliably say WHICH person is now
          // holding something.
          const alreadyTracked = getHolding(worldState, charId);
          const isNewObject = !alreadyTracked || alreadyTracked.toLowerCase() !== obj.toLowerCase();
          if (isNewObject && seenCharacters.has(charId) && !PROP_ACQUISITION_RE.test(ownText)) {
            issues.push({
              shotId: s.id,
              code: "WORLD_STATE_PROP_NO_ORIGIN",
              severity: "warn",
              detail:
                `"${charId}" is now holding "${obj}" with no earlier shot showing them acquire it, and this ` +
                `shot's own text doesn't show the acquisition either (no pick-up, hand-off, receiving, or ` +
                `similar verb). Either add an earlier shot establishing where this came from, or add ` +
                `acquisition language to this shot.`,
              autofixed: false,
            });
          }
          setHolding(worldState, charId, obj);
        }
      }
    }
    if (s.characters.length > 1) {
      // SAME Finding-A-shaped gap as elsewhere in this file: the solo-shot
      // branch above was deliberately narrow (a bare regex match can't say
      // WHICH of several present characters now holds something), but that
      // meant a multi-character shot got ZERO no-origin checking at all,
      // no matter how blatant. Confirmed real: an envelope appeared in a
      // two-character shot with no earlier shot establishing it and no
      // acquisition verb anywhere — completely invisible to this check
      // before, since it only ever looked at solo shots. Deliberately
      // UNATTRIBUTED here (never calls setHolding for a specific
      // character) — same conservative discipline Migration Step 5's
      // "inferred-shared" fallback uses: flag the shot as a whole rather
      // than guess who, and leave worldState's own per-character tracking
      // untouched so a LATER, more confident signal isn't overridden by a
      // guess. Deliberately OUTSIDE the per-character loop above — this
      // must run ONCE per shot, not once per character (running it inside
      // that loop pushed a duplicate issue for every character present, a
      // real bug caught by this check's own regression test).
      const ownText = `${authoredOnly(s.endFrame)} ${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;
      const m = ownText.match(HELD_OBJECT_ESTABLISH_RE) ?? ownText.match(PASSIVE_CARRY_RE) ?? ownText.match(OBJECT_ALREADY_HELD_RE);
      if (m) {
        const obj = m[1].trim();
        const alreadyTrackedByAnyone = s.characters.some(
          (id) => getHolding(worldState, id)?.toLowerCase() === obj.toLowerCase(),
        );
        const anyoneSeenBefore = s.characters.some((id) => seenCharacters.has(id));
        if (!alreadyTrackedByAnyone && anyoneSeenBefore && !PROP_ACQUISITION_RE.test(ownText)) {
          issues.push({
            shotId: s.id,
            code: "WORLD_STATE_PROP_NO_ORIGIN",
            severity: "warn",
            detail:
              `Someone in this shot is now described holding "${obj}" with no earlier shot showing anyone ` +
              `acquire it, and this shot's own text doesn't show the acquisition either (no pick-up, ` +
              `hand-off, receiving, or similar verb) — unattributed since this shot has ${s.characters.length} ` +
              `people and a bare text match can't say which of them it is. Either add an earlier shot ` +
              `establishing where this came from, or add acquisition language to this shot.`,
            autofixed: false,
          });
        }
      }
    }

    // ── WORLD-STATE: ACTION PRECONDITION/EFFECT ─────────────────────────────
    // See lib/actionLibrary.ts's own top-of-file comment for the full picture
    // and the concrete failure this exists to catch: a character "unlocks
    // the door" while already tracked as inside that same location.
    //
    // PER-CHARACTER ATTRIBUTION. A bare regex match on shot text cannot
    // reliably say WHICH of two or more people an action belongs to — that
    // used to mean every multi-character shot was blanket-skipped. Now:
    // prefer s.characterActions (breakdown-attributed, additive field, see
    // types.ts) whenever it covers a character; only fall back to the whole
    // shot's `motion` text for the single-character case with no
    // characterActions at all (old data, or the LLM omitted it — the
    // original, narrower behavior). A multi-character shot that's missing
    // attribution for one or more of its characters degrades gracefully:
    // THAT shot is skipped, with a logged reason, not silently folded into
    // an undifferentiated "always skip multi-character" rule.
    const locInstances = findReferentLocation(s);
    const attributedActions = (s.characterActions ?? []).filter(
      (ca) => s.characters.includes(ca.characterId) && authoredOnly(ca.action).trim()
    );
    let actionsToValidate: { characterId: string; text: string }[] = [];
    if (attributedActions.length) {
      actionsToValidate = attributedActions.map((ca) => ({ characterId: ca.characterId, text: authoredOnly(ca.action).trim() }));
      if (actionsToValidate.length < s.characters.length) {
        const missing = s.characters.filter((id) => !attributedActions.some((ca) => ca.characterId === id));
        console.warn(
          `[world-state] shot ${s.id}: validating action preconditions for ${actionsToValidate.length}/` +
          `${s.characters.length} characters only — no attributed characterActions entry for: ${missing.join(", ")}.`
        );
      }
    } else if (s.characters.length === 1) {
      // MOTION ONLY, deliberately — not description/startFrame/endFrame. See
      // authoredOnly()'s own castLock-handling: castLock only ever injects
      // into s.description, never s.motion, so this was never exposed to
      // that bug — narrowing to motion-only remains the right call for the
      // single-character fallback regardless.
      const actionText = authoredOnly(s.motion).trim();
      if (actionText) actionsToValidate = [{ characterId: s.characters[0], text: actionText }];
    } else if (s.characters.length > 1) {
      // FINDING A FIX (Migration Step 5) — the wiring audit confirmed this
      // used to be a dead end: log-and-skip meant a multi-character shot
      // with no characterActions attribution got ZERO action-precondition
      // validation, no matter what its own text said. This was the single
      // biggest reason the whole system silently missed real shots.
      //
      // A bare regex match on the shot's WHOLE combined text still can't
      // reliably say WHICH present character an action belongs to, so this
      // does NOT reuse the attributed path's per-character checkPrecondition
      // call as-is. Instead: match the shot's whole text ONCE (same
      // detection as the attributed path, via the shared matchAction()
      // helper above — never a second, drifting copy of it), then:
      //   - if EVERY present character's currently-tracked state contradicts
      //     the matched action, that's still a real, useful signal (SOMEONE
      //     present is described doing this, and nobody present could
      //     validly be doing it) — flag it, naming all of them, clearly
      //     worded as an unattributed, multi-character finding rather than
      //     a confirmed single-character one.
      //   - if AT LEAST ONE present character's state doesn't contradict it,
      //     WHO exactly is genuinely ambiguous — silently advance the FIRST
      //     such candidate's state (deterministic, by cast order, never
      //     random) so later shots still have a state to check against,
      //     tagged "inferred-shared" (not "attributed") so this stays
      //     visibly a lower-confidence guess, not a confirmed fact.
      // Handoffs (recipientEffect) are deliberately NOT resolved in this
      // branch — a second layer of "who" ambiguity (the recipient) on top
      // of an already-ambiguous "who" (the actor) is exactly where a false
      // attribution becomes likely, not just imprecise; a real handoff in
      // an unattributed multi-character shot stays undetected here until
      // the breakdown supplies characterActions, same conservative-over-
      // clever discipline this whole file uses elsewhere for fuzzy guesses.
      const sharedText = `${authoredOnly(s.setting)} ${authoredOnly(s.motion)} ${authoredOnly(s.description)}`.trim();
      const matched = sharedText
        ? matchAction(sharedText, `${s.scene || ""}: ${authoredOnly(s.setting) || ""}`.trim())
        : null;
      if (matched) {
        const precondition = resolveInstanceReferents(matched.precondition, locInstances);
        const effect = resolveInstanceReferents(matched.effect, locInstances);
        const candidates = s.characters.filter((id) => !checkPrecondition(getSpatialState(worldState, id), precondition));
        if (candidates.length === 0) {
          const names = s.characters.map((id) => characters.find((c) => c.id === id)?.name ?? id).join(", ");
          issues.push({
            shotId: s.id,
            code: "WORLD_STATE_ACTION_CONTRADICTION",
            severity: "warn",
            detail:
              `This shot's own text describes "${matched.label}", but NONE of the characters present (${names}) ` +
              `are in a tracked state where that action makes sense — and the breakdown doesn't attribute this ` +
              `action to a specific one of them, so this is an unattributed, multi-character finding, not a ` +
              `confirmed single-character contradiction. Either fix whichever character's earlier state is ` +
              `wrong, or attribute this action to a specific character (Shot.characterActions) so it can be ` +
              `checked precisely.`,
            autofixed: false,
          });
        } else {
          const actorId = candidates[0];
          setSpatialState(worldState, actorId, applyEffect(getSpatialState(worldState, actorId), effect), "inferred-shared");
          console.warn(
            `[world-state] shot ${s.id}: unattributed action "${matched.label}" plausibly matches "${actorId}" ` +
            `(of ${s.characters.length} present, no characterActions attribution) — advancing their state as ` +
            `inferred-shared, not attributed.`
          );
        }
      } else {
        console.warn(
          `[world-state] shot ${s.id}: skipping action-precondition validation — ${s.characters.length} ` +
          `characters present but breakdown data does not attribute actions to specific characters for this ` +
          `shot, and the shot's whole text didn't match a known action either.`
        );
      }
    }

    for (const { characterId: charId, text: actionText } of actionsToValidate) {
      const spState = getSpatialState(worldState, charId);
      const matched = matchAction(actionText, `${s.scene || ""}: ${authoredOnly(s.setting) || ""}`.trim());
      if (!matched) continue;

      let { precondition: matchedPrecondition, effect: matchedEffect, label: matchedLabel, coreRule, coreMatch } = matched;
      let matchedRecipientId: string | null = null;
      let matchedRecipientEffect: SpatialFact[] | null = null;

      // HANDOFF: a core-library match with recipientEffect/recipientGroup
      // resolves a SECOND character (the recipient) from the shot's other
      // present characters by name, and applies a separate effect to THEIR
      // tracked state — e.g. "hands the keys to Zara" makes Zara newly
      // near/holding the keys, independent of what happens to the giver.
      if (coreRule?.recipientEffect && coreRule.recipientGroup && coreMatch) {
        const recipientName = coreMatch[coreRule.recipientGroup]?.trim().toLowerCase();
        if (recipientName) {
          // Match either the FULL name ("hands the keys to Farid Nassar") or
          // just the first token ("hands the keys to Zara" against a
          // character named "Zara Ahmed") — script prose commonly uses a
          // first-name-only reference even when the cast sheet has a surname.
          const recipientFirstToken = recipientName.split(/\s+/)[0];
          const recipient = s.characters
            .filter((id) => id !== charId)
            .map((id) => characters.find((c) => c.id === id))
            .find((c) => {
              if (!c) return false;
              const full = c.name.trim().toLowerCase();
              return full === recipientName || full.split(/\s+/)[0] === recipientFirstToken;
            });
          if (recipient) {
            matchedRecipientId = recipient.id;
            matchedRecipientEffect = resolveInstanceReferents(
              resolveReferentPlaceholders(coreRule.recipientEffect, coreMatch),
              locInstances
            );
          }
        }
      }

      // PER-INSTANCE DISAMBIGUATION: resolve each fact's referent against
      // this location's known instances (two doors tracked separately; a
      // later bare "the door" resolves to the single known instance; a
      // genuinely ambiguous bare reference — 2+ known instances — has that
      // one fact dropped rather than guessed). See resolveInstanceReferents()
      // in actionLibrary.ts.
      matchedPrecondition = resolveInstanceReferents(matchedPrecondition, locInstances);
      matchedEffect = resolveInstanceReferents(matchedEffect, locInstances);

      const violation = checkPrecondition(spState, matchedPrecondition);
      if (violation) {
        issues.push({
          shotId: s.id,
          code: "WORLD_STATE_ACTION_CONTRADICTION",
          severity: "warn",
          detail:
            `"${charId}" ${violation} — the action "${matchedLabel}" contradicts this. Either reposition the ` +
            `character (adjust the setting/motion so their tracked spatial state agrees), or change the ` +
            `action to one that makes sense given where they already are.`,
          autofixed: false,
        });
      } else {
        setSpatialState(worldState, charId, applyEffect(spState, matchedEffect), "attributed");
        if (matchedRecipientId && matchedRecipientEffect) {
          const recipientState = getSpatialState(worldState, matchedRecipientId);
          setSpatialState(worldState, matchedRecipientId, applyEffect(recipientState, matchedRecipientEffect), "attributed");
        }
      }
    }

    prevShot = s;
    for (const c of s.characters) seenCharacters.add(c);
    for (const p of s.props ?? []) seenProps.add(p);

    // Ambience used to be assigned here, but SCENE SETTING LOCK (below, after
    // this whole loop) can still enrich s.setting with detail pulled from a
    // richer neighboring shot in the same scene run — computing ambience this
    // early would key it off the pre-lock, possibly-thinner text and miss
    // weather/environment words that only show up once the lock runs. See the
    // AMBIENCE RECOMPUTE pass near the end of this function for where it's
    // actually assigned now.

    shots.push(s);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // NARRATIVE PASS — runs across the WHOLE shot list, not shot by shot.
  // Everything above validates one shot in isolation. These three checks are
  // about the FILM: does it hold together as a continuous scene, or is it a
  // highlight reel with holes the viewer has to guess across?
  // ═════════════════════════════════════════════════════════════════════════
  // Consecutive-run counter for the screen/mirror-insert overuse check below —
  // needs to persist across loop iterations, so it lives outside the loop body.
  let screenInsertStreak = 0;

  // Handoff tracker for REDUNDANT_HANDOFF below — keyed by scene + character
  // pair, so a repeat only fires against an earlier shot that is genuinely the
  // SAME two people in the SAME place, and different scenes never collide.
  // Stores the completing shot's id AND text, because the same two people can
  // legitimately exchange MORE THAN ONE distinct object in one scene (pay with
  // coins, then receive a parcel in return) — that must never be flagged just
  // for sharing a character pair. Only a repeat of the SAME object counts.
  const handoffSeen = new Map<string, { id: string; objects: Set<string> }>();
  const HANDOFF_PICKUP = /\bpicks?\s+up\b/i;
  // A hedge word here usually means a SECOND, genuinely different exchange
  // (change given back, a receipt, a different item) rather than the same
  // object moving back and forth — skip flagging those rather than guess wrong.
  const NEW_ITEM_HINT = /\b(another|a second|a different|in return|as change|receipt|separately)\b/i;
  // Concrete, commonly-exchanged nouns. Matching on THESE (rather than generic
  // token overlap) is what tells "the same parcel, handed off twice" apart from
  // "coins paid, then a parcel received" — two exchange sentences share plenty
  // of generic vocabulary (hand, takes, close, around) no matter what object is
  // actually involved, so raw word overlap alone false-positives constantly.
  const HANDOFF_OBJECT_NOUNS = [
    "parcel", "package", "coins?", "money", "cash", "wallet", "purse", "bag",
    "backpack", "handbag", "letter", "envelope", "key", "ticket", "receipt",
    "box", "bottle", "phone", "ring", "note", "gift",
  ];
  // Confirmed real gap (surfaced by broadening TAKES to catch "accepted",
  // above): real shot text reads "Farid has just accepted the six coins and
  // KEEPS THEM SECURED in his closed hand... he presents a parcel" — that
  // shot both correctly REFERENCES an object already secured from an EARLIER
  // beat AND completes a genuinely NEW exchange. Counting "coins" as a fresh
  // object here made this shot collide with the earlier coins hand-off and
  // get wrongly flagged as re-staging it — a false positive that, now that
  // REDUNDANT_HANDOFF blocks the render, could fail a perfectly correct
  // shot. A noun mentioned only in an "already have it, not taking it again"
  // context doesn't count as a fresh exchange.
  const ALREADY_SECURED_NEAR = /\b(keeps?|keeping|kept|already|still|secured?|securing)\b/i;
  function handoffObjectsIn(text: string): Set<string> {
    const found = new Set<string>();
    for (const noun of HANDOFF_OBJECT_NOUNS) {
      const re = new RegExp(`\\b${noun}\\b`, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        // Check BOTH directions — "coins and keeps them secured" states the
        // already-have-it signal AFTER the noun (via "them"), while other
        // phrasings ("still holding the coins") state it before. A window on
        // only one side missed exactly the real sentence shape this exists for.
        const nearby = text.slice(Math.max(0, m.index - 20), Math.min(text.length, m.index + noun.length + 30));
        if (!ALREADY_SECURED_NEAR.test(nearby)) {
          found.add(noun.replace(/\?$/, ""));
          break;
        }
      }
    }
    return found;
  }

  for (let i = 0; i < shots.length; i++) {
    const cur = shots[i];
    const nxt = shots[i + 1];
    const curText = `${authoredOnly(cur.motion)} ${authoredOnly(cur.description)}`;

    // (0) SCREEN/MIRROR INSERT OVERUSE. A monitor, mirror or window filling the
    //     frame is an easy, safe composition — easy enough that three or four in a
    //     row slip out looking like a directed choice when it is really the model
    //     reaching for the same trick repeatedly. (Real failure: a 19-shot scene
    //     opened with THREE consecutive "the monitor screen fills the frame" shots
    //     — no wide establishing shot at all — and repeated the pattern at the
    //     midpoint and climax, burying the parents' actual reactions behind glass.)
    // (0b) THE SAME OBSTACLE CROSSED TWICE. Both this shot and the next describe
    //      crossing something (a corner, an archway, a wall) AND their text overlaps
    //      heavily — the character is re-crossing the identical obstacle instead of
    //      covering new ground. Threshold is looser than ENDPOINTS_MAYBE_TOO_SIMILAR's
    //      0.9 (that catches near-verbatim keyframes; this catches "the same beat
    //      described twice in different words"), so it only fires on real repeats.
    if (nxt) {
      const nxtText = `${authoredOnly(nxt.motion)} ${authoredOnly(nxt.description)}`;
      // Compare the AUTHORED text only (curText/nxtText), never the raw description —
      // by this point in the pipeline R7 has already appended the compiler's own cast-
      // lock sentence to every shot's description, and two solo-character shots share
      // that near-identical sentence VERBATIM regardless of what their content actually
      // is. Comparing raw description inflates overlap on shared boilerplate alone.
      if (
        CROSSES_SOMETHING(curText) &&
        CROSSES_SOMETHING(nxtText) &&
        tokenOverlapRatio(curText, nxtText) >= 0.5
      ) {
        issues.push({
          shotId: nxt.id,
          code: "REDUNDANT_CROSSING",
          severity: "warn",
          detail:
            `This shot and the previous one ("${cur.id}") both describe crossing what reads as the same ` +
            "obstacle (a corner, archway, doorway, or wall), with heavily overlapping wording. The character " +
            "appears to re-cross ground already covered instead of advancing to a new obstacle or a new stretch " +
            "of the chase. Either make this shot start from where the PREVIOUS crossing actually ended (further " +
            "along, not back at the obstacle), or replace it with new ground — a different obstacle, or a beat " +
            "that doesn't re-run the same crossing.",
          autofixed: false,
        });
      }
    }

    // (0c) THE SAME HAND-OFF, STAGED AGAIN. A two-person exchange (money, a
    //      parcel, any item) that has already completed earlier in this scene
    //      gets re-staged: picked back up off a table, handed over a second
    //      time, or handed back to whoever gave it. (Real failure: a market
    //      customer received a parcel, then a later shot showed him picking it
    //      up from the stall table again, then handing it BACK to the
    //      shopkeeper in the shot after that — three shots re-running one
    //      already-finished exchange.) Only tracks a genuine TWO-person shot,
    //      keyed by scene + the pair, so unrelated later scenes with the same
    //      two characters never collide. A completion is marked the first time
    //      TAKES actually lands (a bare GIVES/offer alone is still in progress —
    //      see ACTION_NEVER_COMPLETES, which covers that gap already).
    if (cur.characters.length === 2 && !NEW_ITEM_HINT.test(curText)) {
      const exchangeActivity = GIVES.test(curText) || TAKES.test(curText) || HANDOFF_PICKUP.test(curText);
      if (exchangeActivity) {
        const key = `${sceneKey(cur)}::${[...cur.characters].sort().join("+")}`;
        const already = handoffSeen.get(key);
        const curObjects = handoffObjectsIn(curText);
        // Only a match on a NAMED object counts as "the same exchange" — two
        // shots that both merely mention hands/taking/giving with no shared
        // object noun are treated as unrelated (or unidentifiable) and never
        // flagged, since guessing wrong here would block a perfectly normal
        // scene where two different items change hands between the same pair.
        const sameObject = already && [...curObjects].some((o) => already.objects.has(o));
        if (already && sameObject && already.id !== cur.id) {
          issues.push({
            shotId: cur.id,
            // REVERTED TO WARN, 2026-08-02: briefly escalated to "error" the same
            // day after being confirmed producing a real visible defect — but the
            // user would rather see a full, flagged film to visually verify
            // today's real root-cause fixes (GIVES/TAKES past-tense matching,
            // handoffObjectsIn's already-secured exclusion, the culled-character-
            // in-prose block) actually worked, than risk a hard failure with
            // nothing to watch. Repair loop still gets its normal two tries; if
            // still unresolved after that, it ships flagged instead of blocking
            // the whole render.
            code: "REDUNDANT_HANDOFF",
            severity: "warn",
            detail:
              `An object hand-off between these same two characters already completed in shot "${already.id}" ` +
              "earlier in this scene. This shot reads as re-staging that exchange — picking the object back " +
              "up, handing it over again, or handing it back to whoever gave it — rather than showing what " +
              "happens NEXT. Once a hand-off between two people is done, it is done for the rest of the scene: " +
              "move on to the aftermath (a reaction, a thank-you, walking away) instead of repeating or " +
              "reversing the exchange.",
            autofixed: false,
          });
        } else if (TAKES.test(curText) && curObjects.size && (!already || !sameObject)) {
          // Track this as the latest COMPLETED exchange for this pair+scene —
          // either the first one ever, or a genuinely different object than
          // whatever completed last (coins paid, now a parcel received: both
          // legitimate, and a later repeat of THIS parcel should still be caught).
          handoffSeen.set(key, { id: cur.id, objects: curObjects });
        }
      }
    }

    const isScreenInsert = REFLECTIVE.test(curText) && FRAME_SPECIFIED.test(curText);
    if (isScreenInsert) {
      screenInsertStreak++;
      if (screenInsertStreak > 2) {
        issues.push({
          shotId: cur.id,
          code: "SCREEN_INSERT_OVERUSE",
          severity: "warn",
          detail:
            `This is the ${screenInsertStreak}${screenInsertStreak === 3 ? "rd" : "th"} shot in a row dominated ` +
            "by the same reused surface (a monitor/mirror/screen) filling the frame. Reads as static and " +
            "repetitive, and buries the characters' own reactions behind glass. Rewrite this shot as a " +
            "reaction/coverage shot of the characters themselves — their faces, their bodies in the room — " +
            "and return to the surface later only if the story needs it again.",
          autofixed: false,
        });
      }
    } else {
      screenInsertStreak = 0;
    }

    // (0c) THE SAME REFLECTION/ESTABLISHING SHOT, TWICE, WITH A GAP. The reusable
    //      "surface fills the frame, X visible in the reflection" template is easy
    //      for the model to reach for lazily a second time instead of advancing the
    //      story — this is the screen-insert twin of REDUNDANT_CROSSING above, and it
    //      is NOT caught by SCREEN_INSERT_OVERUSE (which only fires on an unbroken
    //      RUN of 3+; this fires even with ONE different shot sandwiched between the
    //      two duplicates). Checked against the last TWO screen-insert shots, not just
    //      the immediately preceding one, because that's exactly where this shipped:
    //      shot 2 and shot 4 were both "the door's window reflects Sarah inside and
    //      Daniel outside" with only one shot between them — and shot 4 restated
    //      Daniel as still outside even though shot 3, in between, already showed him
    //      inside reacting with Sarah. A viewer sees him un-enter the house.
    if (isScreenInsert) {
      for (let back = 1; back <= 2; back++) {
        const earlier = shots[i - back];
        if (!earlier) break;
        const earlierText = `${authoredOnly(earlier.motion)} ${authoredOnly(earlier.description)}`;
        const earlierIsScreenInsert = REFLECTIVE.test(earlierText) && FRAME_SPECIFIED.test(earlierText);
        // Compare authored text (curText/earlierText), not raw description — see the
        // note on REDUNDANT_CROSSING above: raw description already carries the
        // compiler's own cast-lock sentence, which is near-identical across any two
        // shots with the same solo character regardless of actual content.
        if (earlierIsScreenInsert && tokenOverlapRatio(curText, earlierText) >= 0.65) {
          issues.push({
            shotId: cur.id,
            code: "REDUNDANT_SCREEN_INSERT",
            severity: "warn",
            detail:
              `This shot and an earlier one ("${earlier.id}") both compose the same reflective surface with ` +
              "heavily overlapping wording — the same reveal is being staged twice instead of advancing the " +
              "scene. Check in particular whether a character's position (inside/outside, before/after a " +
              "threshold) has silently reset between them: if a shot in between already showed them further " +
              "along, this shot must not restate their earlier position. Either cut this shot, or rewrite it to " +
              "show the NEXT moment, not the same one again.",
            autofixed: false,
          });
          break;
        }
      }
    }

    // (1) AN ACTION THAT NEVER COMPLETES. Money offered and never taken; a hand
    //     extended and never met. The completion is a real beat, not an inference.
    if (GIVES.test(curText) && !TAKES.test(curText)) {
      const nextText = nxt ? `${authoredOnly(nxt.motion)} ${authoredOnly(nxt.description)}` : "";
      if (!TAKES.test(nextText)) {
        issues.push({
          shotId: cur.id,
          // REVERTED TO WARN, 2026-08-02 — see REDUNDANT_HANDOFF's own note
          // above for why: prioritizing a full, flagged render to visually
          // verify today's real fixes over risking a hard failure.
          code: "ACTION_NEVER_COMPLETES",
          severity: "warn",
          detail:
            "Someone gives/offers/holds something out, but no shot here or next shows it being TAKEN. " +
            "A giving hand with nobody receiving is the most obvious 'AI video' tell. Add the completing " +
            "beat: the other person's hand closing on it, and them now holding it.",
          autofixed: false,
        });
      }
    }

    // (1b) A DEPARTURE THAT NEVER ACTUALLY DEPARTS. Confirmed real failure: a
    //      market customer's exit shot said he was "walking screen-left to
    //      screen-right" while "glancing back" at the vendor, who was "returning
    //      [his] glance with a friendly wave" — the render showed him walking
    //      BACK TOWARD the stall, because nothing in the text ever pinned real,
    //      growing distance the way CROSSING_NEEDS_TWO_SIDES pins a "far side"
    //      for an obstacle crossing. IMPORTANT LESSON FROM THAT FAILURE: the
    //      shot's OWN text never actually used departure vocabulary at all — the
    //      original shot list said "steps back into the flow of the crowd,
    //      continuing in the same direction he arrived from," but that framing
    //      got diluted away during elaboration into pure screen-direction
    //      blocking ("left to right") that no longer signals leaving at all. So
    //      this can't rely on spotting DEPARTS-type words alone — it ALSO fires
    //      structurally: reusing REDUNDANT_HANDOFF's own handoffSeen tracking
    //      (above), any shot for the SAME two-person pair coming AFTER their
    //      exchange already completed is exactly the moment a departure is due.
    //      Either trigger still only fires when the OTHER character is shown
    //      actively, mutually engaging (a returned wave, a returned glance) —
    //      that reciprocal engagement is what reads as "still right there," the
    //      contradiction a genuine departure cannot have — and only when
    //      nothing in the text states real separation being covered.
    if (cur.characters.length >= 2 && RECIPROCAL_INTERACTION.test(curText) && !SEPARATION_ESTABLISHED.test(curText)) {
      const explicitDeparture = DEPARTS.test(curText);
      const key = `${sceneKey(cur)}::${[...cur.characters].sort().join("+")}`;
      const completedHandoff = handoffSeen.get(key);
      const afterCompletedExchange = !!completedHandoff && completedHandoff.id !== cur.id;
      if (explicitDeparture || afterCompletedExchange) {
        issues.push({
          shotId: cur.id,
          code: "DEPARTURE_NEVER_SEPARATES",
          severity: "warn",
          detail:
            (explicitDeparture
              ? "This shot is framed as departing/leaving, "
              : `This shot follows an exchange between the same two people that already completed in shot ` +
                `"${completedHandoff!.id}" earlier in this scene — the natural next beat is moving on, `) +
            "but the other character is still shown actively engaging back (a returned wave, a returned " +
            "glance) and nothing in the text ever states real, growing distance or separation being covered. " +
            "A screen-direction (\"left to right\") is not a distance fact — without an explicit anchor " +
            "(\"now several strides away\", \"the stall shrinking behind him\", \"putting distance between " +
            "them\"), the render has nothing forcing him to actually move away rather than linger or drift " +
            "back toward where he started. Add a concrete distance/separation statement, or cut the " +
            "reciprocal engagement if the beat is meant to be a clean exit.",
          autofixed: false,
        });
      }
    }

    // (1a) A THROWN OBJECT NEVER CAUGHT. Same failure shape as
    //      ACTION_NEVER_COMPLETES above, for the airborne case: an object
    //      thrown TO someone with no catch shown reads as it vanishing
    //      mid-flight, the single most obvious "AI video" tell for this beat.
    if (THROWN_TO_PERSON.test(curText) && !CAUGHT.test(curText)) {
      const nextText = nxt ? `${authoredOnly(nxt.motion)} ${authoredOnly(nxt.description)}` : "";
      if (!CAUGHT.test(nextText)) {
        issues.push({
          shotId: cur.id,
          code: "THROW_NEVER_CAUGHT",
          severity: "warn",
          detail:
            "Someone throws/tosses/hurls something TO another person, but no shot here or next shows it " +
            "being CAUGHT. Without that beat the object appears to vanish mid-flight. Add the completing " +
            "beat: the receiver's hands rising to meet it and closing around it.",
          autofixed: false,
        });
      }
    }

    // (1b) THE SAME LINE SPOKEN TWICE. Two consecutive shots delivering the same
    //      dialogue reads as the clip stuttering/repeating, not as two takes of one
    //      beat. (Real failure: an interview's closing line was spoken in shot 5,
    //      then spoken again near-verbatim in shot 6, with only the camera angle
    //      changed.) The fix is either a new line, or a silent reaction shot.
    if (nxt && cur.dialogue?.trim() && nxt.dialogue?.trim() && sameDialogue(cur.dialogue, nxt.dialogue)) {
      issues.push({
        shotId: nxt.id,
        code: "DUPLICATE_DIALOGUE_ADJACENT",
        severity: "warn",
        detail:
          `This shot's dialogue repeats shot "${cur.id}"'s line almost word-for-word. Two consecutive ` +
          "shots speaking the same line plays as a stutter, not as continued footage of one line. Either " +
          "give this shot the NEXT line of dialogue, or drop \"dialogue\" here entirely and make it a " +
          "silent reaction/listening beat that continues the scene.",
        autofixed: false,
      });
    } else {
      // ONE-SHOT LOOK-BACK, past a single silent reaction shot in between —
      // the check above only ever compares LITERALLY adjacent shots. A
      // silent reaction/listening beat (no dialogue of its own) inserted
      // between two shots speaking the same line is still the same stutter
      // a viewer hears, just with one cutaway shot separating them; the
      // check above's own strict adjacency requirement would miss it
      // entirely. Deliberately narrow: only fires when the IN-BETWEEN shot
      // has NO dialogue at all (a genuine silent beat) — if it has its own
      // real line, two similar lines either side of it are two separate
      // moments in an ordinary conversation, not a stutter, and must not be
      // flagged.
      const skipOne = shots[i + 2];
      if (
        nxt && !nxt.dialogue?.trim() && skipOne &&
        cur.dialogue?.trim() && skipOne.dialogue?.trim() &&
        sameDialogue(cur.dialogue, skipOne.dialogue)
      ) {
        issues.push({
          shotId: skipOne.id,
          code: "DUPLICATE_DIALOGUE_ADJACENT",
          severity: "warn",
          detail:
            `This shot's dialogue repeats shot "${cur.id}"'s line almost word-for-word, with only a silent ` +
            `reaction shot ("${nxt.id}") in between. The same stutter the strictly-adjacent case catches, just ` +
            `with one cutaway separating the two deliveries. Either give this shot the NEXT line of dialogue, ` +
            `or drop "dialogue" here entirely and make it a silent reaction/listening beat instead.`,
          autofixed: false,
        });
      }
    }

    // (2) A LOCATION JUMP WITH NO TRAVEL. Cutting from outside to inside (or
    //     between places) without an approach/enter/exit beat reads as a teleport
    //     — "he was on the road, then at a counter, then on the road again".
    // An ESTABLISHING or EXTERIOR shot is a deliberate change of location — that
    // is normal film grammar, not a teleport. Only flag a gap when a CHARACTER
    // moves between places with no travel shown.
    const bothHavePeople = cur.characters.length > 0 && (nxt?.characters.length ?? 0) > 0;
    const sharesCharacter = !!nxt && cur.characters.some((c) => nxt.characters.includes(c));
    if (nxt && bothHavePeople && sharesCharacter && !sameScene(cur, nxt)) {
      const bridge = TRANSITION.test(curText) || TRANSITION.test(`${authoredOnly(nxt.motion)} ${authoredOnly(nxt.description)}`);
      if (!bridge) {
        issues.push({
          shotId: nxt.id,
          code: "NARRATIVE_GAP_NEEDS_TRANSITION",
          severity: "warn",
          detail:
            `The location changes between "${cur.id}" and "${nxt.id}" with no shot showing the move. ` +
            "The character teleports across the cut. Insert the bridging beat (approaching, entering, " +
            "stepping through, leaving) so a viewer can follow how he got there.",
          autofixed: false,
        });
      }
    }

    // (2b) A REFLECTIVE SURFACE WITH NO COMPOSITION. The shot names a mirror or
    //      screen but never says what the camera is actually looking at, so the
    //      model defaults to the person and the reflected content is lost.
    if (REFLECTIVE.test(curText) && !FRAME_SPECIFIED.test(curText) && !FRAME_SPECIFIED.test(cur.camera || "")) {
      issues.push({
        shotId: cur.id,
        code: "REFLECTION_NEEDS_COMPOSITION",
        severity: "warn",
        detail:
          "This beat involves a mirror/monitor/screen but never states WHAT FILLS THE FRAME. The renderer " +
          "will make the person the subject and treat the reflective surface as scenery — so whatever the " +
          "reflection was supposed to reveal never appears. Lead with the surface (\"the rearview mirror " +
          "fills the frame\"), then describe what is INSIDE the glass, then what little real space remains.",
        autofixed: false,
      });
    }

    // (2c) A REACTIVE STIMULUS WITH NO NOTICING BEAT. The surface's content
    //      visibly changes (static clears into an image, a feed switches), but
    //      neither this shot nor the one before it shows anyone turning toward
    //      it, hearing it, or being drawn to it — so the cut plays as a random
    //      cutaway instead of a reveal the characters actually experienced.
    if (REFLECTIVE.test(curText) && FRAME_SPECIFIED.test(curText) && SURFACE_CONTENT_CHANGES.test(curText)) {
      const prevText = i > 0 ? `${authoredOnly(shots[i - 1].motion)} ${authoredOnly(shots[i - 1].description)}` : "";
      if (!NOTICE_CUE.test(curText) && !NOTICE_CUE.test(prevText)) {
        issues.push({
          shotId: cur.id,
          code: "STIMULUS_NEEDS_NOTICE_CUE",
          severity: "warn",
          detail:
            "This surface's content changes (static clears, the feed switches) but neither this shot nor the " +
            "previous one shows a character noticing it first — a head turning toward it, eyes cutting to it, " +
            "something drawing their attention. Without that beat, the viewer can't tell who noticed the change " +
            "or when; it reads as a random cutaway, not a reveal. Add the noticing cue to this shot or the one " +
            "before it.",
          autofixed: false,
        });
      }
    }

    // (3) POINTLESS BUSINESS. A door opened and shut again, an object picked up
    //     and put back — motion with no consequence. Usually a bridging beat that
    //     was added mechanically instead of carrying the story forward.
    if (SELF_CANCELLING.test(curText)) {
      issues.push({
        shotId: cur.id,
        // REVERTED TO WARN, 2026-08-02 — see REDUNDANT_HANDOFF's own note
        // above for why: prioritizing a full, flagged render to visually
        // verify today's real fixes over risking a hard failure.
        code: "POINTLESS_BUSINESS",
        severity: "warn",
        detail:
          "This shot performs an action and then undoes it (opens then closes, picks up then puts back), " +
          "so nothing has changed by the end — it reads as random fidgeting. Either make the action lead " +
          "somewhere (he opens the door AND GOES THROUGH IT) or replace the beat with one that advances the story.",
        autofixed: false,
      });
    }

    // (4) A THRESHOLD THAT IS NEVER CROSSED. Touching a door without passing
    //     through it is the same failure in its most common form.
    // A DOOR IS NOT ALWAYS A THRESHOLD TO CROSS. In "the nursery door creaks
    // shut on its own" the door is SCENERY — there is nobody to walk through it,
    // and demanding a crossing made the repair loop bolt on exit shots until a
    // horror ending became a family walking out of the house. Only fire when a
    // character is actually present AND the beat is about moving between spaces.
    const someonePresent = cur.characters.length > 0;
    const wantsToMove = /\b(door|gate|entrance|doorway|shutter)\b[^.]{0,40}\b(open|push|reach|hand|knob|handle|toward|towards|approach)/i.test(curText)
      || /\b(walks?|steps?|moves?|heads?|runs?)\b[^.]{0,30}\b(door|gate|entrance|doorway|inside|outside|in|out)\b/i.test(curText);
    if (someonePresent && wantsToMove && THRESHOLD.test(curText) && !GOES_THROUGH.test(curText)) {
      issues.push({
        shotId: cur.id,
        code: "THRESHOLD_NOT_CROSSED",
        severity: "warn",
        detail:
          "A door/entrance appears in this beat but the character is never shown passing through it. " +
          "A threshold shot exists to move him from one space to another — show him going THROUGH, " +
          "ending clearly on the other side.",
        autofixed: false,
      });
    }

    // (4a) THRESHOLD CROSSING SKIPPED — the cross-shot OMISSION mirror of
    // THRESHOLD_NOT_CROSSED just above. THAT check catches a shot that TOUCHES
    // a door but never shows going through it, all within ONE shot's own text.
    // This catches the different failure the same underlying gap can produce:
    // shot `cur` establishes a character just OUTSIDE a threshold (approaching
    // it, at the door, on the porch) and does NOT depict crossing it, and the
    // VERY NEXT shot `nxt` (sharing that character) jumps straight to a
    // genuinely DIFFERENT setting with no crossing language anywhere in IT
    // either — the entering action was never depicted in EITHER shot, just
    // silently skipped between cuts. Confirmed real: a character shown outside
    // a door, then the very next shot shows them already inside, with no shot
    // in between showing the door opening or the crossing happening — the
    // inverse of the "unlocks door while already inside" contradiction bug
    // (this is an omission, not a contradiction). sameScene(cur, nxt) is
    // deliberately used here as the NEGATIVE signal — unlike every other
    // world-state check, which uses it to scope a check TO one physical
    // place — because a doorway and the room behind it are, by design,
    // different immediate settings that share one scene narratively; "the
    // next shot is a different setting" is exactly the expected shape of a
    // genuine crossing cut, not a false trigger. This is also, directly, the
    // breakdown-COMPLETENESS question the same investigation was asked to
    // check: if the breakdown had actually included a dedicated crossing shot
    // between these two, THAT shot would be `nxt` itself and would contain
    // GOES_THROUGH/THRESHOLD language, so this would not fire — the check
    // only fires when the crossing beat is genuinely missing from the shot
    // list, not merely under-described.
    const outsideNotYetCrossed =
      someonePresent && THRESHOLD.test(curText) && OUTSIDE_OF_THRESHOLD.test(curText) && !GOES_THROUGH.test(curText);
    if (
      outsideNotYetCrossed &&
      nxt &&
      cur.characters.some((id) => nxt.characters.includes(id)) &&
      !sameScene(cur, nxt)
    ) {
      const nxtText = `${authoredOnly(nxt.motion)} ${authoredOnly(nxt.description)} ${authoredOnly(nxt.setting)} ${authoredOnly(nxt.startFrame)}`;
      if (!GOES_THROUGH.test(nxtText) && !THRESHOLD.test(nxtText)) {
        issues.push({
          shotId: nxt.id,
          code: "THRESHOLD_TRANSITION_SKIPPED",
          severity: "warn",
          detail:
            `The previous shot ("${cur.id}") left the character just outside a door/entrance, not yet crossed ` +
            `— and this shot jumps straight to a different setting with no shot anywhere depicting the actual ` +
            `crossing. Either add a dedicated shot between these two showing the character going THROUGH the ` +
            `threshold (mirroring THRESHOLD_NOT_CROSSED's fix), or, if the crossing genuinely happens off-screen ` +
            `by design, make that an explicit authored choice in this shot's own text rather than a silent gap.`,
          autofixed: false,
        });
      }
    }

    // (4a-2) CHARACTER PRESENCE GAP — Track B / B5, the GENERALIZED form of
    // THRESHOLD_TRANSITION_SKIPPED just above: that check is about a
    // character's SIDE OF A DOORWAY silently changing between shots; this is
    // about a character's PRESENCE IN THE SCENE AT ALL silently changing.
    // Confirmed real: a shot explicitly established two characters travelling
    // on TOGETHER ("Mira still at his side" as they head toward the next
    // location), and the very next shot — a genuinely different setting —
    // showed only ONE of them, with nothing in either shot's text explaining
    // a separation (no goodbye, no "stays behind", no split). She simply
    // vanished, then reappeared several shots later with no bridging beat
    // either direction. JOINT_PRESENCE is deliberately a real togetherness
    // PHRASE, not just "both characters happened to be in this shot" (which
    // would be true of nearly every 2-person shot and far too broad) — it
    // requires the text to actually assert they are together AS the scene
    // ends, the same specificity discipline OUTSIDE_OF_THRESHOLD uses above.
    const JOINT_PRESENCE =
      /\b(beside (?:him|her|them)|at (?:his|her|their) side|together|alongside (?:him|her|them)|with (?:him|her|them)\b)/i;
    // WIDENED (2026-08-05, alongside the same-scene block below) — was
    // requiring an exact pronoun ("leaves her behind"), which real breakdown
    // text almost never uses since shots consistently name characters
    // ("leaving Mira behind"). \S+ in place of the pronoun, plus -ing verb
    // forms, catches the named-character phrasing this pipeline actually
    // generates — confirmed via a real isolated test that the pronoun-only
    // version missed "leaving Mira behind" entirely. Strict superset of the
    // old pattern, so this only REMOVES false positives, never adds one.
    const SEPARATION_EXPLAINED =
      /\b(says?\s+goodbye|stays?\s+behind|waits?\s+(?:outside|there|behind)|splits?\s+up|parts?\s+ways|heads?\s+off\s+(?:alone|on\s+(?:his|her|their)\s+own)|goes?\s+(?:her|his|their)\s+own\s+way|leav(?:es|ing)\s+\S+\s+(?:there|behind)|remains?\s+behind|(?:sprints?|runs?|pulls?)\s+ahead\s+alone)\b/i;
    // MIGRATION STEP 6 REFINEMENT — this check used to compare `cur` against
    // the LITERAL next shot (the same shared `nxt` every other check in this
    // loop uses). That's wrong specifically for THIS check: a single
    // interstitial cutaway (a reaction shot, an insert of an object) shares
    // NONE of cur's characters by definition, so comparing directly against
    // it either (a) falsely flags an ordinary cutaway as a presence gap —
    // every one of cur's characters looks "missing" from a shot that was
    // never about them — or (b) silently eats the one comparison this check
    // gets, masking a REAL gap that only shows up in the shot after the
    // cutaway. Bounded forward scan to the next shot that actually shares a
    // character with `cur` fixes both: it stops at the first shot that
    // could meaningfully confirm OR deny presence, never scans past a
    // genuine scene this check should be comparing against, and never
    // touches the shared `nxt` every other check in this same loop relies
    // on meaning "literally the next shot."
    let presenceNxt: Shot | undefined;
    for (let j = i + 1; j < shots.length; j++) {
      if (shots[j].characters.some((id) => cur.characters.includes(id))) {
        presenceNxt = shots[j];
        break;
      }
    }
    if (presenceNxt && !sameScene(cur, presenceNxt) && cur.characters.length >= 2 && JOINT_PRESENCE.test(curText)) {
      const missingChars = cur.characters.filter((id) => !presenceNxt!.characters.includes(id));
      if (missingChars.length) {
        const nxtText = `${authoredOnly(presenceNxt.motion)} ${authoredOnly(presenceNxt.description)}`;
        if (!SEPARATION_EXPLAINED.test(`${curText} ${nxtText}`)) {
          const names = missingChars.map((id) => characters.find((c) => c.id === id)?.name ?? id);
          issues.push({
            shotId: presenceNxt.id,
            code: "CHARACTER_PRESENCE_GAP",
            severity: "warn",
            detail:
              `The previous shot ("${cur.id}") explicitly establishes ${names.join(" and ")} travelling on ` +
              `together as the scene ends, but this shot — a different location — shows the group without ` +
              `${names.length === 1 ? "them" : "them"}, with nothing in either shot's text explaining a ` +
              `separation (no goodbye, no staying behind, no parting ways). Either show/state the separation ` +
              `explicitly, or keep ${names.length === 1 ? "this character" : "these characters"} present in ` +
              `this shot too if they actually travelled here together.`,
            autofixed: false,
          });
        }
      }
    }

    // (4a-3) SAME-SCENE PRESENCE GAP — a DIFFERENT real failure shape than
    // (4a-2) above, confirmed on camera (E3.pdf, "The Package 3"): two
    // characters together in `cur` (a market chase), the very next shot
    // sharing a character drops ONE of them entirely ("Mira is not yet
    // visible in this frame") mid-chase, then she's back the shot after —
    // read by the viewer as a jarring same-scene vanish/reappear, not a
    // deliberate cut. (4a-2) deliberately requires !sameScene() because
    // relaxing it for ordinary same-scene shot/reverse-shot dialogue
    // coverage (an establishing 2-shot followed by single-coverage reaction
    // close-ups — completely normal filmmaking) would false-positive on
    // nearly every dialogue scene. This block also deliberately does NOT
    // require JOINT_PRESENCE's exact phrasing on `cur` — the real failing
    // shot ("Mira catches up a moment behind him") never used it. Narrowed
    // instead by requiring the shot that DROPS the character to itself be a
    // genuine physical-action beat (running/chasing/fleeing): dialogue
    // reaction shots don't use these verbs, action beats do — that's the
    // signal that distinguishes this defect from normal single coverage.
    const CONTINUOUS_GROUP_MOTION =
      /\b(runs?|running|ran|chas(?:e|es|ing)|flee(?:s|ing)?|fled|sprint(?:s|ing)?|dash(?:es|ing)?|pursu(?:e|es|ing)|race(?:s|ing)?|hurr(?:y|ies|ying))\b/i;
    if (presenceNxt && sameScene(cur, presenceNxt) && cur.characters.length >= 2) {
      const missingChars = cur.characters.filter((id) => !presenceNxt!.characters.includes(id));
      if (missingChars.length) {
        const gapText = `${authoredOnly(presenceNxt.motion)} ${authoredOnly(presenceNxt.description)}`;
        if (CONTINUOUS_GROUP_MOTION.test(gapText) && !SEPARATION_EXPLAINED.test(`${curText} ${gapText}`)) {
          const names = missingChars.map((id) => characters.find((c) => c.id === id)?.name ?? id);
          issues.push({
            shotId: presenceNxt.id,
            code: "CHARACTER_PRESENCE_GAP",
            severity: "warn",
            detail:
              `The previous shot ("${cur.id}") has ${names.join(" and ")} together in this same scene, and this ` +
              `shot continues the same physical action (running/chasing) but drops ${names.length === 1 ? "them" : "them"} ` +
              `from frame entirely, with nothing explaining a separation — reads as a same-scene vanish, not a ` +
              `deliberate shot choice. Either keep ${names.length === 1 ? "this character" : "these characters"} ` +
              `in frame too, or make the drop an explicit authored choice (falls behind, stops, stays back).`,
            autofixed: false,
          });
        }
      }
    }

    // (4b) A DAY-TO-NIGHT (OR NIGHT-TO-DAY) JUMP WITH NO TIME SKIP SHOWN. Confirmed
    //      on camera: a daytime driving sequence cut straight to a clearly nighttime
    //      arrival at the destination, with nothing in the script staging any passage
    //      of time — the viewer has no way to tell whether this is a continuity error
    //      or hours quietly passed off-screen. DAY_SIGNAL/NIGHT_SIGNAL only match
    //      strong, unambiguous words on purpose (not "evening", which is genuinely
    //      ambiguous — could be either side of dusk) to avoid false-firing on normal
    //      scene-setting language. TIME_SKIP_PHRASE checked against BOTH shots, since
    //      the skip is sometimes stated in the shot LEAVING the old time as often as
    //      the one arriving in the new one.
    if (nxt) {
      const nxtText = `${authoredOnly(nxt.motion)} ${authoredOnly(nxt.description)} ${authoredOnly(nxt.lighting)}`;
      const curLitText = `${curText} ${authoredOnly(cur.lighting)}`;
      const curIsDay = DAY_SIGNAL.test(curLitText);
      const curIsNight = NIGHT_SIGNAL.test(curLitText);
      const nxtIsDay = DAY_SIGNAL.test(nxtText);
      const nxtIsNight = NIGHT_SIGNAL.test(nxtText);
      const flips = (curIsDay && nxtIsNight) || (curIsNight && nxtIsDay);
      const skipShown = TIME_SKIP_PHRASE.test(curLitText) || TIME_SKIP_PHRASE.test(nxtText);
      if (flips && !skipShown) {
        issues.push({
          shotId: nxt.id,
          code: "TIME_OF_DAY_JUMP_NO_SKIP",
          severity: "warn",
          detail:
            `This shot reads as ${nxtIsDay ? "daytime" : "nighttime"}, but the previous shot ("${cur.id}") ` +
            `read as ${curIsDay ? "daytime" : "nighttime"} — with nothing in either shot showing time passing. ` +
            "A viewer has no way to tell whether hours went by or this is a continuity error. Either add an " +
            "explicit time-skip beat or line (\"later that night\", \"hours later\") bridging the two, or make " +
            "this shot's lighting consistent with the one before it.",
          autofixed: false,
        });
      }
    }

    // (4c) SCREEN POSITION FLIPPED WITH NO REPOSITIONING SHOT — the 180-degree
    //      rule. SYSTEM_PROMPT already asks the LLM to keep two characters on
    //      the same screen-left/screen-right sides across a conversation
    //      (RULE: "SCREEN POSITION STAYS FIXED ACROSS A CONVERSATION"), but
    //      that was purely advisory — nothing enforced it, the same
    //      "sampling problem, not a prompting one" gap every other structural
    //      rule in this file exists to close. Crossing the axis of action
    //      between two same-scene cuts with no camera move to justify it is
    //      exactly what makes an edit feel like a jarring cut instead of a
    //      continuous scene — the single most literal version of "the shots
    //      look cut" a viewer can point at. Only fires when BOTH shots
    //      explicitly state a screen side for the SAME named character (a
    //      shot that doesn't mention screen position at all never triggers
    //      this — silence isn't a contradiction).
    if (nxt && sameScene(cur, nxt)) {
      const nxtText = `${authoredOnly(nxt.motion)} ${authoredOnly(nxt.description)}`;
      const repositions = CAMERA_REPOSITION_MOVE.test(cur.camera || "") || CAMERA_REPOSITION_MOVE.test(nxt.camera || "");
      if (!repositions) {
        const sharedNames = characters
          .filter((c) => cur.characters.includes(c.id) && nxt.characters.includes(c.id))
          .map((c) => c.name);
        for (const name of sharedNames) {
          const curSide = screenSide(curText, name);
          const nxtSide = screenSide(nxtText, name);
          if (curSide && nxtSide && curSide !== nxtSide) {
            issues.push({
              shotId: nxt.id,
              code: "SCREEN_POSITION_FLIPPED",
              severity: "warn",
              detail:
                `"${name}" was screen-${curSide} in the previous shot ("${cur.id}") but is screen-${nxtSide} here, ` +
                `with no camera move shown that would explain repositioning around them. In the same continuous ` +
                `scene, crossing this 180-degree line with no repositioning shot reads as a jarring, disorienting ` +
                `cut rather than a natural angle change. Either keep "${name}" on the same screen side as the ` +
                `previous shot, or describe a camera move that visibly circles/repositions around the scene to earn the flip.`,
              autofixed: false,
            });
            break; // one flagged flip per shot pair is enough signal to act on
          }
        }
      }
    }

    // (5) TWO SHOTS IN A ROW FRAMED THE SAME. A scene shot from one distance
    //     reads as a security camera. Deterministic autofix: vary the second.
    //     EXEMPT a shot the FINE HAND MANIPULATION check (above, in the main
    //     per-shot loop) already forced to a close-up insert for a real
    //     rendering-quality reason (melted/extra fingers) — confirmed real
    //     bug: that correction ran earlier, but this pass compares purely on
    //     framing FAMILY, so a hand-insert shot sitting next to an unrelated
    //     close-up (varied here for its OWN, weaker "keep a rhythm" reason)
    //     got silently un-fixed back to a wide/medium framing, exactly the
    //     failure the fine-manipulation rule exists to prevent.
    if (
      nxt && framingFamily(cur.camera) !== "other" && framingFamily(cur.camera) === framingFamily(nxt.camera) &&
      !nxt.camera.includes("insert on the hands")
    ) {
      const replacement = VARY[framingFamily(cur.camera)] ?? VARY.other;
      issues.push({
        shotId: nxt.id,
        code: "REPEATED_FRAMING",
        severity: "warn",
        detail: `Same framing as the previous shot (${framingFamily(cur.camera)}). Varied it to keep a cinematic rhythm — wide, medium and close should alternate.`,
        autofixed: true,
      });
      nxt.camera = replacement;
    }

    // (5b) CAMERA-STATE CONTINUITY — the camera twin of R9's world/body handoff
    // above (and complementary to the SCREEN_POSITION_FLIPPED 180-degree check
    // above). Two independently-generated clips of the same scene will each
    // pick a camera treatment with NO relationship to each other unless told
    // to — one lands wide-and-static, the next tight-and-tracking, for no
    // story reason — and THAT mismatch, not any single shot's own quality, is
    // what makes a cut between them read as "two separate clips stitched
    // together" instead of a real edit. A professional editor's cut works
    // specifically because the incoming shot's camera continues a coherent
    // relationship (same screen side, a compatible height/distance, movement
    // that logically follows) with the outgoing one — this is the same
    // technique real editing uses to make many separate takes feel like one
    // continuous scene, since nothing in this pipeline can generate an
    // actually-continuous take across two independent renders. Placed AFTER
    // REPEATED_FRAMING (which may have just rewritten nxt.camera wholesale)
    // so this always appends onto whatever nxt.camera actually ends up being,
    // and never gets silently wiped by that earlier rewrite.
    // IDEMPOTENCE, same discipline as authoredOnly()/stripCastLockTail() above:
    // cur.camera may ALREADY carry ITS OWN camera-continuity clause from an
    // earlier compile pass (the repair loop recompiles the whole breakdown,
    // including shots the repair itself never touched). Embedding that
    // clause verbatim into nxt's new clause would nest a growing wrapper of
    // "continuing from... (continuing from... (...))" one layer deeper on
    // every repair round. Truncate at the marker so only cur's OWN camera
    // treatment — never a previous compile's appended text — ever gets quoted.
    const curOwnCamera = cur.camera ? cur.camera.split(", continuing from the previous shot's camera position and movement (")[0] : cur.camera;
    if (
      nxt &&
      sameScene(cur, nxt) &&
      cur.characters.some((id) => nxt.characters.includes(id)) &&
      curOwnCamera?.trim() &&
      !(nxt.camera || "").toLowerCase().includes("continuing from the previous shot's camera")
    ) {
      nxt.camera =
        `${nxt.camera || "medium shot"}, continuing from the previous shot's camera position and movement ` +
        `(${curOwnCamera.trim()}) — keep the same screen side and a compatible height/distance unless this ` +
        `beat's own action specifically calls for a new angle.`;
      issues.push({
        shotId: nxt.id,
        code: "CAMERA_CONTINUITY_CHAINED",
        severity: "warn",
        detail: "Camera framing carries forward from the previous shot's ending position/movement, instead of picking a new treatment with no relationship to it.",
        autofixed: true,
      });
    }
  }

  // (6) A CHARACTER WHO APPEARS FROM NOWHERE. If someone's FIRST appearance is
  //     partway through the film in a tight shot, they pop into existence — the
  //     viewer never saw them arrive. (Real failure: a second person materialised
  //     in shot 3 who was nowhere in shot 2.) They need an establishing beat: a
  //     wider frame that shows them in the space, or a visible entrance.
  const firstSeen = new Map<string, number>();
  shots.forEach((sh, i) => sh.characters.forEach((c) => { if (!firstSeen.has(c)) firstSeen.set(c, i); }));
  for (const [charId, i] of firstSeen) {
    if (i === 0) continue;                       // present from the top, fine
    const sh = shots[i];
    const wideEnough = /wide|establishing|medium|two[- ]shot|long shot/i.test(sh.camera || "");
    const entered = TRANSITION.test(`${authoredOnly(sh.motion)} ${authoredOnly(sh.description)}`);
    if (!wideEnough && !entered) {
      const name = characters.find((c) => c.id === charId)?.name ?? charId;
      issues.push({
        shotId: sh.id,
        code: "CHARACTER_APPEARS_UNINTRODUCED",
        severity: "warn",
        detail:
          `"${name}" appears for the first time here, in a tight frame, with no shot establishing them ` +
          `in the space. They pop into existence. Either widen this shot so the viewer sees them in the ` +
          `location, or give them a visible entrance in the previous beat.`,
        autofixed: false,
      });
    }
  }

  // ── SCENE SETTING LOCK / SCENE LIGHTING LOCK ────────────────────────────
  // The director prompt already asks for a LOCATION MAP (fixed elements,
  // real distances) AND lighting repeated VERBATIM across a scene — see
  // SYSTEM_PROMPT's own SPATIAL GEOGRAPHY section and its "same location,
  // background, landmarks, weather, time of day, lighting" world-consistency
  // rule in llm.ts — but that's advisory, the same "the LLM disobeys a real,
  // non-trivial fraction of the time" gap every other purely-advisory rule in
  // this file exists to close (see this file's own top-of-file severity
  // discipline comment). A scene's LATER shots drifting to a thinner setting
  // than its first ("a kitchen, yellow cabinets on the left, a window over
  // the sink on the right, a round table centered" shrinking to just "the
  // kitchen" three shots later) is exactly how a camera-angle change (a
  // reverse angle, a new position in the room) reveals a part of the space
  // the PIXEL continuity chain never anchored either — 4-images.ts's chain
  // only constrains what a PREVIOUS frame already showed, so the first time
  // an unseen wall, window, doorway, or light source needs to actually
  // appear, the only thing keeping it consistent is this shot's own TEXT,
  // and if that text has drifted thin, the model invents the missing detail
  // fresh instead of reusing what was already established. The exact same
  // drift risk applies to lighting: a scene lit "warm afternoon sun through
  // venetian blinds, long shadows" in shot 1 must not quietly become generic
  // "lit" text by shot 4 just because the LLM didn't re-state it. lockScene
  // Field() locks every shot in a same-scene run (identical pairwise
  // grouping to the continuity chain's own sameScene() runs) to carry the
  // RICHEST description any shot in that run stated for the given field —
  // "richest" measured deterministically by length, not fuzzy LLM judgment —
  // so every shot's own prompt text, independent of whether pixel chaining
  // also holds for it, has the same fixed anchor to draw from. PREPENDS
  // rather than replaces: a shot may legitimately add its own beat-specific
  // detail on top of the shared baseline ("...steam rising from a pot on the
  // stove now", or "...now a lamp flickers on across the room") and that
  // must survive, not be overwritten by a richer neighbor's text.
  // NOTE: "richest" is measured on authoredOnly(s[field]), not the raw field.
  // setting is never library-injected so this is a no-op for it, but lighting
  // IS — LIGHTING LIBRARY INJECTION (above, in the single-shot loop) already
  // appended a library description sentence to some shots' s.lighting before
  // this runs. Comparing raw length would let a shot whose short beat-specific
  // note happened to match a chunky library sentence outrank a genuinely rich,
  // deliberately-authored neighbor, and would re-prepend that neighbor's own
  // boilerplate onto every other shot in the run. Comparing (and matching for
  // the idempotence check) on the authored text only, while still prepending
  // onto the shot's full RAW field, keeps the shot's own injected sentence
  // intact and picks the right "richest" shot regardless of injection noise.
  // Same token-overlap technique sameScene() uses to decide "is this the same
  // physical place", reused here to distinguish "this shot's setting is just
  // THINNER than its neighbor's" (a real gap, but the same content — plain
  // prepending genuinely fixes it) from "this shot's setting describes
  // meaningfully DIFFERENT content" (gluing the richer text onto a
  // contradicting one doesn't resolve the contradiction, it just produces a
  // self-contradictory prompt — see SCENE_SETTING_FEATURE_DRIFT below).
  function tokenOverlapRatio(a: string, b: string): number {
    const norm = (x: string) => new Set((x || "").toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []);
    const A = norm(a), B = norm(b);
    if (!A.size || !B.size) return 1; // nothing to compare against -> not a divergence
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    return shared / Math.min(A.size, B.size);
  }
  function lockSceneField(field: "setting" | "lighting", code: string): void {
    let runStart = 0;
    for (let i = 1; i <= shots.length; i++) {
      const continues = i < shots.length && sameScene(shots[i], shots[i - 1]);
      if (continues) continue;
      const run = shots.slice(runStart, i);
      if (run.length >= 2) {
        const richest = run.reduce((best, s) => (authoredOnly(s[field] || "").length > authoredOnly(best[field] || "").length ? s : best), run[0]);
        const richText = authoredOnly(richest[field] || "").trim();
        if (richText) {
          for (const s of run) {
            const ownAuthored = authoredOnly(s[field] || "").trim();
            if (ownAuthored === richText || ownAuthored.includes(richText)) continue;
            // ── SCENE SETTING FEATURE DRIFT (setting only) ──────────────────
            // Real confirmed defect: a scene established "near a traffic
            // signal, about to cross" and a LATER shot in what reads as the
            // SAME scene (same sameScene() run — an exact scene-label match
            // survives this even when the wording diverges completely)
            // instead described "an empty street" — genuinely different
            // content, not just a thinner version of the same place. The
            // prepend fix just below still applies (the richer text is
            // still injected so the model has SOMETHING correct to draw
            // on), but gluing two DIFFERENT descriptions together doesn't
            // resolve a real content contradiction the way it resolves a
            // genuine thinness gap — flag it explicitly, distinctly, so a
            // repair pass (or a human reviewer) knows this shot's own
            // authored setting didn't just under-describe the room, it
            // described what reads like a different place entirely.
            // Fires ONLY for "setting" (a discrete, checkable place), not
            // "lighting" (mood language legitimately varies shot to shot
            // even in the same room and would false-positive constantly).
            if (field === "setting" && ownAuthored.length >= 15 && tokenOverlapRatio(ownAuthored, richText) < 0.3) {
              issues.push({
                shotId: s.id,
                code: "SCENE_SETTING_FEATURE_DRIFT",
                severity: "warn",
                detail:
                  `This shot's own setting ("${ownAuthored.slice(0, 90)}${ownAuthored.length > 90 ? "…" : ""}") shares ` +
                  `almost no distinctive detail with another shot's in the same scene run ("${richText.slice(0, 90)}` +
                  `${richText.length > 90 ? "…" : ""}") — this reads as a genuinely DIFFERENT place, not just a thinner ` +
                  `description of the same one. If this is really still the same location, rewrite this shot's setting ` +
                  `to keep the same key landmarks/features; if the location has deliberately changed, give it its own ` +
                  `scene rather than reusing this one's label.`,
                autofixed: false,
              });
            }
            // Rebuild from `ownAuthored` (already stripped of any PRIOR
            // scene-lock block by authoredOnly() above), never from the raw
            // s[field] — that's what makes this idempotent. A later pass with
            // a changed richText REPLACES the marker block instead of
            // stacking a second one on top of the first; a later pass with
            // the SAME richText already short-circuited above via the
            // ownAuthored.includes(richText) check and never reaches here.
            const before = ownAuthored;
            s[field] = before ? `${SCENE_LOCK_OPEN}${richText}${SCENE_LOCK_CLOSE} ${before}` : `${SCENE_LOCK_OPEN}${richText}${SCENE_LOCK_CLOSE}`;
            if (before) {
              issues.push({
                shotId: s.id,
                code,
                severity: "warn",
                detail:
                  `This shot's own ${field} ("${before.slice(0, 70)}${before.length > 70 ? "…" : ""}") was thinner ` +
                  `than another shot's in the same scene run ("${richText.slice(0, 70)}${richText.length > 70 ? "…" : ""}"). ` +
                  `Prepended the richer ${field === "setting" ? "spatial" : "lighting"} description so a camera-angle ` +
                  `change in this scene doesn't lose the fixed detail that keeps the ${field === "setting" ? "room recognizable from any angle" : "light source consistent"}.`,
                autofixed: true,
              });
            }
          }
        }
      }
      runStart = i;
    }
  }
  lockSceneField("setting", "SCENE_SETTING_LOCKED");
  lockSceneField("lighting", "SCENE_LIGHTING_LOCKED");

  // ── LOCATION IDENTITY (locationId) ───────────────────────────────────────
  // lockSceneField() above (and sceneAnchorUrl in 4-images.ts) both only see
  // ONE CONTIGUOUS run of same-scene shots — the run resets the moment the
  // scene changes, even if the exact same physical location comes back three
  // shots later. This pass assigns every shot a STABLE locationId shared by
  // every shot recognized as the same place, UNWINDOWED (scanning the whole
  // film, not stopping at a run boundary) — reusing worldState.ts's own
  // getOrCreateLocation()/findLocation() linear-scan-plus-sameScene()
  // matching (createWorldState() here is a fresh, throwaway instance scoped
  // to this one pass, not the `worldState` used elsewhere in
  // compileBreakdown() for per-shot QA tracking — this runs once, up front,
  // over the whole shot list rather than threading through the main
  // per-shot loop). Derived from the group's own richest setting text (same
  // normalize-and-truncate convention as sceneKey() above), not a shot
  // index, so the id stays stable across a later regen_shot/delete_shot/
  // insert_shot recompile as long as the location's own description doesn't
  // change. 3c-locations.ts (location reference sheets) groups shots by this
  // id to find genuinely revisited locations worth a durable reference
  // sheet — that decision is its own job, not this pass's.
  {
    const locState = createWorldState();
    const groups = new Map<string, Shot[]>();
    for (const s of shots) {
      const loc = getOrCreateLocation(locState, s, sameScene);
      const group = groups.get(loc.representativeShotId);
      if (group) group.push(s);
      else groups.set(loc.representativeShotId, [s]);
    }
    for (const group of groups.values()) {
      const richest = group.reduce((best, s) => (authoredOnly(s.setting || "").length > authoredOnly(best.setting || "").length ? s : best), group[0]);
      const richText = authoredOnly(richest.setting || "").trim();
      // CONFIRMED REAL, FIXED: this id is used as a raw filesystem directory
      // name in six places (2b-location-options.ts, 3c-locations.ts — both
      // local disk paths AND the R2 upload key) with no sanitization. A
      // location whose own setting text contains a colon ("Medieval training
      // grounds: dusty open yard...") crashed mkdir on Windows, permanently
      // failing the options job after 3 retries — Windows forbids
      // `< > : " / \ | ? *` and control characters in a path segment.
      // Replacing them (not stripping the id entirely) keeps the id
      // human-legible and keeps 3c-locations.ts's own substring match
      // (`.includes(\`/location-sheet/${locationId}/\`)`) working, since both
      // sides of that comparison derive from this same sanitized value.
      const id = (richText || sceneKey(richest))
        .toLowerCase()
        .slice(0, 60)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
        .replace(/[.\s]+$/, "");
      for (const s of group) s.locationId = id;
    }
  }

  // ── SCENE GEOMETRY NOT ESTABLISHED ───────────────────────────────────────
  // The location reference SHEET above (LOCATION IDENTITY, and 3c-locations.ts)
  // locks a revisited place's visual APPEARANCE, but nothing previously
  // checked whether the film ever stated its fixed LAYOUT in the first place.
  // CONFIRMED REAL: a throne-hall scene never said which way the throne faced
  // relative to the great doors, so an 8-shot scene held on that room had no
  // fixed geometry for later shots to agree with — the renderer invented one,
  // and put the queen behind the commander approaching her instead of facing
  // him. Fuzzy, WARN-only (a regex guessing whether prose states a spatial
  // relationship WILL misfire on legitimate phrasing it doesn't recognize) —
  // flags, never blocks, same severity discipline every other prose-guessing
  // check in this file uses. Scoped to a run of 3+ consecutive same-scene
  // shots — a 1-2 shot scene doesn't hold long enough for an unstated layout
  // to actually drift.
  {
    const SPATIAL_RELATION_RE =
      /\b(facing|faces|opposite|across from|behind|in front of|beside|adjacent to|against the|at the (?:far |near )?end of|on the other side of|to (?:the )?(?:left|right) of|flanking|flanked by|between)\b/i;
    let runStart = 0;
    for (let i = 1; i <= shots.length; i++) {
      const continues = i < shots.length && sameScene(shots[i], shots[i - 1]);
      if (continues) continue;
      const run = shots.slice(runStart, i);
      if (run.length >= 3) {
        const first = run[0];
        const settingText = authoredOnly(first.setting || "");
        if (settingText && !SPATIAL_RELATION_RE.test(settingText)) {
          issues.push({
            shotId: first.id,
            code: "SCENE_GEOMETRY_NOT_ESTABLISHED",
            severity: "warn",
            detail:
              `This location is held for ${run.length} consecutive shots, but this scene's own first shot never ` +
              `states where its key landmarks sit relative to each other (which wall a throne/desk/door backs ` +
              `onto, which direction someone enters from). With no fixed layout stated, later shots have nothing ` +
              `correct to agree with and the renderer is free to invent one, which can put people or landmarks on ` +
              `the wrong side of the room. Add an explicit spatial relationship to this shot's setting (e.g. "the ` +
              `throne faces the doors at the far end of the hall") so every later shot in this scene has a fixed ` +
              `layout to hold to.`,
            autofixed: false,
          });
        }
      }
      runStart = i;
    }
  }

  // ── SPATIAL COMPLEXITY OVERLOAD: MULTIPLE SIMULTANEOUS CHANGES IN ONE SHOT ──
  // A shot that packs several DIFFERENT KINDS of spatial change into one beat
  // — a new character entering the scene AND someone repositioning relative
  // to another person, say — asks the plan (and the render) to treat several
  // independent events as if they were one. Confirmed real, on two different
  // video providers (this pipeline's own Seedance test renders, and an
  // independent Kling test PDF): exactly this kind of packed shot is where
  // "sudden transition" / "suddenly beside him" / "characters reset to a
  // different standing position with no shown transition" complaints
  // concentrate — the render skips straight to an end state because there
  // was never a single, clean event for one continuous take to actually
  // depict. Same root cause MOTION_TOO_DENSE_FOR_DURATION targets (too much
  // for one take), viewed from a different angle: that check counts TIME
  // budget (beats vs seconds), this one counts CATEGORIES of simultaneous
  // change regardless of duration — a 2-second overload and an 8-second one
  // are the same structural problem.
  //
  // STRUCTURAL, NOT A KEYWORD LIST TIED TO ANY SCRIPT'S NOUNS: both classes
  // below detect a VERB/relational-preposition CLASS the same way every
  // other check in this file already does (TRANSITION, HELD_OBJECT_RE,
  // SPATIAL_RELATION_RE just above) — never a character name, location
  // name, or object name. Class 1 additionally cross-checks the shot's own
  // "characters" array against the PREVIOUS shot's (a structural set
  // comparison, not text matching at all) so it only fires for a genuine
  // mid-scene arrival, never a scene's own opening cast.
  {
    // Class 1 signal reuses TRANSITION (defined above, R9's own bridging-
    // beat vocabulary) for "did someone actually enter," deliberately NOT a
    // new regex — a second, slightly different "entrance" pattern here would
    // be exactly the kind of near-duplicate-definitions-that-drift-apart
    // this file's own established discipline (see e.g. HELD_OBJECT_RE's
    // relocation into worldState.ts) warns against.
    //
    // Class 2 — someone repositions relative to ANOTHER named person or the
    // space itself. Requires an explicit relational target (beside/in front
    // of/behind/between/alongside/toward) rather than a bare "moves to
    // stand," which is often just ordinary blocking direction, not a
    // reposition-relative-to-someone event.
    const SPATIAL_REPOSITION_RE =
      /\b(repositions?\s+(?:in front of|behind|beside|next to|between)|moves?\s+to\s+(?:stand|sit)\s+(?:beside|next to|in front of|behind|alongside)|steps?\s+(?:beside|in front of|behind|between|alongside)|circles?\s+(?:around|back)\s+to|crosses?\s+(?:to stand|to face|in front of)|takes?\s+(?:a|their|his|her)\s+place\s+(?:beside|next to|in front of|behind))\b/i;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      const prevShotForSpatial = i > 0 ? shots[i - 1] : undefined;
      const ownText = `${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;

      const enteredMidScene =
        !!prevShotForSpatial &&
        sameScene(s, prevShotForSpatial) &&
        s.characters.some((id) => !prevShotForSpatial.characters.includes(id)) &&
        TRANSITION.test(ownText);
      const repositions = SPATIAL_REPOSITION_RE.test(ownText);

      const changeClasses = [enteredMidScene, repositions].filter(Boolean).length;
      if (changeClasses >= 2) {
        issues.push({
          shotId: s.id,
          code: "SPATIAL_COMPLEXITY_OVERLOAD",
          severity: "warn",
          detail:
            `This shot packs ${changeClasses} different kinds of spatial change into one beat — a character ` +
            `entering the scene AND someone repositioning relative to another person, in the same shot. ` +
            `Confirmed real failure pattern: the render skips straight to the end state with no shown ` +
            `transition, since there was never a single, clean event for one continuous take to depict. Split ` +
            `this into separate shots, one event each — the entrance completing first, then the reposition as ` +
            `its own beat — so every shot asks for only ONE kind of spatial change.`,
          autofixed: false,
        });
      }
    }
  }

  // ── MISSING OFF-SCREEN SOUND CUE ─────────────────────────────────────────
  // CONFIRMED REAL, from the E_new.docx audit: a shot described a character
  // reacting to a shout — the reaction was in the prompt, the sound itself
  // wasn't. This pipeline's audio comes entirely from the video model's own
  // native generation (generate_audio), driven by this SAME text prompt —
  // an implied off-screen sound described only through someone's REACTION to
  // it (not as dialogue, not as an explicit AUDIO: cue — see 5-videos.ts's
  // own earpiece-voice AUDIO: convention, reused here) has no instruction
  // actually telling the model to voice it, so it renders silently.
  // Structural, not a keyword list tied to any script's nouns: a generic
  // sound-event noun class + a generic reaction-verb class, the same
  // verb/noun-CLASS detection method every other check in this file uses.
  // Fuzzy, WARN-only, autofixed:false — a regex guessing whether prose
  // implies an unheard sound WILL misfire on legitimate phrasing it doesn't
  // recognize, same discipline as every other prose-guessing check here.
  {
    const SOUND_EVENT_RE =
      /\b(shouts?|screams?|cr(?:y|ies)|yells?|crash(?:es|ing)?|bangs?|clatters?|clangs?|explosions?|gunshots?|gunfire|horns?\s+blar\w*|sirens?|thuds?|slams?|roars?|screeches?)\b/i;
    const REACTION_TO_SOUND_RE =
      /\b(reacts?\s+to|flinche?s?(?:\s+at)?|startled(?:\s+by)?|jumps?\s+at|turns?\s+toward|glances?\s+toward|head\s+snaps?\s+toward|eyes?\s+(?:dart|cut|flick)(?:s|ed)?\s+toward|whips?\s+around(?:\s+at)?)\b/i;
    const AUDIO_CUE_PRESENT_RE = /\bAUDIO:/i;
    for (const s of shots) {
      const ownText = `${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;
      if (SOUND_EVENT_RE.test(ownText) && REACTION_TO_SOUND_RE.test(ownText) && !AUDIO_CUE_PRESENT_RE.test(ownText)) {
        issues.push({
          shotId: s.id,
          code: "MISSING_OFFSCREEN_SOUND_CUE",
          severity: "warn",
          detail:
            `This shot describes a reaction to what reads as an off-screen sound event, but nothing in the ` +
            `text explicitly tells the video model to actually render that sound — audio here comes entirely ` +
            `from the same text prompt driving the visuals, so an implied-but-unstated sound renders as ` +
            `silence. Add an explicit AUDIO: cue naming the sound (e.g. "AUDIO: a sharp shout rings out from ` +
            `off-screen, urgent and close") the same way this pipeline already does for an off-screen voice.`,
          autofixed: false,
        });
      }
    }
  }

  // ── BACKGROUND HEADCOUNT LOCK ────────────────────────────────────────────
  // castLock (R7, above) only guarantees consistency for NAMED characters —
  // it counts entries in s.characters and locks "exactly N people in frame."
  // It has no idea a shot's prose also said "flanked by two bodyguards" or
  // "a group of four people behind him" — those are unnamed background
  // figures that exist only as a number-word inside free text, so nothing
  // stops shot 3 of the same scene quietly becoming "three bodyguards" or
  // dropping to "his bodyguard" (singular). The world doesn't get to change
  // headcount just because the LLM didn't re-check what it said two shots
  // ago. This scans each shot's description/setting for "<number> <role
  // noun>" (bodyguards, guards, people, etc.), and within each same-scene run
  // (identical run-grouping to the two locks above), whichever shot FIRST
  // establishes a count for a given role noun sets the canonical count for
  // the rest of the run — every later shot's mention of that same role noun
  // gets its number corrected to match, in place, leaving everything else in
  // the sentence untouched. Deliberately does NOT invent a headcount mention
  // in a shot that never mentioned that role at all (unlike the setting/
  // lighting locks, an unnamed background group legitimately can be out of
  // frame or unmentioned in a tight shot — this only stops a stated count
  // from silently drifting once the shot chooses to state one).
  {
    const NUMBER_WORDS: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    };
    // Ordered specific/multi-word first so the alternation (which takes the
    // first alternative that matches at a given position, not the longest)
    // prefers "security guards" over the bare "guards" it contains.
    const ROLE_NOUNS = [
      "security guards", "police officers", "secret service agents", "crew members", "staff members",
      "bodyguards", "henchmen", "gunmen", "soldiers", "officers", "agents", "guards", "cops",
      "servants", "assistants", "aides", "attendants", "onlookers", "bystanders", "pedestrians",
      "dancers", "musicians", "reporters", "photographers", "protesters", "fans", "extras",
      "waiters", "nurses", "doctors", "students", "children", "kids", "guests", "colleagues",
      "men", "women", "people", "figures", "workers",
    ];
    const numberAlt = Object.keys(NUMBER_WORDS).join("|");
    const roleAlt = ROLE_NOUNS.join("|");
    const makeRe = () => new RegExp(`\\b(${numberAlt}|\\d{1,3})\\s+(${roleAlt})\\b`, "gi");
    const toCount = (tok: string) => NUMBER_WORDS[tok.toLowerCase()] ?? parseInt(tok, 10);

    const HEADCOUNT_FIELDS = ["description", "setting"] as const;
    let runStart = 0;
    for (let i = 1; i <= shots.length; i++) {
      const continues = i < shots.length && sameScene(shots[i], shots[i - 1]);
      if (continues) continue;
      const run = shots.slice(runStart, i);
      if (run.length >= 2) {
        const canonical = new Map<string, { token: string; count: number }>();
        for (const s of run) {
          for (const field of HEADCOUNT_FIELDS) {
            const re = makeRe();
            let m: RegExpExecArray | null;
            while ((m = re.exec(s[field] || ""))) {
              const role = m[2].toLowerCase();
              if (!canonical.has(role)) canonical.set(role, { token: m[1], count: toCount(m[1]) });
            }
          }
        }
        if (canonical.size) {
          for (const s of run) {
            for (const field of HEADCOUNT_FIELDS) {
              const before = s[field] || "";
              if (!before) continue;
              let driftedFrom = "";
              const after = before.replace(makeRe(), (whole, numTok: string, roleTok: string) => {
                const canon = canonical.get(roleTok.toLowerCase());
                if (!canon || toCount(numTok) === canon.count) return whole;
                driftedFrom = whole;
                return `${canon.token} ${roleTok}`;
              });
              if (driftedFrom) {
                s[field] = after;
                issues.push({
                  shotId: s.id,
                  code: "BACKGROUND_HEADCOUNT_LOCKED",
                  severity: "warn",
                  detail:
                    `This shot said "${driftedFrom}", but this scene already established a different count for the same ` +
                    `background group earlier — corrected the number so the group stays the same size across the scene.`,
                  autofixed: true,
                });
              }
            }
          }
        }
      }
      runStart = i;
    }
  }

  // ── PROP APPEARANCE / PLACEMENT LOCK ─────────────────────────────────────
  // Confirmed on real output (a nursery scene): the baby monitor changed both
  // its visual look AND its apparent size shot to shot. SINGLE_INSTANCE_PROPS
  // (above) only stops a SECOND instance of a prop from appearing — it says
  // nothing about whether the ONE instance stays the same size, color, and
  // shape, or stays where it was put. This locks a curated set of common
  // "hero" props the same way the two locks above lock setting/lighting:
  // within a same-scene run, the RICHEST description any shot gave a prop —
  // captured as a few words on either side of the noun, covering appearance
  // ("small white ... with a blinking red light") and placement ("... sitting
  // on the shelf") in one pass — becomes canonical. Every other shot
  // mentioning that same prop, whose own mention doesn't already carry that
  // description, gets a dedicated reminder sentence APPENDED (merging it into
  // the shot's own existing prose would be grammatically fragile) restating
  // it explicitly, with an explicit "same size" instruction since that was
  // the exact failure observed. Exempted whenever the shot's own text shows
  // the prop being deliberately picked up, put down, carried, or replaced —
  // that's a real interaction, not drift, and forcing the old description
  // onto it would be wrong. Idempotence: canonical selection reads with our
  // own reminder sentences stripped back out first, so a shot's own injected
  // reminder can never be mistaken for rich AUTHORED text and cascade into
  // longer reminders on every recompile.
  {
    const PROP_NOUNS = [
      "baby monitor", "photo frame", "picture frame", "teddy bear",
      "duffel bag", "duffel", "handbag", "backpack", "bag",
      "crib", "cradle", "bassinet",
      "parcel", "package", "wallet", "purse",
      "smartphone", "phone",
      "mirror", "lamp", "clock", "vase", "candle", "necklace", "watch", "umbrella", "suitcase",
      // RECURRING NON-CHARACTER VISUAL ELEMENTS — llm.ts's own "lock them
      // anyway" section: a baby, pet, corpse, mannequin, or a photographed
      // person never gets a character-sheet entry, so without this the model
      // invents its face fresh every time it's painted. Real cited failure: a
      // baby glimpsed on a monitor screen was visibly a different infant than
      // the one shown in the crib two shots later, in the SAME scene. Same
      // lock mechanism as the objects above — richest description wins,
      // reminder appended, exempted on a real pickup/hand-off.
      "newborn", "infant", "baby", "puppy", "kitten", "dog", "cat", "pet",
      "corpse", "mannequin", "photograph", "photo",
    ];
    const propAlt = PROP_NOUNS.join("|");
    const makePropRe = () => new RegExp(`((?:[A-Za-z']+[ ,]+){0,5})\\b(${propAlt})\\b((?:[ ,]+[A-Za-z']+){0,6})`, "gi");
    const MOVED_NEAR = /\b(picks?\s+up|puts?\s+down|sets?\s+down|places?d?|carr(?:y|ies|ying)|hands?\s+(?:it|the|him|her)|drops?(?:ped)?|moves?\s+it|relocat\w*|swaps?|replac\w*|switch\w*)\b/i;
    const PROP_FIELDS = ["description", "setting", "startFrame", "endFrame"] as const;

    let runStart = 0;
    for (let i = 1; i <= shots.length; i++) {
      const continues = i < shots.length && sameScene(shots[i], shots[i - 1]);
      if (continues) continue;
      const run = shots.slice(runStart, i);
      if (run.length >= 2) {
        const canonical = new Map<string, string>(); // noun -> canonical snippet
        for (const s of run) {
          for (const field of PROP_FIELDS) {
            const re = makePropRe();
            let m: RegExpExecArray | null;
            const authored = authoredOnly(s[field] || "");
            while ((m = re.exec(authored))) {
              const noun = m[2].toLowerCase();
              const snippet = `${m[1]}${m[2]}${m[3]}`.replace(/\s+/g, " ").trim();
              // A pickup/put-down/carry sentence describes the prop CHANGING
              // hands or place, not its stable look -- "the father picks up
              // the baby monitor and carries it to the kitchen counter" must
              // never win as the canonical APPEARANCE description just
              // because it happens to be a long sentence.
              if (MOVED_NEAR.test(snippet)) continue;
              const prev = canonical.get(noun);
              if (!prev || snippet.length > prev.length) canonical.set(noun, snippet);
            }
          }
        }
        for (const [noun, snippet] of canonical) {
          if (snippet.toLowerCase() === noun) continue; // no descriptor beyond the bare noun anywhere in the run -- nothing to lock
          const nounRe = new RegExp(`\\b${noun.replace(/\s+/g, "\\s+")}\\b`, "i");
          const nearRe = new RegExp(`(?:\\b\\w+\\b[ ,]*){0,6}${noun.replace(/\s+/g, "\\s+")}(?:[ ,]*\\b\\w+\\b){0,6}`, "i");
          for (const s of run) {
            const ownText = PROP_FIELDS.map((f) => s[f] || "").join(" ");
            if (!nounRe.test(ownText)) continue; // this shot never mentions the prop -- don't invent it
            if (ownText.toLowerCase().includes(snippet.toLowerCase())) continue; // already carries the canonical description (or already reminded)
            const nearMatch = ownText.match(nearRe);
            if (nearMatch && MOVED_NEAR.test(nearMatch[0])) continue; // a real pickup/put-down/replace -- not drift

            const reminder =
              `The ${noun} here is the SAME object as established earlier in this scene: ${snippet}. ` +
              `Same size, same color, same shape as before — it has not changed appearance or scale.`;
            s.setting = s.setting ? `${s.setting} ${reminder}` : reminder;
            issues.push({
              shotId: s.id,
              code: "PROP_APPEARANCE_LOCKED",
              severity: "warn",
              detail:
                `This shot mentions "${noun}" without the fuller description this scene already established ` +
                `("${snippet.slice(0, 80)}${snippet.length > 80 ? "…" : ""}") — appended a reminder so its size and ` +
                `look don't drift shot to shot.`,
              autofixed: true,
            });
          }
        }
      }
      runStart = i;
    }
  }

  // (7) A SCENE THAT OPENS ALREADY TIGHT — warn only. Rewriting the FIRST shot
  // of a scene is an authorial call (maybe the tight open is deliberate — a
  // hand on a doorknob before the reveal), not a mechanical fact the compiler
  // should overrule the way it overrules a repeated framing. Fires only when
  // this scene run has a genuine follow-on shot (a single cutaway insert has
  // no geography to establish) and the opener itself lands in the "close"
  // bucket with nothing wider before it.
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const prev = i > 0 ? shots[i - 1] : null;
    const nxtInScene = shots[i + 1];
    const isNewSceneStart = !prev || !sameScene(s, prev);
    if (!isNewSceneStart) continue;
    const hasFollowOn = !!nxtInScene && sameScene(s, nxtInScene);
    if (!hasFollowOn) continue;
    if (coarseBucket(framingFamily(s.camera)) !== "close") continue;
    issues.push({
      shotId: s.id,
      code: "SCENE_OPENS_TIGHT",
      severity: "warn",
      detail:
        `This shot opens a new scene run in close framing (camera="${s.camera}"), with no wider shot ` +
        `establishing the space first. A viewer has no geography for what follows. Consider widening this ` +
        `shot, or adding a wide establishing beat before it.`,
      autofixed: false,
    });
  }

  // (8) COVERAGE MONOTONY — a scene living entirely in one size bucket. Tracks
  // a run of CONSECUTIVE shots, within the SAME scene, landing in the same
  // coarse bucket (see coarseBucket() above); on the 3rd shot in one run,
  // breaks it out to the opposite end of the scale. Deterministic autofix at
  // the same confidence level as REPEATED_FRAMING above (shot SIZE is a
  // mechanical property the compiler can judge; WHERE the camera points is
  // not) — this is that same rule's blind spot: REPEATED_FRAMING only ever
  // compares ADJACENT shots and only fires on an exact family repeat, so
  // cu / mcu / cu / mcu... never trips it even though the scene never once
  // cuts wide.
  {
    let bucketRun: "wide" | "med" | "close" | "other" = "other";
    let bucketRunLength = 0;
    let prevForBucket: Shot | null = null;
    for (const s of shots) {
      const bucket = coarseBucket(framingFamily(s.camera));
      const sameRun = bucket !== "other" && bucket === bucketRun && !!prevForBucket && sameScene(s, prevForBucket);
      bucketRunLength = sameRun ? bucketRunLength + 1 : bucket === "other" ? 0 : 1;
      bucketRun = bucket;
      if (bucketRunLength >= 3 && bucket !== "other") {
        const replacement = BUCKET_BREAKOUT[bucket];
        issues.push({
          shotId: s.id,
          code: "COVERAGE_MONOTONY",
          severity: "warn",
          detail:
            `${bucketRunLength} shots in a row have landed in the same "${bucket}" size bucket within one ` +
            `scene — the viewer loses ${bucket === "wide" ? "energy and intimacy" : "geography"} when a scene ` +
            `never varies its coverage. Broke this shot out to ${bucket === "wide" ? "a tighter" : "a wider"} size.`,
          autofixed: true,
        });
        s.camera = replacement;
        bucketRun = coarseBucket(framingFamily(replacement));
        bucketRunLength = 1;
      }
      prevForBucket = s;
    }
  }

  // ── CAMERA MOVE LIBRARY INJECTION ────────────────────────────────────────
  // Runs AFTER REPEATED_FRAMING/CAMERA_CONTINUITY_CHAINED/SCENE_OPENS_TIGHT/
  // COVERAGE_MONOTONY (everything above this point that can still wholesale-
  // rewrite s.camera), same reasoning LENS LIBRARY INJECTION documents just
  // below — and deliberately BEFORE lens, so a shot's final camera text (base
  // authored direction + a named move's rich description) is what lensFor()
  // actually reads framingFamily() off, and lens stays the true last word.
  // Scans the shot's authored motion+description text (matchPace()'s own
  // `text`, not yet in scope here — recomputed the same way) for a move the
  // author already loosely named, then replaces that mention with the full,
  // specific cinematography direction.
  for (const s of shots) {
    const cmText = `${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;
    for (const move of matchCameraMoves(cmText)) {
      if ((s.camera || "").includes(move.marker)) continue; // idempotent across recompiles
      s.camera = s.camera ? `${s.camera}, ${move.description}` : move.description;
    }
  }

  // ── LENS LIBRARY INJECTION ──────────────────────────────────────────────
  // Deliberately the LAST thing to touch shot.camera — see LENS_LIBRARY.json's
  // own note for why: everything above (REPEATED_FRAMING, CAMERA_CONTINUITY_
  // CHAINED, SCENE_OPENS_TIGHT, COVERAGE_MONOTONY, CAMERA MOVE LIBRARY
  // INJECTION) can still rewrite a shot's camera text, and framingFamily() is
  // read off whatever camera text exists AT INJECTION TIME — running this
  // first would key the lens choice off a framing that's about to be
  // overwritten, exactly the trap PACE LIBRARY INJECTION's own comment above
  // documents avoiding for its cameraNote.
  for (const s of shots) {
    const lens = lensFor(s.camera);
    if (!lens) continue;
    if ((s.camera || "").includes(lens.marker)) continue; // idempotent across recompiles
    s.camera = s.camera ? `${s.camera}, ${lens.description}` : lens.description;
  }

  // NEGATIVE-PROMPT RECOMPUTE — R8 (above, in the single-shot loop) computed
  // s.negativePrompt before any of the passes above existed to run: REPEATED_
  // FRAMING, COVERAGE_MONOTONY and the LENS LIBRARY INJECTION all mutate
  // s.camera AFTER that point, which left negativeFor()'s lens-negative lookup
  // (keyed on the FINAL s.camera) working against a stale value the whole
  // first time this ran. negativeFor() is pure and cheap (regex matching over
  // already-computed text), so simply calling it again now, once every camera
  // mutation in this function has happened, is correct and idempotent rather
  // than threading extra state through every pass above.
  for (const s of shots) {
    s.negativePrompt = negativeFor(s, bd.domainPack?.negatives);
  }

  // AMBIENCE RECOMPUTE — this used to be assigned inline in the single-shot
  // loop above, keyed off setting/description AT THAT POINT. SCENE SETTING
  // LOCK and SCENE LIGHTING LOCK (above) can both still enrich a shot's
  // setting after that point — a thin "the kitchen" can gain "...rain
  // hammering the window" prepended from a richer neighbor — and ambienceFor()
  // needs to see that enriched text to pick the right ambience (e.g. a
  // rain/storm ambience) instead of whatever it matched (or fell back to)
  // against the pre-lock, thinner text. Same idempotent-recompute reasoning
  // as the NEGATIVE-PROMPT RECOMPUTE just above: ambienceFor() is pure and
  // cheap, so recomputing once everything it reads has settled is correct.
  // ACOUSTIC SPACE — appended to the SAME s.ambience string, not a separate
  // field, so the SCENE AMBIENCE LOCK block directly below this one already
  // locks it consistently per scene run for free (that block treats
  // s.ambience as one opaque categorical value to compare/lock — no separate
  // lock pass needed). See ACOUSTIC_SPACE_LIBRARY's own comment above for why
  // this is a different axis from the WHAT-sound-is-present pick ambienceFor()
  // makes just above it.
  for (const s of shots) {
    s.ambience = `${ambienceFor(`${authoredOnly(s.setting)} ${authoredOnly(s.description)}`)} ${acousticFor(authoredOnly(s.setting))}`;
  }

  // ── SCENE AMBIENCE LOCK ──────────────────────────────────────────────────
  // ambienceFor() just above is a single CATEGORICAL pick from AMBIENCE_
  // LIBRARY (first matching entry wins, or the fallback) — not a free-text
  // field like setting/lighting. Reusing lockSceneField()'s prepend-the-
  // richest model here would produce contradictory nonsense (a storm
  // ambience description prepended onto a calm-afternoon one); the correct
  // lock for a categorical field is "every shot in one continuous scene gets
  // the SAME pick," not "combine detail." Real gap this closes: setting IS
  // already scene-locked (lockSceneField above), so ambience mostly inherits
  // consistency BY ACCIDENT through that — but description is NOT
  // scene-locked, and ambienceFor() reads description too. A scene's only
  // rain/storm-triggering language living in ONE shot's own unique
  // description (not the shared locked setting) currently reaches only that
  // shot's ambience — room tone should not silently reset to generic just
  // because a later shot's own text didn't happen to restate the rain.
  {
    let runStart = 0;
    for (let i = 1; i <= shots.length; i++) {
      const continues = i < shots.length && sameScene(shots[i], shots[i - 1]);
      if (continues) continue;
      const run = shots.slice(runStart, i);
      if (run.length >= 2) {
        // Prefer the first shot whose ambience is a real, SPECIFIC match —
        // not the library's own generic fallback entry — so a scene's
        // ambience is set by whichever shot actually said the most about
        // its soundscape, not just whichever shot happens to come first.
        const fallback = AMBIENCE_LIBRARY.find((a) => !a.re)?.description ?? "";
        const canonical = run.find((s) => s.ambience && s.ambience !== fallback)?.ambience || run[0].ambience;
        for (const s of run) {
          if (s.ambience === canonical) continue;
          const before = s.ambience;
          s.ambience = canonical;
          issues.push({
            shotId: s.id,
            code: "SCENE_AMBIENCE_LOCKED",
            severity: "warn",
            detail:
              `This shot's own ambience ("${before.slice(0, 70)}${before.length > 70 ? "…" : ""}") didn't match the ` +
              `ambience already established for this scene ("${canonical.slice(0, 70)}${canonical.length > 70 ? "…" : ""}") ` +
              `— room tone (rain, wind, crowd noise, silence) should not change shot to shot within one continuous ` +
              `scene. Locked to match the rest of the scene.`,
            autofixed: true,
          });
        }
      }
      runStart = i;
    }
  }

  // ── SCENE TIME-OF-DAY ACCUMULATED DRIFT ─────────────────────────────────
  // TIME_OF_DAY_JUMP_NO_SKIP (narrative pass, above) only compares ADJACENT
  // shots. A drift spread across 3+ shots in one scene (day in shot 1, a
  // lighting-ambiguous shot 2, night in shot 3) has no adjacent day/night
  // PAIR for that check to catch — shot 1 vs 2 doesn't flip, shot 2 vs 3
  // doesn't flip, but shot 1 and shot 3 directly contradict each other
  // within what's supposed to be one continuous scene. This scans each
  // scene run as a WHOLE: if ANY shot in the run reads as day and ANY OTHER
  // shot in the SAME run reads as night, with no time-skip phrase ANYWHERE
  // in the run, that is the same real defect TIME_OF_DAY_JUMP_NO_SKIP exists
  // to catch, just not limited to one adjacent pair.
  //
  // QUANTIFIED WHERE POSSIBLE: bd.sceneDurations (additive Breakdown field,
  // see types.ts's SceneDurationSchema) carries the breakdown LLM's own
  // estimate of how much STORY time a scene spans. Where a scene run has a
  // matching entry, a day/night contradiction is only flagged if the
  // estimated duration is TOO SHORT for a real transition to plausibly
  // happen (see MIN_MINUTES_FOR_DAY_NIGHT_TRANSITION below) — a stakeout or
  // a long dinner scene genuinely CAN run from afternoon into evening, and a
  // stated duration long enough to make that plausible should not be
  // flagged as a defect. Where no entry exists (old data, or the LLM omitted
  // it for this scene), falls back to the ORIGINAL qualitative-only
  // behavior, unchanged: any contradiction, regardless of duration.
  {
    // Real-world floor for a PERCEPTIBLE day-to-night shift with no
    // transition shown: even a fast dusk (civil twilight) genuinely visible
    // on camera takes on the order of 30-60 minutes in most locations/
    // seasons. Below this, "day" and "night" in the same continuous scene
    // with no time-skip beat is not a plausible unscripted transition — it's
    // a continuity error. At or above it, treat it as plausible (the
    // scene's own stated duration is the story's justification) and don't
    // flag a defect that quantified evidence contradicts.
    const MIN_MINUTES_FOR_DAY_NIGHT_TRANSITION = 45;
    const normalizeSceneLabel = (x: string) => (x || "").trim().toLowerCase().slice(0, 60);
    const sceneDurationByKey = new Map<string, number>();
    for (const sd of bd.sceneDurations ?? []) {
      sceneDurationByKey.set(normalizeSceneLabel(sd.sceneKey), sd.estimatedMinutes);
    }

    let runStart = 0;
    for (let i = 1; i <= shots.length; i++) {
      const continues = i < shots.length && sameScene(shots[i], shots[i - 1]);
      if (continues) continue;
      const run = shots.slice(runStart, i);
      if (run.length >= 2) {
        const litTextFor = (s: Shot) => `${authoredOnly(s.motion)} ${authoredOnly(s.description)} ${authoredOnly(s.lighting)}`;
        const dayShot = run.find((s) => DAY_SIGNAL.test(litTextFor(s)));
        const nightShot = run.find((s) => NIGHT_SIGNAL.test(litTextFor(s)));
        const skipShown = run.some((s) => TIME_SKIP_PHRASE.test(litTextFor(s)));
        if (dayShot && nightShot && dayShot.id !== nightShot.id && !skipShown) {
          const estimatedMinutes = sceneDurationByKey.get(sceneKey(run[0]));
          const isQuantified = estimatedMinutes !== undefined;
          const implausible = !isQuantified || estimatedMinutes < MIN_MINUTES_FOR_DAY_NIGHT_TRANSITION;
          if (implausible) {
            issues.push({
              shotId: nightShot.id,
              code: "WORLD_STATE_TIME_DRIFT",
              severity: "warn",
              detail: isQuantified
                ? `This shot reads as nighttime, but shot "${dayShot.id}" earlier in the SAME continuous scene reads ` +
                  `as daytime — and this scene is estimated to span only ~${estimatedMinutes} minute` +
                  `${estimatedMinutes === 1 ? "" : "s"} of story time, not enough for day to plausibly become night ` +
                  `with no time-skip shown. Either add an explicit time-skip beat, extend the scene's real duration, ` +
                  `or make this shot's lighting consistent with the rest of the scene.`
                : `This shot reads as nighttime, but shot "${dayShot.id}" earlier in the SAME continuous scene reads ` +
                  `as daytime — with no time-skip phrase anywhere in this scene, and no single adjacent day/night cut ` +
                  `for the ordinary continuity check to catch (the drift happened gradually across several shots, not ` +
                  `one jump). A viewer has no way to tell whether hours quietly passed mid-scene or this is a ` +
                  `continuity error. Either add an explicit time-skip beat, or make this shot's lighting consistent ` +
                  `with the rest of the scene.`,
              autofixed: false,
            });
          }
        }
      }
      runStart = i;
    }
  }

  // ── SCENE WEATHER CONSISTENCY ────────────────────────────────────────────
  // Same shape as the time-of-day drift check just above, for weather
  // instead of light level — real gap: nothing previously checked that a
  // scene's weather stayed consistent shot to shot at all, adjacent or not.
  // Deliberately SCENE-scoped only (does NOT survive scene boundaries the
  // way prop-carry/location-state below do): unlike a held prop or a door's
  // state, there is no reliable text signal for "is this the same outdoor
  // space as the last scene" versus a genuinely different place or an
  // indoor cut where weather doesn't even apply — carrying weather across a
  // scene boundary risked flagging an indoor office scene for not
  // mentioning rain that was only ever true of the street outside it.
  {
    const WEATHER_RAIN = /\b(rain\w*|storm\w*|downpour|drizzl\w*|thunder\w*)\b/i;
    const WEATHER_CLEAR = /\b(sunny|clear sky|bright sun\w*|cloudless)\b/i;
    const WEATHER_SNOW = /\b(snow\w*|blizzard|flurr(?:y|ies))\b/i;
    const WEATHER_FOG = /\b(fog\w*|mist\w*|hazy)\b/i;
    const WEATHER_CHANGE_PHRASE =
      /\b(weather (?:clears?|changes?|turns?)|rain (?:stops?|clears?|lets? up)|sun (?:comes? out|breaks? through)|storm (?:passes?|clears?)|snow (?:stops?|clears?))\b/i;
    const WEATHER_KINDS: [string, RegExp][] = [
      ["rain/storm", WEATHER_RAIN], ["clear/sunny", WEATHER_CLEAR], ["snow", WEATHER_SNOW], ["fog/mist", WEATHER_FOG],
    ];
    let runStart = 0;
    for (let i = 1; i <= shots.length; i++) {
      const continues = i < shots.length && sameScene(shots[i], shots[i - 1]);
      if (continues) continue;
      const run = shots.slice(runStart, i);
      if (run.length >= 2) {
        const textFor = (s: Shot) => `${authoredOnly(s.setting)} ${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;
        const matches: { label: string; shot: Shot }[] = [];
        for (const s of run) {
          for (const [label, re] of WEATHER_KINDS) {
            if (re.test(textFor(s))) { matches.push({ label, shot: s }); break; } // first weather kind mentioned wins for this shot
          }
        }
        const distinctLabels = new Set(matches.map((m) => m.label));
        const changeShown = run.some((s) => WEATHER_CHANGE_PHRASE.test(textFor(s)));
        if (distinctLabels.size >= 2 && !changeShown) {
          const first = matches[0];
          const conflicting = matches.find((m) => m.label !== first.label)!;
          issues.push({
            shotId: conflicting.shot.id,
            code: "WORLD_STATE_WEATHER_DRIFT",
            severity: "warn",
            detail:
              `This shot's weather ("${conflicting.label}") contradicts shot "${first.shot.id}" earlier in the ` +
              `SAME continuous scene ("${first.label}"), with no weather-change phrase anywhere in this scene. ` +
              `Weather should not silently flip within one continuous scene. Either add an explicit change ` +
              `("the rain lets up", "the sun breaks through"), or make this shot's weather consistent with the ` +
              `rest of the scene.`,
            autofixed: false,
          });
        }
      }
      runStart = i;
    }
  }

  // ── WORLD-STATE LOCATION FLAGS (door/light/window) ──────────────────────
  // Extends the SAME "survives scene boundaries" principle as
  // WORLD_STATE_PROP_CARRY (single-shot loop, above) to binary environmental
  // state — a door left open, a light left on, a window left open — real
  // gap: nothing previously tracked these AT ALL, adjacent or not. Unlike
  // props (tied to a CHARACTER), these are tied to a LOCATION, so this
  // reuses sameScene()'s own fuzzy "is this the same physical place" test
  // directly against a running list of locations already seen, rather than
  // partitioning into scene RUNS (a location can legitimately be revisited
  // after other scenes shot elsewhere — a return to the same room later in
  // the film — which a contiguous-run partition would treat as unrelated).
  // Detects CONTRADICTIONS specifically (a shot flatly asserting the
  // opposite of an already-established state, in the same real location,
  // with no transition action shown) rather than reminding on every silent
  // shot the way prop-carry does — a scene simply not mentioning the door at
  // all is normal and not itself a defect; asserting it's now closed when
  // it was left open, with no one shown closing it, is the real bug.
  {
    const LOCATION_FLAGS: { key: string; label: string; onRe: RegExp; offRe: RegExp; states: [string, string] }[] = [
      {
        key: "door", label: "door",
        onRe: /\bdoor\b(?:[^.]{0,25})\b(open|opens|opened|ajar|swings? open)\b/i,
        offRe: /\bdoor\b(?:[^.]{0,25})\b(closed|shuts?|shut|swings? shut)\b/i,
        states: ["open", "closed"],
      },
      {
        key: "light", label: "light",
        onRe: /\blights?\b(?:[^.]{0,25})\b(on|switched on|turns? on|flicks? on|flip\w* on)\b/i,
        offRe: /\blights?\b(?:[^.]{0,25})\b(off|switched off|turns? off|flicks? off|flip\w* off)\b/i,
        states: ["on", "off"],
      },
      {
        key: "window", label: "window",
        onRe: /\bwindow\b(?:[^.]{0,25})\b(open|opens|opened|ajar)\b/i,
        offRe: /\bwindow\b(?:[^.]{0,25})\b(closed|shuts?|shut)\b/i,
        states: ["open", "closed"],
      },
    ];
    // MIGRATED (world-state migration, step 2) — KnownLocation/knownLocations/
    // findLocation relocated to worldState.ts's LocationWorldState/
    // findLocation/getOrCreateLocation. Same sameScene()-based linear-scan
    // lookup as before, just sourced from the shared worldState object
    // (already created near the top of this function — see the world-state
    // migration step 1 comment there) instead of a block-local array only
    // this check could see.
    for (const s of shots) {
      const text = `${authoredOnly(s.setting)} ${authoredOnly(s.motion)} ${authoredOnly(s.description)} ${authoredOnly(s.startFrame)} ${authoredOnly(s.endFrame)}`;
      const loc = getOrCreateLocation(worldState, s, sameScene);
      for (const flag of LOCATION_FLAGS) {
        const onMatch = flag.onRe.test(text);
        const offMatch = flag.offRe.test(text);
        const known = loc.flags.get(flag.key);
        // A shot stating BOTH ("opens the door and it swings shut behind
        // him") is a real transition, not a contradiction — only a shot
        // asserting the SINGLE opposite state with no transition verb at
        // all is the defect this check exists to catch.
        if (onMatch && !offMatch) {
          if (known && known.state === flag.states[1] && known.shotId !== s.id) {
            issues.push({
              shotId: s.id,
              code: "WORLD_STATE_LOCATION_CONTRADICTION",
              severity: "warn",
              detail:
                `This shot's ${flag.label} is "${flag.states[0]}", but shot "${known.shotId}" — at what reads as ` +
                `the SAME location, possibly a different scene — already established the ${flag.label} as ` +
                `"${flag.states[1]}", with nothing shown changing it back. Either show the transition, or make ` +
                `this shot's ${flag.label} state consistent with what was last established there.`,
              autofixed: false,
            });
          }
          loc.flags.set(flag.key, { state: flag.states[0], shotId: s.id });
        } else if (offMatch && !onMatch) {
          if (known && known.state === flag.states[0] && known.shotId !== s.id) {
            issues.push({
              shotId: s.id,
              code: "WORLD_STATE_LOCATION_CONTRADICTION",
              severity: "warn",
              detail:
                `This shot's ${flag.label} is "${flag.states[1]}", but shot "${known.shotId}" — at what reads as ` +
                `the SAME location, possibly a different scene — already established the ${flag.label} as ` +
                `"${flag.states[0]}", with nothing shown changing it. Either show the transition, or make this ` +
                `shot's ${flag.label} state consistent with what was last established there.`,
              autofixed: false,
            });
          }
          loc.flags.set(flag.key, { state: flag.states[1], shotId: s.id });
        }
      }
    }
  }

  // ── RELATIVE CHARACTER POSITION LOCK (front/behind) ─────────────────────
  // Extends the SAME "survives scene boundaries via sameScene()" principle
  // the door/light/window WORLD-STATE LOCATION FLAGS just above use, to a
  // character PAIR's relative position in the scene's own choreography —
  // who is in FRONT of whom, who is BEHIND whom — rather than a fixed
  // environmental fact. Real confirmed defect: two characters' front/behind
  // order flipped inconsistently partway through a scene, with nothing
  // shown (an overtake, one stopping) explaining the change. Deliberately
  // scoped to EXACTLY two characters in a shot (same attribution-confidence
  // discipline as every other per-character autofix in this file — a bare
  // regex match against 3+ names can't reliably say WHO is ahead of WHOM),
  // and to explicit "ahead of/in front of/leads" vs "behind/trailing/
  // follows" language naming BOTH characters, not a vague single-character
  // "walks forward" a reader would need to infer a comparison from.
  {
    for (const s of shots) {
      if (s.characters.length !== 2) continue;
      const text = `${authoredOnly(s.setting)} ${authoredOnly(s.motion)} ${authoredOnly(s.description)}`;
      const pair = extractAheadPair(text, s.characters[0], s.characters[1], characters);
      if (!pair) continue;
      const loc = getOrCreateLocation(worldState, s, sameScene);
      const pairKey = [...s.characters].sort().join("|");
      const known = loc.positions.get(pairKey);
      if (known && known.aheadId !== pair.aheadId && known.shotId !== s.id && !OVERTAKE_WORDS.test(text)) {
        const aheadName = characters.find((c) => c.id === pair.aheadId)?.name ?? pair.aheadId;
        const behindName = characters.find((c) => c.id === pair.behindId)?.name ?? pair.behindId;
        issues.push({
          shotId: s.id,
          code: "RELATIVE_POSITION_FLIPPED",
          severity: "warn",
          detail:
            `This shot puts ${aheadName} ahead of ${behindName}, but shot "${known.shotId}" — at what reads as ` +
            `the SAME location — already established the OPPOSITE order, with nothing shown (an overtake, one ` +
            `slowing or stopping) explaining the change. Either show one character actually passing the other, ` +
            `or keep this shot's front/behind order consistent with what was last established there.`,
          autofixed: false,
        });
      }
      loc.positions.set(pairKey, { aheadId: pair.aheadId, shotId: s.id });
    }
  }

  // COLOR PALETTE — locked ONCE for the whole project's life. If bd already
  // carries one (a recompile of an existing project — repair loop, shot
  // regen), keep it (and its matching ffmpeg filter) exactly as-is;
  // recomputing on every compile could pick a DIFFERENT palette as shots are
  // edited, defeating the entire point of a whole-film-consistent grade.
  const picked = bd.colorPalette ? { description: bd.colorPalette, ffmpegFilter: bd.colorGradeFilter } : pickColorPalette(bd);
  const colorPalette = picked.description;
  const colorGradeFilter = picked.ffmpegFilter;

  // ── RUNNING TIMECODES ────────────────────────────────────────────────────
  // See Shot.timecodeStart/timecodeEnd's own comment in types.ts. Last thing
  // this function does — every shot's real screenSeconds is only final once
  // every pass above (duration clamping, the sub-4s floor-and-trim rule,
  // library injections that never touch duration/screenSeconds anyway) has
  // run. `elapsed` accumulates the TRUE fractional total; only the DISPLAYED
  // checkpoint is rounded, never a rounded intermediate re-summed — rounding
  // each shot's own duration independently and adding those would drift the
  // running total away from the real cumulative time over many shots (the
  // same "largest remainder" class of error proportional seat allocation
  // has to avoid), which is exactly wrong for a timeline that must always
  // read consistently end to end.
  let elapsed = 0;
  for (const s of shots) {
    const onScreen = s.screenSeconds > 0 ? s.screenSeconds : s.duration;
    s.timecodeStart = formatTimecode(elapsed);
    elapsed += onScreen;
    s.timecodeEnd = formatTimecode(elapsed);
  }

  return { breakdown: { ...bd, characters, shots, colorPalette, colorGradeFilter }, issues, pendingActionInferences, pendingStagingInferences };
}

/**
 * Fuzzy warns worth ONE repair round: they never block a run, but a cheap LLM
 * rewrite usually fixes them for real (a "hiding" beat becomes a break-from-cover
 * action; a dubious keyframe becomes a photographable pose).
 */
// ACTION_NEVER_COMPLETES, POINTLESS_BUSINESS, and REDUNDANT_HANDOFF are
// deliberately NOT in this set anymore (moved to "error"/blocking at their
// own call sites, 2026-08-02, after all three were confirmed producing real,
// visible defects that survived a full repair loop as warn and shipped
// anyway) — blockingErrors() already includes them unconditionally, so
// leaving them here too would double-count them in repairShots()' target
// list (once via blockers, once via this set) and send the same shot to the
// repair LLM twice in one batch.
export const REPAIRABLE_WARN_CODES = new Set([
  // AUDIT FIX: these 3 codes are pushed with severity:"warn", autofixed:false
  // — the shape of every OTHER entry in this set — but were confirmed
  // missing from it, meaning the repair loop (1-breakdown.ts) would never
  // select them for a fix. They fired, printed once, and accumulated as
  // permanent, un-repaired noise on every render that hit them.
  "SCREEN_DIRECTION_FLIP",
  "THRESHOLD_TRANSITION_SKIPPED",
  "SCENE_OPENS_TIGHT",
  "STATIC_STATE_BEAT",
  "KEYFRAME_MAYBE_NOT_PHOTOGRAPHABLE",
  "ENDPOINTS_MAYBE_TOO_SIMILAR",
  "MOTION_TOO_THIN_FOR_NATURAL",
  "MOTION_TOO_DENSE_FOR_DURATION",
  "DIALOGUE_TIMING_MISMATCH",
  "ENDFRAME_ACTION_NOT_IN_MOTION",
  "STAGING_RULE_VIOLATION",
  "STAGING_RULE_VIOLATION_SCENE_WIDE",
  "BREAKDOWN_HEADCOUNT_CONTRADICTION",
  "NPC_MISSING_CHARACTER_ENTRY",
  "MISSING_HANDOFF_SHOT",
  "CHARACTER_PRESENCE_GAP",
  "CRICKET_ROLE_ACTION_MISMATCH",
  // A LINE OF THE SCRIPT'S OWN DIALOGUE NEVER MADE IT INTO THE FILM.
  // checkScriptDialogueCoverage() / checkTranslatedDialogueCoverage() have
  // always DETECTED this, but the code was missing from this set, so the repair
  // loop never selected it: the warning printed once and the line stayed gone.
  // That is the most consequential thing a breakdown can silently drop — the
  // words the writer actually wrote — and it is squarely repairable, because
  // both checks hand the repair model the exact missing line (or, for a
  // translated film, the exact count that is short) plus explicit instructions
  // on where to put it back.
  "SCRIPT_DIALOGUE_LINE_DROPPED",
  "THROW_NEVER_CAUGHT",
  "NARRATIVE_GAP_NEEDS_TRANSITION",
  "TIME_OF_DAY_JUMP_NO_SKIP",
  "WORLD_STATE_TIME_DRIFT",
  "WORLD_STATE_WEATHER_DRIFT",
  "WORLD_STATE_LOCATION_CONTRADICTION",
  "WORLD_STATE_ACTION_CONTRADICTION",
  "WORLD_STATE_PROP_NO_ORIGIN",
  "PROP_APPEARS_WITHOUT_INTRODUCTION",
  "PROP_VANISHED_WITHIN_SHOT",
  "SCREEN_POSITION_FLIPPED",
  "THRESHOLD_NOT_CROSSED",
  "CHARACTER_APPEARS_UNINTRODUCED",
  "REFLECTION_NEEDS_COMPOSITION",
  "DUPLICATE_DIALOGUE_ADJACENT",
  "SCREEN_INSERT_OVERUSE",
  "STIMULUS_NEEDS_NOTICE_CUE",
  "REDUNDANT_CROSSING",
  "REDUNDANT_SCREEN_INSERT",
  "DEPARTURE_NEVER_SEPARATES",
  "FLAT_GENERIC_WIDE_FRAMING",
  "SCENE_SETTING_FEATURE_DRIFT",
  "RELATIVE_POSITION_FLIPPED",
  "SCRIPT_DIALOGUE_LINE_DROPPED",
  "SOLO_SHOT_IMPLIES_SECOND_BODY",
  // CONFIRMED REAL GAP, found auditing this set against every code that
  // actually pushes with severity:"warn", autofixed:false (the shape every
  // OTHER entry here has): SCENE_GEOMETRY_NOT_ESTABLISHED was pushed but
  // never added to this set, so it fired and printed every time without the
  // repair loop ever once attempting it — the exact same class of bug this
  // file's own MOTION_REDEPICTS_COMPLETED_ACTION comment already documents.
  "SCENE_GEOMETRY_NOT_ESTABLISHED",
  // Spatial-complexity audit (see its own push site above) — a shot packing
  // 2+ simultaneous kinds of spatial change needs a genuine split, same
  // shape of fix as MOTION_TOO_DENSE_FOR_DURATION; also added to
  // MAY_ADD_SHOTS in llm.ts's repairShots() for that reason.
  "SPATIAL_COMPLEXITY_OVERLOAD",
  // Missing off-screen sound cue (see its own push site above) — a plain
  // text enrichment of the EXISTING shot, never needs a new shot, so unlike
  // its two neighbors above it does NOT need a MAY_ADD_SHOTS entry in
  // llm.ts.
  "MISSING_OFFSCREEN_SOUND_CUE",
  // ACTION_DURATION_OFF_LIBRARY (see its own push site above, R7.6c) — a
  // plain duration/text enrichment of the EXISTING shot, same shape as
  // MOTION_TOO_THIN_FOR_NATURAL just above it in compiler.ts; never needs a
  // new shot. Added here on the strength of this session's own confirmed
  // lesson (see the MOTION_REDEPICTS_COMPLETED_ACTION comment just below):
  // a code that pushes an issue but is missing from this set fires and
  // prints, forever, with the repair loop never once attempting it — this
  // is written into the same commit that adds the check, not after.
  "ACTION_DURATION_OFF_LIBRARY",
  // CONFIRMED REAL FAILURE, visually verified on a real render: this code was
  // never in this set at all, so the repair loop never once attempted it,
  // regardless of budget — a shot re-performing an action its own predecessor's
  // endFrame already completed (the "opens outward, then opens inward again"
  // door repeat a user reported) was detected every time and fixed never.
  "MOTION_REDEPICTS_COMPLETED_ACTION",
  // ACTION_NEVER_COMPLETES, POINTLESS_BUSINESS, REDUNDANT_HANDOFF: briefly
  // escalated to "error" (removed from this set) the same day they were
  // confirmed producing real visible defects, then reverted back to warn
  // here — the user wants a full, flagged render to visually verify today's
  // real root-cause fixes before re-deciding whether to block on these again.
  "ACTION_NEVER_COMPLETES",
  "POINTLESS_BUSINESS",
  "REDUNDANT_HANDOFF",
  // CULLED_CHARACTER_STILL_IN_PROSE is DELIBERATELY NOT here — it went
  // further than a warn+repair demotion. It's now autofixed:true at its own
  // push site (above, in the per-shot loop): the compiler adds the missing
  // character to the shot's cast itself instead of asking the repair LLM to
  // decide. autofixed:true issues never reach this set's `!i.autofixed`
  // filter anyway, so listing it here would be dead weight.
]);

/** Hard gate. Non-empty ⇒ do NOT spend. Only STRUCTURAL errors land here. */
export function blockingErrors(issues: CompileIssue[]): CompileIssue[] {
  return issues.filter((i) => i.severity === "error" && !i.autofixed);
}

/** Pretty-print for the console (and, later, the UI). */
export function printIssues(issues: CompileIssue[]): void {
  if (!issues.length) {
    console.log("🎬  Director's notes: clean.\n");
    return;
  }
  console.log("\n🎬  Director's notes:");
  for (const i of issues) {
    const mark = i.autofixed ? "🔧 fixed" : i.severity === "error" ? "🛑 BLOCK" : "⚠️  warn ";
    console.log(`  ${mark}  [${i.shotId}] ${i.code}`);
    console.log(`            ${i.detail}`);
  }
  console.log("");
}