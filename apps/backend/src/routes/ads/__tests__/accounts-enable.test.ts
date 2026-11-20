import { beforeEach, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const m = vi.hoisted(() => ({
  auth: vi.fn(),
  role: vi.fn(),
  tier: vi.fn(),
  lock: vi.fn(),
  rpc: vi.fn(),
  choices: vi.fn(),
  binding: null as Record<string, unknown> | null,
  grant: null as Record<string, unknown> | null,
  updated: [] as unknown[] | null,
  writes: [] as Array<{ table: string; values: unknown; filters: Array<[string, unknown]> }>,
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: m.auth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: m.role }));
vi.mock("@/services/ads-wallet/providers", () => ({ refillEligibility: async () => "blocked" }));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: m.tier }));
vi.mock("@/services/channels/lock", () => ({ isChannelLockedStrict: m.lock }));
vi.mock("@/services/ads-wallet/accounts", async (original) => ({
  ...(await original<typeof import("@/services/ads-wallet/accounts")>()),
  accountChoices: m.choices,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (v: string) => v,
  tenantRpc: m.rpc,
  tenantClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let values: unknown;
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push([c, v]), q),
        is: (c: string, v: unknown) => (filters.push([c, v]), q),
        update: (v: unknown) => ((values = v), q),
        maybeSingle: async () => ({ data: table === "ads_account_binding_details" ? m.binding : m.grant, error: null }),
        then: (ok: (r: unknown) => unknown) => {
          m.writes.push({ table, values, filters });
          return Promise.resolve({ data: m.updated, error: m.updated ? null : { message: "boom" } }).then(ok);
        },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn() }));
import { adsDisableAccount, adsEnableAccount, adsWalletConsent } from "../accounts";
import { logEvent } from "@/services/logging/logEvent";

const ID = "10000000-0000-4000-8000-000000000001";
const req = (body: unknown, platform = "linkedin") => ({ body, params: { platform }, method: "POST" }) as unknown as Request;
const res = () => {
  const r = { status: vi.fn(), json: vi.fn() };
  r.status.mockReturnValue(r);
  return r as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};
const row = { id: ID, platform: "linkedin", provider_account_id: "501", funding_source: "provider", currency: "USD", disabled: false };

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ tenant_id: "verified", user_id: "owner" });
  m.role.mockResolvedValue(true);
  m.tier.mockResolvedValue({ allowed: true, enforced: true });
  m.lock.mockResolvedValue(false);
  m.rpc.mockResolvedValue({ data: true, error: null });
  m.choices.mockResolvedValue({ accounts: [row], managed: [], selected_id: null });
  m.binding = null;
  m.grant = null;
  m.updated = [{ account_binding_id: ID }];
  m.writes = [];
});

it("turns the account back on for the signed-in workspace and returns it as in use", async () => {
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(m.rpc).toHaveBeenCalledTimes(1);
  expect(m.rpc).toHaveBeenCalledWith("verified", "ads_enable_account_binding", { p_binding_id: ID, p_platform: "linkedin" });
  expect(r.status).not.toHaveBeenCalled();
  expect(r.json).toHaveBeenCalledWith({ ok: true, account: row });
});

it("still works after the plan drops the channel, like Stop using this account", async () => {
  m.tier.mockResolvedValue({ allowed: false, enforced: true });
  m.lock.mockResolvedValue(true);
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(m.rpc).toHaveBeenCalledTimes(1);
  expect(r.json).toHaveBeenCalledWith({ ok: true, account: row });
});

it.each(["member", "override"])("refuses a %s and changes nothing", async (who) => {
  if (who === "member") m.role.mockImplementation(async (_a: unknown, _r: unknown, res: Response) => { res.status(403).json({ error: { code: "forbidden" } }); return false; });
  if (who === "override") m.auth.mockResolvedValue({ tenant_id: "other", user_id: "staff", tenant_overridden: true });
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(403);
  expect(m.rpc).not.toHaveBeenCalled();
});

it.each([{ account_binding_id: "not-a-uuid" }, { account_binding_id: ID, tenant_id: "foreign" }, { account_binding_id: ID, p_platform: "chatgpt" }])(
  "refuses a malformed or widened request %o without calling the database",
  async (body) => {
    const r = res();
    await adsEnableAccount(req(body), r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(m.rpc).not.toHaveBeenCalled();
  },
);

it("says plainly when the account cannot be turned back on, with no ids or codes in the message", async () => {
  m.rpc.mockResolvedValue({ data: false, error: null });
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(404);
  const message = r.json.mock.calls[0]![0].error.message as string;
  expect(message).toMatch(/cannot be turned back on/);
  expect(message).not.toMatch(/[0-9a-f]{8}-|binding|_/i);
  expect(m.choices).not.toHaveBeenCalled();
});

it("does not report success when the database call fails", async () => {
  m.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(503);
  expect(r.json.mock.calls[0]![0]).not.toHaveProperty("ok");
});

it.each([
  ["a permission error", { code: "42501", message: "permission denied for function ads_enable_account_binding" }, "42501"],
  ["a missing function", { code: "PGRST202", message: "Could not find the function public.ads_enable_account_binding" }, "PGRST202"],
  ["an error with no code", { message: "fetch failed" }, "unknown"],
])("records the database's code and message for the team on %s, and never shows them to the founder", async (_label, error, dbCode) => {
  m.rpc.mockResolvedValue({ data: null, error });
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(vi.mocked(logEvent)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(logEvent)).toHaveBeenCalledWith({
    level: "error",
    source: "ads-wallet",
    code: "ads_wallet.enable_account_failed",
    tenant_id: "verified",
    message: error.message,
    meta: { db_error_code: dbCode },
  });
  const body = r.json.mock.calls[0]![0];
  expect(body).not.toHaveProperty("ok");
  expect(JSON.stringify(body)).not.toContain(error.message);
  expect(JSON.stringify(body)).not.toContain(dbCode);
  expect(m.choices).not.toHaveBeenCalled();
});

it("records nothing when the account turns back on", async () => {
  await adsEnableAccount(req({ account_binding_id: ID }), res());
  expect(vi.mocked(logEvent)).not.toHaveBeenCalled();
});

it.each([
  ["the enable function is not on this server yet", { code: "PGRST202", message: "Could not find the function" }],
  ["the enable function does not exist", { code: "42883", message: "function does not exist" }],
])("tells the founder setup is still finishing when %s, instead of the generic failure", async (_label, error) => {
  m.rpc.mockResolvedValue({ data: null, error });
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(503);
  const body = r.json.mock.calls[0]![0];
  expect(body).not.toHaveProperty("ok");
  expect(body.error.code).toBe("ads_setup_unavailable");
  expect(body.error.message).toBe("Zavi is finishing ad account setup on this server, so Use this account again is unavailable right now. Nothing was changed. Try again later, or pick another account.");
  expect(m.choices).not.toHaveBeenCalled();
});

it("says turning the account back on failed and nothing changed when the database call fails for another reason", async () => {
  m.rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(503);
  const body = r.json.mock.calls[0]![0];
  expect(body.error.code).toBe("ads_enable_unavailable");
  expect(body.error.message).toBe("Zavi could not turn this ad account back on just now. Nothing was changed. Try again in a minute, or pick another account.");
  expect(JSON.stringify(body)).not.toContain("statement timeout");
});

const walletBinding = { id: ID, tenant_id: "verified", account_id: "managed-account", platform: "linkedin", funding_source: "wallet", credential_source: "platform", legacy_key: null };
const walletRow = { ...row, provider_account_id: "777", funding_source: "wallet" };

it("turns a stopped Zavi shared-wallet account back on, clearing only that account's stop", async () => {
  m.rpc.mockResolvedValue({ data: false, error: null });
  m.binding = walletBinding;
  m.grant = { account_id: "managed-account" };
  m.choices.mockResolvedValue({ accounts: [walletRow], managed: [], selected_id: null });
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(r.status).not.toHaveBeenCalled();
  expect(r.json).toHaveBeenCalledWith({ ok: true, account: walletRow });
  expect(m.writes).toEqual([{ table: "ads_account_binding_status", values: { disabled_at: null }, filters: [["account_binding_id", ID]] }]);
});

it.each([
  ["Zavi no longer lets this workspace use the account", { ...walletBinding }, null],
  ["the account belongs to another platform", { ...walletBinding, platform: "chatgpt" }, { account_id: "managed-account" }],
  ["the binding belongs to another workspace", { ...walletBinding, tenant_id: "other" }, { account_id: "managed-account" }],
  ["it is the legacy ChatGPT platform account", { ...walletBinding, legacy_key: "chatgpt_platform" }, { account_id: "managed-account" }],
  ["it is not a Zavi account at all", { ...walletBinding, funding_source: "provider", credential_source: "tenant_connector" }, { account_id: "managed-account" }],
  ["no such account exists", null, { account_id: "managed-account" }],
])("never turns a wallet account back on when %s", async (_label, binding, grant) => {
  m.rpc.mockResolvedValue({ data: false, error: null });
  m.binding = binding;
  m.grant = grant;
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(404);
  expect(m.writes).toEqual([]);
  expect(m.choices).not.toHaveBeenCalled();
});

it("does not claim a wallet account is back on when the write fails, and says nothing changed", async () => {
  m.rpc.mockResolvedValue({ data: false, error: null });
  m.binding = walletBinding;
  m.grant = { account_id: "managed-account" };
  m.updated = null;
  const r = res();
  await adsEnableAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(503);
  const body = r.json.mock.calls[0]![0];
  expect(body).not.toHaveProperty("ok");
  expect(body.error.message).toMatch(/Nothing was changed/);
});

it("an own-billing account the database turns back on never touches the wallet path", async () => {
  m.binding = walletBinding;
  m.grant = { account_id: "managed-account" };
  await adsEnableAccount(req({ account_binding_id: ID }), res());
  expect(m.writes).toEqual([]);
});

it("a failed Stop using this account says the account is still in use, not a generic refresh line", async () => {
  m.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
  const r = res();
  await adsDisableAccount(req({ account_binding_id: ID }), r);
  expect(r.status).toHaveBeenCalledWith(503);
  const body = r.json.mock.calls[0]![0];
  expect(body).not.toHaveProperty("ok");
  expect(body.error.message).toBe("Zavi could not stop using this account just now, so it is still used for new campaigns. Try again in a minute.");
});

it.each([
  [true, "Zavi could not save your shared wallet permission just now, so it is still not authorized. Try again in a minute."],
  [false, "Zavi could not withdraw your shared wallet permission just now, so it is still authorized and no campaign was paused. Try again in a minute."],
])("a failed save of accept=%s says which way the permission stands", async (accept, message) => {
  m.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
  const r = res();
  await adsWalletConsent({ body: { version: "shared_ads_wallet_v1", accept }, params: {}, method: "POST" } as unknown as Request, r);
  expect(r.status).toHaveBeenCalledWith(503);
  const body = r.json.mock.calls[0]![0];
  expect(body).not.toHaveProperty("accepted");
  expect(body.error.message).toBe(message);
  expect(m.rpc).toHaveBeenCalledTimes(1);
});

it("a saved authorization reports the saved state, not a stale re-read", async () => {
  m.rpc.mockResolvedValue({ data: null, error: null });
  const r = res();
  await adsWalletConsent({ body: { version: "shared_ads_wallet_v1", accept: true }, params: {}, method: "POST" } as unknown as Request, r);
  expect(r.status).not.toHaveBeenCalled();
  expect(r.json.mock.calls[0]![0]).toMatchObject({ accepted: true });
});
