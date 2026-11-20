import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { checkFeature } from "./gatekeeper";

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

beforeEach(() => apiFetch.mockReset());

describe("checkFeature", () => {
  it("returns the server's answer", async () => {
    apiFetch.mockResolvedValue(json(200, { name: "x", enabled: true }));
    expect(await checkFeature("x")).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith("/api/gatekeeper/check/x");
  });

  it("fails closed on a non-200", async () => {
    apiFetch.mockResolvedValue(json(500, {}));
    expect(await checkFeature("x")).toBe(false);
  });

  it("fails closed on an unreadable body, or returns the caller's fallback", async () => {
    const broken = {
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("bad json")),
    } as unknown as Response;
    apiFetch.mockResolvedValue(broken);
    expect(await checkFeature("x")).toBe(false);
    expect(await checkFeature("x", true)).toBe(true);
  });

  it("treats a non-boolean enabled as off", async () => {
    apiFetch.mockResolvedValue(json(200, { enabled: "yes" }));
    expect(await checkFeature("x")).toBe(false);
  });
});
