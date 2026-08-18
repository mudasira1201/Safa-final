import { fal } from "../falClient";
import { withTimeout } from "../util";

// SYNC LIPSYNC v2 PRO (via fal.ai) — REAL, CONFIRMED endpoint and I/O shape,
// fetched directly from fal's own API reference pages (2026-08-15):
//   https://fal.ai/models/fal-ai/sync-lipsync/v2/pro/api
// Input: { video_url: string, audio_url: string, sync_mode?: SyncModeEnum }.
// sync_mode governs how a video/audio DURATION MISMATCH is handled —
// "remap" (used below) ADJUSTS TIMING TO FIT BOTH INPUTS, i.e. it retimes
// the video itself to match the new audio's real length, which is exactly
// what this pipeline needs: a translated dialogue line's natural spoken
// length rarely matches the shot's original (Seedance-rendered) duration,
// and remap is the one mode that fixes that by adjusting the PICTURE rather
// than time-stretching the voice (util.ts's muxReplaceAudio()'s atempo
// approach) or losing content (cut_off) or looping/bouncing unnaturally.
// Output: { video: { url, content_type, file_name, file_size, width,
// height, fps, duration, num_frames } } — same shape convention as
// providers/video.ts's own renderShot() output, same r?.data?.video?.url
// extraction. PRICING NOT SHOWN on fal's docs page — UNVERIFIED cost, same
// "confirm on first real call" discipline this codebase already applies to
// every other not-yet-billed-against endpoint (see providers/music.ts's own
// comment on musicEnabled's default-off state for the identical reasoning).
const LIPSYNC_TIMEOUT_MS = 5 * 60_000;

/** Re-syncs `videoUrl`'s mouth movements to `audioUrl` (a dubbed voice
 *  track), returning the resulting video's URL. Both inputs must be
 *  PUBLICLY FETCHABLE URLs — fal.subscribe() fetches them server-side, the
 *  same requirement every other fal.ai call in this codebase already has
 *  for its own image/video inputs. Throws on failure; the caller (see
 *  5-videos.ts's dub step) falls back to a plain audio-replace (no visual
 *  re-sync) rather than losing the clip. */
export async function applyLipSync(videoUrl: string, audioUrl: string): Promise<string> {
  const r: any = await withTimeout(
    fal.subscribe("fal-ai/sync-lipsync/v2/pro", {
      input: { video_url: videoUrl, audio_url: audioUrl, sync_mode: "remap" },
    }),
    LIPSYNC_TIMEOUT_MS,
    "lip-sync",
  );
  const url = r?.data?.video?.url;
  if (typeof url !== "string" || !url) {
    throw new Error(`sync-lipsync returned no video URL: ${JSON.stringify(r?.data)}`);
  }
  return url;
}
