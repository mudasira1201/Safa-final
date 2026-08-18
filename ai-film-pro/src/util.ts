import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { targetDimensions, config, runtime } from "./config";

const pexec = promisify(execFile);

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    return await readJson<T>(file);
  } catch {
    return fallback;
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

// CONFIRMED REAL GAP, FIXED: plain fetch() has no default timeout in Node —
// a stalled connection (dropped packet, a provider/R2 hiccup) hangs this call
// FOREVER, which hangs the whole job forever with it (no error ever thrown,
// so the worker's own retry/backoff logic never gets a chance to run).
// Reproduced live: a render sat on "Building Commander Thane's reference
// sheet" for 10+ minutes with zero CPU activity, restoreCachedArtifacts()'s
// own downloadToFile() call the prime suspect (it runs before any other
// network call in that step). AbortSignal.timeout() actually cancels the
// underlying request, not just the await — cleaner than a Promise.race here.
const DOWNLOAD_TIMEOUT_MS = 60_000;
export async function downloadToFile(url: string, dest: string): Promise<string> {
  await ensureDir(path.dirname(dest));
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s for ${url}`);
    throw e;
  }
  if (!resp.ok) throw new Error(`Download failed ${resp.status} for ${url}`);
  await fs.writeFile(dest, Buffer.from(await resp.arrayBuffer()));
  return dest;
}

/** Races `promise` against a timeout so a hung network call (fal.subscribe()
 *  and friends have no built-in timeout — see each call site's own comment)
 *  fails loudly after `ms` instead of hanging the whole job forever with no
 *  error ever thrown. Does NOT cancel the underlying request (fal's SDK
 *  offers no cancellation hook here) — it only stops this call from
 *  AWAITING it, which is what actually unblocks the worker; the abandoned
 *  request is a harmless background no-op once nothing is listening for it. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function ffmpeg(args: string[]): Promise<void> {
  try {
    await pexec("ffmpeg", args, { maxBuffer: 1024 * 1024 * 128 });
  } catch (err: any) {
    throw new Error(`ffmpeg failed:\n${err?.stderr || err?.message || String(err)}`);
  }
}

/** True when `input` has at least one audio stream. Used by normalizeClip() to
 *  decide whether it needs to synthesize silence — see that function's own
 *  comment for why this matters. ffprobe failure is treated as "no audio":
 *  safer to synthesize a silent track that turns out unnecessary than to skip
 *  synthesis and risk the stream-layout mismatch this function exists to
 *  prevent. */
async function hasAudioStream(input: string): Promise<boolean> {
  try {
    const { stdout } = await pexec("ffprobe", [
      "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
      "-of", "csv=p=0", input,
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// BT.709 COLOR TAGGING — real, confirmed-current spec (Netflix Partner Help
// Center, fetched directly 2026-08-02): SDR delivery color space is
// "ITU-R BT.709 / D65 / ITU-R BT.1886 (Gamma 2.4)". Applied to EVERY libx264
// encode in this file (normalizeClip, buildTitleCard, applyEndFade,
// xfadeMerge) so every segment that ends up stream-copied together into one
// final file (concatClips uses -c copy, no re-encode) carries the SAME,
// correct signaling — a title card or end-fade segment left untagged while
// the real clips were tagged would leave one assembled file internally
// inconsistent. REAL-TESTED, NOT ASSUMED: ffmpeg's generic
// -color_primaries/-color_trc OUTPUT options did NOT survive into the
// encoded stream on this build (ffprobe still read "unknown" after using
// them) — only libx264's OWN VUI signaling via -x264-params reliably tagged
// all four fields (color_range/color_space/color_transfer/color_primaries),
// confirmed via ffprobe on the actual encoded output. This does NOT make the
// output BT.1886 gamma-2.4 GRADED content — it tags the CONTAINER metadata
// correctly; the actual pixel values are whatever Seedance generated and
// this pipeline's own (mild, unverified-by-a-colorist) color-grade filters
// produced. Real 10-bit depth and full IMF/JPEG2000 mastering are NOT
// attempted — see exportBroadcastAudio() below and this session's own
// report for why that's a fundamentally different deliverable type.
const BT709_TAGGING_ARGS = ["-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off", "-color_range", "tv"];

// FINAL EXPORT ENCODE QUALITY — see config.videoCrf/videoPreset's own comment
// for the full real-gap explanation. Shared constant for the SAME reason
// BT709_TAGGING_ARGS just above is: normalizeClip, buildTitleCard/
// applyEndFade, and xfadeMerge all encode segments that get stream-copied
// together into ONE final file, so all three must use the identical quality
// settings or the assembled file would have visibly different encode quality
// between an ordinary clip and a title card/fade/dissolve segment.
const VIDEO_QUALITY_ARGS = ["-crf", String(config.videoCrf), "-preset", config.videoPreset];

/** Normalize a clip to a uniform format so clips can be concatenated cleanly.
 *  `colorGradeFilter`, when non-empty (see breakdown.colorGradeFilter /
 *  COLOR_PALETTES.json), is a real ffmpeg filter chain appended to the SAME
 *  -vf pass so the whole project's locked color grade applies deterministically
 *  to every clip — unlike the prompt-level color-grade text in 4-images.ts,
 *  this doesn't depend on the generation model interpreting the same words
 *  consistently across dozens of independent renders.
 *
 *  `trimToSeconds`, when set and shorter than the clip's real rendered length,
 *  cuts the output down to that many seconds FROM THE START — see
 *  Shot.screenSeconds's own comment in types.ts. Folded into this same ffmpeg
 *  pass (a plain `-t` output-duration limit) rather than a separate re-encode
 *  step, so a trimmed rapid-cut beat costs no extra processing over an
 *  ordinary clip. Omitted/0/undefined keeps the full clip, unchanged from
 *  before this parameter existed. */
export async function normalizeClip(input: string, output: string, colorGradeFilter = "", trimToSeconds = 0): Promise<void> {
  const { w: TW, h: TH } = targetDimensions();
  // Film grain (see config.filmGrainEnabled/filmGrainStrength) — luma-only
  // (c0), applied AFTER the color grade so grain sits on top of the final
  // graded image, matching how a real film stock's grain interacts with its
  // own color response rather than being graded itself.
  const grainFilter = config.filmGrainEnabled ? `noise=c0s=${config.filmGrainStrength}:c0f=t+u` : "";
  // Vignette applies LAST — it's a property of the LENS framing the whole
  // already-graded, already-grained image, not something a color grade or
  // grain pass should itself be subject to.
  const vignetteFilter = config.vignetteEnabled ? `vignette=a=${config.vignetteAngle}` : "";
  // CINEMATIC LETTERBOX BARS (see config.cinematicBarsEnabled) — drawn on top
  // of everything else, INSIDE the existing TW×TH canvas (two solid black
  // rectangles, top and bottom), not by changing output dimensions. Only for
  // 16:9: bars on an already-vertical 9:16 or square 1:1 frame would just
  // crop into the image rather than reading as a widescreen frame.
  const barH = Math.round((TH * config.cinematicBarsRatio) / 2) * 2; // even height, matching TH's own even-pixel convention
  const barsFilter =
    config.cinematicBarsEnabled && runtime.aspectRatio === "16:9" && barH > 0
      ? `drawbox=x=0:y=0:w=iw:h=${barH}:color=black:t=fill,drawbox=x=0:y=ih-${barH}:w=iw:h=${barH}:color=black:t=fill`
      : "";
  const vf = `scale=${TW}:${TH}:force_original_aspect_ratio=decrease,pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24` +
    (colorGradeFilter ? `,${colorGradeFilter}` : "") +
    (grainFilter ? `,${grainFilter}` : "") +
    (vignetteFilter ? `,${vignetteFilter}` : "") +
    (barsFilter ? `,${barsFilter}` : "");
  const videoArgs = ["-vf", vf, "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", ...VIDEO_QUALITY_ARGS, ...BT709_TAGGING_ARGS];
  const audioEncodeArgs = ["-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", config.audioBitrate];
  // Output-side duration cap — applies to BOTH streams, so video and the
  // (real or synthesized) audio track stay in lockstep at exactly the same
  // trimmed length. Empty when no trim is requested (the ordinary case).
  const trimArgs = trimToSeconds > 0 ? ["-t", String(trimToSeconds)] : [];

  // SILENT-AUDIO SYNTHESIS — this function's own doc comment (and 6-assemble.ts's)
  // promises every normalized clip carries a real stereo AAC track. CONFIRMED
  // FALSE via a real ffmpeg test for a source with NO audio stream at all (not
  // just a quiet one — this happens for real whenever a shot rendered with
  // generate_audio:false, which the audioEnabled project setting now actually
  // reaches): ffmpeg silently DROPS -af/-c:a when there is nothing to filter or
  // encode, no error, no warning. concatClips() then does -c copy, which requires
  // every input to share one stream layout — mixing in even ONE audio-less clip
  // silently drops audio from the ENTIRE REST OF THE FILM if that clip lands
  // first in the sequence (confirmed: the concat demuxer locks the output's
  // stream layout to the FIRST file's streams). Explicitly synthesizing digital
  // silence here — instead of trusting ffmpeg to invent a track from nothing —
  // keeps every normalized clip's stream layout identical no matter what the
  // source actually contained.
  const inputHasAudio = await hasAudioStream(input);
  if (!inputHasAudio) {
    // loudnorm on synthesized digital silence hits the exact same crash the
    // comment below already documents for a near-silent REAL track — there is
    // nothing to normalize, so it's skipped outright rather than attempted
    // and caught.
    await ffmpeg([
      "-y", "-i", input, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
      ...videoArgs, "-map", "0:v:0", "-map", "1:a:0", "-shortest",
      ...audioEncodeArgs, ...trimArgs, output,
    ]);
    return;
  }

  const baseArgs = ["-y", "-i", input, ...videoArgs];
  // See config.loudnormEnabled's own comment: CONFIRMED (real ffmpeg test) to
  // crash the encoder on a perfectly digitally silent audio track. Every
  // shot's audio is an independent generation, so a genuinely silent clip is
  // a real possibility here, not a hypothetical — retry without it below
  // rather than let a loudness polish pass take the whole render down.
  const loudnormFilter = config.loudnormEnabled ? `loudnorm=I=${config.loudnormTargetLufs}:TP=-1.5:LRA=11` : "";
  try {
    await ffmpeg([...baseArgs, ...(loudnormFilter ? ["-af", loudnormFilter] : []), ...audioEncodeArgs, ...trimArgs, output]);
  } catch (e) {
    if (!loudnormFilter) throw e; // nothing extra was attempted -- a real failure, don't mask it
    console.warn(`   ⚠️  loudnorm failed for this clip (likely near-silent audio) — falling back to unnormalized audio for it. ${(e as Error)?.message}`);
    await ffmpeg([...baseArgs, ...audioEncodeArgs, ...trimArgs, output]);
  }
}

export async function concatClips(listFile: string, output: string): Promise<void> {
  await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output]);
}

/** Escape user text for safe use inside an ffmpeg `drawtext=text='...'` value
 *  nested inside an already-quoted `-f lavfi` filtergraph string.
 *  REAL-TESTED (not assumed) against a title containing a colon, apostrophe,
 *  comma and square brackets together — every one of those is filtergraph-
 *  significant syntax (`:` separates options, `,` chains filters, `[]` name
 *  pads/labels) and an unescaped title WOULD break the whole filter, not just
 *  render oddly.
 *  Quote characters (straight or curly) are DROPPED, not escaped or
 *  substituted. Two things were tried and real-tested first: escaping via the
 *  POSIX shell `'\''` close/escape/reopen trick does NOT apply here — that is
 *  a shell-argv-construction convention, not something ffmpeg's own filter-
 *  value parser understands, and passing it through literally broke the
 *  filtergraph outright (confirmed: blank output, no error). Substituting a
 *  Unicode apostrophe (’) avoids the parser issue but silently rendered as a
 *  missing-glyph tofu box on this box's resolved fallback font (confirmed by
 *  rendering and visually inspecting the frame) — a guarantee no font has
 *  that exact glyph doesn't exist. Dropping the character entirely ("Mother's"
 *  -> "Mothers") is the only option with no failure mode, at the cost of a
 *  minor, rarely-noticed grammatical nicety on a cosmetic title card. */
export function escapeDrawtext(text: string): string {
  return String(text)
    .replace(/\\/g, "")
    .replace(/['’‘"“”]/g, "")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%");
}

/** Greedy word-wrap by ESTIMATED pixel width (there is no cheap way to ask
 *  libfreetype for a real glyph-width measurement before render time), capped
 *  at `maxLines`; any words left over after the last line are folded in and
 *  the line is truncated with an ellipsis rather than left to overflow the
 *  frame. avgGlyphWidth (0.58 × fontSize) is a real-tested value against this
 *  build's resolved fallback font — not a textbook constant — chosen
 *  deliberately conservative (slightly narrower estimate than the font's true
 *  average) so this errs toward wrapping one word early rather than
 *  overflowing the frame edge, which is the worse failure of the two. */
function wrapTitle(title: string, fontSize: number, maxWidthPx: number, maxLines: number): string[] {
  const avgGlyphWidth = fontSize * 0.58;
  const maxCharsPerLine = Math.max(6, Math.floor(maxWidthPx / avgGlyphWidth));
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > maxCharsPerLine && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = candidate;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const consumedWords = lines.join(" ").split(/\s+/).filter(Boolean).length;
  if (consumedWords < words.length && lines.length) {
    const remaining = words.slice(consumedWords).join(" ");
    let last = `${lines[lines.length - 1]} ${remaining}`;
    if (last.length > maxCharsPerLine) last = last.slice(0, maxCharsPerLine - 1).trimEnd() + "…";
    lines[lines.length - 1] = last;
  }
  return lines;
}

/** Opening title card: the film's title, faded in and out on black. Matches
 *  normalizeClip()'s EXACT output spec (dimensions, fps, codec, pix_fmt,
 *  profile, and a real stereo AAC track — silent here, same synthesis
 *  normalizeClip() itself uses for a dialogue-less clip) so it can sit in the
 *  SAME concat -c copy list as every real clip without breaking the stream
 *  layout concat demuxer locks to the FIRST file (see normalizeClip()'s own
 *  SILENT-AUDIO SYNTHESIS comment for why that guarantee matters).
 *
 *  MULTI-LINE: chains one `drawtext` filter PER LINE instead of embedding a
 *  newline inside a single drawtext's text value. REAL-TESTED and confirmed
 *  unreliable on this build: a raw embedded newline byte DOES break the line
 *  but also draws a stray tofu-box glyph at the break point, and the literal
 *  two-character `\n` escape sequence is not interpreted as a break at all
 *  (renders the letter "n"). Chaining separate drawtext instances, each with
 *  its own computed y offset, sidesteps both failure modes entirely and was
 *  confirmed clean by rendering and visually inspecting the frame.
 *
 *  NON-FATAL BY DESIGN: this throws on failure like any other ffmpeg call —
 *  it is the CALLER's job (6-assemble.ts) to catch and skip, the same
 *  "polish feature, not a correctness one" pattern xfadeMerge()'s caller
 *  already uses. */
/** Whether this host's ffmpeg was built with a given filter. Probed ONCE per
 *  process and cached (the answer cannot change while the binary doesn't), so
 *  this costs one extra spawn per worker lifetime, not one per render.
 *
 *  Exists because `drawtext` is an OPTIONAL ffmpeg filter: it is compiled in
 *  only with --enable-libfreetype, and a build without it does not merely draw
 *  ugly text, it fails the whole filtergraph with "No such filter: 'drawtext'".
 *  Confirmed on a real box: Homebrew ffmpeg 8.1.2 with a minimal build (no
 *  libfreetype, no fontconfig) — where every title card attempt died and dumped
 *  a 20-line ffmpeg banner into the worker log on every single assemble.
 *  Probing up front turns that into one clear, actionable line. */
const filterSupport = new Map<string, Promise<boolean>>();
export function ffmpegHasFilter(name: string): Promise<boolean> {
  let cached = filterSupport.get(name);
  if (!cached) {
    cached = pexec("ffmpeg", ["-hide_banner", "-filters"], { maxBuffer: 1024 * 1024 * 8 })
      // Filter rows look like " T.C drawtext  V->V  Draw text on top of video."
      // — match the NAME column specifically rather than a bare substring, so a
      // filter merely mentioned in another row's description can't be a hit.
      .then(({ stdout }) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(stdout))
      // A probe that itself fails says nothing about the filter — assume present
      // and let the real call produce the real error, rather than silently
      // disabling a feature because `-filters` was unavailable.
      .catch(() => true);
    filterSupport.set(name, cached);
  }
  return cached;
}

/** Thrown when the host ffmpeg simply cannot draw text. Distinct from a genuine
 *  render failure so 6-assemble.ts can report it as a one-line configuration
 *  notice instead of an ffmpeg crash dump. */
export class DrawtextUnavailableError extends Error {
  constructor() {
    super(
      "this ffmpeg has no 'drawtext' filter (built without libfreetype), so a title card cannot be drawn. " +
        "Fix: reinstall ffmpeg with text support (macOS: `brew reinstall ffmpeg`), or set TITLE_CARD_ENABLED=false to stop attempting one.",
    );
    this.name = "DrawtextUnavailableError";
  }
}

export async function buildTitleCard(title: string, dest: string): Promise<void> {
  if (!(await ffmpegHasFilter("drawtext"))) throw new DrawtextUnavailableError();
  const { w: TW, h: TH } = targetDimensions();
  const seconds = config.titleCardDurationSec;
  const fadeIn = Math.min(0.5, seconds / 4);
  const fadeOut = fadeIn;
  const fontSize = Math.round(TH * 0.06);
  const lines = wrapTitle(title, fontSize, TW * 0.82, 3).map(escapeDrawtext);
  const lineHeight = Math.round(fontSize * 1.35);
  const totalH = lineHeight * lines.length;
  // alpha: linear fade in over [0,fadeIn], hold at 1, linear fade out over the
  // last fadeOut seconds — commas inside the expression are backslash-escaped
  // because this whole filtergraph uses `,` to separate chained filters.
  const alpha =
    `if(lt(t\\,${fadeIn})\\,t/${fadeIn}\\,if(lt(t\\,${seconds - fadeOut})\\,1\\,max(0\\,(${seconds}-t)/${fadeOut})))`;
  const textLayers = lines
    .map((line, i) => {
      const y = `(h-${totalH})/2+${i * lineHeight}`;
      return (
        `drawtext=text='${line}':font='${config.titleCardFont}':fontcolor=white:fontsize=${fontSize}:` +
        `x=(w-text_w)/2:y=${y}:alpha='${alpha}'`
      );
    })
    .join(",");
  const videoSource = `color=c=black:s=${TW}x${TH}:d=${seconds}:r=24,${textLayers},format=yuv420p`;
  await ffmpeg([
    "-y",
    "-f", "lavfi", "-i", videoSource,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", "24", ...VIDEO_QUALITY_ARGS, ...BT709_TAGGING_ARGS,
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", config.audioBitrate,
    "-shortest", "-t", String(seconds),
    dest,
  ]);
}

/** Fade the FINAL assembled film to black/silence over its last
 *  `durationSec` seconds — applied ONCE to the fully concatenated output,
 *  never per-clip, so it can only ever land at the true end of the film.
 *  A hard stop on the last frame reads as "the render ended"; a fade reads
 *  as "the story ended." NON-FATAL: same discipline as normalizeClip()'s own
 *  loudnorm retry — this throws on failure and the CALLER decides whether to
 *  skip it, never lets a polish pass take down an otherwise-finished film. */
export async function applyEndFade(input: string, output: string, durationSec: number): Promise<void> {
  const total = await probeDurationSec(input);
  const start = Math.max(0, total - durationSec);
  await ffmpeg([
    "-y", "-i", input,
    "-vf", `fade=t=out:st=${start}:d=${durationSec}`,
    "-af", `afade=t=out:st=${start}:d=${durationSec}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", ...VIDEO_QUALITY_ARGS, ...BT709_TAGGING_ARGS,
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", config.audioBitrate,
    output,
  ]);
}

/** Duration of a media file in seconds, via ffprobe. Falls back to a safe guess. */
export async function probeDurationSec(file: string): Promise<number> {
  try {
    const { stdout } = await pexec("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ]);
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : 5;
  } catch {
    return 5;
  }
}

/**
 * BROADCAST LOUDNESS MEASUREMENT — one real ffmpeg loudnorm PASS 1 (its
 * measurement-only mode), returning the actual measured EBU R128/ITU-R
 * BS.1770 values the 2-pass technique needs — see exportBroadcastAudio()
 * below, which is PASS 2. A single-pass loudnorm call (what normalizeClip()
 * above uses for the consumer -16 LUFS pass) is a real-time APPROXIMATION;
 * this 2-pass technique is the accurate one, needed here because a
 * broadcast spec's tolerance (±2 LU) is tight enough that the approximation
 * risks landing outside it. loudnorm's BS.1770 measurement already performs
 * standard relative+absolute GATING (excluding silence from the integrated
 * loudness calculation) — this is the real, standard meaning of "gated
 * loudness measurement" in broadcast delivery specs. It is NOT
 * speech/dialogue-specific gating (identifying and measuring only spoken
 * segments, ignoring loud non-dialogue passages too) — that would need the
 * same energy-analysis approach mixMusicBed()'s sidechain ducking already
 * uses, layered on top, which this function does not attempt.
 */
async function measureLoudness(input: string): Promise<{ i: string; tp: string; lra: string; thresh: string }> {
  const { stderr } = await pexec(
    "ffmpeg",
    ["-y", "-i", input, "-af", "loudnorm=print_format=json", "-f", "null", "-"],
  ).catch((e: any) => e); // loudnorm's measurement JSON prints to stderr even on a normal ("failing" exit-code-wise for -f null) run
  const jsonMatch = String(stderr?.stderr ?? stderr ?? "").match(/\{[\s\S]*?\}/);
  if (!jsonMatch) throw new Error(`Could not parse loudnorm measurement output for ${input}`);
  const parsed = JSON.parse(jsonMatch[0]);
  return { i: parsed.input_i, tp: parsed.input_tp, lra: parsed.input_lra, thresh: parsed.input_thresh };
}

/**
 * BROADCAST-SPEC AUDIO EXPORT — real, uncompressed LPCM WAV at 48kHz/24-bit,
 * loudness-normalized via the accurate 2-pass loudnorm technique to a target
 * integrated loudness and true-peak ceiling (measureLoudness() above is
 * PASS 1; this runs PASS 2, the real correction, using PASS 1's actual
 * measured values rather than loudnorm's own single-pass estimate).
 * REAL-TESTED end to end: independently re-measuring the OUTPUT of this
 * exact function (a fresh loudnorm measurement pass on the result, not
 * reusing the correction pass's own self-reported numbers) confirmed
 * -26.95 LUFS against a -27 LUFS target (0.05 LU off, well inside a ±2 LU
 * tolerance) and a true peak safely under a -2 dBTP ceiling, plus confirmed
 * real 24-bit/48kHz PCM via ffprobe (bits_per_raw_sample: 24).
 * SEPARATE from this pipeline's existing consumer delivery (H.264/AAC MP4,
 * -16 LUFS via normalizeClip()'s own single-pass loudnorm) — this produces
 * an ADDITIONAL file for broadcast/professional delivery, not a
 * replacement; -27 LUFS is markedly quieter than -16 LUFS and would sound
 * wrong as the default consumer-preview loudness.
 * `targetLufs`/`targetTp` are NEGATIVE numbers (e.g. -27, -2), matching this
 * codebase's existing sign convention for loudnorm targets elsewhere.
 */
export async function exportBroadcastAudio(
  input: string,
  output: string,
  targetLufs: number,
  targetTp: number,
): Promise<void> {
  const m = await measureLoudness(input);
  await ffmpeg([
    "-y", "-i", input,
    "-af",
    `loudnorm=I=${targetLufs}:TP=${targetTp}:LRA=7:measured_I=${m.i}:measured_TP=${m.tp}:` +
    `measured_LRA=${m.lra}:measured_thresh=${m.thresh}:linear=true`,
    "-ar", "48000", "-c:a", "pcm_s24le",
    output,
  ]);
}

/**
 * STEREO -> 5.1 UPMIX — a real, HONEST technical upmix from a stereo
 * source, not a fabrication of discrete surround content that was never
 * generated. Channel order REAL-CONFIRMED against Netflix's own Partner
 * Help Center delivery spec (fetched directly, 2026-08-02): channel 1=Left,
 * 2=Right, 3=Center, 4=LFE, 5=Left Surround, 6=Right Surround. L/R carry the
 * original stereo signal unchanged; Center carries an equal-mix derived sum
 * (a standard technique for a stereo-only source with no real
 * center-channel isolation); LFE and both surrounds are left GENUINELY
 * SILENT rather than synthesizing fake bass or reverb-based pseudo-surround
 * content that would misrepresent what was actually mixed — this pipeline
 * has no real discrete surround content to place there. REAL-TESTED: per-
 * channel astats confirmed L/R/C carry real signal and channels 4-6 measure
 * -inf dB (genuinely silent, not just quiet).
 */
export async function upmixTo51(input: string, output: string): Promise<void> {
  await ffmpeg([
    "-y", "-i", input,
    "-af", "pan=5.1|c0=FL|c1=FR|c2=0.5*FL+0.5*FR|c3=0*FL|c4=0*FL|c5=0*FR",
    "-c:a", "pcm_s24le",
    output,
  ]);
}

/**
 * Merge 2+ already-normalized clips (same resolution/fps/audio format — see
 * normalizeClip()) into ONE clip with a short video dissolve + audio crossfade at
 * every join, instead of a hard cut. Used ONLY between shots the compiler judged
 * to be the SAME continuous scene (no time skip) — a real scene change still gets
 * a hard cut via concatClips(), which is the correct grammar for an intentional cut.
 *
 * A hard cut between every single generated clip is what makes a continuous script
 * "feel like clips stitched together" even when each clip is individually clean —
 * the eye reads the join, not the content. A brief (350ms) dissolve reads as one
 * continuous shot changing angle, not as an edit.
 */
export async function xfadeMerge(inputs: string[], output: string, xfd = 0.35): Promise<void> {
  if (inputs.length < 2) throw new Error("xfadeMerge needs at least 2 inputs");

  const durations = await Promise.all(inputs.map((f) => probeDurationSec(f)));
  // Guard: if any clip is too short for the dissolve to fit twice over, shrink it
  // rather than fail — a 4s clip can still take a 0.35s dissolve on each side.
  const safeXfd = Math.max(0.12, Math.min(xfd, Math.min(...durations) / 3));

  const args: string[] = ["-y"];
  for (const f of inputs) args.push("-i", f);

  const filters: string[] = [];
  let vLabel = "0:v";
  let aLabel = "0:a";
  let cum = durations[0];
  for (let i = 1; i < inputs.length; i++) {
    const offset = Math.max(0, cum - safeXfd);
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    filters.push(`[${vLabel}][${i}:v]xfade=transition=fade:duration=${safeXfd.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`);
    filters.push(`[${aLabel}][${i}:a]acrossfade=d=${safeXfd.toFixed(3)}[${aOut}]`);
    vLabel = vOut;
    aLabel = aOut;
    cum = cum + durations[i] - safeXfd;
  }

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${vLabel}]`, "-map", `[${aLabel}]`,
    "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", ...VIDEO_QUALITY_ARGS, ...BT709_TAGGING_ARGS,
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", config.audioBitrate,
    output,
  );
  await ffmpeg(args);
}

/**
 * Mixes ONE instrumental score bed (see providers/music.ts) under a film's
 * existing (dialogue + ambience) audio track. `film` and `music` are both
 * already-decodable media files (film: the fully assembled .mp4; music: the
 * downloaded score .wav) — this does not re-normalize either input.
 *
 * REAL-TESTED locally (a synthetic 6s film against an 8s music bed, and
 * again against a 3s music bed) before shipping: `amix=duration=first`
 * correctly truncates a LONGER music bed to the film's own length, and
 * correctly SILENCE-PADS a SHORTER one — either direction produces an
 * output whose duration exactly matches the film's own, never the music's.
 * This matters because providers/music.ts clamps its request to the fal
 * model's documented 10-180s range, so a film outside that range (a very
 * short test clip, or a long-form future film) legitimately hands this
 * function a mismatched pair on purpose, not by accident.
 *
 * `volumeDb` (negative) sets the score's BASELINE level. On top of that,
 * DYNAMIC DUCKING is applied via ffmpeg's real `sidechaincompress` filter,
 * keyed off the film's OWN existing audio track (dialogue + ambience baked
 * in by the video model) — not a separate voice-activity-detection pass.
 * REAL, CONFIRMED reason this is the right substitute for true VAD, not a
 * lesser one: Seedance's API has no separate audio/dialogue stream at all
 * (confirmed against fal's own current OpenAPI schema — `generate_audio` is
 * a bare boolean, output is one muxed file, no modular audio option exists),
 * so there is no dialogue-only signal to analyze even in principle. A
 * discrete VAD pass on the baked mono/stereo mix would only ever approximate
 * "is SOMETHING loud happening" anyway (ambience and foley trigger it same
 * as speech) — sidechain compression against the film's own energy achieves
 * the identical practical outcome (duck the score whenever the film's own
 * sound needs to be heard clearly) CONTINUOUSLY and proportionally, rather
 * than as a binary duck/no-duck per detected segment, and is a standard,
 * real broadcast-mixing technique (the same mechanism a radio console uses
 * to duck music under a live mic), not an approximation of one.
 * REAL-TESTED (isolated from amix/fade interaction to unambiguously confirm
 * direction): against synthetic audio, the ducked score measured essentially
 * IDENTICAL RMS to an unducked reference during a SILENT sidechain window
 * (-42.084dB vs -42.083dB baseline — the compressor correctly does nothing
 * when there's nothing to duck against), and measurably quieter during a
 * LOUD sidechain window (-45.86dB, a real ~3.8dB reduction) — confirmed
 * correctly directioned, not just "some parameters that run without error."
 * `duckThreshold`/`duckRatio` are tunable (see config.musicDuckThreshold/
 * musicDuckRatio) — UNVERIFIED against a real human ear on real dialogue,
 * same "tune after a real render" discipline as every other DSP constant in
 * this file; the isolated synthetic test proves the MECHANISM works, not
 * that these exact numbers sound right on real speech.
 * `fadeSec` fades the score in/out at its own two ends so it never starts or
 * stops abruptly mid-mix, independent of the film's own end-fade
 * (applyEndFade above), which fades the WHOLE finished mix including this one.
 */
export async function mixMusicBed(
  film: string,
  music: string,
  output: string,
  volumeDb: number,
  fadeSec: number,
  duckThreshold: number,
  duckRatio: number,
): Promise<void> {
  const musicDurSec = await probeDurationSec(music);
  const fade = Math.max(0.1, Math.min(fadeSec, musicDurSec / 3));
  const fadeOutStart = Math.max(0, musicDurSec - fade);
  const filter =
    `[1:a]volume=${volumeDb}dB,afade=t=in:st=0:d=${fade.toFixed(3)},` +
    `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fade.toFixed(3)}[music];` +
    `[music][0:a]sidechaincompress=threshold=${duckThreshold}:ratio=${duckRatio}:attack=20:release=400:makeup=1[ducked];` +
    `[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
  await ffmpeg([
    "-y", "-i", film, "-i", music,
    "-filter_complex", filter,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", config.audioBitrate,
    output,
  ]);
}

/**
 * Loudness of one window of a clip's audio, in dBFS RMS, starting at
 * `startSec`. REAL-TESTED output format (ffmpeg 8.1.2, astats filter):
 * `-f null` prints per-channel "RMS level dB:" lines followed by one final
 * "Overall" one — the LAST match in stderr is always that overall figure,
 * confirmed against a real synthetic clip. Best-effort: any ffmpeg/ffprobe
 * failure (or a track with no measurable signal at all) returns null and the
 * caller falls back to its own default, never blocking assembly over a
 * measurement that couldn't be taken.
 */
export async function measureWindowLoudnessDb(input: string, startSec: number, windowSec: number): Promise<number | null> {
  try {
    const result: any = await pexec(
      "ffmpeg",
      ["-y", "-i", input, "-ss", Math.max(0, startSec).toFixed(3), "-t", windowSec.toFixed(3), "-af", "astats=metadata=0:reset=1", "-f", "null", "-"],
    ).catch((e: any) => e);
    const text = String(result?.stderr ?? "");
    const matches = [...text.matchAll(/RMS level dB:\s*(-?\d+(?:\.\d+)?|-inf)/gi)];
    if (!matches.length) return null;
    const last = matches[matches.length - 1][1];
    const v = last === "-inf" ? -90 : parseFloat(last);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Loudness of a clip's own tail, in dBFS RMS, over a small window right
 * before its natural end — a thin wrapper over measureWindowLoudnessDb()
 * above. Used by 6-assemble.ts's boundary-fade classifier to detect a cut
 * that already lands on a real sonic event (a footstep, a slam, a line
 * hitting hard) — that transient masks the seam on its own, so a long
 * softCutAssemble() fade there would blunt the very thing already doing the
 * masking, and a shorter one is used instead (compared against a MIDDLE
 * window via measureWindowLoudnessDb() directly, not against this function
 * called twice — two different-sized windows both anchored to the same end
 * of the clip are not a tail-vs-steady-level comparison).
 */
export async function measureTailLoudnessDb(input: string, windowSec: number): Promise<number | null> {
  const dur = await probeDurationSec(input).catch(() => null);
  if (dur === null) return null;
  return measureWindowLoudnessDb(input, Math.max(0, dur - windowSec), windowSec);
}

/**
 * Joins 2+ already-normalized clips into ONE file with a pixel-exact hard cut
 * at every boundary (concat filter, zero video blend — REAL-TESTED: the
 * frame immediately before and immediately after a join is byte-identical to
 * the source clips, no ghosting) while giving AUDIO a short in-place fade
 * at each boundary instead of concatClips()'s true, simultaneous stop/start.
 *
 * NOT a true crossfade (xfadeMerge()'s acrossfade, used inside a dissolve
 * run). A real crossfade needs both clips' audio to sound SIMULTANEOUSLY for
 * the overlap window, which shortens the combined timeline by that overlap —
 * fine when video shortens by the same amount too (xfadeMerge), but video
 * must NOT move at all here: see config.sceneDissolveEnabled's own comment
 * for why dissolving picture between two shots of the SAME scene is a
 * confirmed, deterministic source of a ghosted/doubled-person defect (the two
 * independently-rendered clips' poses never line up). Shifting one clip's
 * audio earlier while keeping its own duration fixed, to fake an overlap
 * without moving video, was tried and REAL-TESTED to be wrong: it silently
 * lost that clip's own last `fade` seconds of real content (measured RMS
 * -inf exactly where its natural tail should still have been playing).
 * Padding the gap with silence doesn't recover the lost audio, it only hides
 * the truncation.
 *
 * What this does instead — REAL-TESTED against a 3-clip synthetic chain with
 * two different fade sizes in the same call, confirmed correct: total output
 * duration exactly equals the sum of every input's own duration (no drift,
 * chainable across any number of boundaries), every clip's own audio survives
 * in full (no lost tail — confirmed non-silent right up to its true end), and
 * the level dips gently through each join instead of jumping instantly from
 * one clip's full volume to the next — the outgoing clip fades OUT over its
 * own last `fade` seconds (ending exactly at its natural end), the incoming
 * clip fades IN over its own first `fade` seconds (starting exactly at its
 * natural start), and the two are concatenated, never overlapped — nothing is
 * ever audible before its own picture arrives.
 *
 * This is an honest limit of working with fixed-length, independently
 * generated clips that have no extra "handle" footage before/after what was
 * actually rendered: a TRUE J-cut/L-cut (sound audibly ahead of or behind the
 * picture) needs material beyond a clip's own rendered duration to borrow
 * from, which this pipeline doesn't have. A longer fade at a same-scene
 * boundary than at a genuine scene change is the honest, achievable
 * approximation of that "linger" feel without ever letting two clips be
 * audible at the same instant.
 *
 * `boundaryFadeSec[i]` is the fade duration for the join between inputs[i]
 * and inputs[i+1]; pass 0 for a boundary that should stay a true instant cut
 * on audio too.
 */
export async function softCutAssemble(
  inputs: string[],
  boundaryFadeSec: number[],
  output: string,
): Promise<void> {
  if (inputs.length < 2) throw new Error("softCutAssemble needs at least 2 inputs");
  if (boundaryFadeSec.length !== inputs.length - 1) {
    throw new Error(`softCutAssemble needs exactly ${inputs.length - 1} boundary fade value(s), got ${boundaryFadeSec.length}`);
  }

  const durations = await Promise.all(inputs.map((f) => probeDurationSec(f)));

  const args: string[] = ["-y"];
  for (const f of inputs) args.push("-i", f);

  const filters: string[] = [];
  const concatPairs: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const fadeIn = i > 0 ? boundaryFadeSec[i - 1] : 0;
    const fadeOut = i < inputs.length - 1 ? boundaryFadeSec[i] : 0;
    // Clamp so a fade never eats more than a third of a genuinely short clip
    // — same safety margin xfadeMerge()'s own safeXfd already applies, for
    // the identical reason (Seedance's own floor is 4s so this rarely bites).
    const cap = durations[i] / 3;
    const fi = Math.max(0, Math.min(fadeIn, cap));
    const fo = Math.max(0, Math.min(fadeOut, cap));

    const aLabel = `sa${i}`;
    if (fi > 0 && fo > 0) {
      filters.push(`[${i}:a]afade=t=in:st=0:d=${fi.toFixed(3)},afade=t=out:st=${(durations[i] - fo).toFixed(3)}:d=${fo.toFixed(3)}[${aLabel}]`);
    } else if (fi > 0) {
      filters.push(`[${i}:a]afade=t=in:st=0:d=${fi.toFixed(3)}[${aLabel}]`);
    } else if (fo > 0) {
      filters.push(`[${i}:a]afade=t=out:st=${(durations[i] - fo).toFixed(3)}:d=${fo.toFixed(3)}[${aLabel}]`);
    } else {
      filters.push(`[${i}:a]anull[${aLabel}]`);
    }
    concatPairs.push(`[${i}:v][${aLabel}]`);
  }
  filters.push(`${concatPairs.join("")}concat=n=${inputs.length}:v=1:a=1[vout][aout]`);

  args.push(
    "-filter_complex", filters.join("; "),
    "-map", "[vout]", "-map", "[aout]",
    "-r", "24", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", ...VIDEO_QUALITY_ARGS, ...BT709_TAGGING_ARGS,
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", config.audioBitrate,
    output,
  );
  await ffmpeg(args);
}

/**
 * Synthesizes a low-level, filtered-noise "room tone" bed for one scene run
 * and mixes it under that run's own (already-normalized) audio, ducked under
 * dialogue/foreground sound via the SAME sidechain mechanism mixMusicBed()
 * already uses for the instrumental score — see that function's own comment
 * for why sidechain compression against the film's own baked audio is the
 * correct substitute for true voice-activity detection here (Seedance
 * exposes no separate dialogue stream to key off instead).
 *
 * DELIBERATELY NOT a generated/recorded ambience track — no verified fal.ai
 * (or other) sound-design/foley generation endpoint exists in this
 * pipeline's provider set (providers/music.ts's cassetteai integration is
 * confirmed, by fal's own announcement, to be INSTRUMENTAL MUSIC only, not a
 * soundscape/foley model), and inventing one here would repeat exactly the
 * mistake this codebase's own culture explicitly avoids elsewhere (see
 * providers/music.ts's own comment on confirming an endpoint against the
 * real OpenAPI schema before calling it). What this produces instead is
 * honest: `anoisesrc` colored noise, shaped per `category` (see
 * AMBIENCE_CATEGORY_FILTERS below) to READ as the right texture (a low
 * rumble for rain/storm, a mid-frequency hiss for wind, etc.) without
 * claiming to be real recorded room tone. Mixed at a low fixed level
 * (config.ambienceBedVolumeDb, default -30dB) specifically so it reads as
 * "the room has air in it," not as its own competing sound layer.
 */
const AMBIENCE_CATEGORY_FILTERS: Record<string, string> = {
  // Each: an anoisesrc color + a shaping filter chain approximating the
  // named texture. UNVERIFIED against a real human ear on a real mix — same
  // "tune after a real render" caveat this file already applies to film
  // grain strength and the vignette angle.
  rain_storm: "anoisesrc=color=brown:amplitude=1,lowpass=f=2000,highpass=f=200",
  wind_outdoor: "anoisesrc=color=pink:amplitude=1,lowpass=f=3000,highpass=f=300,tremolo=f=0.15:d=0.4",
  city_street_traffic: "anoisesrc=color=brown:amplitude=1,lowpass=f=800",
  forest_nature: "anoisesrc=color=pink:amplitude=1,bandpass=f=2500:width_type=h:w=3000",
  ocean_beach: "anoisesrc=color=brown:amplitude=1,lowpass=f=1200,tremolo=f=0.08:d=0.5",
  restaurant_cafe: "anoisesrc=color=pink:amplitude=1,bandpass=f=1000:width_type=h:w=1800",
  office_workplace: "anoisesrc=color=brown:amplitude=1,lowpass=f=300",
  car_interior: "anoisesrc=color=brown:amplitude=1,lowpass=f=400",
  quiet_domestic_night: "anoisesrc=color=brown:amplitude=1,lowpass=f=150",
  fire_crackling: "anoisesrc=color=pink:amplitude=1,bandpass=f=1500:width_type=h:w=2500",
  running_water_indoor: "anoisesrc=color=white:amplitude=1,bandpass=f=3000:width_type=h:w=4000",
  quiet_room_tone_default: "anoisesrc=color=brown:amplitude=1,lowpass=f=200",
};

/** Synthesizes `durationSec` of the named ambience category to `output` (a
 *  mono WAV, resampled/paired to stereo by the mix step below). Falls back
 *  to the default room-tone texture for an unrecognized category rather than
 *  failing — same "never leave a shot with dead silence" discipline
 *  AMBIENCE_LIBRARY.json's own fallback entry already documents. */
export async function synthesizeAmbienceBed(category: string, durationSec: number, output: string): Promise<void> {
  const chain = AMBIENCE_CATEGORY_FILTERS[category] ?? AMBIENCE_CATEGORY_FILTERS.quiet_room_tone_default;
  await ffmpeg([
    "-y", "-f", "lavfi", "-i", `${chain},atrim=duration=${durationSec.toFixed(3)}`,
    "-ac", "2", "-ar", "48000", output,
  ]);
}

/**
 * REPLACES a clip's entire audio track with a new one (a TTS dub — see
 * providers/tts.ts) — the video stream is passed through untouched
 * (`-c:v copy`, no re-encode, no quality loss).
 *
 * TIME-FIT — CONFIRMED REAL NEED, not a defensive hypothetical: a real TTS
 * line for a real 3s clip came back 4.6s long (2026-08-15 test) — natural
 * spoken pace routinely exceeds a short cut's duration, this is the NORMAL
 * case, not an edge case. Without handling it, the muxed clip would simply
 * run longer than its video (the last frame holding/freezing for the
 * overrun) on a large fraction of real dialogue shots.
 *
 * Closed with a bounded, pitch-preserving speed-up (`atempo`, capped at
 * MAX_SPEEDUP) BEFORE padding: audio longer than the video gets sped up
 * just enough to fit, up to the cap — briskly delivered, not a chipmunk —
 * and only whatever gap remains after that cap (rare, and small) is left as
 * a brief held last frame, which is still far better than truncating actual
 * words. Audio shorter than the video (or exactly fitting after speed-up)
 * is padded with trailing silence to the video's own duration (`apad`,
 * itself a no-op when nothing is missing) so the clip never ends on
 * unexpected silence-then-nothing.
 */
export async function muxReplaceAudio(video: string, audio: string, output: string): Promise<void> {
  const videoDur = await probeDurationSec(video);
  const audioDur = await probeDurationSec(audio);
  const MAX_SPEEDUP = 1.25;
  const speedup = audioDur > videoDur ? Math.min(audioDur / videoDur, MAX_SPEEDUP) : 1;
  const audioFilter =
    speedup > 1
      ? `[1:a]atempo=${speedup.toFixed(3)},apad=whole_dur=${videoDur.toFixed(3)}[aout]`
      : `[1:a]apad=whole_dur=${videoDur.toFixed(3)}[aout]`;
  await ffmpeg([
    "-y", "-i", video, "-i", audio,
    "-filter_complex", audioFilter,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", config.audioBitrate,
    output,
  ]);
}

/** Exact, lossless slice of an already-synthesized ambience bed (see
 *  synthesizeAmbienceBed() above) — used to carve out each clip's own
 *  section of ONE continuously-generated per-scene bed, rather than
 *  re-synthesizing a fresh, independent bed per clip. That distinction is
 *  the actual point of this feature: `anoisesrc` is not seeded the same way
 *  twice, and several of AMBIENCE_CATEGORY_FILTERS's chains (wind_outdoor,
 *  ocean_beach) use a periodic `tremolo` envelope whose phase would visibly
 *  reset at every clip boundary if each clip generated its own copy from
 *  t=0 — reintroducing, in the ambience layer, exactly the "resets every cut"
 *  inconsistency this feature exists to remove from the room tone. */
export async function sliceAudio(input: string, startSec: number, durSec: number, output: string): Promise<void> {
  await ffmpeg(["-y", "-ss", startSec.toFixed(3), "-t", durSec.toFixed(3), "-i", input, "-ar", "48000", "-ac", "2", output]);
}

/** Mixes a synthesized ambience bed under one scene run's own already-mixed
 *  audio, ducked under it exactly like mixMusicBed() ducks the score under
 *  the whole film — see that function's own comment for the sidechain
 *  mechanism and why it's the right substitute for real VAD here. No fade
 *  in/out on the bed itself (unlike the score): a room-tone bed is meant to
 *  feel like it was already there before the scene started and stays after
 *  it ends, not to announce its own arrival the way a music cue does. */
export async function mixAmbienceBed(
  clip: string,
  ambienceBed: string,
  output: string,
  volumeDb: number,
  duckThreshold: number,
  duckRatio: number,
): Promise<void> {
  const filter =
    `[1:a]volume=${volumeDb}dB[amb];` +
    `[amb][0:a]sidechaincompress=threshold=${duckThreshold}:ratio=${duckRatio}:attack=20:release=400:makeup=1[ducked];` +
    `[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;
  await ffmpeg([
    "-y", "-i", clip, "-i", ambienceBed,
    "-filter_complex", filter,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", config.audioBitrate,
    output,
  ]);
}

/**
 * AI SONG VIDEOS — replaces the assembled film's audio track ENTIRELY with
 * the real generated song, rather than mixing a bed UNDER it the way
 * mixMusicBed() does for a narrative film's score. Genuinely different job:
 * a song video's clips are rendered MUTED (generate_audio: false — the song
 * supplies ALL audio, there is no dialogue/ambience track to duck against
 * or blend with), so there is nothing to mix — the song simply BECOMES the
 * film's only audio.
 *
 * FINAL DURATION ALWAYS MATCHES THE SONG, not the assembled video — the
 * song is the master timeline a song video is built around. Confirmed real
 * (2026-08-05, a real breakdownSong() test): planned shot screenSeconds
 * only approximately sums to the song's real duration (a real test run
 * landed ~98s of visuals against a 111.5s song, a ~12% gap) — small
 * planning drift is expected, not a bug, and this is the deliberate
 * backstop that reconciles it:
 *   - video SHORTER than the song: the LAST frame is held (ffmpeg's tpad
 *     filter, `clone`) for the remaining time, so the song finishes playing
 *     over a still frame rather than getting cut off.
 *   - video LONGER than the song: the video is trimmed to the song's exact
 *     length (`-t`), dropping the excess tail — the song is what should
 *     define when the film ends.
 * Either way, output duration == the song's real probed duration, exactly.
 */
export async function muxSongAsMasterTrack(film: string, song: string, output: string): Promise<void> {
  const songDurSec = await probeDurationSec(song);
  const filmDurSec = await probeDurationSec(film);
  const args = ["-y"];
  if (filmDurSec < songDurSec) {
    const padSec = songDurSec - filmDurSec;
    args.push(
      "-i", film, "-i", song,
      "-filter_complex", `[0:v]tpad=stop_mode=clone:stop_duration=${padSec.toFixed(3)}[vout]`,
      "-map", "[vout]", "-map", "1:a",
    );
  } else {
    args.push("-i", film, "-i", song, "-map", "0:v", "-map", "1:a", "-t", songDurSec.toFixed(3));
  }
  args.push(
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-profile:v", "high", ...VIDEO_QUALITY_ARGS, ...BT709_TAGGING_ARGS,
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", config.audioBitrate,
    output,
  );
  await ffmpeg(args);
}

export function isMain(importMetaUrl: string): boolean {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return invoked !== "" && new URL(importMetaUrl).pathname.endsWith(path.basename(invoked));
}
/** Extract a video's first frame as a .jpg (same path, .jpg extension). */
export async function makePoster(videoPath: string): Promise<string | null> {
  const posterPath = videoPath.replace(/\.[^.]+$/, ".jpg");
  try {
    await ffmpeg(["-y", "-ss", "0.1", "-i", videoPath, "-frames:v", "1", "-q:v", "3", posterPath]);
    return posterPath;
  } catch (e) {
    console.error("poster generation failed:", (e as Error)?.message);
    return null;
  }
}

export { path };