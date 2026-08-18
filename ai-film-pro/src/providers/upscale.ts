import { fal } from "../falClient";
import { config, runtime, targetDimensions } from "../config";
import { withTimeout } from "../util";

// fal.subscribe() has no built-in timeout — see util.ts's withTimeout().
// Video upscaling runs on the same order of magnitude as generation itself.
const UPSCALE_TIMEOUT_MS = 10 * 60_000;

/**
 * TOPAZ VIDEO AI UPSCALER (via fal.ai) — reaches a 720p/1080p DELIVERY tier
 * from a 480p GENERATION render (see runtime.generationResolution's own
 * comment in config.ts). REAL, CONFIRMED via a live test call against an
 * actual Seedance 480p output, not guessed:
 *   - Real endpoint: fal-ai/topaz/upscale/video (confirmed via fal's own
 *     OpenAPI schema, fetched directly — the docs page itself was
 *     rate-limited, same 429 this codebase's other provider integrations
 *     have hit before; the raw schema endpoint was not).
 *   - Real input shape: { video_url, model, upscale_factor, H264_output,
 *     ...optional quality knobs (compression/noise/halo/grain/recover_detail,
 *     all left at provider defaults — untested territory, no reason to guess
 *     at better values than Topaz's own per-model defaults). }
 *   - Real output shape: { video: { url, content_type, file_name, file_size } }.
 *   - upscale_factor is a LINEAR multiplier (1-4), not a target resolution —
 *     confirmed by test: requesting 2.25 on an 864x496 source produced an
 *     exact 1944x1116 result (864*2.25=1944, 496*2.25=1116). Real pixel
 *     dimensions from Topaz will not land exactly on a standard delivery
 *     size, so the result still passes through 6-assemble.ts's own
 *     normalizeClip() scale/pad pass same as any other clip.
 *   - Result codec confirmed h264 (H264_output:true respected; Topaz's own
 *     default is H265, which this pipeline's ffmpeg chain doesn't need to
 *     rely on decoding when an explicit, well-supported alternative exists).
 *   - Visually verified by extracting and inspecting a frame: genuine added
 *     texture detail, no warping or smearing artifacts, not just a blurry
 *     stretch — a real quality upscale, not a placebo pass.
 *   - model: "Proteus" (the provider's own general-purpose default) — the
 *     right choice for this pipeline's own content: not degraded/noisy
 *     footage (Artemis), not rendered/CG content (Gaia), not animation
 *     (Gaia 2) — Proteus is Topaz's documented fit for ordinary footage,
 *     which is exactly what Seedance's photorealistic output is.
 */

export interface UpscaleResult {
  url: string;
  /** Real linear multiplier actually sent to Topaz — logged for cost
   *  accounting (see spend.ts's costOfUpscale, priced by the DELIVERY
   *  resolution tier, not this factor directly, but useful to have on hand
   *  for debugging a wrong-looking result). */
  upscaleFactor: number;
}

/** Real Topaz pricing tiers (see spend.ts's costOfUpscale) key off the
 *  DELIVERY resolution, not the linear factor — this only computes the
 *  factor Topaz itself needs, clamped to its own documented 1-4 range. */
function computeUpscaleFactor(): number {
  const from = targetDimensions(runtime.generationResolution);
  const to = targetDimensions(runtime.resolution);
  const factor = to.h / from.h;
  const clamped = Math.min(4, Math.max(1, Math.round(factor * 100) / 100));
  // DEFENSIVE: a factor that needed clamping means generationResolutionFor()
  // (config.ts) picked a generation base too low for this delivery tier — an
  // under-delivered result (e.g. a "4K" file that's actually only 1920px
  // tall) would otherwise ship completely silently. Confirmed this exact
  // failure shape before generationResolutionFor() existed: 480p->4k needed
  // a 4.5x factor, over Topaz's 4x cap, silently clamped with no warning
  // anywhere. This log is the backstop if a FUTURE resolution tier is ever
  // added without also updating that function.
  if (Math.abs(clamped - factor) > 0.01) {
    console.warn(
      `   ⚠️  upscale factor ${factor.toFixed(2)}x (${runtime.generationResolution} → ${runtime.resolution}) ` +
      `exceeds Topaz's 1-4x range and was clamped to ${clamped}x — the delivered file will be SMALLER than the ` +
      `requested ${runtime.resolution} tier. Raise the generation resolution for this delivery tier in ` +
      `generationResolutionFor() (config.ts).`,
    );
  }
  return clamped;
}

/** Upscales one already-finished clip from generation resolution to delivery
 *  resolution. Callers decide WHEN to call this — see 5-videos.ts, which
 *  only calls it on the FINAL accepted clip after QA has settled, never on
 *  a re-rolled attempt, so a shot that needed 3 QA retries is never
 *  upscaled 3 times over. */
export async function upscaleVideo(videoUrl: string): Promise<UpscaleResult> {
  const upscale_factor = computeUpscaleFactor();
  const input = {
    video_url: videoUrl,
    model: "Proteus",
    upscale_factor,
    H264_output: true,
  };
  try {
    const r: any = await withTimeout(fal.subscribe(config.upscaleModel, { input }), UPSCALE_TIMEOUT_MS, "video upscale");
    const url = r?.data?.video?.url;
    if (typeof url !== "string" || !url) {
      throw new Error(`Unexpected response shape from ${config.upscaleModel}: ${JSON.stringify(r?.data ?? r).slice(0, 500)}`);
    }
    return { url, upscaleFactor: upscale_factor };
  } catch (e: any) {
    console.error(`\n❌ Topaz upscale (${runtime.generationResolution} → ${runtime.resolution}, factor ${upscale_factor}) rejected the request. Actual reason:`);
    console.error(JSON.stringify(e?.body ?? e?.response?.data ?? e?.message ?? e, null, 2));
    throw e;
  }
}
