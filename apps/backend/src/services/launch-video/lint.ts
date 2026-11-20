
import type { VideoBrief, VideoType } from "./brief-mapper";

export interface LintViolation {
  code: string;
  message: string;
  sample?: string;
}

export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
  caveats: string[];
}

export const OUTWARD_CLAIM_VIDEO_TYPES: ReadonlySet<VideoType> = new Set<VideoType>(["ad", "social", "promo"]);

const INAPPROPRIATE_FESTIVAL_RE =
  /\b(mlk|martin\s+luther\s+king|juneteenth|(?:veterans?|veteran's|veterans')\s+day|9\s*[/-]\s*11|sept(?:\.|ember)?\s+11(?:th)?|patriot\s+day|holocaust\s+remembrance|yom\s+hashoah)\b/i;

const RESTRAINED_FESTIVAL_RE =
  /\b(memorial\s+day|ash\s+wednesday|good\s+friday|lent|yom\s+kippur|rosh\s+hashanah|ramadan|eid\b|day\s+of\s+the\s+dead|d[ií]a\s+de\s+los\s+muertos)\b/i;

export function isOutwardClaimType(t: VideoType): boolean {
  return OUTWARD_CLAIM_VIDEO_TYPES.has(t);
}

function collectStrings(brief: VideoBrief): string[] {
  const out: string[] = [];
  const push = (s?: string) => {
    if (typeof s === "string" && s.trim().length > 0) out.push(s);
  };
  push(brief.product?.name);
  push(brief.product?.oneLiner);
  push(brief.cta?.text);
  for (const b of brief.beats) {
    const any = b as Record<string, unknown>;
    push(any.headline as string | undefined);
    push(any.sub as string | undefined);
    push(any.eyebrow as string | undefined);
    if (b.vo?.srtText) push(b.vo.srtText);
    if (b.kind === "cardwall") for (const c of b.cards) [c.label, c.headline, c.body, c.footer, c.pill].forEach(push);
    if (b.kind === "productui") {
      push(b.header?.title);
      push(b.header?.searchPlaceholder);
      for (const it of b.items) {
        push(it.title);
        it.chips.forEach(push);
      }
    }
    if (b.kind === "coverage") b.regions.forEach(push);
    if (b.kind === "metric") for (const m of b.metrics ?? []) [m.stat, m.label].forEach(push);
    if (b.kind === "cta") (b.chips ?? []).forEach(push);
  }
  return out;
}

const EM_DASH_RE = /[—―]/;

const SUPERLATIVE_ABSOLUTE_RE = /#\s?1\b|\bnumber\s+one\b|\bguaranteed\b|\bthe\s+only\b/i;
const SUPERLATIVE_COMPARATIVE_RE = /\bthe\s+best\b|\bworld'?s\s+best\b|\b(?:fastest|cheapest|safest)\b/gi;
const HEDGE_TAIL_RE = /\b(?:one|some|any|a\s+few|few)\s+of\s+(?:the\s+)?$|\bamong\s+(?:the\s+)?$/i;

function firstUnhedgedSuperlative(strings: string[]): string | undefined {
  for (const s of strings) {
    if (SUPERLATIVE_ABSOLUTE_RE.test(s)) return s;
    for (const m of s.matchAll(SUPERLATIVE_COMPARATIVE_RE)) {
      if (m.index === undefined) continue;
      if (!HEDGE_TAIL_RE.test(s.slice(0, m.index))) return s;
    }
  }
  return undefined;
}

const FAKE_URGENCY_RE =
  /\b(only\s+today|today\s+only|act\s+now|limited\s+time|ends\s+(tonight|today|soon)|hurry|last\s+chance|\d+\s+(spots?|seats?|left in stock)\s*(left|remaining)?|only\s+\d+\s+(left|remaining|spots?|seats?))\b/i;

const HEALTH_CLAIM_RE =
  /\b(cure[sd]?|miracle\s+cure|clinically\s+proven|fda[- ]approved|lose\s+\d+\s*(lbs?|pounds?|kg)|lose\s+weight\s+fast|melt(s|ing)?\s+fat|burn(s|ing)?\s+fat\s+fast|reverse(s|d)?\s+(aging|diabetes)|detox(es|ify)?\s+your)\b/i;

const FINANCIAL_CLAIM_RE =
  /\b(get\s+rich(\s+quick)?|guaranteed\s+(returns?|income|profit|results?)|risk[- ]free\s+(investment|returns?)|double\s+your\s+money|passive\s+income\s+guaranteed|make\s+\$?\d[\d,]*\s+(a|per)\s+(day|week|month)\s+guaranteed)\b/i;

const FABRICATED_ENDORSEMENT_RE =
  /\b(doctors?\s+recommend|dentists?\s+recommend|\d+\s+out\s+of\s+\d+\s+(doctors|dentists|users|people)|as\s+seen\s+on|endorsed\s+by|celebrities?\s+use|#\s?1\s+(doctor|dentist)\s+recommended)\b/i;

const RESULTS_NOT_TYPICAL_RE = /\bresults?\s+(not\s+typical|may\s+vary)\b/i;
const DISCLAIMER_RE = /\b(individual\s+results\s+(may\s+)?vary|not\s+typical|terms\s+apply|results\s+may\s+vary)\b/i;

function firstMatch(strings: string[], re: RegExp): string | undefined {
  for (const s of strings) if (re.test(s)) return s;
  return undefined;
}

export function lintVideoBrief(
  brief: VideoBrief,
  videoType: VideoType,
  opts?: { avoid?: string[]; festival?: string },
): LintResult {
  const strings = collectStrings(brief);
  const violations: LintViolation[] = [];
  const caveats: string[] = [];
  const add = (code: string, message: string, sample?: string) => violations.push({ code, message, sample });

  {
    const m = firstMatch(strings, EM_DASH_RE);
    if (m) add("generic.em_dash", "Copy contains an em-dash (banned in customer-facing copy).", m);
  }
  {
    const m = firstUnhedgedSuperlative(strings);
    if (m) add("generic.superlative", "Unsupported superlative / absolute claim (e.g. '#1', 'the best', 'guaranteed', 'fastest'). A hedged comparative — 'one of the best', 'among the fastest' — is fine.", m);
  }
  {
    const m = firstMatch(strings, FAKE_URGENCY_RE);
    if (m) add("generic.fake_urgency", "Fake-urgency / misleading countdown (e.g. 'only today', 'X spots left').", m);
  }
  for (const b of brief.beats) {
    const hasOnScreen = Boolean((b as { headline?: string }).headline);
    const srt = b.vo?.srtText;
    if (b.vo && (!srt || srt.trim().length === 0)) {
      add("generic.caption_vo_empty", "A beat has an empty VO/caption line (caption and VO must stay consistent).");
      break;
    }
    if (hasOnScreen && srt === undefined) {
      add("generic.caption_vo_missing", "An on-screen beat has no VO/caption line.");
      break;
    }
  }
  const avoid = (opts?.avoid ?? []).map((t) => t.trim()).filter(Boolean);
  if (avoid.length > 0) {
    const lc = strings.map((s) => s.toLowerCase());
    for (const term of avoid) {
      const t = term.toLowerCase();
      const hitIdx = lc.findIndex((s) => s.includes(t));
      if (hitIdx >= 0) add("generic.avoid_violation", `A term on the avoid-list ("${term}") appears in the final video copy.`, strings[hitIdx]);
    }
  }
  if (firstMatch(strings, /\b\d[\d,.]*\s*(x|%|k|m|bn?)\b/i) || firstMatch(strings, /\$\s?\d/)) {
    caveats.push(
      "Numeric claims are present but cannot be deterministically verified as grounded — confirm every stat is real before relying on this for an outward ad.",
    );
  }

  if (videoType === "promo") {
    const festivalHay = [opts?.festival ?? "", ...strings].join("  ");
    const bad = festivalHay.match(INAPPROPRIATE_FESTIVAL_RE);
    if (bad) {
      add(
        "promo.inappropriate_festival",
        `A discount promo is inappropriate for this occasion ("${bad[0]}") — it reads as tone-deaf on a remembrance/solemn day. Skip the coupon or use a respectful non-discount message.`,
        bad[0],
      );
    }
    const restrained = festivalHay.match(RESTRAINED_FESTIVAL_RE);
    if (restrained) {
      caveats.push(
        `"${restrained[0]}" calls for a restrained, respectful tone — a "big sale" framing may be tone-deaf. Review the copy before publishing.`,
      );
    }
  }

  if (isOutwardClaimType(videoType)) {
    {
      const m = firstMatch(strings, HEALTH_CLAIM_RE);
      if (m) add("ad.health_claim", "Unverifiable health / weight-loss claim (banned by Meta Health & Wellness, TikTok Weight Management, Google Unreliable Claims).", m);
    }
    {
      const m = firstMatch(strings, FINANCIAL_CLAIM_RE);
      if (m) add("ad.financial_claim", "Financial guarantee / get-rich claim (banned by Meta Fraud & Deceptive Practices, Google Unreliable Claims).", m);
    }
    {
      const m = firstMatch(strings, FABRICATED_ENDORSEMENT_RE);
      if (m) add("ad.fabricated_endorsement", "Fabricated endorsement / testimonial (banned by Google Misleading Representation, Meta Deceptive Practices).", m);
    }
    {
      const flagged = firstMatch(strings, RESULTS_NOT_TYPICAL_RE);
      const hasDisclaimer = Boolean(firstMatch(strings, DISCLAIMER_RE));
      if (flagged && /not\s+typical/i.test(flagged) && !/(may\s+vary|terms\s+apply)/i.test(strings.join("  "))) {
        add("ad.results_not_typical_no_disclaimer", "An atypical-results claim ('results not typical') appears without a 'results may vary' disclaimer.", flagged);
      } else if (!hasDisclaimer) {
        if (firstMatch(strings, FINANCIAL_CLAIM_RE) || firstMatch(strings, HEALTH_CLAIM_RE)) {
          add("ad.missing_required_disclaimer", "An earnings/health claim requires a clear disclaimer ('results may vary'); none was found.");
        }
      }
    }
    caveats.push(
      "Comparative / superlative substantiation and required legal disclosures are not deterministically checkable — a human must confirm any comparative claim has substantiation on file before this ad is published.",
    );
  }

  return { ok: violations.length === 0, violations, caveats };
}

export function lintCopyStrings(strings: string[], opts?: { avoid?: string[] }): LintViolation[] {
  const v: LintViolation[] = [];
  const add = (code: string, sample?: string) => sample && v.push({ code, message: code, sample });
  add("generic.superlative", firstUnhedgedSuperlative(strings));
  add("generic.fake_urgency", firstMatch(strings, FAKE_URGENCY_RE));
  add("ad.health_claim", firstMatch(strings, HEALTH_CLAIM_RE));
  add("ad.financial_claim", firstMatch(strings, FINANCIAL_CLAIM_RE));
  add("ad.fabricated_endorsement", firstMatch(strings, FABRICATED_ENDORSEMENT_RE));
  const lc = strings.map((x) => x.toLowerCase());
  for (const term of (opts?.avoid ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const i = lc.findIndex((x) => x.includes(term));
    if (i >= 0) add("generic.avoid_violation", strings[i]);
  }
  return v;
}

export function formatLintAdvisory(result: LintResult): string | undefined {
  if (result.ok && result.caveats.length === 0) return undefined;

  const parts: string[] = [];
  if (result.violations.length > 0) {
    const lines = result.violations.map((v) => `• ${v.message}${v.sample ? ` (found: "${truncate(v.sample)}")` : ""}`);
    parts.push(
      `⚠️ *Before you publish this anywhere* — the draft trips ad-policy checks ` +
        `(Google / Meta / TikTok). The video is attached; fix the copy and re-render if you plan to run it as an ad:\n` +
        lines.join("\n"),
    );
  }
  if (result.caveats.length > 0) {
    parts.push(`Also note (not auto-checkable): ${result.caveats.join(" ")}`);
  }
  return parts.join("\n\n");
}

function truncate(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function selectAdvisories(
  advisoryByLabel: ReadonlyMap<string, string>,
  deliveredLabels: ReadonlySet<string>,
  multiVariant: boolean,
): string | undefined {
  const parts: string[] = [];
  for (const [label, advisory] of advisoryByLabel) {
    if (!deliveredLabels.has(label)) continue;
    parts.push(multiVariant ? `*Variant ${label}*\n${advisory}` : advisory);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
