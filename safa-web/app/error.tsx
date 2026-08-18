"use client";
import Link from "next/link";
import Logo from "@/components/Logo";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="peach-bg" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "24px", gap: 14 }}>
      <div style={{ marginBottom: 8 }}><Logo height={30} /></div>
      <h1 style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: "clamp(22px,3.4vw,30px)", color: "#2C211C", margin: 0 }}>Something went wrong</h1>
      <p style={{ color: "#6b5a4f", fontSize: 15, maxWidth: 400, margin: 0, lineHeight: 1.6 }}>
        An unexpected error happened on our end. You can try again, or head back to your projects.
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <button onClick={reset} style={{ background: "var(--coral)", color: "#fff", fontWeight: 600, fontSize: 15, padding: "11px 22px", borderRadius: 12, border: "none", cursor: "pointer" }}>
          Try again
        </button>
        <Link href="/app" style={{ background: "#fff", color: "#2C211C", fontWeight: 600, fontSize: 15, padding: "11px 22px", borderRadius: 12, textDecoration: "none", border: "1px solid rgba(44,33,28,.15)" }}>
          Back to projects
        </Link>
      </div>
    </main>
  );
}