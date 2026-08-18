import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

const VALID_KINDS = new Set(["character_sheet", "prop_sheet", "location_sheet"]);

// Regenerate ONE character/prop/location reference sheet. Triggered from the
// global Artifacts gallery (app/app/page.tsx), not a per-project review
// screen, so — unlike regenKeyframe/regenClip — this is valid against a
// project in ANY status, including "done". No atomic status-claim gate: there
// is no single review status to flip through, and the underlying job
// (worker.ts's handleRegenSheet) never writes project.status at all, on
// success or failure, so nothing here needs to protect a status transition.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { action, sheetKind, entityId, note } = body;
  if (action !== "regenSheet") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!VALID_KINDS.has(sheetKind) || typeof entityId !== "string" || !entityId) return badRequest();
  // Only location_sheet's worker handler actually reads this — see
  // handleRegenSheet()/runLocationSheet() in ai-film-pro. Accepted here for
  // any kind (harmless to pass through) rather than rejected, so the route
  // doesn't need updating the moment prop notes are wired up too.
  const cleanNote = typeof note === "string" ? note.trim().slice(0, 500) : "";

  // Duplicate-request guard: no status field to gate on here, so instead
  // check directly for an already in-flight regen of this SAME entity's
  // sheet before queuing another one (a double-click, or a slow first
  // request still running when the user clicks again). CONFIRMED REAL GAP,
  // FIXED: findFirst() only ever inspected ONE in-flight regen_sheet job —
  // with two different entities regenerating at once (a location AND a
  // prop, say), whichever job findFirst happened to return might not be the
  // one this new request actually duplicates, letting a real duplicate
  // through. findMany() + some() checks every in-flight job for this
  // project, not just one.
  const inFlight = await prisma.job.findMany({
    where: { projectId: project.id, type: "regen_sheet", status: { in: ["queued", "running"] } },
    select: { payload: true },
  });
  if (inFlight.some((j) => (j.payload as any)?.sheetKind === sheetKind && (j.payload as any)?.entityId === entityId)) {
    return NextResponse.json({ error: "Already regenerating — hang tight." }, { status: 409 });
  }

  // Free — a fresh take on a reference sheet doesn't charge a credit, same
  // reasoning as regenKeyframe: the film's one render already covers it.
  await prisma.project.update({
    where: { id: project.id },
    data: { jobs: { create: { type: "regen_sheet", status: "queued", stage: "Queued", payload: { sheetKind, entityId, note: cleanNote } } } },
  });
  return NextResponse.json({ ok: true });
}
