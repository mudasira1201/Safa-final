// ==========================================================
// PUT THIS FILE AT:  safa-web/app/api/upload/route.ts   *** NEW FILE ***
// ==========================================================
//
// Uploads a product image for ad-mode films. Flow:
//   browser file → this endpoint → fal storage → MODERATE the URL → return it.
//
// Uses fal storage (free — fal only charges for model inference, not file
// storage) with the SAME FAL_KEY the pipeline already uses. No new account,
// no new token, works on localhost immediately.

import { NextResponse } from "next/server";
import { fal } from "@/lib/falClient";
import { currentUser } from "@/lib/currentUser";
import { moderateImage, blockedMessage } from "@/lib/moderation";
import { rateLimit, clientKey } from "@/lib/ratelimit";
import { tooMany } from "@/lib/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const OK_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Every request costs real money regardless of outcome: a real fal storage
  // upload, then a real paid OpenAI moderation call on the result (see
  // moderateImage() in lib/moderation.ts) -- unlike every other paid-call
  // route in this app (options, expand), this one had no rate limit at all,
  // so a single authenticated user could hammer it indefinitely with no cap.
  if (!(await rateLimit(clientKey(req, "upload") + ":" + user.id, 10, 60_000))) {
    return tooMany("You're uploading very fast. Please wait a moment.");
  }

  if (!process.env.FAL_KEY) {
    console.error("[upload] FAL_KEY not set");
    return NextResponse.json({ error: "Uploads are not configured." }, { status: 500 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (!OK_TYPES.has(file.type)) {
    return NextResponse.json({ error: "Please upload a JPEG, PNG, or WebP image." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Image is too large (max 8 MB)." }, { status: 400 });
  }

  // Upload to fal storage → get a public URL fal's own models can fetch.
  let url: string;
  try {
    url = await fal.storage.upload(file);
  } catch (e) {
    console.error("[upload] fal storage upload failed:", (e as Error)?.message);
    return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 500 });
  }

  // MODERATE the uploaded image before it can be used in a film. Uploads are a new
  // abuse surface, so nothing gets used until it clears the same check as scripts.
  const mod = await moderateImage(url);
  if (!mod.allowed) {
    return NextResponse.json({ error: blockedMessage(mod.reason) }, { status: 422 });
  }

  return NextResponse.json({ url });
}