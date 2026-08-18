// ==========================================================
// PUT THIS FILE AT:  safa-web/lib/pricing.ts   *** NEW FILE ***
// ==========================================================
//
// ONE SOURCE OF TRUTH for what a film costs us and what we charge for it.
// The UI, the API route and the spend log all read from here, so a price change
// is a one-line edit instead of a hunt through the codebase.
//
// TUNE THESE CONSTANTS — everything else derives from them.

// RESTORED, 2026 — the render engine (ai-film-pro) reverted from Veo 3.1
// Lite back to Seedance 1.5 Pro (see its config.ts/spend.ts), which genuinely
// supports all three tiers again and honors Project.resolution per-render
// (applyProjectSettings()). This file had been left locked to "720p" from the
// Veo-only era; that lock now silently overrides every project to 720p
// regardless of what ai-film-pro can actually do, and blocks a resolution-
// based price lever entirely. Widened back to a real three-way union so the
// UI, the creation-time gate, and the actual charge all agree again.
export type Resolution = "480p" | "720p" | "1080p";
export type Aspect = "16:9" | "9:16" | "1:1";

/** What fal actually charges us per rendered second, by tier — Seedance 1.5
 *  Pro (see ai-film-pro/src/spend.ts's USD_PER_VIDEO_SECOND, its ONE
 *  confirmed-ish anchor: ~$0.052/s @720p w/ audio, sourced from a published
 *  $0.26-for-5s figure, not a real invoice). 480p/1080p are UNVERIFIED
 *  ESTIMATES scaled off that single anchor (roughly 0.6x / 1.9x) — Seedance's
 *  real per-resolution rates have not been independently confirmed for
 *  either tier. Check your fal.ai dashboard after the first real render at
 *  each tier and correct these to match; ai-film-pro's own spend.ts should
 *  eventually track the same three rates instead of one flat figure, since
 *  right now it bills every resolution identically regardless of what the
 *  user is actually charged here. */
const VIDEO_USD_PER_SEC: Record<Resolution, number> = {
  "480p": 0.03,
  "720p": 0.052,
  "1080p": 0.1,
};

/** generate_audio's real cost multiplier on Seedance 1.5 Pro -- an estimate
 *  (~2x), not independently confirmed against a real invoice yet -- verify
 *  against real billing once audio-on renders have actually run. */
const AUDIO_MULTIPLIER = 2;

/** Nano Banana keyframe cost. ~1 keyframe per shot, plus a 2nd on two-endpoint
 *  shots. Real films average ~1.5 images per shot. */
const IMAGE_USD = 0.08;
const AVG_IMAGES_PER_SHOT = 1.5;
// Matches ai-film-pro's own shot-count guidance (llm.ts's SHOTS section) and
// reconcileLength()'s gap/6 estimate — keep these in sync; a mismatch here
// only skews the image-cost estimate, not what's actually billed for video.
const SECONDS_PER_SHOT = 6;

/** One credit is priced to cover a standard short film with margin.
 *  Exported so the referral reward calc (stripe/webhook/route.ts) converts
 *  a real dollar reward into credits at the SAME rate everything else in
 *  the app already uses, instead of a second, driftable hardcoded number. */
export const USD_PER_CREDIT = 1.5;

/** FREE TIER CAPS — the launch guardrails. Resolution is a lever again now
 *  that all three tiers are real: the free plan gets the cheapest one. */
export const FREE_MAX_SECONDS = 15;
export const FREE_MAX_RESOLUTION: Resolution = "480p";
export const FREE_ALLOW_AUDIO = false;

// Ordered cheapest -> priciest. applyPlanLimits() below compares indices into
// this array, so the ORDER here (not just membership) matters.
export const RESOLUTIONS: Resolution[] = ["480p", "720p", "1080p"];
export const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

export interface FilmSettings {
  seconds: number;
  resolution: Resolution;
  audio: boolean;
}

/** Our real cost to produce this film, in USD. */
export function estimateCostUsd({ seconds, resolution, audio }: FilmSettings): number {
  const secs = Math.max(1, Math.round(seconds));
  const perSec = VIDEO_USD_PER_SEC[resolution] ?? VIDEO_USD_PER_SEC["720p"];
  const video = secs * perSec * (audio ? AUDIO_MULTIPLIER : 1);
  const shots = Math.max(1, Math.ceil(secs / SECONDS_PER_SHOT));
  const images = shots * AVG_IMAGES_PER_SHOT * IMAGE_USD;
  return Math.round((video + images) * 100) / 100;
}

/** Credits to charge the user. Always at least 1. */
export function creditsFor(s: FilmSettings): number {
  return Math.max(1, Math.ceil(estimateCostUsd(s) / USD_PER_CREDIT));
}

/**
 * Enforce plan limits. Returns the settings actually allowed, plus a note when
 * something was clamped so the UI can explain it instead of silently changing
 * what the user asked for.
 */
export function applyPlanLimits(
  s: FilmSettings,
  plan: string,
): { settings: FilmSettings; clamped: string[] } {
  // .toLowerCase() to match every other plan-tier check in the codebase
  // (spend.ts, worker.ts, chat/route.ts) — currently a DB value is always
  // already-lowercase in practice (the Stripe checkout route's PLAN_PRICE_ID
  // lookup rejects anything miscased before it ever reaches Stripe metadata),
  // but that's an accidental guarantee from an unrelated code path, not
  // something this function should silently depend on holding forever.
  const isFree = !plan || plan.toLowerCase() === "free" || plan.toLowerCase() === "lite";
  if (!isFree) return { settings: s, clamped: [] };

  const clamped: string[] = [];
  const out: FilmSettings = { ...s };

  if (out.seconds > FREE_MAX_SECONDS) {
    out.seconds = FREE_MAX_SECONDS;
    clamped.push(`length capped to ${FREE_MAX_SECONDS}s on the free plan`);
  }
  if (RESOLUTIONS.indexOf(out.resolution) > RESOLUTIONS.indexOf(FREE_MAX_RESOLUTION)) {
    out.resolution = FREE_MAX_RESOLUTION;
    clamped.push(`resolution capped to ${FREE_MAX_RESOLUTION} on the free plan`);
  }
  if (out.audio && !FREE_ALLOW_AUDIO) {
    out.audio = false;
    clamped.push("audio is a paid feature");
  }
  return { settings: out, clamped };
}

/** Normalise anything arriving from the client. Resolution IS taken from the
 *  client again (each tier is real again — see Resolution above), but never
 *  trusted blindly: anything outside RESOLUTIONS (a stale client, a tampered
 *  request, an old cached page from the 720p-only era) falls back to 720p
 *  rather than being rejected outright or silently accepted as something
 *  ai-film-pro might not honor. */
export function sanitizeSettings(raw: any): FilmSettings {
  const resolution: Resolution = RESOLUTIONS.includes(raw?.resolution) ? raw.resolution : "720p";
  const seconds = Number.isFinite(Number(raw?.seconds)) ? Math.max(5, Math.min(600, Math.round(Number(raw.seconds)))) : 20;
  return { seconds, resolution, audio: raw?.audio === true };
}

export function sanitizeAspect(raw: any): Aspect {
  return ASPECTS.includes(raw) ? raw : "16:9";
}