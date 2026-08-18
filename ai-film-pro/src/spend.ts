// ==========================================================
// PUT THIS FILE AT:  ai-film-pro/src/spend.ts   *** NEW FILE ***
// (rename to: spend.ts)
// ==========================================================
import { prisma } from "./db";

/** COST MODEL.
 *  These are estimates, not invoices. They exist so the system can STOP ITSELF before it
 *  burns a budget, which is the whole point. Provider prices move, so they are env-tunable.
 *  Check the live fal pricing pages every couple of months and update the defaults. */
// MIGRATED: Seedance 1.5 Pro -> Veo 3.1 Lite -> Kling 3.0 Turbo -> Veo 3.1
// Lite -> Veo 3.1 FULL "Quality" tier -> Seedance 1.5 Pro. REVERTED 2026-07-28:
// the Veo Quality tier's $0.40/s led directly to a $50 render that never
// finished. "0.052" below is sourced from a real published figure -- $0.26
// for a 5-second 720p clip WITH AUDIO on Seedance 1.5 Pro ($0.26 / 5 = $0.052/s)
// -- a better-grounded number than a bare guess, but still not a real invoice,
// so still marked UNVERIFIED per this file's own standing convention: check
// your fal.ai dashboard after the first real render and correct
// USD_PER_VIDEO_SECOND in your real .env if it differs.
const USD_PER_VIDEO_SECOND = parseFloat(process.env.USD_PER_VIDEO_SECOND ?? "0.052"); // Seedance 1.5 Pro @720p w/ audio -- UNVERIFIED, sourced from a published per-clip figure
const USD_PER_IMAGE = parseFloat(process.env.USD_PER_IMAGE ?? "0.04");               // keyframe / character option

// TOPAZ UPSCALE PRICING — real, published tiers (fal-ai/topaz/upscale/video),
// keyed by the DELIVERY resolution (the output tier), not the linear
// upscale_factor. Confirmed via a live test call (see providers/upscale.ts's
// own comment) that the integration itself works; these three rates are the
// provider's own published pricing, not independently re-derived from a
// per-clip invoice the way USD_PER_VIDEO_SECOND above was, so treat them
// with the same "verify against your real fal.ai dashboard, correct your
// .env if it differs" discipline as every other price in this file.
const USD_PER_UPSCALE_SECOND_TO_720P = parseFloat(process.env.USD_PER_UPSCALE_SECOND_TO_720P ?? "0.01");
const USD_PER_UPSCALE_SECOND_TO_1080P = parseFloat(process.env.USD_PER_UPSCALE_SECOND_TO_1080P ?? "0.02");
const USD_PER_UPSCALE_SECOND_ABOVE_1080P = parseFloat(process.env.USD_PER_UPSCALE_SECOND_ABOVE_1080P ?? "0.08");

// MUSIC (fal-ai/cassetteai/music-generator, see providers/music.ts) — real,
// published per-MINUTE pricing (fal's own pricing page), not per-second like
// the rates above, so this is its own function rather than reusing
// costOfClip's per-second math. UNVERIFIED against a real invoice, same
// standing convention as every other price in this file.
const USD_PER_MUSIC_MINUTE = parseFloat(process.env.USD_PER_MUSIC_MINUTE ?? "0.02");

/** Hard ceilings. When either is hit, rendering STOPS. A blown cap is a bad day.
 *  An uncapped runaway is a bankruptcy. Defaults are deliberately conservative. */
export const DAILY_CAP_USD = parseFloat(process.env.DAILY_SPEND_CAP_USD ?? "500");
export const USER_MONTHLY_CAP_USD = parseFloat(process.env.USER_MONTHLY_CAP_USD ?? "5000");

export const costOfClip = (seconds: number) => Math.max(0, seconds) * USD_PER_VIDEO_SECOND;
export const costOfImages = (count: number) => Math.max(0, count) * USD_PER_IMAGE;

/** `deliveryResolution` picks the real Topaz pricing tier — "720p" bills at
 *  the up-to-720p rate, "1080p" at the 720p-1080p rate; anything else (a
 *  future higher tier) at the above-1080p rate. "480p" never reaches this
 *  function at all (see 5-videos.ts — no upscale call happens when delivery
 *  already equals generation resolution), so there is no 480p case here. */
export const costOfUpscale = (seconds: number, deliveryResolution: string) => {
  const rate =
    deliveryResolution === "720p" ? USD_PER_UPSCALE_SECOND_TO_720P
    : deliveryResolution === "1080p" ? USD_PER_UPSCALE_SECOND_TO_1080P
    : USD_PER_UPSCALE_SECOND_ABOVE_1080P;
  return Math.max(0, seconds) * rate;
};

export const costOfMusic = (seconds: number) => (Math.max(0, seconds) / 60) * USD_PER_MUSIC_MINUTE;

/** Record what a step actually cost. Never throws: a logging failure must not kill a render. */
export async function logSpend(kind: "clip" | "image" | "upscale" | "music", opts: { userId?: string; projectId?: string; units: number; amountUsd: number }) {
  await prisma.spend
    .create({ data: { kind, userId: opts.userId ?? null, projectId: opts.projectId ?? null, units: opts.units, amountUsd: opts.amountUsd } })
    .catch((e) => console.error("[spend] could not log:", (e as Error)?.message));
}

export type CapCheck = { ok: true } | { ok: false; reason: string };

/**
 * Thrown by checkCaps()'s callers when a budget cap is exceeded. A budget cap
 * is DETERMINISTIC within the retry window — if you're over budget now, you
 * are still over budget 30 seconds later — so this must be classified as a
 * permanent (non-retriable) failure the same way a content refusal or a 4xx
 * is, in worker.ts's tick(). Without this, a plain Error here gets treated as
 * transient and retried up to MAX_ATTEMPTS times with backoff delays before
 * the correct "you've hit your limit" message finally reaches the user.
 */
export class BudgetCapExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetCapExceededError";
    Object.setPrototypeOf(this, BudgetCapExceededError.prototype);
  }
}

/** Called BEFORE any expensive job starts. This is the backstop that runs even if you forgot
 *  to set a cap in the fal or OpenAI dashboard.
 *
 *  `estimatedAdditionalUsd` (default 0, every existing caller unaffected):
 *  CONFIRMED REAL GAP, FIXED — this only ever checked spend ALREADY logged
 *  today/this month, never the job that's ABOUT to run. A render costing a
 *  perfectly reasonable $50 sailing straight past a daily cap sitting at
 *  $490/$500 was invisible here — checkCaps() said "ok", the render started,
 *  and the cap was only ever discovered blown AFTER the money was spent.
 *  Passing the job's own forecast (estimateShotsJob(), below — previously
 *  defined but never actually called from anywhere) folds it into the SAME
 *  check, so a job that WOULD blow the cap is refused before a single call
 *  is made, not after. */
export async function checkCaps(userId: string, estimatedAdditionalUsd = 0): Promise<CapCheck> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [today, thisMonth] = await Promise.all([
    prisma.spend.aggregate({ _sum: { amountUsd: true }, where: { createdAt: { gte: dayAgo } } }),
    prisma.spend.aggregate({ _sum: { amountUsd: true }, where: { userId, createdAt: { gte: monthAgo } } }),
  ]);

  const globalToday = today._sum.amountUsd ?? 0;
  const userMonth = thisMonth._sum.amountUsd ?? 0;

  if (globalToday >= DAILY_CAP_USD) {
    return { ok: false, reason: `safa has hit its daily rendering budget ($${DAILY_CAP_USD}). Films will start again tomorrow.` };
  }
  if (userMonth >= USER_MONTHLY_CAP_USD) {
    return { ok: false, reason: `You've reached your monthly rendering limit. Get in touch if you need it raised.` };
  }
  if (estimatedAdditionalUsd > 0 && globalToday + estimatedAdditionalUsd >= DAILY_CAP_USD) {
    return { ok: false, reason: `This render is forecast to push safa past its daily rendering budget ($${DAILY_CAP_USD}). Try again tomorrow.` };
  }
  if (estimatedAdditionalUsd > 0 && userMonth + estimatedAdditionalUsd >= USER_MONTHLY_CAP_USD) {
    return { ok: false, reason: `This render is forecast to push you past your monthly rendering limit. Get in touch if you need it raised.` };
  }
  return { ok: true };
}

// estimateShotsJob() used to live here (a combined image+clip cost forecast
// for checkCaps()'s estimatedAdditionalUsd). DEAD CODE, REMOVED: since the
// keyframes/clips job split, worker.ts forecasts each pass separately
// (costOfImages() alone in the keyframes pass, costOfClip() alone in the
// clips pass — they're no longer one combined job to forecast together), and
// nothing else called this.