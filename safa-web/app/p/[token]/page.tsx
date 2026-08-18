// ==========================================================
// PUT THIS FILE AT:  safa-web/app/p/[token]/page.tsx
// (rename to: page.tsx)
// ==========================================================
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import Logo from "@/components/Logo";
import ReportButton from "@/components/ReportButton";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

async function getShared(token: string) {
  const project = await prisma.project.findUnique({ where: { shareToken: token } });
  // TAKEDOWN: a blocked project disappears from the public web immediately.
  if (!project || project.blocked || project.status !== "done" || !project.filmUrl) return null;
  return { title: project.title, filmUrl: project.filmUrl };
}

export async function generateMetadata({ params }: { params: { token: string } }): Promise<Metadata> {
  const shared = await getShared(params.token);
  if (!shared) return { title: "safa.ai" };
  return { title: `${shared.title} · safa.ai`, description: "A film made with safa.ai" };
}

export default async function SharedFilm({ params }: { params: { token: string } }) {
  const shared = await getShared(params.token);
  if (!shared) notFound();

  return (
    <main style={{ minHeight: "100vh", background: "linear-gradient(180deg,#FFF5EC 0%,#FFE9D8 100%)", display: "flex", flexDirection: "column", alignItems: "center", padding: "32px 20px" }}>
      <div style={{ width: "100%", maxWidth: 900, display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
        <div style={{ alignSelf: "flex-start" }}><Logo height={26} /></div>
        <h1 style={{ fontFamily: "var(--display, 'Bricolage Grotesque', system-ui)", fontSize: "clamp(26px,4vw,40px)", color: "#2C211C", textAlign: "center", margin: "8px 0 0", lineHeight: 1.1 }}>
          {shared.title}
        </h1>
        <div style={{ width: "100%", borderRadius: 18, overflow: "hidden", background: "#000", boxShadow: "0 24px 60px rgba(80,40,25,.28)" }}>
          <video src={shared.filmUrl} poster={shared.filmUrl.replace(/\.mp4(#.*)?$/i, ".jpg")} controls playsInline style={{ width: "100%", display: "block", aspectRatio: "16 / 9", background: "#000" }} />
        </div>
        <p style={{ color: "#6b5a4f", fontSize: 14, textAlign: "center", margin: 0 }}>
          Made with <a href="/" style={{ color: "#EE6C4D", fontWeight: 600, textDecoration: "none" }}>safa.ai</a>. Turn a script into a finished film.
        </p>
        <ReportButton token={params.token} />
      </div>
    </main>
  );
}