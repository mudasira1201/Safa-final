// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/admin/projects/route.ts   *** NEW FILE ***
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

  const body = await safeJson<{ projectId?: string; action?: string }>(req);
  if (!body?.projectId || !["block", "unblock", "delete"].includes(String(body.action))) return badRequest("Unknown action.");

  const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (body.action === "delete") {
    // Cascades to jobs, artifacts, messages and reports. Irreversible.
    await prisma.project.delete({ where: { id: project.id } });
  } else {
    await prisma.project.update({ where: { id: project.id }, data: { blocked: body.action === "block" } });
  }
  return NextResponse.json({ ok: true });
}