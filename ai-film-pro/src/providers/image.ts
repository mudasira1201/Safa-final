import { fal } from "../falClient";
import { config, keyframeAspect } from "../config";
import { isBillingOrAuthError, reportBillingOrAuthError } from "../lib/opsAlert";
import { withTimeout } from "../util";

// fal.subscribe() has no built-in timeout — a stalled connection hangs this
// call (and the whole job with it) forever. See withTimeout()'s own comment.
//
// LOWERED 300s -> 120s, WITH REAL RETRIES (below). 300s was not a considered
// budget, it was "long enough that nothing legitimate could hit it" — but the
// only thing it actually bought was a LONGER WAIT before failing. A healthy
// nano-banana call returns in seconds; a call still hanging at two minutes is
// a stalled connection, not a slow one, and waiting another three minutes for
// it never once turned into a success. Meanwhile the cost of giving up was
// enormous, because a throw here failed the WHOLE JOB: the worker then waited
// its own 30s backoff and re-ran the entire step from scratch (options has no
// per-item cache — see 2b-location-options.ts's loop), re-paying for every
// image that had already succeeded.
//
// Confirmed from a real run: "generateImages timed out after 300s" -> "job
// failed (attempt 1/3), retrying in 30s" -> the whole options step started
// over. Retrying the ONE stalled call in place instead turns that ~5.5-minute
// detour into a few seconds in the overwhelmingly common case.
const IMAGE_TIMEOUT_MS = parseInt(process.env.IMAGE_TIMEOUT_MS ?? "", 10) > 0
  ? parseInt(process.env.IMAGE_TIMEOUT_MS!, 10)
  : 120_000;

/** Transient = worth retrying the identical request. A timeout/stall, a fal
 *  5xx, or a dropped socket are all "the request never really ran"; a 422, a
 *  content-policy refusal, or a billing/auth error are deterministic and would
 *  fail identically forever, so they deliberately do NOT match — retrying those
 *  is the exact behaviour that wastes minutes for zero chance of success (the
 *  same reasoning worker.ts's own `permanent` check already applies at the job
 *  level). */
function isTransientImageError(e: any): boolean {
  if (isBillingOrAuthError(e)) return false;
  const status = e?.status ?? e?.response?.status;
  if (typeof status === "number" && status >= 400 && status < 500) return false;
  const text = `${e?.message ?? ""} ${e?.code ?? ""}`;
  if (/content_policy_violation/i.test(JSON.stringify(e?.body ?? ""))) return false;
  return (
    /timed out after/i.test(text) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed/i.test(text) ||
    (typeof status === "number" && status >= 500)
  );
}

/** How many times a transient image failure is retried IN PLACE, before the
 *  error is allowed to escape and fail the job. Three total attempts against a
 *  120s timeout bounds the worst case at ~6 minutes — roughly what ONE old
 *  300s attempt plus the job-level backoff already cost, except this path can
 *  actually succeed instead of restarting the whole step. */
const IMAGE_MAX_ATTEMPTS = 3;

/** Shared transient-retry wrapper for every fal image call in this file. */
async function withImageRetries<T>(label: string, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (e: any) {
      if (attempt >= IMAGE_MAX_ATTEMPTS || !isTransientImageError(e)) throw e;
      const wait = 2_000 * attempt;
      console.warn(
        `   ↻ ${label} failed transiently (attempt ${attempt}/${IMAGE_MAX_ATTEMPTS}), retrying in ${wait / 1000}s: ${e?.message ?? e}`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const isNano = (m: string) => /nano-banana|gemini/i.test(m);

// Nano Banana legal aspect ratios (fal enum). Anything else 422s. We snap to the
// nearest legal value so a stray "3:4"/"16:9"/"1:1" request can never be rejected
// for the ratio alone.
const NANO_RATIOS = new Set([
  "auto","21:9","16:9","3:2","4:3","5:4","1:1","4:5","3:4","2:3","9:16","4:1","1:4","8:1","1:8",
]);
const nanoRatio = (r: string) => (NANO_RATIOS.has(r) ? r : "auto");

/** Log fal's REAL, field-level reason. "Unprocessable Entity" is only the HTTP
 *  status; the body says WHICH field was wrong. image.ts used to swallow this,
 *  so a 422 here was a dead end. Never again. */
function logFalError(where: string, model: string, input: Record<string, any>, e: any): void {
  console.error(`\n❌ Image model rejected the request (${where} · ${model}). Actual reason:`);
  console.error(JSON.stringify(e?.body ?? e?.response?.data ?? e?.message ?? e, null, 2));
  console.error(`   sent → model: ${model} | keys: [${Object.keys(input).join(", ")}] | aspect: ${input.aspect_ratio ?? input.image_size ?? "—"}\n`);
  // PASSIVE PROVIDER-HEALTH SIGNAL — see lib/opsAlert.ts. Both of this
  // file's real fal.ai call sites already route their error through this
  // one function, so this is the single place to classify+report a
  // billing/auth-shaped failure without touching either call site directly.
  if (isBillingOrAuthError(e)) reportBillingOrAuthError("fal", e);
}

/** True when fal refused the PROMPT on content grounds — not a transient or field error.
 *  Retrying identical text always fails identically, so callers must degrade or surface it.
 *
 *  "no_media_generated" (seen from Veo 3.1 Lite) is treated the SAME as a clean
 *  content_policy_violation, even though fal's own message for it lists several
 *  possible causes ("unsafe content", a prompt incompatible with the media
 *  type, missing references, etc) rather than naming content as the definite
 *  cause. From the pipeline's point of view the outcome is identical either
 *  way: THIS shot cannot render as currently written, and retrying identical
 *  text will fail identically. Treating it as anything else meant it fell
 *  through to an unhandled crash of the WHOLE job instead of gracefully
 *  parking just this one shot for a rewrite (confirmed on camera: a coin-
 *  exchange close-up hit this exact error and took the entire render down). */
export function isContentPolicyError(e: any): boolean {
  const body = e?.body ?? e?.response?.data ?? {};
  const detail = Array.isArray(body?.detail) ? body.detail : [];
  const REFUSAL_TYPES = new Set(["content_policy_violation", "no_media_generated"]);
  if (detail.some((d: any) => REFUSAL_TYPES.has(d?.type))) return true;
  const text = JSON.stringify(body ?? "") + String(e?.message ?? "");
  return /content_policy_violation|flagged by a content checker|content policy|no_media_generated|did not generate the expected output/i.test(text);
}

/** True ONLY for the specific "no_media_generated" refusal type — narrower than
 *  isContentPolicyError() above, which intentionally lumps it in with genuine
 *  content_policy_violation for the PARK-vs-CRASH decision made by callers in
 *  4-images.ts/5-videos.ts. This check exists for a different, earlier decision:
 *  whether a single failed call is worth one immediate retry before it ever
 *  reaches that park/crash logic. no_media_generated's own message is a
 *  catch-all ("unsafe content OR incompatible prompt OR missing attachments OR
 *  other cases") — it fired once on a single character-sheet angle that had
 *  rendered fine for every other character, which looks like a transient
 *  model hiccup rather than a real refusal. content_policy_violation is a
 *  clean, named refusal — retrying identical text always fails identically,
 *  so it deliberately gets NO retry here. */
function isNoMediaGeneratedError(e: any): boolean {
  const body = e?.body ?? e?.response?.data ?? {};
  const detail = Array.isArray(body?.detail) ? body.detail : [];
  if (detail.some((d: any) => d?.type === "no_media_generated")) return true;
  const text = JSON.stringify(body ?? "") + String(e?.message ?? "");
  return /no_media_generated/i.test(text) && !/content_policy_violation/i.test(text);
}

/** Text-to-image. Returns N image URLs (character look-options). */
export async function generateImages(prompt: string, count = 1, aspectRatio = "16:9"): Promise<string[]> {
  const input: Record<string, any> = { prompt, num_images: count };
  if (isNano(config.imageModel)) {
    input.aspect_ratio = nanoRatio(aspectRatio);
    input.resolution = "1K";
  } else {
    input.image_size = aspectRatio === "16:9" ? "landscape_16_9" : "portrait_4_3";
  }
  try {
    return await withImageRetries("generateImages", async () => {
      const result = await withTimeout(fal.subscribe(config.imageModel, { input, logs: false }), IMAGE_TIMEOUT_MS, "generateImages");
      const images = (result.data as any)?.images;
      if (!images?.length) throw new Error("Image model returned no images.");
      return images.map((im: any) => im.url) as string[];
    });
  } catch (e: any) {
    logFalError("generateImages", config.imageModel, input, e);
    throw e;
  }
}

/** Reference-based edit: keep the people in `referenceUrls` looking identical. */
export async function editFromReferences(prompt: string, referenceUrls: string[], aspectRatio?: string): Promise<string> {
  if (referenceUrls.length === 0) {
    const [url] = await generateImages(prompt, 1);
    return url;
  }
  const input: Record<string, any> = {
    prompt,
    image_urls: referenceUrls.slice(0, 14), // Nano Banana supports up to 14 refs
    num_images: 1,
  };
  if (isNano(config.imageEditModel)) {
    // WAS HARDCODED "16:9" — which silently forced every film to landscape no
    // matter what the user picked, because the video model's i2v output takes
    // its shape from the input keyframe. The orientation must start here.
    input.aspect_ratio = nanoRatio(aspectRatio || keyframeAspect());
    input.resolution = "1K";
  }
  const MAX_ATTEMPTS = 3; // 1 try + 2 retries, no_media_generated only — see isNoMediaGeneratedError()
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // The inner wrapper handles TRANSIENT failures (stall/5xx/socket); this
      // outer loop handles no_media_generated, which is a real model response
      // rather than a failed request and so needs its own, longer backoff.
      return await withImageRetries("editFromReferences", async () => {
        const result = await withTimeout(fal.subscribe(config.imageEditModel, { input, logs: false }), IMAGE_TIMEOUT_MS, "editFromReferences");
        const url = (result.data as any)?.images?.[0]?.url;
        if (!url) throw new Error("Image-edit model returned no image URL.");
        return url as string;
      });
    } catch (e: any) {
      const willRetry = attempt < MAX_ATTEMPTS && isNoMediaGeneratedError(e);
      logFalError(`editFromReferences${willRetry ? ` (attempt ${attempt}/${MAX_ATTEMPTS}, retrying)` : ""}`, config.imageEditModel, input, e);
      if (!willRetry) throw e;
      await new Promise((r) => setTimeout(r, 4_000 * attempt));
    }
  }
  throw new Error("unreachable"); // loop always returns or throws
}