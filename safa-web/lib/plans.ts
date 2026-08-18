export type PlanId = "lite" | "plus" | "pro" | "enterprise";

// Render credits granted per plan (align these with your pricing).
export const PLAN_CREDITS: Record<PlanId, number> = { lite: 3, plus: 15, pro: 60, enterprise: 1000 };

// Stripe Price IDs for the paid plans (from your Stripe dashboard).
export const PLAN_PRICE_ID: Record<string, string | undefined> = {
  plus: process.env.STRIPE_PRICE_PLUS,
  pro: process.env.STRIPE_PRICE_PRO,
};

export function planFromPriceId(priceId?: string | null): PlanId {
  if (priceId && priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (priceId && priceId === process.env.STRIPE_PRICE_PLUS) return "plus";
  return "lite";
}
