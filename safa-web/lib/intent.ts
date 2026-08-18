import OpenAI from "openai";

const client = process.env.LLM_API_KEY ? new OpenAI({ apiKey: process.env.LLM_API_KEY }) : null;

// "proceed" = the user is not asking for a CHANGE at all, they are asking the
// pipeline to CARRY ON to the next stage ("shots are done, now make the clips").
// Without this the message fell through to "reply" and the model improvised a
// clarifying question, which reads as the app not understanding plain English.
export type Intent = {
  action: "regen_clip" | "regen_all" | "proceed" | "reply";
  clipNumber: number | null;
  note: string;
  reply: string;
};

export async function parseIntent(message: string, clips: { label: string }[]): Promise<Intent> {
  if (!client) return heuristic(message);
  try {
    const clipList = clips.map((c, i) => `${i + 1}. ${c.label}`).join("\n");
    const res = await client.chat.completions.create({
      model: process.env.LLM_MODEL || "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
`You help a user edit their AI-generated film via chat. The film currently has these clips:
${clipList || "(no clips yet)"}

Read the user's message and respond ONLY as JSON:
{ "action": "regen_clip" | "regen_all" | "proceed" | "reply", "clipNumber": <1-based clip number or null>, "note": "<the specific visual change, phrased as an instruction>", "reply": "<one short friendly sentence to show the user>" }

Rules:
- "regen_clip": user wants to change ONE specific clip/shot -> set clipNumber, put the change in note.
- "regen_all": user wants to change the WHOLE film (e.g. "make it all nighttime") -> clipNumber null, change in note.
- "proceed": user is NOT asking for any change. They are telling you to carry on to the next stage: continue, go ahead, start generating the clips, render the film, keep going, next step. -> clipNumber null, note empty. This is very common right after the shot list is created and there are no clips yet.
- "reply": it's a question, greeting, or too vague -> put a helpful/clarifying sentence in reply, note empty.
- A message that asks to re-do or change something that ALREADY exists is a regen, never "proceed".
- Keep reply short and friendly, e.g. "Sure, regenerating clip 2 to make it nighttime." or "Starting the clip generation now."
- Plain punctuation only: never use em dashes in reply.`,
        },
        { role: "user", content: message },
      ],
    });
    const j = JSON.parse(res.choices[0]?.message?.content || "{}");
    const action = ["regen_clip", "regen_all", "proceed", "reply"].includes(j.action) ? j.action : "reply";
    return {
      action,
      clipNumber: Number.isInteger(j.clipNumber) ? j.clipNumber : null,
      note: typeof j.note === "string" ? j.note : "",
      reply: typeof j.reply === "string" && j.reply ? j.reply : "On it.",
    };
  } catch {
    return heuristic(message);
  }
}

// A message is "proceed" only when it asks to CARRY ON. Anything that asks to redo
// or alter existing work is a regeneration, so those words veto it.
const PROCEED_RE =
  /\b(continue|proceed|go ahead|carry on|keep going|next step|start (?:the )?(?:clip|render|generation)|begin (?:the )?(?:clip|render)|generate (?:the )?clips?|make (?:the )?clips?|render (?:the )?(?:clips?|film|video))\b/;
const REDO_RE = /\b(again|re-?generate|re-?render|re-?do|redo|change|instead|different)\b/;

function heuristic(message: string): Intent {
  const m = message.toLowerCase();

  const num = m.match(/(?:clip|shot|scene)\s*#?\s*(\d+)/);
  if (num) {
    const n = parseInt(num[1], 10);
    return { action: "regen_clip", clipNumber: n, note: message, reply: `Regenerating clip ${n} with your change…` };
  }

  // Checked BEFORE the "whole film" branch: "generate the clips" and "render the
  // film" both contain film/clip words and would otherwise be read as a re-render.
  if (PROCEED_RE.test(m) && !REDO_RE.test(m)) {
    return { action: "proceed", clipNumber: null, note: "", reply: "Starting the clip generation now." };
  }

  if (/\b(all|whole|entire|everything)\b/.test(m)) {
    return { action: "regen_all", clipNumber: null, note: message, reply: "Regenerating the whole film with your change…" };
  }

  return { action: "reply", clipNumber: null, note: "", reply: 'Which clip should I change? Try e.g. "make clip 2 nighttime" or "make the whole film brighter".' };
}