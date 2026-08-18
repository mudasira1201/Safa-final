// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/[id]/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

// Status of one project (ownership-checked): options, film, and active job progress
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const project = await prisma.project.findFirst({
    where: { id: params.id, userId: user.id },
    // Was `take: 1` on createdAt desc — "the" job was just whichever row
    // happened to be created most recently, with no regard for its status.
    // A project can have more than one job for the same stage sitting
    // around at once (a duplicate-submitted request, a worker started
    // twice — see worker.ts's claimJob() comment for a confirmed live
    // case), and the newest of those is frequently a leftover duplicate
    // still sitting "queued" at 0% while an OLDER row is the one actually
    // "running" and making real progress. Polling that newest-but-idle row
    // forever shows a frozen "Queued 5%" even while clips are visibly
    // finishing. Fetch a bounded window and pick the one that actually
    // reflects reality: the running job if there is one, else the oldest
    // still-queued job (the next one the worker's own FIFO claimJob() will
    // pick up), else just the newest row (a finished project's last job,
    // for its terminal done/failed/cancelled state).
    include: { jobs: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const job =
    project.jobs.find((j) => j.status === "running") ??
    [...project.jobs].reverse().find((j) => j.status === "queued") ??
    project.jobs[0];
  const messages = await prisma.message.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, select: { id: true, role: true, content: true } });
  return NextResponse.json({
    id: project.id,
    title: project.title,
    status: project.status,
    script: project.script,
    breakdown: project.breakdownJson ?? null,
    options: project.optionsJson ?? null,
    // Which portrait was picked per character (charId -> option index) — the
    // recap view (CreateFlow's "Film so far" section) needs this to show the
    // actual chosen character portraits, not just the option grid.
    selection: project.selectionJson ?? {},
    // Same shape/reasoning as options/selection above, for locations.
    locationOptions: project.locationOptionsJson ?? null,
    locationSelection: project.locationSelectionJson ?? {},
    keyframes: project.keyframesJson ?? null,
    clips: project.clipsJson ?? null,
    type: project.type,
    song: project.songJson ?? null,
    filmUrl: project.filmUrl,
    error: project.error,
    messages,
    job: job ? { type: job.type, status: job.status, stage: job.stage, progress: job.progress } : null,
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { title } = body;
  if (!title || !String(title).trim()) return NextResponse.json({ error: "Title required." }, { status: 400 });
  await prisma.project.update({ where: { id: project.id }, data: { title: String(title).trim().slice(0, 80) } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.project.delete({ where: { id: project.id } });
  return NextResponse.json({ ok: true });
}