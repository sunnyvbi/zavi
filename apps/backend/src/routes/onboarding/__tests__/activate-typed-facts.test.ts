
import { beforeEach, describe, expect, it, vi } from "vitest";

const writes: Array<{ key: string; value: string; ref: string }> = [];
const domains: Array<string | null> = [];
let fails = false;
let draftWizard: Record<string, unknown> | null = null;
let auditDomain: string | null = null;

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of [
        "select", "eq", "neq", "gte", "lte", "gt", "lt", "in", "is", "not",
        "contains", "order", "update", "insert", "upsert", "delete",
      ]) {
        q[m] = () => q;
      }
      q.limit = () => {
        q.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
        return q;
      };
      q.maybeSingle = async () => ({
        data: draftWizard || auditDomain ? { wizard: draftWizard ?? {}, resolved_domain: auditDomain } : null,
        error: null,
      });
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock("@/services/company/facts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/company/facts")>()),
  setCompanyFact: async (_t: string, key: string, value: string, ref: string) => {
    writes.push({ key, value, ref });
    return fails ? { ok: false, error: "rpc down" } : { ok: true, error: null };
  },
  setCompanyDomain: async (_t: string, url: string | null) => {
    domains.push(url);
    return { ok: true, error: null };
  },
}));

import { __test } from "../activate";

const { writeTypedFactsFromWizard, persistCompanyFacts } = __test as unknown as {
  writeTypedFactsFromWizard: (
    tenant_id: string,
    user_id: string,
    wizard: Record<string, unknown>,
    opts?: { skipWhatWeSell?: boolean },
  ) => Promise<void>;
  persistCompanyFacts: (
    tenant_id: string,
    user_id: string,
    onboardingMeta?: unknown,
  ) => Promise<void>;
};

beforeEach(() => {
  writes.length = 0;
  domains.length = 0;
  fails = false;
  draftWizard = null;
});

describe("onboarding writes the record", () => {
  it("saves the company name and description the founder typed", async () => {
    await writeTypedFactsFromWizard("t1", "u1", {
      orgName: "Upcar",
      freeText: "We rent cars from local owners, delivered to your door.",
    });
    expect(writes.map((w) => [w.key, w.value])).toEqual([
      ["company_name", "Upcar"],
      ["what_we_sell", "We rent cars from local owners, delivered to your door."],
      ["company_story", "We rent cars from local owners, delivered to your door."],
    ]);
    expect(writes[0].ref).toMatch(/typed by the operator/);
  });

  it("keeps the whole answer as the story, not just its first sentence", async () => {
    const full = `We are a marketplace for renting cars. ${"Owners list, guests book, we handle insurance and payouts. ".repeat(9)}`.trim();
    expect(full.length).toBeGreaterThan(500);
    await writeTypedFactsFromWizard("t1", "u1", { orgName: "Upcar", freeText: full });
    const story = writes.find((w) => w.key === "company_story")!.value;
    const description = writes.find((w) => w.key === "what_we_sell")!.value;
    expect(story).toBe(full);
    expect(description).toBe("We are a marketplace for renting cars.");
    expect(story.length).toBeGreaterThan(description.length);
  });

  it("skips what_we_sell when the caller projects its own", async () => {
    await writeTypedFactsFromWizard(
      "t1",
      "u1",
      { freeText: "Build an app that tracks habits." },
      { skipWhatWeSell: true },
    );
    expect(writes.map((w) => w.key)).toEqual(["company_story"]);
  });

  it("keeps the competitor appendix out of the story too", async () => {
    await writeTypedFactsFromWizard("t1", "u1", {
      orgName: "Upcar",
      freeText:
        "We rent cars from local owners.\n\nFounder-confirmed competitors to track: Turo (https://turo.com).",
    });
    const story = writes.find((w) => w.key === "company_story")!.value;
    expect(story).toBe("We rent cars from local owners.");
    expect(story).not.toMatch(/Turo|competitors/i);
  });

  it("keeps the Focus-first answer that both clients append AFTER the competitors", async () => {
    await writeTypedFactsFromWizard("t1", "u1", {
      orgName: "Upcar",
      freeText:
        "We rent cars.\n\nFounder-confirmed competitors to track: Turo (https://turo.com).\n\nFocus first: bookings",
    });
    const story = writes.find((w) => w.key === "company_story")!.value;
    expect(story).toBe("We rent cars.\n\nFocus first: bookings");
  });

  it("slices an over-long story to the column's ceiling instead of losing it", async () => {
    const huge = `We rent cars. ${"Background. ".repeat(1200)}`;
    expect(huge.length).toBeGreaterThan(8000);
    await writeTypedFactsFromWizard("t1", "u1", { orgName: "Upcar", freeText: huge });
    const story = writes.find((w) => w.key === "company_story")!.value;
    expect(story.length).toBe(8000);
    expect(huge.startsWith(story)).toBe(true);
  });

  it("never lets the appended competitor line into the description", async () => {
    await writeTypedFactsFromWizard("t1", "u1", {
      orgName: "Upcar",
      freeText:
        "We rent cars from local owners.\n\nFounder-confirmed competitors to track: Turo (https://turo.com), Getaround (https://getaround.com).",
    });
    const description = writes.find((w) => w.key === "what_we_sell")!.value;
    expect(description).toBe("We rent cars from local owners.");
    expect(description).not.toMatch(/Turo|competitors/i);
  });

  it("shortens a long answer to its first sentence rather than storing an essay", async () => {
    const long = `We are a marketplace for renting cars. ${"More background. ".repeat(40)}`;
    await writeTypedFactsFromWizard("t1", "u1", { orgName: "Upcar", freeText: long });
    const description = writes.find((w) => w.key === "what_we_sell")!.value;
    expect(description).toBe("We are a marketplace for renting cars.");
  });

  it("writes nothing for answers the founder left blank", async () => {
    await writeTypedFactsFromWizard("t1", "u1", { orgName: "   ", freeText: "" });
    expect(writes).toEqual([]);
  });

  it("does not throw when a write fails — activation must not break over a fact", async () => {
    fails = true;
    await expect(
      writeTypedFactsFromWizard("t1", "u1", { orgName: "Upcar", freeText: "Cars." }),
    ).resolves.toBeUndefined();
  });
});

describe("the wizard comes from THIS request, not only the legacy draft", () => {
  it("writes the facts /start sent when no draft row exists", async () => {
    await persistCompanyFacts("t1", "u1", {
      wizard: { orgName: "Upcar", freeText: "We rent cars from local owners." },
    });
    expect(writes.map((w) => [w.key, w.value])).toEqual([
      ["company_name", "Upcar"],
      ["what_we_sell", "We rent cars from local owners."],
      ["company_story", "We rent cars from local owners."],
    ]);
  });

  it("still reads the legacy draft when that is all there is", async () => {
    draftWizard = { orgName: "Legacy Co", freeText: "We do legacy things." };
    await persistCompanyFacts("t1", "u1", undefined);
    expect(writes.map((w) => [w.key, w.value])).toEqual([
      ["company_name", "Legacy Co"],
      ["what_we_sell", "We do legacy things."],
      ["company_story", "We do legacy things."],
    ]);
  });

  it("prefers this request over a stale draft for the same field", async () => {
    draftWizard = { orgName: "Stale Co", freeText: "Stale description." };
    await persistCompanyFacts("t1", "u1", { wizard: { orgName: "Fresh Co" } });
    const byKey = Object.fromEntries(writes.map((w) => [w.key, w.value]));
    expect(byKey.company_name).toBe("Fresh Co");
    expect(byKey.what_we_sell).toBe("Stale description.");
  });
});

describe("the company website", () => {
  it("is saved for the founder's own site", async () => {
    await persistCompanyFacts("t1", "u1", { wizard: { website: "https://www.greenfarm.com/about" } });
    expect(domains).toEqual(["https://www.greenfarm.com"]);
  });

  it("is not saved when the founder gave a social profile", async () => {
    for (const website of [
      "https://www.facebook.com/greenfarm",
      "m.facebook.com/greenfarm",
      "instagram.com/greenfarm",
      "linktr.ee/greenfarm",
      "https://www.amazon.co.uk/stores/greenfarm",
      "https://apps.apple.com/us/app/greenfarm/id123",
    ]) {
      domains.length = 0;
      await persistCompanyFacts("t1", "u1", {
        wizard: {
          website,
          _enrichment: { domain_pages: [{ url: "https://www.facebook.com/" }] },
        },
      });
      expect(domains, website).toEqual([]);
    }
  });

  it("does not fall back to an earlier scan when the founder gave a social profile", async () => {
    auditDomain = "acme.com";
    try {
      domains.length = 0;
      await persistCompanyFacts("t1", "u1", { wizard: {} });
      expect(domains).toEqual(["https://acme.com"]);
      domains.length = 0;
      await persistCompanyFacts("t1", "u1", { wizard: { website: "https://www.facebook.com/bluefarm" } });
      expect(domains).toEqual([]);
    } finally {
      auditDomain = null;
    }
  });
});
