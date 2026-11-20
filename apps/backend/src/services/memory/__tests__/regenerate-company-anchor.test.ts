
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../upsert-anchor", () => ({
  upsertAnchor: vi.fn(async () => ({ note_id: "note-1", chunks: 3 })),
}));

vi.mock("@/services/llm/call-model", () => ({
  callModel: vi.fn(async () => {
    throw new Error("callModel must not be reached for the company anchor");
  }),
}));

let record = {
  name: "Upcar",
  nameIsWorkspaceLabel: false,
  website: "https://upcar.ai",
  competitors: ["Turo", "Getaround"],
  facts: {
    what_we_sell: { value: "Car rental from local owners", source: "human_confirmed" },
    company_story: { value: "Upcar rents cars from local owners.", source: "human_confirmed" },
  } as Record<string, { value: string; source: string }>,
};
vi.mock("@/services/company/facts", () => ({
  getCompanyFacts: async () => record,
}));

const noteRow: { id: string; body_markdown: string } | null = {
  id: "note-1",
  body_markdown: "# Upcar\n\nUpcar rents cars from local owners.",
};
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "not", "neq", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: noteRow, error: null });
      return q;
    },
  }),
}));

import { regenerateAnchor } from "../generate-anchors";
import { upsertAnchor } from "../upsert-anchor";
import { callModel } from "@/services/llm/call-model";

const upsertAnchorMock = vi.mocked(upsertAnchor);
const callModelMock = vi.mocked(callModel);

beforeEach(() => {
  vi.clearAllMocks();
  upsertAnchorMock.mockResolvedValue({ note_id: "note-1", chunks: 3 });
});

describe("regenerating the company anchor", () => {
  it("re-renders from the record and never calls a model", async () => {
    const out = await regenerateAnchor({ tenant_id: "t1", slug: "company" } as never);

    expect(callModelMock).not.toHaveBeenCalled();
    expect(out.slug).toBe("company");
    expect(out.tokens).toEqual({ input: 0, output: 0 });

    const written = upsertAnchorMock.mock.calls[0][0] as {
      slug: string;
      body_markdown: string;
      metadata?: { key_facts?: Array<{ label: string; value: string }> };
    };
    expect(written.slug).toBe("company");
    expect(written.body_markdown).toContain("Car rental from local owners");
  });

  it("writes key_facts so the card stops asking, sourced from the record", async () => {
    const out = await regenerateAnchor({ tenant_id: "t1", slug: "company" } as never);

    expect(out.key_facts).toBeDefined();
    const labels = (out.key_facts ?? []).map((f) => f.label);
    expect(labels).toContain("What they sell");
    expect(labels).toContain("Website");
    expect(labels).toContain("Competitors");

    const written = upsertAnchorMock.mock.calls[0][0] as {
      metadata?: { key_facts?: unknown };
    };
    expect(written.metadata?.key_facts).toBeDefined();
  });

  it("refuses instead of inventing when the record is empty", async () => {
    const saved = record;
    record = {
      name: null as unknown as string,
      nameIsWorkspaceLabel: false,
      website: null as unknown as string,
      competitors: [],
      facts: {},
    };
    try {
      await expect(
        regenerateAnchor({ tenant_id: "t1", slug: "company" } as never),
      ).rejects.toThrow(/company record/i);
      expect(callModelMock).not.toHaveBeenCalled();
      expect(upsertAnchorMock).not.toHaveBeenCalled();
    } finally {
      record = saved;
    }
  });
});
