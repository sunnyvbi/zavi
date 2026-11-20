// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../WorkspaceShell", () => ({ useWorkspace: () => ({}) }));
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LookPicker, BUILD_WITH_LOOK, PICK_FIRST, STARTING_BUILD, lookStartedLine } from "./LookPicker";
import { resetSharedSiteDesigns } from "@/lib/workspace/useSiteDesign";
import { LookPreview, escapeHtml, lookPreviewDoc, safeThemeCss } from "./LookPreview";
import { swatchThemeCss, websiteVariantDoc } from "./WebsiteVariant";
import type { SiteDesign, SiteDesignLook, SiteDesignPreview } from "@/lib/workspace/useSiteDesign";

const RUN = "33333333-3333-4333-8333-333333333333";

const THEME = `@import url("https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&display=swap");
:root {
  --background: 255 255 255;
  --primary: 34 85 170;
  --font-display: "Fraunces", serif;
}
.surface-inverse {
  --background: 17 17 17;
}`;

const PREVIEW: SiteDesignPreview = {
  name: "Lumen Studio",
  eyebrow: "Couples planning a wedding",
  headline: "Photographs that feel like the day did",
  subtitle: "Calm, candid wedding photography.",
  primary_action: "Send an enquiry",
  sections: [
    { title: "Gallery", body: "Recent weddings" },
    { title: "Packages", body: "Three ways to book" },
    { title: "About", body: "Who shoots your day" },
  ],
};

function look(id: string, over: Partial<SiteDesignLook> = {}): SiteDesignLook {
  return {
    id,
    label: `${id[0]!.toUpperCase()}${id.slice(1)} look`,
    mood: `${id} mood`,
    recommended: id === "brand",
    fonts: { display: "Fraunces", body: "Inter" },
    swatches: { background: "#ffffff", foreground: "#111111", primary: "#2255aa", accent: "#ddeeff", muted: "#f3f3f3" },
    radius: "0.5rem",
    theme_css: THEME,
    preview: PREVIEW,
    ...over,
  };
}

function design(over: Partial<SiteDesign> = {}): SiteDesign {
  return {
    run_id: RUN,
    awaiting_pick: true,
    preview: PREVIEW,
    source: "model",
    looks: [look("brand"), look("luxe"), look("studio")],
    chosen: "brand",
    applied: "brand",
    locked: null,
    plan: { audience: null, positioning: null, tone: null, main_action: null, sections: [], pages: [], facts: [] },
    checklist: null,
    ...over,
  };
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

afterEach(() => {
  cleanup();
  resetSharedSiteDesigns();
  vi.useRealTimers();
  document.head.querySelectorAll("link[data-zavi-look-fonts]").forEach((l) => l.remove());
});

describe("lookPreviewDoc", () => {
  it.each(["split", "centered", "editorial", "bold", "minimal"] as const)("renders the %s layout sample", (layout) => {
    const doc = new DOMParser().parseFromString(lookPreviewDoc(THEME, PREVIEW, layout), "text/html");
    expect(doc.body.dataset.layout).toBe(layout);
    expect(doc.querySelectorAll(".image-slot")).toHaveLength(layout === "split" ? 1 : layout === "minimal" ? 3 : 0);
  });

  it("draws a look's own structure: its hero variant and its sections in order, each as its component and variant", () => {
    const structured: SiteDesignPreview = {
      ...PREVIEW,
      hero_variant: "editorial",
      sections: [
        { title: "Kind words", body: "Couples on their day", kind: "Testimonials", variant: "quote" },
        { title: "Work", body: "Recent weddings", kind: "Gallery", variant: "feature" },
        { title: "Book", body: "Hold your date", kind: "CTA", variant: "banner" },
        { title: "Extra", body: "Not drawn", kind: "FAQ" },
      ],
    };
    const doc = parse(lookPreviewDoc(THEME, structured, "editorial"));
    expect(doc.body.dataset.hero).toBe("editorial");
    expect(Array.from(doc.querySelectorAll("section.sec")).map((s) => (s as HTMLElement).dataset.kind)).toEqual(["Testimonials", "Gallery"]);
    expect(doc.querySelector(".quote")!.textContent).toBe("Couples on their day");
    expect(doc.querySelectorAll(".feature .image-slot")).toHaveLength(3);
    expect(doc.querySelector(".cta")).toBeNull();
    const other = parse(lookPreviewDoc(THEME, { ...structured, hero_variant: "split", sections: [{ ...structured.sections[1]!, variant: "grid" }] }, "split"));
    expect(other.body.dataset.hero).toBe("split");
    expect(other.querySelectorAll(".hero .image-slot")).toHaveLength(1);
    expect(other.querySelectorAll(".row .image-slot")).toHaveLength(3);
  });

  it("a structured preview keeps hostile text inert, and an unknown hero variant falls back to the layout's", () => {
    const evil = `<img src=x onerror=1>`;
    const doc = parse(
      lookPreviewDoc(THEME, { ...PREVIEW, hero_variant: `x" onload="1`, sections: [{ title: evil, body: evil, kind: "Testimonials", variant: "quote" }, { title: evil, body: evil, kind: "Stats" }] }, "bold"),
    );
    expect(doc.querySelectorAll("img, script")).toHaveLength(0);
    expect(doc.querySelectorAll("[onerror], [onload]")).toHaveLength(0);
    expect(doc.body.dataset.hero).toBe("image");
    expect(doc.querySelector(".quote")!.textContent).toBe(evil);
  });

  it("renders hostile preview text as inert text, never as markup or attributes", () => {
    const hostile: SiteDesignPreview = {
      name: `<script>parent.pwned=1</script>Acme`,
      eyebrow: `"><img src=x onerror="parent.pwned=1">`,
      headline: `</h1><iframe src="javascript:parent.pwned=1"></iframe>`,
      subtitle: `It's "quoted" & <b>bold</b>`,
      primary_action: `' onmouseover='parent.pwned=1`,
      sections: [{ title: `<style>body{display:none}</style>`, body: `</p><script>x()</script>` }],
    };
    const doc = parse(lookPreviewDoc(THEME, hostile));
    expect(doc.querySelectorAll("script")).toHaveLength(0);
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    expect(doc.querySelectorAll("iframe")).toHaveLength(0);
    expect(doc.querySelectorAll("b")).toHaveLength(0);
    expect(doc.querySelectorAll("style")).toHaveLength(2);
    expect(doc.querySelectorAll("[onerror], [onmouseover]")).toHaveLength(0);
    expect(doc.querySelector(".brand")!.textContent).toBe(hostile.name);
    expect(doc.querySelector(".eyebrow")!.textContent).toBe(hostile.eyebrow);
    expect(doc.querySelector("h1")!.textContent).toBe(hostile.headline);
    expect(doc.querySelector(".subtitle")!.textContent).toBe(hostile.subtitle);
    expect(doc.querySelector(".card h3")!.textContent).toBe(hostile.sections[0]!.title);
    expect(doc.querySelector(".card p")!.textContent).toBe(hostile.sections[0]!.body);
    expect(Array.from(doc.querySelectorAll(".btn-primary")).every((b) => b.textContent === hostile.primary_action)).toBe(true);
  });

  it("keeps a </style> inside theme_css from closing the style element", () => {
    const evil = `:root{--primary: 1 2 3}</style><script>parent.pwned=1</script><style>body{}</STYLE ><img src=x onerror=1>`;
    const doc = parse(lookPreviewDoc(evil, PREVIEW));
    expect(doc.querySelectorAll("script")).toHaveLength(0);
    expect(doc.querySelectorAll("img")).toHaveLength(0);
    const styles = doc.querySelectorAll("style");
    expect(styles).toHaveLength(2);
    expect(styles[0]!.textContent).toContain(":root{--primary: 1 2 3}");
    expect(styles[0]!.textContent).not.toContain("<");
    expect(doc.querySelector("h1")!.textContent).toBe(PREVIEW.headline);
  });

  it("carries the theme verbatim, scopes the page with a no-script CSP and draws every planned part", () => {
    const html = lookPreviewDoc(THEME, PREVIEW);
    const doc = parse(html);
    expect(doc.querySelectorAll("style")[0]!.textContent).toBe(THEME);
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(doc.querySelectorAll(".card")).toHaveLength(3);
    expect(doc.querySelector(".band.surface-inverse")).not.toBeNull();
    expect(Array.from(doc.querySelectorAll(".links span")).map((s) => s.textContent)).toEqual(["Gallery", "Packages", "About"]);
  });

  it("escapeHtml and safeThemeCss neutralise every character that can open markup", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    expect(safeThemeCss("a</style>b<!--c")).not.toContain("<");
  });

  it("LookPreview mounts a sandboxed iframe with no script permission and the document as srcdoc", () => {
    render(<LookPreview label="Brand look" themeCss={THEME} preview={PREVIEW} />);
    const frame = screen.getByTitle("Preview of the Brand look look") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toBe(lookPreviewDoc(THEME, PREVIEW));
  });
});

describe("LookPicker", () => {
  it("shows three websites, numbered, with one Recommended badge and the plain name once, never the mood or a font swatch", () => {
    const onStart = vi.fn();
    render(<LookPicker design={design()} starting={null} started={null} startError={null} onStart={onStart} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    expect(screen.getAllByTestId("website-variant")).toHaveLength(3);
    expect(screen.getAllByText("Recommended")).toHaveLength(1);
    expect(radios.map((r) => r.querySelector("p")!.textContent)).toEqual(["Website 1", "Website 2", "Website 3"]);
    expect(screen.getAllByTestId("website-name").map((n) => n.textContent)).toEqual(["Brand look", "Luxe look", "Studio look"]);
    expect(radios[0]!.textContent).toContain("Recommended");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["Website 1: Brand look (recommended)", "Website 2: Luxe look", "Website 3: Studio look"]);
    const text = screen.getByTestId("look-picker").textContent!;
    expect(text).not.toMatch(/mood/);
    expect(text).not.toContain("Aa Bb");
    expect(screen.queryAllByTestId("look-swatch")).toHaveLength(0);
    expect(text).not.toMatch(/sample of your home page|final wording|timer/i);
    expect(screen.getByText(PICK_FIRST).textContent).toBe("Pick a website to start your build.");
    const build = screen.getByTestId("look-build") as HTMLButtonElement;
    expect(build.textContent).toBe(BUILD_WITH_LOOK);
    expect(build.disabled).toBe(true);
    fireEvent.click(build);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("never starts a build on its own and shows no timer, even with a server deadline long past", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    try {
      const onStart = vi.fn();
      const stale = { ...design(), look_deadline_at: new Date(Date.now() - 60_000).toISOString(), look_deadline_in_ms: 0, look_wait_s: 30 } as unknown as SiteDesign;
      render(<LookPicker design={stale} starting={null} started={null} startError={null} onStart={onStart} />);
      const noTimer = () => {
        expect(screen.queryByTestId("look-countdown")).toBeNull();
        expect(screen.queryByRole("timer")).toBeNull();
        expect(screen.getByTestId("look-picker").textContent).not.toMatch(/starts in|starting “|\d+s\b|timer/i);
      };
      noTimer();
      act(() => {
        vi.advanceTimersByTime(10 * 60_000);
      });
      expect(onStart).not.toHaveBeenCalled();
      expect(screen.getByTestId("look-picker").getAttribute("data-state")).toBe("picking");
      noTimer();
      fireEvent.click(screen.getByTestId("look-tile-luxe"));
      expect(screen.getByTestId("look-picker").textContent).toContain("Previewing “Luxe look”. Build with it when you're ready.");
      act(() => {
        vi.advanceTimersByTime(60 * 60_000);
      });
      expect(onStart).not.toHaveBeenCalled();
      noTimer();
      fireEvent.click(screen.getByTestId("look-build"));
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(onStart).toHaveBeenCalledWith("luxe");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a tile click only selects; arrows move the selection without starting; the button starts the selected look", () => {
    const onStart = vi.fn();
    render(<LookPicker design={design()} starting={null} started={null} startError={null} onStart={onStart} />);
    fireEvent.click(screen.getByTestId("look-tile-luxe"));
    expect(screen.getByTestId("look-tile-luxe").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("look-tile-brand").getAttribute("aria-checked")).toBe("false");
    fireEvent.keyDown(screen.getByTestId("look-tile-luxe"), { key: "ArrowRight" });
    expect(screen.getByTestId("look-tile-studio").getAttribute("aria-checked")).toBe("true");
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("look-build"));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith("studio");
  });

  it("calls onStart once when the button is hit twice before the parent re-renders", () => {
    const onStart = vi.fn();
    render(<LookPicker design={design()} starting={null} started={null} startError={null} onStart={onStart} />);
    fireEvent.click(screen.getByTestId("look-tile-brand"));
    const build = screen.getByTestId("look-build");
    act(() => {
      build.click();
      build.click();
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  function FailingParent({ posts, returnPromise }: { posts: string[]; returnPromise: boolean }) {
    const [starting, setStarting] = useState<string | null>(null);
    const [startError, setStartError] = useState<string | null>(null);
    const onStart = (lookId: string) => {
      posts.push(lookId);
      setStarting(lookId);
      setStartError(null);
      const done = Promise.resolve().then(() => {
        setStarting(null);
        setStartError("We could not start your build. Try again.");
      });
      return returnPromise ? done : undefined;
    };
    return <LookPicker design={design()} starting={starting} started={null} startError={startError} onStart={onStart} />;
  }

  it("a start that fails before the parent re-renders still lets the founder retry", async () => {
    const posts: string[] = [];
    render(<FailingParent posts={posts} returnPromise={false} />);
    fireEvent.click(screen.getByTestId("look-tile-luxe"));
    await act(async () => {
      screen.getByTestId("look-build").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(posts).toEqual(["luxe"]);
    expect(screen.getByRole("alert").textContent).toMatch(/could not start/);
    await act(async () => {
      screen.getByTestId("look-build").click();
      await Promise.resolve();
    });
    expect(posts).toEqual(["luxe", "luxe"]);
  });

  it("repeated identical fast failures never block the next retry when onStart returns its promise", async () => {
    const posts: string[] = [];
    render(<FailingParent posts={posts} returnPromise />);
    fireEvent.click(screen.getByTestId("look-tile-studio"));
    for (let i = 1; i <= 3; i++) {
      await act(async () => {
        screen.getByTestId("look-build").click();
        for (let j = 0; j < 4; j++) await Promise.resolve();
      });
      expect(posts).toHaveLength(i);
    }
  });

  it("a brief with no plan: three distinct mini websites in the site's name, each a full landing page in its own layout", () => {
    const sample = (hero_variant: string, section: SiteDesignPreview["sections"][number]): SiteDesignPreview => ({
      name: "Crumb & Co",
      eyebrow: "Warm and crafted",
      headline: "Welcome to Crumb & Co",
      subtitle: "",
      primary_action: "Get in touch",
      hero_variant,
      sections: [section],
    });
    const d = design({
      preview: null,
      looks: [
        look("brand", { layout: "split", preview: sample("split", { title: "What we offer", body: "What Crumb & Co offers", kind: "Features", variant: "alternating" }) }),
        look("luxe", { layout: "editorial", preview: sample("editorial", { title: "Kind words", body: "Why people choose Crumb & Co", kind: "Testimonials", variant: "quote", tone: "muted" }) }),
        look("studio", {
          layout: "bold",
          theme_css: null,
          swatches: { background: "#0b0b0f", foreground: "#f5f5f5", primary: "#c6ff00", accent: "#333333", muted: "#1a1a1a" },
          preview: sample("image", { title: "At a glance", body: "Crumb & Co in numbers", kind: "Stats", tone: "inverse" }),
        }),
      ],
    });
    render(<LookPicker design={d} starting={null} started={null} startError={null} onStart={vi.fn()} />);
    expect(screen.queryAllByTestId("look-swatch")).toHaveLength(0);
    const variants = screen.getAllByTestId("website-variant");
    expect(variants.map((v) => v.dataset.layout)).toEqual(["split", "editorial", "bold"]);
    const docs = variants.map((v) => parse(v.querySelector("iframe")!.getAttribute("srcdoc")!));
    for (const doc of docs) {
      expect(doc.querySelector("header.nav .brand")!.textContent).toBe("Crumb & Co");
      expect(doc.querySelector(".hero h1")!.textContent).toBe("Welcome to Crumb & Co");
      expect(doc.querySelector(".hero .eyebrow")!.textContent).toBe("Warm and crafted");
      expect(doc.querySelector(".hero .btn-primary")!.textContent).toBe("Get in touch");
      expect(doc.querySelectorAll("section.features .feature")).toHaveLength(3);
      expect(doc.querySelector("section.band")).not.toBeNull();
      expect(doc.querySelector("footer.footer .brand")!.textContent).toBe("Crumb & Co");
    }
    expect(docs.map((doc) => doc.body.dataset.hero)).toEqual(["split", "editorial", "image"]);
    expect(docs.map((doc) => doc.body.dataset.layout)).toEqual(["split", "editorial", "bold"]);
    expect(docs.map((doc) => (doc.querySelector("section.features") as HTMLElement).dataset.style)).toEqual(["cards", "numbered", "solid"]);
    expect(docs.map((doc) => (doc.querySelector("section.band") as HTMLElement).dataset.kind)).toEqual(["cta", "quote", "cta"]);
    expect(docs[0]!.querySelectorAll(".hero .panel")).toHaveLength(1);
    expect(docs[0]!.querySelector(".feature h3")!.textContent).toBe("What we offer");
    expect(docs[1]!.querySelector(".band h2")!.textContent).toBe("Why people choose Crumb & Co");
    expect(Array.from(docs[1]!.querySelectorAll(".feature h3")).map((h) => h.textContent)).toEqual(["What we offer", "How it works", "Why choose us"]);
    expect(docs[0]!.querySelectorAll("style")[0]!.textContent).toBe(THEME);
    expect(docs[2]!.querySelectorAll("style")[0]!.textContent).toContain("--primary: 198 255 0;");
    expect(docs[2]!.querySelectorAll("style")[0]!.textContent).toContain("--background: 11 11 15;");
    expect(new Set(docs.map((doc) => doc.documentElement.outerHTML)).size).toBe(3);
  });

  it("every look is a website even with no theme_css or no preview: its swatches, fonts and radius become the page's theme", () => {
    const d = design({
      preview: null,
      looks: [look("brand", { theme_css: null, radius: "1rem", fonts: { display: "Playfair Display", body: "Lato" } }), look("luxe", { preview: null }), look("studio")],
    });
    render(<LookPicker design={d} starting={null} started={null} startError={null} onStart={vi.fn()} />);
    expect(screen.getAllByTestId("website-variant")).toHaveLength(3);
    expect(screen.queryAllByTestId("look-swatch")).toHaveLength(0);
    const brand = parse(screen.getByTestId("look-tile-brand").querySelector("iframe")!.getAttribute("srcdoc")!);
    const theme = brand.querySelectorAll("style")[0]!.textContent!;
    expect(theme).toContain("--primary: 34 85 170;");
    expect(theme).toContain("--primary-foreground: 255 255 255;");
    expect(theme).toContain("--radius: 1rem;");
    expect(theme).toContain(`--font-display: "Playfair Display"`);
    expect(theme).toContain("https://fonts.googleapis.com/css2?family=Lato:wght@400;700&family=Playfair+Display:wght@400;700&display=swap");
    expect(brand.querySelector("h1")!.textContent).toBe(PREVIEW.headline);
    const luxe = parse(screen.getByTestId("look-tile-luxe").querySelector("iframe")!.getAttribute("srcdoc")!);
    expect(luxe.querySelector(".nav .brand")!.textContent).toBe("Your business");
    expect(luxe.querySelector("h1")!.textContent).toBe("Your new website");
    expect(luxe.querySelectorAll(".feature")).toHaveLength(3);
    expect(luxe.querySelector("footer.footer")).not.toBeNull();
  });

  it("a website page keeps hostile text inert and a </style> in the theme from closing its style element", () => {
    const evil = `<img src=x onerror=1>`;
    const hostile = look("brand", {
      theme_css: `:root{--primary: 1 2 3}</style><script>parent.pwned=1</script>`,
      radius: `1rem;}</style><script>x()</script>`,
      preview: {
        name: `<script>parent.pwned=1</script>Acme`,
        eyebrow: `"><img src=x onerror="parent.pwned=1">`,
        headline: `</h1><iframe src="javascript:parent.pwned=1"></iframe>`,
        primary_action: `' onmouseover='parent.pwned=1`,
        sections: [{ title: evil, body: evil, kind: "Testimonials", variant: "quote" }, { title: evil, body: evil }],
      },
    });
    const doc = parse(websiteVariantDoc(hostile, hostile.preview!));
    expect(doc.querySelectorAll("script, img, iframe")).toHaveLength(0);
    expect(doc.querySelectorAll("[onerror], [onmouseover]")).toHaveLength(0);
    expect(doc.querySelectorAll("style")).toHaveLength(2);
    expect(doc.querySelector(".nav .brand")!.textContent).toBe(hostile.preview!.name);
    expect(doc.querySelector("h1")!.textContent).toBe(hostile.preview!.headline);
    expect(doc.querySelector(".band h2")!.textContent).toBe(evil);
    expect(doc.querySelector(".feature h3")!.textContent).toBe(evil);
    const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute("content")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    const swatchDoc = parse(websiteVariantDoc({ ...hostile, theme_css: null }, hostile.preview!));
    expect(swatchDoc.querySelectorAll("script")).toHaveLength(0);
    expect(swatchThemeCss({ ...hostile, theme_css: null })).toContain("--radius: 0.5rem;");
  });

  it("uses the design's shared preview when a look carries none", () => {
    render(
      <LookPicker design={design({ looks: [look("brand", { preview: null })] })} starting={null} started={null} startError={null} onStart={vi.fn()} />,
    );
    expect(screen.getByTestId("look-tile-brand").querySelector("iframe")).not.toBeNull();
  });

  it("while starting, locks the tiles and the button", () => {
    render(<LookPicker design={design()} starting="luxe" started={null} startError={null} onStart={vi.fn()} />);
    const build = screen.getByTestId("look-build") as HTMLButtonElement;
    expect(build.disabled).toBe(true);
    expect(build.textContent).toBe(STARTING_BUILD);
    expect(screen.getAllByRole("radio").every((r) => (r as HTMLButtonElement).disabled)).toBe(true);
  });

  it("once started, shows the look it builds in and no button", () => {
    render(<LookPicker design={design({ awaiting_pick: false })} starting={null} started="luxe" startError={null} onStart={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe(lookStartedLine("Luxe look"));
    expect(screen.queryByTestId("look-build")).toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByTestId("look-tile-luxe").getAttribute("aria-checked")).toBe("true");
  });

  it("shows the start error under the tiles", () => {
    render(<LookPicker design={design()} starting={null} started={null} startError="Nope." onStart={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe("Nope.");
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });
});

describe("the build starts only from an explicit pick", () => {
  const props = { starting: null, started: null, startError: null };

  it("previewing a website never commits it when the server deadline expires", () => {
    vi.useFakeTimers();
    try {
      const onStart = vi.fn();
      const stale = { ...design(), look_deadline_at: new Date(Date.now() + 5_000).toISOString(), look_deadline_in_ms: 5_000 } as unknown as SiteDesign;
      render(<LookPicker design={stale} {...props} onStart={onStart} />);
      expect(screen.getByText(PICK_FIRST)).toBeTruthy();
      fireEvent.click(screen.getByTestId("look-tile-studio"));
      expect(screen.queryByText(PICK_FIRST)).toBeNull();
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(onStart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("nothing selected never starts a build", () => {
    vi.useFakeTimers();
    try {
      const onStart = vi.fn();
      render(<LookPicker design={design()} {...props} onStart={onStart} />);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(onStart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("every picker for the run shows the same selection (preview pane and chat card)", () => {
    const d = design();
    render(
      <>
        <LookPicker design={d} {...props} onStart={vi.fn()} wide />
        <LookPicker design={d} {...props} onStart={vi.fn()} />
      </>,
    );
    expect(screen.getAllByText(PICK_FIRST)).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("look-tile-luxe")[0]!);
    expect(screen.getAllByTestId("look-tile-luxe").map((t) => t.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    expect(screen.queryAllByText(PICK_FIRST)).toHaveLength(0);
  });
});

describe("LookPicker auto start countdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts down to the recommended website by the second, and says it is starting at zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-30T10:00:15.000Z"));
    render(<LookPicker design={design({ auto_start_at: "2026-10-30T10:01:00.000Z" })} starting={null} started={null} startError={null} onStart={vi.fn()} />);
    expect(screen.getByTestId("look-auto-start").textContent).toBe("Starting with “Brand look” in 0:45");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("look-auto-start").textContent).toBe("Starting with “Brand look” in 0:44");
    act(() => {
      vi.advanceTimersByTime(44_000);
    });
    expect(screen.getByTestId("look-auto-start").textContent).toBe("Starting with “Brand look”…");
  });

  it("names the recommended website even when another is listed first or selected", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-10-30T10:00:00.000Z"));
    const looks = [look("luxe", { recommended: false }), look("brand", { recommended: true }), look("studio", { recommended: false })];
    render(<LookPicker design={design({ looks, auto_start_at: "2026-10-30T10:01:00.000Z" })} starting={null} started={null} startError={null} onStart={vi.fn()} />);
    fireEvent.click(screen.getByTestId("look-tile-studio"));
    expect(screen.getByTestId("look-auto-start").textContent).toBe("Starting with “Brand look” in 1:00");
  });

  it("no countdown without a start time, once the build is starting, or when nothing waits on a pick", () => {
    const { rerender } = render(<LookPicker design={design({ auto_start_at: null })} starting={null} started={null} startError={null} onStart={vi.fn()} />);
    expect(screen.queryByTestId("look-auto-start")).toBeNull();
    const at = new Date(Date.now() + 30_000).toISOString();
    rerender(<LookPicker design={design({ auto_start_at: at })} starting="luxe" started={null} startError={null} onStart={vi.fn()} />);
    expect(screen.queryByTestId("look-auto-start")).toBeNull();
    rerender(<LookPicker design={design({ awaiting_pick: false, auto_start_at: at })} starting={null} started={null} startError={null} onStart={vi.fn()} />);
    expect(screen.queryByTestId("look-auto-start")).toBeNull();
  });

  it("picking before the countdown ends starts the build at once on that website", () => {
    const onStart = vi.fn();
    render(<LookPicker design={design({ auto_start_at: new Date(Date.now() + 50_000).toISOString() })} starting={null} started={null} startError={null} onStart={onStart} />);
    fireEvent.click(screen.getByTestId("look-tile-luxe"));
    fireEvent.click(screen.getByTestId("look-build"));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith("luxe");
  });
});
