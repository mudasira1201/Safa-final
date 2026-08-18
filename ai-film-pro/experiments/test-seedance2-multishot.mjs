// experiments/test-seedance2-multishot.mjs
// -----------------------------------------------------------------------------
// STANDALONE. Does not import anything from src/ and does not touch config.ts,
// video.ts, or any provider this pipeline actually uses. Reuses the already-
// installed @fal-ai/client SDK directly (same package your real pipeline
// depends on) so polling/retry is handled by fal's own supported client, not
// hand-rolled here.
//
// WHAT THIS TESTS: whether bytedance/seedance-2.0/reference-to-video can
// genuinely produce a single, continuous, MULTI-SHOT clip from one call --
// several internal "cuts" at stated timestamps, all understood by the model as
// one temporal continuum -- instead of your current pipeline's approach (one
// call per shot, stitched afterward with an ffmpeg hard-cut concat). If this
// holds up on a real render, it is a more direct fix for "the shots look cut"
// than anything achievable through prompt-only camera-continuity text or a
// transition filter between independently-generated clips.
//
// Reads FAL_KEY from your environment/.env -- same credential your real
// pipeline already uses, nothing new to set up.
//
// SETUP:
//   1. Fill in REFERENCE_IMAGE_URL(S) below with real URLs from your own R2
//      bucket -- e.g. a character's angle-1.png and/or a product/vehicle photo.
//   2. node experiments/test-seedance2-multishot.mjs
//
// UNVERIFIED, STATED HONESTLY: request/response field names below are sourced
// from fal.ai's own published docs (not a live test yet) -- if fal rejects the
// request, its error body will say exactly which field it didn't like; read
// that, don't re-guess.
// -----------------------------------------------------------------------------

import "dotenv/config";
import { fal } from "@fal-ai/client";

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error("❌ FAL_KEY not found in environment/.env.");
  process.exit(1);
}
fal.config({ credentials: FAL_KEY });

// ---- FILL THESE IN with real URLs from your own R2 bucket ------------------
// At least one reference image is required for a meaningful identity/consistency
// test. Order matters -- the prompt below refers to them as @Image1, @Image2 ...
// in the SAME order you list them here.
const REFERENCE_IMAGES = [
  // Arjun's real selected-look reference from "The Package 2" (project
  // cmsenkfik000157sac5vbsn20) -- the same character whose identity kept
  // drifting/getting swapped in that render, so this is a directly
  // comparable test of whether Seedance 2.0 holds identity better across
  // internal cuts than the current one-call-per-shot approach did.
  "https://pub-3a4f58d716dc4abba5e4950dd3c2d7df.r2.dev/projects/cmsenkfik000157sac5vbsn20/options/arjun/opt-1.png",
];

// A short multi-shot prompt using Seedance 2.0's own documented conventions
// (@ImageN reference tags, timestamped internal cuts, "Cut scene to..."). Edit
// this to something close to a real scene from your own catalogue once the
// basic smoke test passes -- this default is intentionally simple so a first
// run isolates "does multi-shot work at all" from "is my specific scene text
// well-written."
const PROMPT = `
Cinematic photorealistic video, natural daylight.
@Image1 stands in a quiet street, looking around calmly.

At 0 seconds: wide establishing shot, @Image1 standing still, hands in pockets.
At 3 seconds: Cut scene to a medium shot, @Image1 begins walking forward, natural pace.
At 6 seconds: Cut scene to a close-up on @Image1's face, a small, natural smile forming.
`.trim();

async function run() {
  if (!REFERENCE_IMAGES.length) {
    console.error("❌ Fill in REFERENCE_IMAGES at the top of this file with at least one real R2 URL first.");
    process.exit(1);
  }

  console.log("▶ Submitting to bytedance/seedance-2.0/reference-to-video...");
  console.log(`   ${REFERENCE_IMAGES.length} reference image(s), duration: auto (model picks length for a 3-cut prompt)`);

  try {
    const result = await fal.subscribe("bytedance/seedance-2.0/reference-to-video", {
      input: {
        prompt: PROMPT,
        image_urls: REFERENCE_IMAGES,
        resolution: "720p",
        duration: "auto",
        aspect_ratio: "16:9",
        generate_audio: false, // keep the smoke test cheap/simple; flip on once basic multi-shot behavior is confirmed
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          (update.logs ?? []).forEach((l) => console.log(`   ${l.message}`));
        }
      },
    });

    const url = result?.data?.video?.url;
    if (!url) {
      console.error("❌ No video URL in response:", JSON.stringify(result?.data ?? result, null, 2));
      process.exit(1);
    }
    console.log(`\n✅ Done -> ${url}`);
    console.log("\nWatch it and judge specifically:");
    console.log("  1. Are there really 3 distinct shots/cuts inside the ONE clip, at roughly the stated timestamps?");
    console.log("  2. Does @Image1's identity hold across all three internal cuts (same face, same person)?");
    console.log("  3. Do the cuts feel like real editing (a clean cut, no ghosting/morphing AT the cut point)?");
  } catch (e) {
    console.error("❌ Request failed:", JSON.stringify(e?.body ?? e?.message ?? e, null, 2));
    process.exit(1);
  }
}

run();
