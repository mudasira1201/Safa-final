// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/support/route.ts   *** NEW FILE ***
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { safeJson, badRequest, tooMany } from "@/lib/http";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// EMAIL_RE allows any non-whitespace, non-@ character in the local part --
// including "<" and ">" -- so it does NOT reject something like
// "<img src=x onerror=...>@x.co" as an email address. Both `email` and
// `message` below get interpolated into a raw HTML email with no escaping,
// so without this, arbitrary HTML/script could ride along into the outbound
// email to support@safa.ai. Not currently reachable from a web page (no admin
// UI reads SupportTicket back today), so this is defense-in-depth rather than
// a live exploit -- but cheap to close now, before an admin ticket viewer
// (a natural next addition, mirroring the existing users/projects/reports
// panels) would turn unescaped stored HTML into real stored XSS.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function POST(req: Request) {
  if (!(await rateLimit(clientKey(req, "support"), 5, 60_000))) {
    return tooMany("Too many messages. Please wait a minute.");
  }
  const body = await safeJson<{ email?: string; subject?: string; message?: string }>(req);
  if (!body) return badRequest();

  const session = await getServerSession(authOptions).catch(() => null);
  const email = String(body.email || session?.user?.email || "").trim().toLowerCase();
  const subject = String(body.subject || "").trim().slice(0, 120);
  const message = String(body.message || "").trim().slice(0, 4000);

  if (!EMAIL_RE.test(email)) return badRequest("We need a valid email so we can reply.");
  if (message.length < 10) return badRequest("Tell us a bit more so we can actually help.");

  // Stored FIRST. If the email send fails, the ticket still exists and is not lost.
  const ticket = await prisma.supportTicket.create({
    data: { email, subject: subject || "No subject", message },
  });

  await sendEmail(
    // Subject is a plain-text email header, not HTML body content -- unlike
    // the two fields below, it must NOT be HTML-escaped (that would show a
    // literal "&lt;" to the recipient for any subject containing "<").
    process.env.SUPPORT_EMAIL || "support@safa.ai",
    `[safa support] ${subject || "No subject"}`,
    `<p><b>From:</b> ${escapeHtml(email)}</p><p><b>Ticket:</b> ${ticket.id}</p><hr/><p>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>`
  ).catch((e) => console.error("[support] email failed, ticket still saved:", e?.message));

  return NextResponse.json({ ok: true });
}