
import { beforeEach, describe, expect, it, vi } from "vitest";

let brief: string | null = null;
let readError: { message: string } | null = null;
const reads: string[] = [];

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      reads.push(table);
      const q = {
        select: () => q,
        eq: () => q,
        is: () => q,
        order: () => q,
        limit: () =>
          Promise.resolve({
            data: brief === null ? [] : [{ body_markdown: brief }],
            error: readError,
          }),
      };
      return q;
    },
  }),
}));

import {
  companySuggestions,
  firstSentence,
  plainText,
  readCompanyBrief,
} from "../suggestions";

beforeEach(() => {
  brief = null;
  readError = null;
  reads.length = 0;
});

describe("plainText", () => {
  it("keeps the words and drops the markdown", () => {
    expect(plainText("**Upcar, Inc.** is a [P2P](https://x) marketplace.")).toBe(
      "Upcar, Inc. is a P2P marketplace.",
    );
    expect(plainText("# Heading\n\n- one\n- two")).toBe("Heading one two");
  });
});

describe("firstSentence", () => {
  it("takes the opening sentence, which is what these briefs lead with", () => {
    expect(
      firstSentence(
        "**Upcar, Inc.** is a peer-to-peer car-rental marketplace. Website: upcar.ai. Founder: someone.",
      ),
    ).toBe("Upcar, Inc. is a peer-to-peer car-rental marketplace.");
  });

  it("refuses to guess from a fragment, a heading or a bare URL", () => {
    expect(firstSentence("")).toBeNull();
    expect(firstSentence("# Company")).toBeNull();
    expect(firstSentence("https://example.com")).toBeNull();
    expect(firstSentence("Short.")).toBeNull();
  });

  it("truncates a runaway first sentence rather than pasting an essay", () => {
    const long = `${"We sell things to people ".repeat(40)}.`;
    const out = firstSentence(long)!;
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not glue the brief's own title onto the opening sentence", () => {
    expect(
      firstSentence(
        "# UpcarAI\n\n**Upcar, Inc.** is a peer-to-peer car-rental marketplace. Website: upcar.ai.",
      ),
    ).toBe("Upcar, Inc. is a peer-to-peer car-rental marketplace.");
    expect(
      firstSentence(
        "# A simple recipe sharing\n\nWe're building a recipe-sharing community where users post recipes.",
      ),
    ).toBe("We're building a recipe-sharing community where users post recipes.");
  });

  it("drops a whole stack of leading headings, not just the first", () => {
    expect(
      firstSentence("# Acme\n\n## Overview\n\nAcme sells widgets to hardware shops."),
    ).toBe("Acme sells widgets to hardware shops.");
  });

  it("still folds in a heading that is NOT the title block", () => {
    expect(
      firstSentence("Acme sells widgets to hardware shops.\n\n## Market\n\nBig."),
    ).toBe("Acme sells widgets to hardware shops.");
  });

  it("handles a brief with no sentence-ending punctuation at all", () => {
    expect(firstSentence("A marketplace for renting cars from local owners")).toBe(
      "A marketplace for renting cars from local owners",
    );
  });
});

describe("readCompanyBrief", () => {
  it("reads the company note, and nothing else", async () => {
    brief = "**Acme** is a widget company.";
    await readCompanyBrief("t1");
    expect(reads).toEqual(["memory_note"]);
  });

  it("returns null on a read error instead of throwing into the card", async () => {
    readError = { message: "boom" };
    expect(await readCompanyBrief("t1")).toBeNull();
  });
});

describe("companySuggestions", () => {
  it("proposes the description when it is missing", async () => {
    brief = "**Upcar, Inc.** is a peer-to-peer car-rental marketplace. More prose.";
    const out = await companySuggestions("t1", new Set(["what_we_sell"]));
    expect(out.what_we_sell).toEqual({
      value: "Upcar, Inc. is a peer-to-peer car-rental marketplace.",
      from: "your company brief",
    });
  });

  it("proposes nothing for a fact the tenant already stated", async () => {
    brief = "**Upcar, Inc.** is a peer-to-peer car-rental marketplace.";
    expect(await companySuggestions("t1", new Set())).toEqual({});
    expect(reads).toEqual([]);
  });

  it("offers the whole brief as the story, verbatim", async () => {
    brief = "**Upcar** is a marketplace. It delivers cars to your door.";
    const out = await companySuggestions("t1", new Set(["company_story"]));
    expect(out.company_story?.value).toBe(brief);
  });

  it("says nothing when there is no brief", async () => {
    brief = null;
    expect(await companySuggestions("t1", new Set(["what_we_sell"]))).toEqual({});
  });
});

describe("the competitor cap is one number", () => {
  it("the record and the shared normalizer agree", async () => {
    const record = await import("../facts");
    const normalizer = await import("@/services/agents/company-fact-sheet");
    expect(normalizer.MAX_COMPETITORS).toBe(record.MAX_COMPETITORS);
    expect(normalizer.MAX_COMPETITOR_NAME_CHARS).toBe(record.MAX_COMPETITOR_NAME_CHARS);
  });

  it("is the number Ravi set", async () => {
    const record = await import("../facts");
    expect(record.MAX_COMPETITORS).toBe(20);
    expect(record.MAX_COMPETITOR_NAME_CHARS).toBe(60);
  });

  it("the value ceiling can actually hold that many names", async () => {
    const { CompanyFactsBody } = await import("@/services/company-facts/write");
    const record = await import("../facts");
    const longest = Array.from({ length: record.MAX_COMPETITORS }, (_, i) =>
      `${String(i).padStart(2, "0")}${"x".repeat(record.MAX_COMPETITOR_NAME_CHARS - 2)}`,
    ).join(", ");
    expect(
      CompanyFactsBody.safeParse({ facts: [{ key: "competitors", value: longest }] }).success,
    ).toBe(true);
    expect(
      CompanyFactsBody.safeParse({ facts: [{ key: "what_we_sell", value: "x".repeat(501) }] })
        .success,
    ).toBe(false);
  });
});

describe("the country proposal (PLAN-ad-location-picker)", () => {
  beforeEach(() => {
    brief = null;
    readError = null;
  });

  it("proposes the ISO code the record's own location names, even with no brief; nothing is written", async () => {
    const s = await companySuggestions("t1", new Set(["country"]), { location: "Austin, TX", markets: null });
    expect(s).toEqual({ country: { value: "US", from: "where your company is based" } });
  });

  it("falls back to markets, and proposes nothing when they name several countries", async () => {
    expect((await companySuggestions("t1", new Set(["country"]), { location: null, markets: "Canada" })).country).toEqual({ value: "CA", from: "your markets" });
    expect((await companySuggestions("t1", new Set(["country"]), { location: null, markets: "United States and Canada" })).country).toBeUndefined();
  });

  it("never proposes a country the founder already set", async () => {
    expect((await companySuggestions("t1", new Set(["what_we_sell"]), { location: "Austin, TX" })).country).toBeUndefined();
  });
});
