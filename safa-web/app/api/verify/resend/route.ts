// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/verify/resend/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { rateLimit, clientKey } from "@/lib/ratelimit";

export async function POST(req: Request) {
  if (!(await rateLimit(clientKey(req, "resend"), 3, 60_000))) {
    return NextResponse.json({ error: "Too many requests. Please wait a minute." }, { status: 429 });
  }
  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { email } = body;
  const norm = String(email || "").trim().toLowerCase();
  // Always return ok (do not reveal whether the email exists).
  const user = norm ? await prisma.user.findUnique({ where: { email: norm } }) : null;
  if (user && !user.emailVerified) {
    // per-account cooldown: at most one verification email per 60s per account
    const recent = await prisma.authToken.findFirst({
      where: { userId: user.id, purpose: "verify", createdAt: { gt: new Date(Date.now() - 60_000) } },
    });
    if (!recent) {
      const token = randomBytes(32).toString("hex");
      await prisma.authToken.create({ data: { token, userId: user.id, purpose: "verify", expires: new Date(Date.now() + 1000 * 60 * 60 * 24) } });
      const base = process.env.NEXTAUTH_URL || "http://localhost:3000";
      await sendEmail(norm, "Confirm your safa.ai email",
        `<p>Confirm your email address to start making films.</p><p><a href="${base}/api/verify?token=${token}">Confirm my email</a></p>`);
    }
  }
  return NextResponse.json({ ok: true });
}