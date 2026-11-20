// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");

function extractRenderZaviBadge(): (badgeHidden: unknown, reserveSpace?: unknown) => void {
  const start = SRC.indexOf("/* test-extract:start renderZaviBadge */");
  const end = SRC.indexOf("/* test-extract:end renderZaviBadge */");
  if (start < 0 || end < 0) throw new Error("renderZaviBadge extract markers not found in runtime source");
  const body = SRC.slice(start, end);
  return new Function(`${body}\n; return renderZaviBadge;`)() as (b: unknown, r?: unknown) => void;
}

const renderZaviBadge = extractRenderZaviBadge();

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("renderZaviBadge — fixed 'Made with Zavi' badge", () => {
  it("injects exactly one #zavi-made-badge, only on explicit false", () => {
    renderZaviBadge(false);
    const el = document.getElementById("zavi-made-badge");
    expect(el).not.toBeNull();
    expect(el!.tagName).toBe("A");
    expect(el!.textContent).toBe("Made with Zavi");
    expect((el as HTMLAnchorElement).href).toContain("zaviagent.com");
    expect(el!.getAttribute("rel")).toContain("noopener");
    expect(document.querySelectorAll("#zavi-made-badge")).toHaveLength(1);
  });

  it("renders the real Zavi mark on a white tile — inlined, no network fetch", () => {
    renderZaviBadge(false);
    const el = document.getElementById("zavi-made-badge")!;
    const svg = el.querySelector("svg")!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("viewBox")).toBe("0 0 171 171");
    expect(svg.querySelectorAll("path")).toHaveLength(2);
    expect(el.getAttribute("aria-label")).toBe("Made with Zavi");
  });

  it("has no status pip — the badge is the mark + label only", () => {
    renderZaviBadge(false);
    const el = document.getElementById("zavi-made-badge")!;
    const green = Array.from(el.querySelectorAll("span")).filter((s) =>
      (s.getAttribute("style") ?? "").includes("#22c55e"),
    );
    expect(green).toHaveLength(0);
    expect(el.querySelectorAll("span")).toHaveLength(2);
  });

  it("pins its own sizing with inline !important (host CSS can't blow up the logo)", () => {
    renderZaviBadge(false);
    const svgStyle = document.getElementById("zavi-made-badge")!.querySelector("svg")!.getAttribute("style") ?? "";
    expect(svgStyle).toContain("width:17px !important");
    expect(svgStyle).toContain("height:17px !important");
  });

  it("every child carries its own all:revert FIRST (host CSS can't restyle the pill)", () => {
    renderZaviBadge(false);
    const el = document.getElementById("zavi-made-badge")!;
    const children = Array.from(el.querySelectorAll("span"));
    expect(children.length).toBeGreaterThanOrEqual(2);
    for (const c of children) {
      const style = c.getAttribute("style") ?? "";
      expect(style.startsWith("all:revert")).toBe(true);
    }
  });

  it("is idempotent — a second call does not duplicate", () => {
    renderZaviBadge(false);
    renderZaviBadge(false);
    expect(document.querySelectorAll("#zavi-made-badge")).toHaveLength(1);
  });

  it("does NOT inject for true / undefined / null / missing (fail-closed)", () => {
    for (const v of [true, undefined, null] as const) {
      document.body.innerHTML = "";
      renderZaviBadge(v);
      expect(document.getElementById("zavi-made-badge")).toBeNull();
    }
  });

  it("removes an existing badge when the tenant hides it (called with true)", () => {
    renderZaviBadge(false);
    expect(document.getElementById("zavi-made-badge")).not.toBeNull();
    renderZaviBadge(true);
    expect(document.getElementById("zavi-made-badge")).toBeNull();
  });

  it("is fixed-positioned — all:revert comes FIRST and does not clobber position", () => {
    renderZaviBadge(false);
    const style = document.getElementById("zavi-made-badge")!.getAttribute("style")!;
    expect(style).toContain("all:revert");
    expect(style).toContain("position:fixed");
    expect(style.indexOf("all:revert")).toBeLessThan(style.indexOf("position:fixed"));
  });

  it("never throws on a hostile / malformed argument", () => {
    expect(() =>
      renderZaviBadge({
        toString() {
          throw new Error("boom");
        },
      }),
    ).not.toThrow();
    expect(() => renderZaviBadge(0)).not.toThrow();
    expect(document.getElementById("zavi-made-badge")).toBeNull();
  });
});

describe("renderZaviBadge — keeps space for itself (site_badge_reserves_space)", () => {
  function host() {
    const root = document.createElement("div");
    root.id = "root";
    const picker = document.createElement("button");
    picker.textContent = "Pick a day";
    root.appendChild(picker);
    document.body.appendChild(root);
    return root;
  }

  it("adds one empty strip after the page content, at least as tall as the badge plus its gap", () => {
    const root = host();
    renderZaviBadge(false, true);
    renderZaviBadge(false, true);
    const spacers = document.querySelectorAll("#zavi-badge-spacer");
    expect(spacers).toHaveLength(1);
    const spacer = spacers[0] as HTMLElement;
    expect(spacer.parentElement).toBe(document.body);
    expect(root.compareDocumentPosition(spacer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(spacer.getAttribute("aria-hidden")).toBe("true");
    expect(spacer.textContent).toBe("");
    const spacerStyle = spacer.getAttribute("style")!;
    expect(spacerStyle.startsWith("all:revert")).toBe(true);
    expect(spacerStyle).toContain("display:block !important");
    const reserved = Number(/height:(\d+)px !important/.exec(spacerStyle)![1]);

    const badge = document.getElementById("zavi-made-badge")!;
    const style = badge.getAttribute("style")!;
    const bottom = Number(/bottom:(\d+)px/.exec(style)![1]);
    const pad = /padding:(\d+)px \d+px (\d+)px/.exec(style)!;
    const tileStyle = badge.querySelector("span")!.getAttribute("style")!;
    const tile = Number(/height:(\d+)px !important/.exec(tileStyle)![1]);
    const badgeHeight = tile + Number(pad[1]) + Number(pad[2]);
    expect(reserved).toBeGreaterThanOrEqual(bottom + badgeHeight + 8);
  });

  it("is smaller than the default badge", () => {
    renderZaviBadge(false, true);
    const compact = document.getElementById("zavi-made-badge")!.getAttribute("style")!;
    const compactTile = document.getElementById("zavi-made-badge")!.querySelector("span")!.getAttribute("style")!;
    document.body.innerHTML = "";
    renderZaviBadge(false);
    const full = document.getElementById("zavi-made-badge")!.getAttribute("style")!;
    const fullTile = document.getElementById("zavi-made-badge")!.querySelector("span")!.getAttribute("style")!;
    const px = (re: RegExp, s: string) => Number(re.exec(s)![1]);
    expect(px(/font:600 (\d+)px/, compact)).toBeLessThan(px(/font:600 (\d+)px/, full));
    expect(px(/height:(\d+)px/, compactTile)).toBeLessThan(px(/height:(\d+)px/, fullTile));
    expect(px(/bottom:(\d+)px/, compact)).toBeLessThan(px(/bottom:(\d+)px/, full));
    expect(compact.indexOf("all:revert")).toBeLessThan(compact.indexOf("position:fixed"));
  });

  it("keeps no space when the key is off, so the default badge is unchanged", () => {
    renderZaviBadge(false);
    renderZaviBadge(false, false);
    expect(document.getElementById("zavi-badge-spacer")).toBeNull();
    const style = document.getElementById("zavi-made-badge")!.getAttribute("style")!;
    expect(style).toContain("bottom:16px !important");
    expect(style).toContain("padding:7px 14px 7px 7px");
  });

  it("removes the strip with the badge when the tenant hides it", () => {
    renderZaviBadge(false, true);
    expect(document.getElementById("zavi-badge-spacer")).not.toBeNull();
    renderZaviBadge(true, true);
    expect(document.getElementById("zavi-made-badge")).toBeNull();
    expect(document.getElementById("zavi-badge-spacer")).toBeNull();
  });

  it("never keeps space for a hidden or missing badge", () => {
    for (const v of [true, undefined, null] as const) {
      document.body.innerHTML = "";
      renderZaviBadge(v, true);
      expect(document.getElementById("zavi-badge-spacer")).toBeNull();
    }
  });

  it("the runtime hands the public route's badge_reserve flag to the badge, only on an explicit true", () => {
    expect(SRC).toContain("renderZaviBadge(j && j.badge_hidden, !!(j && j.badge_reserve === true));");
  });
});

describe("renderZaviBadge — a re-fetch that flips badge_reserve while the badge stays shown (DEL-1323 review)", () => {
  const isCompact = () => document.getElementById("zavi-made-badge")!.getAttribute("style")!.includes("bottom:12px !important");

  it("drops the strip and grows the badge back to full size when badge_reserve turns false", () => {
    renderZaviBadge(false, true);
    expect(document.getElementById("zavi-badge-spacer")).not.toBeNull();
    expect(isCompact()).toBe(true);
    renderZaviBadge(false, false);
    expect(document.getElementById("zavi-badge-spacer")).toBeNull();
    expect(document.querySelectorAll("#zavi-made-badge")).toHaveLength(1);
    expect(isCompact()).toBe(false);
  });

  it("adds the strip and shrinks an already shown full-size badge when badge_reserve turns true", () => {
    renderZaviBadge(false, false);
    expect(isCompact()).toBe(false);
    renderZaviBadge(false, true);
    expect(document.querySelectorAll("#zavi-badge-spacer")).toHaveLength(1);
    expect(document.querySelectorAll("#zavi-made-badge")).toHaveLength(1);
    expect(isCompact()).toBe(true);
  });

  it("keeps the same badge element when the state does not change", () => {
    renderZaviBadge(false, true);
    const first = document.getElementById("zavi-made-badge");
    renderZaviBadge(false, true);
    expect(document.getElementById("zavi-made-badge")).toBe(first);
  });
});
