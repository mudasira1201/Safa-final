// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/stripe/checkout/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import { PLAN_PRICE_ID } from "@/lib/plans";

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user?.email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { plan } = body;
  const price = PLAN_PRICE_ID[plan];
  if (!price) return NextResponse.json({ error: "That plan isn't purchasable." }, { status: 400 });

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const c = await stripe.customers.create({ email: user.email, metadata: { userId: user.id } });
    customerId = c.id;
    await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
  }

  const base = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    success_url: `${base}/app?upgraded=1`,
    cancel_url: `${base}/pricing`,
    metadata: { userId: user.id, plan },
  });
  return NextResponse.json({ url: session.url });
}