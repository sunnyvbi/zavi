import { decodeXmlEntities } from "@/services/onboarding/enrichment/sanitize";

export const LOGO_TYPES = ["monogram", "pictorial", "abstract", "mascot", "emblem", "wordmark"] as const;
export type LogoType = (typeof LOGO_TYPES)[number];

export const LOGO_STYLES = ["geometric", "monoline", "negative-space", "solid-silhouette", "organic", "lettering"] as const;
export type LogoStyle = (typeof LOGO_STYLES)[number];

export const LOGO_TYPE_GUIDE: Readonly<Record<LogoType, { fits: string; drawn: string }>> = {
  monogram: {
    fits: "a long or multi-word name, professional services (law, finance, consulting, architecture), luxury and fashion, or a founder who asked for initials",
    drawn: "one to three letterforms interlocked, mirrored or carved so they read as one shape, with deliberate negative space",
  },
  pictorial: {
    fits: "a business with one ownable object or scene customers already associate with it (cafe, florist, pet care, bakery, bike shop, boats, books)",
    drawn: "a single recognisable object simplified to its silhouette, with one unexpected twist so it is not the stock icon",
  },
  abstract: {
    fits: "software, platforms, finance, health or any service with no single object to show, or a brand that wants to feel modern and open to growth",
    drawn: "two or three geometric forms whose relationship implies the promise (motion, connection, growth, care, precision)",
  },
  mascot: {
    fits: "kids, food and drink, sports, pets, entertainment or any brand whose tone is playful and friendly",
    drawn: "one character reduced to a few flat shapes with a clear face or gesture, no fine detail",
  },
  emblem: {
    fits: "heritage, craft, outdoors, breweries and roasters, schools, clubs and anything that trades on tradition",
    drawn: "a symbol inside one simple containing shape (circle, shield, hexagon), kept bold enough to survive at 32 px",
  },
  wordmark: {
    fits: "only when the founder explicitly asks for lettering; the site already prints the name as text beside the mark",
    drawn: "the exact name in custom lettering with one distinctive detail",
  },
};

export const LOGO_STYLE_GUIDE: Readonly<Record<LogoStyle, string>> = {
  geometric: "constructed from circles, squares and exact angles; even weights; mathematical balance",
  monoline: "a single consistent stroke weight, rounded joins, open shapes, no fills",
  "negative-space": "a second meaning revealed by the space inside or between the solid shapes",
  "solid-silhouette": "bold filled forms with no outlines, readable as a stamp",
  organic: "soft, hand-shaped curves with natural asymmetry, still simplified",
  lettering: "custom letterforms with one distinctive detail",
};

const LETTERS = /^[A-Z0-9&]{1,3}$/;

export type LogoDesignSpec = {
  type: LogoType;
  subject: string;
  concept: string;
  style: LogoStyle;
  rationale: string;
  avoid: string[];
  letters?: string;
  palette_note?: string;
  source: "founder" | "heuristic";
};

export type LogoDesignInput = {
  site_name: string;
  business: string;
  direction?: string | null;
  industry?: string | null;
  mood?: string | null;
  audience?: string | null;
  positioning?: string | null;
  primary?: string | null;
  accent?: string | null;
};

export const LOGO_PLACEHOLDER_NAME = "this business";
export const LOGO_RENDER_PROMPT_MAX = 1000;

export function logoInitials(siteName: string): string {
  const firsts = siteName
    .split(/[\s&/+-]+/)
    .map((w) => w.match(/[a-z0-9]/i)?.[0] ?? "")
    .filter(Boolean);
  return firsts.slice(0, 2).join("").toUpperCase();
}

export function hasRealLogoName(siteName: string | null | undefined): boolean {
  const name = String(siteName ?? "").trim();
  return name.length > 0 && name.toLowerCase() !== LOGO_PLACEHOLDER_NAME && logoInitials(name).length > 0;
}

const NEGATED = /\b(no|not|without|avoid|never|don't|do not|instead of|rather than)\b[^.;!?]{0,48}$/i;
const CLAUSE_BREAK = /[.;!?]|,\s*(?=(?:use|draw|make|give|go with|just|only|but|rather|instead|i want|we want|prefer|(?:an?|the)\s+(?:abstract|geometric|mascot|character|badge|emblem|crest|monogram|wordmark))\b)/i;

function asked(direction: string, pattern: RegExp): boolean {
  for (const clause of direction.split(CLAUSE_BREAK)) {
    for (const m of clause.matchAll(pattern)) {
      if (!NEGATED.test(clause.slice(Math.max(0, m.index! - 56), m.index))) return true;
    }
  }
  return false;
}

export function directedLogoType(direction: string | null | undefined): LogoType | null {
  const d = decodeXmlEntities(String(direction ?? ""));
  if (asked(d, /\b(word ?mark|logotype|lettering|the name (written|set|spelled))/gi)) return "wordmark";
  if (asked(d, /\b(monogram|initials|letter ?mark)\b/gi)) return "monogram";
  if (asked(d, /\b(mascot|character|cartoon)\b/gi)) return "mascot";
  if (asked(d, /\b(emblem|badge|crest|stamp)\b/gi)) return "emblem";
  if (asked(d, /\b(abstract|geometric mark|geometric shapes?)\b/gi)) return "abstract";
  return null;
}

function logoLettersFor(input: Pick<LogoDesignInput, "site_name" | "direction">): string {
  if (directedLogoType(input.direction) === "monogram") {
    for (const clause of decodeXmlEntities(String(input.direction ?? "")).split(CLAUSE_BREAK)) {
      const assignments = /\b(?:initials?|letters?|monogram)\s*(?:[:=]\s*|(?:of|are|as|with)\s+)?(["“']?)([a-z0-9&]{1,3})(?=["”'\s.,;!?]|$)/gi;
      for (const match of clause.matchAll(assignments)) {
        if (NEGATED.test(clause.slice(Math.max(0, match.index! - 56), match.index))) continue;
        const raw = match[2]!;
        const letters = raw.toUpperCase();
        if (LETTERS.test(letters) && (match[1] || (raw === letters && !/^(ON|BUT|MY|USE|OF|IN|OUR|THE|AND|FOR|A|AN|AS|TO|NO|NOT|DO)$/.test(raw)))) return letters;
      }
    }
  }
  return logoInitials(input.site_name);
}

const PICTORIAL_HINTS: ReadonlyArray<{ words: RegExp; subject: string; avoid: string }> = [
  { words: /\b(cafe|café|coffee|espresso|roaster)/i, subject: "a coffee cup whose steam curls into one extra meaning", avoid: "a plain mug icon" },
  { words: /\b(bakery|bread|pastry|patisserie|cake|dessert)/i, subject: "a loaf, croissant or wheat ear reduced to one clean silhouette", avoid: "a chef hat" },
  { words: /\b(florist|flowers?|garden|nursery|plants?|landscap)/i, subject: "a single bloom or leaf built from two or three shapes", avoid: "a generic leaf" },
  { words: /\b(?:pets?\b|dogs?\b|cats?\b|vets?\b|veterinar|groom)/i, subject: "one animal silhouette with a single telling gesture", avoid: "a paw print" },
  { words: /\b(bike|bicycle|cycling)/i, subject: "a wheel or frame line that doubles as a path", avoid: "a full bicycle" },
  { words: /\b(restaurant|kitchen|chef|dining|catering|food truck)/i, subject: "one signature dish or utensil shape with a twist", avoid: "crossed fork and knife" },
  { words: /\b(photograph|photo|studio|camera)/i, subject: "an aperture or frame shape that forms a second object", avoid: "a camera icon" },
  { words: /\b(?:yoga|pilates|wellness|spas?\b|massage|meditat)/i, subject: "a calm figure or lotus reduced to balanced curves", avoid: "a stock lotus" },
  { words: /\b(?:gyms?\b|fitness|crossfit|training|coach)/i, subject: "a rising form that implies strength and momentum", avoid: "a dumbbell" },
  { words: /\b(dent|clinic|doctor|medical|health|physio|therapy)/i, subject: "a protective or caring form, soft geometry, no cross", avoid: "a red cross or heartbeat line" },
  { words: /\b(?:realtor|property|homes?\b|roof|construction|builder|plumb|electric)/i, subject: "a roofline or structural angle that forms an initial or arrow", avoid: "a house icon" },
  { words: /\b(boat|marine|sail|fishing|harbor|harbour|coast|beach|surf)/i, subject: "a wave, sail or hull line drawn as one stroke", avoid: "an anchor" },
  { words: /\b(?:books?\b|bookshop|library|tutor|school|academy|learning|courses?\b)/i, subject: "an open page or path that reads as growth", avoid: "a graduation cap" },
  { words: /\b(?:music|bands?\b|records?\b|recording|dj\b|sound\b)/i, subject: "a waveform or note shape that forms a second object", avoid: "a plain music note" },
  { words: /\b(?:cars?\b|auto\b|automotive|detailing|garage|mechanic|tyres?\b|tires?\b)/i, subject: "a speed line or wheel arc with precise geometry", avoid: "a car side view" },
  { words: /\b(?:travel|tours?\b|tourism|trips?\b|adventure|hiking|outdoor|camps?\b|camping)/i, subject: "a horizon, peak or trail line with one focal point", avoid: "a generic mountain" },
];

const MONOGRAM_WORDS = /\b(?:law\b|lawyer|legal|attorney|account|tax\b|finance|financial|wealth|invest|consult|advisory|architect|interior|jewel|couture|atelier|boutique|estate)/i;
const ABSTRACT_WORDS = /\b(?:software|saas|apps?\b|platform|ai\b|data\b|analytics|cloud|tech\b|technology|startup|fintech|marketplace|logistics|network|security|automation|agency|marketing)/i;
const PLAYFUL_WORDS = /\b(?:kids\b|children|toys?\b|party|parties|ice cream|candy|arcade|games?\b|comics?\b|fun\b)/i;
const HERITAGE_WORDS = /\b(brew|brewery|distill|whisk|roast|heritage|since 1|craft|club|lodge|ranch|farm|vineyard|winery)/i;

export function heuristicLogoDesign(input: LogoDesignInput): LogoDesignSpec {
  const business = `${input.business} ${input.industry ?? ""}`.trim();
  const named = hasRealLogoName(input.site_name);
  const directed0 = directedLogoType(input.direction);
  const directed = directed0 === "wordmark" || (!named && directed0 === "monogram") ? null : directed0;
  const direction = directed0 === "wordmark" ? "" : decodeXmlEntities(String(input.direction ?? "")).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  const initials = logoLettersFor(input);
  const base = { avoid: ["clip art", "generic icons", "gradients"], source: directed || direction ? ("founder" as const) : ("heuristic" as const) };
  if (directed === "monogram") {
    return { ...base, type: "monogram", style: "negative-space", letters: initials, subject: `the letters ${initials}`, concept: direction, rationale: "The founder asked for a monogram." };
  }
  if (directed === "mascot") {
    return { ...base, type: "mascot", style: "solid-silhouette", subject: direction, concept: direction, rationale: "The founder asked for a character." };
  }
  if (directed === "emblem") {
    return { ...base, type: "emblem", style: "solid-silhouette", subject: direction, concept: direction, rationale: "The founder asked for a badge." };
  }
  if (directed === "abstract") {
    return { ...base, type: "abstract", style: "geometric", subject: direction, concept: direction, rationale: "The founder asked for an abstract mark." };
  }
  if (direction) {
    return { ...base, type: "pictorial", style: "solid-silhouette", subject: direction, concept: direction, rationale: "Drawn from the founder's own description." };
  }
  const hint = PICTORIAL_HINTS.find((h) => h.words.test(business));
  if (hint && !MONOGRAM_WORDS.test(business) && !ABSTRACT_WORDS.test(business)) {
    const playful = PLAYFUL_WORDS.test(business);
    const heritage = HERITAGE_WORDS.test(business);
    return {
      ...base,
      type: heritage ? "emblem" : "pictorial",
      style: playful ? "organic" : heritage ? "solid-silhouette" : "geometric",
      subject: hint.subject,
      concept: `One object a customer links with this business at a glance: ${hint.subject}.`,
      rationale: heritage
        ? "A compact emblem suits a business that trades on craft and tradition."
        : "A pictorial mark: customers already know the object, so the mark is recognised at once.",
      avoid: [...base.avoid, hint.avoid],
    };
  }
  if (named && (MONOGRAM_WORDS.test(business) || (initials.length > 1 && input.site_name.length > 14 && !ABSTRACT_WORDS.test(business)))) {
    return {
      ...base,
      type: "monogram",
      style: "negative-space",
      letters: initials,
      subject: `the letters ${initials}`,
      concept: `The initials ${initials} interlocked into one confident form.`,
      rationale: "A monogram carries a longer or professional name with authority and stays crisp at favicon size.",
    };
  }
  if (PLAYFUL_WORDS.test(business)) {
    return {
      ...base,
      type: "mascot",
      style: "organic",
      subject: "one friendly character reduced to a few flat shapes",
      concept: "A face or gesture customers smile at, simple enough to read small.",
      rationale: "A playful brand earns a character; everything else would feel corporate.",
    };
  }
  return {
    ...base,
    type: "abstract",
    style: "geometric",
    subject: "two or three interlocking geometric forms that imply forward motion and connection",
    concept: "The promise of the service, not its tools: forms that suggest progress and trust.",
    rationale: "No single object stands for this service, so an abstract mark stays ownable and grows with the business.",
  };
}

export type LogoDesignResult = { spec: LogoDesignSpec; ms: number; reason: string | null };

export async function designSiteLogo(input: LogoDesignInput): Promise<LogoDesignResult> {
  const startedAt = Date.now();
  return { spec: heuristicLogoDesign(input), ms: Date.now() - startedAt, reason: null };
}

const HARD_RULES =
  "Transparent background, centred in a square canvas, strong silhouette that stays legible at 16 px and works in one colour. Flat colour, at most three tones. No mockup, frame, drop shadow, gradient mesh, watermark, photographic detail or extra text.";

export function logoRenderPrompt(
  spec: LogoDesignSpec,
  input: { site_name: string; business?: string | null; primary?: string | null; accent?: string | null },
): string {
  const colors = [input.primary, input.accent].filter((v): v is string => !!v).join(" and ");
  const named = hasRealLogoName(input.site_name);
  const letters = spec.letters && LETTERS.test(spec.letters) ? spec.letters : logoInitials(input.site_name);
  const type = spec.type === "wordmark" || (spec.type === "monogram" && (!named || !letters)) ? "abstract" : spec.type;
  const subject = type === spec.type ? spec.subject : "two or three interlocking geometric forms";
  const typeLine =
    type === "monogram"
      ? `A monogram built only from the letters "${letters}": ${LOGO_TYPE_GUIDE.monogram.drawn}. No other text.`
      : type === "pictorial"
        ? `A pictorial mark: ${subject}. ${LOGO_TYPE_GUIDE.pictorial.drawn}. No text, letters or initials.`
        : type === "abstract"
          ? `An abstract mark: ${subject}. ${LOGO_TYPE_GUIDE.abstract.drawn}. No text, letters or initials.`
          : type === "mascot"
            ? `A mascot mark: ${subject}. ${LOGO_TYPE_GUIDE.mascot.drawn}. No text, letters or initials.`
            : `An emblem: ${subject}. ${LOGO_TYPE_GUIDE.emblem.drawn}. No text, letters or initials.`;
  const palette = (note: boolean) =>
    colors
      ? `Palette: ${colors}${note && spec.palette_note ? ` (${spec.palette_note})` : ""}.`
      : note && spec.palette_note
        ? `Palette: ${spec.palette_note}; one or two confident brand colours that read on light and dark.`
        : "Use one or two confident brand colours that read on both light and dark backgrounds.";
  const avoidLine = (n: number) => `Avoid: ${Array.from(new Set(["clip art", "generic stock icons", ...spec.avoid])).slice(0, n).join(", ")}.`;
  const lead = (business: boolean) => `Design a premium, original vector logo mark for ${input.site_name}${business && input.business ? `, ${input.business}` : ""}.`;
  const compose = (business: boolean, avoidN: number, note: boolean, conceptMax: number) =>
    [lead(business), typeLine, `The idea: ${spec.concept.slice(0, conceptMax)}`, `Style: ${spec.style} (${LOGO_STYLE_GUIDE[spec.style]}).`, avoidLine(avoidN), palette(note), HARD_RULES].join(" ");
  for (const attempt of [compose(true, 8, true, 220), compose(false, 8, true, 220), compose(false, 4, false, 220), compose(false, 2, false, 120)]) {
    if (attempt.length <= LOGO_RENDER_PROMPT_MAX) return attempt;
  }
  const short = [lead(false), typeLine.slice(0, 260), `Style: ${spec.style}.`, avoidLine(1), palette(false), HARD_RULES].join(" ");
  return short.length <= LOGO_RENDER_PROMPT_MAX ? short : [lead(false).slice(0, 120), typeLine.slice(0, 200), HARD_RULES].join(" ");
}

export function logoDesignSummary(spec: LogoDesignSpec): { type: LogoType; rationale: string; concept: string } {
  return { type: spec.type, rationale: spec.rationale, concept: spec.concept };
}
