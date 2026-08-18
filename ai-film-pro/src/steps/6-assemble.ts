import { promises as fs } from "node:fs";
import * as path from "node:path";
import { config, runtime } from "../config";
import {
  readJson, readJsonOr, ensureDir, normalizeClip, concatClips, xfadeMerge, buildTitleCard, DrawtextUnavailableError,
  applyEndFade, mixMusicBed, muxSongAsMasterTrack, downloadToFile, probeDurationSec, exportBroadcastAudio, upmixTo51, isMain,
  softCutAssemble, measureTailLoudnessDb, measureWindowLoudnessDb, synthesizeAmbienceBed, mixAmbienceBed, sliceAudio,
} from "../util";
import { generateMusicBed } from "../providers/music";
import { costOfMusic, logSpend } from "../spend";
import { ambienceCategoryFor } from "../lib/compiler";
import type { ClipList } from "./5-videos";
import type { Breakdown, Shot } from "../types";

/**
 * ASSEMBLY — normalize (color grade, film grain, vignette, letterbox — see
 * normalizeClip()), join with a hard cut at real scene changes and a short
 * dissolve wherever one is actually earned (a same-scene angle change, or a
 * genuine time-skip — see shouldMerge() below), then a title card, an
 * instrumental score, and a closing fade.
 *
 * THIS USED TO DO A LOT MORE, AND THAT WAS THE PROBLEM. Voice generation and lip
 * sync ran here, at the very end, which meant the clips you reviewed were silent
 * and you could not judge a performance until the whole film was stitched.
 *
 * Audio lives with the clip: the video model renders speech, ambience and its own lip
 * sync directly into each clip (generate_audio), so by the time we get here
 * every clip already carries its own sound, perfectly aligned with its own
 * picture — and assembly's only job is to put them in order.
 *
 * This is more robust than mixing audio over a stitched film, which meant
 * computing each line's offset from the sum of the shot durations: one clip
 * coming back a fraction long pushed every later line out of sync. Audio baked
 * into its own clip cannot drift, because it moves with the picture.
 *
 * normalizeClip() guarantees every clip carries a stereo AAC track — silent for
 * shots with no dialogue — so the concat is uniform and never drops sound.
 *
 * WHY A DISSOLVE AT ALL: a hard cut between EVERY generated clip is what makes
 * a continuous scene "feel like clips stitched together" even when each clip
 * is individually clean — the eye reads the join itself, not the content
 * either side of it. Every clip in this pipeline is an independently
 * generated video, so there is no real continuous footage to cut between the
 * way a film editor would. TWO different, independently-toggled reasons earn
 * a dissolve instead — see shouldMerge()'s own comment for both — and a real
 * scene change that earns NEITHER still gets a clean hard cut, which is the
 * correct grammar for it.
 */

/** Same fuzzy "same place" test the compiler and step 4 use, duplicated locally
 *  (as they each already do) rather than adding a cross-module dependency for
 *  three lines of token-overlap logic. */
function sameScene(a: { scene?: string; setting?: string }, b: { scene?: string; setting?: string }): boolean {
  const sa = (a.scene || "").trim().toLowerCase();
  const sb = (b.scene || "").trim().toLowerCase();
  if (sa && sb && sa === sb) return true;
  const toks = (s: { scene?: string; setting?: string }) =>
    new Set((`${s.scene ?? ""} ${s.setting ?? ""}`).toLowerCase().match(/\b[a-z]{4,}\b/g) ?? []);
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / Math.min(A.size, B.size) >= 0.4;
}

/** Same day/night + explicit-time-skip-phrase signal compiler.ts's own
 *  TIME_OF_DAY_JUMP_NO_SKIP check already validates (see that check's own
 *  regexes) — duplicated locally rather than exporting compiler.ts internals
 *  across a module boundary, same reasoning as sameScene() above. Used by
 *  config.sceneTransitionDissolveEnabled (see that flag's own comment in
 *  config.ts) to decide which scene-change boundaries get a genuine
 *  passage-of-time dissolve instead of a hard cut. */
const DAY_SIGNAL = /\b(daylight|broad daylight|bright sun\w*|sunny|midday|noon|morning|afternoon)\b/i;
const NIGHT_SIGNAL = /\b(night|nighttime|midnight|moonlit|moonlight|pitch dark|streetlights?|starlit)\b/i;
const TIME_SKIP_PHRASE =
  /\b(later that (?:night|evening|day|morning|afternoon)|hours later|the next (?:day|morning|night)|by (?:nightfall|morning)|as (?:the sun|evening|night) (?:set|sets|fell|falls|falling)|meanwhile|some time later|a while later)\b/i;

function isGenuineTimeSkip(a: Shot | undefined, b: Shot | undefined): boolean {
  if (!a || !b) return false;
  const textA = `${a.setting ?? ""} ${a.description ?? ""} ${a.motion ?? ""}`;
  const textB = `${b.setting ?? ""} ${b.description ?? ""} ${b.motion ?? ""}`;
  const flips = (DAY_SIGNAL.test(textA) && NIGHT_SIGNAL.test(textB)) || (NIGHT_SIGNAL.test(textA) && DAY_SIGNAL.test(textB));
  const explicitSkip = TIME_SKIP_PHRASE.test(textA) || TIME_SKIP_PHRASE.test(textB);
  return flips || explicitSkip;
}

/** Extract the shot id this clip was rendered for, from its filename
 *  (`NN-<shotId>.mp4`, the naming worker.ts and step 5 both use). */
function shotIdFromClipPath(p: string): string | null {
  const m = path.basename(p).match(/^\d+-(.+)\.mp4$/);
  return m ? m[1] : null;
}

/** Shared tail end of both assembly paths (hard-cut and dissolve): prepend an
 *  opening title card (best-effort), concat, generate+mix an instrumental
 *  score (best-effort), then apply a closing fade (best-effort) LAST so it
 *  fades the whole finished mix — dialogue, ambience AND score together —
 *  to silence, not just the original track. Factored out so the "polish,
 *  never fail the render over it" handling lives in exactly one place
 *  instead of being duplicated — and risking drifting out of sync — across
 *  both branches below. */
async function finishFilm(
  clipPaths: string[],
  tmp: string,
  title: string | undefined,
  colorGradeFilter: string,
  spendCtx: { userId?: string; projectId?: string },
  songAudioUrl?: string,
): Promise<string> {
  let ordered = clipPaths;
  if (runtime.titleCardEnabled && title?.trim()) {
    const titleCardPath = path.join(tmp, "title_card.mp4");
    try {
      await buildTitleCard(title, titleCardPath);
      ordered = [path.resolve(titleCardPath), ...clipPaths];
      console.log("   🎬 Opening title card added.");
    } catch (e) {
      // Same philosophy as xfadeMerge()'s own caller below: a polish feature
      // failing must never take down an otherwise-finished film.
      //
      // A HOST THAT CANNOT DRAW TEXT AT ALL is a configuration fact, not a
      // render failure — it will be true for every film this box ever
      // assembles, so it gets one actionable line instead of an ffmpeg crash
      // dump repeated on every job. Everything else keeps the full message.
      if (e instanceof DrawtextUnavailableError) {
        console.warn(`   ⚠️  title card skipped — ${e.message}`);
      } else {
        console.warn(`   ⚠️  title card generation failed, skipping it: ${(e as Error)?.message}`);
      }
    }
  }

  const listFile = path.join(tmp, "concat.txt");
  await fs.writeFile(listFile, ordered.map((p) => `file '${path.resolve(p)}'`).join("\n"), "utf8");
  const finalPath = `${runtime.outDir}/final.mp4`;
  await concatClips(listFile, finalPath);

  // AI SONG VIDEOS — the real generated song REPLACES the film's (silent —
  // song-video clips render with generate_audio: false) audio track
  // entirely, via muxSongAsMasterTrack() (see that function's own comment
  // for why this is a replace, not a mix-under-a-bed like the instrumental
  // score path below). Mutually exclusive with that path: a song video has
  // no dialogue/ambience track to mix a SEPARATE score under, and no reason
  // to — the song IS the score. NOT a "polish feature" the way the
  // instrumental score is — a song video with no audio at all is a broken
  // deliverable, not a degraded one, so a failure here is NOT swallowed.
  if (songAudioUrl) {
    console.log(`   🎵 Muxing the real song as the film's master audio track...`);
    const songPath = path.join(tmp, "song_master.mp3");
    await downloadToFile(songAudioUrl, songPath);
    const muxedPath = path.join(tmp, "final_song.mp4");
    await muxSongAsMasterTrack(finalPath, songPath, muxedPath);
    await fs.copyFile(muxedPath, finalPath);
    console.log(`   🎵 Song muxed in — final duration matches the song exactly.`);
  } else if (config.musicEnabled && title?.trim()) {
    // INSTRUMENTAL SCORE — see config.musicEnabled's own comment for why this
    // defaults off (an unverified-by-live-call external endpoint) and
    // providers/music.ts / mixMusicBed()'s own comments for what IS verified
    // (the mixing mechanics, real-tested locally). Same "polish feature, never
    // take down an otherwise-finished film" discipline as the title card and
    // end fade around it — a failed music call or mix leaves the film exactly
    // as it would have been with MUSIC_ENABLED=false, never a thrown error.
    try {
      const filmDurationSec = await probeDurationSec(finalPath);
      console.log(`   🎵 Generating instrumental score (~${Math.round(filmDurationSec)}s)...`);
      const music = await generateMusicBed(title, colorGradeFilter, filmDurationSec);
      const musicPath = path.join(tmp, "score.wav");
      await downloadToFile(music.url, musicPath);
      const scoredPath = path.join(tmp, "final_scored.mp4");
      await mixMusicBed(
        finalPath, musicPath, scoredPath,
        config.musicVolumeDb, config.musicFadeSec,
        config.musicDuckThreshold, config.musicDuckRatio,
      );
      await fs.copyFile(scoredPath, finalPath);
      const amountUsd = costOfMusic(music.durationSec);
      await logSpend("music", { userId: spendCtx.userId, projectId: spendCtx.projectId, units: music.durationSec, amountUsd });
      console.log(`   🎵 Score mixed in (+$${amountUsd.toFixed(3)}).`);
    } catch (e) {
      console.warn(`   ⚠️  music generation/mix failed, keeping the film without a score: ${(e as Error)?.message}`);
    }
  }

  if (config.endFadeEnabled) {
    const fadedPath = path.join(tmp, "final_faded.mp4");
    try {
      await applyEndFade(finalPath, fadedPath, config.endFadeDurationSec);
      await fs.copyFile(fadedPath, finalPath);
      console.log("   🎬 Closing fade applied.");
    } catch (e) {
      console.warn(`   ⚠️  end fade failed, keeping the film without it: ${(e as Error)?.message}`);
    }
  }

  // BROADCAST-SPEC AUDIO EXPORT — see config.broadcastExportEnabled's own
  // comment and util.ts's exportBroadcastAudio()/upmixTo51() for the full
  // real-tested mechanism. Runs LAST, on the truly final mix (title card +
  // score + end fade all already applied) — an ADDITIONAL artifact beside
  // finalPath, never a replacement for it, so a failure here (best-effort,
  // same "polish feature" discipline as the title card/score/end fade
  // above) never affects the primary consumer deliverable.
  if (config.broadcastExportEnabled) {
    try {
      const broadcastWavPath = `${runtime.outDir}/final_broadcast.wav`;
      await exportBroadcastAudio(finalPath, broadcastWavPath, config.broadcastLoudnessLufs, config.broadcastTruePeakDb);
      console.log(`   📡 Broadcast-spec audio exported → ${path.resolve(broadcastWavPath)} (${config.broadcastLoudnessLufs} LUFS, ${config.broadcastTruePeakDb} dBTP, 24-bit/48kHz LPCM)`);
      if (config.broadcast51Enabled) {
        const upmixPath = `${runtime.outDir}/final_broadcast_5.1.wav`;
        await upmixTo51(broadcastWavPath, upmixPath);
        console.log(`   📡 5.1 upmix exported → ${path.resolve(upmixPath)} (technical upmix from stereo — see upmixTo51()'s own comment)`);
      }
    } catch (e) {
      console.warn(`   ⚠️  broadcast-spec audio export failed, consumer file is unaffected: ${(e as Error)?.message}`);
    }
  }

  console.log(`\n🎉 DONE → ${path.resolve(finalPath)}\n`);
  return finalPath;
}

export async function runAssemble(spendCtx: { userId?: string; projectId?: string } = {}): Promise<string> {
  const clips = await readJson<ClipList>(`${runtime.outDir}/clips.json`);
  if (clips.length === 0) throw new Error("No clips to assemble. Run step 5 first.");

  const tmp = `${runtime.outDir}/_normalized`;
  await ensureDir(tmp);

  // Best-effort scene lookup. If breakdown.json is not sitting in outDir (a
  // resumed job that only downloaded clips), we degrade to a plain hard-cut
  // concat — exactly the previous behaviour — rather than fail the render over
  // a nice-to-have transition.
  const breakdown = await readJsonOr<Breakdown | null>(`${runtime.outDir}/breakdown.json`, null);

  // AI SONG VIDEOS — see handleAssemble()'s own comment (worker.ts) for why
  // this file exists in outDir at all: written fresh, alongside breakdown.json,
  // for every assemble job whose project has project.songJson set. Absent
  // for every ordinary narrative film.
  const songData = await readJsonOr<{ song?: { url?: string } } | null>(`${runtime.outDir}/song.json`, null);
  const songAudioUrl = songData?.song?.url;

  // COLOR GRADE — see breakdown.colorGradeFilter / COLOR_PALETTES.json. Empty
  // for the naturalistic_neutral palette, or any project compiled before this
  // field existed — normalizeClip() already treats "" as a no-op.
  const colorGradeFilter = breakdown?.colorGradeFilter || "";
  const passes = [
    colorGradeFilter ? "color grade" : "",
    config.filmGrainEnabled ? "film grain" : "",
    config.vignetteEnabled ? "vignette" : "",
    config.loudnormEnabled ? "loudness normalization" : "",
  ].filter(Boolean);
  if (passes.length) {
    console.log(`🎨 Applying ${passes.join(" + ")} to every clip...`);
  }

  const shotById = new Map<string, Shot>();
  if (breakdown?.shots) {
    for (const s of breakdown.shots) shotById.set(s.id, s);
  }

  console.log("🔧 Normalizing clips to a uniform format...");
  const normalized: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const out = path.join(tmp, `norm_${String(i).padStart(2, "0")}.mp4`);
    const shotId = shotIdFromClipPath(clips[i]);
    const shot = shotId ? shotById.get(shotId) : undefined;
    // A genuine trim only — screenSeconds equals the full render duration for
    // every ordinary shot (see compileBreakdown()'s R5), so this is a no-op
    // for the overwhelming majority of clips and only fires for a real
    // rapid-cut beat (see Shot.screenSeconds's own comment in types.ts).
    const trimToSeconds = shot && shot.screenSeconds > 0 && shot.screenSeconds < shot.duration ? shot.screenSeconds : 0;
    if (trimToSeconds > 0) {
      console.log(`   ✂️  ${shotId}: trimming to ${trimToSeconds}s (rendered at ${shot!.duration}s for a rapid hard cut)`);
    }
    await normalizeClip(clips[i], out, colorGradeFilter, trimToSeconds);
    normalized.push(path.resolve(out));
  }

  const shotForIndex = (i: number): Shot | undefined => {
    const id = shotIdFromClipPath(clips[i]);
    return id ? shotById.get(id) : undefined;
  };

  // ── SCENE AMBIENCE BED (config.ambienceBedEnabled, default off) ─────────
  // A DIFFERENT grouping from the dissolve-eligibility `runs` built below:
  // this needs every CONTIGUOUS same-scene run of clips regardless of
  // whether config.sceneDissolveEnabled/sceneTransitionDissolveEnabled would
  // ever dissolve them (most same-scene boundaries never do, since
  // sceneDissolveEnabled defaults off) — a scene's room tone should stay
  // consistent whether or not its cuts also get a visual dissolve. Runs
  // BEFORE the dissolve-run/soft-cut logic below, on the untouched
  // `normalized` clips, and replaces each clip's entry in place with an
  // ambience-enhanced version — so everything downstream (dissolve runs,
  // soft-cut boundary fades) operates on the enhanced audio without knowing
  // this step happened at all.
  if (config.ambienceBedEnabled && breakdown?.shots) {
    console.log("🌫️  Mixing per-scene ambience beds...");
    const sceneGroups: number[][] = [];
    for (let i = 0; i < normalized.length; i++) {
      const prevGroup = sceneGroups[sceneGroups.length - 1];
      const a = shotForIndex(i);
      const b = prevGroup ? shotForIndex(prevGroup[prevGroup.length - 1]) : undefined;
      if (prevGroup && a && b && sameScene(a, b)) prevGroup.push(i);
      else sceneGroups.push([i]);
    }
    for (let g = 0; g < sceneGroups.length; g++) {
      const group = sceneGroups[g];
      const firstShot = shotForIndex(group[0]);
      if (!firstShot) continue; // no shot to key the ambience category off — skip, never fail the render over polish
      try {
        const durations = await Promise.all(group.map((i) => probeDurationSec(normalized[i])));
        const totalDur = durations.reduce((n, d) => n + d, 0);
        const category = ambienceCategoryFor(`${firstShot.setting ?? ""} ${firstShot.description ?? ""}`);
        const bedPath = path.join(tmp, `ambience_bed_${String(g).padStart(2, "0")}.wav`);
        await synthesizeAmbienceBed(category, totalDur, bedPath);

        let offset = 0;
        for (let k = 0; k < group.length; k++) {
          const idx = group[k];
          const dur = durations[k];
          const slicePath = path.join(tmp, `ambience_slice_${String(g).padStart(2, "0")}_${String(k).padStart(2, "0")}.wav`);
          const mixedPath = path.join(tmp, `ambience_mixed_${String(idx).padStart(2, "0")}.mp4`);
          await sliceAudio(bedPath, offset, dur, slicePath);
          await mixAmbienceBed(normalized[idx], slicePath, mixedPath, config.ambienceBedVolumeDb, config.ambienceBedDuckThreshold, config.ambienceBedDuckRatio);
          normalized[idx] = mixedPath;
          offset += dur;
        }
      } catch (e) {
        // Polish feature — same "never lose work over it" discipline as every
        // other best-effort pass in this file. Clips in this group keep
        // whatever audio they already had (no ambience bed, not broken).
        console.warn(`   ⚠️  ambience bed failed for scene group ${g + 1}/${sceneGroups.length}, skipping it: ${(e as Error)?.message}`);
      }
    }
  }

  // Two INDEPENDENT reasons two adjacent clips might get a dissolve instead
  // of a hard cut, either of which is enough on its own:
  //   1. config.sceneDissolveEnabled (default OFF — real ghosting risk, see
  //      that flag's own comment): the two shots are the SAME continuous
  //      scene (an angle change).
  //   2. config.sceneTransitionDissolveEnabled (default ON — see that
  //      flag's own comment): a GENUINE detected time-skip between the two
  //      shots (day/night flip, or an explicit "later that night"-style
  //      phrase), the classic passage-of-time use of a dissolve.
  // Both resolve to the exact same physical action (xfadeMerge these two
  // clips together instead of concatenating them with a hard cut), so one
  // shared partition pass handles both rather than duplicating the
  // run-grouping logic per flag.
  const shouldMerge = (i: number): boolean => {
    const idA = shotIdFromClipPath(clips[i - 1]);
    const idB = shotIdFromClipPath(clips[i]);
    const a = idA ? shotById.get(idA) : undefined;
    const b = idB ? shotById.get(idB) : undefined;
    if (!a || !b) return false; // safer to hard-cut than to guess
    if (config.sceneDissolveEnabled && sameScene(a, b)) return true;
    if (config.sceneTransitionDissolveEnabled && isGenuineTimeSkip(a, b)) return true;
    return false;
  };

  // Partition the clips, in FINAL assembly order, into runs of consecutive
  // clips that should be dissolved together per shouldMerge() above.
  const runs: string[][] = [];
  for (let i = 0; i < normalized.length; i++) {
    if (i > 0 && shouldMerge(i) && runs.length) {
      runs[runs.length - 1].push(normalized[i]);
    } else {
      runs.push([normalized[i]]);
    }
  }

  console.log(
    runs.length < normalized.length
      ? `🎞  ${normalized.length} clip(s) grouped into ${runs.length} run(s) — dissolving within each, hard cut between.`
      : `🎞  Stitching final film (hard cuts)...`,
  );

  // `indexOfNormalizedPath` maps a clip's own path back to its original
  // position in `normalized`/`clips`, which shotForIndex() needs to resolve
  // its actual shot. Built once here, before `joined`, and reused by the
  // boundary-fade pass below — NOT reconstructed from `runs` after the fact:
  // xfadeMerge()'s own failure fallback (`joined.push(...run)`, just below)
  // can push MULTIPLE clips for a single run, so `joined` and `runs` are not
  // reliably index-aligned — tracking each joined PIECE's own first/last shot
  // as it's actually pushed (not assumed from `runs[r]`) is the only way to
  // get this right regardless of whether a dissolve succeeded or fell back.
  const indexOfNormalizedPath = new Map(normalized.map((p, i) => [p, i]));
  const shotForPath = (p: string): Shot | undefined => {
    const idx = indexOfNormalizedPath.get(p);
    return idx !== undefined ? shotForIndex(idx) : undefined;
  };

  const joined: string[] = [];
  // Parallel to `joined`: the first/last shot backing each pushed piece —
  // one entry per joined[] push, however many raw clips that push actually
  // contained (1 for a normal or dissolved run, N on a dissolve fallback).
  const joinedEdges: { first: Shot | undefined; last: Shot | undefined }[] = [];
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (run.length === 1) {
      joined.push(run[0]);
      const s = shotForPath(run[0]);
      joinedEdges.push({ first: s, last: s });
      continue;
    }
    const merged = path.join(tmp, `run_${String(r).padStart(2, "0")}.mp4`);
    try {
      await xfadeMerge(run, merged);
      joined.push(merged);
      joinedEdges.push({ first: shotForPath(run[0]), last: shotForPath(run[run.length - 1]) });
    } catch (e) {
      // A transition is a polish feature, not a correctness one. If the filter
      // graph fails for any reason, fall back to hard-cutting this run's clips
      // individually rather than losing the film over it.
      console.warn(`   ⚠️  dissolve failed for scene run ${r + 1}/${runs.length}, falling back to hard cuts: ${(e as Error).message}`);
      joined.push(...run);
      for (const clip of run) {
        const s = shotForPath(clip);
        joinedEdges.push({ first: s, last: s });
      }
    }
  }

  // ── SOFT-CUT AUDIO AT EVERY REMAINING BOUNDARY ───────────────────────────
  // Everywhere above, two pieces that DIDN'T get dissolved into one still
  // went straight to a true, simultaneous hard stop/start on BOTH picture and
  // sound once concatClips() ran inside finishFilm() below — the common case,
  // since config.sceneDissolveEnabled defaults off. This replaces that: video
  // stays a pixel-exact hard cut always (softCutAssemble() never blends
  // video, so none of sceneDissolveEnabled's ghosting risk applies), but
  // audio gets a short in-place fade at each boundary instead of a click.
  let assembled = joined;
  if (joined.length >= 2) {
    const boundaryFadeSec: number[] = [];
    for (let r = 1; r < joined.length; r++) {
      const shotA = joinedEdges[r - 1].last;
      const shotB = joinedEdges[r].first;
      const isSameScene = !!shotA && !!shotB && sameScene(shotA, shotB);
      let fade = isSameScene ? config.sameSceneSoftCutFadeSec : config.hardCutAudioFadeSec;

      // SOUND-MASKED CUTS (best-effort) — if the outgoing run's own tail is
      // already notably louder than its own steady level, a real sonic event
      // is already happening right at the cut and will mask the seam on its
      // own; shortening the fade toward the hard-cut value leans on that
      // instead of blunting it. Any measurement failure just keeps the base
      // fade chosen above — never blocks assembly.
      if (config.soundMaskedCutsEnabled) {
        try {
          const outgoing = joined[r - 1];
          const dur = await probeDurationSec(outgoing);
          const window = Math.min(0.6, dur / 3);
          // Tail = the last `window` seconds (right where the cut happens).
          // Steady = a window centered on the clip's own midpoint — a real,
          // independent baseline for "how loud this clip normally is,"
          // distinct from the tail itself.
          const [tailDb, steadyDb] = await Promise.all([
            measureTailLoudnessDb(outgoing, window),
            measureWindowLoudnessDb(outgoing, Math.max(0, dur / 2 - window / 2), window),
          ]);
          if (tailDb !== null && steadyDb !== null && tailDb > steadyDb + 4) {
            fade = Math.min(fade, config.hardCutAudioFadeSec);
          }
        } catch {
          // best-effort — keep the base fade chosen above
        }
      }
      boundaryFadeSec.push(Math.max(0, fade));
    }

    try {
      const preAssembled = path.join(tmp, "soft_cut_assembled.mp4");
      await softCutAssemble(joined, boundaryFadeSec, preAssembled);
      assembled = [preAssembled];
    } catch (e) {
      // Same "polish feature, never lose the film over it" discipline as
      // every other best-effort pass here — fall back to the true hard-cut
      // concat finishFilm() already knows how to do.
      console.warn(`   ⚠️  soft-cut audio assembly failed, falling back to plain hard cuts: ${(e as Error)?.message}`);
      assembled = joined;
    }
  }

  return finishFilm(assembled, tmp, breakdown?.title, colorGradeFilter, spendCtx, songAudioUrl);
}

if (isMain(import.meta.url)) {
  runAssemble().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}