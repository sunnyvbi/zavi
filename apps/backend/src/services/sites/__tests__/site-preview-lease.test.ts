import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rpc: vi.fn(async (_tid: string, _name: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }> => ({ data: null, error: null })),
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: (tid: string, name: string, args: Record<string, unknown>) => h.rpc(tid, name, args),
}));

import {
  claimSiteDirectChangeLease,
  claimSiteEditLease,
  claimSiteLease,
  releaseHeldSiteLeases,
  releaseSiteLease,
  siteLeaseHeld,
  siteLeasesHeldHere,
  SITE_DIRECT_CHANGE_LEASE_TTL_S,
  SITE_LEASE_TTL_S,
} from "../site-preview-lease";

const T = "11111111-1111-4111-8111-111111111111";
const S = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  h.rpc.mockReset();
});

describe("site preview lease", () => {
  it("claims through the tenant-scoped RPC with the kind's ttl and returns the token", async () => {
    h.rpc.mockResolvedValueOnce({ data: [{ token: "tok-1", held_kind: null }], error: null });
    expect(await claimSiteLease(T, S, "restart")).toEqual({ token: "tok-1" });
    expect(h.rpc).toHaveBeenCalledWith(T, "claim_site_preview_lease", { p_site_id: S, p_kind: "restart", p_ttl_seconds: SITE_LEASE_TTL_S.restart });
  });

  it("says who holds a taken lease", async () => {
    h.rpc.mockResolvedValueOnce({ data: [{ token: null, held_kind: "edit" }], error: null });
    expect(await claimSiteLease(T, S, "restart")).toEqual({ token: null, held: "edit" });
  });

  it("fails closed: an RPC error or a throw reads as held by an unknown holder, never as free", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    expect(await claimSiteLease(T, S, "wake")).toEqual({ token: null, held: "unknown" });
    h.rpc.mockRejectedValueOnce(new Error("network"));
    expect(await claimSiteLease(T, S, "edit")).toEqual({ token: null, held: "unknown" });
    h.rpc.mockRejectedValueOnce(new Error("network"));
    expect(await siteLeaseHeld(T, S)).toBe("unknown");
  });

  it("releases by token, or by kind", async () => {
    await releaseSiteLease(T, S, { token: "tok-1" });
    expect(h.rpc).toHaveBeenLastCalledWith(T, "release_site_preview_lease", { p_site_id: S, p_token: "tok-1", p_kind: null });
    await releaseSiteLease(T, S, { kind: "restart" });
    expect(h.rpc).toHaveBeenLastCalledWith(T, "release_site_preview_lease", { p_site_id: S, p_token: null, p_kind: "restart" });
  });

  it("an edit claim hands back its own release", async () => {
    h.rpc.mockResolvedValueOnce({ data: [{ token: "tok-e", held_kind: null }], error: null });
    const lease = await claimSiteEditLease(T, S);
    expect("release" in lease).toBe(true);
    if ("release" in lease) await lease.release();
    expect(h.rpc).toHaveBeenLastCalledWith(T, "release_site_preview_lease", { p_site_id: S, p_token: "tok-e", p_kind: null });
    h.rpc.mockResolvedValueOnce({ data: [{ token: null, held_kind: "restart" }], error: null });
    expect(await claimSiteEditLease(T, S)).toEqual({ held: "restart" });
  });

  it("keeps a direct change leased through paid media generation", async () => {
    h.rpc.mockResolvedValueOnce({ data: [{ token: "tok-d", held_kind: null }], error: null });
    const lease = await claimSiteDirectChangeLease(T, S);
    expect(h.rpc).toHaveBeenCalledWith(T, "claim_site_preview_lease", {
      p_site_id: S,
      p_kind: "edit",
      p_ttl_seconds: SITE_DIRECT_CHANGE_LEASE_TTL_S,
    });
    expect("release" in lease).toBe(true);
  });
});

describe("leases held by this process at shutdown", () => {
  it("releases every lease this process still holds, by its own token, and none it already gave back", async () => {
    await releaseHeldSiteLeases();
    h.rpc.mockReset();
    h.rpc.mockResolvedValueOnce({ data: [{ token: "wake-tok", held_kind: null }], error: null });
    h.rpc.mockResolvedValueOnce({ data: [{ token: "edit-tok", held_kind: null }], error: null });
    await claimSiteLease(T, S, "wake");
    const edit = await claimSiteEditLease(T, "44444444-4444-4444-8444-444444444444");
    expect(siteLeasesHeldHere()).toBe(2);
    if ("release" in edit) await edit.release();
    expect(siteLeasesHeldHere()).toBe(1);
    h.rpc.mockClear();
    expect(await releaseHeldSiteLeases()).toBe(1);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledWith(T, "release_site_preview_lease", { p_site_id: S, p_token: "wake-tok", p_kind: null });
    expect(siteLeasesHeldHere()).toBe(0);
  });

  it("never holds shutdown past its time limit when the release hangs", async () => {
    h.rpc.mockResolvedValueOnce({ data: [{ token: "slow-tok", held_kind: null }], error: null });
    await claimSiteLease(T, S, "restart");
    h.rpc.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    expect(await releaseHeldSiteLeases(50)).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a refused claim is not tracked", async () => {
    await releaseHeldSiteLeases(10);
    h.rpc.mockReset();
    h.rpc.mockResolvedValueOnce({ data: [{ token: null, held_kind: "edit" }], error: null });
    await claimSiteLease(T, S, "wake");
    expect(siteLeasesHeldHere()).toBe(0);
  });
});
