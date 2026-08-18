// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/expand/route.ts
// (rename to: route.ts)
// ==========================================================
import { NextResponse } from "next/server";
import { safeJson, badRequest } from "@/lib/http";
import OpenAI from "openai";
import { currentUser } from "@/lib/currentUser";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { moderateText, blockedMessage } from "@/lib/moderation";

const client = process.env.LLM_API_KEY ? new OpenAI({ apiKey: process.env.LLM_API_KEY }) : null;

const SYSTEM = `You are a screenwriter for short AI-generated films. Turn the user's short idea into a brief, filmable screenplay.
Rules:
- 4 to 8 short scenes, suitable for a 1 to 2 minute film.
- Each scene: a one-line visual description of what we see, and optional short dialogue.
- Keep the whole thing under 1400 characters.
- Concrete and visual. No camera jargon, no title page, no act headings.
- Output ONLY the screenplay text. No preamble, no explanation, no markdown fences.`;

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await rateLimit(clientKey(req, "expand") + ":" + user.id, 10, 60_000))) {
    return NextResponse.json({ error: "You're generating scripts very fast. Please wait a moment." }, { status: 429 });
  }
  if (!client) {
    return NextResponse.json({ error: "Script writing is not configured. Add LLM_API_KEY to enable it, or paste your own script." }, { status: 503 });
  }

  const body = await safeJson<any>(req);
  if (!body) return badRequest();
  const { idea } = body;
  const clean = String(idea || "").trim().slice(0, 2000);
  if (clean.length < 8) {
    return NextResponse.json({ error: "Tell me a little more about your idea first." }, { status: 400 });
  }

  const mod = await moderateText(clean);
  if (!mod.allowed) return NextResponse.json({ error: blockedMessage(mod.reason) }, { status: 422 });

  try {
    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Idea: ${clean}` },
      ],
      temperature: 0.8,
      max_tokens: 600,
    });
    const script = (res.choices[0]?.message?.content || "").trim();
    if (!script) throw new Error("empty");
    return NextResponse.json({ script });
  } catch {
    return NextResponse.json({ error: "Could not write the script just now. Please try again." }, { status: 500 });
  }
}