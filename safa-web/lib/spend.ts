import { prisma } from "@/lib/prisma";

const DAILY_CAP_USD = parseFloat(process.env.DAILY_SPEND_CAP_USD ?? "25");
const USER_MONTHLY_CAP_USD = parseFloat(process.env.USER_MONTHLY_CAP_USD ?? "30");

// Plans that are allowed exactly ONE free film, ever.
const FREE_PLANS = new Set(["lite", "free"]);

// Set REQUIRE_VERIFIED_EMAIL=false only for local dev. In production this MUST be true,
// or the one-film cap is defeated by signing up with throwaway addresses.
const REQUIRE_VERIFIED_EMAIL = (process.env.REQUIRE_VERIFIED_EMAIL ?? "true") !== "false";

/**
 * Mirror of the worker's spend caps, PLUS the free-tier one-film-per-account cap.
 * Runs BEFORE any credit is taken, so a blocked user is told immediately and never
 * charged, instead of the render failing minutes later on our dime.
 *
 * Returns a human-readable reason string if the render should be refused, else null.
 *
 * NOTE: this is the ADVISORY check for a fast, friendly error. The AUTHORITATIVE
 * cap is enforced atomically in claimFreeFilm() inside the render transaction —
 * two tabs clicking "generate" at once cannot both slip through, because the DB
 * write is conditional. Always call claimFreeFilm() in the transaction; this
 * function only exists to fail fast with a nice message.
 */
export async function spendBlocked(userId: string): Promise<string | null> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [user, today, month] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, emailVerified: true, freeFilmUsedAt: true },
    }),
    prisma.spend.aggregate({ _sum: { amountUsd: true }, where: { createdAt: { gte: dayAgo } } }),
    prisma.spend.aggregate({ _sum: { amountUsd: true }, where: { userId, createdAt: { gte: monthAgo } } }),
  ]);

  if (!user) return "Account not found.";

  // Global + per-user budget guards (unchanged).
  if ((today._sum.amountUsd ?? 0) >= DAILY_CAP_USD) {
    return "safa has hit its rendering budget for today. Films will start again tomorrow. Sorry about that.";
  }
  if ((month._sum.amountUsd ?? 0) >= USER_MONTHLY_CAP_USD) {
    return "You've reached your monthly rendering limit. Email support@safa.ai if you need it raised.";
  }

  // ── THE FREE-FILM CAP ──────────────────────────────────────────────────────
  const isFreePlan = FREE_PLANS.has((user.plan || "lite").toLowerCase());
  if (isFreePlan) {
    // (a) A free film costs us real money (~$0.80 of Seedance 1.5 Pro at the free
    //     tier's own ceiling settings -- 15s, 480p, no audio; see pricing.ts's
    //     estimateCostUsd()). One throwaway signup = one more free film. So the
    //     free film requires a VERIFIED identity.
    if (REQUIRE_VERIFIED_EMAIL && !user.emailVerified) {
      return "Please verify your email to render your free film. Check your inbox for the link.";
    }
    // (b) One free film per account, ever. (Advisory — the transaction enforces it.)
    if (user.freeFilmUsedAt) {
      return "You've used your free film. Subscribe to make more — full quality, no watermark.";
    }
  }

  return null;
}

/**
 * ATOMIC free-film claim. Call this INSIDE the render $transaction.
 *
 * For a paid plan: no-op (returns true).
 * For a free plan: flips freeFilmUsedAt from NULL → now(), but ONLY if it is still
 *   NULL. The `updateMany ... where freeFilmUsedAt: null` makes the write conditional,
 *   so if two requests race, exactly ONE updates a row (count 1) and the other gets
 *   count 0 and must be rejected. This is what actually enforces the cap; the check
 *   in spendBlocked() is just for a nice early error message.
 *
 * Returns true if the render may proceed, false if the free film was already claimed.
 */
export async function claimFreeFilm(tx: any, userId: string, plan: string): Promise<boolean> {
  if (!FREE_PLANS.has((plan || "lite").toLowerCase())) return true; // paid: unlimited (credits govern)

  const res = await tx.user.updateMany({
    where: { id: userId, freeFilmUsedAt: null },
    data: { freeFilmUsedAt: new Date() },
  });
  return res.count === 1;
}