
import { z } from "zod";

export const TONE_VALUES = ["clean", "bold", "playful", "enterprise"] as const;
export type Tone = (typeof TONE_VALUES)[number];

export const PRODUCT_SHAPE_VALUES = ["marketplace", "saas", "dtc", "devtool", "consumer"] as const;
export type ProductShape = (typeof PRODUCT_SHAPE_VALUES)[number];

type SceneSlot = "hook" | "problem" | "productui" | "cardwall" | "coverage" | "metric" | "cta";

const LEGACY_ARC: SceneSlot[] = ["hook", "problem", "productui", "cardwall", "coverage", "metric", "cta"];

const SHAPE_ARCS: Record<ProductShape, SceneSlot[]> = {
  marketplace: ["hook", "problem", "productui", "cardwall", "coverage", "metric", "cta"],
  saas: ["hook", "productui", "problem", "cardwall", "metric", "cta"],
  dtc: ["hook", "productui", "cardwall", "metric", "cta"],
  devtool: ["hook", "problem", "productui", "cardwall", "metric", "cta"],
  consumer: ["hook", "problem", "productui", "cardwall", "coverage", "metric", "cta"],
};

export function arcForShape(shape: ProductShape | undefined): SceneSlot[] {
  return shape ? SHAPE_ARCS[shape] : LEGACY_ARC;
}

export const VIDEO_TYPE_VALUES = ["launch", "ad", "explainer", "social", "story", "promo", "testimonial", "demo"] as const;
export type VideoType = (typeof VIDEO_TYPE_VALUES)[number];

export interface VideoTypeProfile {
  arc: SceneSlot[] | null;
  scriptObjective: string;
  ctaStyle: string;
  pacingScalar: number;
  lengthTargetSec: number;
  scenePalette: SceneSlot[];
}

export const VIDEO_TYPE_PROFILES: Record<VideoType, VideoTypeProfile> = {
  launch: {
    arc: null,
    scriptObjective:
      "Announce the product to investors + social (LinkedIn/Twitter/Product Hunt): lead with the positioning, show the product, name the traction, invite people to try it.",
    ctaStyle: "try-it / support-the-launch (e.g. 'Find a car near you', 'Try it free', \"We're live on Product Hunt\")",
    pacingScalar: 1,
    lengthTargetSec: 75,
    scenePalette: ["hook", "problem", "productui", "cardwall", "coverage", "metric", "cta"],
  },
  ad: {
    arc: ["hook", "cardwall", "metric", "cta"],
    scriptObjective:
      "Sell in 15-30s: open on the single sharpest hook, show the core value (the strongest capabilities), back it with one real proof point, end on ONE hard call-to-action. Tight and punchy, vertical-friendly. NEVER an unsupported claim, superlative, '#1', 'guaranteed', or fake urgency.",
    ctaStyle: "one hard CTA (e.g. 'Get started', 'Try it free today')",
    pacingScalar: 0.7,
    lengthTargetSec: 22,
    scenePalette: ["hook", "cardwall", "metric", "cta"],
  },
  explainer: {
    arc: ["problem", "productui", "cardwall", "cta"],
    scriptObjective:
      "Teach how it works: state the problem, show the product doing the job on screen, walk the key capabilities, close. Clear and instructive, not hypey.",
    ctaStyle: "learn-by-doing CTA (e.g. 'See how it works', 'Start your first project')",
    pacingScalar: 1,
    lengthTargetSec: 60,
    scenePalette: ["hook", "problem", "productui", "cardwall", "metric", "cta"],
  },
  social: {
    arc: ["hook", "cardwall", "cta"],
    scriptObjective:
      "One idea, fast: a scroll-stopping hook, ONE concrete point (the strongest capability), one CTA. Built for a 15s vertical feed. No filler.",
    ctaStyle: "low-friction CTA (e.g. 'Follow along', 'Try it', 'Link in bio')",
    pacingScalar: 0.7,
    lengthTargetSec: 15,
    scenePalette: ["hook", "cardwall", "cta"],
  },
  story: {
    arc: ["hook", "problem", "productui", "metric", "cta"],
    scriptObjective:
      "Tell the founder/journey story: the hook, the real problem, the journey (the product taking shape), the outcome (true traction), the invitation. Honest and human; the numbers must be real.",
    ctaStyle: "join-the-journey CTA (e.g. 'Come build with us', 'See where we're headed')",
    pacingScalar: 1.1,
    lengthTargetSec: 45,
    scenePalette: ["hook", "problem", "productui", "cardwall", "metric", "cta"],
  },
  promo: {
    arc: ["hook", "productui", "cardwall", "cta"],
    scriptObjective:
      "A short festival/seasonal COUPON promo (15-25s, vertical-friendly): open on the festival hook, show the real product/value, close on ONE CTA that carries the offer — the discount as the headline and the code + expiry as chips. NEVER an unsupported claim, superlative, or fake urgency; a real dated expiry is fine, a manufactured countdown is not.",
    ctaStyle: "one CTA carrying the coupon (discount headline + 'CODE: <code>' + a real dated expiry)",
    pacingScalar: 0.7,
    lengthTargetSec: 20,
    scenePalette: ["hook", "productui", "cardwall", "metric", "cta"],
  },
  testimonial: {
    arc: ["hook", "cardwall", "metric", "coverage", "cta"],
    scriptObjective:
      "A short social-proof video (15-30s, vertical-friendly) built from the customer's REAL reviews: open on a proof hook, show a wall of REAL review quotes (each traceable to a real source — NEVER invented), back it with the true rating + review count, close on ONE low-friction CTA. NEVER fabricate or misattribute a quote, a name, or a rating; NEVER route this to an AI talking-head presenter.",
    ctaStyle: "one low-friction CTA (e.g. 'See why they love it', 'Try it free', 'Read more reviews')",
    pacingScalar: 0.7,
    lengthTargetSec: 22,
    scenePalette: ["hook", "cardwall", "metric", "coverage", "cta"],
  },
  demo: {
    arc: ["hook", "productui", "cardwall", "metric", "cta"],
    scriptObjective:
      "Show the product doing its job: open on a tight hook, then put the customer's REAL product UI on screen as the centerpiece (captured live when a capture_url is supplied, else the stylized product_surface), walk the key things it does, back it with one real proof point if there is one, and close on a try-it CTA. SHOW more than you tell — the real screen is the star, not a pitch. Everything on screen must be real (no invented UI, metric, or claim).",
    ctaStyle: "try-it CTA (e.g. 'See it yourself', 'Try the live product', 'Start your first project')",
    pacingScalar: 1,
    lengthTargetSec: 45,
    scenePalette: ["hook", "problem", "productui", "cardwall", "metric", "cta"],
  },
};

export interface BrandKit {
  colors?: { primary?: string; accent?: string; bg?: string };
  logoUrl?: string;
  voiceId?: string;
}

export interface MapperOptions {
  brandKit?: BrandKit;
}

export const PLATFORM_VALUES = [
  "tiktok",
  "instagram",
  "instagram_reels",
  "instagram_feed",
  "youtube",
  "youtube_shorts",
  "linkedin",
  "x",
  "web",
] as const;
export type Platform = (typeof PLATFORM_VALUES)[number];

export const ASPECT_VALUES = ["16:9", "1:1", "9:16"] as const;

export function aspectForPlatform(p: Platform | undefined): Aspect {
  switch (p) {
    case "tiktok":
    case "instagram":
    case "instagram_reels":
    case "youtube_shorts":
      return "9:16";
    case "instagram_feed":
      return "1:1";
    case "youtube":
    case "linkedin":
    case "x":
    case "web":
    default:
      return "16:9";
  }
}

export const launchVideoFeatureSchema = z.object({
  title: z.string().min(1).max(120).describe("Short capability headline, e.g. 'Opens real pull requests'."),
  detail: z.string().min(1).max(240).describe("One supporting line under the title."),
  meta: z
    .string()
    .max(40)
    .optional()
    .describe(
      "OPTIONAL short REAL data tag for this capability, rendered as the card's mono footer — e.g. '600+ hosts', '5 cities', '4.9★ avg', '30s avg'. Fill ONLY when a real, verifiable number exists (from the customer's own site copy or their connected operating data). NEVER invent it — omit when there's no real figure (the card renders fine without a footer).",
    ),
});

export const launchVideoTestimonialSchema = z.object({
  quote: z.string().min(1).max(240).describe("The customer's REAL review text, verbatim (never invented or paraphrased into a stronger claim)."),
  attribution: z
    .string()
    .min(1)
    .max(80)
    .describe("Who said it — a real name/handle/role from the review (e.g. 'Maria G.', 'a host in Austin'). NEVER a fabricated persona."),
  rating: z
    .string()
    .max(12)
    .optional()
    .describe("OPTIONAL per-quote star rating shown as the card footer, e.g. '5★' or '4.9'. Real ratings only; omit if the review has none."),
  source: z
    .string()
    .min(1)
    .max(160)
    .describe(
      "REQUIRED provenance — WHERE this quote came from (a real read-tool source): e.g. 'operator_db reviews table', 'Google review 2026-06', 'App Store review'. NOT shown on screen; it is the receipt that the quote is real. If you cannot name a real source, DO NOT include the quote — a sourceless quote is refused (public) or dropped (Slack).",
    ),
});
export type LaunchVideoTestimonial = z.infer<typeof launchVideoTestimonialSchema>;

export const launchVideoSceneSchema = z.object({
  kind: z
    .enum(["hook", "problem", "feature", "proof", "productui", "cardwall", "coverage", "metric", "cta", "broll"])
    .describe(
      "Which scene to render at this position in the video. `feature` is ONE capability on its own scene (headline + sub) and is the scene you REPEAT, a different capability each time, when the story needs length; `cardwall` is the opposite, several capabilities at once on one dense wall. `proof` is a single big stat on its own scene.",
    ),
  headline: z.string().max(240).optional().describe("On-screen headline for this scene (hook/problem/coverage/cta)."),
  sub: z.string().max(240).optional().describe("Optional supporting line under the headline (hook)."),
  eyebrow: z.string().max(60).optional().describe("Small uppercase eyebrow above the scene."),
  vo: z.string().max(240).optional().describe("Spoken VO / caption line for THIS scene (the authored narration)."),
  duration_frames: z
    .number()
    .int()
    .min(30)
    .max(450)
    .optional()
    .describe(
      "OPTIONAL explicit length for THIS scene, in frames at 30fps. OMIT IT on a narrated video: the per-kind defaults are tuned for narration and the render path already stretches a beat to fit its VO clip, so setting this can only cut a line off. It exists for a SILENT render, where reading is the viewer's only channel and the pacing has to be set deliberately.",
    ),
  image_prompt: z
    .string()
    .max(300)
    .optional()
    .describe("hook: OPTIONAL photoreal HERO image prompt for this scene (generates a real hero image, ~1 credit; people are fine)."),
  header: z
    .object({ title: z.string().min(1).max(60), search_placeholder: z.string().max(60).optional() })
    .optional()
    .describe("productui: the search/list header inside the product frame."),
  items: z
    .array(
      z.object({
        glyph: z.string().max(20).optional(),
        image_prompt: z.string().max(300).optional().describe("OPTIONAL photoreal image prompt for this card (generates a real image, ~1 credit; people are fine)."),
        title: z.string().min(1).max(60),
        chips: z.array(z.string().min(1).max(28)).min(1).max(3),
      }),
    )
    .min(1)
    .max(4)
    .optional()
    .describe("productui: 1-4 item cards for the product surface."),
  glyph: z
    .string()
    .max(20)
    .optional()
    .describe("feature: OPTIONAL inline-SVG glyph name (bolt|chart|shield|clock|car|check|spark|chat). Omit to derive one from the headline."),
  stat: z.string().max(40).optional().describe("proof: the big number, e.g. '10x' / '$1.2M' / '600+'. REAL only."),
  stat_label: z.string().max(160).optional().describe("proof: what the stat means, e.g. 'active hosts'."),
  cards: z
    .array(z.object({ title: z.string().min(1).max(120), detail: z.string().min(1).max(240), meta: z.string().max(40).optional() }))
    .min(1)
    .max(6)
    .optional()
    .describe("cardwall: the capability cards (the strongest 3 are shown)."),
  regions: z.array(z.string().min(1).max(40)).min(2).max(8).optional().describe("coverage: real region/location labels."),
  metrics: z
    .array(z.object({ stat: z.string().min(1).max(40), label: z.string().min(1).max(160) }))
    .min(1)
    .max(3)
    .optional()
    .describe("metric: 1-3 real headline stats."),
  chips: z.array(z.string().min(1).max(40)).max(3).optional().describe("cta: optional factual mono chip row (real data only)."),
  video_prompt: z
    .string()
    .max(300)
    .optional()
    .describe("broll: CLIP prompt — generates a ~6s video clip (~22-72cr). A scene, product in motion, or an AI person (e.g. a UGC reaction hook before the product demo). No fabricated UI/text/logos, and never a person presented as a real customer endorsing the product."),
  prompt: z
    .string()
    .max(300)
    .optional()
    .describe("broll: alias of video_prompt (either key works)."),
});
export type LaunchVideoScene = z.infer<typeof launchVideoSceneSchema>;

export const launchVideoIntakeBase = z.object({
  product_name: z.string().min(1).max(80),
  one_liner: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "The opening hook — a LAUNCH-ANNOUNCEMENT / positioning line aimed at investors + social (LinkedIn/Twitter), NOT in-app end-user how-to copy. e.g. 'Introducing Acme — book a vetted local pro in two minutes.' NOT 'What Acme does'.",
    ),
  url: z.string().min(1).max(300).describe("Product URL (display + provenance)."),
  video_type: z
    .enum(VIDEO_TYPE_VALUES)
    .optional()
    .describe(
      "OPTIONAL kind of video — drives the narrative arc, pacing, length, and CTA style. SIBLING to product_shape (which is about the COMPANY; this is about the VIDEO). Omit (or 'launch') = the default launch-announcement arc (today's behavior; product_shape still selects it). 'ad' = a 15-30s punchy conversion ad (hook→value→proof→one hard CTA, lint-gated, no unsupported claims). 'explainer' = teaches how it works (problem→show-the-product→features→CTA). 'social' = a ~15s single-point clip (hook→one point→CTA). 'story' = a founder/journey arc (hook→problem→journey→outcome→CTA). 'testimonial' = a REAL social-proof deck built from the customer's own review quotes (hook→wall of real quotes→rating+count→CTA) — supply `testimonials` (each {quote, attribution, rating?, source}); NEVER an AI 'happy customer' presenter and NEVER an invented quote/rating. 'demo' = a PRODUCT-FORWARD showcase of the customer's REAL product doing its job (hook→the real product on screen→what it does→proof→try-it CTA) — it LEADS with the product UI; pair it with `capture_url` (the customer's own live URL) so the product beat is a REAL screenshot of the running app instead of a stylized mockup, and supply a `product_surface` as the fallback. For a non-launch type the type's arc WINS over the product_shape arc. Pick from what the USER asked for ('make a TikTok ad', 'an explainer', 'a video from our reviews'); default to launch when unspecified.",
    ),
  product_shape: z
    .enum(PRODUCT_SHAPE_VALUES)
    .optional()
    .describe(
      "OPTIONAL product SHAPE — pick the one that best fits and the video adopts a shape-specific narrative arc (scene order + which scenes belong): 'marketplace' (two-sided, geographic — full footprint story), 'saas' (B2B software — LEADS with the product demo, no geographic footprint), 'dtc' (physical/consumer product — hero → what's-special → reviews), 'devtool' (developer product — why-now → demo → benchmarks), 'consumer' (general consumer app). Infer it from what the product IS; ask the user only if genuinely ambiguous. Omit to use the general content-adaptive order. Shape NEVER fabricates content — it only reorders + selects from the data you actually supply. SUPERSEDED by `scenes` when you author an explicit order.",
    ),
  scenes: z
    .array(launchVideoSceneSchema)
    .min(1)
    .max(24)
    .optional()
    .describe(
      "OPTIONAL — the LLM-DIRECTED scene order. When YOU want to author the exact narrative (not the shape default), supply an ordered list of scenes; the video renders THEM in THIS order. Each scene is {kind, + that kind's content}. You can fully specify a scene's content OR give just {kind} and the engine fills it from the matching intake field (one_liner→hook, problem→problem, product_surface→productui, features→cardwall, coverage→coverage, metrics→metric, cta_text→cta). Author per-scene `vo` for the spoken line. GROUNDING applies: every metric/region/chip must be real. When omitted, the engine uses the `product_shape` arc (or the content-adaptive default). Use this to tailor the story to THIS product instead of accepting the shape template.",
    ),
  audience: z
    .string()
    .min(1)
    .max(160)
    .describe("The EXTERNAL launch audience — investors, press, prospective users/followers — e.g. 'investors and marketplace founders'. The video is a public announcement, not an in-app tutorial."),
  problem: z
    .string()
    .min(1)
    .max(240)
    .optional()
    .describe(
      "OPTIONAL one-line MARKET-PAIN / WHY-NOW framing — the status-quo gap the product removes, or why this is the moment, e.g. 'Renting a car still means a counter, a line, and a markup.' Renders as a dedicated why-now beat right after the hook. GROUNDED ONLY — state the real problem in the product's own positioning; never invent a competitor claim or a market stat. Omit when there's no honest one-liner (the video reads fine without it).",
    ),
  tone: z.enum(TONE_VALUES),
  theme: z
    .enum(["editorial", "swiss", "neon"] as const)
    .optional()
    .describe(
      "OPTIONAL visual THEME — the film's whole design language, not a colour swap. `editorial` = warm paper, serif display, springs that settle (this is the DEFAULT and the pre-theme look). `swiss` = a visible modular grid, flat colour, elements SNAP into place on a beat; kinetic and data-forward. `neon` = near-black, content glowing out of the dark, emphasis by DIMMING the surround. OMIT unless the operator asked for a specific look — omitting keeps the established house style, and a theme change restyles the ENTIRE film.",
    ),
  highlight: z
    .array(z.string().min(1).max(80))
    .max(12)
    .optional()
    .describe(
      "OPTIONAL — themes/features/words to EMPHASIZE. Any feature/product item whose text matches one of these (case-insensitive) is pulled toward the FRONT so it lands in the 3 shown cards. Pure REORDER of the operator's own data — never fabricates. e.g. ['free trial','instant booking'].",
    ),
  de_emphasize: z
    .array(z.string().min(1).max(80))
    .max(12)
    .optional()
    .describe(
      "OPTIONAL — themes/features to DOWN-WEIGHT (push toward the back so they're less likely to make the 3 shown cards). Reorder only; never removes — use `avoid` to hard-exclude. e.g. ['enterprise SSO'].",
    ),
  avoid: z
    .array(z.string().min(1).max(80))
    .max(20)
    .optional()
    .describe(
      "OPTIONAL — words/topics to NEVER mention (HARD EXCLUDE). Any feature, card, chip, metric, region, product item, or whole optional beat whose text contains one of these (case-insensitive substring) is REMOVED from the final video. Use to honor 'don't mention price', 'no competitor names', etc. The render is lint-gated so an avoided term can't slip through on an ad.",
    ),
  platform: z
    .enum(PLATFORM_VALUES)
    .optional()
    .describe(
      "OPTIONAL publish platform — sets the video's default aspect: tiktok / instagram(-reels) / youtube-shorts → 9:16 (vertical); instagram-feed → 1:1 (square); youtube / linkedin / x / web → 16:9 (wide). Omit to default 16:9. Pick from where the user says they'll post ('a TikTok ad', 'for LinkedIn').",
    ),
  length_seconds: z
    .number()
    .int()
    .min(5)
    .max(180)
    .optional()
    .describe(
      "OPTIONAL target length in seconds. Scales the video_type's pacing toward this target (tighter for a shorter clip), clamped to a sane range. Only steers a NON-launch video_type's pacing; the launch path keeps its proven default timing.",
    ),
  aspects: z
    .array(z.enum(ASPECT_VALUES))
    .min(1)
    .max(3)
    .optional()
    .describe(
      "OPTIONAL explicit list of output aspect ratios to RENDER (multi-format fan-out). Set this ONLY when the user explicitly asks for more than one format (e.g. 'make it for TikTok AND YouTube') — otherwise OMIT and the video renders the single `platform` aspect (default 16:9). All variants share ONE media budget; they don't multiply Higgsfield cost. Values: '16:9' (wide), '1:1' (square), '9:16' (vertical).",
    ),
  capture_url: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "OPTIONAL — a public URL of the customer's OWN live product to CAPTURE a real screenshot from and show as the product surface (instead of a stylized mockup). Set this ONLY when the user wants the video to show their ACTUAL running product ('show our real product', 'capture our live site'). The backend navigates the URL headlessly (never an agent tool), screenshots the first screen, and uses it as the productui image; if the capture lands on a login wall / blank / error page it silently falls back to the stylized product surface. SAME GROUNDING + SSRF RULE AS `url`, ENFORCED SERVER-SIDE: it must be the customer's own product URL (their recorded product_url or a host they typed in this conversation) and it must be a public https address — a private/internal/loopback address is refused. Omit unless the user explicitly asked to show the real product.",
    ),
  hook_pack: z
    .array(z.string().min(1).max(200))
    .min(2)
    .max(6)
    .optional()
    .describe(
      "OPTIONAL — a SOCIAL CLIP PACK: 2-6 DISTINCT opening hooks (short scroll-stopping lines) for the SAME product. The studio auto-renders ONE short clip PER hook in a single request (a pack) — you do NOT hand-type full A/B `scripts`. Author each hook from the company's REAL positioning/brain, a different angle each (e.g. lead with the core value, then a proof point, then the pain it removes); default to ~3. SAME GROUNDING as `one_liner` — never invent a claim, number, or superlative. Best paired with `platform:'tiktok'`/`'instagram_reels'` (9:16) and `capture_url` (the one real-product screenshot is reused across every clip at no extra cost). The whole pack SHARES ONE media budget and is capped at 6 outputs total. IGNORED if you also pass `scripts` (hand-authored A/B wins). Use when the user asks for 'a few TikToks', 'a pack of hooks', 'variations to test' — NOT for a single clip.",
    ),
  features: z
    .array(launchVideoFeatureSchema)
    .min(1)
    .max(12)
    .describe(
      "Your key capabilities, each a {title, detail} plus an OPTIONAL real `meta` data tag. On the default arc they render as ONE dense capability wall showing your 3 STRONGEST, most concrete capabilities (only the first 3 are shown, so order them best-first); an authored `scenes` order can also give each one its own `feature` scene. Each a positioning/what-it-does line, not an end-user how-to.",
    ),
  product_surface: z
    .object({
      header: z
        .object({
          title: z.string().min(1).max(60).describe("The search/list header label, e.g. 'Cars near you' / 'Your dashboard' / 'Shop all'."),
          search_placeholder: z.string().max(60).optional().describe("Optional placeholder for the search field."),
        })
        .optional(),
      items: z
        .array(
          z.object({
            glyph: z
              .string()
              .max(20)
              .optional()
              .describe(
                "OPTIONAL thumbnail glyph name (one of: car, chart, box, bolt, spark, user, shield, clock, chat, check). Pure SVG icon — NOT a real image. Pick the one that best fits the item; omit to auto-derive from the title.",
              ),
            title: z.string().min(1).max(60).describe("The item's main line, e.g. 'Tesla Model 3' / 'Monthly revenue' / 'Linen shirt'."),
            image_prompt: z
              .string()
              .max(300)
              .optional()
              .describe(
                "OPTIONAL photoreal IMAGE PROMPT for this card's thumbnail — when supplied, a REAL product image is generated (Higgsfield, ~1 credit) and shown instead of the SVG glyph. Use for products with a visual subject (a car, a physical product, a UI screenshot-style shot) — e.g. 'a clean silver Tesla Model 3 parked on a sunny residential street, photoreal, 16:9'. Describe ONLY the real product/subject — never an invented logo, fake metric, or text overlay. OMIT for abstract items (the glyph fallback reads fine). People are fine.",
              ),
            chips: z
              .array(z.string().min(1).max(28))
              .min(1)
              .max(3)
              .describe("1-3 short meta chips, e.g. ['$48/day','4.9★','Austin TX'] or ['$12.4k MRR','↑ 12%']."),
          }),
        )
        .min(2)
        .max(4),
    })
    .optional()
    .describe(
      "OPTIONAL — describe your REAL product surface so the video shows the actual product on screen (a device/browser frame with a search header + 2-4 item cards). PRODUCT-AGNOSTIC: items are car listings for a marketplace, dashboard rows for a SaaS, product cards for a DTC brand. Supply REPRESENTATIVE-BUT-HONEST content for YOUR product (real-looking example listings/rows are fine for a UI mockup; do NOT present a fabricated aggregate/business metric here — those belong in `metrics`). OMIT entirely if you can't describe a believable surface — the scene is then skipped.",
    ),
  coverage: z
    .object({
      headline: z.string().min(1).max(80).optional().describe("Scene title, e.g. 'Live in 5 states.' / 'Available in 12 countries.'"),
      regions: z
        .array(z.string().min(1).max(40))
        .min(2)
        .max(8)
        .describe("REAL region/location labels the product operates in — US states, countries, cities, anything. e.g. ['California','Nevada','Texas','Arizona','Florida']."),
    })
    .optional()
    .describe(
      "OPTIONAL geographic footprint. Renders a generic 'where we operate' scene (region pin tiles + a live-markets count). Geography-agnostic — works for states/countries/cities. Supply ONLY real coverage; OMIT for a non-geographic product (most SaaS/DTC) — the scene is then skipped.",
    ),
  narration: z
    .object({
      hook: z.string().max(240).optional(),
      problem: z.string().max(240).optional(),
      product: z.string().max(240).optional(),
      features: z.string().max(240).optional(),
      coverage: z.string().max(240).optional(),
      metrics: z.string().max(240).optional(),
      cta: z.string().max(240).optional(),
    })
    .optional()
    .describe(
      "OPTIONAL per-beat spoken VO lines. These are the INVESTOR-GRADE NARRATION script — author lines that ADD context the viewer can't read on screen (the wedge, the why-now, the unfair advantage, the ask), NOT a verbatim echo of the on-screen text. Lead with traction. Answer 'how is this different from <the obvious competitor>?' honestly. Keep it grounded — never voice a number or claim you wouldn't put in writing to an investor. When omitted, the engine falls back to a plain caption derived from the on-screen text.",
    ),
  proof: z
    .object({
      stat: z.string().min(1).max(40).describe("The big number, e.g. '10x' or '$1.2M' or '100+'."),
      label: z.string().min(1).max(160).describe("What the stat means."),
    })
    .optional()
    .describe("Back-compat single headline stat. Prefer `metrics` (1-3 stats) for a richer Metric scene; if only `proof` is given it renders as a single metric."),
  metrics: z
    .array(
      z.object({
        stat: z.string().min(1).max(40).describe("The big number, e.g. '600+', '$1.2M', '4.9★'."),
        label: z.string().min(1).max(160).describe("What the stat means, e.g. 'active hosts'."),
      }),
    )
    .min(1)
    .max(3)
    .optional()
    .describe(
      "OPTIONAL 1-3 REAL headline TRACTION metrics for the Metric scene — LEAD WITH THESE: investors care most about the numbers (users, GMV, growth, revenue), so author the customer's TRUE top-line traction (from their site or connected data), e.g. {stat:'600+',label:'active hosts'}, {stat:'$1.2M',label:'monthly GMV'}. The engine renders multiple stat cards when >1. NEVER fabricate a stat; omit the whole array if there are no real numbers. Supersedes `proof` when present.",
    ),
  testimonials: z
    .array(launchVideoTestimonialSchema)
    .min(1)
    .max(6)
    .optional()
    .describe(
      "OPTIONAL — the customer's REAL review quotes for a `video_type:'testimonial'` social-proof deck. Each is {quote, attribution, rating?, source}. They render as the cardwall (the 3 strongest shown), the rating + count go in `metrics`. PROVENANCE IS ENFORCED: every quote's `source` must name where it really came from (a connected review feed / operator-DB row / named public review). A sourceless or fabricated quote is REFUSED on the public path and DROPPED on the Slack path — NEVER invent a reviewer, a rating, or a quote (fabricated endorsements are an FTC/trust failure). Pull these via your read tools; omit the whole array if you have no real reviews.",
    ),
  hero_image_prompt: z
    .string()
    .max(300)
    .optional()
    .describe(
      "OPTIONAL photoreal HERO IMAGE PROMPT — when supplied, a REAL hero image is generated (Higgsfield, ~1 credit) and shown in the opening hook beat instead of the decorative skeleton cards. The single biggest 'this is a real product' lever for a launch. Describe the product/scene (people are fine; no invented logos/text) — e.g. 'a row of cars parked on a tree-lined street at golden hour, photoreal, cinematic, 16:9'. OMIT for an abstract product (the skeleton-chrome fallback reads fine).",
    ),
  broll_prompt: z
    .string()
    .max(300)
    .optional()
    .describe(
      "OPTIONAL cinematic B-ROLL prompt (Phase 4) — when supplied, a ~6s generated clip (Higgsfield seedance, ~22-72cr) plays as a full-bleed cinematic opener right after the hook. Describe a scene, product in motion, or an AI person (no fabricated UI/text/logos) — e.g. 'slow dolly past cars parked on a tree-lined street at golden hour, cinematic, 16:9'. Counts toward the 150-credit/video media cap (shared with images); OMIT to keep the video MG-only. (For finer control, place a `broll` scene yourself in `scenes[]`.)",
    ),
  cta_text: z
    .string()
    .min(1)
    .max(80)
    .describe(
      "Closing LAUNCH call-to-action for a MAKER/COMMUNITY audience (LinkedIn/Twitter/Product Hunt) — a try-it / support-the-launch line: 'Find a car near you', 'Try it free', 'Follow along', \"We're live on Product Hunt\". This string renders as the closing button, so it must match the launch audience. NEVER an INVESTOR/B2B ask ('Building in marketplaces? Let's talk', 'Book a demo', 'Talk to sales', 'If you invest…') and NEVER an in-app action ('Start your trip' / 'Book now'); avoid the limp 'Learn more'.",
    ),
  cta_url: z.string().min(1).max(300),
  festival: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe(
      "OPTIONAL — the festival/holiday this promo is for (e.g. 'July 4th', 'Labor Day', 'Diwali'). Used ONLY for video_type 'promo': it drives a SUITABILITY check that BLOCKS a discount promo on somber/remembrance days (MLK Day, Juneteenth, Veterans Day-as-remembrance, 9/11) and warns on restrained ones (Memorial Day, religious solemn days). Omit for a non-festival promo.",
    ),
  coupon: z
    .object({
      code: z
        .string()
        .min(1)
        .max(40)
        .describe("The exact coupon code the OPERATOR explicitly provided (e.g. 'SUMMER20'). NEVER invent or guess a code — if you don't have a real one from the operator, OMIT `coupon` entirely and the promo renders without an offer. Praxis only RENDERS this string; it never creates, validates, or activates the code — the operator makes the coupon live and posts."),
      discount_label: z.string().min(1).max(48).describe("The offer as shown, e.g. '$30 off your trip' or '20% off'."),
      expiry_label: z.string().min(1).max(48).describe("ABSOLUTE expiry as shown, e.g. 'Ends July 25, 2026'. Never a vague 'this weekend'."),
    })
    .optional()
    .describe(
      "OPTIONAL coupon for video_type 'promo'. When present, the closing CTA shows the discount as its headline and 'CODE: <code>' + the expiry as its two chips. OPERATOR-SUPPLIED ONLY — Praxis does not create, verify, or activate the coupon. OMIT for a non-coupon promo.",
    ),
  channel_id: z.string().max(64).optional(),
  thread_ts: z.string().max(64).optional(),
});

const variantScriptOverlaySchema = launchVideoIntakeBase
  .pick({
    one_liner: true,
    problem: true,
    tone: true,
    scenes: true,
    features: true,
    product_surface: true,
    coverage: true,
    narration: true,
    proof: true,
    metrics: true,
    hero_image_prompt: true,
    broll_prompt: true,
    cta_text: true,
    cta_url: true,
    highlight: true,
    de_emphasize: true,
    avoid: true,
  })
  .partial();

export type VariantScriptOverlay = z.infer<typeof variantScriptOverlaySchema>;

export const launchVideoIntakeSchema = launchVideoIntakeBase.extend({
  scripts: z
    .array(variantScriptOverlaySchema)
    .min(1)
    .max(5)
    .optional()
    .describe(
      "OPTIONAL A/B SCRIPT VARIANTS (multiplies media spend — opt-in only). Set this ONLY when the user explicitly asks for two or more different takes/scripts of the SAME video (e.g. 'give me two versions, one leading with price, one leading with speed'). The BASE intake is variant A; each entry here is an additional variant (B, C, ...) carrying ONLY the fields that DIFFER from A — typically a different `one_liner`/hook, `narration`, `cta_text`, `scenes`, `features`, or `metrics`. Shared fields (product_name, url, video_type, platform, aspects) stay constant across every variant. Each variant renders its OWN mp4 (one run artifact per variant × aspect) and EACH generates its own media under the 150-credit cap, so two variants cost roughly twice the media of one. OMIT for a single video (the default, byte-identical to today).",
    ),
}).superRefine((val, ctx) => {
  if (val.coupon && val.video_type !== "promo") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["coupon"],
      message: "`coupon` is only valid for video_type 'promo'.",
    });
  }
});

export type LaunchVideoIntake = z.infer<typeof launchVideoIntakeSchema>;

export type Aspect = "16:9" | "1:1" | "9:16";

export interface BeatVO {
  audioFile?: string;
  srtText?: string;
}

export type StatusDot = "green" | "amber" | "red" | "blue";

export interface ChatMessage {
  speaker: string;
  monogram?: string;
  accent?: string;
  mention?: string;
  body?: string;
  reply?: { badge?: string; role?: string; statusDot?: StatusDot; body: string };
}

export interface WallCard {
  label: string;
  accent: string;
  headline: string;
  body?: string;
  footer?: string;
  pill?: string;
}

export interface MetricItem {
  stat: string;
  label: string;
  series?: number[];
  delta?: { dir: "up" | "down" | "flat"; text: string };
}

export interface ProductUIItem {
  glyph?: string;
  image?: string;
  imagePrompt?: string;
  title: string;
  chips: string[];
}

export type Beat =
  | { kind: "hook"; headline?: string; sub?: string; image?: string; imagePrompt?: string; durationFrames?: number; vo?: BeatVO }
  | { kind: "problem"; headline?: string; sub?: string; durationFrames?: number; vo?: BeatVO }
  | { kind: "feature"; icon?: string; glyph?: string; headline?: string; sub?: string; durationFrames?: number; vo?: BeatVO }
  | { kind: "proof"; stat?: string; statLabel?: string; headline?: string; sub?: string; durationFrames?: number; vo?: BeatVO }
  | { kind: "cta"; headline?: string; sub?: string; chips?: string[]; durationFrames?: number; vo?: BeatVO }
  | { kind: "chat"; eyebrow?: string; headline?: string; messages: ChatMessage[]; durationFrames?: number; vo?: BeatVO }
  | { kind: "cardwall"; eyebrow?: string; headline?: string; cards: WallCard[]; durationFrames?: number; vo?: BeatVO }
  | {
      kind: "metric";
      eyebrow?: string;
      headline?: string;
      metrics?: MetricItem[];
      stat?: string;
      label?: string;
      series?: number[];
      durationFrames?: number;
      vo?: BeatVO;
    }
  | {
      kind: "productui";
      eyebrow?: string;
      headline?: string;
      header?: { title: string; searchPlaceholder?: string };
      domain?: string;
      items: ProductUIItem[];
      durationFrames?: number;
      vo?: BeatVO;
    }
  | { kind: "coverage"; eyebrow?: string; headline?: string; regions: string[]; durationFrames?: number; vo?: BeatVO }
  | {
      kind: "broll";
      eyebrow?: string;
      headline?: string;
      video?: string;
      videoPrompt?: string;
      durationFrames?: number;
      vo?: BeatVO;
    };

export type ThemeName = "editorial" | "swiss" | "neon";

export interface VideoBrief {
  product: { name: string; oneLiner: string; url: string };
  brand: { primaryColor: string; accentColor: string; bgColor?: string; logoUrl?: string };
  audience: string;
  tone: Tone;
  theme?: ThemeName;
  cta: { text: string; url: string };
  aspect?: Aspect;
  beats: Beat[];
  music?: { file?: string };
}

const DEFAULT_BRAND = {
  primaryColor: "#5B6CFF",
  accentColor: "#22D3EE",
  bgColor: "#0B0E14",
} as const;

const CARD_ACCENTS = ["#5B5BF5", "#2FB573", "#E0991F", "#E2574C", "#7C6CE0", "#3C7DD6"];

const BEAT_FRAMES: Record<Beat["kind"], number> = {
  hook: 120,
  problem: 132,
  feature: 132,
  proof: 132,
  cta: 120,
  chat: 162,
  cardwall: 132,
  metric: 156,
  productui: 162,
  coverage: 132,
  broll: 180,
};

export function totalBriefFrames(beats: Beat[]): number {
  return Math.max(1, beats.reduce((sum, b) => sum + (b.durationFrames && b.durationFrames > 0 ? Math.round(b.durationFrames) : BEAT_FRAMES[b.kind]), 0));
}

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function resolveBrand(kit?: BrandKit): VideoBrief["brand"] {
  const c = kit?.colors ?? {};
  const brand: VideoBrief["brand"] = {
    primaryColor: c.primary && HEX_RE.test(c.primary) ? c.primary : DEFAULT_BRAND.primaryColor,
    accentColor: c.accent && HEX_RE.test(c.accent) ? c.accent : DEFAULT_BRAND.accentColor,
    bgColor: c.bg && HEX_RE.test(c.bg) ? c.bg : DEFAULT_BRAND.bgColor,
  };
  if (kit?.logoUrl) brand.logoUrl = kit.logoUrl;
  return brand;
}

function applyPacing(beats: Beat[], scalar: number): Beat[] {
  if (scalar === 1) return beats;
  return beats.map((b) => ({
    ...b,
    durationFrames: Math.max(1, Math.round((b.durationFrames && b.durationFrames > 0 ? b.durationFrames : BEAT_FRAMES[b.kind]) * scalar)),
  }));
}

function matchesAny(text: string | undefined, terms: string[]): boolean {
  if (!text) return false;
  const lc = text.toLowerCase();
  return terms.some((t) => lc.includes(t.toLowerCase()));
}

function resolvePacingScalar(profile: VideoTypeProfile, lengthSeconds: number | undefined): number {
  if (!lengthSeconds || lengthSeconds <= 0 || profile.lengthTargetSec <= 0) return profile.pacingScalar;
  const ratio = lengthSeconds / profile.lengthTargetSec;
  const scaled = profile.pacingScalar * ratio;
  const lo = Math.max(0.4, profile.pacingScalar * 0.4);
  const hi = Math.min(2.0, profile.pacingScalar * 1.6);
  return Math.min(hi, Math.max(lo, scaled));
}

function orderFeatures<T extends { title: string; detail: string; meta?: string }>(
  features: T[],
  highlight: string[],
  deEmphasize: string[],
): T[] {
  if (highlight.length === 0 && deEmphasize.length === 0) return features;
  const rank = (f: T): number => {
    const blob = `${f.title} ${f.detail} ${f.meta ?? ""}`;
    if (highlight.length > 0 && matchesAny(blob, highlight)) return -1;
    if (deEmphasize.length > 0 && matchesAny(blob, deEmphasize)) return 1;
    return 0;
  };
  return features
    .map((f, i) => ({ f, i, r: rank(f) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.f);
}

function pruneAvoided(brief: VideoBrief, terms: string[]): VideoBrief {
  const hit = (s: string | undefined) => matchesAny(s, terms);
  const beats: Beat[] = [];
  for (const b of brief.beats) {
    if (b.kind === "cardwall") {
      const cards = b.cards.filter((c) => !(hit(c.label) || hit(c.headline) || hit(c.body) || hit(c.footer) || hit(c.pill)));
      if (cards.length === 0) continue;
      const vo = b.vo && hit(b.vo.srtText) ? undefined : b.vo;
      beats.push({ ...b, cards, ...(vo ? { vo } : {}) });
      continue;
    }
    if (b.kind === "productui") {
      const items = b.items.filter((it) => !(hit(it.title) || it.chips.some(hit)));
      if (items.length === 0) continue;
      if (hit(b.headline) || hit(b.eyebrow) || hit(b.header?.title) || hit(b.header?.searchPlaceholder)) continue;
      beats.push({ ...b, items });
      continue;
    }
    if (b.kind === "coverage") {
      const regions = b.regions.filter((r) => !hit(r));
      if (regions.length === 0 || hit(b.headline) || hit(b.eyebrow)) continue;
      beats.push({ ...b, regions });
      continue;
    }
    if (b.kind === "metric") {
      const metrics = (b.metrics ?? []).filter((m) => !(hit(m.stat) || hit(m.label)));
      if (metrics.length === 0 || hit(b.headline) || hit(b.eyebrow)) continue;
      beats.push({ ...b, metrics });
      continue;
    }
    if (b.kind === "problem") {
      if (hit(b.headline) || hit(b.sub) || hit(b.vo?.srtText)) continue;
      beats.push(b);
      continue;
    }
    if (b.kind === "broll") {
      if (hit(b.headline) || hit(b.eyebrow) || hit(b.vo?.srtText)) continue;
      beats.push(b);
      continue;
    }
    if (b.kind === "cta") {
      const chips = b.chips?.filter((c) => !hit(c));
      const next = { ...b } as Extract<Beat, { kind: "cta" }>;
      if (chips && chips.length > 0) next.chips = chips;
      else delete next.chips;
      beats.push(next);
      continue;
    }
    beats.push(b);
  }
  return { ...brief, beats };
}

export function intakeToVideoBrief(intake: LaunchVideoIntake, opts?: MapperOptions): VideoBrief {
  const name = intake.product_name;
  const n = intake.narration;

  const videoType: VideoType = intake.video_type ?? "launch";
  const profile = VIDEO_TYPE_PROFILES[videoType];
  const brand = resolveBrand(opts?.brandKit);

  const avoidTerms = intake.avoid ?? [];
  const highlight = intake.highlight ?? [];
  const deEmphasize = intake.de_emphasize ?? [];
  const aspect: Aspect = aspectForPlatform(intake.platform);
  const pacingScalar = resolvePacingScalar(profile, intake.length_seconds);
  const pace = (beats: Beat[]): Beat[] => (videoType === "launch" ? beats : applyPacing(beats, pacingScalar));
  const finalize = (b: VideoBrief): VideoBrief => sanitizeBrief(avoidTerms.length > 0 ? pruneAvoided(b, avoidTerms) : b);

  if (intake.scenes && intake.scenes.length > 0) {
    const authored = authoredScenesToBeats(intake);
    if (authored.length > 0) {
      return finalize({
        product: { name, oneLiner: intake.one_liner, url: intake.url },
        brand,
        audience: intake.audience,
        tone: intake.tone,
        theme: intake.theme,
        cta: { text: intake.cta_text, url: intake.cta_url },
        aspect,
        beats: pace(authored),
      });
    }
  }

  const arc = videoType !== "launch" && profile.arc ? profile.arc : arcForShape(intake.product_shape);
  const inArc = (slot: SceneSlot) => arc.includes(slot);

  const hookBeat: Beat = {
    kind: "hook",
    headline: intake.one_liner,
    sub: `Meet ${name}.`,
    ...(intake.hero_image_prompt ? { imagePrompt: intake.hero_image_prompt } : {}),
    vo: { srtText: n?.hook ?? intake.one_liner },
  };

  const problemBeat: Beat | null = intake.problem
    ? { kind: "problem", headline: intake.problem, vo: { srtText: n?.problem ?? intake.problem } }
    : null;

  let productuiBeat: Beat | null = null;
  if (intake.product_surface) {
    const ps = intake.product_surface;
    productuiBeat = {
      kind: "productui",
      eyebrow: name,
      headline: `Inside ${name}.`,
      header: ps.header ? { title: ps.header.title, searchPlaceholder: ps.header.search_placeholder } : undefined,
      domain: stripScheme(intake.url),
      items: ps.items.map((it) => ({
        glyph: it.glyph,
        ...(it.image_prompt ? { imagePrompt: it.image_prompt } : {}),
        title: it.title,
        chips: it.chips,
      })),
      vo: { srtText: n?.product ?? `This is ${name}.` },
    };
  }

  const orderedFeatures = orderFeatures(intake.features, highlight, deEmphasize);
  const keptFeatures =
    avoidTerms.length > 0
      ? orderedFeatures.filter((f) => !matchesAny(`${f.title} ${f.detail} ${f.meta ?? ""}`, avoidTerms))
      : orderedFeatures;
  const topFeatures = keptFeatures.slice(0, 3);
  const useTestimonialWall = videoType === "testimonial" && (intake.testimonials?.length ?? 0) > 0;
  const topTestimonials = useTestimonialWall
    ? (avoidTerms.length > 0
        ? intake.testimonials!.filter((t) => !matchesAny(`${t.quote} ${t.attribution} ${t.rating ?? ""}`, avoidTerms))
        : intake.testimonials!
      ).slice(0, 3)
    : [];
  const cardwallBeat: Beat =
    useTestimonialWall && topTestimonials.length > 0
      ? {
          kind: "cardwall",
          eyebrow: name,
          headline: `What they're saying.`,
          cards: topTestimonials.map((t, i) => {
            const card: WallCard = {
              label: String(i + 1).padStart(2, "0"),
              accent: CARD_ACCENTS[i % CARD_ACCENTS.length],
              headline: t.quote,
              body: t.attribution,
            };
            if (t.rating) card.footer = t.rating;
            return card;
          }),
          vo: { srtText: n?.features ?? `${topTestimonials.map((t) => t.attribution.replace(/[.!?]+$/, "")).join(". ")}.` },
        }
      : {
          kind: "cardwall",
          eyebrow: name,
          headline: `The short version.`,
          cards: topFeatures.map((f, i) => {
            const card: WallCard = {
              label: String(i + 1).padStart(2, "0"),
              accent: CARD_ACCENTS[i % CARD_ACCENTS.length],
              headline: f.title,
              body: f.detail,
            };
            if (f.meta) card.footer = f.meta;
            return card;
          }),
          vo: { srtText: n?.features ?? `${topFeatures.map((f) => f.title.replace(/[.!?]+$/, "")).join(". ")}.` },
        };

  const keptRegions =
    intake.coverage && avoidTerms.length > 0
      ? intake.coverage.regions.filter((r) => !matchesAny(r, avoidTerms))
      : intake.coverage?.regions ?? [];
  const coverageHeadlineAvoided =
    avoidTerms.length > 0 && matchesAny(intake.coverage?.headline, avoidTerms);
  const coverageAvailable = Boolean(intake.coverage) && keptRegions.length > 0 && !coverageHeadlineAvoided;
  let coverageBeat: Beat | null = null;
  if (intake.coverage && coverageAvailable) {
    const cov = intake.coverage;
    coverageBeat = {
      kind: "coverage",
      eyebrow: name,
      headline: cov.headline ?? `Where ${name} operates.`,
      regions: keptRegions,
      vo: { srtText: n?.coverage ?? `Live in ${keptRegions.length} markets.` },
    };
  }

  const rawMetrics: MetricItem[] = intake.metrics
    ? intake.metrics.map((m) => ({ stat: m.stat, label: m.label }))
    : intake.proof
      ? [{ stat: intake.proof.stat, label: intake.proof.label }]
      : [];
  const metrics: MetricItem[] =
    avoidTerms.length > 0 ? rawMetrics.filter((m) => !matchesAny(`${m.stat} ${m.label}`, avoidTerms)) : rawMetrics;
  const metricBeat: Beat | null =
    metrics.length > 0
      ? {
          kind: "metric",
          eyebrow: "Traction",
          headline: "The numbers so far.",
          metrics,
          vo: { srtText: n?.metrics ?? `${metrics.map((m) => `${m.stat}, ${m.label}`).join(". ")}.` },
        }
      : null;

  const ctaChips: string[] = [];
  const coupon = videoType === "promo" ? intake.coupon : undefined;
  if (coupon) {
    ctaChips.push(`CODE: ${coupon.code}`.toUpperCase());
    ctaChips.push(coupon.expiry_label.toUpperCase());
  } else {
    if (coverageAvailable && inArc("coverage")) ctaChips.push(`${keptRegions.length} MARKETS`);
    if (inArc("metric")) for (const m of metrics.slice(0, 2)) ctaChips.push(`${m.stat} ${m.label}`.toUpperCase());
  }
  const ctaHeadline = coupon?.discount_label ?? intake.cta_text;
  const ctaBeat: Beat = {
    kind: "cta",
    headline: ctaHeadline,
    sub: intake.cta_url,
    ...(ctaChips.length > 0 ? { chips: ctaChips.slice(0, 3) } : {}),
    vo: { srtText: n?.cta ?? `${ctaHeadline}. ${stripScheme(intake.cta_url)}.` },
  };

  const bySlot: Record<SceneSlot, Beat | null> = {
    hook: hookBeat,
    problem: problemBeat,
    productui: productuiBeat,
    cardwall: cardwallBeat,
    coverage: coverageBeat,
    metric: metricBeat,
    cta: ctaBeat,
  };
  const beats: Beat[] = [];
  for (const slot of arc) {
    const b = bySlot[slot];
    if (b) beats.push(b);
  }

  if (intake.broll_prompt) {
    const brollBeat: Beat = {
      kind: "broll",
      eyebrow: name,
      headline: intake.one_liner,
      videoPrompt: intake.broll_prompt,
      vo: { srtText: n?.hook ?? intake.one_liner },
    };
    const hookAt = beats.findIndex((b) => b.kind === "hook");
    beats.splice(hookAt + 1, 0, brollBeat);
  }

  return finalize({
    product: { name, oneLiner: intake.one_liner, url: intake.url },
    brand,
    audience: intake.audience,
    tone: intake.tone,
    theme: intake.theme,
    cta: { text: intake.cta_text, url: intake.cta_url },
    aspect,
    beats: pace(beats),
  });
}

function authoredScenesToBeats(intake: LaunchVideoIntake): Beat[] {
  const name = intake.product_name;
  const scenes = intake.scenes ?? [];
  const beats: Beat[] = [];

  for (const s of scenes) {
    const before = beats.length;
    switch (s.kind) {
      case "hook": {
        const headline = s.headline ?? intake.one_liner;
        const heroPrompt = s.image_prompt ?? intake.hero_image_prompt;
        beats.push({
          kind: "hook",
          headline,
          sub: s.sub ?? `Meet ${name}.`,
          ...(heroPrompt ? { imagePrompt: heroPrompt } : {}),
          vo: { srtText: s.vo ?? headline },
        });
        break;
      }
      case "feature": {
        const headline = s.headline;
        if (!headline) break;
        beats.push({
          kind: "feature",
          headline,
          ...(s.sub ? { sub: s.sub } : {}),
          ...(s.glyph ? { glyph: s.glyph } : {}),
          vo: { srtText: s.vo ?? [headline, s.sub].filter(Boolean).join(". ") },
        });
        break;
      }
      case "proof": {
        const stat = s.stat ?? intake.proof?.stat;
        const statLabel = s.stat_label ?? intake.proof?.label;
        if (!stat || !statLabel) break;
        beats.push({
          kind: "proof",
          stat,
          statLabel,
          ...(s.headline ? { headline: s.headline } : {}),
          vo: { srtText: s.vo ?? `${stat}, ${statLabel}.` },
        });
        break;
      }
      case "problem": {
        const headline = s.headline ?? intake.problem;
        if (!headline) break;
        beats.push({ kind: "problem", headline, vo: { srtText: s.vo ?? headline } });
        break;
      }
      case "productui": {
        const rawItems = s.items ?? intake.product_surface?.items;
        if (!rawItems || rawItems.length === 0) break;
        const header = s.header ?? intake.product_surface?.header;
        beats.push({
          kind: "productui",
          eyebrow: s.eyebrow ?? name,
          headline: s.headline ?? `Inside ${name}.`,
          header: header ? { title: header.title, searchPlaceholder: header.search_placeholder } : undefined,
          domain: stripScheme(intake.url),
          items: rawItems.map((it) => ({
            glyph: it.glyph,
            ...((it as { image_prompt?: string }).image_prompt ? { imagePrompt: (it as { image_prompt?: string }).image_prompt } : {}),
            title: it.title,
            chips: it.chips,
          })),
          vo: { srtText: s.vo ?? `This is ${name}.` },
        });
        break;
      }
      case "cardwall": {
        const source = s.cards ?? intake.features;
        const top = source.slice(0, 3);
        if (top.length === 0) break;
        beats.push({
          kind: "cardwall",
          eyebrow: s.eyebrow ?? name,
          headline: s.headline ?? `The short version.`,
          cards: top.map((f, i) => {
            const card: WallCard = {
              label: String(i + 1).padStart(2, "0"),
              accent: CARD_ACCENTS[i % CARD_ACCENTS.length],
              headline: f.title,
              body: f.detail,
            };
            if (f.meta) card.footer = f.meta;
            return card;
          }),
          vo: { srtText: s.vo ?? `${top.map((f) => f.title.replace(/[.!?]+$/, "")).join(". ")}.` },
        });
        break;
      }
      case "coverage": {
        const regions = s.regions ?? intake.coverage?.regions;
        if (!regions || regions.length === 0) break;
        beats.push({
          kind: "coverage",
          eyebrow: s.eyebrow ?? name,
          headline: s.headline ?? intake.coverage?.headline ?? `Where ${name} operates.`,
          regions,
          vo: { srtText: s.vo ?? `Live in ${regions.length} markets.` },
        });
        break;
      }
      case "metric": {
        const metrics: MetricItem[] = s.metrics
          ? s.metrics.map((m) => ({ stat: m.stat, label: m.label }))
          : intake.metrics
            ? intake.metrics.map((m) => ({ stat: m.stat, label: m.label }))
            : intake.proof
              ? [{ stat: intake.proof.stat, label: intake.proof.label }]
              : [];
        if (metrics.length === 0) break;
        beats.push({
          kind: "metric",
          eyebrow: s.eyebrow ?? "Traction",
          headline: s.headline ?? "The numbers so far.",
          metrics,
          vo: { srtText: s.vo ?? `${metrics.map((m) => `${m.stat}, ${m.label}`).join(". ")}.` },
        });
        break;
      }
      case "cta": {
        const headline = s.headline ?? intake.cta_text;
        const chips = s.chips && s.chips.length > 0 ? s.chips.slice(0, 3) : undefined;
        beats.push({
          kind: "cta",
          headline,
          sub: intake.cta_url,
          ...(chips ? { chips } : {}),
          vo: { srtText: s.vo ?? `${headline}. ${stripScheme(intake.cta_url)}.` },
        });
        break;
      }
      case "broll": {
        const prompt = s.video_prompt?.trim() || s.prompt?.trim() || intake.broll_prompt?.trim();
        if (!prompt) break;
        beats.push({
          kind: "broll",
          eyebrow: s.eyebrow ?? name,
          ...(s.headline ? { headline: s.headline } : {}),
          videoPrompt: prompt,
          vo: { srtText: s.vo ?? s.headline ?? intake.one_liner },
        });
        break;
      }
    }
    if (s.duration_frames) {
      for (let i = before; i < beats.length; i++) {
        const b = beats[i];
        if (b) b.durationFrames = s.duration_frames;
      }
    }
  }

  return beats;
}

export function stripDashes(s: string): string {
  if (typeof s !== "string") return s;
  return s
    .replace(/\s*[—―]\s*/g, ", ")
    .replace(/,\s*,/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/,\s*([.!?;:])/g, "$1")
    .trim();
}

export function sanitizeBrief<T>(x: T): T {
  if (typeof x === "string") return stripDashes(x) as unknown as T;
  if (Array.isArray(x)) return x.map((v) => sanitizeBrief(v)) as unknown as T;
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as Record<string, unknown>)) {
      out[k] = sanitizeBrief((x as Record<string, unknown>)[k]);
    }
    return out as unknown as T;
  }
  return x;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}
