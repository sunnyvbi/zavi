import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantClient: vi.fn(),
}));

import { creatorFacingProblems, proposeCreativeBriefTool } from "../propose_creative_brief";
import { tenantClient } from "@/services/tenant-client";
import { ExpectedToolError } from "@/services/tools/types";

const mockTenantClient = tenantClient as unknown as ReturnType<typeof vi.fn>;

function stubDb(result: { data?: unknown; error?: { message: string } | null }) {
  const insert = vi.fn();
  const from = vi.fn();
  mockTenantClient.mockReturnValue({
    from: from.mockImplementation((table: string) => ({
      insert: insert.mockImplementation((row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => ({ data: result.data ?? null, error: result.error ?? null }),
        }),
        __row: row,
      })),
    })),
  });
  return { insert, from };
}

const okRow = {
  id: "11111111-2222-3333-4444-555555555555",
  utm_campaign: "zavi-brief-11111111",
  status: "draft",
  title: "Fresh hook for Gig Rentals",
};

const validInput = {
  title: "Fresh hook for Gig Rentals",
  angle: "Lead with the weekend-trip use case, not the price.",
  hook: "I rented this for $40 and it paid for my whole weekend.",
  format: "9:16 UGC talking-head, 20-30s",
  deliverables: 2,
  rationale: "Gig Rentals CTR halved over 14d at frequency 3.1 — the creative is burned, not the targeting.",
  evidence: [
    { claim: "Gig Rentals: CTR 0.9% -> 0.4% over 14d", source: "meta_ads__list_ads" },
    { claim: "frequency 3.1 on the same ad set", source: "growth__read_ads_perf" },
  ],
  source_campaign_ref: "Gig Rentals Purchase",
  budget_usd: 600,
};

const ctx = { tenant_id: "tenant-A", log: () => {}, run_id: "run-abc" };

describe("proposeCreativeBriefTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the brief and returns the attribution tag", async () => {
    stubDb({ data: okRow });
    const out = (await proposeCreativeBriefTool.execute(ctx, validInput)) as {
      brief_id: string;
      utm_campaign: string;
      status: string;
      next_step: string;
    };
    expect(out.brief_id).toBe(okRow.id);
    expect(out.utm_campaign).toBe("zavi-brief-11111111");
    expect(out.status).toBe("draft");
    expect(out.next_step).toContain("zavi-brief-11111111");
  });

  it("scopes the write to ctx.tenant_id, not anything the model supplied", async () => {
    const { from } = stubDb({ data: okRow });
    await proposeCreativeBriefTool.execute(
      ctx,
      { ...validInput, tenant_id: "tenant-EVIL" } as never,
    );
    expect(mockTenantClient).toHaveBeenCalledWith("tenant-A");
    expect(from).toHaveBeenCalledWith("creator_briefs");
  });

  it("takes source_run_id from ctx, never from input", async () => {
    const { insert } = stubDb({ data: okRow });
    await proposeCreativeBriefTool.execute(
      ctx,
      { ...validInput, source_run_id: "run-SPOOFED" } as never,
    );
    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.source_run_id).toBe("run-abc");
    expect(row.status).toBe("draft");
    expect(Object.keys(row)).not.toContain("tenant_id");
  });

  it("refuses a brief with no evidence", async () => {
    stubDb({ data: okRow });
    await expect(
      proposeCreativeBriefTool.execute(ctx, { ...validInput, evidence: [] }),
    ).rejects.toThrow();
  });

  it("refuses evidence that carries no source", async () => {
    stubDb({ data: okRow });
    await expect(
      proposeCreativeBriefTool.execute(ctx, {
        ...validInput,
        evidence: [{ claim: "CTR is down" }] as never,
      }),
    ).rejects.toThrow();
  });

  it("turns a DB error VALUE (not a throw) into a recoverable ExpectedToolError", async () => {
    stubDb({ data: null, error: { message: "duplicate key" } });
    await expect(proposeCreativeBriefTool.execute(ctx, validInput)).rejects.toBeInstanceOf(
      ExpectedToolError,
    );
  });

  it("tells the agent to preserve the work when the write fails", async () => {
    stubDb({ data: null, error: { message: "boom" } });
    await expect(proposeCreativeBriefTool.execute(ctx, validInput)).rejects.toThrow(
      /operator/i,
    );
  });

  it("defaults deliverables to 1 and budget to null when omitted", async () => {
    const { insert } = stubDb({ data: okRow });
    const { deliverables, budget_usd, ...rest } = validInput;
    void deliverables;
    void budget_usd;
    await proposeCreativeBriefTool.execute(ctx, rest as never);
    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.deliverables).toBe(1);
    expect(row.budget_usd).toBeNull();
  });
});

describe("creator-facing brief text", () => {
  const plain = {
    title: "Film yourself booking a weekend car on Upcar",
    angle: "Upcar rents cars from local owners. You search a real 3-day trip, read the daily prices, pick one car and say what you think.",
    hook: "1. I looked up a three-day rental near me. 2. I picked the exact car I wanted. Film each opening separately; the rest of the video stays the same.",
    format: "Vertical video, 30 to 45 seconds, your face and your screen",
  };

  it("accepts a brief written in plain words for the creator", () => {
    expect(creatorFacingProblems(plain)).toEqual([]);
  });

  it("does not refuse a product or phrase that says 'the body'", () => {
    expect(creatorFacingProblems({ ...plain, title: "Show how The Body Pillow supports you", hook: "\"My back finally rests.\"" })).toEqual([]);
  });

  it("names every field that reads like an internal test plan", () => {
    expect(
      creatorFacingProblems({
        title: "Upcar: first real rental from a local owner, price on screen",
        angle: "Creator searches Upcar. One variable: which of three hooks opens the same body best.",
        hook: 'A (price): "I looked it up." B (choice): "I picked it." C (who): "A local owner."',
        format: "Screen and Face, 30-45s vertical, 3 hook takes + one body, raw clips",
      }),
    ).toEqual([
      "angle: testing language",
      "angle: 'body' or 'takes'",
      "hook: internal labels like 'A (price):'",
      "format: 'body' or 'takes'",
      "format: production shorthand",
    ]);
  });

  it("refuses to save jargon and tells the agent what to fix, writing nothing", async () => {
    const { insert } = stubDb({ data: okRow });
    await expect(
      proposeCreativeBriefTool.execute(ctx, {
        ...validInput,
        angle: "One variable: which hook opens the same body best.",
      }),
    ).rejects.toMatchObject({ code: "brief_not_creator_facing" });
    expect(insert).not.toHaveBeenCalled();
  });
});

