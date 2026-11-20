
import { z } from "zod";
import type { VideoGenIntent } from "./generative-models";
import { PRESENTER_GENDERS } from "./presenter";

export const TALKING_HEAD_MAX_WORDS = 150;
export const TALKING_HEAD_MIN_WORDS = 6;

const wordCount = (s?: string): number => (s ?? "").trim().split(/\s+/).filter(Boolean).length;

export const SPEAKING_WORDS_PER_SECOND = 2.5;

export function spokenSeconds(script?: string): number {
  const words = wordCount(script);
  if (!words) return 8;
  return Math.ceil(words / SPEAKING_WORDS_PER_SECOND) + 1;
}

export function narrowAspect(a?: string): "1:1" | "4:5" | "9:16" | "16:9" {
  return a === "1:1" || a === "4:5" || a === "9:16" || a === "16:9" ? a : "16:9";
}

export function requestedVideoAspect(intent: unknown, a?: unknown): "1:1" | "4:5" | "9:16" | "16:9" {
  if (a === "1:1" || a === "4:5" || a === "9:16" || a === "16:9") return a;
  return intent === "cinematic" ? "16:9" : "9:16";
}

export function finishMode(intake: { intent: string; aspect_ratio?: string }): "full" | "none" {
  return intake.intent === "talking_head" && narrowAspect(intake.aspect_ratio) === "9:16" ? "full" : "none";
}

export const generativeVideoIntakeSchema = z
  .object({
    prompt: z.string().min(1).max(2000),
    intent: z.enum(["talking_head", "cinematic", "social", "animate"]),
    premium: z.boolean().optional().default(false),
    aspect_ratio: z.string().optional(),
    script: z.string().max(4000).optional(),
    presenter_gender: z.enum(PRESENTER_GENDERS).optional(),
    voice: z.string().max(40).optional(),
    hook: z.string().max(200).optional(),
    avatar_tier: z.enum(["pro", "standard"]).optional(),
    image_path: z.string().min(1).max(300).optional(),
    portrait_path: z.string().min(1).max(300).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.voice?.trim() && !v.presenter_gender) {
      ctx.addIssue({ code: "custom", path: ["presenter_gender"], message: "voice needs presenter_gender: say whether the presenter is male or female, or leave voice out" });
    }
    if (v.intent === "animate" && !v.image_path) {
      ctx.addIssue({ code: "custom", path: ["image_path"], message: "animate needs image_path: the uploaded image the video starts from" });
    }
    if (v.portrait_path && v.intent !== "talking_head") {
      ctx.addIssue({ code: "custom", path: ["portrait_path"], message: "portrait_path is only used by talking_head" });
    }
    if (v.intent !== "animate" && v.image_path) {
      ctx.addIssue({ code: "custom", path: ["image_path"], message: "image_path is only used by animate" });
    }
    if (v.intent !== "talking_head") return;
    if (!v.script?.trim()) {
      ctx.addIssue({ code: "custom", path: ["script"], message: "talking_head needs script: write the exact line the presenter says" });
    } else if (wordCount(v.script) < TALKING_HEAD_MIN_WORDS) {
      ctx.addIssue({
        code: "custom",
        path: ["script"],
        message: `talking_head script must be at least ${TALKING_HEAD_MIN_WORDS} words — a shorter line makes an audio clip the video model rejects`,
      });
    } else if (wordCount(v.script) > TALKING_HEAD_MAX_WORDS) {
      ctx.addIssue({ code: "custom", path: ["script"], message: `talking_head script must be ≤${TALKING_HEAD_MAX_WORDS} words; shorten it` });
    }
  });
export type GenerativeVideoIntake = z.infer<typeof generativeVideoIntakeSchema>;

const TALKING_HEAD_RE =
  /\b(talking[-\s]?head|person speaking|speaking to camera|to camera|presenter|spokesperson|founder|avatar|recruit|pitch|host|anchor|ugc)\b/i;
const CINEMATIC_RE =
  /\b(cinematic|wide shot|landscape|atmospheric|film|hero shot|b[-\s]?roll|scenery|establishing)\b/i;
const SOCIAL_RE = /\b(tiktok|reel|short|social|quick clip|meme|snappy)\b/i;

export function mentionsPresenter(text: string): boolean {
  return TALKING_HEAD_RE.test(text || "");
}

export function classifyVideoIntent(text: string): VideoGenIntent {
  const t = text || "";
  if (TALKING_HEAD_RE.test(t)) return "talking_head";
  if (CINEMATIC_RE.test(t)) return "cinematic";
  if (SOCIAL_RE.test(t)) return "social";
  return "talking_head";
}

const TESTIMONIAL_RE =
  /\b(testimonials?|customers?\s+(?:reviews?|quotes?|testimon\w*|stor(?:y|ies))|social\s+proof|happy\s+customers?|review\s+quotes?|what\s+(?:our\s+)?customers?\s+(?:say|are\s+saying)|from\s+our\s+reviews?|five[-\s]?star\s+reviews?|5[-\s]?star\s+reviews?|[1-5](?:\.\d)?\s*(?:\/\s*5\s*)?stars?\s+(?:reviews?|ratings?|on\s+(?:google|yelp|trustpilot))|rated\s+[1-5](?:\.\d)?\s*(?:\/\s*5\s*)?stars?)\b/i;

export function isTestimonialIntent(text: string): boolean {
  return TESTIMONIAL_RE.test(text || "");
}

export function shouldRedirectTestimonialFromTalkingHead(intent: VideoGenIntent, prompt: string): boolean {
  return intent === "talking_head" && isTestimonialIntent(prompt);
}

const CUSTOMER_WORD = "(?:customers?|clients?|buyers?|shoppers?|patrons?)";
const NOT_A_CUSTOMER_ROLE = "(?!-|\\s+(?:service|success|support|care|experience)\\b)";
const CUSTOMER_ADJ = "(?:(?:happy|satisfied|real|regular|loyal|longtime|long-time|repeat|verified|returning|proud|devoted|big|huge|genuine|actual)\\s+){0,2}";

const CUSTOMER_VOICE_RE = new RegExp(
  [
    `as (?:a|an|one of (?:your|our|their|the|its)) ${CUSTOMER_ADJ}${CUSTOMER_WORD}${NOT_A_CUSTOMER_ROLE}`,
    `i(?:'m| am) (?:a|an|one of (?:your|our|their|the|its)) ${CUSTOMER_ADJ}${CUSTOMER_WORD}${NOT_A_CUSTOMER_ROLE}`,
    "i(?:'ve| have| had|'d) been (?:using|ordering|buying|shopping|eating)",
    "i switched to (?:this|it|your|you|them)",
    "my review",
    "five stars",
    "5 stars",
    "changed my life",
  ]
    .map((p) => `\\b${p}\\b`)
    .join("|"),
  "i",
);

const BOUGHT_RE = /\bi(?:'ve| have| had|'d)? (?:bought|ordered|purchased)\b([^.!?\n]{0,160})/gi;
const REVIEW_VERDICT_RE =
  /\b(?:lov(?:e|es|ed|ing)|changed my life|best|recommend(?:s|ed)?|amazing|perfect|obsessed|favou?rite|worth it|never going back|can't stop|so good|saved (?:me|a fortune|us)|five stars|5 stars|as (?:a|an) (?:[a-z'-]+\s+){0,2}customers?)\b/i;
const FROM_THE_SELLER_RE = /\b(?:from|on|at|with)\s+(?:you|us|them|your|our)\b/i;
const NAMED_PRODUCT_RE = /\b(?!I\b)[A-Z][A-Za-z0-9]+/;

function boughtAsCustomer(text: string): boolean {
  for (const m of text.matchAll(BOUGHT_RE)) {
    const tail = m[1];
    if (REVIEW_VERDICT_RE.test(tail) || FROM_THE_SELLER_RE.test(tail) || NAMED_PRODUCT_RE.test(tail)) return true;
  }
  return false;
}

export function speaksAsCustomer(text: string): boolean {
  const t = (text || "").replace(/[\u2018\u2019\u02bc]/g, "'");
  return CUSTOMER_VOICE_RE.test(t) || boughtAsCustomer(t);
}

const QUOTED_LINE_RE = /["\u201c\u201d\u00ab\u00bb]([^"\u201c\u201d\u00ab\u00bb]{2,600})["\u201c\u201d\u00ab\u00bb]/g;
const SAID_LINE_RE = /\b(?:says?|saying|said|tells?\s+(?:the\s+)?(?:viewers?|camera|people|everyone)|telling|goes|line|script)\b\s*[:,-]?\s*([^.!?\n]{2,300})/gi;

export function requestedLines(request: string): string[] {
  const t = (request || "").replace(/[\u2018\u2019\u02bc]/g, "'");
  return [...t.matchAll(QUOTED_LINE_RE), ...t.matchAll(SAID_LINE_RE)].map((m) => m[1]);
}

const REPORTED_SUBJECT_RE = /^\s*(?:that\s+)?(?:they|she|he|the\s+presenter)(?:'re|'s|\s+(?:are|is|was|were|has|have|had)\b)?/i;

export function inPresenterVoice(line: string): string {
  const m = (line || "").match(REPORTED_SUBJECT_RE);
  if (!m) return line;
  const aux = m[0].replace(/^\s*(?:that\s+)?(?:they|she|he|the\s+presenter)/i, "").trim().toLowerCase();
  const rest = line.slice(m[0].length);
  const first = aux === "'s" || aux === "'re" || aux === "is" || aux === "are" ? (/^\s*been\b/i.test(rest) ? "I have" : "I am") : aux === "has" ? "I have" : aux ? `I ${aux}` : "I";
  return `${first}${rest}`;
}

const POSES_AS_CUSTOMER_RE = new RegExp(
  [
    `(?:pretend(?:s|ing)?|pos(?:e|es|ing)|act(?:s|ing)?|play(?:s|ing)?|role[-\\s]?play(?:s|ing)?|speak(?:s|ing)?|talk(?:s|ing)?|claim(?:s|ing)?|portray(?:s|ing)?|introduc(?:e|es|ing)\\s+(?:themselves|herself|himself))\\s+(?:to\\s+be|as(?:\\s+(?:if|though)\\s+(?:they|she|he)\\s+(?:were|was|are|is))?|like)\\s+(?:a|an|one\\s+of\\s+(?:your|our|their|the|its))\\s+(?:[a-z'-]+\\s+){0,2}?${CUSTOMER_WORD}${NOT_A_CUSTOMER_ROLE}`,
    "as\\s+(?:if|though)\\s+(?:they|she|he|the\\s+presenter)(?:'d|\\s+(?:had|has|have|did|does|do))?(?:\\s+(?:already|really|personally|actually))?\\s+(?:used|bought|ordered|purchased|tried|eaten|owned|been\\s+(?:using|ordering|buying|eating|a))",
  ]
    .map((p) => `\\b${p}\\b`)
    .join("|"),
  "i",
);

export function asksPresenterToSpeakAsCustomer(request: string): boolean {
  const t = (request || "").replace(/[\u2018\u2019\u02bc]/g, "'");
  if (POSES_AS_CUSTOMER_RE.test(t)) return true;
  return requestedLines(t).some((line) => speaksAsCustomer(line) || speaksAsCustomer(inPresenterVoice(line)));
}

const ENDORSEMENT_SCENE_RE =
  /(?:[\u2605\u2b50]\ufe0f?\s*){3,}|\b(?:google|yelp|trustpilot|tripadvisor|amazon)\s+reviews?\b|\b(?:customers?|clients?|guests?|diners?|shoppers?|buyers?|users?|patients?)\s+(?:(?:are|is)\s+)?(?:rav(?:e|es|ing)|prais(?:e|es|ing)|recommend(?:s|ing)?|testify(?:ing)?|vouch(?:es|ing)?|endors(?:e|es|ing)|giv(?:e|es|ing)\s+(?:it\s+|us\s+)?(?:a\s+)?(?:review|rating|five|5|thumbs)|review(?:s|ing)?\s+(?:us|it|our|the\s+(?:product|service|shop|place))\b)|\b(?:on[-\s]?screen|overlay|caption|text)\b[^.\n]{0,60}\b(?:reviews?|testimonials?|quotes?\s+from)\b/i;

const NEGATED_ENDORSEMENT_RE = /\b(?:no|without|remove|drop|delete|not|never)\b[^.\n]{0,40}\b(?:reviews?|testimonials?|ratings?|stars?)\b/gi;

function withoutNegations(text: string): string {
  return (text || "").replace(NEGATED_ENDORSEMENT_RE, " ");
}

const CUSTOMER_QUOTE_RE =
  /\b(?:customers?|clients?|guests?|diners?|shoppers?|buyers?|patients?|regulars?)\b[^.\n]{0,40}\b(?:says?|saying|tells?|telling|speaks?\s+(?:to|into)\s+(?:the\s+)?camera|turns?\s+to\s+(?:the\s+)?camera)\b/i;

export function asksForCustomerEndorsement(request: string): boolean {
  const raw = withoutNegations(request);
  const t = raw.replace(/\bhappy\s+customers?\b/gi, "happy people");
  return isTestimonialIntent(t) || ENDORSEMENT_SCENE_RE.test(t) || CUSTOMER_QUOTE_RE.test(raw);
}

export function showsCustomerEndorsement(visual: string): boolean {
  const t = withoutNegations(visual).replace(/\bhappy\s+customers?\b/gi, "happy people");
  return isTestimonialIntent(t) || ENDORSEMENT_SCENE_RE.test(t) || CUSTOMER_QUOTE_RE.test(t) || speaksAsCustomer(t.replace(/\b(?:five|5)[-\s]stars?\b/gi, " "));
}

export function shouldRefuseGeneratedEndorsement(intent: VideoGenIntent, prompt: string): boolean {
  if (intent === "cinematic" || intent === "social") return asksForCustomerEndorsement(prompt);
  return shouldRedirectTestimonialFromTalkingHead(intent, prompt) || (intent === "talking_head" && speaksAsCustomer(prompt));
}
