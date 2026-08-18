"use client";
import { useState } from "react";
import type { GalleryItem } from "@/app/gallery/page";

// The worker uploads a matching .jpg poster next to every video — same
// convention app/app/page.tsx's ProjectCard already relies on.
const posterFor = (u: string) => u.replace(/\.mp4(#.*)?$/i, ".jpg");

// Safari ignores #t= alone on a <video>, so seek on both loadedmetadata and
// loadeddata for a reliable cross-browser poster frame — same fix
// app/app/page.tsx already applies to every video thumbnail.
function seekPoster(e: React.SyntheticEvent<HTMLVideoElement>) {
  const v = e.currentTarget;
  try { if (v.currentTime < 0.05) v.currentTime = 0.1; } catch {}
}

export default function GalleryLoadMore({ initialItems, initialCursor }: { initialItems: GalleryItem[]; initialCursor: string | null }) {
  const [items, setItems] = useState(initialItems);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/gallery?cursor=${encodeURIComponent(cursor)}`);
      const j = await r.json();
      setItems((prev) => [...prev, ...(j.items || [])]);
      setCursor(j.nextCursor ?? null);
    } catch {
      // leave cursor as-is — the button just stays available to retry
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 18 }}>
        {items.map((p) => (
          <a
            key={p.id}
            href={`/p/${p.shareToken}`}
            style={{ display: "block", borderRadius: 14, overflow: "hidden", background: "#000", boxShadow: "0 10px 30px rgba(80,40,25,.18)", textDecoration: "none" }}
          >
            <video
              src={`${p.filmUrl}#t=0.1`}
              poster={posterFor(p.filmUrl)}
              muted
              playsInline
              preload="metadata"
              onLoadedMetadata={seekPoster}
              onLoadedData={seekPoster}
              style={{ width: "100%", aspectRatio: "16 / 9", display: "block", background: "#000" }}
            />
            <div style={{ padding: "10px 12px", background: "#fff" }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "#2C211C", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</div>
            </div>
          </a>
        ))}
      </div>
      {cursor && (
        <div style={{ textAlign: "center", marginTop: 28 }}>
          <button
            onClick={loadMore}
            disabled={loading}
            style={{ padding: "10px 22px", borderRadius: 999, border: "1.5px solid #EE6C4D", background: "transparent", color: "#EE6C4D", fontWeight: 600, fontSize: 14, cursor: loading ? "default" : "pointer" }}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
