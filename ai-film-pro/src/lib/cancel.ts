// src/lib/cancel.ts
// -----------------------------------------------------------------------------
// A USER-REQUESTED STOP IS NOT A FAILURE.
//
// Thrown from inside the keyframe (4-images.ts) and clip (5-videos.ts) render
// loops when the caller's isCancelled() check reports the job's
// Job.cancelRequested flag was set (see safa-web's /api/projects/[id]/cancel).
// worker.ts's tick() catches this specifically — same "typed error, special-
// cased by the dispatcher" pattern as ContentRefusedError/BudgetCapExceededError
// — and marks the job "cancelled" rather than "failed": no refund, no
// needs_edit detour, project.status stays exactly where it was so a Resume
// just re-queues the same job type and picks up from whatever was already
// banked (clips bank incrementally as they finish; renderKeyframesPass banks
// whatever's on disk in a finally block regardless of how this loop exits).
// -----------------------------------------------------------------------------

export class JobCancelledError extends Error {
  constructor() {
    super("Job cancelled by user");
    this.name = "JobCancelledError";
    Object.setPrototypeOf(this, JobCancelledError.prototype);
  }
}
