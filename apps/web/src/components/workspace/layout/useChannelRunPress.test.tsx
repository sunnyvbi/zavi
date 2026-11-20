// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const ids: string[] = [];
let answer: () => Promise<Response>;
vi.mock("@/lib/api", () => ({
  apiFetch: async (_path: string, opts?: { body?: string }) => {
    ids.push((JSON.parse(opts?.body ?? "{}") as { request_id: string }).request_id);
    return answer();
  },
}));

import { useChannelRunPress } from "./useChannelRunPress";

const lost = () => Promise.reject(new Error("network down"));
const refused = () =>
  Promise.resolve({
    ok: false,
    status: 409,
    json: async () => ({ error: { message: "Locked." } }),
  } as unknown as Response);

beforeEach(() => {
  ids.length = 0;
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("SecurityError");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("SecurityError");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("SecurityError");
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useChannelRunPress without localStorage", () => {
  it("reuses the same request id on a retry and on a second mounted button", async () => {
    answer = lost;
    const a = renderHook(() => useChannelRunPress({ slug: "seo-mem-1", onRan: () => {} }));
    const b = renderHook(() => useChannelRunPress({ slug: "seo-mem-1", onRan: () => {} }));
    await act(() => a.result.current.press());
    await act(() => a.result.current.press());
    await act(() => b.result.current.press());
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });

  it("clears the held id on a refusal, so the next press is new", async () => {
    answer = refused;
    const { result } = renderHook(() => useChannelRunPress({ slug: "seo-mem-2", onRan: () => {} }));
    await act(() => result.current.press());
    await act(() => result.current.press());
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
