// ==========================================================
// PUT THIS FILE AT:  safa-web/lib/moderation.ts   *** NEW FILE - create it ***
// (rename to: moderation.ts)
// ==========================================================
import OpenAI from "openai";

const client = process.env.LLM_API_KEY ? new OpenAI({ apiKey: process.env.LLM_API_KEY }) : null;

export type Moderation = { allowed: boolean; reason?: string };

const LABEL: Record<string, string> = {
  sexual: "sexual content",
  "sexual/minors": "sexual content involving minors",
  harassment: "harassment",
  "harassment/threatening": "threats",
  hate: "hate speech",
  "hate/threatening": "violent hate speech",
  violence: "graphic violence",
  "violence/graphic": "graphic violence",
  "self-harm": "self-harm",
  "self-harm/intent": "self-harm",
  "self-harm/instructions": "self-harm",
  illicit: "illegal activity",
  "illicit/violent": "violent illegal activity",
};

/**
 * PER-CATEGORY CONFIDENCE THRESHOLDS.
 *
 * The old check used OpenAI's boolean `flagged`, which flips on ANY signal at all.
 * That is right for a chat product and wrong for a screenwriting tool: fiction is
 * made of conflict. A slapstick farm comedy — a goat headbutting a thief into an
 * irrigation ditch — was refused as "graphic violence", because "headbutts",
 * "blasting him backward" and "colliding mid-air" register as violence at low
 * confidence even though nothing in the script is remotely graphic.
 *
 * So we read `category_scores` (0-1) instead, and require real confidence before
 * refusing. Storytelling categories get a high bar; the categories where a false
 * NEGATIVE is unacceptable keep a very low one. Child safety is effectively zero
 * tolerance and must stay that way.
 *
 * Lower number = stricter.
 */
const THRESHOLDS: Record<string, number> = {
  // ── Non-negotiable. A near-zero bar; never raise these. ──
  "sexual/minors": 0.05,
  "self-harm/instructions": 0.20,
  "self-harm/intent": 0.30,
  "hate/threatening": 0.30,

  // ── Serious. Normal bar. ──
  sexual: 0.50,
  hate: 0.50,
  "self-harm": 0.50,
  "illicit/violent": 0.50,
  "harassment/threatening": 0.60,
  illicit: 0.70,
  harassment: 0.80,

  // ── Storytelling. A high bar: thrillers, horror and slapstick all live here,
  //    and blocking them makes the product useless for its actual purpose.
  //    Genuinely graphic material still scores far above these. ──
  "violence/graphic": 0.80,
  violence: 0.88,
};

const DEFAULT_THRESHOLD = 0.7;

/** Screen user text (a script, an idea, a chat edit) before it is turned into a film.
 *  This is the FIRST of three layers. The provider safety checkers (fal) are the second,
 *  and human abuse reports plus admin takedown are the third. */
export async function moderateText(text: string): Promise<Moderation> {
  const input = String(text || "").trim().slice(0, 8000);
  if (!input) return { allowed: true };
  // Not configured: allow, but say so loudly in the logs so it is never silently off.
  if (!client) {
    console.warn("[moderation] LLM_API_KEY not set - content is NOT being screened.");
    return { allowed: true };
  }
  try {
    const res = await client.moderations.create({ model: "omni-moderation-latest", input });
    const r = res.results?.[0];
    if (!r) return { allowed: true };

    // Score-based, not boolean. A category only blocks when the model is actually
    // confident, which is what stops fiction being refused for containing conflict.
    const scores = (r.category_scores || {}) as unknown as Record<string, number>;
    const breached = Object.entries(scores).filter(
      ([cat, score]) => (score ?? 0) >= (THRESHOLDS[cat] ?? DEFAULT_THRESHOLD),
    );
    if (!breached.length) {
      // Useful when tuning: shows what nearly tripped, without refusing anything.
      const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] > 0.2) {
        console.log(`[moderation] allowed — highest signal "${top[0]}" at ${top[1].toFixed(2)} (limit ${(THRESHOLDS[top[0]] ?? DEFAULT_THRESHOLD).toFixed(2)})`);
      }
      return { allowed: true };
    }
    console.warn(
      `[moderation] BLOCKED: ${breached.map(([c, v]) => `${c}=${v.toFixed(2)}`).join(", ")}`,
    );
    const hits = breached.map(([k]) => LABEL[k] || k);
    const reason = Array.from(new Set(hits)).slice(0, 3).join(", ") || "our content policy";
    console.warn(`[moderation] BLOCKED: ${reason}`);
    return { allowed: false, reason };
  } catch (e) {
    // FAIL OPEN: an outage at the moderation provider must not take the product down.
    // The provider-side safety checkers still apply, and abuse reports remain the backstop.
    console.error("[moderation] check failed, allowing through:", (e as Error)?.message);
    return { allowed: true };
  }
}

/** Screen an uploaded IMAGE (e.g. a product photo for an ad) before it enters the
 *  pipeline. Uploads are a new abuse surface, so this runs BEFORE the file is stored
 *  and used. Uses the same omni-moderation model, which accepts image URLs. */
export async function moderateImage(imageUrl: string): Promise<Moderation> {
  if (!imageUrl) return { allowed: true };
  if (!client) {
    console.warn("[moderation] LLM_API_KEY not set - uploaded image is NOT being screened.");
    return { allowed: true };
  }
  try {
    const res = await client.moderations.create({
      model: "omni-moderation-latest",
      input: [{ type: "image_url", image_url: { url: imageUrl } }] as any,
    });
    const r = res.results?.[0];
    if (!r?.flagged) return { allowed: true };
    const hits = Object.entries(r.categories || {})
      .filter(([, on]) => on)
      .map(([k]) => LABEL[k] || k);
    const reason = Array.from(new Set(hits)).slice(0, 3).join(", ") || "our content policy";
    console.warn(`[moderation] IMAGE BLOCKED: ${reason}`);
    return { allowed: false, reason };
  } catch (e) {
    console.error("[moderation] image check failed, allowing through:", (e as Error)?.message);
    return { allowed: true };
  }
}

/** Standard refusal message shown to the user. */
export function blockedMessage(reason?: string): string {
  return `This can't be made into a film. It looks like it involves ${reason || "content against our policy"}. Please edit it and try again.`;
}