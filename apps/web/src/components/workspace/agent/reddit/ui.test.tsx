// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { RelevantPostsTable } from "./KpiTables";

afterEach(() => cleanup());

describe("matched keywords cell", () => {
  it("drops the keyword column and lists matched keywords in a popover from the relevance info button", () => {
    const post = {
      thread_id: "t1",
      url: "https://www.reddit.com/r/turo/comments/a/",
      subreddit: "turo",
      title: "Renting out my car",
      posted_at: null,
      relevance: 90,
      matched_terms: ["car sharing app", "rent my car", "turo host"],
      score: 4,
      comment_count: 2,
    };
    render(
      <RelevantPostsTable
        lists={{ brand_mentions: [], relevant_posts: [post], relevant_comments: [] }}
        total={1}
        scanned={10}
        threshold={60}
      />,
    );
    expect(screen.queryByRole("columnheader", { name: /Matched/ })).toBeNull();
    const heads = screen.getAllByRole("columnheader").length;
    const cells = [...document.querySelectorAll("tbody tr:first-child td")].length;
    expect(cells).toBe(heads);
    expect(screen.queryByText("car sharing app")).toBeNull();
    const more = screen.getByRole("button", { name: "Show 3 matched keywords" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    const pop = screen.getByRole("dialog", { name: "Matched keywords" });
    expect(pop.textContent).toContain("car sharing app");
    expect(pop.textContent).toContain("rent my car");
    expect(pop.textContent).toContain("turo host");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Matched keywords" })).toBeNull();
    fireEvent.click(more);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Matched keywords" })).toBeNull();
  });
});
