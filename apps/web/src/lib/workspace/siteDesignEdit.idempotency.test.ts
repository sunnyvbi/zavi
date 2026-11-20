import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ apiFetch: vi.fn(), changed: vi.fn() }));

vi.mock("@/lib/api", () => ({
  apiFetch: h.apiFetch,
  IDEMPOTENCY_HEADER: "Idempotency-Key",
  newIdempotencyKey: () => "site-edit-key",
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: h.changed }));

import { saveSiteDesignEdit } from "./siteDesignEdit";

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("saveSiteDesignEdit idempotency", () => {
  beforeEach(() => {
    h.apiFetch.mockReset();
    h.changed.mockReset();
  });

  it("replays an in-progress paid edit with the same key until its result is available", async () => {
    h.apiFetch
      .mockResolvedValueOnce(response(409, { error: { code: "idempotency_in_progress", message: "Still working" } }))
      .mockResolvedValueOnce(response(200, { logo: { src: "/images/logo.svg?v=123" }, conductor_run_id: "run-1" }));

    await expect(saveSiteDesignEdit("site:s1", { kind: "logo", description: "angular fox" })).resolves.toMatchObject({
      ok: true,
      logo: { src: "/images/logo.svg?v=123" },
      changeId: "run-1",
    });
    expect(h.apiFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of h.apiFetch.mock.calls) {
      expect(init).toMatchObject({
        idempotent: true,
        headers: { "Idempotency-Key": "site-edit-key" },
      });
    }
    expect(h.changed).toHaveBeenCalledOnce();
  });
});
