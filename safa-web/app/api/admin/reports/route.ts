// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/admin/reports/route.ts
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isAdmin } from "@/lib/isAdmin";
import { prisma } from "@/lib/prisma";
import { safeJson, badRequest } from "@/lib/http";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(await isAdmin(session?.user?.email))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await safeJson<{ reportId?: string; action?: string }>(req);
  if (!body) return badRequest();
  const { reportId, action } = body;
  if (!reportId || !["block", "unblock", "dismiss"].includes(String(action))) return badRequest("Unknown action.");

  const report = await prisma.report.findUnique({ where: { id: reportId } });
  if (!report) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (action === "block") {
    await prisma.project.update({ where: { id: report.projectId }, data: { blocked: true } });
    await prisma.report.update({ where: { id: reportId }, data: { status: "actioned" } });
  } else if (action === "unblock") {
    await prisma.project.update({ where: { id: report.projectId }, data: { blocked: false } });
    await prisma.report.update({ where: { id: reportId }, data: { status: "dismissed" } });
  } else {
    await prisma.report.update({ where: { id: reportId }, data: { status: "dismissed" } });
  }
  return NextResponse.json({ ok: true });
}