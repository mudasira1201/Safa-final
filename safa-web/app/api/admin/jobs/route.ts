// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/admin/jobs/route.ts   *** NEW FILE ***
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

  const body = await safeJson<{ jobId?: string; action?: string }>(req);
  if (!body?.jobId || body.action !== "retry") return badRequest("Unknown action.");

  const job = await prisma.job.findUnique({ where: { id: body.jobId } });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (job.status !== "failed") return badRequest("Only failed jobs can be retried.");

  // Requeue with the attempt counter reset, so the worker picks it up immediately.
  // Cached keyframes and clips are reused, so a retry does not re-charge for finished work.
  await prisma.job.update({
    where: { id: job.id },
    data: { status: "queued", attempts: 0, runAfter: null, error: null, stage: "Requeued by an admin" },
  });
  return NextResponse.json({ ok: true });
}