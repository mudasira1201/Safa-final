// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/forgot/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { rateLimit, clientKey } from "@/lib/ratelimit";

export async function POST(req: Request) {
  // Same two layers verify/resend/route.ts already uses for the architecturally
  // identical "email someone a token" pattern — this route had NEITHER before:
  // no IP rate limit meant anyone could hammer it with a target's email to spam
  // their inbox with reset links indefinitely (and burn paid Resend quota), and
  // no per-account cooldown meant even a single attacker session could re-email
  // the same target as fast as requests could be sent.
  if (!(await rateLimit(clientKey(req, "forgot"), 3, 60_000))) {
    return NextResponse.json({ error: "Too many requests. Please wait a minute." }, { status: 429 });
  }
  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { email } = body;
  // .trim().toLowerCase() — register.ts always stores email lowercased, but this
  // route was looking up the RAW request body value. A legitimate user typing
  // their own email with different casing would silently get no reset email at
  // all (findUnique misses, and the response is uniformly {ok:true} either way
  // to avoid enumeration, so there'd be no error to explain why).
  const norm = String(email || "").trim().toLowerCase();
  if (norm) {
    const user = await prisma.user.findUnique({ where: { email: norm } });
    if (user) {
      // Per-account cooldown, same shape as verify/resend/route.ts: at most one
      // reset email per 60s per account, regardless of how many different IPs
      // request it.
      const recent = await prisma.authToken.findFirst({
        where: { userId: user.id, purpose: "reset", createdAt: { gt: new Date(Date.now() - 60_000) } },
      });
      if (!recent) {
        const token = randomBytes(32).toString("hex");
        await prisma.authToken.create({ data: { token, userId: user.id, purpose: "reset", expires: new Date(Date.now() + 1000 * 60 * 30) } });
        const base = process.env.NEXTAUTH_URL || "http://localhost:3000";
        await sendEmail(norm, "Reset your safa.ai password",
          `<p>Reset your password:</p><p><a href="${base}/reset?token=${token}">Reset my password</a></p><p>This link expires in 30 minutes. If you didn't request this, ignore this email.</p>`);
      }
    }
  }
  return NextResponse.json({ ok: true });
}