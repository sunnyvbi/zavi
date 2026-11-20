import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(
  join(__dirname, "../../routes/onboarding/activate.ts"),
  "utf-8",
);

describe("persistCompanyFacts — the enrichment_audit fallback is USER-scoped and must be bounded", () => {
  it("only accepts an operator-CONFIRMED domain (mode='full'), never a bare Tavily guess", () => {
    expect(src).toMatch(/\.eq\("mode",\s*"full"\)/);
  });

  it("only accepts a row from THIS onboarding session, not the user's history", () => {
    expect(src).toMatch(/ENRICHMENT_SESSION_WINDOW_MS/);
    expect(src).toMatch(/\.gte\("created_at",\s*sessionStart\)/);
  });

  it("keeps the session window short enough that it cannot reach a previous company's onboarding", () => {
    expect(src).toMatch(/const ENRICHMENT_SESSION_WINDOW_MS = 2 \* 60 \* 60 \* 1000;/);
  });

  it("still persists NOTHING when no source yields a domain — absence is silent", () => {
    expect(src).toMatch(/if \(!origin\) return;/);
  });
});
