import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let code = user.referralCode;
  if (!code) {
    code = randomBytes(9).toString("base64url"); // short, URL-safe -- same generation shape share/route.ts already uses
    await prisma.user.update({ where: { id: user.id }, data: { referralCode: code } });
  }

  const base = new URL(req.url).origin;
  return NextResponse.json({ code, link: `${base}/r/${code}` });
}
