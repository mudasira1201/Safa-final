// lib/opsDigest.ts
// -----------------------------------------------------------------------------
// SHARED QUERY LOGIC for the daily ops digest AND the admin overview page —
// extracted from app/api/admin/overview/route.ts's own stats block (2026-08-07)
// so the scheduled digest (app/api/cron/daily-digest) and the human-facing
// admin page compute the SAME numbers from the SAME queries, never two
// slightly-drifted copies. The admin route's own users/projects/jobs/reports
// LIST data (200 rows each, for the UI tables) stays in that route — only the
// STATS/aggregate queries move here, since a digest email needs summary
// numbers, not full row lists.
// -----------------------------------------------------------------------------

import { prisma } from "@/lib/prisma";

const round2 = (n: number | null | undefined) => Math.round((n ?? 0) * 100) / 100;

export interface AdminStats {
  userCount: number;
  projectCount: number;
  doneCount: number;
  clipsTotal: number;
  clipsWeek: number;
  failedCount: number;
  openReports: number;
  blockedUsers: number;
  spendToday: number;
  spendWeek: number;
  spendMonth: number;
  qaByStage: Record<string, { pass: number; fail: number; unverified: number }>;
  qaUnverifiedRateWeek: number | null;
  qaPassRateWeek: number | null;
}

/** Byte-for-byte the same queries/shaping app/api/admin/overview/route.ts's
 *  GET handler used to compute inline — moved here so both callers share one
 *  implementation. See that route's own history (PRIORITY 5 comments) for
 *  why these specific numbers were chosen. */
export async function getAdminStats(): Promise<AdminStats> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [userCount, projectCount, doneCount, clipsTotal, clipsWeek, failedCount, openReports, blockedUsers, spendToday, spendWeek, spendMonth, qaEventsWeek] =
    await Promise.all([
      prisma.user.count(),
      prisma.project.count(),
      prisma.project.count({ where: { status: "done" } }),
      prisma.artifact.count({ where: { kind: "clip" } }),
      prisma.artifact.count({ where: { kind: "clip", createdAt: { gte: weekAgo } } }),
      prisma.job.count({ where: { status: "failed" } }),
      prisma.report.count({ where: { status: "open" } }),
      prisma.user.count({ where: { blocked: true } }),
      prisma.spend.aggregate({ _sum: { amountUsd: true }, where: { createdAt: { gte: dayAgo } } }),
      prisma.spend.aggregate({ _sum: { amountUsd: true }, where: { createdAt: { gte: weekAgo } } }),
      prisma.spend.aggregate({ _sum: { amountUsd: true }, where: { createdAt: { gte: monthAgo } } }),
      prisma.qaEvent.groupBy({ by: ["stage", "outcome"], where: { createdAt: { gte: weekAgo } }, _count: { _all: true } }),
    ]);

  const qaByStage: AdminStats["qaByStage"] = {};
  for (const row of qaEventsWeek) {
    const stage = row.stage;
    if (!qaByStage[stage]) qaByStage[stage] = { pass: 0, fail: 0, unverified: 0 };
    const outcome = row.outcome as "pass" | "fail" | "unverified";
    if (outcome === "pass" || outcome === "fail" || outcome === "unverified") {
      qaByStage[stage][outcome] += row._count._all;
    }
  }
  const qaTotals = Object.values(qaByStage).reduce(
    (acc, s) => ({ pass: acc.pass + s.pass, fail: acc.fail + s.fail, unverified: acc.unverified + s.unverified }),
    { pass: 0, fail: 0, unverified: 0 },
  );
  const qaTotalEvents = qaTotals.pass + qaTotals.fail + qaTotals.unverified;

  return {
    userCount, projectCount, doneCount, clipsTotal, clipsWeek, failedCount, openReports, blockedUsers,
    spendToday: round2(spendToday._sum.amountUsd),
    spendWeek: round2(spendWeek._sum.amountUsd),
    spendMonth: round2(spendMonth._sum.amountUsd),
    qaByStage,
    qaUnverifiedRateWeek: qaTotalEvents > 0 ? round2((qaTotals.unverified / qaTotalEvents) * 100) : null,
    qaPassRateWeek: qaTotalEvents > 0 ? round2((qaTotals.pass / qaTotalEvents) * 100) : null,
  };
}

export interface StuckOrDuplicateJob {
  id: string;
  projectId: string;
  status: string;
  stage: string;
  updatedAt: Date;
  reason: "stuck" | "duplicate";
}

// A render can legitimately run 30+ minutes (confirmed this session's own
// keyframe/clip timing investigation) — the threshold here is deliberately
// generous so this never false-positives on an ordinary long render, only a
// job that's genuinely stopped making progress.
const STUCK_THRESHOLD_MS = 90 * 60 * 1000;

/** Two independent worker-health signals, same shape as the confirmed real
 *  bugs this session already found by hand (a stuck/duplicate job silently
 *  wasting a slot no one noticed until a user complained). Read-only —
 *  flags, does not touch/cancel the job itself. */
export async function getStuckOrDuplicateJobs(): Promise<StuckOrDuplicateJob[]> {
  const stuckCutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
  const [stuck, nonTerminal] = await Promise.all([
    prisma.job.findMany({
      where: { status: "running", updatedAt: { lt: stuckCutoff } },
      select: { id: true, projectId: true, status: true, stage: true, updatedAt: true },
    }),
    prisma.job.findMany({
      where: { status: { in: ["queued", "running"] } },
      select: { id: true, projectId: true, status: true, stage: true, updatedAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const byProject = new Map<string, typeof nonTerminal>();
  for (const j of nonTerminal) {
    const list = byProject.get(j.projectId) ?? [];
    list.push(j);
    byProject.set(j.projectId, list);
  }
  const duplicates = [...byProject.values()].filter((jobs) => jobs.length > 1).flat();

  const stuckIds = new Set(stuck.map((j) => j.id));
  return [
    ...stuck.map((j) => ({ ...j, reason: "stuck" as const })),
    ...duplicates.filter((j) => !stuckIds.has(j.id)).map((j) => ({ ...j, reason: "duplicate" as const })),
  ];
}

export interface QaTrend {
  thisWeekFailRate: number | null;
  lastWeekFailRate: number | null;
  deltaPct: number | null; // positive = getting worse
}

/** Week-over-week QA fail-rate comparison, trending the SAME QaEvent data
 *  getAdminStats() already reads (real-time, complete, zero extra cost) —
 *  chosen over a new periodic re-audit/re-inspection pipeline, which would
 *  mean fresh paid vision-API calls duplicating what QA already does live
 *  during every render. See the plan's own "QA sampler design" decision. */
export async function getQaTrend(): Promise<QaTrend> {
  const now = Date.now();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);

  const [thisWeek, lastWeek] = await Promise.all([
    prisma.qaEvent.groupBy({ by: ["outcome"], where: { createdAt: { gte: weekAgo } }, _count: { _all: true } }),
    prisma.qaEvent.groupBy({ by: ["outcome"], where: { createdAt: { gte: twoWeeksAgo, lt: weekAgo } }, _count: { _all: true } }),
  ]);

  const failRate = (rows: { outcome: string; _count: { _all: number } }[]): number | null => {
    const total = rows.reduce((n, r) => n + r._count._all, 0);
    if (!total) return null;
    const fail = rows.find((r) => r.outcome === "fail")?._count._all ?? 0;
    return round2((fail / total) * 100);
  };

  const thisWeekFailRate = failRate(thisWeek);
  const lastWeekFailRate = failRate(lastWeek);
  const deltaPct = thisWeekFailRate !== null && lastWeekFailRate !== null ? round2(thisWeekFailRate - lastWeekFailRate) : null;

  return { thisWeekFailRate, lastWeekFailRate, deltaPct };
}

export interface SafetyRefusalSummary {
  count24h: number;
  count7d: number;
  byCategory7d: Record<string, number>;
}

/** SafetyRefusal is write-only today (confirmed: logged for script_submit
 *  only, never read back anywhere, admin or otherwise). This is the first
 *  read of it — a plain category rollup for a human to skim, not automated
 *  action on any of it. */
export async function getSafetyRefusalSummary(): Promise<SafetyRefusalSummary> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [count24h, rows7d] = await Promise.all([
    prisma.safetyRefusal.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.safetyRefusal.findMany({ where: { createdAt: { gte: weekAgo } }, select: { categories: true } }),
  ]);

  const byCategory7d: Record<string, number> = {};
  for (const row of rows7d) {
    let parsed: { category?: string }[] = [];
    try {
      parsed = JSON.parse(row.categories);
    } catch {
      continue; // malformed row — skip rather than crash the whole digest over one bad row
    }
    for (const c of parsed) {
      const key = c.category || "unknown";
      byCategory7d[key] = (byCategory7d[key] ?? 0) + 1;
    }
  }

  return { count24h, count7d: rows7d.length, byCategory7d };
}

export interface OpsFindingRow {
  id: string;
  source: string;
  severity: string;
  message: string;
  detail: string;
  createdAt: Date;
}

/** Rolls up findings ai-film-pro's own passive provider-health hooks (see
 *  ai-film-pro/src/lib/opsAlert.ts) and this repo's own refund auditor write
 *  to the SAME shared-DB OpsFinding table. `unresolvedOnly` — a critical
 *  finding is marked resolved the moment the alert cron actually emails
 *  about it (see app/api/cron/critical-alert), so re-running this never
 *  re-sends the same alert twice. */
export async function getOpsFindings(opts: { since?: Date; severity?: string; unresolvedOnly?: boolean } = {}): Promise<OpsFindingRow[]> {
  return prisma.opsFinding.findMany({
    where: {
      ...(opts.since ? { createdAt: { gte: opts.since } } : {}),
      ...(opts.severity ? { severity: opts.severity } : {}),
      ...(opts.unresolvedOnly ? { resolvedAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, source: true, severity: true, message: true, detail: true, createdAt: true },
  });
}

export interface RefundAuditRow {
  id: string;
  createdAt: Date;
  message: string;
  userId: string | null;
  jobId: string | null;
  projectId: string | null;
  projectSpend24hUsd: number | null; // that project's Spend total in the 24h BEFORE this refund
}

/** Tier 2 #7 (credit-refund auditor) — Part B. worker.ts's refundCredit()
 *  (ai-film-pro, see its own comment) now logs an OpsFinding for every
 *  refund; this surfaces each one alongside its project's real Spend total
 *  in the preceding 24h, so a human reviewer can judge plausibility (does a
 *  1-credit refund look right against how much this project was actually
 *  costing to render?) at a glance.
 *
 *  DELIBERATELY NOT an automated mismatch detector: there is no persisted
 *  "credit charged" event log anywhere today (confirmed this session — the
 *  four routes that deduct credits each just decrement User.credits inline,
 *  none of them log a separate charge event), and Spend rows track dollar
 *  RENDER COST, not credit-charge COUNT — the two aren't the same unit, so
 *  auto-flagging "inconsistent" from Spend alone would be comparing apples
 *  to oranges and could easily be wrong. Surfacing the real correlated data
 *  for a human to judge is the honest version of "flag, never auto-correct"
 *  this feature was scoped as. */
export async function getRefundAuditRows(opts: { since?: Date } = {}): Promise<RefundAuditRow[]> {
  const findings = await prisma.opsFinding.findMany({
    where: { source: "refund-audit", ...(opts.since ? { createdAt: { gte: opts.since } } : {}) },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, message: true, detail: true },
  });

  return Promise.all(
    findings.map(async (f) => {
      let userId: string | null = null;
      let jobId: string | null = null;
      let projectId: string | null = null;
      try {
        const parsed = JSON.parse(f.detail);
        userId = parsed.userId ?? null;
        jobId = parsed.jobId ?? null;
        projectId = parsed.projectId ?? null;
      } catch {
        // Malformed detail — still surface the finding itself, just without
        // the Spend cross-reference.
      }

      let projectSpend24hUsd: number | null = null;
      if (projectId) {
        const dayBefore = new Date(f.createdAt.getTime() - 24 * 60 * 60 * 1000);
        const agg = await prisma.spend.aggregate({
          _sum: { amountUsd: true },
          where: { projectId, createdAt: { gte: dayBefore, lte: f.createdAt } },
        });
        projectSpend24hUsd = round2(agg._sum.amountUsd);
      }

      return { id: f.id, createdAt: f.createdAt, message: f.message, userId, jobId, projectId, projectSpend24hUsd };
    }),
  );
}
