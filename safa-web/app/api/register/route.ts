// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/register/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { safeJson, badRequest } from "@/lib/http";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  try {
    if (!(await rateLimit(clientKey(req, "register"), 5, 60_000))) {
      return NextResponse.json({ error: "Too many attempts. Please wait a minute and try again." }, { status: 429 });
    }
    const body = await safeJson<{ email?: string; password?: string; name?: string }>(req);
    if (!body) return badRequest();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const name = body.name ? String(body.name).trim().slice(0, 60) : null;

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Your password must be at least 8 characters." }, { status: 400 });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { name, email, password: hash } });

    // send a confirmation email (login is gated on this)
    const token = randomBytes(32).toString("hex");
    await prisma.authToken.create({ data: { token, userId: user.id, purpose: "verify", expires: new Date(Date.now() + 1000 * 60 * 60 * 24) } });
    const base = process.env.NEXTAUTH_URL || "http://localhost:3000";
    await sendEmail(email, "Confirm your safa.ai email",
      `<p>Welcome to safa.ai.</p><p>Confirm your email address to start making films:</p><p><a href="${base}/api/verify?token=${token}">Confirm my email</a></p>`);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not create the account." }, { status: 500 });
  }
}