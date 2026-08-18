// experiments/test-segmind-seedance2.mjs
// -----------------------------------------------------------------------------
// STANDALONE. Does not import anything from src/ and does not touch config.ts
// or providers/video.ts. This is the pre-flight check before wiring Segmind's
// Seedance 2.0 into the real production pipeline as a full replacement for
// Seedance 1.5 Pro on fal.
//
// WHY THIS RUNS FIRST: Segmind's documented request schema confirms
// first_frame_url / last_frame_url / duration / aspect_ratio / generate_audio,
// but does NOT document negative_prompt, camera_fixed, or seed -- three fields
// this pipeline's real prompts depend on (compiler.ts's negativeFor(), the
// close-up camera lock in 5-videos.ts, and the QA retry system's seed+attempt
// pattern). Rather than guess these into production code, this script sends
// ONE real request with best-guess field names and reads back Segmind's own
// error/response to confirm or correct them -- same discipline this codebase
// already uses for every other provider integration (see video.ts's own
// history of confirmed-via-testing field names).
//
// SETUP:
//   1. Get a Segmind API key at segmind.com, then in your terminal (NOT in
//      this file, NOT pasted anywhere):
//        export SEGMIND_API_KEY=your_key_here      (bash)
//        $env:SEGMIND_API_KEY = "your_key_here"     (PowerShell)
//   2. Fill in FIRST_FRAME_URL and (optionally) LAST_FRAME_URL below with real
//      R2 URLs -- an existing shot's keyframe(s) work fine, so the identity/
//      motion quality is directly comparable to what your real pipeline
//      already produces on Seedance 1.5 Pro.
//   3. node experiments/test-segmind-seedance2.mjs
//
// AUTH HEADER: inferred as "x-api-key" from Segmind's OTHER model docs (their
// Gen-4-Turbo reseller page uses this exact header) -- not directly confirmed
// for the Seedance 2.0 endpoint specifically, but Segmind's auth is a
// platform-level convention, not typically per-model. If wrong, the very
// first response will say so (401/403), not fail silently.
// -----------------------------------------------------------------------------

const API_KEY = process.env.SEGMIND_API_KEY;
if (!API_KEY) {
  console.error("❌ Set SEGMIND_API_KEY in your environment first.");
  process.exit(1);
}

// ---- FILL THESE IN with real URLs from your own R2 bucket ------------------
const FIRST_FRAME_URL = "https://pub-3a4f58d716dc4abba5e4950dd3c2d7df.r2.dev/projects/cms67rnew0001ner455w2dyb2/image/shot-02.png";
const LAST_FRAME_URL = "https://pub-3a4f58d716dc4abba5e4950dd3c2d7df.r2.dev/projects/cms67rnew0001ner455w2dyb2/image/shot-02-end.png"; // real two-endpoint pair from "THE MARKET" -- tests FLF for real

const API_BASE = "https://api.segmind.com/v2";
const HEADERS = {
  "x-api-key": API_KEY, // UNVERIFIED for this specific endpoint -- see header comment
  "Content-Type": "application/json",
};

async function createTask() {
  const body = {
    prompt:
      "The person turns their head slightly and speaks, natural expression, cinematic lighting. " +
      // BEST-GUESS field: negative_prompt is undocumented for this endpoint. Sent as a real,
      // separate field first -- if Segmind rejects/ignores it, the fallback below folds it
      // into the prompt text instead, mirroring how video.ts already handles Seedance 1.5
      // Pro's confirmed-absent negative_prompt field ("AVOID: ..." suffix).
      "",
    negative_prompt: "cartoon, cgi, deformed hands, extra limbs, duplicate person, watermark, text, background music, soundtrack",
    first_frame_url: FIRST_FRAME_URL,
    ...(LAST_FRAME_URL ? { last_frame_url: LAST_FRAME_URL } : {}),
    duration: 6, // number, per Segmind's documented allowed set (4/5/6/8/10/12/15)
    resolution: "720p", // UNVERIFIED param name -- fal.ai and most resellers use this exact name, best guess here too
    aspect_ratio: "16:9",
    generate_audio: false, // keep the smoke test simple/cheap
    camera_fixed: false, // UNVERIFIED field -- if Segmind rejects it, this needs to move into prompt text instead
    seed: 12345, // UNVERIFIED field -- if ignored/rejected, the QA retry system's seed+attempt pattern won't transfer as-is
  };

  console.log("▶ Submitting to Segmind Seedance 2.0 (POST /v2/seedance-2.0)...");
  const res = await fetch(`${API_BASE}/seedance-2.0`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`❌ Request rejected (${res.status}). READ THIS CAREFULLY -- it will likely name exactly`);
    console.error(`   which of the UNVERIFIED fields above (negative_prompt/resolution/camera_fixed/seed) is wrong:`);
    console.error(JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log(`   request_id: ${json.request_id}`);
  return json.request_id;
}

async function pollTask(id) {
  for (let i = 0; i < 90; i++) {
    const res = await fetch(`${API_BASE}/requests/${id}/status`, { headers: HEADERS });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`❌ Poll failed (${res.status}):`, JSON.stringify(json, null, 2));
      return null;
    }
    if (json.status === "COMPLETED") {
      const result = await fetch(`${API_BASE}/requests/${id}`, { headers: HEADERS });
      const resultJson = await result.json().catch(() => ({}));
      console.log("\n✅ Done. Full result payload (to confirm the REAL response shape / video URL field):");
      console.log(JSON.stringify(resultJson, null, 2));
      return resultJson;
    }
    if (json.status === "FAILED") {
      console.error("❌ Generation failed:", JSON.stringify(json, null, 2));
      return null;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.error("\n⚠️  Gave up polling after ~7.5 minutes.");
  return null;
}

async function run() {
  if (!FIRST_FRAME_URL) {
    console.error("❌ Fill in FIRST_FRAME_URL at the top of this file with a real R2 keyframe URL first.");
    process.exit(1);
  }
  const id = await createTask();
  if (id) await pollTask(id);

  console.log("\nAfter this runs, report back exactly what happened for each UNVERIFIED field:");
  console.log("  - Did negative_prompt work, get ignored, or cause a rejection?");
  console.log("  - Was resolution accepted at '720p' as-written?");
  console.log("  - Was camera_fixed accepted, or silently ignored?");
  console.log("  - Was seed honored (rerun with a different seed and compare output), or ignored?");
  console.log("  - What's the EXACT key the video URL appears under in the result payload above?");
}

run();
