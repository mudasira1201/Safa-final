// Single source of truth for project statuses.
// Every status the web app or worker can set must have an entry here,
// so no raw internal value ever reaches the UI.
export type StatusTone = "draft" | "working" | "waiting" | "done" | "failed";

export const STATUS: Record<string, { label: string; tone: StatusTone; polls: boolean }> = {
  draft: { label: "Draft", tone: "draft", polls: false },
  generating_breakdown: { label: "Planning your shots", tone: "working", polls: true },
  breakdown_review: { label: "Shots ready for your review", tone: "waiting", polls: false },
  generating_options: { label: "Designing characters", tone: "working", polls: true },
  awaiting_selection: { label: "Waiting for your character pick", tone: "waiting", polls: false },
  generating_shots: { label: "Filming your clips", tone: "working", polls: true },
  clips_review: { label: "Clips ready for your review", tone: "waiting", polls: false },
  needs_edit: { label: "Needs a script edit before continuing", tone: "waiting", polls: false },
  assembling: { label: "Stitching the final film", tone: "working", polls: true },
  done: { label: "Ready", tone: "done", polls: false },
  failed: { label: "Failed", tone: "failed", polls: false },
};

export const statusLabel = (s: string) => STATUS[s]?.label ?? "In progress";
export const statusWorking = (s: string) => (STATUS[s]?.tone ?? "working") === "working";
