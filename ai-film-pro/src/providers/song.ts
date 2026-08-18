import { fal } from "../falClient";
import { config } from "../config";
import { downloadToFile, probeDurationSec, withTimeout } from "../util";
import type { LyricsResult } from "../types";

// fal.subscribe() has no built-in timeout — see util.ts's withTimeout().
const SONG_TIMEOUT_MS = 5 * 60_000;

/**
 * MINIMAX MUSIC v2 (via fal.ai) — a full song WITH VOCALS (lyrics + music),
 * for the AI Song Videos feature. DISTINCT from providers/music.ts
 * (cassetteai/music-generator), which is instrumental-ONLY and explicitly
 * cannot do this (see that file's own prompt: "No vocals, no lyrics...").
 *
 * Endpoint and I/O shape CONFIRMED via a real test call (2026-08-05, see
 * experiments/test-minimax-music-v2-smoketest.mjs and its saved
 * experiments/minimax-music-v2-result.json) — not guessed:
 *   - Input: { prompt: string (style, 10-300 chars), lyrics_prompt: string
 *     (10-3000 chars, structure tags — "[verse]line1\nline2\n[chorus]...").
 *     Lowercase tags CONFIRMED working ([verse]/[chorus]/[outro] used in the
 *     real test call); the rest of LyricsSectionSchema's tag enum (Pre
 *     Chorus, Post Chorus, Hook, etc) is the model's own documented list per
 *     fal's product page, NOT individually test-called — a wrong one would
 *     surface as a real API error, same "let a wrong guess surface"
 *     discipline as every other unverified field in this codebase.
 *   - Output: { audio: { url, content_type, file_name, file_size } } — same
 *     nested-object shape every other fal.ai media provider here returns
 *     (video.ts's { video: {...} }, image.ts's { images: [...] }).
 *   - NO section-timing metadata in the response — confirmed via the real
 *     test call. Real total duration is probed from the downloaded audio
 *     file itself (see generateSong() below); per-SECTION timing is only
 *     ever an ESTIMATE, proportional to each section's line count within
 *     that real total (see estimateSectionTimings()) — there is no ground
 *     truth to measure it against.
 *   - Real cost: $0.035/generation per fal.ai's own product page (flat per
 *     call, not per-second like video/image) — see config.ts's own comment
 *     on why this still needs verifying against actual billing.
 *   - COMMERCIAL-USE LICENSING: fal.ai's product page advertises commercial
 *     use, but MiniMax's OWN base model license separately requires written
 *     authorization for commercial use — unconfirmed whether that's already
 *     covered by fal.ai's own agreement with MiniMax. STATED HONESTLY: this
 *     needs direct verification with fal.ai before this feature goes live
 *     for paying customers — nothing in this file can resolve that.
 */

export interface SongResult {
  url: string;
  /** REAL duration, probed from the downloaded audio file — the API's own
   *  response never includes it (confirmed). */
  durationSec: number;
  /** Each section's ESTIMATED start/end within durationSec, proportional to
   *  its own line count relative to the whole song's total line-equivalent
   *  weight — an approximation, not a measurement (the API gives nothing to
   *  measure against). Used by the song-breakdown step to time shots against
   *  real song structure. */
  sections: { tag: string; startSec: number; endSec: number }[];
}

const INSTRUMENTAL_TAGS = new Set(["Inst", "Interlude", "Break"]);
/** Line-equivalent weight for a section with zero lyric lines (instrumental
 *  breaks/interludes) — these still take real song time, just no words. A
 *  rough middle-ground guess (about one phrase's length), not a measured
 *  constant — there is nothing to measure it against without real
 *  section-level API timing. */
const INSTRUMENTAL_LINE_WEIGHT = 4;

function estimateSectionTimings(
  sections: LyricsResult["sections"],
  totalDurationSec: number,
): SongResult["sections"] {
  const weights = sections.map((s) =>
    INSTRUMENTAL_TAGS.has(s.tag) ? INSTRUMENTAL_LINE_WEIGHT : Math.max(1, s.lines.length),
  );
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  return sections.map((s, i) => {
    const share = (weights[i] / totalWeight) * totalDurationSec;
    const startSec = Math.round(cursor * 10) / 10;
    cursor += share;
    return { tag: s.tag, startSec, endSec: Math.round(cursor * 10) / 10 };
  });
}

/** Builds the flat "[tag]line1\nline2\n[nexttag]..." string MiniMax's
 *  lyrics_prompt field expects, from LyricsResult's structured sections —
 *  the structured shape is kept upstream (see types.ts's own comment on
 *  LyricsSectionSchema) so the breakdown step can read each section's real
 *  line COUNT for timing estimation; this flattening only happens right
 *  before the API call. */
function buildLyricsPrompt(sections: LyricsResult["sections"]): string {
  return sections.map((s) => `[${s.tag.toLowerCase()}]${s.lines.join("\n")}`).join("\n");
}

/** Generates one full vocal song and downloads it to `downloadPath` (needed
 *  to probe its real duration — see SongResult's own comment on why the API
 *  response alone isn't enough). */
export async function generateSong(lyrics: LyricsResult, downloadPath: string): Promise<SongResult> {
  const input = {
    prompt: lyrics.stylePrompt,
    lyrics_prompt: buildLyricsPrompt(lyrics.sections),
  };
  try {
    const r: any = await withTimeout(fal.subscribe(config.songModel, { input }), SONG_TIMEOUT_MS, "song generation");
    const url = r?.data?.audio?.url;
    if (typeof url !== "string" || !url) {
      throw new Error(`Unexpected response shape from ${config.songModel}: ${JSON.stringify(r?.data ?? r).slice(0, 500)}`);
    }
    await downloadToFile(url, downloadPath);
    const durationSec = await probeDurationSec(downloadPath);
    const sections = estimateSectionTimings(lyrics.sections, durationSec);
    return { url, durationSec, sections };
  } catch (e: any) {
    console.error(`\n❌ Song generation (${config.songModel}) rejected the request. Actual reason:`);
    console.error(JSON.stringify(e?.body ?? e?.response?.data ?? e?.message ?? e, null, 2));
    throw e;
  }
}
