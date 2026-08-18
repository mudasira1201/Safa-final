// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/[id]/resume/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

// Resume button — re-queues the SAME job row a Stop request paused (see
// cancel/route.ts), same type and payload, at its original createdAt (so it
// rejoins the worker queue where it originally was, not behind newer work).
// No credit charge and no project.status change: this is the same paid
// render continuing, not a new one — the worker's own caching
// (restoreCachedArtifacts, plus the keyframe/clip loops' own per-shot
// cache-hit checks) means re-running this job type only redoes whatever
// hadn't finished before Stop was clicked.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = await prisma.job.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "desc" } });
  if (!job) return NextResponse.json({ error: "Nothing paused right now to resume." }, { status: 409 });

  // Atomic claim — guards a double-click (or a resume racing a fresh Stop)
  // from queueing the same paused job twice; only the request that actually
  // flips status "cancelled" -> "queued" wins.
  const claimed = await prisma.job.updateMany({
    where: { id: job.id, status: "cancelled" },
    data: { status: "queued", stage: "Queued", cancelRequested: false },
  });
  if (claimed.count !== 1) {
    return NextResponse.json({ error: "Nothing paused right now to resume." }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
