import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SuggestionChips } from "./SuggestionChips";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

function markup(suggestions: string[]) {
  return renderToStaticMarkup(
    <SuggestionChips agentSlug="chief-of-staff" threadId="t1" suggestions={suggestions} />,
  );
}

describe("SuggestionChips render contract", () => {
  it("renders a button per suggestion label", () => {
    const html = markup(["Confirm", "Cancel"]);
    expect(html).toContain("Confirm");
    expect(html).toContain("Cancel");
    expect((html.match(/<button/g) || []).length).toBe(2);
  });

  it("drops empty / whitespace-only labels", () => {
    const html = markup(["Confirm", "", "   "]);
    expect((html.match(/<button/g) || []).length).toBe(1);
    expect(html).toContain("Confirm");
  });

  it("caps at 5 chips", () => {
    const html = markup(["a", "b", "c", "d", "e", "f", "g"]);
    expect((html.match(/<button/g) || []).length).toBe(5);
  });

  it("renders nothing when there are no usable suggestions", () => {
    expect(markup([])).toBe("");
    expect(markup(["", "  "])).toBe("");
  });
});
