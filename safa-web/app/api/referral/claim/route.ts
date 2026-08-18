import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

const REF_COOKIE = "ref";

// Fully idempotent -- safe to call on every app load (see app/app/page.tsx),
// not just right after signup. Bails instantly once referredBy is already
// set, so there's no need to detect "is this a brand-new signup" client-side.
export async function POST() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (user.referredBy) return NextResponse.json({ ok: true, claimed: false });

  const code = cookies().get(REF_COOKIE)?.value;
  if (!code) return NextResponse.json({ ok: true, claimed: false });

  // Once looked at, the cookie has done its job either way -- clear it so a
  // stale/invalid code doesn't get re-resolved on every future app load.
  const done = (claimed: boolean) => {
    const res = NextResponse.json({ ok: true, claimed });
    res.cookies.set(REF_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  };

  const referrer = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
  // No referrer found, or the visitor is trying to refer themselves -- both
  // are silent no-ops, never an error surfaced to the caller.
  if (!referrer || referrer.id === user.id) return done(false);

  await prisma.user.update({ where: { id: user.id }, data: { referredBy: referrer.id } });
  return done(true);
}
