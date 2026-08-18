import { z } from "zod";

/**
 * ACTION PRECONDITION/EFFECT SYSTEM — catches a distinct failure category
 * from every other world-state check in compiler.ts: those track OBJECT
 * state (a prop being carried, a door's open/closed state, a light's
 * on/off state); this tracks a CHARACTER'S OWN PHYSICAL/SPATIAL STATE, and
 * validates that an action's real-world PRECONDITIONS are satisfied before
 * it's allowed to render unchallenged. Confirmed real failure this exists
 * to catch: a character "unlocks the door" in a shot, while an EARLIER shot
 * had already established them as being inside that same location —
 * unlocking-to-enter only makes sense from the exterior side of a
 * threshold, and nothing previously represented which side of a door a
 * character was on, so nothing could catch it.
 *
 * DATA-DRIVEN, ON PURPOSE — precondition/effect are DATA (SpatialFact[]),
 * not functions. This is what lets a hardcoded CORE_ACTION_LIBRARY entry
 * and an LLM-INFERRED entry (compiler.ts's inference cache, populated via
 * providers/llm.ts's inferActionRule()) share the EXACT SAME shape and the
 * EXACT SAME validation code — an LLM can return JSON describing "the
 * character must be outside the window," it cannot return a JS closure.
 *
 * SCOPE, STATED HONESTLY: SpatialState tracks a character's threshold side,
 * posture, near-object, and vehicle occupancy — NOT their held props (see
 * WORLD_STATE_PROP_CARRY, a different, already-shipped check) and NOT a
 * door/light/window's own OBJECT state (see WORLD_STATE_LOCATION_
 * CONTRADICTION, also already shipped) — this system is deliberately
 * scoped to the one thing neither of those track: where the CHARACTER
 * THEMSELVES is, relative to what's around them. Referents (a door, a
 * window, a desk) are tracked PER CHARACTER, not per specific physical
 * instance of that noun — a script with two genuinely different doors the
 * same character interacts with will conflate them under one "door" key.
 * This is a real, stated limitation, not a silently accepted one.
 *
 * MULTI-CHARACTER SHOTS: validated per character when the breakdown data
 * attributes each character's own action (Shot.characterActions, additive
 * schema field — see types.ts), not skipped as a blanket rule. A shot
 * missing attribution for one or more of its characters degrades
 * gracefully — that specific shot is skipped, with a logged reason — rather
 * than silently skipping every multi-character shot. See compiler.ts's
 * WORLD_STATE_ACTION_CONTRADICTION block for the actual attribution/
 * fallback logic. HANDOFFS between two characters in the same shot (one
 * hands an object to another) are supported via ActionRule.recipientEffect,
 * which lets a single action's effect update a SECOND character's tracked
 * state, not just the actor's own.
 */

// ── SPATIAL STATE ────────────────────────────────────────────────────────

export interface SpatialState {
  /** referent noun (e.g. "door", "gate") -> which side of it this character
   *  is currently on. Only set once a threshold action has established it. */
  thresholdSide: Record<string, "inside" | "outside">;
  posture: "standing" | "sitting" | "kneeling" | "lying" | null;
  /** The last object this character was positioned at/beside/near, e.g. "desk". */
  nearObject: string | null;
  /** The vehicle this character is currently inside, or null if not in one. */
  inVehicle: string | null;
}

export function initialSpatialState(): SpatialState {
  return { thresholdSide: {}, posture: null, nearObject: null, inVehicle: null };
}

// ── FACTS — the vocabulary precondition/effect are expressed in ─────────

export type SpatialFact =
  | { kind: "thresholdSide"; referent: string; side: "inside" | "outside" }
  | { kind: "postureNot"; value: SpatialState["posture"] } // precondition: posture must NOT currently be this
  | { kind: "postureIs"; value: NonNullable<SpatialState["posture"]> } // precondition: posture must currently be this (or untracked)
  | { kind: "posture"; value: SpatialState["posture"] } // effect: set posture to this
  | { kind: "nearObjectIs"; referent: string } // precondition: must currently be near this object
  | { kind: "nearObjectIsNot"; referent: string } // precondition: must NOT currently be near this object
  | { kind: "nearObject"; referent: string | null } // effect: set near-object
  | { kind: "inVehicle"; value: string | null }; // precondition OR effect: vehicle occupancy

export interface ActionRule {
  /** Normalized label for human-readable messages, e.g. "unlock door (to enter)". */
  label: string;
  category:
    | "threshold" | "locomotion" | "object_manipulation" | "body_position"
    | "social_contact" | "consumption" | "vehicle";
  /** Detection regex for CORE library entries. null for LLM-inferred entries,
   *  which are matched by cache key (normalized text), not a pattern —
   *  see compiler.ts's inference-cache lookup. */
  pattern: RegExp | null;
  /** ALL facts must hold for the action to be considered valid. Empty = no precondition. */
  precondition: SpatialFact[];
  /** Facts that become true after this action — applied to update tracked state. */
  effect: SpatialFact[];
  /**
   * HANDOFF SUPPORT: some actions (handing an object to another character)
   * set state for a SECOND character, not just the actor — e.g. "hands the
   * keys to Zara" should make Zara newly near/holding the keys, regardless
   * of what it does (or doesn't) do to the giver's own state. `recipientGroup`
   * names which regex capture group holds the recipient's character NAME
   * (resolved against the shot's OTHER present characters by name, see
   * compiler.ts); `recipientEffect` is applied to THAT character's tracked
   * state once resolved. Both undefined for the vast majority of entries,
   * which only ever affect the actor.
   */
  recipientEffect?: SpatialFact[];
  recipientGroup?: number;
}

/**
 * Runtime validation for LLM-INFERRED rules (providers/llm.ts's
 * inferActionRule()) — the CORE library above is authored TypeScript,
 * already type-checked; an LLM's JSON response gets no such guarantee, and
 * this codebase's own established discipline is to Zod-parse every
 * structured LLM output rather than trust `JSON.parse(...) as T`. Mirrors
 * the SpatialFact discriminated union exactly — a response using a "kind"
 * outside this set, or missing a required field for its own kind, fails
 * validation and the caller falls back to "no precondition check for this
 * action" (see compiler.ts) rather than silently trusting malformed data.
 */
const SpatialFactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thresholdSide"), referent: z.string(), side: z.enum(["inside", "outside"]) }),
  z.object({ kind: z.literal("postureNot"), value: z.enum(["standing", "sitting", "kneeling", "lying"]).nullable() }),
  z.object({ kind: z.literal("postureIs"), value: z.enum(["standing", "sitting", "kneeling", "lying"]) }),
  z.object({ kind: z.literal("posture"), value: z.enum(["standing", "sitting", "kneeling", "lying"]).nullable() }),
  z.object({ kind: z.literal("nearObjectIs"), referent: z.string() }),
  z.object({ kind: z.literal("nearObjectIsNot"), referent: z.string() }),
  z.object({ kind: z.literal("nearObject"), referent: z.string().nullable() }),
  z.object({ kind: z.literal("inVehicle"), value: z.string().nullable() }),
]);

export const InferredActionRuleSchema = z.object({
  label: z.string(),
  category: z.enum([
    "threshold", "locomotion", "object_manipulation", "body_position",
    "social_contact", "consumption", "vehicle",
  ]),
  precondition: z.array(SpatialFactSchema).default([]),
  effect: z.array(SpatialFactSchema).default([]),
});
export type InferredActionRule = z.infer<typeof InferredActionRuleSchema>;

// ── PRECONDITION CHECK / EFFECT APPLICATION — shared by core + inferred ─

/** Returns a human-readable violation reason, or null if the precondition holds.
 *  A fact about a referent/object that has never been TRACKED for this
 *  character is treated as satisfied (lenient) — the first time a threshold/
 *  object is ever mentioned, there is nothing yet to contradict; only an
 *  ESTABLISHED, opposing fact counts as a real violation. This is the same
 *  "no known state yet -> pass" discipline WORLD_STATE_LOCATION_CONTRADICTION
 *  and WORLD_STATE_PROP_CARRY already use. */
export function checkPrecondition(state: SpatialState, facts: SpatialFact[]): string | null {
  for (const fact of facts) {
    switch (fact.kind) {
      case "thresholdSide": {
        const known = state.thresholdSide[fact.referent];
        if (known && known !== fact.side) {
          return `is already tracked as ${known === "inside" ? "INSIDE" : "OUTSIDE"} the ${fact.referent}, not ${fact.side}`;
        }
        break;
      }
      case "postureNot": {
        if (state.posture && state.posture === fact.value) {
          return `is already tracked as ${fact.value}`;
        }
        break;
      }
      case "postureIs": {
        if (state.posture && state.posture !== fact.value) {
          return `is tracked as ${state.posture}, not ${fact.value}`;
        }
        break;
      }
      case "nearObjectIs": {
        if (state.nearObject && state.nearObject !== fact.referent) {
          return `is tracked as being near "${state.nearObject}", not the ${fact.referent}`;
        }
        break;
      }
      case "nearObjectIsNot": {
        if (state.nearObject === fact.referent) {
          return `is already tracked as being near the ${fact.referent}`;
        }
        break;
      }
      case "inVehicle": {
        const known = state.inVehicle;
        if (fact.value === null && known) {
          return `is already tracked as inside the ${known}`;
        }
        if (fact.value !== null && !known) {
          return `is not tracked as being inside a vehicle`;
        }
        if (fact.value !== null && known && known !== fact.value) {
          return `is tracked as being inside the ${known}, not the ${fact.value}`;
        }
        break;
      }
      // "posture"/"nearObject" (bare, no "Is"/"Not"/"IsNot" suffix) are
      // EFFECT-only fact kinds — never appear in a precondition array.
    }
  }
  return null;
}

/** Returns a NEW state (does not mutate the input) with every effect fact applied. */
export function applyEffect(state: SpatialState, facts: SpatialFact[]): SpatialState {
  const next: SpatialState = { thresholdSide: { ...state.thresholdSide }, posture: state.posture, nearObject: state.nearObject, inVehicle: state.inVehicle };
  for (const fact of facts) {
    switch (fact.kind) {
      case "thresholdSide": next.thresholdSide[fact.referent] = fact.side; break;
      case "posture": next.posture = fact.value; break;
      case "nearObject": next.nearObject = fact.referent; break;
      case "inVehicle": next.inVehicle = fact.value; break;
      // precondition-only kinds (postureNot/postureIs/nearObjectIs/nearObjectIsNot)
      // never appear in an effect array — no-op if they somehow do.
    }
  }
  return next;
}

/** Some entries' precondition/effect referent is only known at MATCH time
 *  (e.g. "approaches the desk" — the object name is a regex capture group,
 *  not something the library can hardcode). Those entries write the literal
 *  placeholder "$1" as their fact's referent; this resolves it against the
 *  match's first DEFINED capture group (several entries have alternative
 *  branches — "sits on X" / "sits at X" — where only one branch's group is
 *  ever set for a given match) before the fact is checked/applied. Facts
 *  with a real, non-placeholder referent pass through unchanged. */
export function resolveReferentPlaceholders(facts: SpatialFact[], match: RegExpMatchArray): SpatialFact[] {
  const captured = match.slice(1).find((g) => g !== undefined)?.trim().toLowerCase();
  return facts.map((f) => {
    if ("referent" in f && f.referent === "$1") {
      return { ...f, referent: captured ?? "it" } as SpatialFact;
    }
    return f;
  });
}

/**
 * PER-INSTANCE REFERENT DISAMBIGUATION (a scene with a front door AND a back
 * door). A captured referent like "front door" or "back door" is already its
 * OWN distinct instance key (regex capture preserves the qualifier verbatim)
 * — nothing needed there. The gap this closes is the BARE reference: once a
 * QUALIFIED instance of a noun exists in a location, what does a later "the
 * door" (no qualifier) resolve to? `locInstances` tracks, per location (the
 * caller keys it the same way WORLD_STATE_LOCATION_CONTRADICTION's
 * knownLocations does — sameScene()-grouped, not scene-number-grouped, so a
 * location revisited later in the film is still the same location) and per
 * bare noun type (the LAST word of the referent, e.g. "door" out of "front
 * door"), the set of distinct instances mentioned so far:
 *   - 0 known instances yet -> this bare mention becomes THE known instance
 *     (nothing to disambiguate — nothing established this location has more
 *     than one).
 *   - exactly 1 known instance -> resolve to it, whatever it's called ("the
 *     door" correctly means "the front door" once that's the only door this
 *     scene has ever named — no new authoring convention required).
 *   - 2+ known instances -> genuinely ambiguous; returns null so the caller
 *     drops just this one fact (lenient — same "untracked -> pass" discipline
 *     as checkPrecondition itself; better to skip one fact than risk a false
 *     positive on the wrong door).
 */
export function resolveInstanceKey(locInstances: Map<string, Set<string>>, rawReferent: string): string | null {
  const words = rawReferent.trim().split(/\s+/);
  const bareType = words[words.length - 1];
  const isQualified = words.length > 1;
  let known = locInstances.get(bareType);
  if (!known) {
    known = new Set();
    locInstances.set(bareType, known);
  }
  if (isQualified) {
    known.add(rawReferent);
    return rawReferent;
  }
  if (known.size === 0) {
    known.add(bareType);
    return bareType;
  }
  if (known.size === 1) {
    return [...known][0];
  }
  return null;
}

/** Applies resolveInstanceKey() to every referent-bearing fact in an array,
 *  dropping (not nulling) any fact that resolves ambiguously — the shot's
 *  OTHER facts (a different character, a different referent entirely) are
 *  unaffected by one ambiguous reference. */
export function resolveInstanceReferents(facts: SpatialFact[], locInstances: Map<string, Set<string>>): SpatialFact[] {
  const resolved: SpatialFact[] = [];
  for (const f of facts) {
    if ("referent" in f && typeof f.referent === "string") {
      const key = resolveInstanceKey(locInstances, f.referent);
      if (key === null) continue;
      resolved.push({ ...f, referent: key } as SpatialFact);
    } else {
      resolved.push(f);
    }
  }
  return resolved;
}

// ── CORE ACTION LIBRARY ──────────────────────────────────────────────────
// Hand-authored, covering the high-frequency script action categories.
// Regexes deliberately conservative (specific verb + referent shapes) to
// avoid false-triggering on unrelated prose — an entry that DOESN'T match
// falls through to the generative fallback (compiler.ts), not to silence;
// better to occasionally pay for an inferred entry than to false-positive
// on a common sentence shape.

// Positional/room qualifiers a script realistically uses to distinguish two
// instances of the same threshold noun ("the front door" vs "the back
// door"). Deliberately a fixed list rather than "any adjective" — an
// adjective like "heavy" or "old" describes the SAME single door, it doesn't
// introduce a second one, and treating every adjective as a new instance key
// would make ordinary descriptive text falsely look like a second referent.
const DOOR_QUALIFIER = "(?:front|back|rear|side|main|garage|kitchen|bedroom|bathroom|office|closet|patio)\\s+";
const doorPattern = (verbGroup: string) => new RegExp(`\\b${verbGroup}\\s+the\\s+(${DOOR_QUALIFIER}?door)\\b`, "i");

export const CORE_ACTION_LIBRARY: ActionRule[] = [
  // ── THRESHOLD / ENTRY ────────────────────────────────────────────────
  // The category the concrete bug report lives in: unlocking a door only
  // makes narrative sense as the move that PRECEDES entering from outside.
  // The referent is now a CAPTURE GROUP ("$1"), not a hardcoded "door" —
  // preserves a qualifier if the script uses one ("the front door" ->
  // referent "front door"), so two distinct doors in the same location are
  // tracked as two distinct thresholds instead of being silently conflated.
  // See resolveInstanceReferents() (actionLibrary.ts) for how a later BARE
  // "the door" then resolves back against whatever's already known.
  {
    label: "unlock door (to enter)",
    category: "threshold",
    pattern: doorPattern("unlocks?"),
    precondition: [{ kind: "thresholdSide", referent: "$1", side: "outside" }],
    effect: [{ kind: "thresholdSide", referent: "$1", side: "outside" }],
  },
  {
    label: "knock on door",
    category: "threshold",
    pattern: doorPattern("knocks?\\s+(?:on|at)"),
    precondition: [{ kind: "thresholdSide", referent: "$1", side: "outside" }],
    effect: [{ kind: "thresholdSide", referent: "$1", side: "outside" }],
  },
  {
    label: "enter (through a door)",
    category: "threshold",
    pattern: /\b(?:enters?|steps? (?:inside|in)|walks? in|goes? inside|comes? in)\b(?!\s+the\s+car\b)/i,
    precondition: [{ kind: "thresholdSide", referent: "door", side: "outside" }],
    effect: [{ kind: "thresholdSide", referent: "door", side: "inside" }],
  },
  {
    label: "exit (through a door)",
    category: "threshold",
    // Negative lookahead excludes "exits the car" — the bare "exits?"
    // alternative would otherwise also match a VEHICLE exit (a real bug
    // caught while cross-checking this library: threshold entries are
    // matched before vehicle entries below, first-match-wins, so an
    // unguarded generic "exits?" would silently steal every "exits the car"
    // shot from the more specific vehicle rule and apply the wrong
    // precondition/effect entirely — thresholdSide instead of inVehicle).
    // Same guard "enter" above already needed for the symmetric case.
    pattern: /\b(?:exits?|steps? outside|walks? out|goes? outside|leaves? the (?:house|room|building|apartment|office))\b(?!\s+the\s+car\b)/i,
    precondition: [{ kind: "thresholdSide", referent: "door", side: "inside" }],
    effect: [{ kind: "thresholdSide", referent: "door", side: "outside" }],
  },
  {
    label: "close door (behind oneself, from inside)",
    category: "threshold",
    pattern: /\bcloses?\s+the\s+door\s+behind\s+(?:him|her|them)\b/i,
    precondition: [],
    effect: [],
  },
  {
    // Deliberately NO position precondition/effect, unlike unlock/enter/exit
    // above — genuinely ambiguous which side "opens the door" happens from
    // (someone inside opening it to greet a guest is just as valid as
    // someone outside opening it to enter). Recognized anyway so it doesn't
    // burn a generative-fallback call on one of the most common threshold
    // phrases in ordinary scripts.
    label: "open the door",
    category: "threshold",
    pattern: /\bopens?\s+the\s+door\b/i,
    precondition: [],
    effect: [],
  },

  // ── LOCOMOTION ───────────────────────────────────────────────────────
  {
    label: "approach an object/location",
    category: "locomotion",
    pattern: /\b(?:approaches?|walks?\s+(?:up\s+)?to|runs?\s+to)\s+the\s+([a-z][a-z ]{2,20}?)\b/i,
    // "$1" resolved at match time against the captured object noun — see
    // resolveReferentPlaceholders() above. Approaching something you are
    // ALREADY tracked as being next to is the contradiction this catches
    // (a milder, more common version of the door-side bug — "approaches
    // the desk" when the character was last established already at it).
    precondition: [{ kind: "nearObjectIsNot", referent: "$1" }],
    effect: [{ kind: "nearObject", referent: "$1" }],
  },
  {
    label: "back away from an object/location",
    category: "locomotion",
    pattern: /\b(?:backs?\s+away\s+from|steps?\s+back\s+from|retreats?\s+from)\s+the\s+([a-z][a-z ]{2,20}?)\b/i,
    precondition: [{ kind: "nearObjectIs", referent: "$1" }],
    effect: [{ kind: "nearObject", referent: null }],
  },
  {
    label: "climb (stairs/ladder/structure)",
    category: "locomotion",
    pattern: /\bclimbs?\s+(?:the\s+)?(?:stairs?|ladder|steps?|wall|fence)\b/i,
    precondition: [],
    effect: [],
  },
  {
    label: "descend (stairs/ladder)",
    category: "locomotion",
    pattern: /\b(?:descends?|climbs?\s+down)\s+(?:the\s+)?(?:stairs?|ladder|steps?)\b/i,
    precondition: [],
    effect: [],
  },

  // ── OBJECT MANIPULATION ──────────────────────────────────────────────
  // Holding state itself is WORLD_STATE_PROP_CARRY's job (already shipped);
  // MOST of these entries exist so common manipulation verbs are RECOGNIZED
  // (and so don't burn a generative-fallback call on something this common),
  // even where this system's simplified spatial model has nothing further
  // useful to assert. The one exception, below, genuinely IS spatially
  // constrained: picking something up "from" a named place implies the
  // character is already positioned there. MUST come before the generic
  // "pick up" entry just below — matching is first-match-wins, and the
  // generic pattern would otherwise shadow this more specific one every time.
  {
    label: "pick up an object from a specific place",
    category: "object_manipulation",
    pattern: /\bpicks?\s+up\s+the\s+[a-z][a-z ]{2,20}?\s+from\s+the\s+([a-z][a-z ]{2,20}?)\b/i,
    precondition: [{ kind: "nearObjectIs", referent: "$1" }],
    effect: [],
  },
  { label: "pick up an object", category: "object_manipulation", pattern: /\bpicks?\s+up\b/i, precondition: [], effect: [] },
  { label: "put down an object", category: "object_manipulation", pattern: /\bputs?\s+down\b/i, precondition: [], effect: [] },
  {
    // MUST come before the generic "hand an object to someone" entry just
    // below — matching is first-match-wins, and the generic pattern (which
    // only recognizes vague pronoun handoffs like "hands it over") would
    // otherwise shadow this named-object, named-recipient form every time.
    // The one HANDOFF entry in this library where the recipient's own
    // tracked state actually changes — see ActionRule.recipientEffect.
    label: "hand a specific object to a named character",
    category: "object_manipulation",
    pattern: /\bhands?\s+(?:the|a|an)\s+([a-z][a-z '-]{1,20}?)\s+to\s+([A-Z][a-zA-Z'-]*(?:\s+[A-Z][a-zA-Z'-]*)*)\b/,
    precondition: [],
    effect: [],
    recipientEffect: [{ kind: "nearObject", referent: "$1" }],
    recipientGroup: 2,
  },
  { label: "hand an object to someone", category: "object_manipulation", pattern: /\bhands?\s+(?:it|him|her|them|over)\b/i, precondition: [], effect: [] },
  { label: "throw an object", category: "object_manipulation", pattern: /\bthrows?\b/i, precondition: [], effect: [] },
  { label: "drop an object", category: "object_manipulation", pattern: /\bdrops?\b/i, precondition: [], effect: [] },
  {
    label: "open a container",
    category: "object_manipulation",
    pattern: /\bopens?\s+the\s+(?:drawer|box|jar|cabinet|fridge|refrigerator|bag|suitcase)\b/i,
    precondition: [],
    effect: [],
  },
  {
    label: "close a container",
    category: "object_manipulation",
    pattern: /\bcloses?\s+the\s+(?:drawer|box|jar|cabinet|fridge|refrigerator|bag|suitcase)\b/i,
    precondition: [],
    effect: [],
  },

  // ── BODY POSITION ────────────────────────────────────────────────────
  {
    label: "sit down",
    category: "body_position",
    // "sits down" (no object) leaves group 1 undefined, so
    // resolveReferentPlaceholders() falls back to "it" for the nearObject
    // effect in that case — harmless, since nothing downstream depends on
    // "sits down" alone establishing a specific referent.
    pattern: /\bsits?\s+(?:down|on\s+the\s+([a-z][a-z ]{2,20}?)|at\s+the\s+([a-z][a-z ]{2,20}?))\b/i,
    precondition: [{ kind: "postureNot", value: "sitting" }],
    effect: [{ kind: "posture", value: "sitting" }, { kind: "nearObject", referent: "$1" }],
  },
  {
    label: "stand up",
    category: "body_position",
    pattern: /\b(?:stands?\s+up|rises?|gets?\s+up)\b/i,
    precondition: [{ kind: "postureNot", value: "standing" }],
    effect: [{ kind: "posture", value: "standing" }],
  },
  {
    label: "kneel",
    category: "body_position",
    pattern: /\bkneels?\b/i,
    precondition: [{ kind: "postureNot", value: "kneeling" }],
    effect: [{ kind: "posture", value: "kneeling" }],
  },
  {
    label: "lie down",
    category: "body_position",
    pattern: /\blies?\s+down\b|\blying\s+down\b/i,
    precondition: [{ kind: "postureNot", value: "lying" }],
    effect: [{ kind: "posture", value: "lying" }],
  },
  {
    label: "lean against/on something",
    category: "body_position",
    pattern: /\bleans?\s+(?:against|on)\s+the\s+([a-z][a-z ]{2,20}?)\b/i,
    precondition: [],
    effect: [{ kind: "nearObject", referent: "$1" }],
  },

  // ── SOCIAL / CONTACT ─────────────────────────────────────────────────
  // No meaningful spatial precondition in this system's simplified model
  // (an interpersonal action's validity is about who's IN FRAME, already
  // governed by castLock/R7 — not about threshold/posture/vehicle state) —
  // recognized so these extremely common verbs never trigger the
  // generative fallback.
  { label: "embrace", category: "social_contact", pattern: /\b(?:embraces?|hugs?)\b/i, precondition: [], effect: [] },
  { label: "shake hands", category: "social_contact", pattern: /\bshakes?\s+(?:his|her|their)?\s*hands?\b/i, precondition: [], effect: [] },
  { label: "kiss", category: "social_contact", pattern: /\bkisses?\b/i, precondition: [], effect: [] },
  { label: "push", category: "social_contact", pattern: /\bpushes?\b/i, precondition: [], effect: [] },
  { label: "strike", category: "social_contact", pattern: /\b(?:strikes?|punches?|hits?)\b/i, precondition: [], effect: [] },

  // ── CONSUMPTION ──────────────────────────────────────────────────────
  { label: "eat", category: "consumption", pattern: /\beats?\b/i, precondition: [], effect: [] },
  { label: "drink", category: "consumption", pattern: /\bdrinks?\b/i, precondition: [], effect: [] },
  { label: "smoke", category: "consumption", pattern: /\bsmokes?\b/i, precondition: [], effect: [] },

  // ── VEHICLE ───────────────────────────────────────────────────────────
  {
    label: "get into a vehicle",
    category: "vehicle",
    pattern: /\b(?:gets?\s+in(?:to)?|climbs?\s+in(?:to)?)\s+the\s+car\b/i,
    precondition: [{ kind: "inVehicle", value: null }],
    effect: [{ kind: "inVehicle", value: "car" }],
  },
  {
    label: "get out of a vehicle",
    category: "vehicle",
    pattern: /\b(?:gets?\s+out\s+of|climbs?\s+out\s+of|exits?)\s+the\s+car\b/i,
    precondition: [{ kind: "inVehicle", value: "car" }],
    effect: [{ kind: "inVehicle", value: null }],
  },
  {
    label: "start the engine",
    category: "vehicle",
    pattern: /\bstarts?\s+the\s+(?:engine|car)\b/i,
    precondition: [{ kind: "inVehicle", value: "car" }],
    effect: [],
  },
  {
    label: "park the car",
    category: "vehicle",
    pattern: /\bparks?\s+the\s+car\b/i,
    precondition: [{ kind: "inVehicle", value: "car" }],
    effect: [],
  },
];

// ── ACTION POSE LIBRARY ──────────────────────────────────────────────────
// A DIFFERENT facet of the SAME "common human actions" domain knowledge
// CORE_ACTION_LIBRARY above already curates — not a competing taxonomy.
// CORE_ACTION_LIBRARY answers "is this action's real-world PRECONDITION
// satisfied" (a narrative/state-consistency question — was the door already
// unlocked, is the character already sitting). This answers a completely
// different pair of questions the compiler's R4 two-endpoint law and R7.5/
// R7.6 duration checks (see compileBreakdown()) already ask of every shot,
// but currently ask GENERICALLY: "what does a PHOTOGRAPHABLE start/end pose
// for this specific action actually look like" and "how many real seconds
// does this specific action need." Every shot currently reinvents both
// answers from scratch in prose, with nothing to check the answer against —
// this is what KEYFRAME_MAYBE_NOT_PHOTOGRAPHABLE, ENDPOINTS_MAYBE_TOO_
// SIMILAR, and R7.6's own "roughly one beat per 1-2 seconds" heuristic are
// each independently guessing at, per shot, with no shared ground truth.
//
// PLACEMENT DECISION: lives HERE, inside actionLibrary.ts, not in a
// separate file or inside DIRECTOR_RULES.json. Reasoning: DIRECTOR_RULES.json
// (src/director/) is free-text prose appended to the SYSTEM PROMPT — a
// GENERATION-time nudge with no structured shape a TypeScript check could
// read back and validate against; this library needs to be queried
// PROGRAMMATICALLY (by label, cross-referenced against CORE_ACTION_LIBRARY's
// own matched entry) by a COMPILE-time check, the same way CORE_ACTION_LIBRARY
// itself is. Keeping both facets of "what this pipeline knows about the
// action labelled X" in ONE file, cross-referenced by the SAME label string,
// means there is one place to look, not two that can silently drift apart —
// the same "shared vocabulary, not a parallel one" discipline this whole
// file's own top-of-file comment already commits to for precondition/effect.
//
// `label` cross-references CORE_ACTION_LIBRARY's own `label` field where a
// matching entry exists (compiler.ts's consumer matches by re-running that
// SAME CORE_ACTION_LIBRARY pattern, then looking up the matched entry's
// label here — one detection pass, not two). Not every entry here has (or
// needs) a CORE_ACTION_LIBRARY counterpart, and not every CORE_ACTION_LIBRARY
// entry needs a pose/duration counterpart here (many, like "throw an
// object" or "eat", have no useful universal pose/duration answer worth
// asserting) — the two lists intentionally do not have to be the same size
// or cover the same entries.
export interface ActionPose {
  /** Cross-references CORE_ACTION_LIBRARY's own `label` where one exists. */
  label: string;
  /** A concrete, PHOTOGRAPHABLE start pose — a real position a human body
   *  can actually hold still for a camera, the same bar
   *  KEYFRAME_MAYBE_NOT_PHOTOGRAPHABLE's own check already insists a
   *  startFrame/endFrame must clear (see compiler.ts). Written as prose a
   *  director could hand a photographer, not an abstract description of
   *  the action. */
  startPose: string;
  /** The photographable end pose — same discipline, same bar. */
  endPose: string;
  /** Realistic real-world [min, max] seconds this action needs to read as
   *  genuinely, physically performed — not a single number, since e.g. a
   *  rushed vs. a deliberate version of the same action legitimately
   *  differ. Grounds R7.6's duration check in a real per-action reference
   *  instead of the generic "roughly one beat per 1-2 seconds" convention
   *  that check falls back to for anything NOT in this library. */
  typicalDurationSec: [number, number];
}

export const ACTION_POSE_LIBRARY: ActionPose[] = [
  {
    label: "sit down",
    startPose: "Standing upright beside the seat, knees straight, weight balanced on both feet, hands loose at the sides.",
    endPose: "Fully seated, weight settled back into the seat, knees bent at roughly a right angle, both feet flat on the floor.",
    typicalDurationSec: [1.5, 3],
  },
  {
    label: "stand up",
    startPose: "Fully seated, weight settled back into the seat, knees bent, both feet flat on the floor.",
    endPose: "Standing upright, knees straight, weight balanced evenly on both feet.",
    typicalDurationSec: [1.5, 3],
  },
  {
    label: "kneel",
    startPose: "Standing upright, knees straight, weight balanced on both feet.",
    endPose: "One or both knees resting on the ground, weight settled down and back, torso upright over the hips, not slumped forward.",
    typicalDurationSec: [1.5, 3],
  },
  {
    label: "open the door",
    startPose: "Standing directly in front of the closed door, one hand reaching for or already resting on the handle, the door itself fully shut in frame.",
    endPose: "The door swung open to a natural resting angle, the handle released, the space beyond now visible past the open door.",
    typicalDurationSec: [1, 2.5],
  },
  {
    label: "enter (through a door)",
    startPose: "Standing just outside the threshold, facing into the doorway, the open door beside them.",
    endPose: "Fully inside the room, both feet past the threshold line, the doorway now behind them, not still framed in it.",
    typicalDurationSec: [1.5, 3],
  },
  // No direct CORE_ACTION_LIBRARY counterpart (that library recognizes
  // "shake hands" only as part of the broader social_contact category, with
  // no dedicated pattern of its own) — kept here anyway since a scripted
  // greeting is common enough, and its start/end poses concrete enough, to
  // be worth a real reference regardless of whether the precondition/effect
  // side of this system tracks it.
  {
    label: "greet / shake hands",
    startPose: "Two people facing each other at a natural conversational distance, arms at their sides, neither hand extended yet.",
    endPose: "Hands clasped in a single handshake, both bodies upright and still separate, forearms extended in the space between them.",
    typicalDurationSec: [1.5, 3],
  },
  {
    label: "hand an object to someone",
    startPose: "The giver holds the object out at arm's length toward the receiver, who has not yet made contact with it; both bodies stay in their own space, not overlapping.",
    endPose: "The receiver's hand is fully closed around the object, fingers wrapped around it, the giver's hand released and withdrawn — the object has visibly, completely changed hands, not left floating between them.",
    typicalDurationSec: [1, 2],
  },
  {
    label: "pick up an object",
    startPose: "Hand reaching toward the object where it currently rests, fingers not yet closed around it.",
    endPose: "Object fully gripped, fingers wrapped around it, the hand and arm lifted clear of the surface it rested on.",
    typicalDurationSec: [1, 2],
  },
  {
    label: "embrace",
    startPose: "Two people facing each other at a natural conversational distance, arms at their sides.",
    endPose: "Arms wrapped around each other, chests in contact, both bodies still distinct and separate at the point of contact — never merged into one silhouette (see the codebase's own TWO BODIES IN CONTACT rule, llm.ts).",
    typicalDurationSec: [2, 4],
  },
];

/** Looks up an ActionPose by the exact label CORE_ACTION_LIBRARY (or a
 *  caller's own string) uses. Returns undefined for any action with no
 *  entry here — callers must treat that as "no library reference exists for
 *  this one," not an error; see ACTION_POSE_LIBRARY's own top-of-block
 *  comment for why the two lists are not required to be the same size. */
export function findActionPose(label: string): ActionPose | undefined {
  return ACTION_POSE_LIBRARY.find((p) => p.label === label);
}
