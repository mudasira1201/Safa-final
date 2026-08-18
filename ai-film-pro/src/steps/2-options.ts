import { config, runtime } from "../config";
import { generateImages } from "../providers/image";
import { readJson, writeJson, downloadToFile, fileExists, isMain } from "../util";
import { runBreakdown } from "./1-breakdown";
import { logSpend, costOfImages } from "../spend";
import type { Breakdown, Selections, Character } from "../types";
import { mapLimit, CONCURRENCY } from "../concurrency";

export async function runOptions(projectId = "local", userId?: string): Promise<Selections> {
  const sel = `${runtime.outDir}/selections.json`;
  if (await fileExists(sel)) {
    console.log(
      "\ud83c\udfad Character options already generated (skipping).\n" +
        "   \u2192 Open output/characters/options/ and pick your favorite for each character,\n" +
        "   \u2192 set its number in output/selections.json (the \"chosen\" field), then run `npm run film`.\n" +
        "   (Delete output/selections.json to regenerate options.)"
    );
    return readJson<Selections>(sel);
  }

  // Make sure the breakdown exists first (it's cached, so this is a no-op if already done).
  await runBreakdown();

  const breakdown = await readJson<Breakdown>(`${runtime.outDir}/breakdown.json`);
  const selections: Selections = {};

/**
 * WHAT SEX IS THIS CHARACTER? — stated explicitly, from data we already hold.
 *
 * "appearance" never required gender, and the option prompt used appearance
 * ALONE, never the character's name. So a character called "Woman Courier"
 * reached the image model as "30s, dark trench coat, soaked, dark hair" — with
 * no gender marker at all. Given a trench coat, gloves and a briefcase the model
 * defaulted to a man, and every downstream shot inherited him via the character
 * sheet.
 *
 * Two signals, checked in order of reliability:
 *   1. the voice archetype the director assigned (male_adult, female_young, …)
 *   2. gendered words in the character's NAME or appearance text
 */
function genderLock(char: { name: string; appearance: string; voice?: string }): string {
  const v = (char.voice || "").toLowerCase();
  if (v.startsWith("female")) return "This character is a WOMAN. ";
  if (v.startsWith("male")) return "This character is a MAN. ";
  if (v === "child") return "This character is a CHILD. ";

  const hay = `${char.name} ${char.appearance}`.toLowerCase();
  // TWO TIERS, NOT ONE. Confirmed on real test text: a character described as
  // "a stern old man ... who spoke fondly of his late wife" was locked to
  // WOMAN by the old single-tier check, because "wife" matched the woman-word
  // list — even though "man" and "his" both correctly identify HIM. A KINSHIP
  // NOUN (wife/husband/mother/father/son/daughter/sister/brother/mr/mrs/ms/miss)
  // names a RELATIVE, not necessarily the character being described — "his
  // wife" tells you about a different person entirely. A DIRECT term
  // (woman/man/female/male/girl/boy/lady/gentleman/actress) or a gendered
  // PRONOUN referring to the subject (she/her/he/him/his) remains reliable
  // even in exactly these relationship-mentioning sentences, since "his wife"
  // grammatically still means "the wife belonging to a male person" — the
  // pronoun itself stays correct even when the noun next to it does not.
  // So: direct/pronoun signals are checked FIRST and win outright; kinship
  // nouns are only consulted as a last-resort fallback when nothing else
  // matched at all.
  const WOMAN_DIRECT = /\b(woman|female|girl|lady|actress|she|her|hers)\b/;
  const MAN_DIRECT = /\b(man|male|boy|gentleman|he|him|his)\b/;
  const WOMAN_RELATION = /\b(mother|mrs|ms|miss|daughter|sister|wife)\b/;
  const MAN_RELATION = /\b(father|mr|son|brother|husband)\b/;
  if (WOMAN_DIRECT.test(hay)) return "This character is a WOMAN. ";
  if (MAN_DIRECT.test(hay)) return "This character is a MAN. ";
  if (WOMAN_RELATION.test(hay)) return "This character is a WOMAN. ";
  if (MAN_RELATION.test(hay)) return "This character is a MAN. ";
  return "";
}

  // PARALLEL ACROSS CHARACTERS — same reasoning as 2b-location-options.ts's own
  // comment: each character's look-options are an independent prompt writing to
  // its own folder and its own `selections` entry (keyed by char.id, so arrival
  // order does not matter). `idx` is still the character's ARRAY position, which
  // is what the uploaded-photo matching below depends on, so that pairing is
  // unaffected by running these concurrently.
  await mapLimit([...breakdown.characters.entries()] as [number, Character][], CONCURRENCY, async ([idx, char]) => {
    // UPLOADED CHARACTER PHOTO \u2014 matched to breakdown.characters BY ARRAY
    // ORDER (1st uploaded photo -> 1st character in script order), same
    // "flat list, no explicit tagging" simplicity runtime.productImages
    // already uses. A character with a matching upload skips AI generation
    // entirely \u2014 same "the real photo IS the reference, never a regenerated
    // approximation of it" discipline 3-sheet.ts's angle-0 reuse already
    // established for the CHOSEN photo; this just moves that discipline one
    // step earlier, to the choice itself.
    const uploaded = runtime.characterImages[idx];
    if (uploaded) {
      console.log(`\ud83c\udfad Using your uploaded photo for ${char.name} (skipping AI-generated options).`);
      selections[char.id] = { name: char.name, chosen: 1, options: [uploaded] };
      return; // `continue` in the old for-loop — this is now a mapLimit callback
    }

    console.log(`\ud83c\udfad Generating ${config.optionsCount} look-options for ${char.name}...`);
    // Gender goes FIRST, before any wardrobe. Clothing and props carry strong
    // gender associations of their own (a trench coat and a briefcase read male),
    // so the instruction has to land before the model starts inferring.
    const prompt =
      `Full-body character reference photo, photorealistic, shot on 35mm film, natural skin texture. ` +
      `${genderLock(char)}${char.appearance}. Neutral expression, standing, plain neutral studio background, ` +
      `even soft lighting, looking at camera, sharp focus. NOT cartoon, NOT 3D render.`;
    const urls = await generateImages(prompt, config.optionsCount, "3:4");
    // COST TRACKING GAP (now fixed): these config.optionsCount real Nano Banana
    // generations were a real cost the moment generateImages() paid for them,
    // but nothing recorded it -- only shot keyframes, clips, and the character
    // sheet were logged via logSpend(), so checkCaps()'s budget enforcement
    // silently undercounted every project by this amount.
    await logSpend("image", { userId, projectId, units: urls.length, amountUsd: costOfImages(urls.length) });
    let n = 0;
    for (const url of urls) {
      n++;
      await downloadToFile(url, `${runtime.outDir}/characters/options/${char.id}/opt-${n}.png`);
    }
    selections[char.id] = { name: char.name, chosen: 1, options: urls };
  });

  await writeJson(sel, selections);
  console.log(
    `\n\u2705 Options ready in output/characters/options/.\n` +
      `   \u2192 Look at them, then set the winning number per character in output/selections.json ("chosen").\n` +
      `   \u2192 Then run \`npm run film\` to build the sheet and the movie. (Defaults to option 1 if you skip this.)`
  );
  return selections;
}

if (isMain(import.meta.url)) {
  runOptions().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}