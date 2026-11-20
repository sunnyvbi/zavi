
import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: apiFetchMock }));

import { loadSummary } from "./summaryState";
import { EMPTY_SUMMARY } from "./summary";

function res(init: { status?: number; ok?: boolean; json?: () => unknown }) {
  return {
    status: init.status ?? 200,
    ok: init.ok ?? true,
    json: init.json ?? (async () => ({})),
  } as unknown as Response;
}

describe("loadSummary classification", () => {
  beforeEach(() => apiFetchMock.mockReset());

  it("409 no_active_tenant → no_tenant (sent to /start; nothing is lazy-provisioned)", async () => {
    apiFetchMock.mockResolvedValue(res({ status: 409, ok: false }));
    expect(await loadSummary()).toEqual({ status: "no_tenant" });
  });

  it("non-ok (500) → error", async () => {
    apiFetchMock.mockResolvedValue(res({ status: 500, ok: false }));
    expect(await loadSummary()).toEqual({ status: "error" });
  });

  it("200 valid → ok with normalized summary", async () => {
    apiFetchMock.mockResolvedValue(
      res({ json: async () => ({ ...EMPTY_SUMMARY, spend_total_usd: 9 }) }),
    );
    const r = await loadSummary();
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.summary.spend_total_usd).toBe(9);
  });

  it("200 malformed → ok with a SAFE normalized payload (no throw, no fake-empty error)", async () => {
    apiFetchMock.mockResolvedValue(
      res({ json: async () => ({ spend_week: "x", spend_total_usd: null }) }),
    );
    const r = await loadSummary();
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.summary.spend_week).toEqual([]);
      expect(r.summary.spend_total_usd).toBe(0);
    }
  });

  it("200 but res.json() throws → error", async () => {
    apiFetchMock.mockResolvedValue(
      res({
        json: async () => {
          throw new Error("bad json");
        },
      }),
    );
    expect(await loadSummary()).toEqual({ status: "error" });
  });

  it("real-empty 200 → ok with the empty summary (NOT error)", async () => {
    apiFetchMock.mockResolvedValue(res({ json: async () => EMPTY_SUMMARY }));
    const r = await loadSummary();
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.summary).toEqual(EMPTY_SUMMARY);
  });
});
