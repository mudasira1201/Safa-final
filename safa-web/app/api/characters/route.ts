import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/currentUser";

// Mirrors ai-film-pro's CharacterSchema voice enum (types.ts) — stored as a
// plain string in the DB (same convention Project.status/type already use),
// validated against this allowlist here rather than in the schema.
const VOICES = new Set(["male_young", "male_adult", "male_old", "female_young", "female_adult", "female_old", "child", "narrator"]);

export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const characters = await prisma.savedCharacter.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ characters });
}

// Called from CreateFlow's char-modal (see components/CreateFlow.tsx) — the
// modal already has name/appearance/voice/photo client-side from the
// project's own breakdown + options, so this route takes them directly
// rather than looking them up server-side from a projectId+url pair.
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await safeJson<{ name?: string; appearance?: string; voice?: string; referenceImageUrl?: string; sourceProjectId?: string }>(req);
  if (!body) return badRequest();

  const name = String(body.name || "").trim().slice(0, 80);
  const appearance = String(body.appearance || "").trim().slice(0, 2000);
  const referenceImageUrl = String(body.referenceImageUrl || "").trim();
  const voice = VOICES.has(String(body.voice || "")) ? String(body.voice) : "narrator";

  if (!name) return badRequest("Give this character a name.");
  if (!/^https?:\/\//.test(referenceImageUrl)) return badRequest("A saved character needs a reference photo.");

  // Provenance only — never trusted for anything beyond display, so this is
  // just a courtesy check that the caller actually owns the project they
  // claim this came from, not a security-critical gate.
  let sourceProjectId: string | null = null;
  if (typeof body.sourceProjectId === "string" && body.sourceProjectId) {
    const owned = await prisma.project.findFirst({ where: { id: body.sourceProjectId, userId: user.id }, select: { id: true } });
    if (owned) sourceProjectId = owned.id;
  }

  const character = await prisma.savedCharacter.create({
    data: { userId: user.id, name, appearance, voice, referenceImageUrl, sourceProjectId },
  });
  return NextResponse.json({ character });
}
