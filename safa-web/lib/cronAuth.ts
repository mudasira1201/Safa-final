/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` on every scheduled
 *  invocation when CRON_SECRET is set in the project's env (Vercel's own
 *  documented convention) — this is what keeps these routes from being
 *  publicly triggerable by anyone who finds the URL. Fails CLOSED: if
 *  CRON_SECRET isn't set at all, every request is rejected rather than the
 *  route silently running unauthenticated. */
export function isAuthorizedCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${secret}`;
}
