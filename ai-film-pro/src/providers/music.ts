import { fal } from "../falClient";
import { config } from "../config";
import { withTimeout } from "../util";

// fal.subscribe() has no built-in timeout — see util.ts's withTimeout().
const MUSIC_TIMEOUT_MS = 5 * 60_000;

/**
 * CASSETTEAI MUSIC GENERATOR (via fal.ai) — one instrumental score bed per
 * finished film, sized to its own runtime and mixed in under its existing
 * dialogue/ambience track (see 6-assemble.ts's finishFilm()).
 *
 * Endpoint and I/O shape confirmed against fal's own OpenAPI schema,
 * fetched directly (https://fal.ai/api/openapi/queue/openapi.json?
 * endpoint_id=cassetteai/music-generator — the docs page itself 429'd, same
 * rate-limit upscale.ts's own comment already documents hitting; the raw
 * schema endpoint was not) — NOT yet confirmed via a live test call the way
 * upscale.ts's Topaz integration was. See config.musicEnabled's own comment
 * for why this defaults off until that first real call happens.
 *   - Input: { prompt: string, duration: number }. duration is DOCUMENTED
 *     10-180 seconds (clamped below); no separate instrumental/vocal toggle
 *     exists in the schema — instrumental output is a property of the model
 *     itself (confirmed via fal's own blog post announcing it: "instrumental
 *     compositions... jazz to rock, hip-hop, EDM, and Lofi," explicitly
 *     listed for "background music for product demonstration video" and
 *     "custom soundtracks," not vocal songs) — the prompt below still asks
 *     explicitly for no vocals as a second layer of insurance, matching this
 *     codebase's own habit of stating a constraint even when the model
 *     "shouldn't" need it (see negativeFor() in compiler.ts).
 *   - Output: { audio_file: { url, file_name, content_type, file_size } }.
 *   - Pricing: $0.02 per output MINUTE (fal's own pricing page) — negligible
 *     next to this pipeline's image/video spend; a 40s film's score costs
 *     roughly $0.013.
 */

const MIN_DURATION_SEC = 10;
const MAX_DURATION_SEC = 180;

/**
 * Mood phrase per color-grade filter (see director/COLOR_PALETTES.json).
 * Keyed by the FFMPEG FILTER STRING already stored on breakdown.
 * colorGradeFilter — not a separate lookup keyed by the palette's own `key`,
 * so this needs no schema change to Breakdown. Every palette's filter string
 * in that file is unique (confirmed by reading the whole file, including
 * "" for naturalistic_neutral, which is also this map's fallback below). A
 * filter string that doesn't match anything here (a manually edited
 * COLOR_PALETTES.json, or a project compiled before some future palette
 * entry is added) falls through to the generic default rather than
 * throwing — a missing mood hint is a minor quality miss, never a crash.
 */
const MOOD_BY_GRADE_FILTER: Record<string, string> = {
  "colorbalance=rm=0.08:bm=-0.06:rs=-0.03:bs=0.05,eq=contrast=1.04:saturation=1.05":
    "warm, gentle acoustic instrumental with soft strings and light piano, nostalgic and inviting",
  "colorbalance=bs=0.07:bm=0.04:rs=-0.05:rm=-0.03,eq=contrast=1.08:saturation=0.82:brightness=-0.015":
    "tense, minimal instrumental score, low sustained strings and a subtle pulsing bass, quiet dread building",
  "eq=contrast=1.15:saturation=0.55:brightness=-0.02:gamma=0.95":
    "moody jazz-noir instrumental, soft muted trumpet and brushed drums, late-night and mysterious",
  "eq=contrast=1.07:saturation=1.25:brightness=0.005":
    "upbeat, bright instrumental, playful rhythm and light percussion, joyful and energetic",
  "colorbalance=rm=0.05:gm=0.02:bm=-0.04:rs=0.02,eq=contrast=0.97:saturation=0.92:brightness=0.01":
    "tender romantic instrumental, soft piano and warm strings, gentle and intimate",
  "colorbalance=gm=0.06:gs=0.04:rm=-0.03:bm=-0.02,eq=contrast=1.1:saturation=0.65:brightness=-0.02:gamma=0.93":
    "unsettling ambient instrumental score, dissonant low drones and sparse tones, quiet dread",
  "colorbalance=bm=0.08:bs=0.05:gm=0.02:rm=-0.05,eq=contrast=1.1:saturation=0.9:brightness=0.0":
    "cool, minimal electronic instrumental, subtle synth pads and a steady pulse, futuristic and clean",
  "colorbalance=rm=0.07:rs=0.03:bm=-0.05,eq=contrast=0.95:saturation=0.85:brightness=0.02:gamma=1.05":
    "sparse, sun-baked instrumental with light acoustic guitar and slow percussion, wide open and dusty",
  "colorbalance=bm=0.09:gm=0.04:rm=-0.07:rs=-0.04,eq=contrast=1.02:saturation=0.95:brightness=-0.01":
    "slow, ambient instrumental with soft sustained pads and gentle shimmer, weightless and calm",
  "colorbalance=rm=0.09:rs=0.03:bm=-0.05:gm=0.01,eq=contrast=1.05:saturation=1.1:brightness=0.0":
    "warm folk instrumental, acoustic guitar and soft strings, earthy and reflective",
  "colorbalance=bm=0.06:bs=0.04:rm=-0.04,eq=contrast=1.08:saturation=0.8:brightness=0.01:gamma=1.02":
    "sparse, cold instrumental with soft bells and slow strings, quiet and crisp",
  "colorbalance=rm=0.1:gm=0.03:bm=-0.08:bs=-0.05,eq=contrast=1.03:saturation=0.5:brightness=0.0:gamma=0.98":
    "gentle vintage instrumental, warm acoustic piano and soft strings, old-fashioned and wistful",
  "eq=contrast=0.93:saturation=0.8:brightness=0.02:gamma=1.03":
    "hazy, dreamlike ambient instrumental, soft reverberant piano and airy pads, floating and soft",
  "colorbalance=bm=0.05:gm=-0.02:rm=-0.03,eq=contrast=1.06:saturation=0.85:brightness=0.0":
    "clean, minimal instrumental, subtle piano and light electronic pulse, professional and understated",
  "": "gentle cinematic instrumental score, subtle piano and soft strings, understated and natural",
};

function moodFor(colorGradeFilter: string): string {
  return MOOD_BY_GRADE_FILTER[colorGradeFilter] ?? MOOD_BY_GRADE_FILTER[""];
}

export interface MusicResult {
  url: string;
  /** Real duration ACTUALLY requested (post-clamp) — the source of truth
   *  for the caller's fade-out timing, not the raw film length. */
  durationSec: number;
}

/** Generates one instrumental score bed. `title`/`colorGradeFilter` come
 *  straight off the finished breakdown — no extra LLM call needed to derive
 *  a mood, reusing the color-palette decision compileBreakdown() already
 *  made once. `filmDurationSec` is the ACTUAL assembled film's length (see
 *  6-assemble.ts, probed via probeDurationSec on the real finished file, not
 *  the planned/estimated length) — clamped into the model's documented
 *  10-180s range; 6-assemble.ts's mixing pass handles a film outside that
 *  range by truncating or silence-padding the bed (see mixMusicBed()'s own
 *  comment in util.ts), not by failing. */
export async function generateMusicBed(
  title: string,
  colorGradeFilter: string,
  filmDurationSec: number,
): Promise<MusicResult> {
  const duration = Math.min(MAX_DURATION_SEC, Math.max(MIN_DURATION_SEC, Math.round(filmDurationSec)));
  const mood = moodFor(colorGradeFilter);
  const prompt =
    `Instrumental cinematic film score for "${title}". Mood: ${mood}. ` +
    `No vocals, no lyrics, no words sung or spoken — instrumental only.`;
  const input = { prompt, duration };
  try {
    const r: any = await withTimeout(fal.subscribe(config.musicModel, { input }), MUSIC_TIMEOUT_MS, "music generation");
    const url = r?.data?.audio_file?.url;
    if (typeof url !== "string" || !url) {
      throw new Error(`Unexpected response shape from ${config.musicModel}: ${JSON.stringify(r?.data ?? r).slice(0, 500)}`);
    }
    return { url, durationSec: duration };
  } catch (e: any) {
    console.error(`\n❌ Music generation (${config.musicModel}) rejected the request. Actual reason:`);
    console.error(JSON.stringify(e?.body ?? e?.response?.data ?? e?.message ?? e, null, 2));
    throw e;
  }
}
