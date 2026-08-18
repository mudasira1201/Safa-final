// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/[id]/cancel/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

// The slow, expensive job types are stoppable — matches CreateFlow's own
// scoping for the Stop button (breakdown/options finish in well under a
// minute, not worth the UI or the worker-side checkpoint plumbing).
// regen_keyframe/regen_clip are single-shot operations but were the ORIGINAL
// reported case of a run silently taking 90 minutes (the cache-shape bug —
// see worker.ts's handleRegenKeyframe/handleRegenClip comments), so they get
// Stop too, not just the two main render phases.
const CANCELLABLE_TYPES = new Set(["shots", "render_clips", "regen_keyframe", "regen_clip"]);

// Stop button — flips Job.cancelRequested on the project's current job. The
// worker polls this flag once per shot inside the keyframe/clip render loops
// (ai-film-pro's lib/cancel.ts) and stops at the next shot boundary, not
// instantly — an in-flight paid generation call can't be aborted mid-flight,
// only prevented from starting the next one. Whatever finished before that
// point is already banked (clips bank the instant each one finishes; the
// keyframe pass now banks whatever's on disk no matter how it exits), so
// Resume (see resume/route.ts) picks up from there, not from scratch.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job = await prisma.job.findFirst({ where: { projectId: project.id }, orderBy: { createdAt: "desc" } });
  if (!job || !CANCELLABLE_TYPES.has(job.type) || (job.status !== "queued" && job.status !== "running")) {
    return NextResponse.json({ error: "Nothing running right now that can be stopped." }, { status: 409 });
  }
  await prisma.job.update({ where: { id: job.id }, data: { cancelRequested: true } });
  return NextResponse.json({ ok: true });
}
