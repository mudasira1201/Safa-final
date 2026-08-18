// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/[id]/breakdown/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { safeJson, badRequest, tooMany } from "@/lib/http";

// COST CONTROL: every regeneration below queues a real, paid LLM job. Without a cap a
// logged-in user can loop these endpoints and run up the provider bill. Free, but bounded.
const MAX_BREAKDOWN_RUNS = 10; // includes the first breakdown + all regenerations
const MAX_OPTION_RUNS = 6;     // options generate character IMAGES: more expensive, tighter cap

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!(await rateLimit(clientKey(req, "breakdown") + ":" + user.id, 20, 60_000))) {
    return tooMany("You're making changes very fast. Please wait a moment.");
  }

  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await safeJson<{ action?: string; index?: number; shots?: unknown }>(req);
  if (!body) return badRequest();
  const { action, index, shots } = body;

  // Editing the shot text yourself is free and costs no provider money.
  if (action === "update" && Array.isArray(shots)) {
    const bd = (project.breakdownJson as any) || {};
    await prisma.project.update({ where: { id: project.id }, data: { breakdownJson: { ...bd, shots } } });
    return NextResponse.json({ ok: true });
  }

  // Re-planning the film: a paid LLM job. Capped per project.
  if (action === "regenerate" || (action === "regenShot" && Number.isInteger(index))) {
    // STATUS GUARD — same reasoning as "confirm" above. CreateFlow's
    // breakdown-review screen (the only caller of these two actions) is
    // shown for BOTH "breakdown_review" and "needs_edit", so both are valid;
    // anything else means a stale/duplicate request racing against a status
    // that already moved on.
    if (project.status !== "breakdown_review" && project.status !== "needs_edit") {
      return NextResponse.json({ error: "This project's plan isn't ready to regenerate right now." }, { status: 409 });
    }
    const used = await prisma.job.count({
      where: { projectId: project.id, type: { in: ["breakdown", "regen_shot"] } },
    });
    if (used >= MAX_BREAKDOWN_RUNS) {
      return tooMany(`You've reached the limit of ${MAX_BREAKDOWN_RUNS} shot-plan revisions for this film. Start a new film to keep going.`);
    }
    const job =
      action === "regenerate"
        ? { type: "breakdown", status: "queued", stage: "Queued" }
        : { type: "regen_shot", status: "queued", stage: "Queued", payload: { index } };
    await prisma.project.update({
      where: { id: project.id },
      data: { status: "generating_breakdown", jobs: { create: job as any } },
    });
    return NextResponse.json({ ok: true });
  }

  // Confirming the plan queues character generation: paid IMAGE work. Capped per project.
  if (action === "confirm") {
    // STATUS GUARD — every other mutating action in this codebase checks the
    // project is actually in the state it's about to act on (select/route.ts,
    // clips/route.ts's deleteShot/insertShot); this one didn't. Confirmed real
    // failure: two "confirm" requests close together (a double-click, a slow
    // network retry) both passed straight through and each queued their own
    // "options" job — the SAME character options got paid for and generated
    // twice for one project. Once status flips off "breakdown_review" here,
    // a second concurrent confirm now correctly rejects instead of queueing
    // a duplicate paid job.
    if (project.status !== "breakdown_review") {
      return NextResponse.json({ error: "This project's plan isn't ready to confirm right now." }, { status: 409 });
    }
    const used = await prisma.job.count({ where: { projectId: project.id, type: "options" } });
    if (used >= MAX_OPTION_RUNS) {
      return tooMany(`You've reached the limit of ${MAX_OPTION_RUNS} character generations for this film. Start a new film to keep going.`);
    }
    await prisma.project.update({
      where: { id: project.id },
      data: { status: "generating_options", jobs: { create: { type: "options", status: "queued", stage: "Queued" } } },
    });
    return NextResponse.json({ ok: true });
  }

  return badRequest("Unknown action.");
}