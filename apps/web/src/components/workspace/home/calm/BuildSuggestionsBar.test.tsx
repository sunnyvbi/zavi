// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuildSuggestionsBar, MORE_SUGGESTIONS_LABEL, SUGGESTIONS_COLLAPSED_KEY } from "./BuildSuggestionsBar";
import { mergeSuggestions, moreSuggestionsUrl, MAX_SUGGESTIONS } from "@/lib/workspace/useBuildSuggestions";

const CHIPS = [
  { key: "a", label: "Add Reviews", prompt: "Show reviews." },
  { key: "b", label: "Add Gift Cards", prompt: "Sell gift cards." },
];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("BuildSuggestionsBar", () => {
  it("a header with a lightbulb folds and unfolds the chips, and the fold is remembered", () => {
    render(<BuildSuggestionsBar suggestions={CHIPS} loading={false} disabled={false} onPick={vi.fn()} />);
    const toggle = screen.getByTestId("build-suggestions-toggle");
    expect(toggle.textContent).toBe("Suggestions");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: "Add Reviews" })).toBeNull();
    expect(window.localStorage.getItem(SUGGESTIONS_COLLAPSED_KEY)).toBe("1");
    cleanup();
    render(<BuildSuggestionsBar suggestions={CHIPS} loading={false} disabled={false} onPick={vi.fn()} />);
    expect(screen.getByTestId("build-suggestions-toggle").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("build-suggestions-toggle"));
    expect(screen.getByRole("button", { name: "Add Reviews" })).toBeTruthy();
  });

  it("a chip fires its suggestion; at the end of the row the arrow is + and asks for more", () => {
    const onPick = vi.fn();
    const onMore = vi.fn();
    render(<BuildSuggestionsBar suggestions={CHIPS} loading={false} disabled={false} onPick={onPick} onMore={onMore} />);
    fireEvent.click(screen.getByRole("button", { name: "Add Gift Cards" }));
    expect(onPick).toHaveBeenCalledWith(CHIPS[1]);
    expect(screen.queryByTestId("build-suggestions-left")).toBeNull();
    expect(screen.queryByTestId("build-suggestions-right")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: MORE_SUGGESTIONS_LABEL }));
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it("shows < > arrows when the row scrolls, and + only at the end", () => {
    render(<BuildSuggestionsBar suggestions={CHIPS} loading={false} disabled={false} onPick={vi.fn()} onMore={vi.fn()} />);
    const row = screen.getByRole("list").parentElement as HTMLDivElement;
    Object.defineProperty(row, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(row, "clientWidth", { value: 300, configurable: true });
    row.scrollBy = vi.fn() as unknown as typeof row.scrollBy;
    row.scrollLeft = 0;
    fireEvent.scroll(row);
    expect(screen.queryByTestId("build-suggestions-left")).toBeNull();
    expect(screen.getByTestId("build-suggestions-right")).toBeTruthy();
    expect(screen.queryByTestId("build-suggestions-more")).toBeNull();
    fireEvent.click(screen.getByTestId("build-suggestions-right"));
    expect(row.scrollBy).toHaveBeenCalled();
    row.scrollLeft = 300;
    fireEvent.scroll(row);
    expect(screen.getByTestId("build-suggestions-left")).toBeTruthy();
    expect(screen.getByTestId("build-suggestions-more")).toBeTruthy();
  });

  it("says so when asking for more failed, and not while a retry is loading", () => {
    const view = render(<BuildSuggestionsBar suggestions={CHIPS} loading={false} moreFailed disabled={false} onPick={vi.fn()} onMore={vi.fn()} />);
    expect(screen.getByTestId("build-suggestions-more-failed").textContent).toBe("Couldn't get more suggestions. Try again.");
    view.rerender(<BuildSuggestionsBar suggestions={CHIPS} loading={false} moreFailed loadingMore disabled={false} onPick={vi.fn()} onMore={vi.fn()} />);
    expect(screen.queryByTestId("build-suggestions-more-failed")).toBeNull();
    view.rerender(<BuildSuggestionsBar suggestions={CHIPS} loading={false} disabled={false} onPick={vi.fn()} onMore={vi.fn()} />);
    expect(screen.queryByTestId("build-suggestions-more-failed")).toBeNull();
  });

  it("locks the chips while a change runs and spins the + while more load", () => {
    render(<BuildSuggestionsBar suggestions={CHIPS} loading={false} loadingMore disabled onPick={vi.fn()} onMore={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Add Reviews" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: MORE_SUGGESTIONS_LABEL }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("more suggestions", () => {
  it("asks with the shown labels excluded and merges only new chips, capped", () => {
    const url = new URL(moreSuggestionsUrl("s-1", CHIPS), "https://x");
    expect(url.searchParams.get("more")).toBe("1");
    expect(url.searchParams.getAll("exclude")).toEqual(["Add Reviews", "Add Gift Cards"]);
    const merged = mergeSuggestions(CHIPS, [
      { key: "a", label: "Add Reviews", prompt: "x" },
      { key: "z", label: "add gift cards", prompt: "x" },
      { key: "c", label: "Add FAQ", prompt: "Add an FAQ." },
    ]);
    expect(merged.map((m) => m.label)).toEqual(["Add Reviews", "Add Gift Cards", "Add FAQ"]);
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, prompt: "p" }));
    expect(mergeSuggestions([], many)).toHaveLength(MAX_SUGGESTIONS);
  });
});
