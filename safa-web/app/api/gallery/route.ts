import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic"; // never statically cache a moderatable public list

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : lo;
}

// PUBLIC, UNAUTHENTICATED. Anyone can call this — no currentUser() check on
// purpose, this is the public gallery feed. Cursor-paginated, not skip/
// offset: this list is moderatable (a card can vanish via /admin/reports'
// takedown flow between page loads), and offset pagination would risk
// skipping or duplicating rows when that happens mid-scroll.
//
// NEVER add `include` here, or any field beyond the explicit `select` below.
// This route has no auth gate — an `include: { user: true }` added later for
// some unrelated reason would silently leak emails onto the open internet.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const take = clamp(Number(searchParams.get("take")), 1, 48) || 24;
  const cursor = searchParams.get("cursor") || undefined;

  const rows = await prisma.project.findMany({
    where: { publicGallery: true, blocked: false, status: "done", filmUrl: { not: null }, shareToken: { not: null } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], // id tiebreaker so the cursor is stable even when updatedAt ties
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, title: true, filmUrl: true, shareToken: true, updatedAt: true },
  });

  const hasMore = rows.length > take;
  const items = hasMore ? rows.slice(0, take) : rows;
  return NextResponse.json({
    items: items.map((p) => ({ id: p.id, title: p.title, filmUrl: p.filmUrl, shareToken: p.shareToken, updatedAt: p.updatedAt })),
    nextCursor: hasMore ? items[items.length - 1].id : null,
  });
}
