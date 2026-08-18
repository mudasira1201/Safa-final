// Pre-launch ops automation — Tier 1 #2 (provider balance/health monitor),
// the FAST/frequent-poll half. Triggered by Vercel Cron every 15 minutes
// (see vercel.json). ai-film-pro's own passive provider-health hooks (see
// ai-film-pro/src/lib/opsAlert.ts, wired into llm.ts/image.ts/video.ts's
// real error-handling paths) write critical OpsFinding rows the instant a
// real render call fails on a billing/auth-shaped error — this route's only
// job is to notice those quickly and email about them, not to detect
// anything itself. This is what would have caught today's real
// OpenAI-out-of-credits incident before it silently blocked work.
//
// Also covers the "stuck job" half of worker/job health at this same fast
// cadence — the daily digest (app/api/cron/daily-digest) covers the SAME
// query as its own daily summary; this is the immediate-alert version.
import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cronAuth";
import { getOpsRecipients } from "@/lib/opsRecipients";
import { sendEmail } from "@/lib/email";
import { getOpsFindings, getStuckOrDuplicateJobs } from "@/lib/opsDigest";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [critical, stuckOrDuplicate] = await Promise.all([
    getOpsFindings({ severity: "critical", unresolvedOnly: true }),
    getStuckOrDuplicateJobs(),
  ]);

  const stuckOnly = stuckOrDuplicate.filter((j) => j.reason === "stuck");

  if (!critical.length && !stuckOnly.length) {
    return NextResponse.json({ ok: true, alerted: false });
  }

  const html = `
    <h2>Safa.ai — Critical Ops Alert</h2>
    ${
      critical.length
        ? `<h3>Critical provider/worker findings</h3><p>${critical
            .map((f) => `[${f.source}] ${f.message}${f.detail ? ` — ${f.detail.slice(0, 300)}` : ""}`)
            .join("<br>")}</p>`
        : ``
    }
    ${
      stuckOnly.length
        ? `<h3>Stuck jobs</h3><p>${stuckOnly
            .map((j) => `Job ${j.id} (project ${j.projectId}) — status "${j.status}", last updated ${j.updatedAt.toISOString()}`)
            .join("<br>")}</p>`
        : ``
    }
  `;

  const to = getOpsRecipients();
  if (to.length) {
    await sendEmail(to.join(","), "Safa.ai — Critical Ops Alert", html);
  }

  // The alert itself is the resolution — a human now knows and can
  // investigate; if the underlying problem recurs, a fresh finding gets
  // logged and alerted on its own next cycle. Never delete the row, only
  // mark it handled, so the audit trail survives.
  if (critical.length) {
    await prisma.opsFinding.updateMany({
      where: { id: { in: critical.map((f) => f.id) } },
      data: { resolvedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true, alerted: true, criticalCount: critical.length, stuckCount: stuckOnly.length });
}
