import { runtime } from "../config";
import { editFromReferences } from "../providers/image";
import { readJson, readJsonOr, writeJson, downloadToFile, fileExists, isMain } from "../util";
import { mapLimit, CONCURRENCY } from "../concurrency";
import { logSpend, costOfImages } from "../spend";
import { uploadFile } from "../storage";
import { prisma } from "../db";
import { authoredOnly } from "../lib/compiler";
import type { Breakdown, LocationRefs, LocationSelections, Shot } from "../types";

/**
 * Location reference sheets — the same locked-identity-photo treatment
 * 3-sheet.ts gives characters and 3b-props.ts gives props, applied to
 * physical places. `Shot.locationId` (assigned by compileBreakdown()'s
 * LOCATION IDENTITY pass — an UNWINDOWED sameScene() grouping across the
 * whole film, see compiler.ts) is what makes a REVISIT recognizable at all:
 * `sceneAnchorUrl` in 4-images.ts only holds within one contiguous
 * same-scene run and resets the moment the scene changes, even when it's
 * the exact same physical location coming back.
 *
 * SCOPED TO GENUINELY REVISITED LOCATIONS ONLY (see isRevisited() below) —
 * a location seen once already has sceneAnchorUrl plus its own setting text
 * covering it; paying for a sheet there adds real cost for no confirmed
 * problem. This targets the confirmed bug (a revisited place drifting
 * across non-adjacent scenes), not every location generically.
 */
const LOCATION_ANGLES = [
  "wide establishing view of this space, showing its full layout and every key landmark, photorealistic",
  "the same space viewed from the opposite side, showing the same key landmarks from a different vantage point",
  "a closer view highlighting this space's single most distinctive fixed feature or landmark",
];

const IDENTITY_LOCK =
  "This is the SAME physical location as the reference image - identical layout, architecture, fixed " +
  "furniture and landmarks, materials, and colors. Reproduce the exact position of its key landmarks, " +
  "never a different arrangement or orientation. Only change the camera angle. Photorealistic.";

/** True when a locationId's shots aren't one contiguous block in the shot
 *  list — i.e. the film actually LEAVES this place and comes back later,
 *  not just holds on it for a run of adjacent shots. Counts how many
 *  separate runs this id appears in, walking shots in story order. */
function runCount(shots: Shot[], locationId: string): number {
  let runs = 0;
  let inRun = false;
  for (const s of shots) {
    if (s.locationId === locationId) {
      if (!inRun) runs++;
      inRun = true;
    } else {
      inRun = false;
    }
  }
  return runs;
}

export async function runLocationSheet(
  breakdown: Breakdown,
  projectId = "local",
  userId?: string,
  onProgress?: (label: string) => void,
  // A regen_sheet job's user-supplied "make it look like X" request, scoped to
  // ONE locationId — every OTHER revisited location in this same call is
  // unaffected (still generates/restores purely from its own setting text).
  // Only meaningful together with a cache miss for that locationId (see
  // handleRegenSheet in worker.ts, which deletes that location's cached
  // Artifact rows before calling this) — a cache HIT never reaches the
  // generation code below, so a stale note can't silently no-op undetected.
  noteFor?: { locationId: string; note: string },
): Promise<LocationRefs> {
  const out = `${runtime.outDir}/locations.json`;
  if (await fileExists(out)) {
    console.log("🏛️  Location sheet already built (skipping). Delete output/locations.json to rebuild.");
    return readJson<LocationRefs>(out);
  }

  const shots = breakdown.shots ?? [];
  const byId = new Map<string, Shot[]>();
  for (const s of shots) {
    if (!s.locationId) continue; // unassigned — pre-locationId breakdown or a shot compileBreakdown() hasn't touched
    const group = byId.get(s.locationId);
    if (group) group.push(s);
    else byId.set(s.locationId, [s]);
  }

  const revisited = [...byId.entries()].filter(([id]) => runCount(shots, id) > 1);
  if (!revisited.length) {
    // Most films never leave-and-return to the same place — the common case.
    await writeJson(out, {});
    return {};
  }

  const refs: LocationRefs = {};
  let locsDone = 0;

  // CHOSEN LOOK, SAME PATTERN AS 3-sheet.ts's CHOSEN CASTING PHOTO — read the
  // user's early "which look for this place" pick (2b-location-options.ts,
  // made alongside character casting, for EVERY location, not just revisited
  // ones) directly off local disk, same "read the file, don't thread a new
  // parameter through every caller" approach runSheet() already uses for
  // selections.json. Absent for an older project or a local-CLI run that
  // skipped the options step — falls through to today's fresh-generation
  // behavior below, unaffected.
  const locationSelections = await readJsonOr<LocationSelections>(`${runtime.outDir}/location-selections.json`, {});

  // DURABLE SHEET CACHE — same fix, same reasoning, as 3-sheet.ts/3b-props.ts's
  // own (a per-job scratch dir cache alone doesn't survive across separate
  // jobs — see 3-sheet.ts's comment for the full story). projectId === "local"
  // skips this (no real DB row for the CLI/dev-server tools to cache against).
  const priorArts = projectId !== "local"
    ? await prisma.artifact.findMany({ where: { projectId, kind: "location_sheet" } }).catch(() => [])
    : [];

  for (const [locationId, group] of revisited) {
    locsDone++;
    const richest = group.reduce((best, s) => (authoredOnly(s.setting || "").length > authoredOnly(best.setting || "").length ? s : best), group[0]);
    const richText = authoredOnly(richest.setting || "").trim() || richest.scene || locationId;
    onProgress?.(`Building "${richText.slice(0, 40)}"'s location reference sheet (${locsDone}/${revisited.length})`);

    const cachedForLoc = priorArts.filter((a) => a.url.includes(`/location-sheet/${locationId}/`));
    if (cachedForLoc.length >= LOCATION_ANGLES.length) {
      try {
        const urls: string[] = [];
        for (let i = 0; i < LOCATION_ANGLES.length; i++) {
          const art = cachedForLoc.find((a) => a.url.endsWith(`/angle-${i + 1}.png`));
          if (!art) throw new Error("incomplete cached sheet");
          await downloadToFile(art.url, `${runtime.outDir}/locations/${locationId}/angle-${i + 1}.png`);
          urls.push(art.url);
        }
        refs[locationId] = urls;
        console.log(`   ♻️  Location reference sheet restored from storage — not re-billed.`);
        continue;
      } catch {
        console.warn(`   Cached location sheet was incomplete/unreachable — rebuilding for real.`);
      }
    }

    console.log(`🏛️  Building ${LOCATION_ANGLES.length}-angle location sheet for "${richText.slice(0, 60)}"...`);
    // The requested change is folded into the CANONICAL prompt only — every
    // other angle below is a visual edit FROM that canonical image (not a
    // second independent text-to-image call), so once the canonical shot
    // reflects the request, the other 2 angles inherit it automatically by
    // construction, exactly the same "edit from the locked reference" chain
    // that already keeps a character's 10 angles consistent with each other.
    const requestedChange = noteFor && noteFor.locationId === locationId && noteFor.note.trim()
      ? ` Requested change from the previous version of this location: ${noteFor.note.trim()}.`
      : "";
    const canonicalPrompt = `${richText}. ${LOCATION_ANGLES[0]}${requestedChange}`;

    const bank = async (localPath: string, angleIndex: number, fallbackUrl: string): Promise<string> => {
      if (projectId === "local") return fallbackUrl;
      try {
        const stored = await uploadFile(localPath, `projects/${projectId}/location-sheet/${locationId}/angle-${angleIndex}.png`);
        await prisma.artifact.create({ data: { projectId, kind: "location_sheet", url: stored } }).catch(() => {});
        return stored;
      } catch { return fallbackUrl; } // best-effort — a failed upload just costs the NEXT job a cache miss
    };

    // CHOSEN-LOOK REUSE — same "the real photo IS angle-0/angle-1, never a
    // regenerated approximation of it" discipline 3-sheet.ts already uses for
    // characters: if the user picked a look for this location, that picked
    // image is the canonical angle, not a fresh text-to-image guess at their
    // own richText. A real, new generation only happens here when there's a
    // requested change to apply (editFromReferences FROM the chosen image,
    // not from nothing — keeps the edit grounded in what was actually
    // chosen) or when no chosen look exists at all (older project, local CLI
    // run that skipped 2b-location-options.ts).
    const chosenInfo = locationSelections[locationId];
    const chosenUrl = chosenInfo ? chosenInfo.options[(chosenInfo.chosen || 1) - 1] ?? chosenInfo.options[0] : undefined;
    let canonicalUrl: string;
    let canonicalIsFreshGeneration: boolean;
    if (chosenUrl && !requestedChange) {
      canonicalUrl = chosenUrl;
      canonicalIsFreshGeneration = false;
    } else if (chosenUrl && requestedChange) {
      canonicalUrl = await editFromReferences(`${LOCATION_ANGLES[0]}${requestedChange}`, [chosenUrl]);
      canonicalIsFreshGeneration = true;
    } else {
      // No pre-existing chosen look to reuse — text-to-image (empty reference list),
      // same as before this feature existed.
      canonicalUrl = await editFromReferences(canonicalPrompt, []);
      canonicalIsFreshGeneration = true;
    }
    const canonicalPath = `${runtime.outDir}/locations/${locationId}/angle-1.png`;
    await downloadToFile(canonicalUrl, canonicalPath);
    const bankedCanonicalUrl = await bank(canonicalPath, 1, canonicalUrl);

    const derivedUrls = await mapLimit(LOCATION_ANGLES.slice(1), CONCURRENCY, async (angle, i) => {
      const url = await editFromReferences(`${angle}. ${IDENTITY_LOCK}`, [canonicalUrl]);
      const path = `${runtime.outDir}/locations/${locationId}/angle-${i + 2}.png`;
      await downloadToFile(url, path);
      return bank(path, i + 2, url);
    });

    refs[locationId] = [bankedCanonicalUrl, ...derivedUrls];
    // COST TRACKING — the derived angles are always real generations; the
    // canonical only is when it wasn't a straight reuse of the chosen photo
    // (mirrors 3-sheet.ts's realGenerations = ANGLES.length - 1 for the same
    // reused-photo reason).
    const realGenerations = canonicalIsFreshGeneration ? LOCATION_ANGLES.length : LOCATION_ANGLES.length - 1;
    await logSpend("image", { userId, projectId, units: realGenerations, amountUsd: costOfImages(realGenerations) });
  }

  await writeJson(out, refs);
  console.log(`✅ Location reference sheet(s) ready — these lock a revisited room's geometry across every shot.`);
  return refs;
}

if (isMain(import.meta.url)) {
  readJsonOr<Breakdown>(`${runtime.outDir}/breakdown.json`, null as unknown as Breakdown)
    .then((bd) => {
      if (!bd) throw new Error("No breakdown.json found. Run the breakdown step first.");
      return runLocationSheet(bd);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
