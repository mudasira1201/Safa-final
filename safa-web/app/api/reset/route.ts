// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/reset/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientKey } from "@/lib/ratelimit";

export async function POST(req: Request) {
  // The reset token itself is 256 bits of randomBytes — brute-forcing it is
  // computationally infeasible regardless of rate limiting, so this isn't an
  // account-takeover gap. Added anyway for consistency: every other
  // unauthenticated write endpoint in this app (register, forgot, resend)
  // rate-limits, and this one didn't.
  if (!(await rateLimit(clientKey(req, "reset"), 5, 60_000))) {
    return NextResponse.json({ error: "Too many attempts. Please wait a minute." }, { status: 429 });
  }
  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { token, password } = body;
  if (!token || !password || String(password).length < 8) {
    return NextResponse.json({ error: "Enter a password of at least 8 characters." }, { status: 400 });
  }
  const row = await prisma.authToken.findUnique({ where: { token } });
  if (!row || row.purpose !== "reset" || row.expires < new Date()) {
    return NextResponse.json({ error: "This reset link is invalid or has expired." }, { status: 400 });
  }
  const hash = await bcrypt.hash(password, 10);
  await prisma.user.update({ where: { id: row.userId }, data: { password: hash } });
  await prisma.authToken.delete({ where: { token } }).catch(() => {});
  return NextResponse.json({ ok: true });
}