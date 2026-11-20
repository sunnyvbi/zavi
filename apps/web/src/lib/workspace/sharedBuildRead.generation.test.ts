import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("./sessionScopedCache", () => ({ registerSessionScopedCache: () => {} }));

import { resetSharedBuildReads, sharedBuildRead } from "./useBuildPreview";

function reply(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

beforeEach(() => {
  apiFetch.mockReset();
  resetSharedBuildReads();
});

describe("shared build-status read across a sign-out", () => {
  it("a request still in flight when the account changes never fills the next account's cache", async () => {
    let finishOld!: (r: Response) => void;
    apiFetch.mockImplementationOnce(() => new Promise<Response>((r) => (finishOld = r)));
    const oldRead = sharedBuildRead("/api/workspace/autopilot/build-status?run_id=x");
    resetSharedBuildReads();
    finishOld(reply({ owner: "account-A" }));
    await oldRead;

    apiFetch.mockResolvedValueOnce(reply({ owner: "account-B" }));
    const next = await sharedBuildRead("/api/workspace/autopilot/build-status?run_id=x");
    expect(await next.json()).toEqual({ owner: "account-B" });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("within one account a settled read is still reused for a second", async () => {
    apiFetch.mockResolvedValue(reply({ owner: "account-A" }));
    await sharedBuildRead("/p");
    await sharedBuildRead("/p");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
