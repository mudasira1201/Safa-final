import { runtime } from "../config";
import { generateLyrics } from "../providers/llm";
import { generateSong, type SongResult } from "../providers/song";
import { writeJson, readJsonOr, fileExists, isMain } from "../util";
import type { LyricsResult } from "../types";

export interface SongData {
  lyrics: LyricsResult;
  song: SongResult;
}

/** PHASE 1 of a song video (see worker.ts's "song" job / handleSong()):
 *  theme/mood prompt -> lyrics -> real sung song. Writes lyrics.json (the
 *  structured lyrics, editable/regenerable in the "song_review" UI screen —
 *  same review-before-spending-more pattern as breakdown_review) and
 *  song.json (the real generated audio's URL/duration/section timing).
 *  Idempotent by file presence, same discipline as every other step here —
 *  a re-run after a worker crash doesn't re-pay for a song already made. */
export async function runSong(theme: string, targetLengthSec: number): Promise<SongData> {
  const out = `${runtime.outDir}/song.json`;
  if (await fileExists(out)) {
    return readJsonOr<SongData>(out, undefined as any);
  }

  const lyrics = await generateLyrics(theme, targetLengthSec);
  console.log(`✅ Lyrics written: "${lyrics.title}" — ${lyrics.sections.length} section(s).`);

  const audioPath = `${runtime.outDir}/song.mp3`;
  const song = await generateSong(lyrics, audioPath);
  console.log(`✅ Song generated — ${song.durationSec.toFixed(1)}s, ${song.sections.length} section(s) timed.`);

  const data: SongData = { lyrics, song };
  await writeJson(out, data);
  return data;
}

if (isMain(import.meta.url)) {
  runSong("a bittersweet farewell to a childhood hometown before moving away for good", 90).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
