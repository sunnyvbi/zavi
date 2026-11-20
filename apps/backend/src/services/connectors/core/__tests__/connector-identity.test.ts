import { describe, it, expect, vi, beforeEach } from "vitest";

const refreshTokenMock = vi.fn();
const fetchIdentityMock = vi.fn();
const rpcMock = vi.fn();
const updateMock = vi.fn();
let updateResult: { error: { message: string } | null } = { error: null };
let storedTeamId: string | null = "2095542369584304128";

vi.mock("../registry", () => ({
  getConnector: (slug: string) =>
    slug === "x_social"
      ? { refreshToken: refreshTokenMock, fetchIdentity: fetchIdentityMock }
      : slug === "jira"
        ? { refreshToken: refreshTokenMock }
        : null,
}));

type Op = { table: string; verb: string; patch?: Record<string, unknown>; filters: [string, unknown][] };
const ops: Op[] = [];

function builder(table: string, verb: string, patch?: Record<string, unknown>) {
  const op: Op = { table, verb, patch, filters: [] };
  ops.push(op);
  const chain: Record<string, unknown> = {};
  const step = (name: string) => (col: string, val: unknown) => {
    op.filters.push([col, val]);
    if (name === "eq" && table === "connector_metadata" && verb === "update") updateMock(patch);
    return chain;
  };
  chain.eq = step("eq");
  chain.in = step("in");
  chain.maybeSingle = async () => ({ data: { team_id: storedTeamId } });
  chain.select = () => chain;
  (chain as { then?: unknown }).then = (res: (v: unknown) => unknown) =>
    res(table === "connector_metadata" && verb === "update" ? updateResult : { error: null });
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: rpcMock,
    from: (table: string) => ({
      select: () => builder(table, "select"),
      update: (patch: Record<string, unknown>) => builder(table, "update", patch),
      delete: () => builder(table, "delete"),
    }),
  }),
}));

vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn() }));

async function load() {
  vi.resetModules();
  return await import("../token");
}

describe("refreshConnectorIdentity", () => {
  beforeEach(() => {
    refreshTokenMock.mockReset();
    fetchIdentityMock.mockReset();
    rpcMock.mockReset().mockResolvedValue({ error: null });
    updateMock.mockReset();
    updateResult = { error: null };
    storedTeamId = "2095542369584304128";
    ops.length = 0;
  });

  it("persists the handle the vendor reports right now", async () => {
    fetchIdentityMock.mockResolvedValue({ team_id: "2095542369584304128", team_name: "@UpcarCarRental" });
    const { refreshConnectorIdentity } = await load();
    const who = await refreshConnectorIdentity("t1", "x_social");
    expect(who).toEqual({ team_id: "2095542369584304128", team_name: "@UpcarCarRental" });
    expect(updateMock).toHaveBeenCalledWith({
      team_id: "2095542369584304128",
      team_name: "@UpcarCarRental",
    });
  });

  it("does nothing for a connector that cannot report identity", async () => {
    const { refreshConnectorIdentity } = await load();
    expect(await refreshConnectorIdentity("t1", "jira")).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not overwrite the stored label when the connection is gone", async () => {
    fetchIdentityMock.mockResolvedValue(null);
    const { refreshConnectorIdentity } = await load();
    expect(await refreshConnectorIdentity("t1", "x_social")).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not write a blank label", async () => {
    fetchIdentityMock.mockResolvedValue({ team_id: "1", team_name: "   " });
    const { refreshConnectorIdentity } = await load();
    expect(await refreshConnectorIdentity("t1", "x_social")).toBeNull();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed write instead of reporting success", async () => {
    fetchIdentityMock.mockResolvedValue({ team_id: "1", team_name: "@UpcarCarRental" });
    updateResult = { error: { message: "permission denied" } };
    const { refreshConnectorIdentity } = await load();
    await expect(refreshConnectorIdentity("t1", "x_social")).rejects.toThrow("permission denied");
  });

  it("propagates a vendor failure rather than guessing a label", async () => {
    fetchIdentityMock.mockRejectedValue(new Error("X users/me HTTP 429"));
    const { refreshConnectorIdentity } = await load();
    await expect(refreshConnectorIdentity("t1", "x_social")).rejects.toThrow("429");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("identity refresh rides along with the token refresh", () => {
  beforeEach(() => {
    refreshTokenMock.mockReset().mockResolvedValue({
      secrets: { "x_social.access_token": "fresh" },
      expiresInSec: 7200,
    });
    fetchIdentityMock.mockReset();
    rpcMock.mockReset().mockResolvedValue({ error: null });
    updateMock.mockReset();
    updateResult = { error: null };
    storedTeamId = "2095542369584304128";
    ops.length = 0;
  });

  it("refreshes the label after a successful token refresh", async () => {
    fetchIdentityMock.mockResolvedValue({ team_id: "1", team_name: "@UpcarCarRental" });
    const { forceRefreshConnector } = await load();
    await forceRefreshConnector("t1", "x_social");
    expect(rpcMock).toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledWith({ team_id: "1", team_name: "@UpcarCarRental" });
  });

  it("a failed identity read never fails the token refresh", async () => {
    fetchIdentityMock.mockRejectedValue(new Error("X users/me HTTP 503"));
    const { forceRefreshConnector } = await load();
    await expect(forceRefreshConnector("t1", "x_social")).resolves.toBeUndefined();
    expect(rpcMock).toHaveBeenCalled();
  });
});

const did = (table: string, verb: string) => ops.find((o) => o.table === table && o.verb === verb);

describe("handleConnectorAccountSwap", () => {
  beforeEach(() => {
    ops.length = 0;
  });

  it("drops the cached posts AND cancels queued sends for that channel", async () => {
    const { handleConnectorAccountSwap } = await load();
    await handleConnectorAccountSwap("t1", "x_social");
    expect(did("social_post_metric_snapshots", "delete")).toBeTruthy();
    const queued = did("social_posts", "update");
    expect(queued?.patch).toEqual({ status: "cancelled", last_error: "disconnected" });
    expect(queued?.filters).toContainEqual(["channel", ["x", "x_image", "x_video"]]);
    expect(queued?.filters).toContainEqual(["status", ["approved", "scheduled"]]);
  });

  it("targets Instagram's real publish channel, not the connector name", async () => {
    const { handleConnectorAccountSwap } = await load();
    await handleConnectorAccountSwap("t1", "instagram_social");
    expect(did("social_posts", "update")?.filters).toContainEqual(["channel", ["instagram_image", "instagram_video"]]);
  });

  it("disarms the auto-spend grant when the ad account changes", async () => {
    const { handleConnectorAccountSwap } = await load();
    await handleConnectorAccountSwap("t1", "meta_ads");
    const cap = did("tenant_ads_write_caps", "update");
    expect(cap?.patch).toEqual({ enabled: false });
    expect(cap?.filters).toContainEqual(["platform", "meta_ads"]);
  });

  it("cancels the tiktok queue, which publishes publicly and cannot be undone", async () => {
    const { handleConnectorAccountSwap } = await load();
    await handleConnectorAccountSwap("t1", "tiktok");
    expect(did("tiktok_scheduled_posts", "update")?.patch).toEqual({ status: "cancelled" });
  });

  it("does nothing for a connector with nothing to invalidate", async () => {
    const { handleConnectorAccountSwap } = await load();
    await handleConnectorAccountSwap("t1", "jira");
    expect(ops).toHaveLength(0);
  });

  it("never fails the connect it rides on when a statement errors", async () => {
    const { handleConnectorAccountSwap } = await load();
    await expect(handleConnectorAccountSwap("t1", "x_social")).resolves.toBeUndefined();
  });
});
