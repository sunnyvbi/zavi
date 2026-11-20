
import { createHash } from "node:crypto";

export const RENDERER_VERSION = "email-r1";

export const FONT_STACKS = {
  system: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  helvetica: "'Helvetica Neue',Helvetica,Arial,sans-serif",
  verdana: "Verdana,Geneva,sans-serif",
  trebuchet: "'Trebuchet MS','Lucida Grande',sans-serif",
  georgia: "Georgia,'Times New Roman',Times,serif",
  palatino: "'Palatino Linotype','Book Antiqua',Palatino,serif",
} as const;

export type FontKey = keyof typeof FONT_STACKS;
export const FONT_KEYS = Object.keys(FONT_STACKS) as FontKey[];

export function isFontKey(v: unknown): v is FontKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FONT_STACKS, v);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_COLOR.test(v);
}

export type EmailTemplate = {
  logo_url: string | null;
  brand_color: string;
  button_color: string;
  font_key: string;
  sign_off: string;
  postal_address: string | null;
  show_cards: boolean;
};

export type EmailCard = { title: string; meta: string; price?: string; url?: string; image_url?: string };

export type EmailContent = {
  subject: string;
  preview_text: string;
  title: string;
  hero?: { big: string; small: string };
  paragraphs: string[];
  button: { label: string; url: string };
  cards?: EmailCard[];
};

export type EmailRoute = "sendgrid" | "mailchimp" | "klaviyo" | "zavi_list";

export const UNSUBSCRIBE_HREF: Readonly<Record<EmailRoute, string>> = {
  sendgrid: "{{{unsubscribe}}}",
  mailchimp: "*|UNSUB|*",
  klaviyo: "{% unsubscribe_link %}",
  zavi_list: "{{zavi_unsubscribe_url}}",
};

export type RenderContext = {
  route: EmailRoute;
  campaignSlug: string;
  ownHost: string | null;
  companyName?: string | null;
};

export type RenderResult = { html: string; text: string; render_sha: string; renderer_version: string };

export type EmailRenderErrorCode =
  | "bad_url"
  | "bad_color"
  | "bad_font"
  | "missing_postal_address"
  | "missing_field"
  | "bad_campaign_slug";

export class EmailRenderError extends Error {
  readonly name = "EmailRenderError";
  constructor(
    readonly code: EmailRenderErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function escapeText(s: string): string {
  return neutralizeTags(s).replace(/[&<>{}|]/g, (c) => TEXT_ENTITY[c]);
}

const TEXT_ENTITY: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "{": "&#123;", "}": "&#125;", "|": "&#124;" };

export function neutralizeTags(s: string): string {
  return s.replace(/\{(?=[{%#])/g, "{\u200b").replace(/\*(?=\|)/g, "*\u200b").replace(/\|(?=\*)/g, "|\u200b");
}

function contentAttr(s: string): string {
  return escapeAttr(neutralizeTags(s)).replace(/[{}|]/g, (c) => TEXT_ENTITY[c]);
}

function urlSafe(s: string): string {
  return s.replace(/[{}|]/g, (c) => (c === "{" ? "%7B" : c === "}" ? "%7D" : "%7C"));
}

export function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function textLines(s: string): string {
  return escapeText(s.replace(/\r\n?/g, "\n").trim()).replace(/\n/g, "<br>");
}

const BODY_LINK = /https:\/\/[^\s<>"'`]+/gi;
const LINK_TAIL = /[.,;:!?}'"]$/;

const count = (s: string, c: string) => s.split(c).length - 1;

export function trimLinkTail(link: string): string {
  let s = link;
  for (;;) {
    const last = s.slice(-1);
    if (LINK_TAIL.test(last)) s = s.slice(0, -1);
    else if (last === ")" && count(s, "(") < count(s, ")")) s = s.slice(0, -1);
    else if (last === "]" && count(s, "[") < count(s, "]")) s = s.slice(0, -1);
    else return s;
  }
}

function bodyLines(s: string, ctx: ResolvedCtx, linkStyle: string): string {
  const raw = s.replace(/\r\n?/g, "\n").trim();
  let out = "";
  let at = 0;
  for (const m of raw.matchAll(BODY_LINK)) {
    const start = m.index ?? 0;
    const link = trimLinkTail(m[0]);
    let href: string | null = null;
    try {
      href = linkHref(link, "link in the email", "link", ctx);
    } catch {
      href = null;
    }
    if (!href) continue;
    out += escapeText(raw.slice(at, start)).replace(/\n/g, "<br>");
    out += `<a href="${escapeAttr(href)}" style="${linkStyle}">${escapeText(link)}</a>`;
    at = start + link.length;
  }
  return out + escapeText(raw.slice(at)).replace(/\n/g, "<br>");
}

function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

const URL_MAX = 2048;

type UrlUse = "link" | "button" | "image";

function short(raw: string): string {
  const one = oneLine(raw);
  return one.length > 60 ? `${one.slice(0, 57)}...` : one;
}

export function checkEmailUrl(raw: unknown, field: string, use: UrlUse = "link"): URL {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new EmailRenderError("bad_url", `The ${field} has no web address.`);
  }
  const value = raw.trim();
  if (value.length > URL_MAX) throw new EmailRenderError("bad_url", `The ${field} web address is too long.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmailRenderError("bad_url", `The ${field} is not a full web address ("${short(value)}"). Use one that starts with https://.`);
  }
  if (url.protocol === "mailto:") {
    if (use !== "button") {
      throw new EmailRenderError("bad_url", `The ${field} is an email address. Only the button may link to an email address.`);
    }
    if (url.search || url.hash || !/^[^\s@,;?&]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.pathname)) {
      throw new EmailRenderError("bad_url", `The ${field} must be a plain email address (mailto:name@example.com) with nothing after it.`);
    }
    return url;
  }
  if (url.protocol !== "https:") {
    throw new EmailRenderError(
      "bad_url",
      `The ${field} uses "${url.protocol.replace(/:$/, "")}", which emails cannot use. Use a web address that starts with https://.`,
    );
  }
  if (url.username || url.password) {
    throw new EmailRenderError("bad_url", `The ${field} web address contains a login. Remove it.`);
  }
  if (!url.hostname) throw new EmailRenderError("bad_url", `The ${field} web address has no site name.`);
  return url;
}

export function normalizeOwnHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h || !/^[a-z0-9.-]+$/.test(h) || !h.includes(".")) return null;
  return h.replace(/^www\./, "");
}

function isOwnHost(hostname: string, ownHost: string | null): boolean {
  if (!ownHost) return false;
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === ownHost || h.endsWith(`.${ownHost}`);
}

function linkHref(raw: string, field: string, use: "link" | "button", ctx: ResolvedCtx): string {
  const url = checkEmailUrl(raw, field, use);
  if (url.protocol === "https:" && isOwnHost(url.hostname, ctx.ownHost)) {
    url.searchParams.set("utm_source", "email");
    url.searchParams.set("utm_medium", "zavi");
    url.searchParams.set("utm_campaign", ctx.campaignSlug);
  }
  return urlSafe(url.toString());
}

function imageSrc(raw: string, field: string): string {
  return urlSafe(checkEmailUrl(raw, field, "image").toString());
}

function checkColor(v: unknown, field: string): string {
  if (!isHexColor(v)) {
    throw new EmailRenderError("bad_color", `The ${field} must be a color like #1a73e8.`);
  }
  return v.toLowerCase();
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function inkOn(bg: string): string {
  const l = luminance(bg);
  return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#111827";
}

type ResolvedCtx = { route: EmailRoute; campaignSlug: string; ownHost: string | null; companyName: string };

const SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function need(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new EmailRenderError("missing_field", `The ${field} is empty.`);
  return v;
}

export function render(template: EmailTemplate, content: EmailContent, ctx: RenderContext): RenderResult {
  if (!SLUG.test(ctx.campaignSlug)) {
    throw new EmailRenderError("bad_campaign_slug", "The campaign name for tracking must be lowercase letters, numbers, - or _.");
  }
  if (!Object.prototype.hasOwnProperty.call(UNSUBSCRIBE_HREF, ctx.route)) {
    throw new EmailRenderError("missing_field", "The email has no send route.");
  }
  const c: ResolvedCtx = {
    route: ctx.route,
    campaignSlug: ctx.campaignSlug,
    ownHost: normalizeOwnHost(ctx.ownHost),
    companyName: oneLine(ctx.companyName ?? ""),
  };

  const brand = checkColor(template.brand_color, "brand color");
  const button = checkColor(template.button_color, "button color");
  if (!isFontKey(template.font_key)) {
    throw new EmailRenderError("bad_font", `The font "${short(String(template.font_key))}" is not one Zavi offers.`);
  }
  const font = FONT_STACKS[template.font_key];
  const postal = typeof template.postal_address === "string" ? template.postal_address.trim() : "";
  if (!postal) {
    throw new EmailRenderError("missing_postal_address", "Add your business postal address in Email campaigns settings. Every marketing email must show it.");
  }

  need(content.subject, "subject");
  const title = need(content.title, "title");
  const buttonLabel = need(content.button?.label, "button label");
  const buttonHref = linkHref(need(content.button?.url, "button link"), "button link", "button", c);
  const paragraphs = Array.isArray(content.paragraphs) ? content.paragraphs.filter((p) => typeof p === "string" && p.trim()) : [];
  if (paragraphs.length === 0) throw new EmailRenderError("missing_field", "The email has no body text.");
  const preview = oneLine(typeof content.preview_text === "string" ? content.preview_text : "");
  const heroInput = content.hero && typeof content.hero.big === "string" && content.hero.big.trim() ? content.hero : null;
  const heroSmall = heroInput && typeof heroInput.small === "string" ? heroInput.small.trim() : "";
  const heroBig = heroInput && oneLine(heroInput.big).toLowerCase() !== oneLine(title).toLowerCase() ? heroInput.big.trim() : "";
  const hero = heroBig || heroSmall ? { big: heroBig, small: heroSmall } : null;
  const cards = template.show_cards && Array.isArray(content.cards) ? content.cards : [];
  const logo = template.logo_url ? imageSrc(template.logo_url, "logo") : null;
  const unsubscribe = UNSUBSCRIBE_HREF[c.route];
  const brandInk = inkOn(brand);
  const buttonInk = inkOn(button);
  const fontAttr = escapeAttr(font);

  const pad = "padding-left:44px;padding-right:44px;";
  const canvas = "#f7f6f3";
  const line = "#e6e3db";
  const muted = "#77716a";
  const ink = "#141413";
  const body = `font-family:${fontAttr};font-size:16px;line-height:1.65;color:#3d3b37;`;
  const h: string[] = [];
  h.push(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeText(oneLine(content.subject))}</title>`,
    `<style>@media only screen and (max-width:620px){.zp{padding-left:24px!important;padding-right:24px!important}.zt{font-size:23px!important}.zo{padding:24px 0 32px!important}.zc{border-radius:0!important;border-left:0!important;border-right:0!important}}</style></head>`,
    `<body style="margin:0;padding:0;background-color:${canvas};">`,
  );
  if (preview) {
    h.push(`<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeText(preview)}</div>`);
  }
  h.push(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${canvas}" style="background-color:${canvas};"><tr><td class="zo" align="center" style="padding:40px 16px;">`,
    `<table class="zc" role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid ${line};border-radius:12px;border-collapse:separate;overflow:hidden;font-family:${fontAttr};color:${ink};">`,
  );
  if (logo) {
    h.push(
      `<tr><td class="zp" align="left" style="padding-top:36px;${pad}"><img src="${escapeAttr(logo)}" alt="${contentAttr(c.companyName)}" height="32" style="display:block;height:32px;width:auto;max-width:180px;border:0;outline:none;text-decoration:none;"></td></tr>`,
    );
  } else if (c.companyName) {
    const initial = Array.from(c.companyName)[0].toUpperCase();
    h.push(
      `<tr><td class="zp" align="left" style="padding-top:36px;${pad}">`,
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>`,
      `<td width="28" height="28" align="center" valign="middle" bgcolor="${brand}" style="width:28px;height:28px;border-radius:8px;background-color:${brand};color:${brandInk};font-family:${fontAttr};font-size:14px;line-height:28px;font-weight:bold;">${escapeText(initial)}</td>`,
      `<td valign="middle" style="padding-left:10px;font-family:${fontAttr};font-size:16px;line-height:1.3;font-weight:bold;letter-spacing:-0.01em;color:${ink};">${escapeText(c.companyName)}</td>`,
      `</tr></table></td></tr>`,
    );
  }
  h.push(
    `<tr><td class="zp zt" style="padding-top:32px;padding-bottom:14px;${pad}font-family:${fontAttr};font-size:26px;line-height:1.25;font-weight:bold;letter-spacing:-0.02em;color:${ink};">${textLines(title)}</td></tr>`,
  );
  if (hero) {
    h.push(
      `<tr><td class="zp" style="padding-top:8px;padding-bottom:24px;${pad}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="left" style="padding:16px 0;border-top:1px solid ${line};border-bottom:1px solid ${line};font-family:${fontAttr};">`,
      hero.big ? `<div style="font-size:20px;line-height:1.3;font-weight:bold;letter-spacing:-0.01em;color:${ink};">${textLines(hero.big)}</div>` : "",
      hero.small ? `<div style="padding-top:${hero.big ? "4px" : "0"};font-size:14px;line-height:1.5;color:${muted};">${textLines(hero.small)}</div>` : "",
      `</td></tr></table></td></tr>`,
    );
  }
  for (const p of paragraphs) {
    h.push(`<tr><td class="zp" style="padding-top:0;padding-bottom:14px;${pad}${body}">${bodyLines(p, c, `color:${ink};text-decoration:underline;`)}</td></tr>`);
  }
  h.push(
    `<tr><td class="zp" align="left" style="padding-top:12px;padding-bottom:32px;${pad}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td align="center" bgcolor="${button}" style="background-color:${button};border-radius:8px;mso-padding-alt:14px 26px;">`,
    `<a href="${escapeAttr(buttonHref)}" style="display:inline-block;padding:14px 26px;border:1px solid ${button};border-radius:8px;background-color:${button};font-family:${fontAttr};font-size:15px;line-height:1.2;font-weight:bold;color:${buttonInk};text-decoration:none;">${escapeText(oneLine(buttonLabel))}</a>`,
    `</td></tr></table></td></tr>`,
  );
  const cardText: string[] = [];
  cards.forEach((card, i) => {
    const n = i + 1;
    const cardTitle = need(card?.title, `card ${n} title`);
    const href = card.url ? linkHref(card.url, `card ${n} link`, "link", c) : null;
    const img = card.image_url ? imageSrc(card.image_url, `card ${n} image`) : null;
    const titleHtml = href
      ? `<a href="${escapeAttr(href)}" style="color:${ink};text-decoration:none;">${escapeText(oneLine(cardTitle))}</a>`
      : escapeText(oneLine(cardTitle));
    h.push(
      `<tr><td class="zp" style="padding-top:0;padding-bottom:14px;${pad}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${line};border-radius:10px;border-collapse:separate;overflow:hidden;">`,
    );
    if (img) {
      h.push(`<tr><td style="padding:0;"><img src="${escapeAttr(img)}" alt="${contentAttr(oneLine(cardTitle))}" width="470" style="display:block;width:100%;height:auto;border:0;"></td></tr>`);
    }
    h.push(
      `<tr><td style="padding:14px 18px;font-family:${fontAttr};">`,
      `<div style="font-size:15px;line-height:1.4;font-weight:bold;color:${ink};">${titleHtml}</div>`,
      typeof card.meta === "string" && card.meta.trim() ? `<div style="padding-top:4px;font-size:14px;line-height:1.5;color:${muted};">${escapeText(oneLine(card.meta))}</div>` : "",
      typeof card.price === "string" && card.price.trim() ? `<div style="padding-top:6px;font-size:15px;font-weight:bold;color:${brand};">${escapeText(oneLine(card.price))}</div>` : "",
      `</td></tr></table></td></tr>`,
    );
    cardText.push(
      [oneLine(cardTitle), card.meta && oneLine(card.meta), card.price && oneLine(card.price), href].filter(Boolean).join("\n"),
    );
  });
  const signOff = typeof template.sign_off === "string" ? template.sign_off.trim() : "";
  if (signOff) {
    h.push(`<tr><td class="zp" style="padding-top:4px;padding-bottom:36px;${pad}font-family:${fontAttr};font-size:16px;line-height:1.65;color:${ink};">${textLines(signOff)}</td></tr>`);
  } else {
    h.push(`<tr><td style="height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>`);
  }
  h.push(
    `</table>`,
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;"><tr><td class="zp" align="left" style="padding:20px 8px 0;font-family:${fontAttr};font-size:12px;line-height:1.6;color:${muted};">`,
    c.companyName ? `<div style="padding-bottom:2px;font-weight:bold;color:#3d3b37;">${escapeText(c.companyName)}</div>` : "",
    `<div>${textLines(postal)}</div>`,
    `<div style="padding-top:10px;"><a href="${escapeAttr(unsubscribe)}" style="color:${muted};text-decoration:underline;">Unsubscribe</a></div>`,
    `</td></tr></table>`,
    `</td></tr></table></body></html>`,
  );
  const html = h.join("");

  const t: string[] = [oneLine(title)];
  if (hero) t.push([hero.big, hero.small].filter(Boolean).join("\n"));
  for (const p of paragraphs) t.push(p.replace(/\r\n?/g, "\n").trim());
  t.push(`${oneLine(buttonLabel)}: ${buttonHref}`);
  t.push(...cardText);
  if (signOff) t.push(signOff.replace(/\r\n?/g, "\n"));
  t.push(`--\n${postal}`);
  const text = `${t.map(neutralizeTags).join("\n\n")}\nUnsubscribe: ${unsubscribe}\n`;

  const render_sha = createHash("sha256").update(RENDERER_VERSION).update("\0").update(html).update("\0").update(text).digest("hex");
  return { html, text, render_sha, renderer_version: RENDERER_VERSION };
}
