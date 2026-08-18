"use client";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => { Sentry.captureException(error); }, [error]);
  return (
    <html>
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, textAlign: "center", padding: 24, background: "linear-gradient(180deg,#FFF5EC 0%,#FFE9D8 100%)", fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 26, color: "#2C211C", margin: 0 }}>Something went wrong</h1>
        <p style={{ color: "#6b5a4f", fontSize: 15, maxWidth: 400, margin: 0, lineHeight: 1.6 }}>
          An unexpected error happened. We&apos;ve been notified.
        </p>
        <a href="/app" style={{ marginTop: 8, background: "#EE6C4D", color: "#fff", fontWeight: 600, fontSize: 15, padding: "11px 22px", borderRadius: 12, textDecoration: "none" }}>
          Back to projects
        </a>
      </body>
    </html>
  );
}