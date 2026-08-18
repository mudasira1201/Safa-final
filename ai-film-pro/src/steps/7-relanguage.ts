import { promises as fs } from "node:fs";
import * as path from "node:path";
import { runtime } from "../config";
import { readJson, readJsonOr, writeJson, fileExists, ensureDir, isMain } from "../util";
import { translateDialogue } from "../providers/llm";
import { runVideos } from "./5-videos";
import { runAssemble } from "./6-assemble";
import type { Breakdown } from "../types";
import { languageName, resolveLanguage } from "../lib/languages";

/**
 * RE-LANGUAGE — produces a SECOND-LANGUAGE VERSION of an already-rendered
 * film, reusing everything that doesn't actually depend on spoken language
 * (keyframes, character/prop/location references, and every clip that has
 * no dialogue at all) and paying only for what genuinely has to change: a
 * fresh video+audio render for each shot that HAS dialogue, spoken in the
 * new target language.
 *
 * WHY IT'S SAFE TO REUSE VISUALS: lib/languages.ts's own rule translates
 * ONLY `Shot.dialogue` — every other field (description, motion, camera,
 * setting, keyframe references) stays byte-identical between language
 * versions. A shot with no dialogue therefore renders IDENTICALLY regardless
 * of language — same keyframe, same motion prompt, same audio (ambience
 * only) — so re-rendering it a second time would be pure wasted spend, not
 * a quality improvement.
 *
 * HOW: runs runVideos()/runAssemble() completely UNCHANGED, pointed at a
 * NESTED output directory (runtime.outDir + "/lang-<code>") pre-seeded to
 * look like a normal, partially-rendered project to those functions:
 *   - breakdown.json: the original breakdown with only each dialogue-
 *     bearing shot's `dialogue` field replaced (see translateDialogue()'s
 *     own comment for why this can't touch any other field) and `language`
 *     set to the target code.
 *   - images.json / characters.json / props.json / locations.json /
 *     location-selections.json / song.json: copied in unchanged — these are
 *     all language-independent reference data.
 *   - clips/: PRE-SEEDED with a copy of every NON-dialogue shot's ALREADY-
 *     RENDERED clip, under the exact same "NN-shotId.mp4" filename
 *     runVideos() itself uses — its own existing cache check
 *     (fileExists(dest)) then finds these and skips them as a normal cache
 *     hit, so runVideos() only ever does real paid work for shots that
 *     actually need it, with zero changes to that file.
 */
export async function runRelanguage(targetLanguageInput: string): Promise<string> {
  const baseOutDir = runtime.outDir;
  const code = resolveLanguage(targetLanguageInput);
  if (!code) {
    throw new Error(
      `"${targetLanguageInput}" is not a recognized language (see lib/languages.ts's LANGUAGES map). Refusing to ` +
      `guess — shipping a film silently mislabeled as the wrong language is worse than failing here.`,
    );
  }

  const breakdown = await readJson<Breakdown>(`${baseOutDir}/breakdown.json`);
  const clips = await readJsonOr<string[]>(`${baseOutDir}/clips.json`, []);
  if (!clips.length) {
    throw new Error(
      `No rendered clips found at ${baseOutDir}/clips.json — run the full pipeline (breakdown → images → videos) ` +
      `in the ORIGINAL language first. Re-languaging reuses those clips; it has nothing to reuse without them.`,
    );
  }
  if (!(await fileExists(`${baseOutDir}/images.json`))) {
    throw new Error(`No ${baseOutDir}/images.json — keyframes must already exist before re-languaging.`);
  }

  console.log(`🌐 Translating dialogue to ${languageName(code)}...`);
  const translated = await translateDialogue(breakdown, code);
  console.log(`   ${Object.keys(translated).length} line(s) translated.`);

  const langBreakdown: Breakdown = {
    ...breakdown,
    language: code,
    shots: breakdown.shots.map((s) => (translated[s.id] ? { ...s, dialogue: translated[s.id] } : s)),
  };

  const langDir = `${baseOutDir}/lang-${code}`;
  await ensureDir(langDir);
  await ensureDir(`${langDir}/clips`);
  await writeJson(`${langDir}/breakdown.json`, langBreakdown);

  // Language-independent references, copied through unchanged. images.json
  // is required (checked above); the rest are per-project optional — most
  // films have no tracked props or revisited locations at all (same
  // readJsonOr reasoning 4-images.ts/5-videos.ts already apply to these
  // exact files).
  const passthroughFiles = ["images.json", "characters.json", "props.json", "locations.json", "location-selections.json", "song.json"];
  for (const f of passthroughFiles) {
    if (await fileExists(`${baseOutDir}/${f}`)) {
      await fs.copyFile(`${baseOutDir}/${f}`, `${langDir}/${f}`);
    }
  }

  // Pre-seed every NON-dialogue shot's clip so runVideos()'s own cache check
  // finds it and skips real work — see this function's own top comment for
  // why that's correct, not just an optimization.
  const dialogueShotIds = new Set(Object.keys(translated));
  let reused = 0;
  for (const clipPath of clips) {
    const base = path.basename(clipPath);
    const shotId = base.match(/^\d+-(.+)\.mp4$/)?.[1];
    if (shotId && dialogueShotIds.has(shotId)) continue; // needs a fresh render below, in the new language
    if (!(await fileExists(clipPath))) continue; // can't reuse what isn't actually on disk
    await fs.copyFile(clipPath, `${langDir}/clips/${base}`);
    reused++;
  }
  console.log(
    `   ♻️  ${reused} non-dialogue clip(s) reused unchanged, ${dialogueShotIds.size} dialogue clip(s) will render ` +
    `fresh in ${languageName(code)}.`,
  );

  // Point every downstream step at the language-scoped directory for the
  // duration of this call, then restore it — runVideos()/runAssemble() both
  // read/write fixed filenames under runtime.outDir, completely unmodified.
  runtime.outDir = langDir;
  try {
    await runVideos();
    const finalPath = await runAssemble();
    const dest = `${baseOutDir}/final.${code}.mp4`;
    await fs.copyFile(finalPath, dest);
    console.log(`\n🌐 ${languageName(code)} version → ${path.resolve(dest)}\n`);
    return dest;
  } finally {
    runtime.outDir = baseOutDir;
  }
}

if (isMain(import.meta.url)) {
  const target = process.env.TARGET_LANGUAGE;
  if (!target) {
    console.error("Set TARGET_LANGUAGE (e.g. TARGET_LANGUAGE=hi npm run relanguage) to the language code/name to render.");
    process.exit(1);
  }
  runRelanguage(target).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
