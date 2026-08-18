// ==========================================================
// PUT THIS FILE AT:  safa-web/lib/falClient.ts   *** NEW FILE ***
// ==========================================================
// Shared fal client for safa-web. Uses the SAME FAL_KEY you already use in the
// pipeline. Used for uploading product images to fal storage (free — fal only
// charges for model inference, not file storage).
import { fal } from "@fal-ai/client";

if (process.env.FAL_KEY) {
  fal.config({ credentials: process.env.FAL_KEY });
}

export { fal };