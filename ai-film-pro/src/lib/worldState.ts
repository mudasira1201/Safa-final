// src/lib/worldState.ts
// -----------------------------------------------------------------------------
// UNIFIED WORLD-STATE MODEL — migration in progress, one tracker at a time.
// See the design document (this project's own session history) for the full
// rationale: compiler.ts had accumulated several PARALLEL, independently-
// invented trackers (heldByCharacter, knownLocations, stagingScenes,
// posLocations, characterSpatialState) — each solving one specific
// consistency problem, each with its own Map, each populated by its own
// slightly different rule for when it runs. A wiring audit confirmed the
// real cost of that: the biggest gap found wasn't "detection logic is too
// weak", it was "some of these trackers are silently never invoked for a
// real, common shot shape" (multi-character shots with no characterActions
// attribution skip the ENTIRE action-precondition system, for example).
//
// This file is the single, canonical per-film world-state representation
// those trackers are being migrated INTO, incrementally. Each migration
// step:
//   1. Extends this file's schema with exactly the fields that one tracker
//      needs (never all of them speculatively upfront).
//   2. Adds a buildWorldState() extraction step for that tracker's own
//      state, reusing the SAME detection regexes the old tracker used
//      (this is a RELOCATION of working logic, not a rewrite of it).
//   3. Is validated by a parallel-run test comparing the OLD tracker's
//      output against the NEW WorldState-based output on the full existing
//      regression suite before compiler.ts's real logic is ever switched
//      over.
// Only after a migration step's parallel-run passes does compiler.ts's own
// per-shot loop get changed to read/write this file instead of its own
// local Map — and the old Map is deleted in that SAME change, never left
// running alongside the new path in production (that's what the parallel-
// run TEST is for, not a permanent dual-write in the real compile path).
// -----------------------------------------------------------------------------

import type { Shot } from "../types";
import type { StagingRule } from "./stagingLibrary";
import { type SpatialState, initialSpatialState } from "./actionLibrary";

/** One character's tracked state, as of a given point in the shot timeline.
 *  Fields are added ONE MIGRATION STEP AT A TIME — see the migration-step
 *  comment on each field for which tracker it replaces and when it landed. */
export interface CharacterWorldState {
  characterId: string;
  /** MIGRATION STEP 1 (heldByCharacter → here). The single object this
   *  character is currently tracked as holding/carrying, or null if none —
   *  kept as a single value, not a Set, in this first migration so its
   *  behavior is a byte-for-byte relocation of heldByCharacter's own
   *  existing single-string-per-character semantics. (The design document's
   *  proposed generalization to multiple simultaneously-held objects is a
   *  real, separately-scoped improvement — deliberately NOT bundled into
   *  this migration step, which is a relocation, not an enhancement, so a
   *  parallel-run comparison against the OLD tracker stays meaningful.) */
  holding: string | null;
  /** MIGRATION STEP 5 (characterSpatialState → here). Threshold side,
   *  posture, near-object, and vehicle occupancy — see actionLibrary.ts's
   *  own top-of-file comment for the full picture. `null` until the first
   *  action involving this character sets it (matches the old Map's
   *  "absent key" semantics; callers use getSpatialState()'s fallback to
   *  initialSpatialState(), never read this field directly). */
  spatial: SpatialState | null;
  /** MIGRATION STEP 5, NEW (not a relocation) — closes Finding A (the
   *  wiring-audit-confirmed gap: a multi-character shot with no
   *  characterActions attribution used to skip action-precondition
   *  validation ENTIRELY, logging a warning and nothing else). "attributed"
   *  means this state came from a confident, per-character-attributed (or
   *  unambiguous single-character) action — the ONLY kind the old system
   *  ever tracked. "inferred-shared" means it came from the new fallback
   *  below: a multi-character shot's WHOLE combined text matched an action,
   *  with no reliable way to say which present character it belongs to, so
   *  the plausible candidate's state was advanced anyway rather than the
   *  shot being skipped outright — a real but lower-confidence data point.
   *  `null` alongside `spatial: null` — no action has touched this
   *  character yet. Consumers that want to treat inferred-shared state more
   *  cautiously than an attributed one can read this field; the migration
   *  itself doesn't yet make that distinction anywhere (see the fallback's
   *  own comment in compiler.ts for exactly how it's used today). */
  spatialConfidence: "attributed" | "inferred-shared" | null;
}

/** MIGRATION STEP 2 (knownLocations → here). A physical location's tracked
 *  binary environmental flags (door/light/window open-closed, etc.) — same
 *  shape as the old KnownLocation interface, just relocated. `representative`
 *  is kept (not just the id) because location matching is done via the
 *  CALLER's sameScene(a, b) fuzzy comparison, which needs a real Shot to
 *  compare against, exactly like the original KnownLocation did. */
export interface LocationWorldState {
  representativeShotId: string;
  representative: Shot;
  flags: Map<string, { state: string; shotId: string }>;
  /** MIGRATION STEP 3 (posLocations → here). Same "one location, several
   *  kinds of facts recorded there" shape as `flags` above — relocated onto
   *  the SAME LocationWorldState record rather than a separate parallel
   *  array, since posLocations's own old shape (an array of locations found
   *  via sameScene(), each holding a lookup keyed by something) was already
   *  structurally identical to knownLocations's. Keyed by the sorted
   *  "idA|idB" character pair, exactly like the old PositionLocation.pairs
   *  Map was. */
  positions: Map<string, { aheadId: string; shotId: string }>;
  /** MIGRATION STEP 4 (stagingScenes → here). Same "one location, several
   *  kinds of facts recorded there" shape as `flags`/`positions` above.
   *  Keyed by the staging rule's own `label`, exactly like the old
   *  StagingSceneState.established Map was. */
  staging: Map<string, { rule: StagingRule; shotId: string }>;
}

/** One shot's worth of world-state, threaded through the per-shot compile
 *  loop as it processes shots in order — this is NOT a full per-film
 *  snapshot array yet (that arrives once enough trackers have migrated that
 *  building the whole timeline upfront, before any check runs, is actually
 *  the better shape — see the design document's own step-5 note that later
 *  migrations may want a real WorldStateSnapshot[] timeline). For now, each
 *  migrated tracker keeps updating ONE mutable WorldState object in place,
 *  shot by shot, exactly the same access pattern heldByCharacter/
 *  knownLocations/etc. already use — this file just gives that pattern one
 *  shared home instead of N independently-invented ones. */
export interface WorldState {
  charactersById: Map<string, CharacterWorldState>;
  /** MIGRATION STEP 2. A flat, in-order array of locations seen so far —
   *  same shape/lookup pattern as the old knownLocations array (linear scan
   *  + sameScene(), not a hash map, because "is this the same place" is a
   *  fuzzy comparison, not an exact key lookup). */
  locations: LocationWorldState[];
}

export function createWorldState(): WorldState {
  return { charactersById: new Map(), locations: [] };
}

/** MIGRATION STEP 2. sameScene is passed in rather than imported, deliberately
 *  — compiler.ts's own sameScene(a, b) is a module-local function there, and
 *  worldState.ts is meant to stay a leaf module with no dependency back on
 *  compiler.ts (avoiding a circular import). Same relocation discipline as
 *  everywhere else in this file: this is the EXACT same linear-scan lookup
 *  the old knownLocations array used, not a new algorithm. */
export function findLocation(
  state: WorldState,
  shot: Shot,
  sameScene: (a: Shot, b: Shot) => boolean,
): LocationWorldState | undefined {
  return state.locations.find((loc) => sameScene(loc.representative, shot));
}

/** Returns the existing location for this shot (via findLocation) or creates
 *  and registers a new one, exactly matching the old knownLocations block's
 *  own "if (!loc) { loc = {...}; knownLocations.push(loc); }" logic. */
export function getOrCreateLocation(
  state: WorldState,
  shot: Shot,
  sameScene: (a: Shot, b: Shot) => boolean,
): LocationWorldState {
  const existing = findLocation(state, shot, sameScene);
  if (existing) return existing;
  const created: LocationWorldState = { representativeShotId: shot.id, representative: shot, flags: new Map(), positions: new Map(), staging: new Map() };
  state.locations.push(created);
  return created;
}

function getOrCreateCharacter(state: WorldState, characterId: string): CharacterWorldState {
  let c = state.charactersById.get(characterId);
  if (!c) {
    c = { characterId, holding: null, spatial: null, spatialConfidence: null };
    state.charactersById.set(characterId, c);
  }
  return c;
}

export function getHolding(state: WorldState, characterId: string): string | null {
  return state.charactersById.get(characterId)?.holding ?? null;
}

export function setHolding(state: WorldState, characterId: string, object: string | null): void {
  getOrCreateCharacter(state, characterId).holding = object;
}

/** MIGRATION STEP 5. Matches characterSpatialState's old
 *  `.get(charId) ?? initialSpatialState()` fallback exactly — a character
 *  with no tracked spatial state yet is indistinguishable from one whose
 *  state is all-default, same as before. */
export function getSpatialState(state: WorldState, characterId: string): SpatialState {
  return state.charactersById.get(characterId)?.spatial ?? initialSpatialState();
}

export function setSpatialState(
  state: WorldState,
  characterId: string,
  spatial: SpatialState,
  confidence: "attributed" | "inferred-shared",
): void {
  const c = getOrCreateCharacter(state, characterId);
  c.spatial = spatial;
  c.spatialConfidence = confidence;
}

// ── SHARED DETECTION VOCABULARY (Migration Step 1) ─────────────────────────
// RELOCATED VERBATIM from compiler.ts's own module scope — same regexes, same
// behavior, not a rewrite. Kept here so the new WorldState-based check and
// the (temporarily still-present, being validated against) old
// heldByCharacter-based check share ONE definition during the parallel-run
// period, the same anti-drift reasoning BT709_TAGGING_ARGS/CASTLOCK_TAIL_
// MARKERS already use elsewhere in this codebase for "two places that must
// never quietly diverge".
export const HELD_OBJECT_RE =
  /\b(?:holding|holds?|gripping|grips?|clutch(?:ing|es)?|clasp(?:ing|s)?|carries|carrying|carried)\s+(?:the|a|an|his|her|their)\s+([a-z][a-z '-]{2,24}?)(?=[.,;]|\s+(?:in|with|as|while|and)\b|$)/i;
export const HELD_OBJECT_CLEARED_RE =
  /\b(sets?\s+down|set\s+down|puts?\s+down|put\s+down|drops?|dropped|hands?\s+(?:over|it|him|her|them)|handed\s+(?:over|it)|places?|placed|gives?|gave|pockets?|pocketed)\b/i;
export const PROP_ACQUISITION_RE =
  /\b(picks?\s+up|takes?|grabs?|retrieves?|receives?|is\s+handed|accepts?|produces?|pulls?\s+out|reaches?\s+(?:for|into)|draws?|unwraps?|finds?)\b/i;
export const HELD_OBJECT_ESTABLISH_RE =
  /\b(?:holding|holds?|gripping|grips?|clutch(?:ing|es)?|clasp(?:ing|s)?|carries|carrying|carried|picks?\s+up|takes?|grabs?|retrieves?|receives?|accepts?|produces?|pulls?\s+out|unwraps?)\s+(?:the|a|an|his|her|their)\s+([a-z][a-z '-]{2,24}?)(?=[.,;]|\s+(?:in|with|as|while|and|from)\b|$)/i;
export const PASSIVE_CARRY_RE =
  /\b(?:his|her|their|a|the)\s+([a-z][a-z '-]{2,24}?)\s+(?:still\s+|now\s+|also\s+|already\s+|again\s+)?(?:slung|draped|hung|hanging|tucked|strapped|perched|wrapped|tied|looped)\s+(?:over|around|on|across)\s+(?:his|her|their|its)?\s*(?:left\s+|right\s+)?(?:shoulders?|arms?|necks?|wrists?|heads?|backs?)\b/i;
// CONFIRMED REAL GAP: a shot's own text can describe an object in an
// already-possessed STATE with no verb at all — "sword in hand", "blade
// raised", "sword drawn" — which is neither PASSIVE_CARRY_RE's shape (built
// for a WORN item — slung/draped/tucked over a body part) nor HELD_OBJECT_
// ESTABLISH_RE's shape (built for a VERB + article + noun clause). A real
// script's breakdown read "Queen Isolde stands before Commander Thane,
// sword in hand" with no earlier shot showing her draw or pick it up — and
// because NEITHER regex matched this construction at all, the WORLD_STATE_
// PROP_NO_ORIGIN check downstream never even ran against it (no match to
// check `m[1]` against), so the dropped draw-the-sword beat went completely
// unflagged. This closes that gap: same "noun, no acquisition verb" shape
// PASSIVE_CARRY_RE already covers, extended to the "already drawn/raised/
// in-hand" phrasing a held weapon or tool commonly gets instead of a worn
// item's "slung over the shoulder" phrasing.
export const OBJECT_ALREADY_HELD_RE =
  /\b(?:(?:his|her|their|a|the)\s+)?([a-z][a-z '-]{2,24}?)\s+(?:is\s+|now\s+|already\s+|still\s+)?(?:drawn|raised(?:\s+(?:high|aloft))?|held\s+(?:aloft|high|before\s+(?:him|her|them))|in\s+(?:his|her|their|one)?\s*hands?)\b/i;

// ── SHARED DETECTION VOCABULARY (Migration Step 3) ──────────────────────────
// RELOCATED VERBATIM from compiler.ts's RELATIVE CHARACTER POSITION LOCK
// block. `characters` is passed as a parameter (not imported) for the same
// leaf-module, no-circular-import reason `sameScene` is passed into
// findLocation/getOrCreateLocation above.
export const AHEAD_WORD = "(?:ahead of|in front of|leads?|leading|out in front of)";
export const BEHIND_WORD = "(?:behind|trailing|follows?|following)";
export const OVERTAKE_WORDS =
  /\b(overtakes?|passes?|pulls?\s+ahead|falls?\s+behind|catches?\s+up|steps?\s+past)\b/i;

function escapeName(n: string): string {
  return n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns {aheadId, behindId} if the text explicitly states one of these two
 *  named characters is ahead of/behind the other, else null. Checked both
 *  phrasing directions ("A ahead of B" and "B behind A" both mean the same
 *  relation) since either is a natural way to write it. */
export function extractAheadPair(
  text: string,
  idA: string,
  idB: string,
  characters: { id: string; name: string }[],
): { aheadId: string; behindId: string } | null {
  const nameA = characters.find((c) => c.id === idA)?.name;
  const nameB = characters.find((c) => c.id === idB)?.name;
  if (!nameA || !nameB) return null;
  const a = escapeName(nameA), b = escapeName(nameB);
  const aAheadOfB =
    new RegExp(`\\b${a}\\b[^.]{0,30}\\b${AHEAD_WORD}\\b[^.]{0,20}\\b${b}\\b`, "i").test(text) ||
    new RegExp(`\\b${b}\\b[^.]{0,30}\\b${BEHIND_WORD}\\b[^.]{0,20}\\b${a}\\b`, "i").test(text);
  if (aAheadOfB) return { aheadId: idA, behindId: idB };
  const bAheadOfA =
    new RegExp(`\\b${b}\\b[^.]{0,30}\\b${AHEAD_WORD}\\b[^.]{0,20}\\b${a}\\b`, "i").test(text) ||
    new RegExp(`\\b${a}\\b[^.]{0,30}\\b${BEHIND_WORD}\\b[^.]{0,20}\\b${b}\\b`, "i").test(text);
  if (bAheadOfA) return { aheadId: idB, behindId: idA };
  return null;
}
