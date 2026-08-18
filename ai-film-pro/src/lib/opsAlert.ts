// src/lib/opsAlert.ts
// -----------------------------------------------------------------------------
// PASSIVE PROVIDER-HEALTH SIGNAL — pre-launch ops automation (2026-08-07).
//
// The honest signal for "is OpenAI/fal.ai out of credits or otherwise
// unreachable" is NOT a proactive balance-check API call — neither provider
// exposes a reliable one for this kind of account. This project's
// LLM_API_KEY is a modern project-scoped "sk-proj-..." key, and OpenAI does
// not expose billing/credit-balance endpoints to that key type (billing is
// dashboard-only); fal.ai's own billing is dashboard-only too, per this
// project's own .env comment history ("real cost, from the user's own
// fal.ai billing, not a rate card"). Rather than build a fake/guessed
// balance check against an endpoint that may not exist, this passively
// watches the REAL provider calls the pipeline already makes during normal
// rendering — the exact call that failed today's real OpenAI-out-of-credits
// incident IS the detector, the moment it happens, not a separate poll
// lagging behind it.
//
// logOpsFinding() is a best-effort, fire-and-forget Prisma write — same
// "never let logging break the actual job" discipline spend.ts's
// logSpend() already established.
// -----------------------------------------------------------------------------

import { prisma } from "../db";

export async function logOpsFinding(
  source: string,
  severity: "info" | "warn" | "critical",
  message: string,
  detail = "",
): Promise<void> {
  try {
    await prisma.opsFinding.create({ data: { source, severity, message, detail } });
  } catch (e) {
    // Best-effort: a logging failure must never take down the real job it's
    // trying to report on.
    console.warn(`   ⚠️  logOpsFinding failed (non-fatal): ${(e as Error)?.message}`);
  }
}

/** True when a provider error means "we cannot reach/afford this provider at
 *  all right now" — insufficient credits/quota, a revoked/invalid key, or a
 *  rate limit severe enough to be an outage — as distinct from every other
 *  kind of provider failure this codebase already handles separately.
 *  DELIBERATELY NOT the same thing as isContentPolicyError() (image.ts/
 *  video.ts): a content refusal means the ACCOUNT is fine and the PROMPT was
 *  rejected — the opposite signal from what this function exists to catch.
 *  HTTP status is the most reliable signal (401/403 = auth/key problem, 429
 *  = rate/quota, 402 = payment required, wherever the provider's SDK
 *  surfaces it), backed by a text fallback for providers/SDKs that bury the
 *  real status inside a message string instead. */
export function isBillingOrAuthError(e: any): boolean {
  const status = e?.status ?? e?.response?.status ?? e?.statusCode;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  const text = JSON.stringify(e?.body ?? e?.response?.data ?? "") + " " + String(e?.message ?? "");
  return /insufficient[_\s]?quota|insufficient[_\s]?credit|billing|out of credits|exceeded your current quota|invalid[_\s]?api[_\s]?key|unauthorized|rate[_\s]?limit/i.test(text);
}

/** Shared "log it once, as an OpsFinding" call for a classified billing/auth
 *  error — kept as one function so the three provider files (llm.ts,
 *  image.ts, video.ts) that each independently classify this error type
 *  report it in the exact same shape, not three slightly-drifted ones. */
export function reportBillingOrAuthError(provider: "openai" | "fal", e: any): void {
  const status = e?.status ?? e?.response?.status ?? e?.statusCode;
  const message = `${provider === "openai" ? "OpenAI" : "fal.ai"} call failed with a billing/auth-shaped error` + (status ? ` (HTTP ${status})` : "");
  void logOpsFinding(
    "provider-balance",
    "critical",
    message,
    JSON.stringify(e?.body ?? e?.response?.data ?? String(e?.message ?? e)).slice(0, 2000),
  );
}
