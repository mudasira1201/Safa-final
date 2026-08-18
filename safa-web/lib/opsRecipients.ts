/** Ops digest/alert recipients — reuses ADMIN_EMAILS (lib/isAdmin.ts's own
 *  root-admin list) rather than inventing a second, separately-maintained
 *  email list. Admins are the natural, only-existing audience for this. */
export function getOpsRecipients(): string[] {
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
