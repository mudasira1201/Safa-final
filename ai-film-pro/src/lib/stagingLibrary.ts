import { z } from "zod";

/**
 * DOMAIN/STAGING PLAUSIBILITY — same hybrid shape as actionLibrary.ts's
 * action-precondition system (core library + generative fallback + durable
 * cache), for a DIFFERENT class of fact: not "is this character's spatial
 * state consistent with this action" but "does this SETTING/DOMAIN have an
 * implicit real-world staging constraint the script text should respect" —
 * a pedestrian-only lane has no vehicle traffic, a two-sided sport's
 * opposing roles stand at opposite ends, a courtroom's witness and judge
 * occupy fixed, non-interchangeable positions.
 *
 * Confirmed real failures this exists to catch: a car rendered on a
 * pedestrian-only market lane; background pedestrians rendered walking in
 * the middle of a vehicle road; a cricket bowler bowling from the same end
 * as the batsman instead of the opposite end.
 *
 * DELIBERATELY NOT a hand-enumerated list of every real-world domain rule —
 * the CORE library below covers only the highest-frequency, safely-
 * generalizable cases (pedestrian/vehicle zones, opposing-end two-sided
 * sports). Everything else falls through to the SAME generative-fallback +
 * persisted-cache pattern actionLibrary.ts already established: infer a
 * structured rule via one LLM call, cache it durably (reusing
 * lib/actionRuleStore.ts's existing table, not a new one), and every later
 * occurrence of a similar setting reuses it for free.
 *
 * SCOPE, STATED HONESTLY: this validates SETTING/DOMAIN TEXT for a
 * self-contradiction (a car mentioned somewhere a pedestrian-only zone was
 * also established) the same way LOCATION_VEHICLE_MISMATCH always did — it
 * does NOT verify RENDERED PIXELS. A render inserting a vehicle the script
 * never mentioned at all is still outside what a text-level check can
 * catch; that failure mode needs vision QA, not this.
 */

export interface StagingFact {
  /** Human-readable statement of the constraint, reused directly in issue detail text and prompts. */
  description: string;
}

export interface StagingRule {
  /** Normalized label, e.g. "pedestrian-only zone", "opposing-end sport". */
  label: string;
  /** Detection regex for CORE library entries. null for LLM-inferred entries, matched by cache key instead. */
  pattern: RegExp | null;
  facts: StagingFact[];
  /** A trigger regex; if it matches the scene's text AND `contradicts` ALSO
   *  matches (with no `permits` present), that's a real self-contradiction —
   *  same "the script's own words disagree" discipline
   *  LOCATION_VEHICLE_MISMATCH always used, just data-driven now instead of
   *  hardcoded per-check. */
  trigger: RegExp;
  contradicts: RegExp;
  /** If present in the same text, the trigger is legitimate (no contradiction) — e.g. a vehicle mentioned WITH "on the road" qualifying language is normal street geography, not a defect. */
  permits?: RegExp;
}

// ── CORE STAGING LIBRARY ─────────────────────────────────────────────────
// Hand-authored, covering the highest-frequency cases. An entry that
// doesn't match falls through to the generative fallback (compiler.ts), not
// to silence.
export const CORE_STAGING_LIBRARY: StagingRule[] = [
  {
    label: "pedestrian-only zone",
    pattern: /\bpedestrian(?:-only)?\s*(?:lane|street|zone|area|walkway)\b|\bfootpath(?:s)?\s+only\b|\bno\s+vehicles\b|\bcar-free\b|\bclosed\s+to\s+traffic\b/i,
    facts: [{ description: "No vehicle traffic is present or moving through this space — it is closed to cars, bikes, and other vehicles." }],
    trigger: /\bpedestrian(?:-only)?\s*(?:lane|street|zone|area|walkway)\b|\bfootpath(?:s)?\s+only\b|\bno\s+vehicles\b|\bcar-free\b|\bclosed\s+to\s+traffic\b/i,
    contradicts: /\b(?:cars?|bikes?|motorcycles?|trucks?|vans?|buses?|vehicles?)\s+(?:passes?|passing|drives?|driving|speeds?|speeding|races?|racing|zooms?|zooming|moving|moves?)\b|\bengine\s+revs?\b/i,
  },
  {
    label: "vehicle roadway (pedestrians must stay clear)",
    pattern: /\b(?:vehicles?|cars?|traffic)\s+(?:are\s+|is\s+)?moving\b|\btraffic\s+flows?\b/i,
    facts: [{ description: "Pedestrians stay on the footpath/sidewalk — they do not walk in the roadway where vehicle traffic is moving." }],
    trigger: /\b(?:vehicles?|cars?|traffic)\s+(?:are\s+|is\s+)?moving\b|\btraffic\s+flows?\b/i,
    contradicts: /\b(?:walking|walks?|standing|stands?|crossing|crosses?)\s+(?:in|on)\s+(?:the\s+)?(?:middle\s+of\s+the\s+)?road\b|\bmiddle\s+of\s+the\s+road\b/i,
  },
  {
    label: "opposing-end two-sided sport (cricket, tennis, and similar)",
    pattern: /\b(?:cricket|tennis)\s+(?:pitch|court|ground)\b|\bbatting\s+crease\b|\bbaseline\b/i,
    facts: [{ description: "The two opposing roles (bowler/batsman, server/returner) stand at OPPOSITE ends of the same pitch/court — never on the same side, next to each other, or facing the same direction." }],
    trigger: /\b(?:bowler|server)\b[\s\S]{0,80}\bsame\s+(?:side|end)\s+as\b|\bsame\s+(?:side|end)\s+as\b[\s\S]{0,80}\b(?:batsman|returner)\b/i,
    contradicts: /./, // trigger itself already encodes the contradiction (an explicit "same side as" phrase is inherently the defect)
  },
];

export const InferredStagingRuleSchema = z.object({
  applies: z.boolean(),
  label: z.string().default(""),
  facts: z.array(z.string()).default([]),
  /** Keyword/phrase alternatives (plain words, NOT regex syntax — the
   *  compiler builds a safe regex from these) that would indicate this
   *  rule's constraint. Kept as plain keywords rather than asking the LLM
   *  to emit regex syntax directly — unreliable and a real injection risk
   *  if ever used unescaped; a keyword list is trivially safe to compile. */
  triggerKeywords: z.array(z.string()).default([]),
  contradictsKeywords: z.array(z.string()).default([]),
});
export type InferredStagingRule = z.infer<typeof InferredStagingRuleSchema>;

function keywordsToRegex(words: string[]): RegExp | null {
  const escaped = words.map((w) => w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean);
  if (!escaped.length) return null;
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

/** Converts an LLM-inferred rule into the same StagingRule shape the core
 *  library uses, so compiler.ts's validation logic is identical for both —
 *  one code path, not two. Returns null if the LLM said this scene has no
 *  real staging constraint (the common case) or the keyword lists were
 *  empty after sanitization. */
export function inferredToStagingRule(inferred: InferredStagingRule): StagingRule | null {
  if (!inferred.applies) return null;
  const trigger = keywordsToRegex(inferred.triggerKeywords);
  const contradicts = keywordsToRegex(inferred.contradictsKeywords);
  if (!trigger || !contradicts) return null;
  return {
    label: inferred.label || "inferred staging rule",
    pattern: null,
    facts: inferred.facts.map((description) => ({ description })),
    trigger,
    contradicts,
  };
}

/** Checks a scene's combined text against a StagingRule. Returns a human-
 *  readable contradiction detail, or null if consistent. */
export function checkStaging(text: string, rule: StagingRule): string | null {
  if (!rule.trigger.test(text)) return null;
  if (!rule.contradicts.test(text)) return null;
  if (rule.permits?.test(text)) return null;
  return rule.facts.map((f) => f.description).join(" ");
}
