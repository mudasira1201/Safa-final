// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/admin/overview/route.ts
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isAdmin, isRootAdmin } from "@/lib/isAdmin";
import { prisma } from "@/lib/prisma";
import { getAdminStats } from "@/lib/opsDigest";

const JOB_SELECT = {
  id: true, type: true, status: true, stage: true, progress: true, error: true,
  attempts: true, createdAt: true, projectId: true,
  project: { select: { title: true, user: { select: { email: true } } } },
} as const;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(await isAdmin(session?.user?.email))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const [users, projects, recentJobs, failedJobs, reports, referralRewardRows, stats] =
    await Promise.all([
      prisma.user.findMany({
        orderBy: { createdAt: "desc" }, take: 200,
        select: {
          id: true, name: true, email: true, plan: true, credits: true, isAdmin: true, blocked: true,
          emailVerified: true, createdAt: true, _count: { select: { projects: true } },
        },
      }),
      prisma.project.findMany({
        orderBy: { createdAt: "desc" }, take: 200,
        select: {
          id: true, title: true, status: true, blocked: true, shareToken: true, filmUrl: true, createdAt: true,
          user: { select: { id: true, email: true } }, _count: { select: { artifacts: true, reports: true } },
        },
      }),
      prisma.job.findMany({ orderBy: { createdAt: "desc" }, take: 60, select: JOB_SELECT }),
      // FAILED jobs are fetched SEPARATELY. Otherwise an old failure falls outside the
      // "60 most recent" window and the Failed filter shows nothing while the badge says 2.
      prisma.job.findMany({ where: { status: "failed" }, orderBy: { createdAt: "desc" }, take: 60, select: JOB_SELECT }),
      prisma.report.findMany({
        orderBy: [{ status: "asc" }, { createdAt: "desc" }], take: 200,
        include: { project: { select: { id: true, title: true, blocked: true, shareToken: true, user: { select: { id: true, email: true, blocked: true } } } } },
      }),
      // REFERRAL PROGRAM review queue -- see api/stripe/webhook/route.ts
      // (where a reward is queued, never granted automatically) and
      // api/admin/referrals/route.ts (the approve/reject actions).
      prisma.referralReward.findMany({ orderBy: { createdAt: "desc" }, take: 200 }),
      // PRIORITY 5 / pre-launch ops automation — the stats block that used to
      // live inline here now lives in lib/opsDigest.ts's getAdminStats(),
      // shared with app/api/cron/daily-digest so the scheduled digest and
      // this human-facing page never compute two slightly-drifted versions
      // of the same numbers.
      getAdminStats(),
    ]);

  // Merge and de-duplicate, newest first.
  const byId = new Map<string, (typeof recentJobs)[number]>();
  [...failedJobs, ...recentJobs].forEach((j) => byId.set(j.id, j));
  const jobs = [...byId.values()].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));

  const withRoot = users.map((u) => ({ ...u, rootAdmin: isRootAdmin(u.email) }));

  // referralReward only stores userIds (not a Prisma relation -- see its
  // schema comment), so join emails in-memory the same way jobs above are
  // merged/de-duped by hand rather than via a Prisma `include`.
  const refUserIds = Array.from(new Set(referralRewardRows.flatMap((r) => [r.referrerId, r.referredUserId])));
  const refUsers = refUserIds.length
    ? await prisma.user.findMany({ where: { id: { in: refUserIds } }, select: { id: true, email: true } })
    : [];
  const refEmailById = Object.fromEntries(refUsers.map((u) => [u.id, u.email]));
  const referralRewards = referralRewardRows.map((r) => ({
    id: r.id,
    referrerEmail: refEmailById[r.referrerId] || "unknown",
    referredEmail: refEmailById[r.referredUserId] || "unknown",
    plan: r.plan,
    rewardCredits: r.rewardCredits,
    status: r.status,
    createdAt: r.createdAt,
  }));

  return NextResponse.json({
    users: withRoot, projects, jobs, reports, referralRewards,
    stats,
  });
}