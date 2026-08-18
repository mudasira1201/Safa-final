import "dotenv/config";

// Raised 3 -> 6: the video-render phase (5-videos.ts) is the one part of the
// pipeline that already renders concurrently by design (unlike the keyframe
// phase, which is deliberately sequential for cross-shot continuity — see
// 4-images.ts's own comment). Doubling this halves that phase's wall-clock
// time for a typical film with no change to total provider cost (same number
// of calls, just more in flight at once) — the real tradeoff is hitting the
// video provider's own concurrency/rate limit sooner on an unusually large
// render. Still fully overridable via the CONCURRENCY env var.
export const CONCURRENCY = (() => {
  const n = parseInt(process.env.CONCURRENCY ?? "6", 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
})();

/** Run an async mapper over items with at most `limit` running at once. Keeps order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit > 0 ? limit : 1, items.length || 1));
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
