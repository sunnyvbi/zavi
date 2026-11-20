// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { renderToString } from "react-dom/server";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import {
  ZaviWelcome,
  SuggestionChips,
  WORKSPACE_MODE_SUGGESTIONS,
  WORKSPACE_MODE_SUGGESTION_CHIPS,
} from "./ZaviWelcome";

describe("WORKSPACE_MODE_SUGGESTIONS", () => {
  it("offers the six growth prompts, in order, on the grow surface", () => {
    expect(WORKSPACE_MODE_SUGGESTIONS.grow).toEqual([
      "What's my 30 day marketing strategy?",
      "Who's my target customer and what pain points should I lead with?",
      "Show me the competitors I'm tracking",
      "How do you think we should position our product?",
      "Write me a one-liner that sells my product better",
      "How can we grow our organic traffic in the next 90 days?",
    ]);
  });

  it("no longer offers the retired status-report prompts", () => {
    for (const retired of [
      "What did the team do this week?",
      "What needs my attention right now?",
      "Draft a short update for investors",
    ]) {
      expect(WORKSPACE_MODE_SUGGESTIONS.grow).not.toContain(retired);
    }
  });

  it("leaves the build chips alone", () => {
    expect(WORKSPACE_MODE_SUGGESTIONS.build).toEqual([
      "A launch-ready landing page",
      "A customer portal",
      "An analytics dashboard",
    ]);
  });
});

describe("SuggestionChips", () => {
  it("shows the short label and sends the full prompt", () => {
    const picked: string[] = [];
    const html = renderToString(
      <SuggestionChips
        items={WORKSPACE_MODE_SUGGESTION_CHIPS.grow}
        onPick={(prompt) => picked.push(prompt)}
      />,
    );

    expect(html).toContain(">Plan my next month<");
    expect(html).not.toContain(">What's my 30 day marketing strategy?<");
  });

  it("gives every chip its prompt as the accessible name", () => {
    const html = renderToString(
      <SuggestionChips items={WORKSPACE_MODE_SUGGESTION_CHIPS.grow} onPick={() => {}} />,
    );

    for (const { prompt } of WORKSPACE_MODE_SUGGESTION_CHIPS.grow) {
      expect(html).toContain(`aria-label="${prompt.replace(/'/g, "&#x27;")}"`);
    }
  });

  it("keeps a label for every prompt on both surfaces", () => {
    for (const mode of ["build", "grow"] as const) {
      const chips = WORKSPACE_MODE_SUGGESTION_CHIPS[mode];
      expect(chips.map((chip) => chip.prompt)).toEqual(
        WORKSPACE_MODE_SUGGESTIONS[mode],
      );
      for (const chip of chips) {
        expect(chip.label.trim()).not.toEqual("");
        expect(chip.label.length).toBeLessThan(chip.prompt.length);
      }
    }
  });
});

describe("ZaviWelcome", () => {
  it("opens on Let's start in both modes, never on a mode-specific pitch", () => {
    for (const mode of ["build", "grow"] as const) {
      const html = renderToString(<ZaviWelcome mode={mode} />);
      expect(html).toContain("Let&#x27;s start");
      expect(html).not.toContain("your business");
    }
  });

  it("hydrates without a server/client mismatch", async () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const html = renderToString(<ZaviWelcome mode="build" />);
    const host = document.createElement("div");
    const recoverableErrors: unknown[] = [];
    host.innerHTML = html;
    document.body.appendChild(host);

    const root = hydrateRoot(host, <ZaviWelcome mode="build" />, {
      onRecoverableError: (error) => recoverableErrors.push(error),
    });
    await act(async () => Promise.resolve());

    expect(recoverableErrors).toEqual([]);
    act(() => root.unmount());
    host.remove();
  });
});
