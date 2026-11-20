import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  get: vi.fn(),
  lifetime: vi.fn(),
  inventory: [] as { id: string }[],
  final: null as null | {
    observed_cents: number;
    stable_since: string;
    ended_since: string;
    last_observed_at: string;
  },
  filters: [] as unknown[],
  gone: new Set<string>(),
  recorded: [] as Array<Record<string, unknown>>,
  recordedError: false,
  late: vi.fn(),
}));
vi.mock("../adapters/linkedin", () => ({
  linkedinLifetimeSpend: m.lifetime,
  goneLinkedinCampaignIds: async () => m.gone,
  linkedinGonePeriodSpend: m.late,
}));
vi.mock("@/services/connectors/linkedin-ads/http", () => ({
  linkedinAdsGet: m.get,
}));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tenant: string) => ({
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: (...filter: unknown[]) => {
          m.filters.push([tenant, table, ...filter]);
          return q;
        },
        in: () => q,
        gte: () => q,
        order: () => q,
        range: async () =>
          table === "ad_spend_daily"
            ? { data: m.recordedError ? null : m.recorded, error: m.recordedError ? { message: "no" } : null }
            : { data: m.inventory, error: null },
        maybeSingle: async () => ({ data: m.final, error: null }),
      };
      return q;
    },
  }),
}));
import { readManagedLinkedinLedger } from "../linkedin-ledger";
const start = new Date("2026-10-01T00:00:00Z"),
  now = new Date("2026-10-12T00:00:00Z");
beforeEach(() => {
  vi.resetAllMocks();
  m.inventory = [{ id: "internal-a" }, { id: "internal-b" }];
  m.final = null;
  m.filters = [];
  m.gone = new Set();
  m.recorded = [];
  m.recordedError = false;
  m.lifetime.mockImplementation(async (_t, id) => ({
    cents: 500,
    token: "pinned",
    account: { id: "42", currency: "USD" },
    campaign: {
      id: id === "internal-a" ? "12345" : "67890",
      name: id,
      status: "PAUSED",
      totalBudget: { amount: "60.00" },
      runSchedule: { end: now.getTime() },
    },
  }));
  m.get.mockImplementation(async (_token, _path, query) => ({
    elements: [{ pivotValues: query.campaigns, costInLocalCurrency: "1.23" }],
  }));
});
it("queries only this tenant's bound campaigns and writes distinct internal identities", async () => {
  const [a] = await readManagedLinkedinLedger("tenant-a", start, now);
  expect(m.filters).toEqual(
    expect.arrayContaining([
      ["tenant-a", "ads_campaign_binding_details", "platform", "linkedin"],
      ["tenant-a", "ads_campaign_binding_details", "funding_source", "wallet"],
    ]),
  );
  expect(a.spend).toEqual([
    {
      object_id: "internal-a",
      spend_date: "2026-10-01",
      amount_usd: 1.23,
      provisional: true,
    },
    {
      object_id: "internal-b",
      spend_date: "2026-10-01",
      amount_usd: 1.23,
      provisional: true,
    },
  ]);
  expect(m.get).toHaveBeenCalledWith(
    "pinned",
    "adAnalytics",
    expect.objectContaining({
      accounts: ["urn:li:sponsoredAccount:42"],
      campaigns: ["urn:li:sponsoredCampaign:12345"],
      timeGranularity: "ALL",
    }),
    expect.anything(),
    { fresh: true },
  );
  expect(a.campaigns.map((c) => c.object_id)).toEqual([
    "internal-a",
    "internal-b",
  ]);
});
it.each([
  {},
  {
    elements: [
      {
        pivotValues: ["urn:li:sponsoredCampaign:foreign"],
        costInLocalCurrency: "1.00",
      },
    ],
  },
])(
  "retains previous actuals when a report cannot prove current-period spend",
  async (report) => {
    m.get.mockResolvedValue(report);
    await expect(
      readManagedLinkedinLedger("tenant-a", start, now),
    ).rejects.toThrow("period spend is unavailable");
  },
);
it("keeps the last verified figure while a running campaign's month is still empty", async () => {
  m.inventory = [{ id: "internal-a" }];
  m.lifetime.mockResolvedValue({
    cents: 500,
    token: "pinned",
    account: { id: "42", currency: "USD" },
    campaign: { id: "12345", name: "Live", status: "ACTIVE", totalBudget: { amount: "60.00" }, runSchedule: { end: new Date("2026-12-31T00:00:00Z").getTime() } },
  });
  m.get.mockResolvedValue({ elements: [] });
  await expect(readManagedLinkedinLedger("t", start, now)).rejects.toThrow("period spend is unavailable");
});
it("fails closed on truncated campaign inventory before querying any provider", async () => {
  m.inventory = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
  await expect(readManagedLinkedinLedger("t", start, now)).rejects.toThrow(
    "inventory is incomplete",
  );
  expect(m.lifetime).not.toHaveBeenCalled();
});
const beforeStart = start.getTime() - 3600000,
  inMonth = new Date("2026-10-05T00:00:00Z").getTime();
it.each([
  { status: "PAUSED", end: new Date("2027-03-01T00:00:00Z").getTime(), modified: inMonth },
  { status: "PAUSED", end: undefined, modified: undefined },
  { status: "COMPLETED", end: inMonth, modified: beforeStart },
  { status: "ACTIVE", end: inMonth, modified: beforeStart },
  { status: "PENDING_DELETION", end: undefined, modified: beforeStart },
])(
  "keeps the spend unknown when an empty month could hide delivery ($status, end $end, modified $modified)",
  async ({ status, end, modified }) => {
    m.inventory = [{ id: "internal-a" }];
    m.lifetime.mockResolvedValue({
      cents: 500,
      token: "pinned",
      account: { id: "42", currency: "USD" },
      campaign: {
        id: "12345",
        name: "a",
        status,
        totalBudget: { amount: "60.00" },
        runSchedule: end === undefined ? {} : { end },
        changeAuditStamps: modified === undefined ? {} : { lastModified: { time: modified } },
      },
    });
    m.get.mockResolvedValue({ elements: [] });
    await expect(readManagedLinkedinLedger("t", start, now)).rejects.toThrow("period spend is unavailable");
  },
);
it.each([
  { status: "PAUSED", end: new Date("2027-03-01T00:00:00Z").getTime(), modified: Date.parse("2026-10-05T10:00:00Z") },
  { status: "ACTIVE", end: Date.parse("2026-10-05T12:00:00Z"), modified: beforeStart },
])(
  "judges a mid-day budget start by the whole UTC day LinkedIn reports ($status)",
  async ({ status, end, modified }) => {
    m.inventory = [{ id: "internal-a" }];
    m.lifetime.mockResolvedValue({
      cents: 500,
      token: "pinned",
      account: { id: "42", currency: "USD" },
      campaign: { id: "12345", name: "a", status, totalBudget: { amount: "60.00" }, runSchedule: { end }, changeAuditStamps: { lastModified: { time: modified } } },
    });
    m.get.mockResolvedValue({ elements: [] });
    await expect(
      readManagedLinkedinLedger("t", new Date("2026-10-05T18:30:00Z"), now),
    ).rejects.toThrow("period spend is unavailable");
  },
);
it.each([
  { status: "PAUSED", end: new Date("2027-03-01T00:00:00Z").getTime(), modified: beforeStart },
  { status: "ARCHIVED", end: undefined, modified: beforeStart },
  { status: "COMPLETED", end: start.getTime() - 1, modified: inMonth },
  { status: "ACTIVE", end: start.getTime() - 1, modified: inMonth },
])(
  "reads a month with no delivery as zero for a campaign that could not serve in it ($status)",
  async ({ status, end, modified }) => {
    m.inventory = [{ id: "internal-a" }, { id: "internal-b" }];
    m.lifetime.mockImplementation(async (_t, id) => ({
      cents: 500,
      token: "pinned",
      account: { id: "42", currency: "USD" },
      campaign: {
        id: id === "internal-a" ? "12345" : "67890",
        name: id,
        status,
        totalBudget: { amount: "60.00" },
        runSchedule: end === undefined ? {} : { end },
        changeAuditStamps: { lastModified: { time: modified } },
      },
    }));
    m.get.mockImplementation(async (_token, _path, query) =>
      query.campaigns[0] === "urn:li:sponsoredCampaign:12345"
        ? { elements: [] }
        : {
            elements: [
              { pivotValues: query.campaigns, costInLocalCurrency: "2.50" },
            ],
          },
    );
    const [a] = await readManagedLinkedinLedger("t", start, now);
    expect(a.spend).toEqual([
      {
        object_id: "internal-a",
        spend_date: "2026-10-01",
        amount_usd: 0,
        provisional: true,
      },
      {
        object_id: "internal-b",
        spend_date: "2026-10-01",
        amount_usd: 2.5,
        provisional: true,
      },
    ]);
    expect(m.filters).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining(["ads_campaign_spend_stability"]),
      ]),
    );
  },
);
it("a campaign LinkedIn no longer has keeps its recorded spend, is never read live and does not fail the tenant's read", async () => {
  m.gone = new Set(["internal-a"]);
  m.recorded = [
    { account_id: "42", object_id: "internal-a", spend_date: "2026-10-03", amount_usd: "12.50", provisional: false },
  ];
  m.lifetime.mockImplementation(async (_t, id) => {
    if (id === "internal-a") throw new Error("the deleted campaign must not be read");
    return {
      cents: 500,
      token: "pinned",
      account: { id: "42", currency: "USD" },
      campaign: { id: "67890", name: id, status: "PAUSED", totalBudget: { amount: "60.00" }, runSchedule: { end: now.getTime() } },
    };
  });
  const [a] = await readManagedLinkedinLedger("tenant-a", start, now);
  expect(m.lifetime).toHaveBeenCalledTimes(1);
  expect(a.spend).toEqual(
    expect.arrayContaining([
      { object_id: "internal-a", spend_date: "2026-10-03", amount_usd: 12.5, provisional: false },
      expect.objectContaining({ object_id: "internal-b" }),
    ]),
  );
  expect(a.campaigns).toEqual([expect.objectContaining({ object_id: "internal-b" })]);
});
it("an unreadable recorded spend fails the read rather than treating the campaign's month as zero", async () => {
  m.gone = new Set(["internal-a"]);
  m.recordedError = true;
  await expect(readManagedLinkedinLedger("tenant-a", start, now)).rejects.toThrow("recorded spend is unavailable");
});
describe("spend LinkedIn reports after the campaign is gone", () => {
  const goneRow = (amount: number | string, spend_date = "2026-10-01") => ({ account_id: "42", object_id: "internal-a", spend_date, amount_usd: amount, provisional: true });
  const goneRows = async () => (await readManagedLinkedinLedger("tenant-a", start, now)).flatMap((a) => a.spend).filter((r) => r.object_id === "internal-a");
  beforeEach(() => {
    m.gone = new Set(["internal-a"]);
    m.inventory = [{ id: "internal-a" }];
  });

  it("raises the recorded period row to what LinkedIn now reports", async () => {
    m.recorded = [goneRow("12.50")];
    m.late.mockResolvedValue({ account_id: "42", cents: 2000 });
    expect(await goneRows()).toEqual([{ object_id: "internal-a", spend_date: "2026-10-01", amount_usd: 20, provisional: true }]);
    expect(m.late).toHaveBeenCalledWith("tenant-a", "internal-a", start, now);
  });

  it("reading the raised row back adds nothing, so repeated reads never accumulate", async () => {
    m.recorded = [goneRow("20.00")];
    m.late.mockResolvedValue({ account_id: "42", cents: 2000 });
    expect((await goneRows()).map((r) => r.amount_usd)).toEqual([20]);
  });

  it("adds only the gap when the month already holds rows on other dates", async () => {
    m.recorded = [goneRow("5.00", "2026-10-03"), goneRow("7.00", "2026-10-04")];
    m.late.mockResolvedValue({ account_id: "42", cents: 2000 });
    const rows = await goneRows();
    expect(rows.reduce((sum, r) => sum + r.amount_usd, 0)).toBeCloseTo(20, 6);
    expect(rows.find((r) => r.spend_date === "2026-10-01")).toMatchObject({ amount_usd: 8, provisional: true });
  });

  it("a campaign with no recorded row yet still enters the ledger on its account", async () => {
    m.late.mockResolvedValue({ account_id: "42", cents: 1500 });
    expect(await goneRows()).toEqual([{ object_id: "internal-a", spend_date: "2026-10-01", amount_usd: 15, provisional: true }]);
  });

  it("a lower figure never lowers the recorded spend, and no answer keeps it", async () => {
    m.recorded = [goneRow("12.50")];
    m.late.mockResolvedValue({ account_id: "42", cents: 100 });
    expect((await goneRows()).map((r) => r.amount_usd)).toEqual([12.5]);
    m.late.mockResolvedValue(null);
    expect((await goneRows()).map((r) => r.amount_usd)).toEqual([12.5]);
  });
});
