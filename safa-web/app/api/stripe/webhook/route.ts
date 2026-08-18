import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { PLAN_CREDITS, planFromPriceId, type PlanId } from "@/lib/plans";
import { USD_PER_CREDIT } from "@/lib/pricing";
import type Stripe from "stripe";

export async function POST(req: Request) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature") || "";
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET || "");
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object as Stripe.Checkout.Session;
      const userId = s.metadata?.userId;
      const plan = (s.metadata?.plan || "lite") as PlanId;
      if (userId) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            plan,
            credits: PLAN_CREDITS[plan] ?? 3,
            stripeCustomerId: (s.customer as string) || undefined,
            stripeSubscriptionId: (s.subscription as string) || undefined,
          },
        });

        // REFERRAL PROGRAM — queue a reward, never grant one automatically.
        // 10% of what was ACTUALLY charged (s.amount_total, in cents), not a
        // hardcoded plan-price constant — self-corrects if Stripe prices
        // ever change, and there's no second source of truth to drift out of
        // sync. Converted to credits at the same USD_PER_CREDIT rate the
        // rest of the app already prices against. The referredUserId unique
        // constraint on ReferralReward makes this safe against a Stripe
        // webhook retry re-delivering the same event twice.
        const referred = await prisma.user.findUnique({ where: { id: userId }, select: { referredBy: true } });
        if (referred?.referredBy) {
          const rewardCredits = Math.max(1, Math.round((0.10 * ((s.amount_total ?? 0) / 100)) / USD_PER_CREDIT));
          await prisma.referralReward.create({
            data: { referrerId: referred.referredBy, referredUserId: userId, plan, rewardCredits, status: "pending" },
          }).catch(() => {}); // duplicate delivery for the same referredUserId -- already queued, nothing to do
        }
      }
    } else if (event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      const priceId = sub.items?.data?.[0]?.price?.id;
      const plan = planFromPriceId(priceId);
      const user = await prisma.user.findFirst({ where: { stripeCustomerId: sub.customer as string } });
      if (user) await prisma.user.update({ where: { id: user.id }, data: { plan, credits: PLAN_CREDITS[plan] ?? user.credits } });
    } else if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const user = await prisma.user.findFirst({ where: { stripeCustomerId: sub.customer as string } });
      if (user) await prisma.user.update({ where: { id: user.id }, data: { plan: "lite", stripeSubscriptionId: null } });
    } else if (event.type === "invoice.payment_succeeded") {
      // MONTHLY CREDIT RENEWAL. Every OTHER credit grant in this file is a
      // ONE-TIME event: checkout.session.completed fires once at signup,
      // customer.subscription.updated fires on a real PLAN CHANGE, not a
      // plain renewal. Nothing previously reset credits on an ordinary
      // recurring charge — the pricing page promises "N films per MONTH",
      // but a subscriber who used up their allotment had no way to ever get
      // more without changing plans, despite continuing to pay every month.
      // invoice.payment_succeeded is Stripe's own recommended event for
      // exactly this "refresh entitlements every billing period" pattern.
      const invoice = event.data.object as Stripe.Invoice;
      // billing_reason "subscription_create" is the FIRST invoice, already
      // credited by checkout.session.completed above — crediting it again
      // here would double-grant a brand-new subscriber's very first month.
      // Only "subscription_cycle" (a genuine renewal charge) should top up.
      if (invoice.billing_reason === "subscription_cycle" && invoice.customer) {
        const user = await prisma.user.findFirst({ where: { stripeCustomerId: invoice.customer as string } });
        if (user) {
          const plan = (user.plan || "lite") as PlanId;
          const grant = PLAN_CREDITS[plan];
          // Same no-rollover semantics already used by checkout.session.completed
          // and subscription.updated above (a hard SET, not an increment) —
          // matching the existing convention rather than introducing a new one.
          if (grant) await prisma.user.update({ where: { id: user.id }, data: { credits: grant } });
        }
      }
    }
  } catch (e) {
    console.error("Stripe webhook handler error:", e);
  }
  return new Response("ok", { status: 200 });
}
