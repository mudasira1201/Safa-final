// ==========================================================
// PUT THIS FILE AT:  safa-web/lib/scriptSafety.ts   *** NEW FILE ***
// ==========================================================
//
// PRIORITY 1 CONTENT SAFETY GATE — a real, structured, screenplay-specific
// review pass, complementary to (not a replacement for) moderateText()'s
// existing general-purpose OpenAI moderation-endpoint check (lib/moderation.ts).
//
// WHY A SEPARATE CHECK: moderateText() uses OpenAI's dedicated moderation
// endpoint, which is fast, cheap, and well-calibrated for its own category
// set (sexual, hate, violence, self-harm, illicit) — but that endpoint has
// NO concept of "depicts a real named person without consent framing" or
// "uses copyrighted/branded IP" or "contains actionable real-world dangerous
// instructions embedded in a story" at all. Those are screenplay-specific
// risks a generic chat-abuse classifier was never trained to recognize, and
// silently trusting fal's own downstream video-model safety filters to catch
// them means the failure is discovered only AFTER real generation spend has
// already happened. This runs BEFORE that spend, as its own dedicated LLM
// classification pass with a real system prompt for exactly these 6 risk
// categories, using this codebase's own established discipline (Zod-parse
// every structured LLM output, never trust JSON.parse(...) as T).
//
// POLICY: hard refuse on a clear violation. For a genuinely AMBIGUOUS signal
// (the model itself is not confident this is a real violation, just a
// plausible reading), this project has no human-review QUEUE infrastructure
// yet — so the policy is "refuse with a clear, specific reason" rather than
// silently allow, per the explicit "err toward refusal on any ambiguity"
// instruction. Every refusal (clear or ambiguous) is logged with its
// category, reason, and ambiguity flag via logSafetyRefusal() below, so an
// admin reviewing the log can distinguish "definitely bad" from "borderline,
// worth recalibrating the prompt" — the practical equivalent of a review
// queue without building a full separate workflow this session.
import OpenAI from "openai";
import { prisma } from "./prisma";

const client = process.env.LLM_API_KEY ? new OpenAI({ apiKey: process.env.LLM_API_KEY }) : null;

export const SCRIPT_SAFETY_CATEGORIES = [
  "real_people_no_consent",
  "copyrighted_ip",
  "minors_or_age_ambiguous_sexual_content",
  "graphic_violence",
  "hate_extremism_real_world_harm",
  "dangerous_real_world_instructions",
] as const;
export type ScriptSafetyCategory = (typeof SCRIPT_SAFETY_CATEGORIES)[number];

const CATEGORY_LABEL: Record<ScriptSafetyCategory, string> = {
  real_people_no_consent: "depicting a real, identifiable person without consent framing",
  copyrighted_ip: "using copyrighted characters or branded intellectual property",
  minors_or_age_ambiguous_sexual_content: "sexual or suggestive content involving a minor, or an age-ambiguous character",
  graphic_violence: "graphic violence or gore beyond what's appropriate for a general audience",
  hate_extremism_real_world_harm: "content designed to incite hatred, extremism, or real-world harm",
  dangerous_real_world_instructions: "actionable real-world dangerous instructions embedded in the story",
};

export interface CategoryDecision {
  category: ScriptSafetyCategory;
  triggered: boolean;
  // A clear-cut call ("a graphic torture scene", "explicit sexual content
  // with an unspecified-age character") vs a genuinely borderline one (a
  // thriller villain's monologue that BRIEFLY gestures at something violent
  // with zero real technical detail). Both still refuse under this policy —
  // the flag exists so the LOG can tell them apart for later recalibration,
  // not to change today's decision.
  ambiguous: boolean;
  reason: string;
}

export interface ScriptSafetyReview {
  decision: "allow" | "refuse";
  triggeredCategories: { category: ScriptSafetyCategory; ambiguous: boolean; reason: string }[];
  summary: string;
}

/** Manual validation of the LLM's JSON response — matches this codebase's
 *  OWN established convention (lib/intent.ts's parseIntent(), the only other
 *  structured-JSON LLM consumer in safa-web) rather than introducing a new
 *  zod dependency safa-web doesn't otherwise have (unlike ai-film-pro, which
 *  does use zod for this exact purpose). A malformed/incomplete response
 *  throws, which the caller (reviewScriptSafety()) catches and fails CLOSED
 *  on — never silently coerced into a partial, maybe-wrong "allow". */
function parseReview(raw: string): CategoryDecision[] {
  const parsed = JSON.parse(raw);
  const categories = parsed?.categories;
  if (!Array.isArray(categories) || categories.length !== SCRIPT_SAFETY_CATEGORIES.length) {
    throw new Error(`expected ${SCRIPT_SAFETY_CATEGORIES.length} category decisions, got ${Array.isArray(categories) ? categories.length : typeof categories}`);
  }
  const seen = new Set<string>();
  const out: CategoryDecision[] = [];
  for (const c of categories) {
    if (!c || typeof c !== "object") throw new Error("malformed category entry");
    const category = c.category;
    if (!SCRIPT_SAFETY_CATEGORIES.includes(category)) throw new Error(`unknown category "${category}"`);
    if (seen.has(category)) throw new Error(`duplicate category "${category}"`);
    seen.add(category);
    if (typeof c.triggered !== "boolean") throw new Error(`"${category}".triggered is not a boolean`);
    out.push({
      category,
      triggered: c.triggered,
      ambiguous: typeof c.ambiguous === "boolean" ? c.ambiguous : false,
      reason: typeof c.reason === "string" ? c.reason : "",
    });
  }
  if (seen.size !== SCRIPT_SAFETY_CATEGORIES.length) throw new Error("missing one or more required categories");
  return out;
}

const SYSTEM_PROMPT = `You are a content safety reviewer for an AI film-generation product. Users submit a SCRIPT (screenplay text or a freeform idea), which gets turned into a real, photoreal AI-generated video. Review the script for exactly 6 risk categories BEFORE any generation spend happens.

CRITICAL CALIBRATION — READ FIRST: this is a STORYTELLING product. Ordinary fiction is made of conflict, danger, villains, and moral complexity. A thriller with a threat, a war drama, a heist film, a horror story, a slapstick comedy with cartoonish mayhem — none of that is a violation on its own. You are looking for SPECIFIC, REAL risks, not the ordinary presence of drama or conflict. Refusing normal storytelling makes this product useless for its actual purpose — that is as real a failure as missing a genuine violation.

For EACH of the 6 categories below, decide triggered (true/false) and ambiguous (true/false, only meaningful when triggered), with a one-sentence reason:

1. real_people_no_consent — the script depicts a NAMED real public figure (a politician, celebrity, historical figure) or an unambiguously-identifiable real private individual, in a way that could be defamatory, non-consensual (sexual/violent content ABOUT them), or otherwise harmful to their real reputation. Mentioning a real person's NAME in passing, or a clearly fictional character who merely shares a common name, does NOT trigger this.

2. copyrighted_ip — the script explicitly uses a SPECIFIC, recognizable copyrighted character, franchise, or clearly-branded IP (e.g. "Spider-Man", "a Pokemon", "the Batmobile", "a Coca-Cola truck" used as a plot element). A GENERIC archetype ("a superhero", "a masked vigilante", "a wizard with a wand") does NOT trigger this even if it's reminiscent of something famous.

3. minors_or_age_ambiguous_sexual_content — ANY sexual or suggestive content involving a character described as, or ambiguous about being, a minor. ZERO TOLERANCE: if the character's age is not clearly stated as an adult AND the content is sexual or suggestive in nature, this triggers as ambiguous=true even if you are not certain. Err toward triggering this category on ANY doubt at all. Ordinary non-sexual content involving a child (a birthday party, a child in a family drama) does NOT trigger this.

4. graphic_violence — violence or gore at a level of explicit, lingering graphic detail inappropriate for a general-audience platform (dwelling on mutilation, torture-porn-level gore, extreme dismemberment as spectacle). Ordinary dramatic violence (a fight, a shooting, a war scene, a monster attack, slapstick cartoon violence) does NOT trigger this — only genuinely extreme, dwelt-upon graphic content does.

5. hate_extremism_real_world_harm — content whose actual PURPOSE is to incite hatred, extremism, or real-world harm against a real group (real propaganda, real recruitment-style content, genuine dehumanization of a real protected group presented earnestly). A FICTIONAL villain who holds hateful views, portrayed AS a villain the story condemns or that serves the plot, does NOT trigger this — that is ordinary storytelling, not incitement.

6. dangerous_real_world_instructions — the script contains ACTIONABLE, technically real instructions for a dangerous real-world act (real bomb-making steps, real synthesis instructions, real hacking exploit code) embedded in the narrative text, specific enough that a reader could actually follow them. A character vaguely "building a bomb" or "hacking the mainframe" with zero real technical detail does NOT trigger this — that is ordinary fiction, not a real how-to.

Return ONLY valid JSON: { "categories": [ { "category": "<one of the 6 ids above>", "triggered": boolean, "ambiguous": boolean, "reason": string } ... one entry per category, all 6, in the order listed above ] }`;

/** The real, structured safety-classification pass — Priority 1. Runs BEFORE
 *  any paid keyframe/video generation call. Fails CLOSED on a genuine LLM/
 *  parse error for this check specifically (unlike moderateText()'s
 *  deliberate fail-open for provider outages) — an outage here should not
 *  silently let arbitrary content through the one purpose-built check for
 *  real-person/IP/dangerous-instruction risks moderateText() cannot see at
 *  all; the caller decides how to surface that (see reviewScriptSafety()'s
 *  own error contract below). */
export async function reviewScriptSafety(script: string): Promise<ScriptSafetyReview> {
  const input = String(script || "").trim().slice(0, 12000);
  if (!input) return { decision: "allow", triggeredCategories: [], summary: "" };
  if (!client) {
    console.error("[scriptSafety] LLM_API_KEY not set — content safety review CANNOT run. Failing closed.");
    return {
      decision: "refuse",
      triggeredCategories: [],
      summary: "Content safety review is not configured. Please try again later or contact support.",
    };
  }

  let categories: CategoryDecision[];
  try {
    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      response_format: { type: "json_object" },
    });
    const raw = res.choices?.[0]?.message?.content;
    if (!raw) throw new Error("empty response");
    categories = parseReview(raw);
  } catch (e) {
    // FAIL CLOSED, deliberately the opposite of moderateText()'s fail-open —
    // see this function's own doc comment for why: this is the ONLY check
    // covering real-person/IP/dangerous-instruction risk, so an outage here
    // must not silently let those through. A refused user can simply retry;
    // that's a far better failure mode than a silent generation of content
    // this exact check exists to catch.
    console.error("[scriptSafety] review failed, failing CLOSED:", (e as Error)?.message);
    return {
      decision: "refuse",
      triggeredCategories: [],
      summary: "Content safety review could not complete. Please try again in a moment.",
    };
  }

  const triggered = categories.filter((c) => c.triggered);
  if (!triggered.length) {
    return { decision: "allow", triggeredCategories: [], summary: "" };
  }
  const summary = triggered.map((c) => CATEGORY_LABEL[c.category]).join("; ");
  return {
    decision: "refuse",
    triggeredCategories: triggered.map((c) => ({ category: c.category, ambiguous: c.ambiguous, reason: c.reason })),
    summary,
  };
}

/** Every refusal — hard or ambiguous — logged with category and reason, both
 *  for the user's own understanding (the message shown to them is built from
 *  the same data) and to build a real dataset of what's actually being
 *  attempted over time (see the SafetyRefusal model, schema.prisma). Never
 *  throws — a logging failure must not block the refusal itself from taking
 *  effect. `scriptExcerpt` is deliberately truncated (not the full script) —
 *  enough context for a human reviewer to judge the call without this table
 *  becoming an unbounded copy of every refused script in full. */
export async function logSafetyRefusal(opts: {
  userId?: string | null;
  projectId?: string | null;
  stage: "script_submit" | "chat_edit" | "regen_all";
  review: ScriptSafetyReview;
  script: string;
}): Promise<void> {
  try {
    await prisma.safetyRefusal.create({
      data: {
        userId: opts.userId ?? null,
        projectId: opts.projectId ?? null,
        stage: opts.stage,
        categories: JSON.stringify(opts.review.triggeredCategories),
        reason: opts.review.summary,
        scriptExcerpt: String(opts.script || "").slice(0, 500),
      },
    });
  } catch (e) {
    console.error("[scriptSafety] could not log refusal:", (e as Error)?.message);
  }
}
