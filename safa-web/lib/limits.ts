/**
 * Input-size limits shared by the composer UI and the API route.
 *
 * These live here, in ONE place, because they were previously duplicated as
 * separate hardcoded literals in CreateFlow.tsx and app/api/projects/route.ts.
 * Two copies of a validation threshold drift: the client can start allowing a
 * script the server then rejects, which shows the user a hard error at the exact
 * moment they hit Generate instead of while they were still writing.
 */

/**
 * Longest script accepted, in characters.
 *
 * RAISED 10,000 -> 50,000. The old value was arbitrary — nothing downstream
 * required it. `Project.script` is Postgres `@db.Text` (no length limit), and
 * the director prompt hands the script to gpt-4.1, where even a
 * 50,000-character screenplay is ~12,500 tokens: a rounding error against that
 * model's context window. Meanwhile a real, per-shot 4-minute shot list runs
 * about 15,000 characters, so genuine feature-quality input was being refused
 * outright with no way around it.
 *
 * 50,000 is sized to the pipeline's own ceiling rather than picked as a round
 * number: sanitizeSettings() clamps a film to 600 seconds, and a script written
 * at the density of a real per-shot breakdown (~60 characters of script per
 * second of finished film) reaches roughly 37,000 characters at that length.
 * This leaves headroom above the longest film the pipeline will actually render,
 * while still bounding an accidental paste of something enormous.
 */
export const MAX_SCRIPT_CHARS = 50000;

/** Shortest accepted script for a narrative film or a song-video theme. */
export const MIN_SCRIPT_CHARS = 40;

/** Ads take a much shorter brief — "create an ad for this product" is ~31
 *  characters, and a bare product name is fewer still. */
export const MIN_AD_SCRIPT_CHARS = 10;
