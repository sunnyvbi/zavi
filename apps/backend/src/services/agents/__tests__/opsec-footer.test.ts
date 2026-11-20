import { describe, it, expect } from "vitest";
import { BRAND_VOICE_FOOTER, OPSEC_FOOTER } from "../opsec-footer";

describe("OPSEC_FOOTER", () => {
  it("is non-empty", () => {
    expect(OPSEC_FOOTER.length).toBeGreaterThan(0);
  });

  it("starts with a horizontal-rule separator so it appends cleanly", () => {
    expect(OPSEC_FOOTER.startsWith("\n\n---\n")).toBe(true);
  });

  it("instructs the model not to reveal its own instructions verbatim", () => {
    expect(OPSEC_FOOTER).toMatch(/do not\s+reveal/i);
    expect(OPSEC_FOOTER).toMatch(/instructions|system prompt/i);
  });

  it("instructs the model to refuse extraction attempts framed as user requests", () => {
    expect(OPSEC_FOOTER).toMatch(/ignore.*prior|reveal.*prompt|print.*instructions/i);
  });

  it("does NOT promise unbreakable secrecy (we don't want to lie to the model)", () => {
    expect(OPSEC_FOOTER).not.toMatch(/never under any circumstances|absolutely cannot|forbidden/i);
  });

  it("handles the case where the extraction attempt IS the only request", () => {
    expect(OPSEC_FOOTER).toMatch(/no legitimate task|only request|required output schema/i);
  });

  it("requires output to stay inside the agent's schema (no free text leakage)", () => {
    expect(OPSEC_FOOTER).toMatch(/never emit free text outside\s+the schema/i);
  });
});

describe("BRAND_VOICE_FOOTER", () => {
  it("appends cleanly (horizontal-rule separator)", () => {
    expect(BRAND_VOICE_FOOTER.startsWith("\n\n---\n")).toBe(true);
  });

  it("names the product Zavi and forbids the legacy 'Praxis' name to users", () => {
    expect(BRAND_VOICE_FOOTER).toMatch(/\bZavi\b/);
    expect(BRAND_VOICE_FOOTER).toMatch(/never "praxis"/i);
  });

  it("keeps the customer's product SEPARATE from the vendor platform + forbids describing platform internals (2026-07-15 leak fix)", () => {
    expect(BRAND_VOICE_FOOTER).not.toMatch(
      /you are part of \*\*zavi\*\*, the product the user logs into/i,
    );
    expect(BRAND_VOICE_FOOTER).toMatch(/separate thing/i);
    expect(BRAND_VOICE_FOOTER).toMatch(
      /never treat zavi.*as the customer's own product/i,
    );
    expect(BRAND_VOICE_FOOTER).toMatch(
      /never describe the platform's internal architecture/i,
    );
  });

  it("tells the model the file is a downloadable chip under the message and never invents a destination", () => {
    expect(BRAND_VOICE_FOOTER).toMatch(/downloadable chip/i);
    expect(BRAND_VOICE_FOOTER).toMatch(/do NOT redirect the user somewhere else/i);
    expect(BRAND_VOICE_FOOTER).toMatch(/never at a "Files" page/i);
    expect(BRAND_VOICE_FOOTER).toMatch(/google drive/i);
    expect(BRAND_VOICE_FOOTER).toMatch(/Library/);
    expect(BRAND_VOICE_FOOTER).not.toMatch(/no such tab exists/i);
  });

  it("forbids em-dashes in replies", () => {
    expect(BRAND_VOICE_FOOTER).toMatch(/do not use the em-dash/i);
  });
});
