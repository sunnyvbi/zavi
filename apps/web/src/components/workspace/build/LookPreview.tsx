"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { readSiteLayout, type SiteDesignLayout, type SiteDesignLook, type SiteDesignPreview } from "@/lib/workspace/useSiteDesign";

const FONT_FAMILY = /^[A-Za-z0-9 ]{2,60}$/;

export function lookFontsHref(looks: readonly SiteDesignLook[]): string | null {
  const families = [...new Set(looks.flatMap((l) => [l.fonts.display, l.fonts.body]))].filter((f) => FONT_FAMILY.test(f)).sort();
  if (families.length === 0) return null;
  return `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f.replace(/ /g, "+")}:wght@400;700`).join("&")}&display=swap`;
}

export function useLookFonts(looks: readonly SiteDesignLook[]) {
  const href = useMemo(() => lookFontsHref(looks), [looks]);
  useEffect(() => {
    if (!href || typeof document === "undefined") return;
    if (Array.from(document.head.querySelectorAll("link[data-zavi-look-fonts]")).some((l) => l.getAttribute("href") === href)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute("data-zavi-look-fonts", "");
    document.head.appendChild(link);
  }, [href]);
}

export const LOOK_PAGE_WIDTH = 1280;
export const LOOK_PAGE_HEIGHT = 720;

const PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeThemeCss(css: string): string {
  return css.replace(/</g, "\\3c ");
}

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${LOOK_PAGE_WIDTH}px;height:${LOOK_PAGE_HEIGHT}px;overflow:hidden}
body{background:rgb(var(--background));color:rgb(var(--foreground));font-family:var(--font-body);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
h1,h2,h3,.brand{font-family:var(--font-display);font-weight:var(--heading-weight);letter-spacing:var(--heading-tracking);text-transform:var(--heading-case);color:rgb(var(--foreground))}
.nav{display:flex;align-items:center;justify-content:space-between;gap:32px;padding:20px 72px;border-bottom:1px solid rgb(var(--border))}
.brand{font-size:24px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px}
.links{display:flex;gap:28px;font-size:14px;color:rgb(var(--muted-foreground));white-space:nowrap;overflow:hidden}
.btn{display:inline-flex;align-items:center;white-space:nowrap;padding:12px 22px;border-radius:var(--radius);font-weight:600;font-size:15px;line-height:1.2}
.btn-primary{background:rgb(var(--primary));color:rgb(var(--primary-foreground));box-shadow:var(--shadow-sm)}
.btn-secondary{background:rgb(var(--secondary));color:rgb(var(--secondary-foreground));border:1px solid rgb(var(--border))}
.hero{padding:64px 72px 48px;max-width:960px}
.eyebrow{display:inline-block;padding:5px 12px;margin-bottom:20px;border-radius:999px;background:rgb(var(--accent));color:rgb(var(--accent-foreground));font-size:13px;font-weight:600}
h1{font-size:58px;line-height:1.06;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.subtitle{margin-top:20px;max-width:680px;font-size:19px;color:rgb(var(--muted-foreground));display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.actions{display:flex;gap:12px;margin-top:32px}
.features{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:0 72px 40px}
.card{padding:24px;border:1px solid rgb(var(--border));border-radius:var(--radius);background:rgb(var(--card));color:rgb(var(--card-foreground));box-shadow:var(--shadow-md)}
.card h3{font-size:20px;line-height:1.25;margin-bottom:8px}
.card p{font-size:14px;color:rgb(var(--muted-foreground));display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.band{display:flex;align-items:center;justify-content:space-between;gap:32px;margin:0 72px;padding:36px 48px;border-radius:var(--radius);background:rgb(var(--background));color:rgb(var(--foreground))}
.band h2{font-size:30px;line-height:1.2}
.image-slot{position:relative;overflow:hidden;background:linear-gradient(135deg,rgb(var(--accent)),rgb(var(--primary) / .55));border-radius:var(--radius);min-height:230px}
.image-slot:after{content:"";position:absolute;right:-14%;bottom:-30%;width:62%;aspect-ratio:1;border-radius:999px;background:rgb(var(--background) / .28)}
.image-slot:nth-child(2n){background:linear-gradient(200deg,rgb(var(--primary) / .7),rgb(var(--muted)))}
.image-slot:nth-child(3n){background:linear-gradient(160deg,rgb(var(--muted)),rgb(var(--accent)))}
body[data-layout="split"] .hero{display:grid;grid-template-columns:1.2fr 1fr;gap:48px;max-width:none;padding:44px 72px 36px}
body[data-layout="split"] h1{font-size:48px}
body[data-layout="centered"] .hero{max-width:none;text-align:center;padding:44px 180px 36px}
body[data-layout="centered"] .subtitle{margin-left:auto;margin-right:auto}
body[data-layout="centered"] .actions{justify-content:center}
body[data-layout="editorial"] .hero{max-width:none;padding:40px 72px 32px}
body[data-layout="editorial"] .hero-copy{display:grid;grid-template-columns:1.5fr 1fr;gap:16px 48px}
body[data-layout="editorial"] .eyebrow{grid-column:1/-1;justify-self:start;margin-bottom:0}
body[data-layout="editorial"] h1{font-size:70px;grid-row:2/4}
body[data-layout="editorial"] .subtitle{margin-top:0}
body[data-layout="editorial"] .actions{margin-top:0}
body[data-layout="editorial"] .card{border-width:1px 0 0;border-radius:0;box-shadow:none;background:transparent}
body[data-layout="bold"] .hero{max-width:none;padding:36px 72px;background:rgb(var(--primary));color:rgb(var(--primary-foreground));margin-bottom:28px}
body[data-layout="bold"] h1{font-size:76px;color:inherit}
body[data-layout="bold"] .subtitle{color:inherit;opacity:.85}
body[data-layout="bold"] .hero .btn-primary{background:rgb(var(--background));color:rgb(var(--foreground))}
body[data-layout="bold"] .actions{margin-top:20px}
body[data-layout="minimal"] .hero{max-width:none;padding:32px 72px 24px}
body[data-layout="minimal"] h1{font-size:42px}
body[data-layout="minimal"] .subtitle{font-size:17px;margin-top:12px}
body[data-layout="minimal"] .actions{margin-top:16px}
.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:0 72px 24px}
.gallery .image-slot{min-height:140px}
body[data-layout="minimal"] .features{display:none}
body[data-hero] .hero{display:block;max-width:none;text-align:left;padding:44px 72px 36px;background:transparent;color:inherit;margin-bottom:0}
body[data-hero] h1{font-size:54px;color:rgb(var(--foreground))}
body[data-hero] .subtitle{color:rgb(var(--muted-foreground));opacity:1;margin-left:0;margin-right:0}
body[data-hero] .actions{justify-content:flex-start;margin-top:28px}
body[data-hero] .hero .btn-primary{background:rgb(var(--primary));color:rgb(var(--primary-foreground))}
body[data-hero="centered"] .hero{text-align:center;padding:56px 200px 40px}
body[data-hero="centered"] .subtitle{margin-left:auto;margin-right:auto}
body[data-hero="centered"] .actions{justify-content:center}
body[data-hero="split"] .hero{display:grid;grid-template-columns:1.2fr 1fr;gap:48px;align-items:center}
body[data-hero="split"] h1{font-size:46px}
body[data-hero="image"] .hero{position:relative;min-height:330px;display:flex;flex-direction:column;justify-content:flex-end;padding:40px 72px;background:linear-gradient(135deg,rgb(var(--primary)),rgb(var(--foreground)))}
body[data-hero="image"] .hero h1,body[data-hero="image"] .hero .subtitle{color:#fff}
body[data-hero="image"] .hero .btn-primary{background:#fff;color:#111}
body[data-hero="editorial"] .hero-copy{display:grid;grid-template-columns:1.5fr 1fr;gap:16px 48px}
body[data-hero="editorial"] .eyebrow{grid-column:1/-1;justify-self:start;margin-bottom:0;background:transparent;padding:0;border-radius:0;color:rgb(var(--primary));text-transform:uppercase;letter-spacing:.16em}
body[data-hero="editorial"] h1{font-size:72px;grid-row:2/4}
body[data-hero="editorial"] .subtitle,body[data-hero="editorial"] .actions{margin-top:0}
body[data-hero="minimal"] .hero{padding:36px 72px 20px;border-bottom:1px solid rgb(var(--border))}
body[data-hero="minimal"] h1{font-size:38px}
body[data-hero="minimal"] .subtitle{font-size:16px;margin-top:10px}
body[data-hero="minimal"] .actions{margin-top:14px}
.sec{padding:22px 72px}
.sec h2{font-size:26px;line-height:1.2;margin-bottom:14px;max-width:760px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sec.tone-muted{background:rgb(var(--muted))}
.sec.tone-inverse{background:rgb(var(--foreground))}
.sec.tone-inverse h2,.sec.tone-inverse .num{color:rgb(var(--background))}
.row{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.tile{height:84px;border:1px solid rgb(var(--border));border-radius:var(--radius);background:rgb(var(--card));box-shadow:var(--shadow-sm)}
.icon-row .tile{height:auto;border:0;background:transparent;box-shadow:none;display:flex;gap:12px;align-items:center}
.dot{width:36px;height:36px;border-radius:999px;background:rgb(var(--accent));flex:none}
.bar{height:10px;border-radius:5px;background:rgb(var(--muted-foreground));opacity:.25;flex:1}
.alt{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:center}
.alt .image-slot{min-height:110px}
.lines{display:grid;gap:10px}
.quote{font-family:var(--font-display);font-size:30px;line-height:1.25;max-width:880px}
.quote:before{content:"\\201C";color:rgb(var(--primary));margin-right:4px}
.num{font-family:var(--font-display);font-size:44px;font-weight:var(--heading-weight);color:rgb(var(--primary))}
.masonry{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;align-items:start}
.masonry .image-slot:nth-child(1){min-height:150px}.masonry .image-slot:nth-child(2){min-height:100px}.masonry .image-slot:nth-child(3){min-height:130px}
.feature{display:grid;grid-template-columns:2fr 1fr;gap:14px}
.feature .stack{display:grid;gap:14px}
.feature .image-slot{min-height:70px}.feature>.image-slot{min-height:154px}
.sec .image-slot{min-height:110px}
.cta{display:flex;align-items:center;justify-content:space-between;gap:28px;border-radius:var(--radius);padding:26px 36px;background:rgb(var(--primary));color:rgb(var(--primary-foreground))}
.cta h2{color:inherit;margin:0}
.cta .btn-primary{background:rgb(var(--background));color:rgb(var(--foreground))}
`;

const slots = (n: number) => Array.from({ length: n }, () => '<div class="image-slot"></div>').join("");
const bars = '<div class="lines"><div class="bar"></div><div class="bar" style="flex:none;width:70%"></div></div>';
const TONES = new Set(["muted", "inverse"]);

function sectionBlock(sec: SiteDesignPreview["sections"][number], action: string): string {
  const e = escapeHtml;
  const tone = sec.tone && TONES.has(sec.tone) ? ` tone-${sec.tone}` : "";
  const head = `<h2>${e(sec.body ?? sec.title)}</h2>`;
  const wrap = (kind: string, inner: string) => `<section class="sec${tone}" data-kind="${kind}">${inner}</section>`;
  switch (sec.kind) {
    case "Features":
      if (sec.variant === "alternating" || sec.variant === "split") return wrap("Features", `${head}<div class="alt"><div class="image-slot"></div>${bars}</div>`);
      if (sec.variant === "icons") return wrap("Features", `${head}<div class="row icon-row">${'<div class="tile"><span class="dot"></span><div class="bar"></div></div>'.repeat(3)}</div>`);
      return wrap("Features", `${head}<div class="row">${'<div class="tile"></div>'.repeat(3)}</div>`);
    case "Gallery":
      if (sec.variant === "masonry") return wrap("Gallery", `${head}<div class="masonry">${slots(3)}</div>`);
      if (sec.variant === "feature") return wrap("Gallery", `${head}<div class="feature"><div class="image-slot"></div><div class="stack">${slots(2)}</div></div>`);
      return wrap("Gallery", `${head}<div class="row">${slots(3)}</div>`);
    case "Testimonials":
      if (sec.variant === "quote") return wrap("Testimonials", `<p class="quote">${e(sec.body ?? sec.title)}</p>`);
      return wrap("Testimonials", `${head}<div class="row">${'<div class="tile"></div>'.repeat(3)}</div>`);
    case "Stats":
      return wrap("Stats", `${head}<div class="row">${'<div><div class="num">00</div><div class="bar"></div></div>'.repeat(3)}</div>`);
    case "CTA":
      return wrap(
        "CTA",
        `<div class="cta"><h2>${e(sec.body ?? sec.title)}</h2>${sec.variant === "split" ? '<div class="image-slot" style="min-height:70px;flex:0 0 200px"></div>' : ""}<span class="btn btn-primary">${e(action)}</span></div>`,
      );
    default:
      return wrap(sec.kind ?? "Section", `${head}${bars}`);
  }
}

export const TILE_SECTIONS = 2;

const HERO_VARIANTS = new Set(["centered", "split", "image", "editorial", "minimal"]);

export function lookPreviewDoc(themeCss: string, preview: SiteDesignPreview, layout: SiteDesignLayout = "centered"): string {
  const arrangement = readSiteLayout(layout);
  if (preview.sections.some((s) => s.kind)) return structuredPreviewDoc(themeCss, preview, arrangement);
  const e = escapeHtml;
  const action = preview.primary_action ?? "Get started";
  const cards = preview.sections.slice(0, 3);
  const links = preview.sections.slice(0, 3).map((s) => `<span>${e(s.title)}</span>`).join("");
  const band = preview.sections[3]?.title ?? `Visit ${preview.name}`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    `<style>${safeThemeCss(themeCss)}</style>`,
    `<style>${BASE_CSS}</style>`,
    `</head><body data-layout="${arrangement}">`,
    `<header class="nav"><span class="brand">${e(preview.name)}</span><nav class="links">${links}</nav><span class="btn btn-primary">${e(action)}</span></header>`,
    '<section class="hero"><div class="hero-copy">',
    preview.eyebrow ? `<span class="eyebrow">${e(preview.eyebrow)}</span>` : "",
    `<h1>${e(preview.headline)}</h1>`,
    preview.subtitle ? `<p class="subtitle">${e(preview.subtitle)}</p>` : "",
    `<div class="actions"><span class="btn btn-primary">${e(action)}</span><span class="btn btn-secondary">Learn more</span></div>`,
    "</div>",
    arrangement === "split" ? '<div class="image-slot"></div>' : "",
    "</section>",
    arrangement === "minimal" ? '<div class="gallery"><div class="image-slot"></div><div class="image-slot"></div><div class="image-slot"></div></div>' : "",
    cards.length
      ? `<section class="features">${cards.map((c) => `<div class="card"><h3>${e(c.title)}</h3>${c.body ? `<p>${e(c.body)}</p>` : ""}</div>`).join("")}</section>`
      : "",
    `<section class="band surface-inverse"><h2>${e(band)}</h2><span class="btn btn-primary">${e(action)}</span></section>`,
    "</body></html>",
  ].join("");
}

function structuredPreviewDoc(themeCss: string, preview: SiteDesignPreview, arrangement: SiteDesignLayout): string {
  const e = escapeHtml;
  const action = preview.primary_action ?? "Get started";
  const hero = preview.hero_variant && HERO_VARIANTS.has(preview.hero_variant) ? preview.hero_variant : { split: "split", centered: "centered", editorial: "editorial", bold: "image", minimal: "minimal" }[arrangement];
  const links = preview.sections.slice(0, 3).map((s) => `<span>${e(s.title)}</span>`).join("");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    `<style>${safeThemeCss(themeCss)}</style>`,
    `<style>${BASE_CSS}</style>`,
    `</head><body data-layout="${arrangement}" data-hero="${hero}">`,
    `<header class="nav"><span class="brand">${e(preview.name)}</span><nav class="links">${links}</nav><span class="btn btn-primary">${e(action)}</span></header>`,
    '<section class="hero"><div class="hero-copy">',
    preview.eyebrow ? `<span class="eyebrow">${e(preview.eyebrow)}</span>` : "",
    `<h1>${e(preview.headline)}</h1>`,
    preview.subtitle ? `<p class="subtitle">${e(preview.subtitle)}</p>` : "",
    `<div class="actions"><span class="btn btn-primary">${e(action)}</span><span class="btn btn-secondary">Learn more</span></div>`,
    "</div>",
    hero === "split" ? '<div class="image-slot"></div>' : "",
    "</section>",
    preview.sections
      .slice(0, TILE_SECTIONS)
      .map((s) => sectionBlock(s, action))
      .join(""),
    "</body></html>",
  ].join("");
}

export function LookPreview({ label, themeCss, preview, layout }: { label: string; themeCss: string; preview: SiteDesignPreview; layout?: SiteDesignLayout }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  const doc = useMemo(() => lookPreviewDoc(themeCss, preview, layout), [themeCss, preview, layout]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const w = box.getBoundingClientRect().width;
      if (w > 0) setScale(w / LOOK_PAGE_WIDTH);
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={boxRef}
      aria-hidden
      data-testid="look-preview"
      className="relative w-full overflow-hidden bg-cream"
      style={{ aspectRatio: `${LOOK_PAGE_WIDTH} / ${LOOK_PAGE_HEIGHT}` }}
    >
      <iframe
        title={`Preview of the ${label} look`}
        srcDoc={doc}
        sandbox=""
        loading="lazy"
        tabIndex={-1}
        className="pointer-events-none absolute left-0 top-0 border-0"
        style={{
          width: LOOK_PAGE_WIDTH,
          height: LOOK_PAGE_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }}
      />
    </div>
  );
}
