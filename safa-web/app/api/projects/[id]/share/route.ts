import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

// Generate (once) and return a public share token for a project the caller owns.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const project = await prisma.project.findFirst({ where: { id: params.id, userId: user.id } });
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  let token = project.shareToken;
  if (!token) {
    token = randomBytes(9).toString("base64url"); // short, URL-safe (~12 chars)
    await prisma.project.update({ where: { id: project.id }, data: { shareToken: token } });
  }
  return NextResponse.json({ token, ready: project.status === "done", publicGallery: project.publicGallery });
}