import { describe, expect, it } from "vitest";
import { CompanyFactsBody, FACT_KEYS, RETIRED_FACT_KEYS } from "../write";

describe("retired company-fact keys", () => {
  it("company_goals is no longer a live key", () => {
    expect(FACT_KEYS as readonly string[]).not.toContain("company_goals");
    expect(RETIRED_FACT_KEYS).toEqual(["company_goals"]);
  });

  it("is accepted from an old client, then dropped before any write", () => {
    const parsed = CompanyFactsBody.parse({
      facts: [
        { key: "markets", value: "US" },
        { key: "company_goals", value: "grow" },
      ],
    });
    expect(parsed.facts).toEqual([{ key: "markets", value: "US" }]);
  });

  it("a body of only retired keys parses to nothing to write", () => {
    expect(CompanyFactsBody.parse({ facts: [{ key: "company_goals", value: "" }] }).facts).toEqual([]);
  });
});
