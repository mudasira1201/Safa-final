// ==========================================================
// PUT THIS FILE AT:  safa-web/lib/http.ts  (NEW FILE - create it)
// (rename this file to: http.ts)
// ==========================================================
import { NextResponse } from "next/server";

/** Safely parse a JSON request body.
 *  An unguarded `await req.json()` THROWS on malformed input, which Next turns into a 500.
 *  Bad input from a client is a 400, not a server error, so every route parses through this. */
export async function safeJson<T = Record<string, unknown>>(req: Request): Promise<T | null> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object") return null;
    return body as T;
  } catch {
    return null;
  }
}

/** Standard 400 for a body we could not parse or that failed validation. */
export function badRequest(message = "Invalid request body.") {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Standard 429 for a caller who is over a rate limit or a per-project cap. */
export function tooMany(message = "Too many requests. Please wait a moment and try again.") {
  return NextResponse.json({ error: message }, { status: 429 });
}