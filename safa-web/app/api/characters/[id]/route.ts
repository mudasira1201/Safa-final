import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const character = await prisma.savedCharacter.findFirst({ where: { id: params.id, userId: user.id } });
  if (!character) return NextResponse.json({ error: "not found" }, { status: 404 });
  await prisma.savedCharacter.delete({ where: { id: character.id } });
  return NextResponse.json({ ok: true });
}
