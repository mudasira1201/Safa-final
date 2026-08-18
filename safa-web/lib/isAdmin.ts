// ==========================================================
// PUT THIS FILE AT:  safa-web/lib/isAdmin.ts
// (rename to: isAdmin.ts)
// ==========================================================
import { prisma } from "./prisma";

/** ROOT admins come from the environment (ADMIN_EMAILS, or any @safa.ai address).
 *  They are the bootstrap: they can always get in, and they can never be demoted from the UI,
 *  so it is impossible to lock yourself out of your own admin panel. */
export function isRootAdmin(email?: string | null): boolean {
  if (!email) return false;
  const e = email.toLowerCase();
  const list = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(e) || e.split("@")[1] === "safa.ai";
}

/** Full admin check: a root admin (env), OR a user promoted to admin in the database.
 *  Promoting from the dashboard means you never have to edit .env and redeploy again. */
export async function isAdmin(email?: string | null): Promise<boolean> {
  if (!email) return false;
  if (isRootAdmin(email)) return true;
  const u = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { isAdmin: true } });
  return Boolean(u?.isAdmin);
}