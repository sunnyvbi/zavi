import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: { value: "owner" as string | null },
  tenantRpc: vi.fn(),
  bearerRpc: vi.fn(),
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/tenant-client", () => ({ tenantRpc: mocks.tenantRpc }));
vi.mock("@/services/supabase", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: mocks.role.value ? { role: mocks.role.value } : null, error: null }),
  };
  return {
    serviceClient: () => ({ from: () => chain }),
    serverClientFromBearer: () => ({ rpc: mocks.bearerRpc }),
  };
});

import { emailKeyConnectWith, emailKeyDisconnect, savedCampaignKeyWorks } from "../email-key";
import { checkSendgridKey } from "@/services/connectors/email-campaign/sendgrid-scopes";
import { requireTenantRole } from "@/services/auth/tenant-role";

const KEY = "SG.brightloopKeyId01.brightloopSecretPart_abcdefghijklmnop";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function sendgridFetch(opts: { scopesStatus?: number; scopes?: string[]; sendersStatus?: number }) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/v3/scopes")) {
      return new Response(JSON.stringify(opts.scopesStatus && opts.scopesStatus >= 400 ? { errors: [{ message: "bad key" }] } : { scopes: opts.scopes ?? [] }), {
        status: opts.scopesStatus ?? 200,
      });
    }
    if (url.includes("/v3/verified_senders")) {
      return new Response(JSON.stringify({ results: [] }), { status: opts.sendersStatus ?? 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

const ALL_SCOPES = ["mail.send", "marketing.read", "stats.read", "asm.groups.read"];

let logSpies: Array<{ mock: { calls: unknown[][] }; mockRestore: () => void }> = [];

beforeEach(() => {
  mocks.requireAuth.mockReset().mockResolvedValue({ tenant_id: "tnt-brightloop", user_id: "u-1", access_token: "tok" });
  mocks.role.value = "owner";
  mocks.tenantRpc.mockReset().mockResolvedValue({ data: null, error: null });
  mocks.bearerRpc.mockReset().mockResolvedValue({ data: null, error: null });
  logSpies = [vi.spyOn(console, "error").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {})];
});

afterEach(() => {
  for (const s of logSpies) {
    for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain("brightloopSecretPart");
    s.mockRestore();
  }
});

function connect(fetchImpl: typeof fetch) {
  return emailKeyConnectWith({ checkKey: (k) => checkSendgridKey(k, fetchImpl) });
}

describe("POST /api/connectors/email", () => {
  it("403s a member and never checks or stores the key", async () => {
    mocks.role.value = "member";
    const f = sendgridFetch({ scopes: ALL_SCOPES });
    const res = mockRes();
    await connect(f)({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: { code: "forbidden", message: "Only a workspace owner or admin can connect SendGrid. Ask one of them to connect it." },
    });
    expect(JSON.stringify(res.body)).not.toContain("Your role");
    expect(JSON.stringify(res.body)).not.toContain("requires one of");
    expect(f).not.toHaveBeenCalled();
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });

  it("a caller with no role row gets the same plain sentence", async () => {
    mocks.role.value = null;
    const res = mockRes();
    await connect(sendgridFetch({ scopes: ALL_SCOPES }))({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { message: string } }).error.message).toBe("Only a workspace owner or admin can connect SendGrid. Ask one of them to connect it.");
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });

  it("an admin is not refused and the key is stored", async () => {
    mocks.role.value = "admin";
    const res = mockRes();
    await connect(sendgridFetch({ scopes: ALL_SCOPES }))({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.tenantRpc).toHaveBeenCalledTimes(1);
  });

  it("400s a key SendGrid rejects, with a readable sentence, and stores nothing (old key kept)", async () => {
    const res = mockRes();
    await connect(sendgridFetch({ scopesStatus: 401 }))({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(400);
    const err = (res.body as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("sendgrid_key_invalid");
    expect(err.message).toMatch(/SendGrid did not accept this key\..*unchanged\.$/);
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });

  it("400s something that is not a SendGrid key without calling SendGrid, and does not echo it", async () => {
    const f = sendgridFetch({ scopes: ALL_SCOPES });
    const res = mockRes();
    await connect(f)({ body: { api_key: "sk_live_brightloopSecretPart_abcdefgh" } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("brightloopSecretPart");
    expect(f).not.toHaveBeenCalled();
  });

  it("stores key + full result in ONE rpc when every group passes", async () => {
    const res = mockRes();
    await connect(sendgridFetch({ scopes: ALL_SCOPES }))({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.tenantRpc).toHaveBeenCalledTimes(1);
    const [tenant, fn, args] = mocks.tenantRpc.mock.calls[0];
    expect(tenant).toBe("tnt-brightloop");
    expect(fn).toBe("set_sendgrid_connection");
    expect(args.p_api_key).toBe(KEY);
    expect(Object.values(args.p_scopes).every(Boolean)).toBe(true);
    const body = res.body as { campaign_ready: boolean; missing: unknown[] };
    expect(body.campaign_ready).toBe(true);
    expect(body.missing).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("brightloopSecretPart");
  });

  it("partial scopes: per-group flags, connected for one-to-one email, NOT campaign-connected", async () => {
    const res = mockRes();
    await connect(sendgridFetch({ scopes: ["mail.send"], sendersStatus: 403 }))({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { campaign_ready: boolean; groups: Record<string, boolean>; missing: Array<{ group: string }>; message: string };
    expect(body.campaign_ready).toBe(false);
    expect(body.groups).toEqual({
      mail_send: true,
      marketing_lists_read: false,
      single_sends_write: false,
      stats_read: false,
      senders_read: false,
      suppression_groups_read: false,
    });
    expect(body.missing.map((m) => m.group)).toContain("single_sends_write");
    expect(body.message).toMatch(/Needs more permissions for campaigns/);
    expect(mocks.tenantRpc.mock.calls[0][2].p_scopes).toEqual(body.groups);
  });

  it("a key without Mail Send is refused and not stored, even with campaign permissions", async () => {
    const res = mockRes();
    await connect(sendgridFetch({ scopes: ["marketing.read", "stats.read", "asm.groups.read"], sendersStatus: 200 }))({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("sendgrid_key_no_mail_send");
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });

  it("a key with no needed permission at all is refused and not stored", async () => {
    const res = mockRes();
    await connect(sendgridFetch({ scopes: ["alerts.read"], sendersStatus: 403 }))({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });

  it("an rpc failure is a 500 that says the old connection is unchanged and never leaks the db error", async () => {
    mocks.tenantRpc.mockResolvedValue({ data: null, error: { code: "XX000", message: `vault failed for ${KEY}` } });
    const res = mockRes();
    await connect(sendgridFetch({ scopes: ALL_SCOPES }))({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("brightloopSecretPart");
    expect((res.body as { error: { message: string } }).error.message).toMatch(/unchanged/);
  });

  it("SendGrid unreachable is a 502 and nothing is stored", async () => {
    const f = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = mockRes();
    await connect(f)({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(502);
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/connectors/email", () => {
  it("403s a member", async () => {
    mocks.role.value = "member";
    const res = mockRes();
    await emailKeyDisconnect({} as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden", message: "Only a workspace owner or admin can disconnect SendGrid. Ask one of them to do it." } });
    expect(JSON.stringify(res.body)).not.toContain("Your role");
    expect(mocks.bearerRpc).not.toHaveBeenCalled();
  });

  it("a 42501 from disconnect_connector is a 403 not_admin with the same sentence as the role check", async () => {
    mocks.bearerRpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } });
    const res = mockRes();
    await emailKeyDisconnect({} as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: { code: "not_admin", message: "Only a workspace owner or admin can disconnect SendGrid. Ask one of them to do it." } });
    expect(JSON.stringify(res.body)).not.toContain("permission denied");
  });

  it("the role check and the 42501 path say exactly the same thing", async () => {
    mocks.role.value = "member";
    const roleRes = mockRes();
    await emailKeyDisconnect({} as never, roleRes as never);
    mocks.role.value = "admin";
    mocks.bearerRpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    const rpcRes = mockRes();
    await emailKeyDisconnect({} as never, rpcRes as never);
    const roleMsg = (roleRes.body as { error: { message: string } }).error.message;
    const rpcMsg = (rpcRes.body as { error: { message: string } }).error.message;
    expect(roleMsg).toBe(rpcMsg);
    expect(roleRes.statusCode).toBe(403);
    expect(rpcRes.statusCode).toBe(403);
    expect((roleRes.body as { error: { code: string } }).error.code).toBe("forbidden");
    expect((rpcRes.body as { error: { code: string } }).error.code).toBe("not_admin");
  });

  it("an owner disconnects with no 403 body", async () => {
    mocks.role.value = "owner";
    const res = mockRes();
    await emailKeyDisconnect({} as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.bearerRpc).toHaveBeenCalledTimes(1);
  });

  it("disconnects through disconnect_connector for the caller's tenant", async () => {
    const res = mockRes();
    await emailKeyDisconnect({} as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(mocks.bearerRpc).toHaveBeenCalledWith("disconnect_connector", { p_tenant_id: "tnt-brightloop", p_slug: "email", p_server_id: "email" });
  });
});

describe("a session acting as another workspace (X-Eval-Tenant override)", () => {
  beforeEach(() => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-other", user_id: "u-1", access_token: "tok", tenant_overridden: true });
  });

  it("cannot connect a key: 403 before SendGrid is asked and nothing is stored", async () => {
    const f = sendgridFetch({ scopes: ALL_SCOPES });
    const res = mockRes();
    await connect(f)({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("tenant_override_forbidden");
    expect(f).not.toHaveBeenCalled();
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });

  it("cannot disconnect the other workspace's SendGrid", async () => {
    const res = mockRes();
    await emailKeyDisconnect({} as never, res as never);
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("tenant_override_forbidden");
    expect(mocks.bearerRpc).not.toHaveBeenCalled();
  });
});

describe("a key with no permission Zavi needs", () => {
  it("is refused as missing Mail Send, the one check that decides it", async () => {
    const res = mockRes();
    await connect(sendgridFetch({ scopes: ["alerts.read"], sendersStatus: 403 }))({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("sendgrid_key_no_mail_send");
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });
});

describe("requireTenantRole without a plain sentence", () => {
  const auth = { tenant_id: "tnt-brightloop", user_id: "u-1", access_token: "tok" } as never;

  it("keeps the exact default sentence for a member", async () => {
    mocks.role.value = "member";
    const res = mockRes();
    expect(await requireTenantRole(auth, ["owner", "admin"], res as never)).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: { code: "forbidden", message: "This action requires one of: owner, admin. Your role: member." } });
  });

  it("keeps the exact default sentence when the role row is gone", async () => {
    mocks.role.value = null;
    const res = mockRes();
    expect(await requireTenantRole(auth, ["owner"], res as never)).toBe(false);
    expect(res.body).toEqual({ error: { code: "forbidden", message: "This action requires one of: owner. Your role: none." } });
  });

  it("an explicit undefined sentence is the same as none", async () => {
    mocks.role.value = "member";
    const res = mockRes();
    expect(await requireTenantRole(auth, ["owner", "admin"], res as never, undefined)).toBe(false);
    expect((res.body as { error: { message: string } }).error.message).toBe("This action requires one of: owner, admin. Your role: member.");
  });

  it("allows an allowed role and writes nothing, with or without a sentence", async () => {
    mocks.role.value = "admin";
    const a = mockRes();
    const b = mockRes();
    expect(await requireTenantRole(auth, ["owner", "admin"], a as never)).toBe(true);
    expect(await requireTenantRole(auth, ["owner", "admin"], b as never, "Only an owner or admin can disconnect SendGrid.")).toBe(true);
    expect(a.body).toBeUndefined();
    expect(b.body).toBeUndefined();
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
  });
});

describe("a weaker key over a campaign-ready SendGrid connection", () => {
  const WEAKER_SCOPES = ["mail.send", "stats.read"];
  const DOWNGRADE_MESSAGE =
    "This key is missing campaign permissions: Marketing: lists, Marketing: Single Sends, Sender verification (read), Unsubscribe groups (read). Your existing campaign-ready key still works and was kept unchanged. To use this key instead, disconnect SendGrid in Connectors first, then paste it again.";

  function connectOver(fetchImpl: typeof fetch, existingCampaignReady: (tenantId: string) => Promise<boolean>) {
    return emailKeyConnectWith({ checkKey: (k) => checkSendgridKey(k, fetchImpl), existingCampaignReady });
  }

  it("409s sendgrid_campaign_downgrade and never overwrites the campaign-ready key", async () => {
    const existing = vi.fn(async () => true);
    const res = mockRes();
    await connectOver(sendgridFetch({ scopes: WEAKER_SCOPES, sendersStatus: 403 }), existing)({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: { code: "sendgrid_campaign_downgrade", message: DOWNGRADE_MESSAGE } });
    expect(existing).toHaveBeenCalledTimes(1);
    expect(existing).toHaveBeenCalledWith("tnt-brightloop");
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("brightloopSecretPart");
  });

  it("saves the same weaker key when the current connection is not campaign-ready, reading as not campaign-connected", async () => {
    const existing = vi.fn(async () => false);
    const res = mockRes();
    await connectOver(sendgridFetch({ scopes: WEAKER_SCOPES, sendersStatus: 403 }), existing)({ body: { api_key: KEY } } as never, res as never);
    expect(existing).toHaveBeenCalledWith("tnt-brightloop");
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; campaign_ready: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.campaign_ready).toBe(false);
    expect(body.message).toMatch(/^SendGrid is connected for one-to-one email\. Needs more permissions for campaigns: /);
    expect(mocks.tenantRpc).toHaveBeenCalledTimes(1);
    const [tenant, fn, args] = mocks.tenantRpc.mock.calls[0];
    expect(tenant).toBe("tnt-brightloop");
    expect(fn).toBe("set_sendgrid_connection");
    expect(args.p_api_key).toBe(KEY);
    expect(args.p_scopes.mail_send).toBe(true);
    expect(args.p_scopes.single_sends_write).toBe(false);
  });

  it("saves a campaign-ready key over a campaign-ready connection without a 409", async () => {
    const existing = vi.fn(async () => true);
    const res = mockRes();
    await connectOver(sendgridFetch({ scopes: ALL_SCOPES }), existing)({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { campaign_ready: boolean }).campaign_ready).toBe(true);
    expect(mocks.tenantRpc).toHaveBeenCalledTimes(1);
    expect(mocks.tenantRpc.mock.calls[0][2].p_api_key).toBe(KEY);
  });

  const SAVED = "SG.savedCampaignKey01.savedCampaignSecret_abcdefghijklmnop";

  function twoKeyFetch(savedStatus: number) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.includes(SAVED)) {
        if (url.endsWith("/v3/scopes")) return new Response(JSON.stringify(savedStatus >= 400 ? { errors: [{ message: "revoked" }] } : { scopes: ALL_SCOPES }), { status: savedStatus });
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      if (url.endsWith("/v3/scopes")) return new Response(JSON.stringify({ scopes: WEAKER_SCOPES }), { status: 200 });
      return new Response(JSON.stringify({ results: [] }), { status: 403 });
    }) as unknown as typeof fetch;
  }

  function overSaved(savedStatus: number) {
    const fetchImpl = twoKeyFetch(savedStatus);
    const check = (k: string) => checkSendgridKey(k, fetchImpl);
    const resolve = vi.fn(async () => ({ api_key: SAVED, key_digest: "d" }));
    return { fetchImpl, resolve, handler: emailKeyConnectWith({ checkKey: check, existingCampaignReady: (t) => savedCampaignKeyWorks(t, check, resolve) }) };
  }

  it("Flow 5: a revoked campaign-ready key is replaced by a mail-only key instead of being kept", async () => {
    const { fetchImpl, resolve, handler } = overSaved(401);
    const res = mockRes();
    await handler({ body: { api_key: KEY } } as never, res as never);
    expect(resolve).toHaveBeenCalledWith("tnt-brightloop");
    const savedChecked = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.some(([, init]) => new Headers(init?.headers).get("authorization")?.includes(SAVED));
    expect(savedChecked).toBe(true);
    expect(res.statusCode).toBe(200);
    expect((res.body as { campaign_ready: boolean }).campaign_ready).toBe(false);
    expect(mocks.tenantRpc).toHaveBeenCalledTimes(1);
    expect(mocks.tenantRpc.mock.calls[0][1]).toBe("set_sendgrid_connection");
    expect(mocks.tenantRpc.mock.calls[0][2].p_api_key).toBe(KEY);
  });

  it("Flow 5: a working campaign-ready key still 409s, and the sentence says to disconnect first", async () => {
    const { handler } = overSaved(200);
    const res = mockRes();
    await handler({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: { code: "sendgrid_campaign_downgrade", message: DOWNGRADE_MESSAGE } });
    expect(DOWNGRADE_MESSAGE).toMatch(/disconnect SendGrid in Connectors first/);
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });

  it("Flow 5: SendGrid unreachable for the saved key 503s and keeps it, never claiming it still works and never a silent downgrade", async () => {
    const check = vi.fn(async (k: string) => (k === SAVED ? ({ status: "unreachable" } as const) : checkSendgridKey(k, twoKeyFetch(200))));
    const handler = emailKeyConnectWith({ checkKey: check, existingCampaignReady: (t) => savedCampaignKeyWorks(t, check, async () => ({ api_key: SAVED, key_digest: "d" })) });
    const res = mockRes();
    await handler({ body: { api_key: KEY } } as never, res as never);
    expect(check).toHaveBeenCalledWith(SAVED);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: { code: string; message: string } }).error.code).toBe("sendgrid_connection_unreadable");
    expect((res.body as { error: { message: string } }).error.message).not.toMatch(/still works/);
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });

  it("Flow 5: a saved key SendGrid still accepts but that lost its campaign permissions is replaced, not defended with a 409", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.endsWith("/v3/scopes")) return new Response(JSON.stringify({ scopes: auth.includes(SAVED) ? ["mail.send"] : WEAKER_SCOPES }), { status: 200 });
      return new Response(JSON.stringify({ results: [] }), { status: 403 });
    }) as unknown as typeof fetch;
    const check = (k: string) => checkSendgridKey(k, fetchImpl);
    const handler = emailKeyConnectWith({ checkKey: check, existingCampaignReady: (t) => savedCampaignKeyWorks(t, check, async () => ({ api_key: SAVED, key_digest: "d" })) });
    const savedCheck = await check(SAVED);
    expect(savedCheck.status === "ok" && savedCheck.campaign_ready).toBe(false);
    const res = mockRes();
    await handler({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { campaign_ready: boolean }).campaign_ready).toBe(false);
    expect(mocks.tenantRpc).toHaveBeenCalledTimes(1);
    expect(mocks.tenantRpc.mock.calls[0][2].p_api_key).toBe(KEY);
  });

  it("savedCampaignKeyWorks is true only for a reachable, campaign-ready saved key", async () => {
    const resolve = async () => ({ api_key: SAVED, key_digest: "d" });
    const groups = {} as never;
    expect(await savedCampaignKeyWorks("tnt-brightloop", async () => ({ status: "ok", groups, campaign_ready: true, missing: [] }), resolve)).toBe(true);
    expect(await savedCampaignKeyWorks("tnt-brightloop", async () => ({ status: "ok", groups, campaign_ready: false, missing: [] }), resolve)).toBe(false);
    expect(await savedCampaignKeyWorks("tnt-brightloop", async () => ({ status: "invalid" }), resolve)).toBe(false);
    await expect(savedCampaignKeyWorks("tnt-brightloop", async () => ({ status: "unreachable" }), resolve)).rejects.toThrow();
  });

  it("no campaign-ready connection never checks a saved key", async () => {
    const check = vi.fn();
    expect(await savedCampaignKeyWorks("tnt-brightloop", check, async () => null)).toBe(false);
    expect(check).not.toHaveBeenCalled();
  });

  it("503s and stores nothing when the current connection cannot be read", async () => {
    const existing = vi.fn(async () => {
      throw new Error("db down");
    });
    const res = mockRes();
    await connectOver(sendgridFetch({ scopes: WEAKER_SCOPES, sendersStatus: 403 }), existing)({ body: { api_key: KEY } } as never, res as never);
    expect(res.statusCode).toBe(503);
    expect((res.body as { error: { code: string } }).error.code).toBe("sendgrid_connection_unreadable");
    expect(mocks.tenantRpc).not.toHaveBeenCalled();
  });
});
