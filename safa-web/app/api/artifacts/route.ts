import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const artifacts = await prisma.artifact.findMany({
    where: { project: { userId: user.id } },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { id: true, kind: true, url: true, projectId: true, createdAt: true },
  });
  return NextResponse.json({ artifacts });
}
