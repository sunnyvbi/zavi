
import { getAnthropic, DEFAULT_FAST_MODEL } from "@/services/anthropic";
import { launchVideoIntakeSchema, TONE_VALUES } from "@/services/launch-video/brief-mapper";

export type PublicLaunchVideoForm = {
  brief?: string;
  grammar?: string;
  film?: string;
  product_name: string;
  one_liner: string;
  features: string;
  audience: string;
  tone: string;
  theme: string;
  problem: string;
  metrics: string;
  regions: string;
  screen: string;
  cta_text: string;
  cta_url: string;
};

export type Completer = (system: string, user: string) => Promise<string>;

const defaultComplete: Completer = async (system, user) => {
  const anthropic = getAnthropic();
  const resp = await anthropic.messages.create({
    model: DEFAULT_FAST_MODEL,
    max_tokens: 3000,
    system,
    messages: [{ role: "user", content: user }],
  });
  const block = resp.content.find((c) => c.type === "text");
  return block && block.type === "text" ? block.text : "";
};

export function extractJsonObject(raw: string): unknown | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type AuthorResult =
  | { ok: true; intake: unknown }
  | { ok: false; error: string };

export function parseAuthoredIntake(raw: string): AuthorResult {
  const obj = extractJsonObject(raw);
  if (!obj) return { ok: false, error: "author_no_json" };
  const parsed = launchVideoIntakeSchema.safeParse(obj);
  if (!parsed.success) return { ok: false, error: `author_schema:${parsed.error.issues[0]?.path.join(".") ?? "?"}` };
  return { ok: true, intake: parsed.data };
}

const AUTHOR_SYSTEM = [
  "You turn a founder's short product form into a JSON launch-video brief.",
  "Output ONLY a single JSON object in a ```json fenced block. No prose.",
  "Required keys: product_name, one_liner, url, audience, tone, features (array of {title, detail}), cta_text, cta_url.",
  `tone MUST be one of: ${TONE_VALUES.join(", ")}.`,
  "GROUNDED ONLY: never invent metrics, customer counts, awards, or comparative claims. Use only what the form states.",
  "WHEN `what_the_founder_wants_shown` IS PRESENT IT OUTRANKS EVERY OTHER FIELD. Those are the",
  "founder's own words about their own product; the rest was read off their website by a model.",
  "Where the two disagree on what the product is, who it is for, or which moment to show, follow",
  "the founder and drop the conflicting field. Keep their register: if they describe a supply",
  "list and a warm loaf, the film shows a supply list and a warm loaf, not a dashboard.",
  "Keep every string within reasonable length (one_liner <=200, feature title <=120, detail <=240).",
  "problem: if problem_freetext is non-empty, copy its meaning into `problem` as ONE sentence.",
  "  If it is empty, OMIT the key. Never write a problem the founder did not give you.",
  "metrics: if metrics_freetext is non-empty, parse its `label|value` lines into",
  "  `metrics: [{stat, label}]` (stat = the value, label = the words). Copy the numbers",
  "  EXACTLY. If it is empty, OMIT the key. Never invent, round or extrapolate a number.",
  "regions: if regions_freetext is non-empty, copy its places into `coverage: {regions:[...]}`.",
  "  Copy them EXACTLY. If it is empty, OMIT the key. Never add a place they did not name.",
  "screen: screen_freetext is ONE SENTENCE on what a user DOES with the product, not a",
  "  description of a screen. Turn that action into",
  "  `product_surface: {header:{title}, items:[{title, chips:[1-3 short factual chips]}]}`:",
  "  the header names the thing they are doing, and the items are the steps or objects that",
  "  action touches, taken from what they told you and from the capabilities. Invent no",
  "  feature, number or label that is not in the form. If it is empty, OMIT the key.",
  "proof: if ONE number is clearly the headline one, ALSO set `proof: {stat, label}` from it.",
  "  Only from a number already given. If there is none, OMIT the key.",
  "features: SPLIT features_freetext into as many distinct {title, detail} entries as it",
  "  GENUINELY contains, up to 12. Never merge two capabilities into one entry, never split",
  "  one capability into two to make the film longer, and never restate the one-liner as a feature.",
  "An omitted key becomes a question we ask the founder; an invented one becomes a lie on screen. Omitting is always correct when you are unsure.",
  "If `audience` is absent or empty, infer the external launch audience from the product itself. That one field is a framing choice, not a claim; everything else stays grounded in the form.",
].join("\n");

export async function authorIntake(
  form: PublicLaunchVideoForm,
  deps: { complete?: Completer } = {},
): Promise<AuthorResult> {
  const complete = deps.complete ?? defaultComplete;
  const tone = (TONE_VALUES as readonly string[]).includes(form.tone) ? form.tone : "clean";
  const user = JSON.stringify({
    ...(form.brief ? { what_the_founder_wants_shown: form.brief } : {}),
    product_name: form.product_name,
    one_liner: form.one_liner,
    url: form.cta_url,
    ...(form.audience ? { audience: form.audience } : {}),
    tone,
    features_freetext: form.features,
    problem_freetext: form.problem,
    metrics_freetext: form.metrics,
    regions_freetext: form.regions,
    screen_freetext: form.screen,
    cta_text: form.cta_text,
    cta_url: form.cta_url,
  });
  let raw: string;
  try {
    raw = await complete(AUTHOR_SYSTEM, user);
  } catch (e) {
    return { ok: false, error: `author_llm_error:${(e as Error).message.slice(0, 80)}` };
  }
  return parseAuthoredIntake(raw);
}

export type ModerationVerdict = { allowed: boolean; reason: string };

export function parseModerationVerdict(raw: string): ModerationVerdict {
  const obj = extractJsonObject(raw);
  if (obj && typeof obj === "object" && "allowed" in obj) {
    const allowed = (obj as { allowed: unknown }).allowed === true;
    const reason = String((obj as { reason?: unknown }).reason ?? (allowed ? "ok" : "blocked"));
    return { allowed, reason };
  }
  return { allowed: false, reason: "moderation_unparseable" };
}

const MODERATION_SYSTEM = [
  "You are a strict content-safety gate for a PUBLIC video generator.",
  "Given a product form, decide if a promotional video may be generated from it.",
  "BLOCK if it contains or promotes: hate, harassment, sexual content, violence, illegal goods/services, weapons, self-harm, political persuasion, medical/financial/legal claims presented as advice, impersonation of a real person, or personal data (SSN, card numbers, addresses of others).",
  'Output ONLY a JSON object: {"allowed": true|false, "reason": "<short>"}.',
].join("\n");

export async function moderateForm(
  form: PublicLaunchVideoForm,
  deps: { complete?: Completer } = {},
): Promise<ModerationVerdict> {
  const complete = deps.complete ?? defaultComplete;
  let raw: string;
  try {
    raw = await complete(
      MODERATION_SYSTEM,
      JSON.stringify({
        product_name: form.product_name,
        one_liner: form.one_liner,
        features: form.features,
        audience: form.audience,
        cta_text: form.cta_text,
        brief: form.brief,
      }),
    );
  } catch {
    return { allowed: false, reason: "moderation_llm_error" };
  }
  return parseModerationVerdict(raw);
}
