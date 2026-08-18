import { prisma } from "@/lib/prisma";
import Logo from "@/components/Logo";
import GalleryLoadMore from "@/components/GalleryLoadMore";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

export const metadata: Metadata = {
  title: "Gallery · safa.ai",
  description: "Real films made with safa.ai — not stock footage, not curated demos.",
};

export type GalleryItem = { id: string; title: string; filmUrl: string; shareToken: string; updatedAt: string };

async function getFirstPage(): Promise<{ items: GalleryItem[]; nextCursor: string | null }> {
  const rows = await prisma.project.findMany({
    where: { publicGallery: true, blocked: false, status: "done", filmUrl: { not: null }, shareToken: { not: null } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    select: { id: true, title: true, filmUrl: true, shareToken: true, updatedAt: true },
  });
  const hasMore = rows.length > PAGE_SIZE;
  const items = (hasMore ? rows.slice(0, PAGE_SIZE) : rows) as unknown as GalleryItem[];
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export default async function GalleryPage() {
  const { items, nextCursor } = await getFirstPage();

  return (
    <main style={{ minHeight: "100vh", background: "linear-gradient(180deg,#FFF5EC 0%,#FFE9D8 100%)", padding: "32px 20px 80px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
          <Logo height={26} />
          <a href="/" style={{ color: "#EE6C4D", fontWeight: 600, fontSize: 14, textDecoration: "none" }}>Make your own film →</a>
        </div>
        <h1 style={{ fontFamily: "var(--display, 'Bricolage Grotesque', system-ui)", fontSize: "clamp(28px,4.5vw,44px)", color: "#2C211C", margin: "0 0 8px", lineHeight: 1.1 }}>
          Real films, made with safa.ai
        </h1>
        <p style={{ color: "#6b5a4f", fontSize: 15, margin: "0 0 32px", maxWidth: 640 }}>
          Every film below is a real render, not a curated demo — published by the people who made them.
        </p>

        {items.length === 0 ? (
          <p style={{ color: "#6b5a4f", fontSize: 15 }}>No films published yet — be the first.</p>
        ) : (
          <GalleryLoadMore initialItems={items} initialCursor={nextCursor} />
        )}
      </div>
    </main>
  );
}
