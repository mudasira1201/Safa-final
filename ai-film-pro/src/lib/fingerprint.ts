// src/lib/fingerprint.ts
// -----------------------------------------------------------------------------
// CACHE-BY-SHOT-ID IS UNSAFE ACROSS A CODE OR CONTENT CHANGE.
//
// restoreCachedArtifacts() (worker.ts) exists to save money on a genuine crash
// retry: re-download whatever this project already has in R2 instead of paying
// fal again for identical output. It matches purely by shot id ("s3.png",
// "...-s3.mp4") appearing in the stored URL — safe within ONE unchanged attempt,
// but the SAME shot id is reused every time this project renders again:
// regenerating after a duration change, after a script edit, or simply
// re-running the project after compiler.ts / 4-images.ts / 5-videos.ts / qa.ts /
// DIRECTOR_RULES.json changed. None of that touches breakdown.shots[i].id.
//
// The result: a genuinely improved negative prompt, a stricter QA gate, a new
// director rule — none of it ever reached an existing project's next render.
// The OLD, pre-fix image and clip were silently restored from R2 and skipped
// over, because nothing recorded WHAT CONTENT OR LOGIC actually produced them.
// This is very likely why a regenerated video showed IDENTICAL defects
// (down to a character's face changing shot to shot, exactly the shape of a
// stale keyframe from a since-replaced character sheet) after real fixes had
// already shipped — the only thing that visibly changed was duration, because
// only the newly-added shots (which had no prior cached artifact to restore)
// ever actually rendered under the new code.
//
// FIX: fingerprint each shot with a hash of its own content PLUS the current
// PIPELINE_VERSION. Only restore a cached artifact when the fingerprint on
// file (from this project's last render attempt) matches the shot's CURRENT
// fingerprint. Bump PIPELINE_VERSION any time a change to prompt-building, QA,
// or director rules should force a fresh render everywhere it applies.
// -----------------------------------------------------------------------------

// Bump this string whenever compiler.ts, 4-images.ts, 5-videos.ts, qa.ts/
// qa-runtime.ts, or DIRECTOR_RULES.json changes in a way that should change
// what actually gets rendered. Every project's next render then regenerates
// exactly the shots affected, instead of silently reusing stale artifacts.
export const PIPELINE_VERSION = "2026-07-28.37-clip-qa-checks-against-real-reference-photo";

function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** Every field that feeds a keyframe or clip prompt. If any of these differ from
 *  the last render, the previously produced image/clip no longer matches what
 *  would render today, and must not be silently reused. */
export function shotFingerprint(shot: any): string {
  const key = [
    PIPELINE_VERSION,
    shot?.description, shot?.motion, shot?.setting, shot?.startFrame, shot?.endFrame,
    shot?.camera, shot?.lighting, shot?.dialogue, shot?.duration, shot?.method,
    shot?.crowd, shot?.speaker, shot?.offscreenSpeaker, shot?.negativePrompt,
    (shot?.characters || []).join(","),
    // CONFIRMED REAL GAP, FIXED: ambience feeds 5-videos.ts's clip prompt and
    // props feeds 4-images.ts's keyframe prompt (propText), but neither was
    // fingerprinted — a repair pass that changed only one of these left the
    // fingerprint unchanged, so restoreCachedArtifacts() silently reused the
    // stale pre-change artifact instead of re-rendering.
    shot?.ambience, (shot?.props || []).join(","),
  ].map((v) => String(v ?? "")).join("");
  return fnv1a(key);
}

export function buildFingerprints(breakdown: { shots: any[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of breakdown?.shots ?? []) out[s.id] = shotFingerprint(s);
  return out;
}

/** Best-effort fetch of the fingerprint recorded before this project's LAST
 *  render attempt. Missing/unreadable means "unknown history" — the caller
 *  should treat that as "nothing is safe to restore", not as a free pass. */
export async function fetchPreviousFingerprints(projectId: string): Promise<Record<string, string>> {
  const base = (process.env.R2_PUBLIC_BASE || "").replace(/\/$/, "");
  if (!base) return {};
  try {
    const res = await fetch(`${base}/projects/${projectId}/fingerprint.json`);
    if (!res.ok) return {};
    return (await res.json()) as Record<string, string>;
  } catch {
    return {};
  }
}
