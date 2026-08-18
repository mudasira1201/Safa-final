// ==========================================================
// PUT THIS FILE AT:  safa-web/lib/currentUser.ts
// (rename to: currentUser.ts)
// ==========================================================
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** Returns the logged-in user row, or null. Use in API routes to authorize + get credits.
 *  A BLOCKED user is treated as logged out, so a ban takes effect immediately: their existing
 *  session token stays valid but every API call now returns 401. */
export async function currentUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || user.blocked) return null;
  return user;
}