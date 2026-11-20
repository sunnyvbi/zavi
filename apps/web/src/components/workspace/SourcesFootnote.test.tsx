// @vitest-environment jsdom

import { beforeEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { SourcesFootnote, splitSources, isRefusalLine } from "./SourcesFootnote";

const BLOCK = [
  "---",
  "**Sources.** 4 of 6 numbers came straight from data pulled in this run, 2 check out as arithmetic on it.",
  "",
  "1. Your database: a query returned 1587, 120",
  "",
  "Checks out against those: 7.6% = 120 / 1587",
].join("\n");

describe("splitSources", () => {
  it("separates the trailing block from the prose", () => {
    const out = splitSources(`Sign-ups doubled but bookings fell.\n\n${BLOCK}`);
    expect(out.body).toBe("Sign-ups doubled but bookings fell.");
    expect(out.sources?.startsWith("**Sources.** 4 of 6")).toBe(true);
  });

  it("recognises the header stored before 2026-09-25", () => {
    const legacy = "Text.\n\n---\n**Where these numbers came from.** 0 of 2 came back from a live pull in this run.";
    expect(splitSources(legacy).body).toBe("Text.");
  });

  it("leaves a reply without the block untouched", () => {
    const text = "A plain answer.\n\n---\n\nWith a rule in it.";
    expect(splitSources(text)).toEqual({ body: text, sources: null });
  });
});

describe("SourcesFootnote", () => {
  it("shows one line, and the pull list only on click", () => {
    const { getByText, queryByText, getByRole } = render(
      <SourcesFootnote sources={splitSources(`x\n\n${BLOCK}`).sources!} />,
    );
    expect(getByText(/4 of 6 numbers came straight/)).toBeTruthy();
    expect(queryByText(/a query returned/)).toBeNull();
    fireEvent.click(getByRole("button"));
    expect(getByText(/a query returned 1587, 120/)).toBeTruthy();
  });

  it("keeps a not-in-data warning visible while folded", () => {
    const block = `${BLOCK}\n\nNot in this run's data: 80-90. Worked out here or carried in from earlier context, so check it before acting.`;
    const { getByText } = render(<SourcesFootnote sources={splitSources(`x\n\n${block}`).sources!} />);
    expect(getByText(/Not in this run's data: 80-90/)).toBeTruthy();
  });
});

describe("SourcesFootnote: database reads (private data S6)", () => {
  beforeEach(cleanup);
  const LOG = "cccccccc-1111-4111-8111-111111111111";
  const DB_BLOCK = [
    "---",
    "**Sources.** The number came straight from data pulled in this run. 1 query was refused.",
    "",
    `1. Your connector: a query (call 1) on bookings, 412 rows, totals only. [See query](/workspace?tab=brain&access=${LOG}#data-access)`,
    `Your connector refused a query on users: users.email is blocked by this connector's rules. Nothing was sent. [See query](/workspace?tab=brain&access=${LOG}#data-access)`,
    "",
    "Not in this run's data: 80-90. Worked out here or carried in from earlier context, so check it before acting.",
    "",
    "Not in this run's data: users.email. Your connector blocked it, so nothing about it was sent.",
  ].join("\n");

  it("keeps every warning visible, draws the refusal amber and links See query in-app", () => {
    const { getByText, getByRole, getByTestId, getAllByRole } = render(
      <SourcesFootnote sources={splitSources(`x\n\n${DB_BLOCK}`).sources!} />,
    );
    expect(getByText(/Not in this run's data: 80-90/)).toBeTruthy();
    expect(getByText(/Your connector blocked it/)).toBeTruthy();
    fireEvent.click(getByRole("button"));
    expect(getByTestId("sources-refusal").textContent).toContain("Your connector refused a query on users");
    const links = getAllByRole("link", { name: "See query" });
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute("href")).toBe(`/workspace?tab=brain&access=${LOG}#data-access`);
      expect(a.getAttribute("target")).toBeNull();
    }
  });
});

describe("Zavi safety-check refusal lines", () => {
  it("are styled as refusals like the other two kinds", () => {
    expect(isRefusalLine("Zavi's safety check blocked a query on items: x. Nothing was sent.")).toBe(true);
    expect(isRefusalLine("Your settings refused a query on items: x. Nothing was sent.")).toBe(true);
    expect(isRefusalLine("1. Your database: a query returned 5,344")).toBe(false);
  });
});
