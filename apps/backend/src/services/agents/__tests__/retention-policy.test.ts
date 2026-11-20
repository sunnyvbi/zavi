import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({ select }));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ from }),
}));

import { shouldStoreRawTranscripts } from "../retention-policy";

describe("shouldStoreRawTranscripts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    maybeSingle.mockReset();
  });

  it("returns true when the tenant has no policy row (the default)", async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { tenant_id: "t-1" }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    expect(await shouldStoreRawTranscripts("run-1")).toBe(true);
  });

  it("returns true when the policy says store_raw=true", async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { tenant_id: "t-1" }, error: null })
      .mockResolvedValueOnce({ data: { store_raw: true }, error: null });
    expect(await shouldStoreRawTranscripts("run-1")).toBe(true);
  });

  it("returns false when policy store_raw=false", async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { tenant_id: "t-1" }, error: null })
      .mockResolvedValueOnce({ data: { store_raw: false }, error: null });
    expect(await shouldStoreRawTranscripts("run-1")).toBe(false);
  });

  it("fails CLOSED when the policy read returns an error (it used to read as 'no policy' and store)", async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { tenant_id: "t-1" }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    expect(await shouldStoreRawTranscripts("run-1")).toBe(false);
  });

  it("fails CLOSED when the run read returns an error or finds no run", async () => {
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    expect(await shouldStoreRawTranscripts("run-1")).toBe(false);
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect(await shouldStoreRawTranscripts("run-1")).toBe(false);
  });

  it("fails CLOSED when a read throws", async () => {
    maybeSingle.mockRejectedValueOnce(new Error("db down"));
    expect(await shouldStoreRawTranscripts("run-1")).toBe(false);
    maybeSingle
      .mockResolvedValueOnce({ data: { tenant_id: "t-1" }, error: null })
      .mockRejectedValueOnce(new Error("db down"));
    expect(await shouldStoreRawTranscripts("run-1")).toBe(false);
  });
});
