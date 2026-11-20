// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn());
const clearers = vi.hoisted(() => [] as Array<() => void>);
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("./sessionScopedCache", () => ({ registerSessionScopedCache: (c: () => void) => clearers.push(c) }));
vi.mock("./tenantSwitch", () => ({ TENANT_SWITCH_EVENT: "tenant-switch" }));

import { sharedJson } from "./sharedRead";

const ok = (body: unknown) => ({ ok: true, json: async () => body });

describe("sharedJson", () => {
  beforeEach(() => apiFetch.mockReset());

  it("two callers at once make one request and both get the answer", async () => {
    apiFetch.mockResolvedValue(ok({ n: 1 }));
    const [a, b] = await Promise.all([sharedJson("/x"), sharedJson("/x")]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
  });

  it("keeps nothing once the read lands", async () => {
    apiFetch.mockResolvedValue(ok({}));
    await sharedJson("/x");
    await sharedJson("/x");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("a fresh read does not join one from before a change", async () => {
    apiFetch.mockResolvedValueOnce(ok({ v: "old" })).mockResolvedValueOnce(ok({ v: "new" }));
    const [a, b] = await Promise.all([sharedJson("/x"), sharedJson("/x", { fresh: true })]);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(a).toEqual({ v: "old" });
    expect(b).toEqual({ v: "new" });
  });

  it("a failed read is null, and a failure does not stick", async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 500 }).mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce(ok({ v: 1 }));
    expect(await sharedJson("/x")).toBeNull();
    expect(await sharedJson("/x")).toBeNull();
    expect(await sharedJson("/x")).toEqual({ v: 1 });
  });

  it("does not join a read that has been on the wire too long", async () => {
    vi.useFakeTimers();
    try {
      apiFetch.mockReturnValueOnce(new Promise(() => {})).mockResolvedValueOnce(ok({ v: "next" }));
      void sharedJson("/stuck");
      vi.advanceTimersByTime(11_000);
      expect(await sharedJson("/stuck")).toEqual({ v: "next" });
      expect(apiFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("after a sign-out a new caller does not join the old read", async () => {
    let finish!: (v: unknown) => void;
    apiFetch.mockReturnValueOnce(new Promise((r) => (finish = r))).mockResolvedValueOnce(ok({ who: "next" }));
    const before = sharedJson("/x");
    for (const clear of clearers) clear();
    expect(await sharedJson("/x")).toEqual({ who: "next" });
    finish(ok({ who: "prior" }));
    expect(await before).toEqual({ who: "prior" });
  });
});
