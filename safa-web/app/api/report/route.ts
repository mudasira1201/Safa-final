// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/report/route.ts
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { safeJson, badRequest, tooMany } from "@/lib/http";

const REASONS = ["sexual", "violence", "hate", "harassment", "illegal", "copyright", "other"];

export async function POST(req: Request) {
  if (!(await rateLimit(clientKey(req, "report"), 5, 60_000))) {
    return tooMany("Too many reports. Please wait a minute.");
  }
  const body = await safeJson<{ token?: string; reason?: string; details?: string }>(req);
  if (!body) return badRequest();

  const token = String(body.token || "").trim();
  const reason = String(body.reason || "").trim();
  if (!token || !REASONS.includes(reason)) return badRequest("Pick a reason for the report.");

  const project = await prisma.project.findUnique({ where: { shareToken: token }, select: { id: true } });

  // The share page is public, so most reporters are NOT signed in. If they happen to be,
  // record who they are; otherwise the report is genuinely anonymous.
  const session = await getServerSession(authOptions).catch(() => null);
  const reporterEmail = session?.user?.email || null;

  if (project) {
    await prisma.report.create({
      data: {
        projectId: project.id,
        reason,
        details: String(body.details || "").slice(0, 1000),
        reporterEmail,
      },
    }).catch(() => {});
  }
  // Never reveal whether the token exists.
  return NextResponse.json({ ok: true });
}