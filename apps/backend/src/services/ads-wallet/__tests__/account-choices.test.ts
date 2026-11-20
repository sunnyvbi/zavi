import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  bindings: [] as Record<string, unknown>[],
  grants: [] as Record<string, unknown>[],
  provider: [] as Record<string, unknown>[],
  selection: null as Record<string, unknown> | null,
  switchOn: true,
  fundingOn: true,
  rpc: vi.fn(),
  reads: [] as string[],
}));
vi.mock("../managed-linkedin", () => ({ managedLinkedinEnabled: () => m.switchOn }));
vi.mock("../wallet", () => ({ fundingEnabled: () => m.fundingOn }));
vi.mock("../adapters/linkedin-account", () => ({ resolveLinkedinAccount: vi.fn(async () => ({ account: {}, token: "t" })) }));
vi.mock("../bindings", () => ({
  getAccountBinding: vi.fn(async (_t: string, id: string) => m.bindings.find((b) => b.id === id)),
  selectAccountBinding: vi.fn(async () => {}),
  legacyChatgptAccount: vi.fn(),
  bindCampaign: vi.fn(),
}));
function query(rows: () => Record<string, unknown>[], table: string) {
  const filters: Array<(r: Record<string, unknown>) => boolean> = [];
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === undefined || r[k] === v), q),
    in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), q),
    is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
    maybeSingle: async () => {
      m.reads.push(table);
      if (table === "ads_account_selections") return { data: m.selection, error: null };
      if (table === "ads_wallet_consents") return { data: { version: "shared_ads_wallet_v1", revoked_at: null }, error: null };
      if (table === "ads_account_binding_status") return { data: null, error: null };
      return { data: rows().filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null };
    },
    range: async () => {
      m.reads.push(table);
      return { data: rows().filter((r) => filters.every((f) => f(r))), error: null };
    },
  };
  return q;
}
const tables: Record<string, () => Record<string, unknown>[]> = {
  ads_account_binding_details: () => m.bindings,
  ads_managed_account_choices: () => m.grants,
  ads_managed_account_grants: () => m.grants,
  ads_provider_accounts: () => m.provider,
};
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantRpc: m.rpc,
  tenantClient: () => ({ from: (table: string) => query(tables[table] ?? (() => []), table) }),
  globalClient: () => ({ from: (table: string) => query(tables[table] ?? (() => []), table) }),
}));
import {
  accountChoices,
  assertAccountAvailableForNewCampaign,
  chooseAccount,
  connectManagedAccount,
  LINKEDIN_WALLET_NOT_READY,
  LINKEDIN_WALLET_SWITCHED_OFF,
} from "../accounts";

const row = (id: string, credential_tenant_id: string | null, funding_source = "provider", account_id = `acct-${id}`) => ({
  id, account_id, platform: "linkedin", provider_account_id: id, funding_source, currency: "USD", credential_tenant_id,
});
const grant = (account_id: string, disabled_at: string | null = null) => ({ account_id, label: `Zavi ${account_id}`, platform: "linkedin", disabled_at });
const zaviAccount = (id: string, over: Record<string, unknown> = {}) => ({ id, credential_source: "platform", verified_at: "2026-11-01T00:00:00Z", currency: "USD", ...over });
const walletBinding = (id: string, account_id: string) => ({
  ...row(id, null, "wallet", account_id), tenant_id: "tenant-a", credential_source: "platform", legacy_key: null,
});

beforeEach(() => {
  m.switchOn = true;
  m.fundingOn = true;
  m.selection = null;
  m.reads = [];
  m.rpc.mockReset();
  m.bindings = [row("own", "tenant-a"), row("taken", "tenant-b"), walletBinding("zavi", "acct-zavi")];
  m.grants = [grant("acct-zavi")];
  m.provider = [zaviAccount("acct-zavi")];
});

it("marks only an account another workspace has taken over, and never sends the other workspace's id", async () => {
  const { accounts } = await accountChoices("tenant-a", "linkedin");
  expect(accounts).toEqual([
    { id: "own", platform: "linkedin", provider_account_id: "own", funding_source: "provider", currency: "USD", disabled: false },
    { id: "taken", platform: "linkedin", provider_account_id: "taken", funding_source: "provider", currency: "USD", disabled: false, owned_elsewhere: true },
    { id: "zavi", platform: "linkedin", provider_account_id: "zavi", funding_source: "wallet", currency: "USD", account_id: "acct-zavi", disabled: false },
  ]);
  expect(JSON.stringify(accounts)).not.toContain("tenant-b");
});

it.each([
  ["the managed switch is off", () => { m.switchOn = false; }],
  ["wallet payments are off", () => { m.fundingOn = false; }],
])("does not offer or keep selected Zavi's account when %s", async (_why, flip) => {
  flip();
  m.selection = { account_binding_id: "zavi" };
  const choices = await accountChoices("tenant-a", "linkedin");
  expect(choices.managed).toEqual([]);
  expect(choices.accounts.map((a) => a.id)).toEqual(["own", "taken"]);
  expect(choices.selected_id).toBeNull();
  expect(m.reads).not.toContain("ads_provider_accounts");
});

it.each([
  ["staff disabled the grant", () => { m.grants = [grant("acct-zavi", "2026-11-02T00:00:00Z")]; }],
  ["the account is not verified", () => { m.provider = [zaviAccount("acct-zavi", { verified_at: null })]; }],
  ["the account is not in USD", () => { m.provider = [zaviAccount("acct-zavi", { currency: "EUR" })]; }],
  ["the account is not Zavi's own login", () => { m.provider = [zaviAccount("acct-zavi", { credential_source: "tenant_connector" })]; }],
])("drops a grant the server would refuse when %s, and clears it as the saved choice", async (_why, flip) => {
  flip();
  m.grants.push(grant("acct-good"));
  m.provider.push(zaviAccount("acct-good"));
  m.selection = { account_binding_id: "zavi" };
  const choices = await accountChoices("tenant-a", "linkedin");
  expect(choices.managed.map((g) => g.account_id)).toEqual(["acct-good"]);
  expect(choices.accounts.some((a) => a.id === "zavi")).toBe(false);
  expect(choices.selected_id).toBeNull();
});

it("keeps a saved own account selected while Zavi's account is switched off", async () => {
  m.switchOn = false;
  m.selection = { account_binding_id: "own" };
  expect((await accountChoices("tenant-a", "linkedin")).selected_id).toBe("own");
});

it("refuses to start using Zavi's account with a plain reason, before any database write, when the switch is off", async () => {
  m.switchOn = false;
  await expect(connectManagedAccount("tenant-a", "linkedin", "acct-zavi")).rejects.toMatchObject({ message: LINKEDIN_WALLET_SWITCHED_OFF });
  await expect(chooseAccount("tenant-a", "linkedin", "zavi")).rejects.toMatchObject({ message: LINKEDIN_WALLET_SWITCHED_OFF });
  expect(m.rpc).not.toHaveBeenCalled();
});

it("refuses a disabled, unverified or non-USD grant with a plain reason instead of asking for a refresh", async () => {
  m.grants = [grant("acct-zavi", "2026-11-02T00:00:00Z")];
  await expect(connectManagedAccount("tenant-a", "linkedin", "acct-zavi")).rejects.toMatchObject({ message: LINKEDIN_WALLET_NOT_READY });
  m.grants = [grant("acct-zavi")];
  m.provider = [zaviAccount("acct-zavi", { currency: "EUR" })];
  await expect(chooseAccount("tenant-a", "linkedin", "zavi")).rejects.toMatchObject({ message: LINKEDIN_WALLET_NOT_READY });
  expect(m.rpc).not.toHaveBeenCalled();
});

it("a prepared campaign cannot be created on Zavi's account while launch would refuse it", async () => {
  m.switchOn = false;
  const binding = m.bindings.find((b) => b.id === "zavi") as never;
  await expect(assertAccountAvailableForNewCampaign("tenant-a", binding)).rejects.toMatchObject({ message: LINKEDIN_WALLET_SWITCHED_OFF });
  m.switchOn = true;
  await expect(assertAccountAvailableForNewCampaign("tenant-a", binding)).resolves.toBeUndefined();
});
