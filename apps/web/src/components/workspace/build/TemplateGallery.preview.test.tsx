// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TemplateGallery, TEMPLATES_PREVIEW_BACK, TEMPLATES_USE, type UsedTemplate } from "./TemplateGallery";
import { readWireframeTokens, templateHue, templateWireframeCss } from "./templateWireframe";
import { resetSiteTemplatesCache } from "@/lib/workspace/siteTemplates";

const THEME = ":root { --background: 255 255 255; --inverse: 31 35 40; }";
const PREVIEW = {
  name: "Your business",
  headline: "Hello",
  hero_variant: "image",
  sections: [
    { title: "Services", body: "What we offer", kind: "Features", variant: "cards" },
    { title: "Reviews", body: "What people say", kind: "Testimonials", tone: "inverse" },
  ],
};
const card = (id: string, label: string, idea: string) => ({
  id,
  label,
  blurb: `${label} blurb`,
  good_for: "Anyone",
  idea,
  layout: "split",
  fonts: { display: "DM Sans", body: "Inter" },
  theme_css: THEME,
  preview: PREVIEW,
});
const CAFE_IDEA = "A website for my [café, restaurant or bakery] called [name] in [town]. People in [town] can order ahead.";
const PLAIN_IDEA = "A simple one-page site that says what we do and how to reach us.";
const CATALOG = {
  templates: [card("menu-and-hours", "Menu and opening hours", CAFE_IDEA), card("plain-page", "Plain page", PLAIN_IDEA)],
};

const LIGHT = { cream: "247 246 243", bone: "228 225 216", ink: "25 25 25", inkMuted: "120 114 104", rule: "216 212 200" };
const DARK = { cream: "20 20 20", bone: "43 43 43", ink: "236 236 236", inkMuted: "154 154 154", rule: "56 56 56" };
const CATALOG_IDS = ["book-a-service", "menu-and-hours", "portfolio", "product-launch", "professional-services", "classes-and-events", "community"];

function dialogBox() {
  return screen.getByRole("dialog");
}
function tabbables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>("button, input, textarea, a[href]")).filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !el.closest("[aria-hidden='true']"),
  );
}
async function open() {
  const onUse = vi.fn<[UsedTemplate], void>();
  render(<TemplateGallery selectedId={null} onUse={onUse} />);
  const trigger = screen.getByTestId("templates-open");
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByTestId("template-menu-and-hours");
  return { onUse, trigger };
}
function heroCss(css: string) {
  return /\.hero\{background:rgb\(([\d ]+)\)/.exec(css)?.[1] ?? null;
}

beforeEach(() => {
  resetSiteTemplatesCache();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => CATALOG })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const v of ["--c-cream", "--c-bone", "--c-ink", "--c-ink-muted", "--c-rule"]) document.documentElement.style.removeProperty(v);
});

describe("template preview", () => {
  it("opens a larger render from the card, and Use this template there walks the same steps and hands over the same template as clicking the card", async () => {
    const viaCard = await open();
    fireEvent.click(screen.getByTestId("template-plain-page"));
    fireEvent.click(within(dialogBox()).getByRole("button", { name: TEMPLATES_USE }));
    const cardResult = viaCard.onUse.mock.calls[0]![0];
    cleanup();
    resetSiteTemplatesCache();

    const { onUse } = await open();
    fireEvent.click(screen.getByTestId("template-menu-and-hours"));
    const idea = () => screen.getByTestId("template-idea-preview");
    const current = () => idea().querySelector("[data-current='true']")!;
    expect(current().getAttribute("data-idea-blank")).toBe("empty");
    fireEvent.change(within(dialogBox()).getByRole("textbox"), { target: { value: "café" } });
    expect(current().textContent).toBe("café");
    expect(current().getAttribute("data-idea-blank")).toBe("filled");
    expect(idea().querySelectorAll("[data-idea-blank='filled']")).toHaveLength(1);
    fireEvent.click(within(dialogBox()).getByRole("button", { name: "All templates" }));

    fireEvent.click(screen.getByRole("button", { name: "Preview Plain page" }));
    expect(screen.getByRole("dialog", { name: "Plain page" })).toBeTruthy();
    const panel = screen.getByTestId("template-preview-panel");
    expect(within(panel).getByTestId("look-preview")).toBeTruthy();
    expect(within(panel).getByRole("list", { name: "Sections" }).textContent).toBe("ServicesReviews");
    expect(screen.queryByTestId("template-menu-and-hours")).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
    const use = within(panel).getByRole("button", { name: TEMPLATES_USE });
    expect(document.activeElement).toBe(use);

    fireEvent.click(use);
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.queryByTestId("template-preview-panel")).toBeNull();
    expect(within(dialogBox()).queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("template-filled-idea").textContent).toBe(PLAIN_IDEA);
    fireEvent.click(within(dialogBox()).getByRole("button", { name: TEMPLATES_USE }));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse.mock.calls[0]![0]).toEqual(cardResult);
    expect(onUse.mock.calls[0]![0].template.id).toBe("plain-page");
  });

  it("Use this template on a template with blanks starts its questions with empty answers, like a card click", async () => {
    const { onUse } = await open();
    fireEvent.click(screen.getByTestId("template-menu-and-hours"));
    fireEvent.change(within(dialogBox()).getByRole("textbox"), { target: { value: "bakery" } });
    fireEvent.click(within(dialogBox()).getByRole("button", { name: "All templates" }));
    fireEvent.click(screen.getByTestId("template-preview-menu-and-hours"));
    fireEvent.click(within(screen.getByTestId("template-preview-panel")).getByRole("button", { name: TEMPLATES_USE }));
    expect(screen.getByTestId("template-step-progress").textContent).toBe("1 of 3");
    const box = within(dialogBox()).getByRole("textbox") as HTMLInputElement;
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
    expect(onUse).not.toHaveBeenCalled();
  });

  it("Escape and Back close only the preview and return focus to its Preview button; Escape again and Close end the dialog without using anything", async () => {
    const { onUse, trigger } = await open();
    const previewButton = () => screen.getByTestId("template-preview-plain-page");

    fireEvent.click(previewButton());
    const esc = new Event("cancel", { cancelable: true });
    fireEvent(dialogBox(), esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(screen.queryByTestId("template-preview-panel")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Start from a template" }).hasAttribute("open")).toBe(true);
    expect(document.activeElement).toBe(previewButton());

    fireEvent.click(previewButton());
    fireEvent.click(within(dialogBox()).getByRole("button", { name: TEMPLATES_PREVIEW_BACK }));
    expect(screen.queryByTestId("template-preview-panel")).toBeNull();
    expect(document.activeElement).toBe(previewButton());

    fireEvent(dialogBox(), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId("template-preview-menu-and-hours"));
    fireEvent.click(within(dialogBox()).getByRole("button", { name: "Close templates" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
  });

  it("the keyboard reaches Preview right after its card, and it shows when focused", async () => {
    await open();
    const order = tabbables(dialogBox());
    for (const t of CATALOG.templates) {
      const cardButton = screen.getByTestId(`template-${t.id}`);
      const preview = screen.getByTestId(`template-preview-${t.id}`);
      expect(preview.tagName).toBe("BUTTON");
      expect(preview.getAttribute("aria-label")).toBe(`Preview ${t.label}`);
      expect(cardButton.contains(preview)).toBe(false);
      expect(order.indexOf(preview)).toBe(order.indexOf(cardButton) + 1);
      expect(preview.className).toMatch(/(^| )focus-visible:opacity-100( |$)/);
    }
    const preview = screen.getByTestId("template-preview-menu-and-hours");
    preview.focus();
    expect(document.activeElement).toBe(preview);
    fireEvent.click(preview);
    expect(screen.getByRole("dialog", { name: "Menu and opening hours" })).toBeTruthy();
  });
});

describe("template wireframe colour", () => {
  it("gives every catalog template its own soft hero tint, in light and dark, with no dark inverse left", () => {
    for (const tokens of [LIGHT, DARK]) {
      const heroes = CATALOG_IDS.map((id) => heroCss(templateWireframeCss(id, tokens)));
      expect(new Set(heroes).size).toBe(CATALOG_IDS.length);
      const base = tokens.cream.split(" ").map(Number);
      for (const hero of heroes) {
        const rgb = hero!.split(" ").map(Number);
        const drift = Math.max(...rgb.map((v, i) => Math.abs(v - base[i]!)));
        expect(drift).toBeGreaterThan(0);
        expect(drift).toBeLessThanOrEqual(40);
      }
      for (const id of CATALOG_IDS) {
        const css = templateWireframeCss(id, tokens);
        expect(css).toContain(`--background:${tokens.cream}`);
        expect(css).toContain(`--foreground:${tokens.ink}`);
        expect(css).toContain(`.sec.tone-inverse{background:rgb(${heroCss(css)})!important}`);
        expect(css).not.toContain("31 35 40");
      }
    }
    expect(new Set(CATALOG_IDS.map(templateHue)).size).toBe(CATALOG_IDS.length);
    expect(templateWireframeCss("portfolio", null)).toBe("");
  });

  it("reads the page's own colour tokens and draws the card wireframes with them", async () => {
    const root = document.documentElement;
    root.style.setProperty("--c-cream", "20 20 20");
    root.style.setProperty("--c-bone", "43 43 43");
    root.style.setProperty("--c-ink", "236 236 236");
    root.style.setProperty("--c-ink-muted", "154 154 154");
    root.style.setProperty("--c-rule", "56  56 56");
    expect(readWireframeTokens()).toEqual(DARK);

    await open();
    const doc = within(screen.getByTestId("template-menu-and-hours")).getByTitle("Preview of the Menu and opening hours look").getAttribute("srcdoc")!;
    const expected = templateWireframeCss("menu-and-hours", DARK);
    expect(doc).toContain(expected.split("\n")[0]!);
    expect(doc.indexOf(expected.split("\n")[0]!)).toBeGreaterThan(doc.indexOf(THEME));
    expect(doc).toContain(`.hero{background:rgb(${heroCss(expected)})!important`);
  });
});
