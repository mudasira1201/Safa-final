import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { safeJson, badRequest } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

// Toggle whether a project is listed on the public /gallery. Deliberately a
// SEPARATE flag from shareToken (see schema.prisma's own comment) -- a
// private share link is consent to "anyone with this exact URL," not consent
// to being publicly LISTED and browsable. Enabling reuses/generates the same
// shareToken share/route.ts does (a gallery card links straight to /p/[token],
// no second viewer page), so a project can end up with a token either from
// this route or from share/route.ts first -- both are safe, idempotent paths
// to the same field.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await safeJson<{ enable?: boolean }>(req);
  if (!body || typeof body.enable !== "boolean") return badRequest();

  if (!body.enable) {
    const updated = await prisma.project.update({ where: { id: project.id }, data: { publicGallery: false } });
    return NextResponse.json({ ok: true, publicGallery: updated.publicGallery, shareToken: updated.shareToken });
  }

  if (project.status !== "done" || !project.filmUrl) {
    return NextResponse.json({ error: "Finish rendering before publishing to the gallery." }, { status: 400 });
  }

  const token = project.shareToken ?? randomBytes(9).toString("base64url");
  const updated = await prisma.project.update({
    where: { id: project.id },
    data: { publicGallery: true, shareToken: token },
  });
  return NextResponse.json({ ok: true, publicGallery: updated.publicGallery, shareToken: updated.shareToken });
}
