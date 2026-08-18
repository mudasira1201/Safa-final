// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/[id]/keyframes/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { prisma, withTransactionRetry } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

// Both actions below are only ever shown on the keyframes_review screen
// (CreateFlow's phase === "keyframes", reached only from that status — see
// pollStatus()'s switch). Anything else means a stale/duplicate request
// racing against a status that already moved on, same guard style as
// breakdown/route.ts and clips/route.ts.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { action, id, note } = body;

  // Free — regenerating a still frame before anything's been animated costs
  // nothing extra (see CreateFlow's own copy: "regenerating a keyframe is
  // free"); the worker's handleRegenKeyframe still enforces the global spend
  // cap itself. No claim needed on a single id, so a plain update is enough,
  // same as clips/route.ts's regenClip.
  if (action === "regenKeyframe" && id) {
    if (project.status !== "keyframes_review") {
      return NextResponse.json({ error: "This project's keyframes aren't ready to edit right now." }, { status: 409 });
    }
    await prisma.project.update({
      where: { id: project.id },
      data: {
        status: "generating_shots",
        jobs: { create: { type: "regen_keyframe", status: "queued", stage: "Queued", payload: { id, note: note || "" } } },
      },
    });
    return NextResponse.json({ ok: true });
  }

  // Not a new charge — the film's one render credit was already spent when
  // the "shots" (keyframe) job was first queued (see select/route.ts); this
  // is the second half of that same paid render, same as chat/route.ts's
  // keyframes_review -> render_clips resume step. Guarded the same
  // atomic-claim way as select/route.ts, so two near-simultaneous "approve"
  // clicks cannot both queue a render_clips job.
  if (action === "approveAll") {
    try {
      await withTransactionRetry(async (tx) => {
        const claimed = await tx.project.updateMany({
          where: { id: project.id, status: "keyframes_review" },
          data: { status: "generating_shots" },
        });
        if (claimed.count !== 1) throw new Error("NOT_READY");
        await tx.project.update({
          where: { id: project.id },
          data: { jobs: { create: { type: "render_clips", status: "queued", stage: "Queued" } } },
        });
      });
    } catch (e: any) {
      if (e?.message === "NOT_READY") {
        return NextResponse.json({ error: "This project's keyframes aren't ready to approve right now." }, { status: 409 });
      }
      throw e;
    }
    return NextResponse.json({ ok: true });
  }

  return badRequest("Unknown action.");
}
