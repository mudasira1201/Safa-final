import { runtime } from "../config";
import { editFromReferences } from "../providers/image";
import { readJson, readJsonOr, writeJson, downloadToFile, fileExists, isMain } from "../util";
import { mapLimit, CONCURRENCY } from "../concurrency";
import { logSpend, costOfImages } from "../spend";
import { uploadFile } from "../storage";
import { prisma } from "../db";
import type { Breakdown, PropRefs } from "../types";

/**
 * Gap A — reference-image locking for story-significant PROPS, the exact
 * same mechanism 3-sheet.ts already gives characters, sized proportionately
 * (3 angles, not 10 — an object's appearance has far fewer meaningfully
 * distinct "views" than a human face does; a parcel doesn't need a
 * "3/4-left, right-profile, back-of-head" treatment).
 *
 * ONE REAL DIFFERENCE FROM CHARACTERS: a character's canonical angle-0 photo
 * is a REAL casting photo the user already chose (2-options.ts) — reused
 * verbatim, never regenerated. A prop has no analogous "casting" step; there
 * is no photo to choose from. So a prop's own canonical image IS a fresh
 * text-to-image generation (from its own `description`), and every other
 * angle is then edit-conditioned on THAT one real generated image — same
 * "one real anchor, everything else derived from it" discipline, just with
 * the anchor itself being generated instead of pre-existing.
 */
const PROP_ANGLES = [
  "front view, centered, on a plain neutral background, studio product photography lighting",
  "three-quarter angle view of the same object, on a plain neutral background",
  "close-up on the object's distinguishing texture, markings, or details, on a plain neutral background",
];

const IDENTITY_LOCK =
  "Keep the EXACT same object as the reference image - identical shape, materials, color, size, proportions, " +
  "and any markings or labels. Same object. Only change the camera angle. Photorealistic, plain neutral background.";

export async function runPropSheet(breakdown: Breakdown, projectId = "local", userId?: string, onProgress?: (label: string) => void): Promise<PropRefs> {
  const out = `${runtime.outDir}/props.json`;
  if (await fileExists(out)) {
    console.log("📦 Prop sheet already built (skipping). Delete output/props.json to rebuild.");
    return readJson<PropRefs>(out);
  }

  const props = breakdown.props ?? [];
  if (!props.length) {
    // Most films have none — this is the common case, not an error.
    await writeJson(out, {});
    return {};
  }

  const refs: PropRefs = {};
  let propsDone = 0;

  // DURABLE SHEET CACHE — same fix, same reasoning, as 3-sheet.ts's own
  // (CONFIRMED REAL, LIVE COST BUG): the local props.json cache above only
  // survives WITHIN one job's scratch dir, wiped every job. See 3-sheet.ts's
  // comment for the full story. projectId === "local" skips this (no real DB
  // row for the CLI/dev-server tools to cache against).
  const priorArts = projectId !== "local"
    ? await prisma.artifact.findMany({ where: { projectId, kind: "prop_sheet" } }).catch(() => [])
    : [];

  for (const prop of props) {
    propsDone++;
    onProgress?.(`Building "${prop.name}"'s reference sheet (${propsDone}/${props.length})`);

    const cachedForProp = priorArts.filter((a) => a.url.includes(`/prop-sheet/${prop.id}/`));
    if (cachedForProp.length >= PROP_ANGLES.length) {
      try {
        const urls: string[] = [];
        for (let i = 0; i < PROP_ANGLES.length; i++) {
          const art = cachedForProp.find((a) => a.url.endsWith(`/angle-${i + 1}.png`));
          if (!art) throw new Error("incomplete cached sheet");
          await downloadToFile(art.url, `${runtime.outDir}/props/${prop.id}/angle-${i + 1}.png`);
          urls.push(art.url);
        }
        refs[prop.id] = urls;
        console.log(`   ♻️  "${prop.name}"'s reference sheet restored from storage — not re-billed.`);
        continue;
      } catch {
        console.warn(`   "${prop.name}"'s cached sheet was incomplete/unreachable — rebuilding for real.`);
      }
    }

    console.log(`📦 Building ${PROP_ANGLES.length}-angle sheet for "${prop.name}"...`);
    const canonicalPrompt = `${prop.description}. ${PROP_ANGLES[0]}`;

    const bank = async (localPath: string, angleIndex: number, fallbackUrl: string): Promise<string> => {
      if (projectId === "local") return fallbackUrl;
      try {
        const stored = await uploadFile(localPath, `projects/${projectId}/prop-sheet/${prop.id}/angle-${angleIndex}.png`);
        await prisma.artifact.create({ data: { projectId, kind: "prop_sheet", url: stored } }).catch(() => {});
        return stored;
      } catch { return fallbackUrl; } // best-effort — a failed upload just costs the NEXT job a cache miss
    };

    // The canonical anchor is resolved FIRST, sequentially — every other
    // angle edit-conditions on it, so it must exist before they can start.
    // Text-to-image (empty reference list), unlike characters' angle-0
    // which reuses an already-real casting photo — see this file's
    // top-of-file comment for why a prop has no equivalent to reuse.
    const canonicalUrl = await editFromReferences(canonicalPrompt, []);
    const canonicalPath = `${runtime.outDir}/props/${prop.id}/angle-1.png`;
    await downloadToFile(canonicalUrl, canonicalPath);
    const bankedCanonicalUrl = await bank(canonicalPath, 1, canonicalUrl);

    const derivedUrls = await mapLimit(PROP_ANGLES.slice(1), CONCURRENCY, async (angle, i) => {
      const url = await editFromReferences(`${angle}. ${IDENTITY_LOCK}`, [canonicalUrl]);
      const path = `${runtime.outDir}/props/${prop.id}/angle-${i + 2}.png`;
      await downloadToFile(url, path);
      return bank(path, i + 2, url);
    });

    refs[prop.id] = [bankedCanonicalUrl, ...derivedUrls];
    // COST TRACKING — every one of these IS a real, new generation (unlike
    // characters' angle-0, there is no pre-existing photo to reuse here).
    await logSpend("image", { userId, projectId, units: PROP_ANGLES.length, amountUsd: costOfImages(PROP_ANGLES.length) });
  }

  await writeJson(out, refs);
  console.log(`✅ Prop sheet(s) ready — these references lock appearance across every shot.`);
  return refs;
}

if (isMain(import.meta.url)) {
  readJsonOr<Breakdown>(`${runtime.outDir}/breakdown.json`, null as unknown as Breakdown)
    .then((bd) => {
      if (!bd) throw new Error("No breakdown.json found. Run the breakdown step first.");
      return runPropSheet(bd);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
