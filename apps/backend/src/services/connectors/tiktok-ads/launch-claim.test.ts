import { beforeEach, describe, expect, it, vi } from "vitest";
type Claim = { advertiser_id: string; action_id: string; token: string; claimed_at: string };
const t = vi.hoisted(() => ({
  row: null as null | Claim,
  cards: {} as Record<string, { exec_status: string | null; exec_claimed_at: string | null }>,
  failInsert: null as null | string,
  failDelete: false,
  open: [] as Array<{ action_id: string; status: string; exec_status: string | null }>,
}));
vi.mock("@/services/growth/pending-test-claim", () => ({ openChannelCards: async () => t.open }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (x: string) => x,
  tenantClient: () => ({
    from: (table: string) => {
      const f: Record<string, unknown> = {};
      let op = "select";
      let patch: Record<string, unknown> = {};
      const q: Record<string, unknown> = {
        insert: async (r: Claim) => {
          if (t.failInsert) return { error: { code: t.failInsert, message: "x" } };
          if (t.row && t.row.advertiser_id === r.advertiser_id) return { error: { code: "23505", message: "duplicate" } };
          t.row = { ...r };
          return { error: null };
        },
        select: () => q,
        update: (p: Record<string, unknown>) => ((op = "update"), (patch = p), q),
        delete: () => ((op = "delete"), q),
        eq: (k: string, v: unknown) => ((f[k] = v), q),
        maybeSingle: async () => {
          if (table === "channel_actions") return { data: t.cards[String(f.id)] ?? null, error: null };
          return { data: t.row, error: null };
        },
        then: (res: (v: unknown) => unknown) => {
          const match = !!t.row && Object.entries(f).every(([k, v]) => (t.row as Record<string, unknown>)[k] === v);
          if (op === "update") {
            if (match) t.row = { ...t.row!, ...(patch as Partial<Claim>) };
            return Promise.resolve({ data: match ? [{ action_id: t.row!.action_id }] : [], error: null }).then(res);
          }
          if (op === "delete") {
            if (t.failDelete) return Promise.resolve({ data: null, error: { message: "down" } }).then(res);
            if (match) t.row = null;
          }
          return Promise.resolve({ data: null, error: null }).then(res);
        },
      };
      return q;
    },
  }),
}));
import { claimLaunch, EXEC_LEASE_MS, otherLaunchesExecuting } from "./launch-claim";

const NOW = new Date("2026-10-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
beforeEach(() => {
  t.row = null;
  t.cards = {};
  t.failInsert = null;
  t.failDelete = false;
  t.open = [];
});

describe("claimLaunch: an exclusive, fenced lease", () => {
  it("while the holder card is dispatching under a live lease, every other claim is refused, the same card included", async () => {
    t.cards["card-a"] = { exec_status: "dispatching", exec_claimed_at: ago(60_000) };
    await claimLaunch("T", "1", "card-a", NOW);
    await expect(claimLaunch("T", "1", "card-b", NOW)).rejects.toMatchObject({ code: "tiktok_ads_launch_in_flight", message: expect.stringContaining("card-a") });
    await expect(claimLaunch("T", "1", "card-a", NOW)).rejects.toMatchObject({ code: "tiktok_ads_launch_in_flight" });
  });

  it("taken over only when the holder is not running: not dispatching, lease over, or the claim predates its current dispatch", async () => {
    const cases: Array<{ exec_status: string | null; exec_claimed_at: string | null; claimed_at: string }> = [
      { exec_status: "failed", exec_claimed_at: ago(60_000), claimed_at: ago(30_000) },
      { exec_status: "dispatching", exec_claimed_at: ago(EXEC_LEASE_MS + 1000), claimed_at: ago(EXEC_LEASE_MS) },
      { exec_status: "dispatching", exec_claimed_at: ago(10_000), claimed_at: ago(3_600_000) },
    ];
    for (const c of cases) {
      t.row = { advertiser_id: "1", action_id: "card-a", token: "old", claimed_at: c.claimed_at };
      t.cards["card-a"] = { exec_status: c.exec_status, exec_claimed_at: c.exec_claimed_at };
      const claim = await claimLaunch("T", "1", "card-b", NOW);
      expect(t.row).toMatchObject({ action_id: "card-b", token: claim.token });
      expect(claim.token).not.toBe("old");
    }
  });

  it("every acquisition gets a new token; verify() fails once another run took the claim over", async () => {
    t.cards["card-a"] = { exec_status: "dispatching", exec_claimed_at: ago(1000) };
    const a = await claimLaunch("T", "1", "card-a", NOW);
    await a.verify();
    t.row!.token = "someone-else";
    await expect(a.verify()).rejects.toMatchObject({ code: "tiktok_ads_launch_claim_lost" });
  });

  it("release deletes only this acquisition's token, and a failed release is logged, not thrown", async () => {
    t.cards["card-a"] = { exec_status: "dispatching", exec_claimed_at: ago(1000) };
    const a = await claimLaunch("T", "1", "card-a", NOW);
    t.row!.token = "newer";
    await a.release();
    expect(t.row).toMatchObject({ token: "newer" });
    t.row!.token = a.token;
    t.failDelete = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await a.release();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("an insert that fails for another reason refuses (never a pass)", async () => {
    t.failInsert = "57014";
    await expect(claimLaunch("T", "1", "card-a", NOW)).rejects.toMatchObject({ code: "tiktok_ads_launch_state_unreadable" });
  });
});

describe("otherLaunchesExecuting", () => {
  it("queued or dispatching counts whatever the card's status; a pending card nobody approved does not; this card never does", async () => {
    t.open = [
      { action_id: "x-dispatching", status: "pending", exec_status: "dispatching" },
      { action_id: "x-queued", status: "snoozed", exec_status: "queued" },
      { action_id: "x-waiting", status: "pending", exec_status: null },
      { action_id: "me", status: "pending", exec_status: "dispatching" },
    ];
    expect(await otherLaunchesExecuting("T", "me")).toEqual(["x-dispatching", "x-queued"]);
  });
});
