import { beforeEach, describe, expect, it, vi } from "vitest";

const state: {
  draftRow: { value: unknown } | null;
  readError: { message: string } | null;
  writeError: { message: string } | null;
  writes: unknown[];
  brandVoice: string;
  failStatus: string | null;
} = { draftRow: null, readError: null, writeError: null, writes: [], brandVoice: "", failStatus: null };

function chain(result: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "neq", "is", "not"]) c[m] = () => c;
  c.maybeSingle = async () => result();
  c.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
  return c;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: () => ({
    from: (table: string) => {
      if (table === "tenant_app_setting")
        return {
          ...chain(() => ({ data: state.draftRow, error: state.readError })),
          upsert: async (row: unknown) => {
            state.writes.push(row);
            const status = (row as { value: { status: string } }).value.status;
            return { error: status === state.failStatus ? { message: "flaky" } : state.writeError };
          },
        };
      if (table === "tenant_personalization")
        return chain(() => ({ data: { brand_voice: state.brandVoice }, error: null }));
      return chain(() => ({ data: [], error: null }));
    },
  }),
}));

const model = vi.fn();
vi.mock("@/services/anthropic", () => ({
  createMessageWithFailover: (...a: unknown[]) => model(...a),
  hasAnthropicAuth: () => true,
  DEFAULT_FAST_MODEL: "fast",
}));
vi.mock("@/services/onboarding/enrichment/discover", () => ({
  safeFetchText: async () => `<p>${"Plain words about the company. ".repeat(20)}</p>`,
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => {} }));
vi.mock("../facts", () => ({
  getCompanyFacts: async () => ({
    name: "Acme",
    website: "acme.com",
    facts: { what_we_sell: { value: "AI" } },
  }),
}));

import { getOrCreateDraft } from "../description-draft";

beforeEach(() => {
  state.draftRow = null;
  state.readError = null;
  state.writeError = null;
  state.writes = [];
  state.brandVoice = "";
  state.failStatus = null;
  model.mockReset();
  model.mockResolvedValue({
    content: [{ type: "text", text: '{"description": "Acme sells tools. It serves small teams."}' }],
  });
});

describe("getOrCreateDraft", () => {
  it("serves a stored draft without calling the model", async () => {
    state.draftRow = { value: { status: "ready", value: "Stored. Two sentences.", from: "x", at: new Date().toISOString() } };
    const d = await getOrCreateDraft("t1", "company_description");
    expect(d).toMatchObject({ status: "ready", value: "Stored. Two sentences." });
    expect(model).not.toHaveBeenCalled();
  });

  it("keeps a dismissal: no model call, nothing rewritten", async () => {
    state.draftRow = { value: { status: "dismissed", at: new Date().toISOString() } };
    expect(await getOrCreateDraft("t1", "company_description")).toMatchObject({ status: "dismissed" });
    expect(model).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  });

  it("treats a failed read as a failure, never as 'no draft yet'", async () => {
    state.readError = { message: "boom" };
    await expect(getOrCreateDraft("t1", "company_description")).rejects.toThrow(/draft read failed/);
    expect(model).not.toHaveBeenCalled();
  });

  it("stops before the model when the pending claim cannot be stored", async () => {
    state.writeError = { message: "denied" };
    await expect(getOrCreateDraft("t1", "company_description")).rejects.toThrow(/draft write failed/);
    expect(model).not.toHaveBeenCalled();
  });

  it("drafts once and stores the result", async () => {
    const d = await getOrCreateDraft("t1", "company_description");
    expect(d).toMatchObject({ status: "ready", value: "Acme sells tools. It serves small teams." });
    expect(model).toHaveBeenCalledTimes(1);
    expect(state.writes.map((w) => (w as { value: { status: string } }).value.status)).toEqual(["pending", "ready"]);
  });

  it("never stores 'none' over a paid-for draft whose save failed", async () => {
    state.failStatus = "ready";
    await expect(getOrCreateDraft("t1", "company_description")).rejects.toThrow(/draft write failed/);
    const statuses = state.writes.map((w) => (w as { value: { status: string } }).value.status);
    expect(statuses).toEqual(["pending", "ready"]);
  });

  it("serves a fresh 'none' without retrying", async () => {
    state.draftRow = { value: { status: "none", at: new Date().toISOString() } };
    expect(await getOrCreateDraft("t1", "company_description")).toMatchObject({ status: "none" });
    expect(model).not.toHaveBeenCalled();
  });

  it("retries a cold 'none': one thin or failed look is not forever", async () => {
    state.draftRow = { value: { status: "none", at: new Date(Date.now() - 2 * 3600_000).toISOString() } };
    const d = await getOrCreateDraft("t1", "company_description");
    expect(d).toMatchObject({ status: "ready" });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("counts a retry that reached the model and came back empty", async () => {
    state.draftRow = { value: { status: "none", paid: 1, at: new Date(Date.now() - 2 * 3600_000).toISOString() } };
    model.mockRejectedValue(new Error("timeout"));
    expect(await getOrCreateDraft("t1", "company_description")).toMatchObject({ status: "none", paid: 2 });
    expect(model).toHaveBeenCalled();
  });

  it("carries the paid count through the pending claim", async () => {
    state.draftRow = { value: { status: "none", paid: 1, at: new Date(Date.now() - 2 * 3600_000).toISOString() } };
    await getOrCreateDraft("t1", "company_description");
    expect(state.writes[0]).toMatchObject({ value: { status: "pending", paid: 1 } });
  });

  it("keeps a cold 'none' that already spent its one paid retry", async () => {
    state.draftRow = { value: { status: "none", paid: 2, at: new Date(Date.now() - 2 * 3600_000).toISOString() } };
    expect(await getOrCreateDraft("t1", "company_description")).toMatchObject({ status: "none", paid: 2 });
    expect(model).not.toHaveBeenCalled();
  });

  it("drafts no brand voice when one is already set", async () => {
    state.brandVoice = "Plain and direct.";
    expect(await getOrCreateDraft("t1", "brand_voice")).toBeNull();
    expect(model).not.toHaveBeenCalled();
  });
});
