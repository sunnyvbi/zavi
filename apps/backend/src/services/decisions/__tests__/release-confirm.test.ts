import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { rpc: { data: null as unknown, error: null as null | { message: string } }, left: [] as unknown[], readError: null as null | { message: string } };

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: async () => state.rpc,
  tenantClient: () => {
    const q = { from: () => q, select: () => q, eq: () => q, limit: async () => ({ data: state.left, error: state.readError }) };
    return q;
  },
}));

import { releaseAdSpendForObject } from "../ad-budget";

beforeEach(() => {
  state.rpc = { data: { status: "released" }, error: null };
  state.left = [];
  state.readError = null;
});

describe("releaseAdSpendForObject confirm", () => {
  it("released with nothing left is true", async () => {
    expect(await releaseAdSpendForObject("t", "chatgpt", "cmpn_1", { confirm: true })).toBe(true);
  });
  it("released but a committed hold is still on the object (e.g. another id) is false", async () => {
    state.left = [{ id: "h1" }];
    expect(await releaseAdSpendForObject("t", "chatgpt", "cmpn_1", { confirm: true })).toBe(false);
  });
  it("no_budget with no hold at all is true: there is nothing to be counted", async () => {
    state.rpc = { data: { status: "no_budget", released_usd: 0 }, error: null };
    expect(await releaseAdSpendForObject("t", "chatgpt", "cmpn_1", { confirm: true })).toBe(true);
  });
  it("no_budget with a committed hold left is false", async () => {
    state.rpc = { data: { status: "no_budget", released_usd: 0 }, error: null };
    state.left = [{ id: "h1" }];
    expect(await releaseAdSpendForObject("t", "chatgpt", "cmpn_1", { confirm: true })).toBe(false);
  });
  it("an unreadable read-back is false (never claims released)", async () => {
    state.readError = { message: "down" };
    expect(await releaseAdSpendForObject("t", "chatgpt", "cmpn_1", { confirm: true })).toBe(false);
  });
  it("without confirm it keeps its old meaning: true on any answer", async () => {
    state.left = [{ id: "h1" }];
    expect(await releaseAdSpendForObject("t", "chatgpt", "cmpn_1")).toBe(true);
  });
});
