
import { describe, it, expect, vi, beforeEach } from "vitest";

type Call = [string, ...unknown[]];
const H = vi.hoisted(() => ({
  calls: [] as Call[],
  result: { data: null as unknown, error: null as unknown },
  byTable: {} as Record<string, { data: unknown; error: unknown }>,
  table: "",
}));

function chain(): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "neq", "is", "not", "in", "gte", "lt", "order", "limit"]) {
    c[m] = (...a: unknown[]) => {
      H.calls.push([m, ...a]);
      return c;
    };
  }
  c.maybeSingle = async () => H.byTable[H.table] ?? H.result;
  c.single = async () => H.result;
  c.then = (res: (v: unknown) => unknown) => Promise.resolve(H.result).then(res);
  return c;
}

vi.mock("@/services/tenant-client", () => ({
  globalClient: () => ({ from: (t: string) => (H.calls.push(["from", t]), (H.table = t), chain()) }),
  startCardRpc: vi.fn(async () => ({ data: null, error: null })),
}));

import { startCardRpc } from "@/services/tenant-client";
import {
  claimCard,
  transitionDelivery,
  confirmQueueRow,
  findRecentCardForDomain,
  generatePublicId,
  listConfirmedQueueRows,
  insertAccountQueueRow,
  PUBLIC_ID_RE,
  toPublicCard,
  type StartCardRow,
  isHiddenSeedCard,
  getPublicCardByPublicId,
  claimSeedCard,
} from "../store";
import { START_CARD_DONE_FIXTURE } from "@zavi/shared";

beforeEach(() => {
  H.calls = [];
  H.result = { data: null, error: null };
});

const has = (...call: unknown[]) => H.calls.some((c) => JSON.stringify(c) === JSON.stringify(call));

describe("queue queries", () => {
  it("the drain lists only confirmed rows without a card, oldest confirmation first", async () => {
    H.result = { data: [], error: null };
    await listConfirmedQueueRows(25);
    expect(has("from", "start_card_email_queue")).toBe(true);
    expect(has("not", "confirmed_at", "is", null)).toBe(true);
    expect(has("is", "card_id", null)).toBe(true);
    expect(has("order", "confirmed_at", { ascending: true })).toBe(true);
  });

  it("confirm is conditional: unconfirmed only, created inside the window", async () => {
    await confirmQueueRow("hash", "2026-09-19T00:00:00.000Z");
    expect(has("eq", "confirm_token_hash", "hash")).toBe(true);
    expect(has("is", "confirmed_at", null)).toBe(true);
    expect(has("gte", "created_at", "2026-09-19T00:00:00.000Z")).toBe(true);
  });
});

describe("authenticated email queue", () => {
  it("confirms an existing public request instead of leaving it invisible to the drain", async () => {
    H.result = { data: { id: "pending", confirmed_at: null }, error: null };
    expect(await insertAccountQueueRow({ email: "founder@acme.com", domain: "acme.com", card_id: null })).toBe(false);
    expect(has("eq", "email", "founder@acme.com")).toBe(true);
    expect(has("eq", "domain", "acme.com")).toBe(true);
    expect(has("is", "card_id", null)).toBe(true);
    expect(H.calls.find(([method]) => method === "update")?.[1]).toEqual({ confirmed_at: expect.any(String) });
    expect(has("eq", "id", "pending")).toBe(true);
    expect(has("is", "confirmed_at", null)).toBe(true);
    expect(H.calls.some(([method]) => method === "insert")).toBe(false);
  });

  it("preserves an existing confirmation timestamp with a conditional update", async () => {
    H.result = { data: { id: "confirmed", confirmed_at: "2026-10-01T00:00:00Z" }, error: null };
    await insertAccountQueueRow({ email: "founder@acme.com", domain: "acme.com", card_id: "c1" });
    expect(has("eq", "card_id", "c1")).toBe(true);
    expect(has("eq", "id", "confirmed")).toBe(true);
    expect(has("is", "confirmed_at", null)).toBe(true);
  });

  it("creates a confirmed row when there is no pending request", async () => {
    expect(await insertAccountQueueRow({ email: "founder@acme.com", domain: "acme.com", card_id: null })).toBe(true);
    expect(H.calls.find(([method]) => method === "insert")?.[1]).toEqual({
      email: "founder@acme.com", domain: "acme.com", card_id: null, ip_hash: null,
      confirmed_at: expect.any(String), confirm_token_hash: expect.any(String),
    });
  });
});

describe("dedupe query", () => {
  it("matches the domain in the window and skips failed, removed and seed-scan cards", async () => {
    await findRecentCardForDomain("acme.com", "2026-10-01T00:00:00.000Z");
    expect(has("eq", "domain", "acme.com")).toBe(true);
    expect(has("gte", "created_at", "2026-10-01T00:00:00.000Z")).toBe(true);
    expect(has("in", "status", ["running", "done"])).toBe(true);
    expect(has("is", "revoked_at", null)).toBe(true);
    expect(has("neq", "funding_kind", "seed")).toBe(true);
  });
});

describe("hidden seed cards", () => {
  it("a seed card is hidden until its notice went out; other cards never are", () => {
    expect(isHiddenSeedCard({ funding_kind: "seed", notice_sent_at: null })).toBe(true);
    expect(isHiddenSeedCard({ funding_kind: "seed", notice_sent_at: "2026-10-12T00:00:00Z" })).toBe(false);
    expect(isHiddenSeedCard({ funding_kind: "public_budget", notice_sent_at: null })).toBe(false);
    expect(isHiddenSeedCard({ funding_kind: "tenant_credits" })).toBe(false);
  });
});

describe("public ids", () => {
  it("are 16 base62 chars and do not repeat", () => {
    const ids = new Set(Array.from({ length: 200 }, generatePublicId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(PUBLIC_ID_RE.test(id)).toBe(true);
  });
});

describe("toPublicCard", () => {
  const row = (over: Partial<StartCardRow> = {}): StartCardRow => ({
    id: "row-id",
    public_id: START_CARD_DONE_FIXTURE.public_id,
    domain: START_CARD_DONE_FIXTURE.domain,
    locale: "US",
    search_term: START_CARD_DONE_FIXTURE.search_term,
    status: "done",
    parts: START_CARD_DONE_FIXTURE.parts,
    score: START_CARD_DONE_FIXTURE.score,
    scorer_version: "1",
    evidence: {},
    ip_hash: "ip-hash",
    referrer_card_id: null,
    budget_day: "2026-09-27",
    reserved_usd: 1,
    spent_usd: 0.6,
    revoked_at: null,
    error: null,
    created_at: START_CARD_DONE_FIXTURE.created_at,
    updated_at: START_CARD_DONE_FIXTURE.created_at,
    expires_at: START_CARD_DONE_FIXTURE.expires_at,
    ...over,
  });
  const NOW = new Date("2026-10-01T00:00:00Z");

  it("round-trips the fixture exactly (the web draws the same shape it will get)", () => {
    expect(toPublicCard(row(), NOW)).toEqual(START_CARD_DONE_FIXTURE);
  });

  it("a removed card reads 'removed' with no parts or score", () => {
    const c = toPublicCard(row({ revoked_at: "2026-09-30T00:00:00Z" }), NOW);
    expect(c).toMatchObject({ status: "removed", parts: {}, score: null, search_term: null });
  });

  it("an expired card reads 'expired' with no parts or score", () => {
    const c = toPublicCard(row(), new Date("2027-01-01T00:00:00Z"));
    expect(c).toMatchObject({ status: "expired", parts: {}, score: null });
  });
});

describe("atomic claim + delivery transitions (praxis__run_site_check)", () => {
  it("a public claim sends no tenant fields; a tenant claim sends its full funding ref and cap", async () => {
    const rpc = vi.mocked(startCardRpc);
    rpc.mockResolvedValueOnce({ data: { outcome: "created", id: "c1", public_id: "P", status: "running" }, error: null } as never);
    const pub = await claimCard({
      domain: "acme.com",
      since_iso: "2026-10-01T00:00:00.000Z",
      funding: { kind: "public_budget", budget_day: "2026-10-02", reserved_usd: 1, ip_hash: "h", referrer_card_id: null },
    });
    expect(pub).toEqual({ outcome: "created", id: "c1", public_id: "P", status: "running" });
    expect(rpc.mock.calls[0][0]).toBe("start_card_claim");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_funding_kind: "public_budget", p_tenant_id: null, p_run_id: null, p_tool_call_id: null, p_budget_day: "2026-10-02", p_run_cap: null });

    rpc.mockResolvedValueOnce({ data: { outcome: "run_cap", count: 5 }, error: null } as never);
    const t = await claimCard({
      domain: "acme.com",
      since_iso: "2026-10-01T00:00:00.000Z",
      funding: { kind: "tenant_credits", tenant_id: "t1", run_id: "r1", tool_call_id: "tu1", reserved_usd: 0.4875, delivery_target: { kind: "none" }, run_cap: 5 },
    });
    expect(t).toEqual({ outcome: "run_cap" });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_funding_kind: "tenant_credits", p_tenant_id: "t1", p_run_id: "r1", p_tool_call_id: "tu1", p_budget_day: null, p_run_cap: 5, p_ip_hash: null });
  });

  it("an RPC error or an unknown outcome throws (never read as 'created')", async () => {
    const rpc = vi.mocked(startCardRpc);
    rpc.mockResolvedValueOnce({ data: null, error: { message: "boom" } } as never);
    await expect(claimCard({ domain: "a.com", since_iso: "x", funding: { kind: "public_budget", budget_day: "d", reserved_usd: 1, ip_hash: null, referrer_card_id: null } })).rejects.toThrow("boom");
    rpc.mockResolvedValueOnce({ data: { outcome: "weird" }, error: null } as never);
    await expect(claimCard({ domain: "a.com", since_iso: "x", funding: { kind: "public_budget", budget_day: "d", reserved_usd: 1, ip_hash: null, referrer_card_id: null } })).rejects.toThrow(/unexpected/);
  });

  it("a delivery move is conditional on the current state and only for tenant cards", async () => {
    H.result = { data: [{ id: "c1" }], error: null };
    expect(await transitionDelivery("c1", "pending", "delivered")).toBe(true);
    expect(has("eq", "id", "c1")).toBe(true);
    expect(has("eq", "funding_kind", "tenant_credits")).toBe(true);
    expect(has("eq", "delivery_state", "pending")).toBe(true);
    H.result = { data: [], error: null };
    expect(await transitionDelivery("c1", "pending", "delivered")).toBe(false);
  });

describe("public card lookup", () => {
  const seed = { id: "c1", public_id: "SEEDSEEDSEEDSEED", domain: "acme.com", funding_kind: "seed", notice_sent_at: "2026-10-12T00:00:00Z" };
  it("a noticed seed card is public unless its domain was suppressed since", async () => {
    H.byTable = { start_cards: { data: seed, error: null }, seed_suppressions: { data: null, error: null } };
    expect(await getPublicCardByPublicId("SEEDSEEDSEEDSEED")).toMatchObject({ id: "c1" });
    H.byTable = { start_cards: { data: seed, error: null }, seed_suppressions: { data: { domain: "acme.com" }, error: null } };
    expect(await getPublicCardByPublicId("SEEDSEEDSEEDSEED")).toBeNull();
    H.byTable = { start_cards: { data: { ...seed, notice_sent_at: null }, error: null } };
    expect(await getPublicCardByPublicId("SEEDSEEDSEEDSEED")).toBeNull();
    H.byTable = {};
  });
});

describe("claimSeedCard", () => {
  it("passes through the refusals and the created card", async () => {
    for (const outcome of ["suppressed", "run_closed", "not_reserved"]) {
      vi.mocked(startCardRpc).mockResolvedValueOnce({ data: { outcome }, error: null } as never);
      expect(await claimSeedCard({ run_id: "r", domain: "a.com" })).toEqual({ outcome });
    }
    vi.mocked(startCardRpc).mockResolvedValueOnce({ data: { outcome: "created", id: "c", public_id: "P", status: "running" }, error: null } as never);
    expect(await claimSeedCard({ run_id: "r", domain: "a.com" })).toMatchObject({ outcome: "created", id: "c" });
  });
});
});
