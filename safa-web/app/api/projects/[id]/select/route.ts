// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/[id]/select/route.ts
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { prisma, withTransactionRetry } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import { spendBlocked, claimFreeFilm } from "@/lib/spend";

// Save the user's character picks, spend one credit, and queue the "render" job
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (project.status !== "awaiting_selection") {
    return NextResponse.json({ error: "This project isn't ready for selection." }, { status: 409 });
  }

  // SPEND CAP (advisory): refuse before taking the credit, with a friendly message.
  // Covers the daily/monthly budget guards AND the free-film cap (verified email + one film).
  const blocked = await spendBlocked(user.id);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 429 });

  // COST: locked in at creation time (see app/api/projects/route.ts's
  // creditsCost: cost) from the resolution/length/audio the user actually
  // picked — never a flat 1. free-tier plans get clamped to cheap settings
  // by applyPlanLimits() before this number was ever computed, so a free
  // film's creditsCost is still 1 in the common case; a paid, longer or
  // higher-resolution film costs exactly what it was quoted at creation.
  const cost = Math.max(1, project.creditsCost || 1);
  if (user.credits < cost) {
    return NextResponse.json({ error: `This film costs ${cost} credit${cost === 1 ? "" : "s"}. You have ${user.credits}.` }, { status: 402 });
  }

  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { selection, locationSelection } = body; // { charId: chosenIndex }, { locationId: chosenIndex }

  // Spend the film's real credit cost + claim the free film + save selection +
  // queue render — ALL atomic. The free-film claim is CONDITIONAL, so two
  // simultaneous requests cannot both render — BUT claimFreeFilm() is a
  // no-op for a paid plan (see its own comment), so that alone was NOT
  // actually a gate for a paid account. CONFIRMED REAL, LIVE FAILURE: two
  // near-simultaneous "select" submissions on a paid account both passed the
  // status check above (read before either write landed) and both reached
  // here, double-charging a credit and queuing two separate "shots" jobs
  // against the same project. The project-status claim below closes that —
  // same atomic updateMany-in-a-transaction pattern as keyframes/route.ts's
  // own fix for the identical class of race.
  try {
    await withTransactionRetry(async (tx) => {
      const claimedStatus = await tx.project.updateMany({
        where: { id: project.id, status: "awaiting_selection" },
        data: { status: "generating_shots" },
      });
      if (claimedStatus.count !== 1) throw new Error("NOT_READY");

      const claimed = await claimFreeFilm(tx, user.id, user.plan);
      if (!claimed) throw new Error("FREE_FILM_ALREADY_USED");

      await tx.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
      await tx.project.update({
        where: { id: project.id },
        data: {
          selectionJson: selection ?? {},
          locationSelectionJson: locationSelection ?? {},
          jobs: { create: { type: "shots", status: "queued", stage: "Queued" } },
        },
      });
    });
  } catch (e: any) {
    if (e?.message === "FREE_FILM_ALREADY_USED") {
      return NextResponse.json(
        { error: "You've used your free film. Subscribe to make more — full quality, no watermark." },
        { status: 429 },
      );
    }
    if (e?.message === "NOT_READY") {
      return NextResponse.json({ error: "This project isn't ready for selection." }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ ok: true });
}