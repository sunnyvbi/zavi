// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: fetchMock }));

import { __resetProductUrlCache, __loadProductUrlForTest } from "./useProductUrl";

const ok = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(() => {
  __resetProductUrlCache();
  fetchMock.mockReset();
});
afterEach(() => {
  __resetProductUrlCache();
});

describe("product-url read caching", () => {
  it("retries after a failed read", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network"));
    await __loadProductUrlForTest();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(
      ok({ product_url: { marketing: "https://www.upcar.ai" } }),
    );
    await __loadProductUrlForTest();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT refetch after a successful read", async () => {
    fetchMock.mockResolvedValueOnce(ok({ product_url: {} }));
    await __loadProductUrlForTest();
    await __loadProductUrlForTest();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a non-2xx response as a failure, and retries it", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await __loadProductUrlForTest();
    fetchMock.mockResolvedValueOnce(ok({ product_url: {} }));
    await __loadProductUrlForTest();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
