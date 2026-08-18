import { runtime } from "../config";
import { editFromReferences } from "../providers/image";
import { readJson, writeJson, downloadToFile, fileExists, isMain } from "../util";
import { mapLimit, CONCURRENCY } from "../concurrency";
import { logSpend, costOfImages } from "../spend";
import { uploadFile } from "../storage";
import { prisma } from "../db";
import type { Selections, CharacterRefs } from "../types";

// The angles we lock for each character. More angles = a stronger identity
// anchor for later shots' reference-image conditioning. Angle 0's own text is
// never actually sent to a generator (see the loop below) -- it's replaced by
// the REAL casting photo, so keep the description here purely as documentation
// of what that slot conceptually represents.
const ANGLES = [
  "front view, facing the camera directly, head and shoulders, neutral expression",
  "three-quarter left view of the same person, neutral expression",
  "left side profile of the same person",
  "three-quarter right view of the same person, neutral expression",
  "right side profile of the same person",
  "full-body standing shot of the same person, head to toe",
  "front view, facing the camera directly, head and shoulders, warm natural smile",
  "three-quarter left view of the same person, serious focused expression",
  "close-up on the face only, front view, neutral expression",
  "back of the head and shoulders, showing hair from behind",
];

const IDENTITY_LOCK =
  "Keep the EXACT same person as the reference image - identical face, eyes, nose, jawline, skin tone, " +
  "hair, and clothing. Same identity. Only change the camera angle/pose. Photorealistic, plain neutral background.";

export async function runSheet(projectId = "local", userId?: string, onProgress?: (label: string) => void): Promise<CharacterRefs> {
  const out = `${runtime.outDir}/characters.json`;
  if (await fileExists(out)) {
    console.log("🧍 Character sheet already built (skipping). Delete output/characters.json to rebuild.");
    return readJson<CharacterRefs>(out);
  }

  const selections = await readJson<Selections>(`${runtime.outDir}/selections.json`);
  const refs: CharacterRefs = {};
  const totalChars = Object.keys(selections).length;
  let charsDone = 0;

  // DURABLE SHEET CACHE — CONFIRMED REAL, LIVE COST BUG, FIXED: the ONLY
  // cache this function had was the local characters.json file above, which
  // lives in runtime.outDir — a PER-JOB scratch directory, rmrf()'d at the
  // start of every single job (see worker.ts's tick()/every handler). So
  // every job that needed the sheet — the keyframes pass, the clips pass
  // (now TWO SEPARATE jobs after this session's keyframes/clips split), and
  // every regen_keyframe/regen_clip/delete_shot/insert_shot — silently
  // re-paid for the full ANGLES.length-1 real edits per character, EVERY
  // time, even though a character's chosen casting photo never changes once
  // selection is locked in (options/route.ts's "regenerate" action is only
  // reachable from "awaiting_selection", before a "shots" job ever queues).
  // Restoring from storage here — same "trust durable storage, not local
  // disk, across jobs" discipline restoreCachedArtifacts() (worker.ts)
  // already uses for keyframes/clips — makes every job after the first a
  // real, free cache hit instead of a silent re-bill. projectId === "local"
  // (run.ts/server.ts's local CLI/dev-server default) skips this entirely —
  // those tools have no real DB-backed project to cache against.
  const priorArts = projectId !== "local"
    ? await prisma.artifact.findMany({ where: { projectId, kind: "character_sheet" } }).catch(() => [])
    : [];

  for (const [charId, info] of Object.entries(selections)) {
    const chosenUrl = info.options[(info.chosen || 1) - 1] ?? info.options[0];
    if (!chosenUrl) throw new Error(`No chosen option for ${charId}. Run npm run characters first.`);

    charsDone++;
    onProgress?.(`Building ${info.name}'s reference sheet (${charsDone}/${totalChars})`);

    const cachedForChar = priorArts.filter((a) => a.url.includes(`/character-sheet/${charId}/`));
    if (cachedForChar.length >= ANGLES.length) {
      try {
        const urls: string[] = [];
        for (let i = 0; i < ANGLES.length; i++) {
          const art = cachedForChar.find((a) => a.url.endsWith(`/angle-${i + 1}.png`));
          if (!art) throw new Error("incomplete cached sheet");
          await downloadToFile(art.url, `${runtime.outDir}/characters/${charId}/angle-${i + 1}.png`);
          urls.push(art.url);
        }
        refs[charId] = urls;
        console.log(`   ♻️  ${info.name}'s reference sheet restored from storage — not re-billed.`);
        continue;
      } catch {
        console.warn(`   ${info.name}'s cached sheet was incomplete/unreachable — rebuilding for real.`);
      }
    }

    console.log(`🧍 Building ${ANGLES.length}-angle sheet for ${info.name} (from option ${info.chosen})...`);

    // SAME IMAGE, EVERY CLIP, FOR REAL — not a regenerated approximation of
    // it. Angle 0 (ANGLE_PRIORITY's own highest-priority slot in 4-images.ts)
    // is the literal casting photo the user/system chose, reused as-is
    // instead of asking the edit model to reproduce a "front view" of it —
    // every generative hop between the real photo and what a shot's
    // keyframe references is a chance for identity to drift, and this is the
    // one hop that was always unnecessary: the chosen photo is ALREADY a
    // front-facing, neutral-expression, camera-looking portrait (see
    // 2-options.ts's own generation prompt). Every other angle still needs a
    // genuine new pose/framing, so those keep regenerating from it.
    const urls = await mapLimit(ANGLES, CONCURRENCY, async (angle, i) => {
      let localUrl: string;
      if (i === 0) {
        await downloadToFile(chosenUrl, `${runtime.outDir}/characters/${charId}/angle-1.png`);
        localUrl = chosenUrl;
      } else {
        localUrl = await editFromReferences(`${angle}. ${IDENTITY_LOCK}`, [chosenUrl]);
        await downloadToFile(localUrl, `${runtime.outDir}/characters/${charId}/angle-${i + 1}.png`);
      }
      // Bank it durably so the NEXT job (a different job.id, a wiped outDir)
      // can restore instead of re-paying — angle-1 is a cheap re-upload of an
      // already-real photo (no paid API call), every other angle is the real
      // generation this whole cache exists to stop repeating.
      if (projectId !== "local") {
        try {
          const stored = await uploadFile(
            `${runtime.outDir}/characters/${charId}/angle-${i + 1}.png`,
            `projects/${projectId}/character-sheet/${charId}/angle-${i + 1}.png`,
          );
          await prisma.artifact.create({ data: { projectId, kind: "character_sheet", url: stored } }).catch(() => {});
          return stored;
        } catch { /* best-effort — a failed upload just costs the NEXT job a cache miss, not this render */ }
      }
      return localUrl;
    });

    refs[charId] = urls;
    // COST TRACKING — ANGLES.length - 1 real Nano Banana edits: angle 0 above
    // is a reused image, not a new paid generation, so it must not be billed
    // or counted as one (that would double-count against the cost already
    // logged when this photo was first generated in 2-options.ts).
    const realGenerations = ANGLES.length - 1;
    await logSpend("image", { userId, projectId, units: realGenerations, amountUsd: costOfImages(realGenerations) });
  }

  await writeJson(out, refs);
  console.log(`✅ Character sheet(s) ready — these references lock identity across every shot.`);
  return refs;
}

if (isMain(import.meta.url)) {
  runSheet().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
