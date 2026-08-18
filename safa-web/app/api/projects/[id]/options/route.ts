// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/projects/[id]/options/route.ts
// (rename this file to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { safeJson, badRequest, tooMany } from "@/lib/http";

// COST CONTROL: each run generates character IMAGES on fal, so it costs real money.
// Free for the user, but hard-capped per project so it cannot be looped.
const MAX_OPTION_RUNS = 6;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!(await rateLimit(clientKey(req, "options") + ":" + user.id, 15, 60_000))) {
    return tooMany("You're regenerating very fast. Please wait a moment.");
  }

  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await safeJson<{ action?: string; note?: string }>(req);
  if (!body) return badRequest();
  const { action, note } = body;

  if (action === "regenerate") {
    const used = await prisma.job.count({ where: { projectId: project.id, type: "options" } });
    if (used >= MAX_OPTION_RUNS) {
      return tooMany(`You've reached the limit of ${MAX_OPTION_RUNS} character generations for this film. Start a new film to keep going.`);
    }
    await prisma.project.update({
      where: { id: project.id },
      data: {
        status: "generating_options",
        jobs: { create: { type: "options", status: "queued", stage: "Queued", payload: { note: String(note || "").slice(0, 500) } } },
      },
    });
    return NextResponse.json({ ok: true });
  }

  return badRequest("Unknown action.");
}