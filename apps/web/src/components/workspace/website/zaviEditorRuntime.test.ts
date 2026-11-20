// @vitest-environment jsdom

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNTIME_SRC = readFileSync(resolve(process.cwd(), "public/zavi-editor-runtime.js"), "utf8");
const PARENT = "http://localhost:3000";

const PAGE = `
  <header>
    <span class="logo">ThreadVault</span>
    <nav>
      <a href="/shop">Shop</a>
      <a href="/about">About</a>
      <a href="/signin">Sign in</a>
    </nav>
    <button>Browse</button>
  </header>
  <main>
    <span class="badge">SUMMER DROP</span>
    <h1 class="hero">Considered clothes, made in small runs.</h1>
    <p class="sub">We source and cut a tight lineup of pieces.</p>
    <a class="cta" href="/shop">Shop the drop</a>
    <img class="hero-img" alt="Atelier Linen Shirt" src="/img/shirt.jpg" />
  </main>
  <footer>
    <p class="tagline">Small-batch clothing, cut with care and made to last.</p>
  </footer>`;

type Posted = Record<string, unknown>;
const posted: Posted[] = [];

beforeAll(() => {
  Object.defineProperty(window, "parent", {
    value: { postMessage: (m: Posted) => posted.push(m) },
    configurable: true,
  });
  Object.defineProperty(document, "referrer", { value: PARENT, configurable: true });
  document.body.innerHTML = PAGE;
  // eslint-disable-next-line no-eval
  (0, eval)(RUNTIME_SRC);
});

beforeEach(() => {
  posted.length = 0;
  document.body.innerHTML = PAGE;
});

function send(data: Posted) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: PARENT }));
}
const OUTLINE_REQUEST = "zavi:editor-outline-request";
const OUTLINE = "zavi:editor-outline";
const APPLY = "zavi:editor-apply";
const APPLIED = "zavi:editor-applied";
type OutlineEl = { selector: string; tag: string; text: string };
function requestOutline(): OutlineEl[] {
  send({ type: OUTLINE_REQUEST });
  const msg = posted.find((m) => m.type === OUTLINE);
  return (msg?.elements as OutlineEl[]) ?? [];
}
function apply(selector: string, patch: Posted): boolean | undefined {
  send({ type: APPLY, selector, patch, reveal: true });
  const ack = posted.find((m) => m.type === APPLIED);
  return ack?.ok as boolean | undefined;
}

describe("editor runtime — page outline (what the AI can target)", () => {
  it("lists the editable leaves + links + image, and EXCLUDES containers", () => {
    const outline = requestOutline();
    const texts = outline.map((e) => e.text);
    expect(texts).toContain("Considered clothes, made in small runs.");
    expect(texts).toContain("Small-batch clothing, cut with care and made to last.");
    expect(texts).toContain("Shop the drop");
    expect(outline.some((e) => e.tag === "img")).toBe(true);
    expect(outline.some((e) => e.text === "Shop")).toBe(true);
    expect(outline.every((e) => !["header", "main", "footer", "nav"].includes(e.tag))).toBe(true);
  });
});

describe("editor runtime — diverse end-user edit requests actually change the DOM", () => {
  it('"change the heading to …" → the hero text changes + ack ok', () => {
    const ok = apply("h1.hero", { text: "Clothes worth keeping." });
    expect(document.querySelector("h1.hero")?.textContent).toBe("Clothes worth keeping.");
    expect(ok).toBe(true);
  });

  it('"change the footer tagline to …" → the footer text changes', () => {
    apply("footer p", { text: "Made to last." });
    expect(document.querySelector("footer p")?.textContent).toBe("Made to last.");
  });

  it('"make the shop button navy" → the CTA colour changes', () => {
    apply("a.cta", { style: { color: "#0a2540" } });
    expect((document.querySelector("a.cta") as HTMLElement).style.color).toBeTruthy();
  });

  it('"point the Shop link at google" → the link href changes', () => {
    apply("nav a", { attrs: { href: "https://google.com" } });
    expect(document.querySelector("nav a")?.getAttribute("href")).toBe("https://google.com");
  });

  it('"swap the hero image" → the image src changes', () => {
    apply("img.hero-img", { attrs: { src: "https://cdn.example.com/new.jpg" } });
    expect(document.querySelector("img.hero-img")?.getAttribute("src")).toBe(
      "https://cdn.example.com/new.jpg",
    );
  });

  it("round-trip: the selector the OUTLINE gives is the one APPLY can change", () => {
    const outline = requestOutline();
    const hero = outline.find((e) => e.text.startsWith("Considered clothes"));
    expect(hero).toBeTruthy();
    posted.length = 0;
    const ok = apply(hero!.selector, { text: "Round-tripped." });
    expect(ok).toBe(true);
    expect(document.querySelector(hero!.selector)?.textContent).toBe("Round-tripped.");
  });
});

describe("editor runtime — honest failure (why an edit may 'not affect')", () => {
  it("a selector that no longer exists on the page → NO change + ack ok:false", () => {
    const ok = apply(".was-removed-in-a-rebuild", { text: "X" });
    expect(ok).toBe(false);
  });

  it("a CONTAINER (has children) is never text-wiped, even if targeted", () => {
    apply("header", { text: "boom" });
    expect(document.querySelector("header .logo")?.textContent).toBe("ThreadVault");
    expect(document.querySelectorAll("header nav a").length).toBe(3);
  });

  it("a malicious style value is dropped (no url()/javascript:)", () => {
    apply("a.cta", { style: { color: "url(javascript:alert(1))" } });
    const cssText = (document.querySelector("a.cta") as HTMLElement).style.cssText;
    expect(cssText).not.toContain("javascript");
    expect(cssText).not.toContain("url(");
  });
});
