
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WebsiteEditorToolbar, toHexColor, parseFontSizePx } from "./WebsiteEditorToolbar";
import type { SelectedElement } from "./editorProtocol";

const leaf: SelectedElement = {
  selector: ".hero h2",
  tag: "h2",
  text: "Headline",
  textEditable: true,
  style: { color: "#111111", backgroundColor: "#ffeeaa", fontSize: "24px" },
};

function render(overrides: Partial<Parameters<typeof WebsiteEditorToolbar>[0]> = {}) {
  return renderToStaticMarkup(
    <WebsiteEditorToolbar
      selected={leaf}
      canUndo={false}
      canRedo={false}
      onApply={() => {}}
      onDelete={() => {}}
      onUndo={() => {}}
      onRedo={() => {}}
      onClose={() => {}}
      {...overrides}
    />,
  );
}

describe("WebsiteEditorToolbar — Slice 1 additions", () => {
  it("renders the element tag chip", () => {
    expect(render()).toContain("h2");
  });

  it("renders a background-color control alongside text color", () => {
    const html = render();
    expect(html).toContain('aria-label="Text color"');
    expect(html).toContain('aria-label="Background color"');
    expect(html).toContain('aria-label="Clear background"');
  });

  it("hides the Ask AI input when onAskAi is not wired (degrades cleanly)", () => {
    expect(render()).not.toContain('aria-label="Ask AI to change this element"');
    expect(render()).not.toContain("Edit Element");
  });

  it("renders the Edit Element button, not the input, when onAskAi is wired", () => {
    const html = render({ onAskAi: async () => {} });
    expect(html).toContain("Edit Element");
    expect(html).not.toContain('aria-label="Ask AI to change this element"');
    expect(html).not.toContain("rebuilds your site");
  });

  it("hides the text field for a non-text-editable (container) element", () => {
    const container: SelectedElement = { ...leaf, textEditable: false };
    expect(render({ selected: container })).not.toContain('aria-label="Element text"');
    expect(render()).toContain('aria-label="Element text"');
  });

  it("shows a Link URL input only for an <a>, prefilled with the current href", () => {
    const anchor: SelectedElement = {
      selector: "a.cta",
      tag: "a",
      text: "Buy",
      textEditable: true,
      style: {},
      attrs: { href: "https://shop.com" },
    };
    const html = render({ selected: anchor });
    expect(html).toContain('aria-label="Link URL"');
    expect(html).toContain("https://shop.com");
    expect(html).not.toContain('aria-label="Image URL"');
    expect(render()).not.toContain('aria-label="Link URL"');
  });

  it("shows an Image URL input only for an <img>, prefilled with the current src", () => {
    const img: SelectedElement = {
      selector: "img.hero",
      tag: "img",
      text: "",
      textEditable: false,
      style: {},
      attrs: { src: "/hero.png" },
    };
    const html = render({ selected: img });
    expect(html).toContain('aria-label="Image URL"');
    expect(html).toContain("/hero.png");
    expect(html).not.toContain('aria-label="Link URL"');
  });
});

describe("toolbar pure helpers", () => {
  it("toHexColor normalizes rgb()/hex and falls back to black", () => {
    expect(toHexColor("#AABBCC")).toBe("#aabbcc");
    expect(toHexColor("rgb(255, 0, 16)")).toBe("#ff0010");
    expect(toHexColor(undefined)).toBe("#000000");
    expect(toHexColor("transparent")).toBe("#000000");
  });

  it("parseFontSizePx parses px and falls back to 16", () => {
    expect(parseFontSizePx("24px")).toBe(24);
    expect(parseFontSizePx(undefined)).toBe(16);
    expect(parseFontSizePx("weird")).toBe(16);
  });
});
