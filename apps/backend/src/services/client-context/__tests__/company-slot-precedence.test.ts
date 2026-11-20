
import { describe, it, expect } from "vitest";
import { __test } from "../sections";

const buildProfileSlots = (input: never) =>
  __test.buildSlots(__test.PROFILE_SLOTS, input);

type Fact = { value_text: string; source: string; verified_at: string | null };

function input(over: {
  saved?: Record<string, string> | null;
  facts?: Record<string, Fact>;
}) {
  return {
    saved: over.saved ?? null,
    facts: new Map(Object.entries(over.facts ?? {})),
    metrics: new Map(),
    previous: new Map(),
    estimated: new Map(),
    slackHumans: null,
  } as never;
}

type Slot = { key: string; value: string | null; source: string | null };

function slot(slots: Slot[], key: string): Slot | undefined {
  return slots.find((s) => s.key === key);
}

describe("company slots pick the best-sourced value, not the first listed", () => {
  it("the founder's own correction beats a stale staff value", () => {
    const slots = buildProfileSlots(
      input({
        saved: { category: "P2P car rental marketplace", updated_at: "2026-01-01" },
        facts: {
          what_we_sell: {
            value_text: "Long-term car subscriptions",
            source: "human_confirmed",
            verified_at: "2026-09-12",
          },
        },
      }),
    );
    const category = slot(slots, "category");
    expect(category?.value).toBe("Long-term car subscriptions");
    expect(category?.source).toBe("human_confirmed");
  });

  it("keeps the staff value when the record's is lower-ranked", () => {
    const slots = buildProfileSlots(
      input({
        saved: { category: "P2P car rental marketplace", updated_at: "2026-01-01" },
        facts: {
          what_we_sell: {
            value_text: "a guess from onboarding",
            source: "onboarding_enrichment",
            verified_at: "2026-09-12",
          },
        },
      }),
    );
    expect(slot(slots, "category")?.value).toBe("P2P car rental marketplace");
  });

  it("still answers from staff alone when the record is empty", () => {
    const slots = buildProfileSlots(
      input({ saved: { category: "P2P car rental marketplace", updated_at: "2026-01-01" } }),
    );
    expect(slot(slots, "category")?.value).toBe("P2P car rental marketplace");
  });

  it("reads industry, founded and location from the record too", () => {
    const slots = buildProfileSlots(
      input({
        saved: null,
        facts: {
          industry: { value_text: "Mobility", source: "human_confirmed", verified_at: null },
          founded: { value_text: "2023", source: "human_confirmed", verified_at: null },
          location: { value_text: "Fremont, CA", source: "human_confirmed", verified_at: null },
        },
      }),
    );
    expect(slot(slots, "industry")?.value).toBe("Mobility");
    expect(slot(slots, "founded")?.value).toBe("2023");
    expect(slot(slots, "location")?.value).toBe("Fremont, CA");
  });

  it("an unknown source loses to a known one", () => {
    const slots = buildProfileSlots(
      input({
        saved: { category: "Staff answer", updated_at: "2026-01-01" },
        facts: {
          what_we_sell: {
            value_text: "from somewhere new",
            source: "some_future_source",
            verified_at: null,
          },
        },
      }),
    );
    expect(slot(slots, "category")?.value).toBe("Staff answer");
  });
});
