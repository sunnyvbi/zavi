// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { useChannelRunPress } from "./useChannelRunPress";

beforeEach(() => apiFetch.mockReset());
afterEach(cleanup);

describe("useChannelRunPress with a plan gate", () => {
  it("a locked channel: the upgrade, and no run request", async () => {
    const upgrade = vi.fn();
    const onRan = vi.fn();
    const { result } = renderHook(() =>
      useChannelRunPress({ slug: "seo-lock-1", onRan, planLock: { tierName: "Starter", upgrade } }),
    );
    await act(() => result.current.press());
    await act(() => result.current.press());
    expect(apiFetch).not.toHaveBeenCalled();
    expect(upgrade).toHaveBeenCalledTimes(2);
    expect(onRan).not.toHaveBeenCalled();
    expect(result.current.fired).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("a 403 plan_upgrade_required opens the upgrade for the tier named, not an error line", async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: { code: "plan_upgrade_required", required_tier: "starter", message: "This needs the Starter plan." },
      }),
    });
    const upgrade = vi.fn();
    const { result } = renderHook(() =>
      useChannelRunPress({ slug: "seo-lock-2", onRan: () => {}, planLock: { tierName: null, upgrade } }),
    );
    await act(() => result.current.press());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(upgrade).toHaveBeenCalledWith("starter");
    expect(result.current.error).toBeNull();
    expect(result.current.fired).toBe(false);
  });

  it("any other refusal keeps the server's sentence", async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: { message: "Locked." } }) });
    const upgrade = vi.fn();
    const { result } = renderHook(() =>
      useChannelRunPress({ slug: "seo-lock-3", onRan: () => {}, planLock: { tierName: null, upgrade } }),
    );
    await act(() => result.current.press());
    expect(upgrade).not.toHaveBeenCalled();
    expect(result.current.error).toBe("Locked.");
  });

  it("with no gate a run starts as before", async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ run_id: "run-12345678" }) });
    const onRan = vi.fn();
    const { result } = renderHook(() => useChannelRunPress({ slug: "seo-lock-4", onRan }));
    await act(() => result.current.press());
    expect(apiFetch).toHaveBeenCalledWith("/api/channels/seo-lock-4/run", expect.objectContaining({ method: "POST" }));
    expect(onRan).toHaveBeenCalledTimes(1);
  });
});
