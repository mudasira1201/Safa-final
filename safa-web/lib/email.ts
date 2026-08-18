import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.EMAIL_FROM || "safa.ai <onboarding@resend.dev>";

/** Sends an email via Resend. If no RESEND_API_KEY is set, logs it to the console
 *  so the flow still works in development. */
export async function sendEmail(to: string, subject: string, html: string) {
  if (!resend) {
    console.log(`\n──────── EMAIL (no RESEND_API_KEY — logged instead) ────────\nTo: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, " ").trim()}\n────────────────────────────────────────────────────────────\n`);
    return;
  }
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (e) {
    console.error("Email send failed:", e);
  }
}
