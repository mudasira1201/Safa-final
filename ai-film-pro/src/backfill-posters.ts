// ==========================================================
// PUT THIS FILE AT:  ai-film-pro/src/backfill-posters.ts   *** NEW FILE ***
// (rename to: backfill-posters.ts)
// ==========================================================
/** ONE-OFF: generate poster images for films and clips rendered before the poster pipeline
 *  existed. Without a poster a video shows a black rectangle until you press play, which is
 *  why the older films look broken in the grids.
 *
 *  Run once:   npx tsx src/backfill-posters.ts
 *  Safe to re-run: it skips anything that already has a poster.
 */
import "dotenv/config";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { prisma } from "./db";
import { uploadFile } from "./storage";
import { makePoster } from "./util";

const TMP = "/tmp/safa-backfill";

async function download(url: string, dest: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

/** The frontend derives a poster URL by swapping .mp4 -> .jpg, so the poster must land on the
 *  SAME storage key. Recover that key from the public URL. */
function keyFromUrl(url: string): string | null {
  const m = url.match(/projects\/[^?]+$/);
  return m ? m[0] : null;
}

async function posterExists(jpgUrl: string): Promise<boolean> {
  try {
    const r = await fetch(jpgUrl, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

async function backfill(videoUrl: string): Promise<string> {
  const clean = videoUrl.split("#")[0];
  if (!/\.mp4$/i.test(clean)) return "skipped (not an mp4)";

  const jpgUrl = clean.replace(/\.mp4$/i, ".jpg");
  if (await posterExists(jpgUrl)) return "already has one";

  const key = keyFromUrl(clean);
  if (!key) return "skipped (could not work out the storage key)";

  const local = path.join(TMP, `${Date.now()}-${path.basename(clean)}`);
  await download(clean, local);

  const poster = await makePoster(local);
  if (!poster) {
    await fs.rm(local, { force: true }).catch(() => {});
    return "ffmpeg could not grab a frame";
  }

  await uploadFile(poster, key.replace(/\.mp4$/i, ".jpg"));
  await fs.rm(local, { force: true }).catch(() => {});
  await fs.rm(poster, { force: true }).catch(() => {});
  return "poster created";
}

async function main() {
  await fs.mkdir(TMP, { recursive: true });

  const films = await prisma.project.findMany({
    where: { filmUrl: { not: null } },
    select: { id: true, title: true, filmUrl: true },
  });
  const clips = await prisma.artifact.findMany({
    where: { kind: "clip" },
    select: { id: true, url: true },
  });

  console.log(`\n🎞  ${films.length} finished films and ${clips.length} clips to check.\n`);

  let made = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of films) {
    try {
      const r = await backfill(f.filmUrl as string);
      console.log(`   film  "${f.title}" -> ${r}`);
      if (r === "poster created") made++;
      else skipped++;
    } catch (e) {
      console.error(`   film  "${f.title}" -> FAILED: ${(e as Error).message}`);
      failed++;
    }
  }

  for (const c of clips) {
    try {
      const r = await backfill(c.url);
      if (r === "poster created") {
        made++;
        console.log(`   clip  ${c.id} -> ${r}`);
      } else {
        skipped++;
      }
    } catch (e) {
      console.error(`   clip  ${c.id} -> FAILED: ${(e as Error).message}`);
      failed++;
    }
  }

  console.log(`\n✅ done. ${made} posters created, ${skipped} skipped, ${failed} failed.\n`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});