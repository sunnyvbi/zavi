
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("../creds", () => ({
  getPipedreamCreds: () => ({ projectId: "proj_1", environment: "production" }),
  PIPEDREAM_API_BASE_URL: "https://api.pipedream.com/v1",
  PIPEDREAM_MCP_BASE_URL: "https://remote.mcp.pipedream.net/v3",
}));
vi.mock("../token-provider", () => ({ getPipedreamAccessToken: async () => "tok" }));
vi.mock("@/services/mcp/streamable-guards", () => ({ assertStreamableUrlAllowed: () => undefined }));

import { listConnectedAccounts, resolveConnectedAccount, verifyAccountOwned } from "../api";

function respond(body: unknown): void {
  mocks.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});

const acct = (over: Record<string, unknown> = {}) => ({
  id: "apn_1",
  app: { name_slug: "posthog" },
  external_user_id: "tenant-1",
  created_at: "2026-07-13T10:00:00Z",
  ...over,
});

describe("listConnectedAccounts — envelope tolerance", () => {
  it.each([
    ["top-level array", (a: unknown) => [a]],
    ["{data:[…]}", (a: unknown) => ({ data: [a] })],
    ["{accounts:[…]}", (a: unknown) => ({ accounts: [a] })],
  ])("parses a %s response", async (_label, wrap) => {
    respond(wrap(acct()));

    const out = await listConnectedAccounts({ external_user_id: "tenant-1", app_slug: "posthog" });

    expect(out).toEqual([{ id: "apn_1", app_slug: "posthog", created_at: "2026-07-13T10:00:00Z" }]);
  });
});

describe("listConnectedAccounts — local fail-closed scoping", () => {
  it("drops a row belonging to another tenant even if Pipedream returns it", async () => {
    respond([acct({ id: "apn_mine" }), acct({ id: "apn_theirs", external_user_id: "tenant-2" })]);

    const out = await listConnectedAccounts({ external_user_id: "tenant-1", app_slug: "posthog" });

    expect(out.map((a) => a.id)).toEqual(["apn_mine"]);
  });

  it("honors external_id as the owner field too (docs use both names)", async () => {
    respond([
      { id: "apn_mine", app: "posthog", external_id: "tenant-1" },
      { id: "apn_theirs", app: "posthog", external_id: "tenant-2" },
    ]);

    const out = await listConnectedAccounts({ external_user_id: "tenant-1", app_slug: "posthog" });

    expect(out.map((a) => a.id)).toEqual(["apn_mine"]);
  });

  it("drops a row for a different app even if Pipedream ignores the app filter", async () => {
    respond([acct({ id: "apn_posthog" }), acct({ id: "apn_stripe", app: { name_slug: "stripe" } })]);

    const out = await listConnectedAccounts({ external_user_id: "tenant-1", app_slug: "posthog" });

    expect(out.map((a) => a.id)).toEqual(["apn_posthog"]);
  });

  it("keeps a foreign-tenant account from ever passing verifyAccountOwned", async () => {
    respond([acct({ id: "apn_theirs", external_user_id: "tenant-2" })]);

    const owned = await verifyAccountOwned({
      external_user_id: "tenant-1",
      app_slug: "posthog",
      account_id: "apn_theirs",
    });

    expect(owned).toBe(false);
  });
});

describe("resolveConnectedAccount", () => {
  it("returns the only account", async () => {
    respond([acct({ id: "apn_only" })]);

    const r = await resolveConnectedAccount({ external_user_id: "tenant-1", app_slug: "posthog" });

    expect(r).toEqual({ status: "ok", account: expect.objectContaining({ id: "apn_only" }) });
  });

  it("picks the strictly newest on a reconnect (old row still present)", async () => {
    respond([
      acct({ id: "apn_old", created_at: "2026-07-01T10:00:00Z" }),
      acct({ id: "apn_new", created_at: "2026-07-13T10:00:00Z" }),
    ]);

    const r = await resolveConnectedAccount({ external_user_id: "tenant-1", app_slug: "posthog" });

    expect(r).toMatchObject({ status: "ok", account: { id: "apn_new" } });
  });

  it("refuses to guess when two accounts share the newest timestamp", async () => {
    respond([
      acct({ id: "apn_a", created_at: "2026-07-13T10:00:00Z" }),
      acct({ id: "apn_b", created_at: "2026-07-13T10:00:00Z" }),
    ]);

    const r = await resolveConnectedAccount({ external_user_id: "tenant-1", app_slug: "posthog" });

    expect(r).toEqual({ status: "ambiguous", count: 2 });
  });

  it("refuses to guess when several accounts carry no usable timestamp", async () => {
    respond([
      { id: "apn_a", app: "posthog", external_user_id: "tenant-1" },
      { id: "apn_b", app: "posthog", external_user_id: "tenant-1" },
    ]);

    const r = await resolveConnectedAccount({ external_user_id: "tenant-1", app_slug: "posthog" });

    expect(r).toEqual({ status: "ambiguous", count: 2 });
  });

  it("retries an empty list before giving up — the list can lag the redirect", async () => {
    respond([]);
    respond([acct({ id: "apn_late" })]);

    const r = await resolveConnectedAccount({
      external_user_id: "tenant-1",
      app_slug: "posthog",
      delayMs: 0,
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ status: "ok", account: { id: "apn_late" } });
  });

  it("reports none after exhausting retries", async () => {
    respond([]);
    respond([]);
    respond([]);

    const r = await resolveConnectedAccount({
      external_user_id: "tenant-1",
      app_slug: "posthog",
      delayMs: 0,
    });

    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ status: "none" });
  });
});
