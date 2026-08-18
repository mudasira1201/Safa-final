import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { currentUser } from "@/lib/currentUser";

export async function POST() {
  const user = await currentUser();
  if (!user?.stripeCustomerId) return NextResponse.json({ error: "No active subscription to manage." }, { status: 400 });
  const base = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const session = await stripe.billingPortal.sessions.create({ customer: user.stripeCustomerId, return_url: `${base}/app` });
  return NextResponse.json({ url: session.url });
}
