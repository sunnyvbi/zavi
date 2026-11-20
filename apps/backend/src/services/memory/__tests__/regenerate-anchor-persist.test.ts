import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../upsert-anchor", () => ({
  upsertAnchor: vi.fn(async () => ({ note_id: "note-9", chunks: 2 })),
}));
vi.mock("@/services/llm/call-model", () => ({
  callModel: vi.fn(async () => ({
    text: `<anchor>${JSON.stringify({
      body_markdown: "# Policies\n\nRefunds within 7 days.",
      key_facts: [{ label: "Refunds", value: "7 days" }],
    })}</anchor>`,
    usage: { input_tokens: 10, output_tokens: 20 },
  })),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "not", "neq", "order", "limit", "in"]) q[m] = () => q;
      q.maybeSingle = async () => ({ data: { display_name: "Acme" }, error: null });
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return q;
    },
  }),
}));

import { regenerateAnchor } from "../generate-anchors";
import { upsertAnchor } from "../upsert-anchor";

const upsertMock = vi.mocked(upsertAnchor);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("regenerateAnchor persist option", () => {
  it("default: writes the anchor as agent_write and returns the written id", async () => {
    const out = await regenerateAnchor({ tenant_id: "t1", slug: "policies" });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0]).toMatchObject({
      tenant_id: "t1",
      slug: "policies",
      source: "agent_write",
      body_markdown: "# Policies\n\nRefunds within 7 days.",
      metadata: { key_facts: [{ label: "Refunds", value: "7 days" }] },
    });
    expect(out.note_id).toBe("note-9");
    expect(out.chunks).toBe(2);
  });

  it("persist:false: returns the body and key facts without writing", async () => {
    const out = await regenerateAnchor({ tenant_id: "t1", slug: "policies", persist: false });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(out.body_markdown).toBe("# Policies\n\nRefunds within 7 days.");
    expect(out.key_facts).toEqual([{ label: "Refunds", value: "7 days" }]);
    expect(out.note_id).toBe("");
    expect(out.chunks).toBe(0);
  });

  it("persist:false is refused for the company brief (always rendered + written from the record)", async () => {
    await expect(regenerateAnchor({ tenant_id: "t1", slug: "company", persist: false })).rejects.toThrow(
      /persist:false/,
    );
    expect(upsertMock).not.toHaveBeenCalled();
  });
});
