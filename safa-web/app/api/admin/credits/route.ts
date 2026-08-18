// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/admin/credits/route.ts
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isAdmin } from "@/lib/isAdmin";
import { prisma } from "@/lib/prisma";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(await isAdmin(session?.user?.email))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { userId, amount } = body;
  const n = parseInt(amount, 10);
  if (!userId || !Number.isFinite(n)) return NextResponse.json({ error: "bad input" }, { status: 400 });
  const u = await prisma.user.update({ where: { id: userId }, data: { credits: { increment: n } } });
  return NextResponse.json({ ok: true, credits: u.credits });
}