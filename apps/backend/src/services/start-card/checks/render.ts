
import { chromium, type Browser, type Page } from "playwright-core";
import type { StartCardRenderResult } from "@zavi/shared";
import { createRestAnchorClient } from "@/services/sandbox/browser-mcp/anchor-rest-client";
import { assertSafeUrl } from "@/services/onboarding/enrichment/url-guard";
import type { AnchorSession } from "@/services/sandbox/browser-mcp/anchor-backend";

export const PHONE = { width: 390, height: 844, deviceScaleFactor: 3 };
const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const NAV_TIMEOUT_MS = 25_000;
const SETTLE_MS = 2_000;
export const TAB_BUDGET_MS = 45_000;

export const CTA_RE =
  /\b(buy|shop|order|book|reserve|schedule|sign[ -]?up|register|join|get started|start|try|free trial|demo|contact|call|quote|estimate|enquire|inquire|subscribe|download|apply|get a quote|kaufen|bestellen|buchen|kontakt|anfragen|jetzt|acheter|commander|r\u00e9server|contactez|devis|essai|inscri)/i;

export const MEASURE_SCRIPT = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
  };
  const CTA = ${CTA_RE.toString()};
  let cta = null;
  for (const el of document.querySelectorAll('a, button, input[type=submit], input[type=button], [role=button]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top >= vh || r.bottom <= 0 || r.left >= vw || r.right <= 0) continue;
    const text = ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '').replace(/\\s+/g, ' ').trim();
    const href = (el.getAttribute('href') || '').toLowerCase();
    if (href.startsWith('tel:') || href.startsWith('mailto:') || (text && text.length <= 40 && CTA.test(text))) {
      cta = text.slice(0, 40) || href.slice(0, 40);
      break;
    }
  }
  const sizes = new Map();
  const boxes = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let n; let seen = 0;
  while ((n = walker.nextNode()) && seen < 4000) {
    seen++;
    const t = (n.textContent || '').trim();
    if (t.length < 3) continue;
    const el = n.parentElement;
    if (!el || !visible(el)) continue;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
    const px = Math.round(parseFloat(getComputedStyle(el).fontSize) || 0);
    if (t.length >= 20 && px > 0) sizes.set(px, (sizes.get(px) || 0) + t.length);
    const r = el.getBoundingClientRect();
    if (r.top < vh * 2 && r.bottom > 0 && boxes.length < 150) boxes.push({ el, r });
  }
  let body = null, best = 0;
  for (const [px, chars] of sizes) if (chars > best) { best = chars; body = px; }
  let pairs = 0;
  for (let i = 0; i < boxes.length && pairs < 50; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 0 || h <= 0) continue;
      const small = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (small >= 100 && w * h > small * 0.5) pairs++;
    }
  }
  const sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  return { cta_above_fold: cta !== null, cta_text: cta, body_text_px: body, overlap_pairs: pairs, horizontal_scroll: sw > vw + 2 };
})()`;

type Raw = { cta_above_fold: boolean; cta_text: string | null; body_text_px: number | null; overlap_pairs: number; horizontal_scroll: boolean };

export function toRenderResult(raw: unknown): StartCardRenderResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Raw>;
  const pairs = typeof r.overlap_pairs === "number" && Number.isFinite(r.overlap_pairs) ? Math.max(0, Math.floor(r.overlap_pairs)) : 0;
  const px = typeof r.body_text_px === "number" && r.body_text_px > 0 && r.body_text_px < 200 ? r.body_text_px : null;
  return {
    cta_above_fold: r.cta_above_fold === true,
    cta_text: typeof r.cta_text === "string" ? r.cta_text.slice(0, 40) : null,
    body_text_px: px,
    overlap_pairs: pairs,
    overlapping_boxes: pairs >= 2,
    horizontal_scroll: r.horizontal_scroll === true,
  };
}

export async function measureTab(browser: Browser, url: string): Promise<StartCardRenderResult | null> {
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  let page: Page | null = null;
  try {
    page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...PHONE, mobile: true });
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: PHONE_UA });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await assertSafeUrl(url);
    const main = page;
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === main.mainFrame()) {
        const ok = await assertSafeUrl(req.url()).then(() => true, () => false);
        if (!ok) return route.abort();
      }
      return route.continue();
    });
    await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS }).catch(async () => {
      if (!page || page.url() === "about:blank") throw new Error("nav_failed");
    });
    await assertSafeUrl(page.url());
    await page.waitForTimeout(SETTLE_MS);
    return toRenderResult(await page.evaluate(MEASURE_SCRIPT));
  } catch {
    return null;
  } finally {
    await page?.close().catch(() => {});
  }
}

export async function withCeiling<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const bell = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([p, bell]);
  } finally {
    clearTimeout(timer);
  }
}

export type RenderSites = (urls: string[]) => Promise<(StartCardRenderResult | null)[] | null>;

export const renderSitesOnPhone: RenderSites = async (urls) => {
  const apiKey = process.env.ANCHOR_API_KEY;
  if (!apiKey || urls.length === 0) return null;
  const client = createRestAnchorClient();
  let session: AnchorSession | null = null;
  let browser: Browser | null = null;
  try {
    session = await client.createSession({ apiKey, viewport: { width: PHONE.width, height: PHONE.height } });
    if (!session.cdp_url) return null;
    browser = await chromium.connectOverCDP(session.cdp_url, { timeout: 20_000 });
    const b = browser;
    return await Promise.all(urls.map((u) => withCeiling(measureTab(b, u), TAB_BUDGET_MS)));
  } catch (e) {
    console.error(`[start-card] phone render failed: ${(e as Error)?.message?.slice(0, 200)}`);
    return null;
  } finally {
    await browser?.close().catch(() => {});
    if (session) await client.closeSession({ apiKey, session }).catch(() => {});
  }
};
