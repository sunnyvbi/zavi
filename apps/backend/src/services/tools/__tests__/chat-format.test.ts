import { describe, it, expect } from "vitest";
import {
  flattenMarkdownTables,
  stripInlineMarkdown,
  formatForDiscord,
  formatForTelegram,
  formatForWhatsApp,
} from "../chat-format";

const TABLE = [
  "Here's what the live data shows this week:",
  "",
  "| Signal | Value |",
  "|---|---|",
  "| New signups | **418** |",
  "| New bookings | **79** |",
  "| Meta spend | $49 (paused Aug 31) |",
  "",
  "**CAC** — partial picture:",
].join("\n");

describe("flattenMarkdownTables", () => {
  it("rewrites a GFM pipe table as aligned columns with a dashed rule", () => {
    const out = flattenMarkdownTables(TABLE, { fence: false });
    expect(out).not.toMatch(/\|/);
    const lines = out.split("\n");
    const header = lines.find((l) => l.startsWith("Signal"))!;
    const rule = lines[lines.indexOf(header) + 1];
    expect(header).toBe("Signal        Value");
    expect(rule).toBe("------------  -------------------");
    expect(lines).toContain("New signups   **418**");
    expect(lines).toContain("Meta spend    $49 (paused Aug 31)");
    expect(lines[0]).toBe("Here's what the live data shows this week:");
    expect(lines[lines.length - 1]).toBe("**CAC** — partial picture:");
  });

  it("wraps the table in a ``` fence when asked (Discord renders fences monospaced)", () => {
    const out = flattenMarkdownTables(TABLE, { fence: true });
    expect(out).toMatch(/```\nSignal {8}Value\n-+ {2}-+\n[\s\S]*\n```/);
    expect(out.split("```").length).toBe(3);
  });

  it("requires the GFM rule row — a lone line with pipes is left alone", () => {
    const text = "a | b | c\nnot a table";
    expect(flattenMarkdownTables(text, { fence: true })).toBe(text);
  });

  it("handles alignment colons, ragged rows and missing outer pipes", () => {
    const text = "Col A | Col B\n:---|---:\nx | 1\ny\n";
    const out = flattenMarkdownTables(text, { fence: false });
    expect(out).toBe("Col A  Col B\n-----  -----\nx      1\ny\n");
  });

  it("caps a runaway cell at 40 chars so one value can't blow the width", () => {
    const text = "| k | v |\n|---|---|\n| a | " + "z".repeat(120) + " |";
    const out = flattenMarkdownTables(text, { fence: false });
    const row = out.split("\n")[2];
    expect(row.length).toBeLessThanOrEqual(3 + 40);
  });

  it("flattens multiple tables independently", () => {
    const text = "| a |\n|---|\n| 1 |\n\ntext\n\n| b |\n|---|\n| 2 |";
    const out = flattenMarkdownTables(text, { fence: true });
    expect(out.split("```").length).toBe(5);
  });
});

describe("stripInlineMarkdown (Telegram plain text)", () => {
  it("drops bold/italic/code markers and heading hashes, keeps the words", () => {
    expect(stripInlineMarkdown("## CAC\n**418** signups, *79* bookings, `$49` spend")).toBe(
      "CAC\n418 signups, 79 bookings, $49 spend",
    );
  });
  it("turns links into 'text (url)' and bullets into •", () => {
    expect(stripInlineMarkdown("- see [the dashboard](https://x.y/z)")).toBe(
      "• see the dashboard (https://x.y/z)",
    );
  });
  it("unwraps fenced code blocks", () => {
    expect(stripInlineMarkdown("```sql\nselect 1\n```")).toBe("select 1\n");
  });
  it("leaves underscores/asterisks INSIDE words alone (snake_case, 2*3, a__b)", () => {
    expect(stripInlineMarkdown("tenant_id and 2*3*4 and a_b_c and a__b")).toBe(
      "tenant_id and 2*3*4 and a_b_c and a__b",
    );
    expect(stripInlineMarkdown("__bold__ word")).toBe("bold word");
  });
});

describe("per-surface formatters", () => {
  it("Discord: fenced table, markdown otherwise untouched", () => {
    const out = formatForDiscord(TABLE);
    expect(out).toContain("```\nSignal");
    expect(out).toContain("**CAC**");
  });
  it("Telegram: bare table, no markers anywhere", () => {
    const out = formatForTelegram(TABLE);
    expect(out).not.toContain("```");
    expect(out).not.toContain("**");
    expect(out).toContain("New signups   418");
    expect(out).toContain("New bookings  79");
    expect(out).toContain("CAC — partial picture:");
  });
});

describe("formatForWhatsApp", () => {
  it("translates **bold** / __bold__ to *bold* and headings to a bold line", () => {
    const out = formatForWhatsApp("## Weekly numbers\n\n**418** signups, __79__ bookings");
    expect(out).toBe("*Weekly numbers*\n\n*418* signups, *79* bookings");
  });

  it("turns links into 'text (url)', inline code into bare text, bullets into •", () => {
    const out = formatForWhatsApp("- see [docs](https://x.io/d)\n* run `npm test`");
    expect(out).toBe("• see docs (https://x.io/d)\n• run npm test");
  });

  it("fences a flattened table (WhatsApp shows ``` monospaced) with cells already translated", () => {
    const out = formatForWhatsApp(TABLE);
    expect(out.split("```").length).toBe(3);
    expect(out).not.toContain("| Signal");
    expect(out).toContain("New signups");
    expect(out).toContain("*418*");
    expect(out).toContain("*CAC* — partial picture:");
  });

  it("leaves a bold line alone when converting bullets (no space after the star)", () => {
    expect(formatForWhatsApp("*Already bold*\n- item")).toBe("*Already bold*\n• item");
  });

  it("keeps snake_case / a__b / 2*3 intact", () => {
    expect(formatForWhatsApp("use snake_case, a__b and 2*3")).toBe("use snake_case, a__b and 2*3");
  });
});
