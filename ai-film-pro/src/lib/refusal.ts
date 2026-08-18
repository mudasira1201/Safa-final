// src/lib/refusal.ts
// -----------------------------------------------------------------------------
// A CONTENT REFUSAL IS NOT A BUG — IT IS A CONVERSATION WITH THE USER.
//
// When fal's image or video model declines a prompt on content grounds, retrying
// is pointless: identical text is refused identically, forever. But it is also not
// a dead end — the user can rewrite that one beat and everything else in the film
// is still valid and already paid for.
//
// So a refusal is thrown as THIS error rather than a plain one. It carries the
// shot id and which stage refused, which lets the worker park the project in
// "needs_edit" with a precise, actionable message instead of a generic failure,
// and lets the UI point the user at the exact beat to change.
// -----------------------------------------------------------------------------

export type RefusalStage = "keyframe" | "clip";

export class ContentRefusedError extends Error {
  readonly shotId: string;
  readonly stage: RefusalStage;
  /** The prompt text that was refused, trimmed — shown to the user for context. */
  readonly refusedText: string;

  constructor(shotId: string, stage: RefusalStage, refusedText: string) {
    super(
      `Shot "${shotId}" was refused by the ${stage === "clip" ? "video" : "image"} provider on content grounds, ` +
        `so this film cannot be rendered as written. Rewrite this beat to work through implication — a reaction, ` +
        `an aftermath, a mark left behind — rather than depicting the moment directly. Everything else in the film ` +
        `is saved, so only this shot will be re-rendered.`,
    );
    this.name = "ContentRefusedError";
    this.shotId = shotId;
    this.stage = stage;
    this.refusedText = (refusedText || "").slice(0, 300);
    // Required when targeting ES5/ES2015 downlevel so `instanceof` keeps working.
    Object.setPrototypeOf(this, ContentRefusedError.prototype);
  }
}

// toDetail()/parseRefusalDetail() used to live here — a JSON serialization of
// this error meant for the UI to parse back into a targeted "edit this beat"
// prompt. DEAD CODE, REMOVED: nothing in safa-web ever actually imported
// parseRefusalDetail() to do that. worker.ts wrote the raw JSON straight into
// Project.error, and the UI renders that field verbatim as plain text
// everywhere (ErrorNotice) — so a real content refusal was showing users raw
// JSON instead of a message. worker.ts now writes `.message` directly.