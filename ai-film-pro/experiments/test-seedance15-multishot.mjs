// experiments/test-seedance15-multishot.mjs
// -----------------------------------------------------------------------------
// STANDALONE. Does not import anything from src/, does not touch config.ts or
// providers/video.ts. Reuses the already-installed @fal-ai/client SDK and your
// existing FAL_KEY -- nothing new to set up.
//
// WHAT THIS TESTS: does the ACTUAL, currently-integrated Seedance 1.5 Pro
// endpoint (fal-ai/bytedance/seedance/v1.5/pro/image-to-video -- see
// src/config.ts's videoModel) honor a multi-cut, timestamped prompt as genuine
// internal cuts within ONE generated clip, or does it just produce one
// continuous, blended motion? This directly checks a claim from marketing
// copy against the real, documented API schema this codebase already
// confirmed by testing (one image_url, one duration, no scene/cut field) --
// the schema strongly suggests "no", but this is the only way to know for
// certain rather than trusting either source blindly.
//
// SETUP:
//   1. Fill in REFERENCE_IMAGE_URL below with a real keyframe URL from your
//      own R2 bucket (any existing shot's first-frame keyframe works fine).
//   2. node experiments/test-seedance15-multishot.mjs
// -----------------------------------------------------------------------------

import "dotenv/config";
import { fal } from "@fal-ai/client";

const FAL_KEY = process.env.FAL_KEY;
if (!FAL_KEY) {
  console.error("❌ FAL_KEY not found in environment/.env.");
  process.exit(1);
}
fal.config({ credentials: FAL_KEY });

// ---- FILL THIS IN with a real keyframe URL from your own R2 bucket --------
const REFERENCE_IMAGE_URL = ""; // e.g. an existing shot's images/<shotId>.png, already uploaded to R2

// Deliberately mirrors your example prompt's OWN conventions (timestamped
// "cut scene to..." instructions) sent to the SAME endpoint your real
// pipeline uses today -- if this endpoint genuinely supports it, it should
// show up here exactly as clearly as it would in production.
const PROMPT = `
The person stands still, looking around calmly.
At 0 seconds: wide shot, standing still, hands relaxed at sides.
Cut scene to a medium shot at 2 seconds: the person begins walking forward at a natural pace.
Cut scene to a close-up at 4 seconds: a small, natural smile forming on their face.
`.trim();

async function run() {
  if (!REFERENCE_IMAGE_URL) {
    console.error("❌ Fill in REFERENCE_IMAGE_URL at the top of this file with a real R2 keyframe URL first.");
    process.exit(1);
  }

  console.log("▶ Submitting to fal-ai/bytedance/seedance/v1.5/pro/image-to-video (your REAL production model)...");

  try {
    const result = await fal.subscribe("fal-ai/bytedance/seedance/v1.5/pro/image-to-video", {
      input: {
        prompt: PROMPT,
        duration: "6", // ~matches the 3-beat prompt above; real per-shot durations in your pipeline are computed by the compiler
        resolution: "720p",
        aspect_ratio: "16:9",
        camera_fixed: false,
        generate_audio: false,
        image_url: REFERENCE_IMAGE_URL,
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          (update.logs ?? []).forEach((l) => console.log(`   ${l.message}`));
        }
      },
    });

    const url = result?.data?.video?.url ?? result?.data?.video_url ?? result?.data?.url;
    if (!url) {
      console.error("❌ No video URL in response:", JSON.stringify(result?.data ?? result, null, 2));
      process.exit(1);
    }
    console.log(`\n✅ Done -> ${url}`);
    console.log("\nWatch it and judge specifically:");
    console.log("  1. Are there really 3 distinct shots/cuts, or one continuous blended motion?");
    console.log("  2. If it DID cut, is each cut clean (a real edit), or does it morph/smear between framings?");
    console.log("  3. Does the subject's identity/pose stay coherent across whatever it actually produced?");
    console.log("\nIf it's one continuous motion with no real cuts (the likely outcome per the schema),");
    console.log("that CONFIRMS your pipeline's current per-shot architecture is still the right approach on 1.5 Pro.");
  } catch (e) {
    console.error("❌ Request failed:", JSON.stringify(e?.body ?? e?.message ?? e, null, 2));
    process.exit(1);
  }
}

run();
