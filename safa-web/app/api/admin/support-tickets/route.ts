// Pre-launch ops automation — Tier 2 #8 (support inbox triage). SupportTicket
// is a plain DB-form table (email, subject, message, status), not an email
// inbox — see app/api/support/route.ts, the only writer. This route is the
// admin-facing triage surface: list open tickets, generate an LLM draft
// reply per ticket (reusing the LLM_API_KEY-gated OpenAI client pattern
// app/api/expand/route.ts already established), and let a human mark a
// ticket resolved once they've reviewed/sent it THEMSELVES — this route
// never sends anything on its own behalf.
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isAdmin } from "@/lib/isAdmin";
import { prisma } from "@/lib/prisma";
import OpenAI from "openai";

const client = process.env.LLM_API_KEY ? new OpenAI({ apiKey: process.env.LLM_API_KEY }) : null;

const DRAFT_SYSTEM = `You are a calm, helpful support agent for safa.ai, an AI film-generation product. Draft a short, warm, specific reply to the user's support message below. Address their actual question or problem directly — do not pad with generic filler ("Thank you for reaching out...") beyond one brief opening line. If the message describes a bug or a billing issue you cannot resolve yourself, say plainly that a team member will follow up with specifics, rather than inventing a resolution you cannot actually confirm. Output ONLY the reply text — no subject line, no signature block, no markdown.`;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(await isAdmin(session?.user?.email))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const tickets = await prisma.supportTicket.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
  });
  return NextResponse.json({ tickets });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(await isAdmin(session?.user?.email))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const ticketId = String(body?.ticketId || "");
  const action = String(body?.action || "");
  if (!ticketId || !["draft", "resolve"].includes(action)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const ticket = await prisma.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (action === "resolve") {
    await prisma.supportTicket.update({ where: { id: ticketId }, data: { status: "resolved" } });
    return NextResponse.json({ ok: true });
  }

  // action === "draft"
  if (!client) {
    return NextResponse.json({ error: "Draft generation is not configured (LLM_API_KEY not set)." }, { status: 503 });
  }
  try {
    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: DRAFT_SYSTEM },
        { role: "user", content: `Subject: ${ticket.subject}\n\nMessage:\n${ticket.message}` },
      ],
      temperature: 0.5,
      max_tokens: 500,
    });
    const draftReply = (res.choices[0]?.message?.content || "").trim();
    if (!draftReply) throw new Error("empty");
    await prisma.supportTicket.update({ where: { id: ticketId }, data: { draftReply } });
    return NextResponse.json({ ok: true, draftReply });
  } catch (e) {
    console.error("[support-tickets] draft generation failed:", (e as Error)?.message);
    return NextResponse.json({ error: "Could not generate a draft just now. Please try again." }, { status: 500 });
  }
}
