
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CookieBannerView, type CookieBannerViewProps } from "./CookieBanner";
import { ANALYTICS, NECESSARY } from "@/lib/cookie-inventory";

const noop = () => {};
const base: CookieBannerViewProps = {
  bannerOpen: true,
  modalOpen: false,
  analytics: false,
  gpc: false,
  onAccept: noop,
  onReject: noop,
  onOpenPrefs: noop,
  onDismiss: noop,
  onToggleAnalytics: noop,
  onSave: noop,
  onCloseModal: noop,
};

function buttonClass(html: string, label: string): string | null {
  const m = html.match(new RegExp(`<button[^>]*class="([^"]*)"[^>]*>${label}</button>`));
  return m ? m[1] : null;
}

describe("first layer", () => {
  const html = renderToStaticMarkup(<CookieBannerView {...base} />);

  it("offers Accept and Reject as same-size, adjacent buttons", () => {
    const accept = buttonClass(html, "Accept");
    const reject = buttonClass(html, "Reject");
    expect(accept).toBeTruthy();
    expect(reject).toBeTruthy();
    for (const size of ["h-10", "flex-1", "text-[14px]", "font-semibold"]) {
      expect(accept!.split(" ")).toContain(size);
      expect(reject!.split(" ")).toContain(size);
    }
    expect(html).toMatch(/>Reject<\/button><button[^>]*>Accept<\/button>/);
  });

  it("links the policy and offers preferences, and says what we do not do", () => {
    expect(html).toContain('href="/cookie-policy"');
    expect(html).toContain("Manage preferences");
    expect(html).toContain("We do not use advertising cookies");
  });

  it("has a close control that is labelled as not choosing", () => {
    expect(html).toContain('aria-label="Close without choosing"');
  });

  it("renders nothing when closed", () => {
    expect(renderToStaticMarkup(<CookieBannerView {...base} bannerOpen={false} />)).toBe("");
  });
});

describe("preferences modal", () => {
  const html = renderToStaticMarkup(<CookieBannerView {...base} bannerOpen={false} modalOpen />);

  it("is a labelled modal dialog", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="cookie-prefs-title"');
    expect(html).toContain('id="cookie-prefs-title"');
  });

  it("renders Necessary locked on and Analytics off when not allowed", () => {
    const necessary = html.match(/<button[^>]*aria-label="Necessary cookies \(always on\)"[^>]*>/)?.[0] ?? "";
    const DISABLED_ATTR = /\sdisabled(=""|\s|>)/;
    expect(necessary).toContain('aria-checked="true"');
    expect(necessary).toMatch(DISABLED_ATTR);
    const analytics = html.match(/<button[^>]*aria-label="Analytics cookies"[^>]*>/)?.[0] ?? "";
    expect(analytics).toContain('aria-checked="false"');
    expect(analytics).not.toMatch(DISABLED_ATTR);
  });

  it("reflects a prior grant in the toggle", () => {
    const granted = renderToStaticMarkup(
      <CookieBannerView {...base} bannerOpen={false} modalOpen analytics />,
    );
    const analytics = granted.match(/<button[^>]*aria-label="Analytics cookies"[^>]*>/)?.[0] ?? "";
    expect(analytics).toContain('aria-checked="true"');
  });

  it("discloses every inventory row by name", () => {
    const text = html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
    for (const r of [...NECESSARY, ...ANALYTICS]) {
      expect(text, r.name).toContain(r.name.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    }
  });

  it("shows the GPC note only when the signal is present", () => {
    expect(html).not.toContain("Global Privacy Control");
    const withGpc = renderToStaticMarkup(
      <CookieBannerView {...base} bannerOpen={false} modalOpen gpc />,
    );
    expect(withGpc).toContain("Global Privacy Control");
  });
});

describe("dark mode", () => {
  const css = postcss.parse(
    readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8"),
  );

  function declsFor(selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    css.walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      rule.walkDecls(/^--c-/, (d) => {
        out[d.prop] = d.value;
      });
    });
    return out;
  }

  function tokensFor(selector: string): Record<string, string> {
    const palette = declsFor("html.dark");
    const out = declsFor(selector);
    for (const [prop, value] of Object.entries(out)) {
      const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
      if (ref) out[prop] = palette[ref[1]];
    }
    return out;
  }

  function brightness(rgb: string | undefined): number {
    const parts = (rgb ?? "").trim().split(/\s+/).map(Number);
    expect(parts).toHaveLength(3);
    return parts.reduce((a, b) => a + b, 0) / 3;
  }

  it("flips the surface tokens to dark under html.dark", () => {
    const light = tokensFor(".cookie-consent");
    const dark = tokensFor("html.dark .cookie-consent");
    expect(brightness(light["--c-cream"])).toBeGreaterThan(200);
    expect(brightness(light["--c-ink"])).toBeLessThan(60);
    expect(brightness(dark["--c-cream"])).toBeLessThan(60);
    expect(brightness(dark["--c-cream-deep"])).toBeLessThan(60);
    expect(brightness(dark["--c-ink"])).toBeGreaterThan(200);
    expect(brightness(dark["--c-ink-soft"])).toBeGreaterThan(150);
    expect(brightness(dark["--c-ink-muted"])).toBeGreaterThan(120);
  });

  for (const [name, props] of [
    ["banner", base],
    ["preferences modal", { ...base, bannerOpen: false, modalOpen: true, gpc: true }],
  ] as const) {
    it(`${name} sits in the themed scope and paints with tokens only`, () => {
      const html = renderToStaticMarkup(<CookieBannerView {...props} />);
      const surface = html.match(/class="(cookie-consent [^"]*)"/)?.[1] ?? "";
      expect(surface.split(" ")).toEqual(expect.arrayContaining(["bg-cream", "border-rule"]));
      const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
      const fixed = classes.filter((c) => /\[#|-(white|black)\b/.test(c) && c !== "bg-black/40");
      expect(fixed).toEqual([]);
    });
  }
});
