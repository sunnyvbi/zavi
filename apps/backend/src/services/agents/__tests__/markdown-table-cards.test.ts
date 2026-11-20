
import { describe, it, expect } from "vitest";
import { liftMarkdownTables } from "@/services/agents/markdown-table-cards";

const REPLY = [
  "Here are the numbers:",
  "",
  "| Month | Sign-ups | Booked | Rate |",
  "|---|---|---|---|",
  "| July | 1,587 | 180 | 11.3% |",
  "| **August** | 2,497 | 166 | 6.6% |",
  "",
  "August sign-ups nearly doubled but conversion fell.",
].join("\n");

describe("liftMarkdownTables", () => {
  it("lifts a table out of the reply as a card", () => {
    const out = liftMarkdownTables(REPLY);
    expect(out.tables).toEqual([
      {
        title: "Sign-ups, Booked and Rate by month",
        columns: ["Month", "Sign-ups", "Booked", "Rate"],
        rows: [
          ["July", "1,587", "180", "11.3%"],
          ["August", "2,497", "166", "6.6%"],
        ],
      },
    ]);
    expect(out.body).toBe("Here are the numbers.\n\nAugust sign-ups nearly doubled but conversion fell.");
  });

  it("takes a bold label right above the table as its title", () => {
    const out = liftMarkdownTables("Intro.\n\n**Sign-ups per month**\n| M | N |\n|---|---|\n| Jul | 1 |\n\nAfter.");
    expect(out.tables[0].title).toBe("Sign-ups per month");
    expect(out.body).toBe("Intro.\n\nAfter.");
  });

  it("leaves a table it cannot hold whole in the prose", () => {
    const wide = `| ${Array.from({ length: 9 }, (_, i) => `c${i}`).join(" | ")} |\n|${"---|".repeat(9)}\n| ${Array(9).fill("x").join(" | ")} |`;
    const ragged = "| A | B |\n|---|---|\n| 1 |";
    for (const t of [wide, ragged]) {
      const out = liftMarkdownTables(`Before.\n\n${t}`);
      expect(out.tables).toEqual([]);
      expect(out.body).toContain(t.split("\n")[0]);
    }
  });

  it("never touches a table inside a code fence", () => {
    const fenced = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
    expect(liftMarkdownTables(fenced).tables).toEqual([]);
  });

  it("moves the table's footnote into the card and closes the dangling colon", () => {
    const out = liftMarkdownTables(
      "Fresh from DB:\n\n| Month | N |\n|---|---|\n| September* | 1,853 |\n\n*Sep 1-25 only.\n\nStory: sign-ups fell.",
    );
    expect(out.tables[0].note).toBe("*Sep 1-25 only.");
    expect(out.body).toBe("Fresh from DB.\n\nStory: sign-ups fell.");
  });

  it("does not take a bullet list under the table as a footnote", () => {
    const out = liftMarkdownTables("| A | B |\n|---|---|\n| 1 | 2 |\n\n* first point\n* second");
    expect(out.tables[0].note).toBeUndefined();
    expect(out.body).toBe("* first point\n* second");
  });

  it("leaves tables with escaped pipes or links, and nested fences, as written", () => {
    expect(liftMarkdownTables("| A | B |\n|---|---|\n| x \\| y | 1 |").tables).toEqual([]);
    expect(liftMarkdownTables("| A | B |\n|---|---|\n| [r](https://e.com) | 1 |").tables).toEqual([]);
    const nested = "````\n```\n| A | B |\n|---|---|\n| 1 | 2 |\n````";
    expect(liftMarkdownTables(nested).tables).toEqual([]);
  });

  it("leaves a footnote too long for the card in the prose", () => {
    const long = `*${"x".repeat(320)}`;
    const out = liftMarkdownTables(`| A | B |\n|---|---|\n| 1 | 2 |\n\n${long}`);
    expect(out.tables[0].note).toBeUndefined();
    expect(out.body).toContain(long);
  });
});
