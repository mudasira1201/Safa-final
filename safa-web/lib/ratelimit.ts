// ==========================================================
// PUT THIS FILE AT:  safa-web/lib/ratelimit.ts
// (rename to: ratelimit.ts)
// ==========================================================
// Rate limiter.
//
// PRODUCTION: uses Upstash Redis (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
// This is REQUIRED on Vercel: serverless instances do not share memory, so an in-memory
// limiter resets on every cold start and is trivially bypassed. An attacker farms accounts
// and converts your free credits straight into fal spend.
//
// LOCAL DEV: with no Upstash env vars, it falls back to an in-memory Map so nothing breaks.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
export const usingRedis = Boolean(REDIS_URL && REDIS_TOKEN);

// Fail LOUDLY at boot rather than silently shipping an ineffective limiter.
if (!usingRedis && process.env.NODE_ENV === "production") {
  console.error(
    "\n🚨 RATE LIMITING IS EFFECTIVELY OFF.\n" +
    "   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set, so the limiter is\n" +
    "   using in-process memory. On serverless this resets constantly and can be bypassed.\n" +
    "   Anyone can farm accounts and convert your free credits into provider spend.\n" +
    "   Create a free database at console.upstash.com and set both env vars.\n"
  );
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function memoryLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

// Fixed-window counter, atomic in one Redis round trip.
async function redisLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowSec), "NX"]]),
    cache: "no-store",
  });
  if (!res.ok) return true; // fail open: a Redis blip must never lock real users out
  const data = (await res.json()) as { result: number }[];
  return Number(data?.[0]?.result ?? 0) <= limit;
}

/** True if the request is allowed, false if it is over the limit. */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  if (!usingRedis) return memoryLimit(key, limit, windowMs);
  try {
    return await redisLimit(key, limit, windowMs);
  } catch {
    return true;
  }
}

export function clientKey(req: Request, scope: string): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  const ip = fwd.split(",")[0].trim() || "local";
  return `rl:${scope}:${ip}`;
}