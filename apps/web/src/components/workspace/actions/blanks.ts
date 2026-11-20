
const MAX_BLANK = 80;
const MAX_LABELLED = 400;
const LABELLED = /^[A-Z][A-Z ]*:/;
const FILL_IN = /^fill[- ]?in\s*:/i;
const FIELD_NAMES = new Set([
  "NAME", "FIRST", "LAST", "CITY", "STATE", "COMPANY", "BRAND", "EMAIL", "PHONE", "DATE", "TIME", "PRICE", "AMOUNT", "URL", "LINK", "ADDRESS",
  "CONFIRM", "TBD", "TBA", "TK", "INSERT", "YOUR",
]);

const BRACKET = /\[([^\[\]]{1,400})\]/g;
const MERGE_TAG = /\{\{\s*([^{}\n]{1,80}?)\s*\}\}/g;

function isBlank(inner: string, before: string, after: string): boolean {
  const s = inner.trim();
  if (!s || !/[a-z]/i.test(s)) return false;
  if (LABELLED.test(s) || FILL_IN.test(s) ? s.length > MAX_LABELLED : s.length > MAX_BLANK || s.includes("\n")) return false;
  if (/^x$/i.test(s)) return false;
  if (after.startsWith("(") || after.startsWith("[") || /^\s*(->|→)\s*\S/.test(after)) return false;
  if ((before === "" || before === "\n") && /^:\s*\S/.test(after)) return false;
  if (before === "[" || before === "]" || before === "/" || /\w/.test(before)) return false;
  if (/^["{\d]/.test(s)) return false;
  if (/^[0-9a-f]{6,}$/i.test(s) && /\d/.test(s)) return false;
  if (/^[A-Z0-9_]+$/.test(s) && s.length > 1 && !s.split("_").some((w) => FIELD_NAMES.has(w))) return false;
  return true;
}

const CODE_KINDS = new Set(["code"]);

export function findBlanks(text: string | null | undefined, kind?: string | null): string[] {
  if (!text || (kind && CODE_KINDS.has(kind))) return [];
  const found: { at: number; blank: string }[] = [];
  for (const m of text.matchAll(BRACKET)) {
    const at = m.index ?? 0;
    const before = at > 0 ? text[at - 1] : "";
    const after = text.slice(at + m[0].length, at + m[0].length + 12);
    if (isBlank(m[1], before, after)) found.push({ at, blank: m[0] });
  }
  const espTags = new Set(Object.values(ESP_TAGS).flatMap((t) => [t.first_name, t.unsubscribe]));
  for (const m of text.matchAll(MERGE_TAG)) {
    const at = m.index ?? 0;
    const tag = text[at - 1] === "{" && text[at + m[0].length] === "}" ? `{${m[0]}}` : m[0];
    if (/[a-z]/i.test(m[1]) && !espTags.has(tag)) found.push({ at, blank: m[0] });
  }
  found.sort((x, y) => x.at - y.at);
  return Array.from(new Set(found.map((f) => f.blank)));
}

export function copyLabel(label: string, blanks: string[]): string {
  if (!blanks.length) return label;
  return `${label} (${blanks.length} ${blanks.length === 1 ? "blank" : "blanks"} to fill)`;
}

const SHOWN = 40;
const clip = (raw: string) => {
  const b = raw.replace(/\s+/g, " ");
  return b.length > SHOWN ? `${b.slice(0, SHOWN - 1).trimEnd()}…]` : b;
};

export function blanksLine(blanks: string[]): string | null {
  if (!blanks.length) return null;
  return `Fill before sending: ${blanks.map(clip).join(", ")}`;
}

export function withBlanks(sentence: string, blanks: string[]): string {
  const line = blanksLine(blanks);
  return line ? `${sentence} ${line}` : sentence;
}

export function blankName(blank: string): string {
  const inner = blank.replace(/^\[|\]$/g, "").replace(/^\{\{\s*|\s*\}\}$/g, "").replace(/\s+/g, " ").trim();
  return inner.length > 60 ? `${inner.slice(0, 59).trimEnd()}…` : inner;
}

export function fillBlanks(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [blank, value] of Object.entries(values)) {
    if (value.trim()) out = out.split(blank).join(value);
  }
  return out;
}

export type BlankSource = "postal_address" | "domain" | "company_name" | "business_name" | "unsubscribe" | "first_name";

const BUSINESS_NOUNS = new Set([
  "bakery", "cafe", "coffee", "restaurant", "bistro", "bar", "pub", "brewery", "salon", "spa", "barbershop", "gym",
  "studio", "clinic", "practice", "shop", "store", "boutique", "hotel", "agency", "firm", "school", "academy",
  "centre", "center", "business", "company", "brand",
]);

function businessWord(blank: string): string | null {
  const head = blankName(blank).toLowerCase().replace(/[_-]+/g, " ").split(":")[0].trim();
  const m = head.match(/^(?:your |our |the )?([a-z]+) name$/);
  return m && BUSINESS_NOUNS.has(m[1]) ? m[1] : null;
}

export function blankSource(blank: string): BlankSource | null {
  const name = blankName(blank).toLowerCase().replace(/[_-]+/g, " ").replace(/’/g, "'");
  const head = name.split(":")[0].trim();
  if (/\bunsubscribe\b/.test(name)) return "unsubscribe";
  if (/^((business|company|your) )?(postal|mailing|physical|street) address$/.test(head) || head === "address") return "postal_address";
  if (/^(your |company |business |site |website )?domain$/.test(head) || /^(your )?(website|site)( url)?$/.test(head)) return "domain";
  if (/^(your )?(company|business|studio|brand|shop|store)( name)?$/.test(head)) return "company_name";
  if (/^((their|recipient's|customer's) )?first name$|^fname$/.test(head)) return "first_name";
  if (businessWord(blank)) return "business_name";
  return null;
}

export type BlankGroup = "recipient" | "sender";

const RECIPIENT_WORDS = /\b(first name|last name|full name|fname|lname|their|they|them|recipient|customer|subscriber|member|attendee|client)\b/;

export function blankGroup(blank: string): BlankGroup {
  const source = blankSource(blank);
  if (source === "first_name") return "recipient";
  if (source) return "sender";
  if (/^\{\{/.test(blank.trim())) return "recipient";
  const name = blankName(blank).toLowerCase().replace(/[_-]+/g, " ").replace(/’/g, "'");
  return RECIPIENT_WORDS.test(name) ? "recipient" : "sender";
}

export type BlankContext = {
  postalAddress?: string | null;
  domain?: string | null;
  companyName?: string | null;
  whatWeSell?: string | null;
  esp?: string | null;
  unsubscribeLink?: string | null;
};

export type KnownValue = { value: string; from?: string };

export const ESP_TAGS: Record<string, { name: string; unsubscribe: string; first_name: string }> = {
  mailchimp: { name: "Mailchimp", unsubscribe: "*|UNSUB|*", first_name: "*|FNAME|*" },
  klaviyo: { name: "Klaviyo", unsubscribe: "{% unsubscribe_link %}", first_name: "{{ first_name|default:'there' }}" },
  sendgrid: { name: "SendGrid", unsubscribe: "{{{unsubscribe}}}", first_name: '{{insert first_name "default=there"}}' },
};

export function siteDomain(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./i, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

function describes(word: string | null, texts: Array<string | null | undefined>): boolean {
  if (!word) return false;
  const re = new RegExp(`\\b${word}\\b`, "i");
  return texts.some((t) => !!t && re.test(t));
}

export function knownBlankValues(blanks: string[], ctx: BlankContext | null): Record<string, KnownValue> {
  const out: Record<string, KnownValue> = {};
  if (!ctx) return out;
  const tags = ctx.esp ? ESP_TAGS[ctx.esp] : undefined;
  for (const blank of blanks) {
    const source = blankSource(blank);
    const postal = ctx.postalAddress?.trim();
    const company = ctx.companyName?.trim();
    if (source === "postal_address" && postal) {
      out[blank] = { value: postal };
    } else if (source === "domain" && ctx.domain) {
      out[blank] = { value: ctx.domain, from: "From your company details" };
    } else if (source === "company_name" && company) {
      out[blank] = { value: company, from: "From your company details" };
    } else if (source === "business_name" && company && describes(businessWord(blank), [company, ctx.whatWeSell])) {
      out[blank] = { value: company, from: "From your company details" };
    } else if (source === "unsubscribe" && tags) {
      out[blank] = { value: tags.unsubscribe, from: `${tags.name}'s unsubscribe tag. ${tags.name} puts each person's own link here.` };
    } else if (source === "unsubscribe" && ctx.unsubscribeLink?.trim()) {
      out[blank] = { value: ctx.unsubscribeLink.trim() };
    } else if (source === "first_name" && tags) {
      out[blank] = { value: tags.first_name, from: `${tags.name}'s first-name tag. Each person sees their own name.` };
    }
  }
  return out;
}

export const FOOTER_SOURCES: readonly BlankSource[] = ["postal_address", "unsubscribe"];

export function isFooterBlank(blank: string): boolean {
  const source = blankSource(blank);
  return source !== null && FOOTER_SOURCES.includes(source);
}

export const FOOTER_MISSING: Readonly<Record<"postal_address" | "unsubscribe", string>> = {
  postal_address: "Add your postal address in Settings > Footer.",
  unsubscribe: "Add your unsubscribe link in Settings > Footer.",
};

export type FooterAsk = { missing: ("postal_address" | "unsubscribe")[]; reading: boolean };

export function footerAsk(remaining: string[], fromSettings: boolean, ready: boolean, unread: readonly string[] | undefined): { typed: string[]; footer: FooterAsk } {
  const isFooter = (b: string) => fromSettings && isFooterBlank(b);
  const footerBlanks = remaining.filter(isFooter);
  const sources = Array.from(new Set(footerBlanks.map((b) => blankSource(b) as "postal_address" | "unsubscribe")));
  const missing = ready ? sources.filter((s) => !unread?.includes(s)) : [];
  return { typed: remaining.filter((b) => !isFooter(b)), footer: { missing, reading: sources.length > missing.length } };
}

export function askAgain(typed: number, footer: FooterAsk, label: string): string {
  const fill = `Fill the ${typed} ${typed === 1 ? "blank" : "blanks"} in the email above`;
  const what = footer.missing.map((s) => (s === "unsubscribe" ? "unsubscribe link" : "postal address")).join(" and ");
  if (typed && what) return `${fill} and add your ${what} in Settings > Footer, then press ${label} again.`;
  if (typed) return `${fill}, then press ${label} again.`;
  return `Zavi is still reading your footer settings. Press ${label} again in a moment.`;
}

const UNSUBSCRIBE_TAGS = [/^\*\|[A-Z_]*UNSUB[A-Z_]*\|\*$/, /^\{%\s*[a-z_]*unsub[a-z_]*\s*%\}$/, /^\{\{\s*[a-z_]*unsub[a-z_]*\s*\}\}$/, /^\{\{\{\s*[a-z_]*unsub[a-z_]*\s*\}\}\}$/, /^\{%\s*unsubscribe\s+(?:'[^'{}%]{1,100}'|"[^"{}%]{1,100}")\s*%\}$/, /^<%asm_(?:group|global)_unsubscribe_raw_url%>$/];

export function isHttpsLink(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 300 || /\s/.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export function isUnsubscribeLink(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 300) return false;
  if (UNSUBSCRIBE_TAGS.some((r) => r.test(s))) return true;
  return isHttpsLink(s);
}

export function isLinkBlank(blank: string): boolean {
  const source = blankSource(blank);
  if (source === "unsubscribe") return true;
  if (source !== null) return false;
  const head = blankName(blank).toLowerCase().replace(/[_-]+/g, " ").split(":")[0];
  return /\b(link|url)\b/.test(head);
}

export const LINK_PROBLEM = "Enter a full link that starts with https://";

export function linkProblem(blank: string, value: string): string | null {
  if (!value.trim() || !isLinkBlank(blank)) return null;
  const ok = blankSource(blank) === "unsubscribe" ? isUnsubscribeLink(value) : isHttpsLink(value);
  return ok ? null : LINK_PROBLEM;
}

export function blankLabel(blank: string): { title: string; hint: string | null } {
  const inner = blank.replace(/^\[|\]$/g, "").replace(/^\{\{\s*|\s*\}\}$/g, "").replace(/\s+/g, " ").trim();
  const at = inner.indexOf(":");
  const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  if (at <= 0) return { title: clipTo(cap(inner.replace(/_/g, " ")), 60), hint: null };
  const head = inner.slice(0, at).trim();
  const rest = inner.slice(at + 1).trim();
  if (!rest) return { title: clipTo(cap(head), 60), hint: null };
  if (head === head.toUpperCase()) {
    return /[a-z]/i.test(rest)
      ? { title: clipTo(cap(rest), 60), hint: null }
      : { title: clipTo(cap(head.toLowerCase()), 60), hint: clipTo(rest, 120) };
  }
  return { title: clipTo(cap(head), 60), hint: clipTo(rest, 120) };
}
