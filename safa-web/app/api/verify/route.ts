import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const base = process.env.NEXTAUTH_URL || url.origin;
  const row = await prisma.authToken.findUnique({ where: { token } });
  if (!row || row.purpose !== "verify" || row.expires < new Date()) {
    return NextResponse.redirect(`${base}/login?verified=0`);
  }
  await prisma.user.update({ where: { id: row.userId }, data: { emailVerified: new Date() } });
  await prisma.authToken.delete({ where: { token } }).catch(() => {});
  return NextResponse.redirect(`${base}/login?verified=1`);
}
