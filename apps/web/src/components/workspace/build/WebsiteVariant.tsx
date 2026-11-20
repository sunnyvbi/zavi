"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { escapeHtml, lookFontsHref, safeThemeCss } from "./LookPreview";
import { readSiteLayout, type SiteDesignLayout, type SiteDesignLook, type SiteDesignPreview } from "@/lib/workspace/useSiteDesign";

export const WEBSITE_PAGE_WIDTH = 1280;
export const WEBSITE_PAGE_HEIGHT = 900;

export function websiteNumber(index: number): string {
  return `Website ${index + 1}`;
}

const CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:";
const HEX = /^#([0-9a-f]{6})$/i;
const RADIUS = /^\d{1,2}(\.\d{1,3})?(rem|px|em)$/;
const FAMILY = /^[A-Za-z0-9 ]{2,60}$/;
const HERO_VARIANTS = new Set(["centered", "split", "image", "editorial", "minimal"]);
const LAYOUT_HERO: Record<SiteDesignLayout, string> = { split: "split", centered: "centered", editorial: "editorial", bold: "image", minimal: "minimal" };
const DEFAULT_FEATURES = ["What we offer", "How it works", "Why choose us"];

function rgb(hex: string): [number, number, number] {
  const m = HEX.exec(hex);
  const n = m ? parseInt(m[1]!, 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function triplet(c: [number, number, number]): string {
  return c.map((v) => Math.round(v)).join(" ");
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function luminance([r, g, b]: [number, number, number]): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function readableOn(bg: [number, number, number], a: [number, number, number], b: [number, number, number]): [number, number, number] {
  const contrast = (x: [number, number, number]) => {
    const l1 = luminance(bg);
    const l2 = luminance(x);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  return contrast(a) >= contrast(b) ? a : b;
}

const fontStack = (family: string) => (FAMILY.test(family) ? `"${family}", ui-sans-serif, system-ui, sans-serif` : "ui-sans-serif, system-ui, sans-serif");

export function swatchThemeCss(look: SiteDesignLook): string {
  const s = look.swatches;
  const bg = rgb(s.background);
  const fg = rgb(s.foreground);
  const primary = rgb(s.primary);
  const accent = rgb(s.accent);
  const muted = rgb(s.muted);
  const white: [number, number, number] = [255, 255, 255];
  const ink: [number, number, number] = [17, 17, 17];
  const fonts = lookFontsHref([look]);
  const vars: Array<[string, string]> = [
    ["background", triplet(bg)],
    ["foreground", triplet(fg)],
    ["card", triplet(bg)],
    ["card-foreground", triplet(fg)],
    ["muted", triplet(muted)],
    ["muted-foreground", triplet(mix(fg, bg, 0.38))],
    ["primary", triplet(primary)],
    ["primary-foreground", triplet(readableOn(primary, white, ink))],
    ["secondary", triplet(muted)],
    ["secondary-foreground", triplet(fg)],
    ["accent", triplet(accent)],
    ["accent-foreground", triplet(readableOn(accent, fg, bg))],
    ["border", triplet(mix(bg, fg, 0.14))],
    ["shadow", triplet(fg)],
    ["radius", RADIUS.test(look.radius) ? look.radius : "0.5rem"],
    ["font-display", fontStack(look.fonts.display)],
    ["font-body", fontStack(look.fonts.body)],
    ["heading-weight", "700"],
    ["heading-tracking", "-0.02em"],
    ["heading-case", "none"],
    ["shadow-sm", "0 1px 2px 0 rgb(var(--shadow) / 0.06)"],
    ["shadow-md", "0 1px 3px 0 rgb(var(--shadow) / 0.08), 0 8px 24px -8px rgb(var(--shadow) / 0.16)"],
  ];
  return `${fonts ? `@import url("${fonts}");\n` : ""}:root{${vars.map(([k, v]) => `--${k}: ${v};`).join("")}}`;
}

const PAGE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${WEBSITE_PAGE_WIDTH}px;height:${WEBSITE_PAGE_HEIGHT}px;overflow:hidden}
body{display:grid;grid-template-rows:auto minmax(0,1fr) auto auto auto;background:rgb(var(--background));color:rgb(var(--foreground));font-family:var(--font-body);font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2,h3,.brand,.num{font-family:var(--font-display);font-weight:var(--heading-weight);letter-spacing:var(--heading-tracking);text-transform:var(--heading-case)}
.clamp{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.nav{display:flex;align-items:center;gap:32px;padding:22px 64px;border-bottom:1px solid rgb(var(--border))}
.brand{font-size:24px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:380px}
.links{display:flex;gap:28px;margin-left:auto;font-size:15px;color:rgb(var(--muted-foreground));white-space:nowrap}
.btn{display:inline-flex;align-items:center;white-space:nowrap;padding:13px 24px;border-radius:var(--radius);font-weight:600;font-size:15px;line-height:1.2}
.btn-primary{background:rgb(var(--primary));color:rgb(var(--primary-foreground));box-shadow:var(--shadow-sm)}
.btn-ghost{border:1px solid rgb(var(--border));color:rgb(var(--foreground))}
.hero{overflow:hidden;padding:56px 64px;display:flex;flex-direction:column;justify-content:center}
.eyebrow{align-self:flex-start;display:inline-block;padding:5px 12px;margin-bottom:18px;border-radius:999px;background:rgb(var(--accent));color:rgb(var(--accent-foreground));font-size:13px;font-weight:600;max-width:640px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
h1{font-size:58px;line-height:1.06;-webkit-line-clamp:3}
.sub{margin-top:18px;max-width:660px;font-size:19px;color:rgb(var(--muted-foreground));-webkit-line-clamp:2}
.actions{display:flex;gap:12px;margin-top:28px}
.panel{border-radius:var(--radius);background:linear-gradient(135deg,rgb(var(--primary)),rgb(var(--accent)));min-height:120px}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:8px 64px 40px}
.feature{padding:24px;border:1px solid rgb(var(--border));border-radius:var(--radius);background:rgb(var(--card));color:rgb(var(--card-foreground));box-shadow:var(--shadow-md)}
.icon{width:40px;height:40px;border-radius:calc(var(--radius) + 4px);background:rgb(var(--accent))}
.feature h3{font-size:21px;line-height:1.25;margin-top:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.feature p{margin-top:6px;font-size:14px;color:rgb(var(--muted-foreground));-webkit-line-clamp:2}
.bar{height:10px;margin-top:12px;border-radius:5px;background:rgb(var(--muted-foreground));opacity:.22;width:80%}
.num{display:none;font-size:15px;color:rgb(var(--primary))}
.feature .panel{display:none;height:120px;min-height:0}
.band{display:flex;align-items:center;justify-content:space-between;gap:32px;margin:0 64px 36px;padding:32px 44px;border-radius:var(--radius);background:rgb(var(--primary));color:rgb(var(--primary-foreground))}
.band h2{font-size:30px;line-height:1.2;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.band .btn{background:rgb(var(--background));color:rgb(var(--foreground))}
.band.quote{background:rgb(var(--muted));color:rgb(var(--foreground))}
.band.quote h2{font-style:italic;white-space:normal}
.band.quote h2:before{content:"\\201C";color:rgb(var(--primary));margin-right:6px}
.band.quote .btn{background:rgb(var(--primary));color:rgb(var(--primary-foreground))}
.footer{display:flex;align-items:center;gap:32px;padding:22px 64px;border-top:1px solid rgb(var(--border));font-size:14px;color:rgb(var(--muted-foreground))}
.footer .brand{font-size:18px;color:rgb(var(--foreground))}
.footer .links{font-size:14px}
body[data-hero="split"] .hero{display:grid;grid-template-columns:1.1fr 1fr;gap:56px;align-items:stretch}
body[data-hero="split"] .copy{display:flex;flex-direction:column;justify-content:center}
body[data-hero="split"] h1{font-size:50px}
body[data-hero="split"] .hero .panel{height:100%}
body[data-hero="centered"] .hero{text-align:center;align-items:center;padding:56px 200px}
body[data-hero="centered"] .copy{display:flex;flex-direction:column;align-items:center}
body[data-hero="centered"] .eyebrow{align-self:center}
body[data-hero="centered"] .actions{justify-content:center}
body[data-hero="image"] .hero{margin:0;background:linear-gradient(135deg,rgb(var(--primary)),rgb(var(--foreground)));color:#fff;justify-content:flex-end}
body[data-hero="image"] h1{font-size:76px;color:#fff;max-width:1000px}
body[data-hero="image"] .sub{color:#fff;opacity:.86}
body[data-hero="image"] .eyebrow{background:rgba(255,255,255,.16);color:#fff}
body[data-hero="image"] .hero .btn-primary{background:#fff;color:#111}
body[data-hero="image"] .hero .btn-ghost{border-color:rgba(255,255,255,.5);color:#fff}
body[data-hero="editorial"] .copy{display:grid;grid-template-columns:1.6fr 1fr;gap:20px 56px;align-items:end}
body[data-hero="editorial"] .eyebrow{grid-column:1/-1;background:transparent;padding:0;border-radius:0;color:rgb(var(--primary));text-transform:uppercase;letter-spacing:.16em;margin:0}
body[data-hero="editorial"] h1{font-size:78px;grid-row:2/4;-webkit-line-clamp:3}
body[data-hero="editorial"] .sub,body[data-hero="editorial"] .actions{margin-top:0}
body[data-hero="minimal"] .hero{padding:40px 64px;justify-content:flex-start}
body[data-hero="minimal"] h1{font-size:44px;max-width:900px}
body[data-hero="minimal"] .sub{font-size:17px;margin-top:12px}
body[data-hero="minimal"] .eyebrow{background:transparent;padding:0;color:rgb(var(--muted-foreground));text-transform:uppercase;letter-spacing:.14em}
body[data-hero="minimal"] .actions{margin-top:20px}
.features[data-style="centered"] .feature{text-align:center}
.features[data-style="centered"] .icon{margin:0 auto;border-radius:999px}
.features[data-style="numbered"] .feature{border-width:2px 0 0;border-color:rgb(var(--foreground));border-radius:0;box-shadow:none;background:transparent;padding:20px 0 0}
.features[data-style="numbered"] .icon{display:none}
.features[data-style="numbered"] .num{display:block}
.features[data-style="numbered"] .feature h3{margin-top:8px}
.features[data-style="solid"]{background:rgb(var(--muted));padding-top:36px;margin-bottom:36px}
.features[data-style="solid"] .feature{box-shadow:none;border-color:transparent}
.features[data-style="gallery"] .feature{padding:0;border:0;box-shadow:none;background:transparent}
.features[data-style="gallery"] .icon{display:none}
.features[data-style="gallery"] .panel{display:block}
.features[data-style="gallery"] .feature h3{font-size:17px;margin-top:12px}
body[data-layout="bold"] .band:not(.quote){background:rgb(var(--foreground));color:rgb(var(--background))}
body[data-layout="minimal"] .band:not(.quote){background:transparent;color:rgb(var(--foreground));border-top:1px solid rgb(var(--border));border-radius:0;padding:28px 0}
body[data-layout="minimal"] .band:not(.quote) .btn{background:rgb(var(--primary));color:rgb(var(--primary-foreground))}
body[data-layout="minimal"] .brand{text-transform:uppercase;letter-spacing:.14em;font-size:20px}
`;

const FEATURE_STYLE: Record<SiteDesignLayout, string> = { split: "cards", centered: "centered", editorial: "numbered", bold: "solid", minimal: "gallery" };

type Item = { title: string; body?: string };

function featureItems(preview: SiteDesignPreview): Item[] {
  const own = preview.sections.filter((s) => s.kind !== "Testimonials" && s.kind !== "CTA").map((s) => ({ title: s.title, body: s.body }));
  const seen = new Set(own.map((i) => i.title.toLowerCase()));
  const pad = DEFAULT_FEATURES.filter((t) => !seen.has(t.toLowerCase())).map((title) => ({ title }));
  return [...own, ...pad].slice(0, 3);
}

export function fallbackWebsitePreview(name = "Your business"): SiteDesignPreview {
  return { name, headline: "Your new website", primary_action: "Get in touch", sections: [] };
}

export function websiteVariantDoc(look: SiteDesignLook, preview: SiteDesignPreview): string {
  const e = escapeHtml;
  const layout = readSiteLayout(look.layout);
  const hero = preview.hero_variant && HERO_VARIANTS.has(preview.hero_variant) ? preview.hero_variant : LAYOUT_HERO[layout];
  const action = preview.primary_action ?? "Get in touch";
  const items = featureItems(preview);
  const gallery = preview.sections.some((s) => s.kind === "Gallery");
  const style = gallery && layout !== "editorial" ? "gallery" : FEATURE_STYLE[layout];
  const quote = preview.sections.find((s) => s.kind === "Testimonials");
  const cta = preview.sections.find((s) => s.kind === "CTA");
  const links = [...items.slice(0, 2).map((i) => i.title), "Contact"];
  const theme = look.theme_css ?? swatchThemeCss(look);
  const band = quote
    ? `<section class="band quote" data-kind="quote"><h2 class="clamp">${e(quote.body ?? quote.title)}</h2><span class="btn btn-primary">${e(action)}</span></section>`
    : `<section class="band" data-kind="cta"><h2>${e(cta?.body ?? cta?.title ?? `Ready to start with ${preview.name}?`)}</h2><span class="btn">${e(action)}</span></section>`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<style>${safeThemeCss(theme)}</style>`,
    `<style>${PAGE_CSS}</style>`,
    `</head><body data-layout="${layout}" data-hero="${hero}">`,
    `<header class="nav"><span class="brand">${e(preview.name)}</span><nav class="links">${links.map((l) => `<span>${e(l)}</span>`).join("")}</nav><span class="btn btn-primary">${e(action)}</span></header>`,
    '<section class="hero"><div class="copy">',
    preview.eyebrow ? `<span class="eyebrow">${e(preview.eyebrow)}</span>` : "",
    `<h1 class="clamp">${e(preview.headline)}</h1>`,
    preview.subtitle ? `<p class="sub clamp">${e(preview.subtitle)}</p>` : "",
    `<div class="actions"><span class="btn btn-primary">${e(action)}</span><span class="btn btn-ghost">Learn more</span></div>`,
    "</div>",
    hero === "split" ? '<div class="panel"></div>' : "",
    "</section>",
    `<section class="features" data-style="${style}">`,
    items
      .map(
        (it, i) =>
          `<div class="feature"><div class="panel"></div><div class="icon"></div><span class="num">0${i + 1}</span><h3>${e(it.title)}</h3>${it.body ? `<p class="clamp">${e(it.body)}</p>` : '<div class="bar"></div>'}</div>`,
      )
      .join(""),
    "</section>",
    band,
    `<footer class="footer"><span class="brand">${e(preview.name)}</span><nav class="links">${links.map((l) => `<span>${e(l)}</span>`).join("")}</nav></footer>`,
    "</body></html>",
  ].join("");
}

function useFitScale() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const w = box.getBoundingClientRect().width;
      if (w > 0) setScale(w / WEBSITE_PAGE_WIDTH);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);
  return { boxRef, scale };
}

export function liveSiteSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (typeof window !== "undefined" && parsed.origin === window.location.origin) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function LiveSiteFrame({ url, name }: { url: string; name: string }) {
  const { boxRef, scale } = useFitScale();
  return (
    <div
      ref={boxRef}
      aria-hidden
      data-testid="website-live"
      className="relative w-full overflow-hidden bg-cream"
      style={{ aspectRatio: `${WEBSITE_PAGE_WIDTH} / ${WEBSITE_PAGE_HEIGHT}` }}
    >
      <iframe
        title={`${name} preview`}
        src={url}
        sandbox="allow-scripts allow-same-origin"
        loading="lazy"
        referrerPolicy="no-referrer"
        tabIndex={-1}
        className="pointer-events-none absolute left-0 top-0 border-0"
        style={{ width: WEBSITE_PAGE_WIDTH, height: WEBSITE_PAGE_HEIGHT, transform: `scale(${scale})`, transformOrigin: "0 0" }}
      />
    </div>
  );
}

export function WebsiteVariant({ look, preview, name }: { look: SiteDesignLook; preview: SiteDesignPreview; name: string }) {
  const { boxRef, scale } = useFitScale();
  const doc = useMemo(() => websiteVariantDoc(look, preview), [look, preview]);

  return (
    <div
      ref={boxRef}
      aria-hidden
      data-testid="website-variant"
      data-layout={readSiteLayout(look.layout)}
      className="relative w-full overflow-hidden bg-cream"
      style={{ aspectRatio: `${WEBSITE_PAGE_WIDTH} / ${WEBSITE_PAGE_HEIGHT}` }}
    >
      <iframe
        title={`${name} preview`}
        srcDoc={doc}
        sandbox=""
        loading="lazy"
        tabIndex={-1}
        className="pointer-events-none absolute left-0 top-0 border-0"
        style={{ width: WEBSITE_PAGE_WIDTH, height: WEBSITE_PAGE_HEIGHT, transform: `scale(${scale})`, transformOrigin: "0 0" }}
      />
    </div>
  );
}

export function WebsiteChoiceBody({
  look,
  index,
  preview,
  selected,
  busy = false,
  siteUrl = null,
  locked = false,
}: {
  look: SiteDesignLook;
  index: number;
  preview: SiteDesignPreview | null;
  selected: boolean;
  busy?: boolean;
  siteUrl?: string | null;
  locked?: boolean;
}) {
  const number = websiteNumber(index);
  const live = liveSiteSrc(siteUrl);
  const frame = live ? <LiveSiteFrame url={live} name={number} /> : <WebsiteVariant look={look} preview={preview ?? fallbackWebsitePreview()} name={number} />;
  if (locked) {
    const fonts = look.fonts.display === look.fonts.body ? look.fonts.display : `${look.fonts.display} · ${look.fonts.body}`;
    const palette = [look.swatches.primary, look.swatches.accent, look.swatches.foreground, look.swatches.background];
    return (
      <>
        {frame}
        <div data-testid="website-footer-locked" className="flex min-w-0 items-center justify-between gap-3 border-t border-rule px-3.5 py-3">
          <div className="min-w-0">
            <p data-testid="website-name" className="truncate text-[14px] font-semibold leading-5 text-ink">
              {look.label}
            </p>
            <p data-testid="website-fonts" className="truncate text-[12px] leading-4 text-inkMuted">
              {fonts}
            </p>
          </div>
          <div data-testid="website-palette" className="flex shrink-0 -space-x-1.5" aria-label="Colours">
            {palette.map((color, i) => (
              <span
                key={`${color}-${i}`}
                title={color}
                style={{ backgroundColor: color }}
                className="h-5 w-5 rounded-full border-2 border-cream shadow-[0_0_0_1px_rgb(var(--c-ink)/0.14)]"
              />
            ))}
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      {frame}
      <div className="flex min-w-0 items-start justify-between gap-2 border-t border-rule px-3 pb-2.5 pt-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium leading-4 text-inkMuted">{number}</p>
          <p data-testid="website-name" className="truncate text-[13px] font-semibold leading-5 text-ink">
            {look.label}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {look.recommended && (
            <span className="rounded-full border border-rule px-1.5 py-0.5 text-[10px] font-medium leading-3 text-inkMuted">Recommended</span>
          )}
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-inkMuted" aria-hidden />
          ) : selected ? (
            <span className="grid h-4 w-4 place-items-center rounded-full bg-ink text-cream">
              <Check className="h-2.5 w-2.5" aria-hidden />
            </span>
          ) : null}
        </div>
      </div>
    </>
  );
}

export function websiteAriaLabel(look: SiteDesignLook, index: number): string {
  return `${websiteNumber(index)}: ${look.label}${look.recommended ? " (recommended)" : ""}`;
}
