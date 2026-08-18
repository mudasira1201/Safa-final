import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const REF_COOKIE = "ref";
const REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// Referral link landing point. Deliberately just a cookie-drop + redirect --
// NOT where a referral gets attributed to an account (see claim/route.ts).
// Signup happens through two structurally different paths in this codebase
// (a direct prisma.user.create() in api/register/route.ts for email/
// password, vs NextAuth's PrismaAdapter.createUser() for Google, which has
// no hook point today) -- rather than patching both, this cookie survives
// however long it takes the visitor to actually sign up, and claim/route.ts
// reads it back afterward, working identically for either path.
export async function GET(req: Request, { params }: { params: { code: string } }) {
  const code = String(params.code || "").trim();
  const base = new URL("/", req.url);
  const res = NextResponse.redirect(base);

  if (!code) return res;

  // Never reveal whether the code matched a real account -- same discipline
  // api/report/route.ts already uses for share tokens.
  const owner = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } }).catch(() => null);
  if (owner) {
    res.cookies.set(REF_COOKIE, code, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: REF_COOKIE_MAX_AGE,
      path: "/",
    });
  }
  return res;
}
