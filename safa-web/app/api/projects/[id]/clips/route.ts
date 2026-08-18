// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/[id]/clips/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { prisma, withTransactionRetry } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import { spendBlocked } from "@/lib/spend";

// Flat cost per inserted shot — deliberately NOT project.creditsCost (that's
// the whole film's locked-in price for its original length/resolution/audio).
// Regenerating an EXISTING clip is free; inserting a brand-new one is real,
// net-new render spend never accounted for in that original quote.
const INSERT_SHOT_COST = 1;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { action, order, id, note, afterId, prompt } = body;

  if (action === "assemble") {
    await prisma.project.update({
      where: { id: project.id },
      data: { status: "assembling", jobs: { create: { type: "assemble", status: "queued", stage: "Queued", payload: { order: Array.isArray(order) ? order : [] } } } },
    });
    return NextResponse.json({ ok: true });
  }
  if (action === "regenClip" && id) {
    await prisma.project.update({
      where: { id: project.id },
      data: { status: "generating_shots", jobs: { create: { type: "regen_clip", status: "queued", stage: "Queued", payload: { id, note: note || "" } } } },
    });
    return NextResponse.json({ ok: true });
  }
  if (action === "reopen") {
    await prisma.project.update({ where: { id: project.id }, data: { status: "clips_review" } });
    return NextResponse.json({ ok: true });
  }
  // deleteShot/insertShot: reachable from clips_review OR a finished (done)
  // project — the client's "Not happy? Re-edit clips" button already reopens
  // a done project to clips_review before either of these can be reached, but
  // this guard also covers a direct call landing on a still-"done" project.
  if (action === "deleteShot" && id) {
    if (project.status !== "clips_review" && project.status !== "done") {
      return NextResponse.json({ error: "This project isn't ready to edit shots right now." }, { status: 409 });
    }
    // Free — nothing is generated, just a splice + a (possibly forced)
    // restore of the successor shot from what's already been paid for.
    await prisma.project.update({
      where: { id: project.id },
      data: { status: "generating_shots", jobs: { create: { type: "delete_shot", status: "queued", stage: "Queued", payload: { shotId: id } } } },
    });
    return NextResponse.json({ ok: true });
  }
  if (action === "insertShot" && typeof prompt === "string" && prompt.trim()) {
    if (project.status !== "clips_review" && project.status !== "done") {
      return NextResponse.json({ error: "This project isn't ready to edit shots right now." }, { status: 409 });
    }
    const blocked = await spendBlocked(user.id);
    if (blocked) return NextResponse.json({ error: blocked }, { status: 429 });
    if (user.credits < INSERT_SHOT_COST) {
      return NextResponse.json({ error: `Inserting a shot costs ${INSERT_SHOT_COST} credit. You have ${user.credits}.` }, { status: 402 });
    }
    await withTransactionRetry(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { credits: { decrement: INSERT_SHOT_COST } } });
      await tx.project.update({
        where: { id: project.id },
        data: {
          status: "generating_shots",
          jobs: { create: { type: "insert_shot", status: "queued", stage: "Queued", payload: { afterShotId: afterId ?? null, prompt: prompt.trim() } } },
        },
      });
    });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}