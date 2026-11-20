import { describe, it, expect } from "vitest";
import { validateGenerateBody, deriveShellSlug, isModerationOutage, isUpstreamUnavailable } from "../request";
import { launchVideoIntakeBase } from "@/services/launch-video/brief-mapper";

const good = {
  email: "Founder@Example.com",
  company: "Acme Robotics",
  product_name: "Acme Bot",
  one_liner: "The friendliest robot for your home.",
  features: "Cleans floors\nFolds laundry",
  audience: "busy families",
  tone: "playful",
  cta_text: "Get yours",
  cta_url: "https://acme.example.com",
};

describe("validateGenerateBody", () => {
  it("accepts a well-formed body and lowercases the email", () => {
    const r = validateGenerateBody(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.email).toBe("founder@example.com");
    expect(r.value.company).toBe("Acme Robotics");
    expect(r.value.form.product_name).toBe("Acme Bot");
    expect(r.value.form.tone).toBe("playful");
  });

  it("defaults company to product_name when company is absent", () => {
    const { company, ...rest } = good;
    void company;
    const r = validateGenerateBody(rest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.company).toBe("Acme Bot");
  });

  it("defaults tone to 'clean' when absent", () => {
    const { tone, ...rest } = good;
    void tone;
    const r = validateGenerateBody(rest);
    expect(r.ok && r.value.form.tone).toBe("clean");
  });

  it.each([
    ["not-an-email", "invalid_email"],
    ["", "invalid_email"],
  ])("rejects a bad email %s", (email, code) => {
    const r = validateGenerateBody({ ...good, email });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(code);
  });

  it("rejects a missing product_name", () => {
    const r = validateGenerateBody({ ...good, product_name: "  " });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("missing_product_name");
  });

  it("rejects a missing one_liner", () => {
    const r = validateGenerateBody({ ...good, one_liner: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("missing_one_liner");
  });

  it("rejects an oversized field", () => {
    const r = validateGenerateBody({ ...good, one_liner: "x".repeat(5000) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("field_too_long");
  });

  it.each([
    ["product_name", 81],
    ["one_liner", 201],
    ["audience", 161],
    ["cta_text", 81],
    ["cta_url", 301],
  ])("rejects %s one character past the intake schema's cap", (field, len) => {
    const base = "https://a.example.com/";
    const value = field === "cta_url" ? base + "x".repeat(len - base.length) : "x".repeat(len);
    expect(value.length).toBe(len);
    const r = validateGenerateBody({ ...good, [field]: value });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("field_too_long");
  });

  it("never accepts a value the intake schema would refuse", () => {
    const shape = launchVideoIntakeBase.shape as Record<string, { maxLength?: number | null }>;
    const pairs: Array<[string, string]> = [
      ["product_name", "product_name"],
      ["one_liner", "one_liner"],
      ["audience", "audience"],
      ["cta_text", "cta_text"],
      ["cta_url", "url"],
    ];
    for (const [publicField, intakeField] of pairs) {
      const cap = shape[intakeField]?.maxLength;
      expect(cap, `intake.${intakeField} should declare a max`).toBeTypeOf("number");
      const r = validateGenerateBody({ ...good, [publicField]: "x".repeat((cap as number) + 1) });
      expect(r.ok, `public ${publicField} accepted ${(cap as number) + 1} chars but intake.${intakeField} caps at ${cap}`).toBe(false);
    }
  });

  it("rejects a non-object body", () => {
    expect(validateGenerateBody(null).ok).toBe(false);
    expect(validateGenerateBody("str").ok).toBe(false);
  });
});

describe("deriveShellSlug", () => {
  it("slugifies a company name", () => {
    expect(deriveShellSlug("Acme Robotics!")).toBe("acme-robotics");
  });
  it("trims to <=40 chars and strips trailing dashes", () => {
    const s = deriveShellSlug("A".repeat(60));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
  });
  it("falls back to 'launch' on empty/garbage", () => {
    expect(deriveShellSlug("")).toBe("launch");
    expect(deriveShellSlug("!!!")).toBe("launch");
  });
});

describe("isModerationOutage", () => {
  it("is true only for our own sentinel", () => {
    expect(isModerationOutage("moderation_llm_error")).toBe(true);
  });

  it.each([
    "promotes unavailable medical treatments",
    "impersonates a rate limit provider",
    "content about a timeout lawsuit",
    "moderation_unparseable",
    "blocked",
  ])("is false for the verdict %j, which isUpstreamUnavailable would have mislabelled", (reason) => {
    expect(isModerationOutage(reason)).toBe(false);
  });

  it("differs from isUpstreamUnavailable on exactly the sentences that matter", () => {
    const trap = "promotes unavailable medical treatments";
    expect(isUpstreamUnavailable(trap)).toBe(true);
    expect(isModerationOutage(trap)).toBe(false);
  });
});

describe("count caps", () => {
  it("refuses a 4th metric line by name, not as a generic failure", () => {
    const r = validateGenerateBody({ ...good, metrics: "A|1\nB|2\nC|3\nD|4" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too_many_metrics");
  });

  it("accepts exactly 3, and ignores blank lines", () => {
    const r = validateGenerateBody({ ...good, metrics: "A|1\n\nB|2\n\nC|3\n" });
    expect(r.ok).toBe(true);
  });
});

describe("field caps the AUTHOR cannot satisfy", () => {
  it("refuses a 9th place by name", () => {
    const r = validateGenerateBody({
      ...good,
      regions: "California, Nevada, Texas, Arizona, Florida, New York, Washington, Oregon, Colorado",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too_many_regions");
  });

  it("accepts exactly 8 places", () => {
    const r = validateGenerateBody({
      ...good,
      regions: "California, Nevada, Texas, Arizona, Florida, New York, Washington, Oregon",
    });
    expect(r.ok).toBe(true);
  });

  it("refuses a metric VALUE the stat field cannot hold", () => {
    const r = validateGenerateBody({ ...good, metrics: "Revenue|$1.2 million in the last twelve months, give or take" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("metric_value_too_long");
  });

  it("accepts a normal metric line", () => {
    const r = validateGenerateBody({ ...good, metrics: "Revenue|$1.2M\nHosts|600+" });
    expect(r.ok).toBe(true);
  });
});

describe("the FLOORS, not just the ceilings", () => {
  it("one place cannot become a coverage scene, and says so", () => {
    const r = validateGenerateBody({ ...good, regions: "Austin" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("too_few_regions");
  });

  it("two places are fine", () => {
    const r = validateGenerateBody({ ...good, regions: "Austin, Dallas" });
    expect(r.ok).toBe(true);
  });

  it("an empty regions field still skips the scene rather than failing", () => {
    const r = validateGenerateBody({ ...good, regions: "" });
    expect(r.ok).toBe(true);
  });

  it.each(["Teachers", "Teachers|", "|400+", "  |  "])("refuses a half metric line: %j", (line) => {
    const r = validateGenerateBody({ ...good, metrics: line });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("metric_line_invalid");
  });
});

describe("the film allowlist tracks the films we actually ship", () => {
  it("accepts every theme the engine can draw", async () => {
    const { THEME_NAMES } = await import("@/services/launch-video/theme-film");
    for (const name of THEME_NAMES) {
      const r = validateGenerateBody({
        email: "a@b.co",
        product_name: "X",
        one_liner: "Y",
        cta_text: "Go",
        cta_url: "https://x.com",
        film: name,
      });
      expect(r.ok && r.value.form.film, `film ${name} must survive the door`).toBe(name);
    }
  });

  it("still falls back for a theme the engine cannot draw", () => {
    const r = validateGenerateBody({
      email: "a@b.co",
      product_name: "X",
      one_liner: "Y",
      cta_text: "Go",
      cta_url: "https://x.com",
      film: "not-a-film",
    });
    expect(r.ok && r.value.form.film).toBeUndefined();
  });
});
