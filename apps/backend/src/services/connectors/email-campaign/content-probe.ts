
import { render, type EmailContent, type EmailTemplate } from "@/services/email-templates/render";
import { compareContent, type CompareVerdict } from "./content-verify";
import { EMAIL_PROVIDERS, type EmailTool, type ProviderCall, type StoredContent } from "./providers";

export const PROBE_TEMPLATE: EmailTemplate = {
  logo_url: null,
  brand_color: "#1f6feb",
  button_color: "#1f6feb",
  font_key: "system",
  sign_off: "The Brightloop team",
  postal_address: "1 Example Way, Springfield",
  show_cards: false,
};
export const PROBE_CONTENT = {
  subject: "Zavi content probe",
  preview_text: "A probe of what this tool stores",
  title: "Probe",
  paragraphs: ["Line one & an ampersand.", "Line two with a <tag-looking> text."],
  button: { label: "Open", url: "https://www.brightloop.test/probe?a=1&b=2" },
} as EmailContent;

export function probeEmail(tool: EmailTool): { html: string; text: string } {
  const r = render(PROBE_TEMPLATE, PROBE_CONTENT, { route: tool, campaignSlug: "zavi-content-probe", ownHost: "www.brightloop.test", companyName: "Brightloop" });
  return { html: r.html, text: r.text };
}

const PROBE_URL = new URL(PROBE_CONTENT.button.url);
const isStructuralKey = (k: string, probeHost: boolean): boolean => /^utm_[a-z]+$/i.test(k) || (probeHost && PROBE_URL.searchParams.has(k));
const isProbeHost = (host: string): boolean => host === PROBE_URL.hostname || host.endsWith(".brightloop.test") || host === "brightloop.test";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const REDACTED = "REDACTED";
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/;

function looksIdentifying(raw: string): boolean {
  const v = raw.replace(TRAILING_PUNCT, "");
  if (EMAIL.test(v) || v.includes("@")) return true;
  if (/\d{6,}/.test(v)) return true;
  if (/^[A-Za-z0-9_-]{16,}$/.test(v)) return true;
  if (v.length >= 8 && /^[A-Za-z0-9+/=_-]+$/.test(v) && (/[+/=]/.test(v) || (/\d/.test(v) && /[A-Za-z]/.test(v)))) return true;
  return false;
}

const decode = (v: string): string => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

function sanitizeUrl(raw: string, depth = 0): string {
  const amp = raw.includes("&amp;");
  let u: URL;
  try {
    u = new URL(raw.replace(/&amp;/g, "&"));
  } catch {
    return scrubText(raw);
  }
  const probeHost = isProbeHost(u.hostname);
  u.username = "";
  u.password = "";
  u.pathname = u.pathname
    .split("/")
    .map((seg) => (seg && looksIdentifying(decode(seg)) ? REDACTED : seg))
    .join("/");
  for (const [k, v] of [...u.searchParams.entries()]) {
    if (/^https?:\/\//i.test(v)) u.searchParams.set(k, depth < 3 ? sanitizeUrl(v, depth + 1) : REDACTED);
    else u.searchParams.set(k, isStructuralKey(k, probeHost) && !looksIdentifying(v) ? v : REDACTED);
  }
  if (u.hash) u.hash = REDACTED;
  const out = u.toString();
  return amp ? out.replace(/&/g, "&amp;") : out;
}

function scrubText(s: string): string {
  return s.replace(new RegExp(EMAIL.source, "g"), "user@example.test").replace(/\d{6,}/g, (m) => "0".repeat(Math.min(m.length, 12)));
}

export function sanitizeProbe(s: string): string {
  const urls: string[] = [];
  const held = s.replace(/https?:\/\/[^\s"'<>]+/g, (grabbed) => {
    const tail = TRAILING_PUNCT.exec(grabbed)?.[0] ?? "";
    const m = tail ? grabbed.slice(0, -tail.length) : grabbed;
    urls.push(sanitizeUrl(m) + tail);
    return `\u0000URL${urls.length - 1}\u0000`;
  });
  return scrubText(held).replace(/\u0000URL(\d+)\u0000/g, (_, i: string) => urls[Number(i)]);
}

export type ProbeFixture = {
  tool: EmailTool;
  recorded_at: string;
  sealed: { html: string; text: string };
  stored: StoredContent;
  verdict: CompareVerdict;
  verdict_raw: CompareVerdict;
};

export type ProbeDeps = {
  call: ProviderCall;
  create: (tool: EmailTool) => Promise<string>;
  remove: (tool: EmailTool, campaignId: string) => Promise<void>;
  now?: () => Date;
};

export async function runContentProbe(tool: EmailTool, deps: ProbeDeps): Promise<ProbeFixture> {
  const sealed = probeEmail(tool);
  const id = await deps.create(tool);
  try {
    await EMAIL_PROVIDERS[tool].setContent(deps.call, id, { title: "Zavi content probe", html: sealed.html, text: sealed.text });
    const stored = await EMAIL_PROVIDERS[tool].readContent(deps.call, id);
    const cleanSealed = { html: sanitizeProbe(sealed.html), text: sanitizeProbe(sealed.text) };
    const clean: StoredContent = stored.proof === "ok" ? { proof: "ok", html: sanitizeProbe(stored.html), text: sanitizeProbe(stored.text) } : stored;
    return {
      tool,
      recorded_at: (deps.now ?? (() => new Date()))().toISOString(),
      sealed: cleanSealed,
      stored: clean,
      verdict: compareContent(tool, cleanSealed, clean),
      verdict_raw: compareContent(tool, sealed, stored),
    };
  } finally {
    await deps.remove(tool, id).catch(() => undefined);
  }
}
