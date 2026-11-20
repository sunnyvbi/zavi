"use client";

import { useRef } from "react";
import { EmailPreviewFrame } from "@/components/email/EmailCampaignCard";
import type { EmailTemplate } from "@/lib/workspace/emailCampaignSettingsApi";

export const PREVIEW_FONT_STACKS: Record<string, string> = {
  system: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  helvetica: "'Helvetica Neue',Helvetica,Arial,sans-serif",
  verdana: "Verdana,Geneva,sans-serif",
  trebuchet: "'Trebuchet MS','Lucida Grande',sans-serif",
  georgia: "Georgia,'Times New Roman',Times,serif",
  palatino: "'Palatino Linotype','Book Antiqua',Palatino,serif",
};

const DEFAULT_COLOR = "#111827";

export function escapeHtml(s: string): string {
  const entity: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => entity[c]!);
}
const lines = (s: string) => escapeHtml(s.replace(/\r\n?/g, "\n").trim()).replace(/\n/g, "<br>");

export function normalHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const hex = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${[...hex.slice(1)].map((c) => c + c).join("")}`;
  return null;
}

export function safeLogoUrl(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const url = new URL(v.trim());
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function inkOn(bg: string): string {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(bg.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#111827";
}

export type BrandPreviewInput = {
  name: string;
  brandColor: string;
  buttonColor: string;
  fontKey: string;
  logoUrl: string | null;
  signOff: string;
  postalAddress: string;
  showCards: boolean;
};

export function brandPreviewHtml(p: BrandPreviewInput): string {
  const font = escapeHtml(PREVIEW_FONT_STACKS[p.fontKey] ?? PREVIEW_FONT_STACKS.system!);
  const name = escapeHtml(p.name);
  const initial = escapeHtml((Array.from(p.name)[0] ?? "").toUpperCase());
  const brand = p.brandColor;
  const button = p.buttonColor;
  const muted = "#77716a";
  const ink = "#141413";
  const line = "#e6e3db";
  const canvas = "#f7f6f3";
  const pad = "padding-left:44px;padding-right:44px;";
  const body = `font-family:${font};font-size:16px;line-height:1.65;color:#3d3b37;`;
  const h: string[] = [
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<style>@media only screen and (max-width:620px){.zp{padding-left:24px!important;padding-right:24px!important}.zt{font-size:23px!important}.zo{padding:24px 0 32px!important}.zc{border-radius:0!important;border-left:0!important;border-right:0!important}}</style></head>`,
    `<body style="margin:0;padding:0;background-color:${canvas};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${canvas}" style="background-color:${canvas};"><tr><td class="zo" align="center" style="padding:40px 16px;">`,
    `<table data-part="email" class="zc" role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:560px;background-color:#ffffff;border:1px solid ${line};border-radius:12px;border-collapse:separate;overflow:hidden;font-family:${font};color:${ink};">`,
  ];
  if (p.logoUrl) {
    h.push(`<tr><td class="zp" align="left" style="padding-top:36px;${pad}"><img data-part="logo" src="${escapeHtml(p.logoUrl)}" alt="${name}" height="32" style="display:block;height:32px;width:auto;max-width:180px;border:0;"></td></tr>`);
  } else if (p.name) {
    h.push(
      `<tr><td class="zp" align="left" style="padding-top:36px;${pad}">`,
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>`,
      `<td data-part="initial" width="28" height="28" align="center" valign="middle" bgcolor="${brand}" style="width:28px;height:28px;border-radius:8px;background-color:${brand};color:${inkOn(brand)};font-family:${font};font-size:14px;line-height:28px;font-weight:bold;">${initial}</td>`,
      `<td data-part="name" valign="middle" style="padding-left:10px;font-family:${font};font-size:16px;line-height:1.3;font-weight:bold;letter-spacing:-0.01em;color:${ink};">${name}</td>`,
      `</tr></table></td></tr>`,
    );
  }
  h.push(
    `<tr><td class="zp zt" style="padding-top:32px;padding-bottom:14px;${pad}font-size:26px;line-height:1.25;font-weight:bold;letter-spacing:-0.02em;color:${ink};">This week at ${name}</td></tr>`,
    `<tr><td class="zp" style="padding-top:8px;padding-bottom:24px;${pad}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td data-part="hero" align="left" style="padding:16px 0;border-top:1px solid ${line};border-bottom:1px solid ${line};font-family:${font};">`,
    `<div style="font-size:20px;line-height:1.3;font-weight:bold;letter-spacing:-0.01em;color:${ink};">New this week</div>`,
    `<div style="padding-top:4px;font-size:14px;line-height:1.5;color:${muted};">A short detail line</div>`,
    `</td></tr></table></td></tr>`,
    `<tr><td class="zp" style="padding-top:0;padding-bottom:14px;${pad}${body}">Here is a short look at what is new. This is sample text so you can see how your emails will read.</td></tr>`,
    `<tr><td class="zp" style="padding-top:0;padding-bottom:14px;${pad}${body}">Your real emails use the words Zavi drafts for each campaign, in this same layout.</td></tr>`,
    `<tr><td class="zp" align="left" style="padding-top:12px;padding-bottom:32px;${pad}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td data-part="button" align="center" bgcolor="${button}" style="background-color:${button};border-radius:8px;">`,
    `<span style="display:inline-block;padding:14px 26px;border:1px solid ${button};border-radius:8px;background-color:${button};font-family:${font};font-size:15px;line-height:1.2;font-weight:bold;color:${inkOn(button)};">Shop now</span>`,
    `</td></tr></table></td></tr>`,
  );
  if (p.showCards) {
    for (const [title, meta, price] of [
      ["Sample product", "A short line about it", "$24"],
      ["Another product", "A short line about it", "$36"],
    ] as const) {
      h.push(
        `<tr><td data-part="card" class="zp" style="padding-top:0;padding-bottom:14px;${pad}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${line};border-radius:10px;border-collapse:separate;overflow:hidden;"><tr><td style="padding:14px 18px;font-family:${font};">`,
        `<div style="font-size:15px;line-height:1.4;font-weight:bold;color:${ink};">${title}</div>`,
        `<div style="padding-top:4px;font-size:14px;line-height:1.5;color:${muted};">${meta}</div>`,
        `<div data-part="price" style="padding-top:6px;font-size:15px;font-weight:bold;color:${brand};">${price}</div>`,
        `</td></tr></table></td></tr>`,
      );
    }
  }
  const signOff = p.signOff.trim();
  if (signOff) {
    h.push(`<tr><td data-part="sign-off" class="zp" style="padding-top:4px;padding-bottom:36px;${pad}font-family:${font};font-size:16px;line-height:1.65;color:${ink};">${lines(signOff)}</td></tr>`);
  } else {
    h.push(`<tr><td style="height:8px;line-height:8px;font-size:0;">\u00a0</td></tr>`);
  }
  h.push(
    `</table>`,
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;"><tr><td data-part="footer" class="zp" align="left" style="padding:20px 8px 0;font-family:${font};font-size:12px;line-height:1.6;color:${muted};">`,
    p.name ? `<div style="padding-bottom:2px;font-weight:bold;color:#3d3b37;">${name}</div>` : "",
    `<div>${lines(p.postalAddress)}</div>`,
    `<div style="padding-top:10px;"><span style="color:${muted};text-decoration:underline;">Unsubscribe</span></div>`,
    `</td></tr></table>`,
    `</td></tr></table></body></html>`,
  );
  return h.join("");
}

export function BrandPreview({ template, name }: { template: EmailTemplate; name?: string | null }) {
  const lastBrand = useRef(normalHex(template.brand_color) ?? DEFAULT_COLOR);
  const lastButton = useRef(normalHex(template.button_color) ?? DEFAULT_COLOR);
  const brand = normalHex(template.brand_color);
  const button = normalHex(template.button_color);
  if (brand) lastBrand.current = brand;
  if (button) lastButton.current = button;
  const html = brandPreviewHtml({
    name: name?.trim() || "Your business",
    brandColor: lastBrand.current,
    buttonColor: lastButton.current,
    fontKey: template.font_key,
    logoUrl: safeLogoUrl(template.logo_url),
    signOff: template.sign_off ?? "",
    postalAddress: template.postal_address?.trim() || "Your postal address",
    showCards: template.show_cards === true,
  });
  return (
    <div data-testid="brand-preview" className="grid min-w-0 content-start gap-1.5">
      <p className="text-[12px] leading-4 text-inkMuted">Preview</p>
      <div className="h-[360px] min-w-0 overflow-hidden rounded-xl border border-rule bg-white">
        <div data-testid="brand-preview-scroll" className="h-full overflow-y-auto overflow-x-hidden">
          <EmailPreviewFrame html={html} title="Email template preview" bare />
        </div>
      </div>
    </div>
  );
}
