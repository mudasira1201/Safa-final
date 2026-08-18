import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isAdmin } from "@/lib/isAdmin";
import { prisma } from "@/lib/prisma";
import { safeJson, badRequest } from "@/lib/http";

// No GET here on purpose -- same shape as its sibling api/admin/reports/route.ts:
// the admin dashboard (AdminClient.tsx) gets its list data in one bulk call to
// api/admin/overview, and only POSTs actions to routes like this one.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(await isAdmin(session?.user?.email))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await safeJson<{ rewardId?: string; action?: string }>(req);
  if (!body) return badRequest();
  const { rewardId, action } = body;
  if (!rewardId || !["approve", "reject"].includes(String(action))) return badRequest("Unknown action.");

  const reward = await prisma.referralReward.findUnique({ where: { id: rewardId } });
  if (!reward) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (reward.status !== "pending") return NextResponse.json({ error: "Already reviewed." }, { status: 409 });

  if (action === "approve") {
    await prisma.user.update({ where: { id: reward.referrerId }, data: { credits: { increment: reward.rewardCredits } } });
    await prisma.referralReward.update({ where: { id: rewardId }, data: { status: "approved", reviewedAt: new Date() } });
  } else {
    await prisma.referralReward.update({ where: { id: rewardId }, data: { status: "rejected", reviewedAt: new Date() } });
  }
  return NextResponse.json({ ok: true });
}
