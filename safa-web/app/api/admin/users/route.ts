// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/admin/users/route.ts
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isAdmin, isRootAdmin } from "@/lib/isAdmin";
import { prisma } from "@/lib/prisma";
import { safeJson, badRequest } from "@/lib/http";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const me = session?.user?.email;
  if (!(await isAdmin(me))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await safeJson<{ userId?: string; action?: string }>(req);
  if (!body?.userId || !["promote", "demote", "block", "unblock"].includes(String(body.action))) {
    return badRequest("Unknown action.");
  }

  const target = await prisma.user.findUnique({ where: { id: body.userId }, select: { email: true } });
  if (!target) return NextResponse.json({ error: "not found" }, { status: 404 });

  const isSelf = target.email?.toLowerCase() === me?.toLowerCase();
  const targetIsRoot = isRootAdmin(target.email);

  // Guards, so an admin can never lock themselves (or the owner) out.
  if (isSelf && (body.action === "demote" || body.action === "block")) {
    return badRequest("You can't remove your own access.");
  }
  if (targetIsRoot && (body.action === "demote" || body.action === "block")) {
    return badRequest("This admin is set in ADMIN_EMAILS and can't be changed here.");
  }

  if (body.action === "promote" || body.action === "demote") {
    await prisma.user.update({ where: { id: body.userId }, data: { isAdmin: body.action === "promote" } });
  } else {
    const blocked = body.action === "block";
    await prisma.user.update({ where: { id: body.userId }, data: { blocked } });
    // Blocking also hides everything they have published, so a bad actor's films go dark at once.
    if (blocked) await prisma.project.updateMany({ where: { userId: body.userId }, data: { blocked: true } });
  }
  return NextResponse.json({ ok: true });
}