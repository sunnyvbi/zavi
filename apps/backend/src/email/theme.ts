
import { webBaseUrl } from "@/services/web-base";

export const ZAVI_POSTAL_ADDRESS = "39763 Fog Shrew Rd, Newark, CA 94560";
const POSTAL_MAP_URL = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ZAVI_POSTAL_ADDRESS)}`;
export const ZAVI_SUPPORT_EMAIL = "support@zaviagent.com";

type ThemeParams = {
  title: string;
  body: string;
  intro?: string;
  userName?: string;
  eyebrow?: string;
  kicker?: string;
  heroNumber?: string;
  heroLabel?: string;
  quote?: { from: string; text: string };
  details?: readonly { label: string; value: string }[];
  ctaText?: string;
  ctaUrl?: string;
  linkFallback?: boolean;
  footerNote?: string;
  preheader?: string;
  siteUrl?: string;
  heroImage?: { src: string; alt: string };
  afterCta?: string;
  unsubscribeUrl?: string;
  footerVariant: EmailFooterVariant;
};

export type EmailFooterVariant = "neutral" | "founder-growth";

export const FOUNDER_TAGLINE = "Your growth, run by Zavi.";

const GROUND = "#f4f5f7";
const CARD = "#ffffff";
const LINE = "#ececec";
const SOFT = "#f9f9f9";
const INK = "#0e0f11";
const BODY = "#3d3d3d";
const MUTED = "#6b6b6b";
const SKY = "#eef6ff";
const SKY_LINE = "#bedeff";
const LABEL = "#46658a";
const FONT =
  "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export const webOrigin = webBaseUrl;

export const EMAIL_PALETTE = {
  paper: SOFT,
  card: CARD,
  rule: LINE,
  ink: INK,
  body: BODY,
  muted: MUTED,
  accent: INK,
  accentDeep: BODY,
  ground: GROUND,
  sky: SKY,
  skyLine: SKY_LINE,
  label: LABEL,
} as const;

export const EMAIL_FONT = FONT;

export function renderEmail(p: ThemeParams): string {
  const {
    title,
    body,
    intro = "",
    userName = "",
    eyebrow = "",
    heroNumber = "",
    heroLabel = "",
    quote,
    details = [],
    ctaText = "",
    ctaUrl = "",
    linkFallback = false,
    footerNote = "",
    preheader = "",
    siteUrl = "",
    footerVariant,
    heroImage,
    afterCta = "",
    unsubscribeUrl = "",
  } = p;
  const site = siteUrl || webOrigin();
  const kicker = (p.kicker ?? "").trim().toLowerCase() === "zavi" ? "" : (p.kicker ?? "").trim();
  const introRendered = intro
    ? intro.replace(
        "{user}",
        userName ? `<strong style="color:${INK};">${userName}</strong>` : "there",
      )
    : "";

  const mastheadHtml = `
  <table role="presentation" width="580" cellpadding="0" cellspacing="0" class="email-container" style="max-width:580px;width:100%;">
    <tr>
      <td style="padding:0 8px 16px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:middle;">
              <a href="${site}" target="_blank" style="font-family:${FONT};font-size:26px;font-weight:800;letter-spacing:-0.03em;color:${INK};text-decoration:none;border:0;">Zavi</a>
            </td>
            ${
              kicker
                ? `<td align="right" style="vertical-align:middle;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${LABEL};">${kicker}</td>`
                : ""
            }
          </tr>
        </table>
      </td>
    </tr>
  </table>`;

  const eyebrowHtml = eyebrow
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px 0;"><tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid ${SKY_LINE};border-radius:999px;padding:6px 14px;font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${LABEL};">${eyebrow}</td></tr></table>`
    : "";

  const heroCalloutHtml =
    heroNumber || heroLabel
      ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
          <tr>
            <td align="center" bgcolor="${SOFT}" style="padding:26px 16px;background-color:${SOFT};border:1px solid ${LINE};border-radius:16px;">
              ${
                heroNumber
                  ? `<div class="u-hero-num" style="font-family:${FONT};font-size:44px;line-height:1.05;font-weight:800;color:${INK};letter-spacing:0.04em;">${heroNumber}</div>`
                  : ""
              }
              ${
                heroLabel
                  ? `<div style="margin-top:${heroNumber ? 12 : 0}px;font-family:${FONT};font-size:13px;font-weight:500;color:${MUTED};">${heroLabel}</div>`
                  : ""
              }
            </td>
          </tr>
        </table>`
      : "";

  const quoteHtml = quote
    ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;">
          <tr>
            <td width="48" style="vertical-align:top;">
              <div style="width:36px;height:36px;border-radius:999px;background-color:${INK};color:#ffffff;font-family:${FONT};font-size:15px;font-weight:800;line-height:36px;text-align:center;">${initialOf(quote.from)}</div>
            </td>
            <td style="vertical-align:top;">
              <div style="font-family:${FONT};font-size:14px;font-weight:700;color:${INK};margin:0 0 6px 0;">${escapeEmailHtml(quote.from)}</div>
              <div class="u-message" style="padding:14px 16px;background-color:${SKY};border-radius:4px 16px 16px 16px;font-family:${FONT};font-size:16px;line-height:1.55;color:${INK};">${escapeEmailHtml(quote.text).replace(/\n/g, "<br>")}</div>
            </td>
          </tr>
        </table>`
    : "";

  const detailsHtml = details.length
    ? `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;background-color:${SOFT};border:1px solid ${LINE};border-radius:16px;">
          ${details
            .map((d, i) => {
              const edge = i === details.length - 1 ? "" : `border-bottom:1px solid ${LINE};`;
              return `<tr>
            <td style="padding:13px 18px;${edge}font-family:${FONT};font-size:14px;line-height:1.45;color:${MUTED};width:38%;vertical-align:top;">${escapeEmailHtml(d.label)}</td>
            <td align="right" style="padding:13px 18px 13px 0;${edge}font-family:${FONT};font-size:14px;line-height:1.45;font-weight:700;color:${INK};vertical-align:top;">${escapeEmailHtml(d.value)}</td>
          </tr>`;
            })
            .join("")}
        </table>`
    : "";

  const ctaHtml =
    ctaText && ctaUrl
      ? `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px 0;">
          <tr>
            <td align="center" bgcolor="${INK}" style="background-color:${INK};border-radius:6px;">
              <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:15px;font-weight:700;mso-line-height-rule:exactly;line-height:20px;border-radius:6px;">${ctaText}</a>
            </td>
          </tr>
        </table>${
          linkFallback
            ? `
        <p style="margin:14px 0 0 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};">Button not working? Paste this link in your browser:<br><span style="word-break:break-all;color:${BODY};">${ctaUrl}</span></p>`
            : ""
        }`
      : "";

  const heroImageHtml = heroImage
    ? `<tr>
              <td style="padding:0;line-height:0;font-size:0;background-color:${SKY};">
                <img src="${escapeAttr(heroImage.src)}" alt="${escapeAttr(heroImage.alt)}" width="580" style="display:block;width:100%;max-width:580px;height:auto;border:0;outline:none;text-decoration:none;" />
              </td>
            </tr>`
    : "";

  const hasBelow = Boolean(
    heroCalloutHtml || quoteHtml || detailsHtml || body.trim() || ctaHtml || afterCta || footerNote,
  );

  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeAttr(title.replace(/<[^>]+>/g, ""))}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
      body, div, p, a, span, strong, em, li, ul, ol, td, th, h1, h2, h3, h4 {
        font-family: ${FONT};
      }
      /* Templates mark the key phrase with <em>: it reads as plain headline text. */
      .u-title em { font-style: normal; }
      .email-body p {
        font-size: 16px;
        line-height: 1.6;
        color: ${BODY};
        margin: 0 0 16px 0;
      }
      .email-body li { font-size: 16px; line-height: 1.6; color: ${BODY}; }
      .email-body a { color: ${INK}; text-decoration: underline; }
      @media only screen and (max-width: 640px) {
        .email-wrapper { padding: 16px 8px !important; }
        .email-container { width: 100% !important; max-width: 100% !important; }
        .email-content { padding-left: 22px !important; padding-right: 22px !important; }
        .u-title { font-size: 26px !important; line-height: 1.18 !important; }
        .u-hero-num { font-size: 34px !important; }
      }
    </style>
  </head>
  <body style="background-color:${GROUND};margin:0;padding:0;-webkit-font-smoothing:antialiased;color:${BODY};">
    ${
      preheader
        ? `<div style="display:none;font-size:1px;color:${GROUND};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeEmailHtml(preheader)}</div>`
        : ""
    }
    <table role="presentation" class="email-wrapper" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background-color:${GROUND};">
      <tr>
        <td align="center">
          ${mastheadHtml}
          <table role="presentation" class="email-container email-card" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background-color:${CARD};border:1px solid ${LINE};border-radius:24px;overflow:hidden;">
            ${heroImageHtml}
            <tr>
              <td class="email-content" align="left" bgcolor="${SKY}" style="padding:36px 40px ${hasBelow ? 26 : 36}px 40px;background-color:${SKY};">
                ${eyebrowHtml}
                <h1 class="u-title" style="color:${INK};margin:0;font-family:${FONT};font-size:30px;line-height:1.15;font-weight:800;letter-spacing:-0.03em;">${title}</h1>
                ${
                  introRendered
                    ? `<p style="font-family:${FONT};font-size:17px;line-height:1.55;font-weight:500;color:#595959;margin:14px 0 0 0;">${introRendered}</p>`
                    : ""
                }
              </td>
            </tr>
            ${
              hasBelow
                ? `<tr>
              <td class="email-content" align="left" bgcolor="${CARD}" style="padding:8px 40px 36px 40px;background-color:${CARD};">
                ${heroCalloutHtml}
                ${quoteHtml}
                ${detailsHtml}
                ${
                  body.trim()
                    ? `<div class="email-body" style="font-family:${FONT};color:${BODY};margin:0 0 12px 0;">
                  ${body}
                </div>`
                    : ""
                }
                ${ctaHtml}
                ${
                  afterCta
                    ? `<div class="email-body" style="font-family:${FONT};color:${BODY};margin:22px 0 0 0;">${afterCta}</div>`
                    : ""
                }
                ${
                  footerNote
                    ? `<p style="margin:22px 0 0 0;font-size:13px;line-height:1.55;color:${MUTED};font-family:${FONT};">${footerNote}</p>`
                    : ""
                }
              </td>
            </tr>`
                : ""
            }
          </table>
          ${renderEmailFooter({ footerVariant, siteUrl: site, unsubscribeUrl })}
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function renderEmailFooter(p: {
  footerVariant: EmailFooterVariant;
  siteUrl?: string;
  unsubscribeUrl?: string;
  note?: string;
}): string {
  const site = p.siteUrl || webOrigin();
  const tagline = p.footerVariant === "founder-growth" ? FOUNDER_TAGLINE : null;
  const year = new Date().getFullYear();
  return `<table role="presentation" class="email-container" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">
            <tr>
              <td align="center" style="padding:22px 20px 0 20px;text-align:center;font-family:${FONT};font-size:12px;line-height:1.7;color:${MUTED};">
                ${p.note ? `<p style="margin:0 0 8px 0;font-size:13px;color:${MUTED};">${p.note}</p>` : ""}
                ${
                  tagline
                    ? `<p style="margin:0 0 8px 0;font-size:13px;font-weight:600;color:${BODY};">${tagline}</p>`
                    : ""
                }
                <p style="margin:0 0 6px 0;">Need help? Write to <a href="mailto:${ZAVI_SUPPORT_EMAIL}" style="color:${MUTED};text-decoration:underline;">${ZAVI_SUPPORT_EMAIL}</a></p>
                <p style="margin:0;"><a href="${site}" style="color:${MUTED};text-decoration:underline;">zaviagent.com</a> &nbsp;&middot;&nbsp; &copy; ${year} Zavi &nbsp;&middot;&nbsp; <a href="${POSTAL_MAP_URL}" style="color:${MUTED};text-decoration:none;">${ZAVI_POSTAL_ADDRESS}</a></p>${
                  p.unsubscribeUrl
                    ? `
                <p style="margin:6px 0 0 0;">Don't want these emails? <a href="${escapeAttr(p.unsubscribeUrl)}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a></p>`
                    : ""
                }
              </td>
            </tr>
          </table>`;
}

function initialOf(name: string): string {
  const first = Array.from(name.trim())[0] ?? "";
  return /[\p{L}\p{N}]/u.test(first) ? escapeEmailHtml(first.toUpperCase()) : "Z";
}

function escapeAttr(s: string): string {
  return s.replace(/[<>"&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&amp;",
  );
}

export function oneLineName(s: string | null | undefined, max = 80): string {
  const t = emailSubjectLine(s);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

export function emailSubjectLine(s: string | null | undefined): string {
  return (s ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeEmailHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
