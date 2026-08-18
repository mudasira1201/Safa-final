/**
 * Spoken languages a FILM can be performed in. The web-side mirror of
 * ai-film-pro/src/lib/languages.ts — the two are separate packages with no
 * shared module, so this list is duplicated on purpose rather than imported
 * across the boundary (the same way pricing/plan constants are duplicated).
 *
 * KEEP THE CODES IN SYNC with ai-film-pro's LANGUAGES table. The worker is the
 * authority: it resolves the "[Language: ...]" tag this app writes, and an
 * unrecognised code there is ignored (treated as English) rather than failing
 * the render — so a drift between the two lists degrades to "the film comes out
 * in English", never to a crash.
 *
 * Films only. Ads are voiceover/product-led and are not part of this feature.
 */
export interface UiLanguage {
  code: string;
  /** English name, for the picker's label. */
  name: string;
  /** Endonym, shown alongside so a speaker recognises their own language. */
  native: string;
}

export const FILM_LANGUAGES: UiLanguage[] = [
  { code: "en", name: "English", native: "English" },
  { code: "hi", name: "Hindi", native: "हिन्दी" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ" },
  { code: "ta", name: "Tamil", native: "தமிழ்" },
  { code: "ml", name: "Malayalam", native: "മലയാളം" },
  { code: "ur", name: "Urdu", native: "اردو" },
];

export const DEFAULT_FILM_LANGUAGE = "en";

export const SUPPORTED_LANGUAGES = new Set(FILM_LANGUAGES.map((l) => l.code));
