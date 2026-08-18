// Pre-launch ops automation — Tier 1 #1 (daily ops digest), #3 (QA defect-rate
// trend), #4 (content-safety log review). Triggered by Vercel Cron (see
// vercel.json, root of repo) once daily. Reuses lib/opsDigest.ts's query
// helpers — the SAME ones app/api/admin/overview/route.ts uses for the live
// admin page, so this never computes a second, drifted version of the same
// numbers. See lib/cronAuth.ts for why this can't be triggered by anyone who
// finds the URL.
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cronAuth";
import { getOpsRecipients } from "@/lib/opsRecipients";
import { sendEmail } from "@/lib/email";
import { getAdminStats, getStuckOrDuplicateJobs, getQaTrend, getSafetyRefusalSummary, getOpsFindings, getRefundAuditRows } from "@/lib/opsDigest";

function fmtUsd(n: number) {
  return `$${n.toFixed(2)}`;
}

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [stats, stuckOrDuplicate, qaTrend, safety, recentFindings, refunds] = await Promise.all([
    getAdminStats(),
    getStuckOrDuplicateJobs(),
    getQaTrend(),
    getSafetyRefusalSummary(),
    getOpsFindings({ since: dayAgo }),
    getRefundAuditRows({ since: dayAgo }),
  ]);

  const trendArrow = qaTrend.deltaPct === null ? "" : qaTrend.deltaPct > 0 ? "▲ worse" : qaTrend.deltaPct < 0 ? "▼ better" : "flat";

  const html = `
    <h2>Safa.ai — Daily Ops Digest</h2>
    <h3>Spend</h3>
    <p>Today: ${fmtUsd(stats.spendToday)} · This week: ${fmtUsd(stats.spendWeek)} · This month: ${fmtUsd(stats.spendMonth)}</p>
    <h3>Jobs / Reports</h3>
    <p>Failed jobs (all-time count): ${stats.failedCount} · Open reports: ${stats.openReports} · Blocked users: ${stats.blockedUsers}</p>
    ${
      stuckOrDuplicate.length
        ? `<p><strong>⚠️ ${stuckOrDuplicate.length} stuck/duplicate job(s):</strong><br>${stuckOrDuplicate
            .map((j) => `${j.reason.toUpperCase()} — job ${j.id} (project ${j.projectId}, status ${j.status}, last updated ${j.updatedAt.toISOString()})`)
            .join("<br>")}</p>`
        : `<p>No stuck or duplicate jobs.</p>`
    }
    <h3>QA</h3>
    <p>Pass rate (7d): ${stats.qaPassRateWeek ?? "—"}% · Unverified rate (7d): ${stats.qaUnverifiedRateWeek ?? "—"}%</p>
    <p>Fail rate this week: ${qaTrend.thisWeekFailRate ?? "—"}% vs last week: ${qaTrend.lastWeekFailRate ?? "—"}% (${trendArrow}${qaTrend.deltaPct !== null ? ` ${Math.abs(qaTrend.deltaPct)}pp` : ""})</p>
    <h3>Content safety</h3>
    <p>Refusals: ${safety.count24h} (24h) / ${safety.count7d} (7d)</p>
    ${
      Object.keys(safety.byCategory7d).length
        ? `<p>By category (7d): ${Object.entries(safety.byCategory7d)
            .map(([cat, n]) => `${cat}: ${n}`)
            .join(", ")}</p>`
        : ``
    }
    <h3>Refunds (last 24h)</h3>
    ${
      refunds.length
        ? `<p>${refunds
            .map(
              (r) =>
                `${r.createdAt.toISOString()} — ${r.message} (project ${r.projectId ?? "?"}, that project's Spend in the preceding 24h: ${
                  r.projectSpend24hUsd === null ? "unknown" : fmtUsd(r.projectSpend24hUsd)
                })`,
            )
            .join("<br>")}</p>`
        : `<p>No refunds in the last 24h.</p>`
    }
    <h3>Provider/worker findings (last 24h)</h3>
    ${
      recentFindings.filter((f) => f.source !== "refund-audit").length
        ? `<p>${recentFindings
            .filter((f) => f.source !== "refund-audit")
            .map((f) => `[${f.severity}] ${f.source}: ${f.message}`)
            .join("<br>")}</p>`
        : `<p>No findings in the last 24h.</p>`
    }
  `;

  const to = getOpsRecipients();
  if (to.length) {
    await sendEmail(to.join(","), "Safa.ai — Daily Ops Digest", html);
  }

  return NextResponse.json({ ok: true, sentTo: to.length });
}
