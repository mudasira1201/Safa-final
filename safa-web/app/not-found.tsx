import Link from "next/link";
import Logo from "@/components/Logo";

export default function NotFound() {
  return (
    <main className="peach-bg" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "24px", gap: 14 }}>
      <div style={{ marginBottom: 8 }}><Logo height={30} /></div>
      <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: "clamp(48px,10vw,84px)", color: "var(--coral)", lineHeight: 1 }}>404</div>
      <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: "clamp(20px,3vw,26px)", color: "#2C211C", margin: 0 }}>We couldn&apos;t find that page</h1>
      <p style={{ color: "#6b5a4f", fontSize: 15, maxWidth: 380, margin: 0, lineHeight: 1.6 }}>
        The link may be broken, or the page may have moved. Let&apos;s get you back on track.
      </p>
      <Link href="/app" style={{ marginTop: 8, background: "var(--coral)", color: "#fff", fontWeight: 600, fontSize: 15, padding: "11px 22px", borderRadius: 12, textDecoration: "none" }}>
        Back to your projects
      </Link>
    </main>
  );
}