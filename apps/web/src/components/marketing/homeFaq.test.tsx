// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./growth-home/fonts", () => ({ jakartaHeavy: { className: "" }, caveat: { className: "" } }));

import { HomeStructuredData } from "./StructuredData";
import { GrowthFaq } from "./growth-home/GrowthFaq";
import { GrowthHero } from "./growth-home/GrowthHero";
import { HOME_FAQ } from "./homeFaq";

function faqSchema(container: HTMLElement) {
  const blocks = [...container.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
    JSON.parse(s.textContent ?? "{}"),
  );
  return blocks.find((b) => b["@type"] === "FAQPage");
}

describe("home FAQ: schema matches the visible page", () => {
  it("FAQPage JSON-LD carries exactly the Q&A the visible FAQ renders", () => {
    const { container } = render(
      <>
        <HomeStructuredData freeDailyCredits={1000} />
        <GrowthFaq items={HOME_FAQ} />
      </>,
    );
    const schema = faqSchema(container);
    const pairs = schema.mainEntity.map((e: { name: string; acceptedAnswer: { text: string } }) => [
      e.name,
      e.acceptedAnswer.text,
    ]);
    expect(pairs.length).toBeGreaterThan(0);
    for (const [q, a] of pairs) {
      expect(screen.getByText(q)).toBeTruthy();
      expect(screen.getByText(a)).toBeTruthy();
    }
  });
});

describe("home SoftwareApplication offer", () => {
  it("quotes the daily grant it is given, not a fixed number", () => {
    const { container } = render(<HomeStructuredData freeDailyCredits={5000} />);
    const app = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((s) => JSON.parse(s.textContent ?? "{}"))
      .find((b) => b["@type"] === "SoftwareApplication");
    expect(app.offers.description).toContain("5,000 credits every day");
  });
});

describe("home hero names the category", () => {
  it("the h1 is the product title", () => {
    render(<GrowthHero startHref="/start" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/AI Growth Agent\s*For Your Business/);
  });

  it("the typewriter deletes down to 'AI ' and never below, and the accessible title never changes", () => {
    vi.useFakeTimers();
    const mm = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
    try {
      const { container } = render(<GrowthHero startHref="/start" typewriter />);
      const h1 = container.querySelector("h1")!;
      const typed = () => (h1.querySelector("span.absolute.inset-0")?.textContent ?? "").trim();
      let shortest = typed();
      for (let i = 0; i < 400; i++) {
        act(() => { vi.advanceTimersByTime(40); });
        if (typed().length < shortest.length) shortest = typed();
        expect(h1.getAttribute("aria-label")).toBe("AI Growth Agent For Your Business");
      }
      expect(shortest).toBe("AI");
    } finally {
      mm.mockRestore();
      vi.useRealTimers();
    }
  });
});
