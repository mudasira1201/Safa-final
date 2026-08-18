// Pre-launch ops automation — Tier 2 #6 (per-user cost vs. revenue report).
// Read-only report, admin-gated same as every other app/api/admin/*/route.ts.
//
// No Payment/Invoice table exists anywhere (confirmed this session's own
// research): Stripe's webhook only ever mutates User.plan/credits/
// stripeCustomerId/stripeSubscriptionId, never persists a dollar amount. So
// the revenue side of this report pulls LIVE from Stripe's own API per user
// (paid invoices, summed) rather than a local table — no schema change, no
// backfill, reasonable for a pre-launch product with minimal real payment
// history so far (see the approved plan's own "Revenue data source"
// decision). This makes one Stripe API call per user with a stripeCustomerId
// — fine at today's user counts; worth revisiting (a cached/batched version,
// or finally persisting invoice amounts via the webhook) if the user base
// grows enough for that to matter.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isAdmin } from "@/lib/isAdmin";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(await isAdmin(session?.user?.email))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [users, spendByUser] = await Promise.all([
    prisma.user.findMany({
      where: { stripeCustomerId: { not: null } },
      select: { id: true, email: true, plan: true, stripeCustomerId: true },
    }),
    prisma.spend.groupBy({ by: ["userId"], where: { userId: { not: null } }, _sum: { amountUsd: true } }),
  ]);

  const costByUserId = new Map(spendByUser.map((s) => [s.userId as string, s._sum.amountUsd ?? 0]));

  const rows = await Promise.all(
    users.map(async (u) => {
      let revenueUsd = 0;
      try {
        // Paid invoices only — a subscription's own revenue, not attempted-
        // and-failed charges. `limit: 100` is a pre-launch-scale simplifying
        // assumption (no pagination) — revisit if any real customer's
        // invoice count approaches it.
        const invoices = await stripe.invoices.list({ customer: u.stripeCustomerId!, status: "paid", limit: 100 });
        revenueUsd = invoices.data.reduce((sum, inv) => sum + (inv.amount_paid ?? 0), 0) / 100;
      } catch (e) {
        console.error(`[cost-vs-revenue] Stripe lookup failed for ${u.email}:`, (e as Error)?.message);
      }
      const costUsd = costByUserId.get(u.id) ?? 0;
      return {
        userId: u.id,
        email: u.email,
        plan: u.plan,
        costUsd: Math.round(costUsd * 100) / 100,
        revenueUsd: Math.round(revenueUsd * 100) / 100,
        marginUsd: Math.round((revenueUsd - costUsd) * 100) / 100,
      };
    }),
  );

  rows.sort((a, b) => a.marginUsd - b.marginUsd); // worst margin first — the actionable end of the list

  return NextResponse.json({ rows });
}
