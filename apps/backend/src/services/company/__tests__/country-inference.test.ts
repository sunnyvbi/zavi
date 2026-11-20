
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: vi.fn(),
  tenantRpc: vi.fn(),
  fleetSweepClient: vi.fn(),
}));
const meta = vi.hoisted(() => ({ creds: vi.fn(), fbGet: vi.fn() }));
vi.mock("@/services/tools/meta-ads/_client", () => ({ metaAdsCreds: meta.creds, fbGet: meta.fbGet }));
const tt = vi.hoisted(() => ({ ensure: vi.fn(), account: vi.fn(), geo: vi.fn() }));
vi.mock("@/services/connectors/tiktok-ads/ad-accounts", () => ({ ensureAdAccounts: tt.ensure }));
vi.mock("@/services/connectors/tiktok-ads/composio-read", () => ({ tiktokAdsAccount: tt.account, readAdvertiserGeo: tt.geo }));
vi.mock("@/services/company/facts", () => ({
  getCompanyFacts: vi.fn(),
  projectCompanyFactValue: vi.fn(),
}));

import {
  autoSetCompanyCountry,
  cleanReading,
  countryFromTimeZone,
  describeSources,
  inferCompanyCountry,
  realRefreshDeps,
  refreshCountrySignals,
  signalsFromRows,
  sweepCompanyCountries,
  type AutoSetDeps,
  type CountrySignals,
  type RefreshDeps,
} from "../country-inference";
import { fleetSweepClient, tenantClient, tenantRpc } from "@/services/tenant-client";
import { getCompanyFacts, projectCompanyFactValue } from "@/services/company/facts";
import type { CompanyFacts } from "@/services/company/facts";

const noText = { location: null, markets: null, story: null };
const sig = (s: Partial<CountrySignals>): CountrySignals => ({ strong: [], timezones: [], text: noText, ...s });

describe("inferCompanyCountry", () => {
  it("writes when two strong signals agree (Meta + TikTok, US)", () => {
    expect(
      inferCompanyCountry(sig({ strong: [{ source: "meta", country: "US" }, { source: "tiktok", country: "US" }] })),
    ).toEqual({ decision: "write", country: "US", source_ref: "your Meta and TikTok ad accounts" });
  });

  it("writes for a non-US shape: a UK SaaS with Stripe GB + Meta GB", () => {
    expect(
      inferCompanyCountry(
        sig({
          strong: [{ source: "stripe", country: "GB" }, { source: "meta", country: "gb" }],
          timezones: [{ source: "meta", zone: "Europe/London" }],
          text: { location: "London, United Kingdom", markets: null, story: null },
        }),
      ),
    ).toEqual({ decision: "write", country: "GB", source_ref: "your Stripe account and your Meta ad account" });
  });

  it("writes on one strong signal when every known ad-account time zone sits in that country", () => {
    expect(
      inferCompanyCountry(
        sig({
          strong: [{ source: "meta", country: "US" }],
          timezones: [
            { source: "meta", zone: "America/Los_Angeles" },
            { source: "google", zone: "America/New_York" },
          ],
        }),
      ),
    ).toEqual({
      decision: "write",
      country: "US",
      source_ref: "your Meta ad account, confirmed by your ad accounts' time zones",
    });
  });

  it("only suggests on one strong signal with no time zone", () => {
    expect(inferCompanyCountry(sig({ strong: [{ source: "stripe", country: "US" }] }))).toEqual({
      decision: "suggest",
      country: "US",
      from: "your Stripe account",
    });
  });

  it("does not write on one strong signal when a time zone is unknown or not one country", () => {
    const out = inferCompanyCountry(
      sig({ strong: [{ source: "meta", country: "US" }], timezones: [{ source: "google", zone: "Etc/GMT+5" }] }),
    );
    expect(out.decision).not.toBe("write");
  });

  it("several advertisers on one platform count as ONE strong source", () => {
    const out = inferCompanyCountry(
      sig({ strong: [{ source: "tiktok", country: "US" }, { source: "tiktok", country: "US" }] }),
    );
    expect(out).toEqual({ decision: "suggest", country: "US", from: "your TikTok ad account" });
  });

  it("conflict between strong signals writes nothing", () => {
    const out = inferCompanyCountry(
      sig({ strong: [{ source: "stripe", country: "US" }, { source: "meta", country: "CA" }] }),
    );
    expect(out.decision).not.toBe("write");
    expect(out).toEqual({ decision: "none" });
  });

  it("conflict suggests the candidate the rest of the evidence backs", () => {
    const out = inferCompanyCountry(
      sig({
        strong: [{ source: "stripe", country: "US" }, { source: "meta", country: "CA" }],
        timezones: [{ source: "meta", zone: "America/Chicago" }],
      }),
    );
    expect(out).toEqual({ decision: "suggest", country: "US", from: "your Stripe account" });
  });

  it("a TikTok registration country alone (CN) with a US display time zone does NOT write or propose CN", () => {
    const out = inferCompanyCountry(
      sig({ strong: [{ source: "tiktok", country: "CN" }], timezones: [{ source: "tiktok", zone: "America/New_York" }] }),
    );
    expect(out.decision).not.toBe("write");
    expect(out).toEqual({ decision: "none" });
  });

  it("a time zone in another country blocks even two agreeing strong signals", () => {
    const out = inferCompanyCountry(
      sig({
        strong: [{ source: "stripe", country: "US" }, { source: "meta", country: "US" }],
        timezones: [{ source: "google", zone: "Europe/London" }],
      }),
    );
    expect(out.decision).not.toBe("write");
  });

  it("the record's location naming another country blocks the write", () => {
    const out = inferCompanyCountry(
      sig({
        strong: [{ source: "stripe", country: "US" }, { source: "meta", country: "US" }],
        text: { location: "Toronto, Canada", markets: null, story: null },
      }),
    );
    expect(out.decision).toBe("suggest");
  });

  it("text alone never writes; it only proposes", () => {
    expect(inferCompanyCountry(sig({ text: { location: "Austin, TX", markets: null, story: null } }))).toEqual({
      decision: "suggest",
      country: "US",
      from: "where your company is based",
    });
  });

  it("time zones alone never write", () => {
    const out = inferCompanyCountry(
      sig({ timezones: [{ source: "meta", zone: "America/New_York" }, { source: "google", zone: "America/Chicago" }] }),
    );
    expect(out.decision).not.toBe("write");
  });
});

describe("countryFromTimeZone / cleanReading", () => {
  it("maps single-country zones and refuses Etc/* and unknown ones", () => {
    expect(countryFromTimeZone("America/Los_Angeles")).toBe("US");
    expect(countryFromTimeZone("Europe/London")).toBe("GB");
    expect(countryFromTimeZone("Etc/GMT+5")).toBeNull();
    expect(countryFromTimeZone("UTC")).toBeNull();
    expect(countryFromTimeZone(null)).toBeNull();
  });

  it("stores only a valid country and zone names, never Etc/*", () => {
    expect(
      cleanReading({ for: "x", countries: ["us", "US"], timezones: ["Etc/GMT+5", "America/New_York", "America/New_York", "bad zone"] }),
    ).toEqual({ for: "x", countries: ["US"], timezones: ["America/New_York"] });
    expect(cleanReading({ for: null, countries: ["ZZ"], timezones: [] }).countries).toEqual([]);
  });

  it("describes sources in founder words", () => {
    expect(describeSources(new Set(["stripe", "meta", "tiktok"]), false)).toBe(
      "your Stripe account and your Meta and TikTok ad accounts",
    );
  });
});

describe("signalsFromRows", () => {
  it("reads each connector's stored reading and ignores one taken for an earlier account", () => {
    const s = signalsFromRows(
      [
        { slug: "stripe", team_id: "acct_1", account_geo: { for: "acct_1", countries: ["US"], timezones: [] } },
        { slug: "meta_ads", team_id: "act_NEW", account_geo: { for: "act_OLD", countries: ["CA"], timezones: ["America/Toronto"] } },
        { slug: "composio.tiktok_ads", team_id: "ca_1", selected_ad_account_id: "7689", account_geo: { for: "ca_1", countries: ["US"], timezones: ["America/New_York"], subjects: ["7689"] } },
        { slug: "google_ads", team_id: "123", account_geo: { for: "123", countries: [], timezones: ["America/Chicago"] } },
      ],
      noText,
    );
    expect(s.strong).toEqual([
      { source: "stripe", country: "US" },
      { source: "tiktok", country: "US" },
    ]);
    expect(s.timezones.map((t) => t.zone)).toEqual(["America/New_York", "America/Chicago"]);
  });

  it("the live TikTok shape: country US + display_timezone America/New_York, with Stripe US, writes US", () => {
    const s = signalsFromRows(
      [
        { slug: "stripe", team_id: null, account_geo: { for: null, countries: ["US"], timezones: [] } },
        { slug: "composio.tiktok_ads", team_id: "ca_1", selected_ad_account_id: "7689", account_geo: { for: "ca_1", countries: ["US"], timezones: ["America/New_York"], subjects: ["7689"] } },
      ],
      noText,
    );
    expect(inferCompanyCountry(s)).toMatchObject({ decision: "write", country: "US" });
  });
});

describe("TikTok advertisers (review findings C-F2, G-F1)", () => {
  const stripeUS = { slug: "stripe", team_id: "acct_1", account_geo: { for: "acct_1", countries: ["US"], timezones: [] } };

  it("advertisers in different countries are a conflict that blocks the write, even with all-US time zones", () => {
    const s = signalsFromRows(
      [
        stripeUS,
        {
          slug: "composio.tiktok_ads",
          team_id: "ca_1",
          ad_accounts: [{ advertiser_id: "1" }, { advertiser_id: "2" }],
          account_geo: { for: "ca_1", countries: ["US", "CN"], timezones: ["America/New_York", "America/Chicago"], subjects: ["1", "2"] },
        },
      ],
      noText,
    );
    expect(s.strong).toEqual([
      { source: "stripe", country: "US" },
      { source: "tiktok", country: "US" },
      { source: "tiktok", country: "CN" },
    ]);
    expect(inferCompanyCountry(s).decision).not.toBe("write");
  });

  it("a reading for a previously picked advertiser is ignored after the founder picks another", () => {
    const s = signalsFromRows(
      [
        stripeUS,
        {
          slug: "composio.tiktok_ads",
          team_id: "ca_1",
          selected_ad_account_id: "222",
          ad_accounts: [{ advertiser_id: "111" }, { advertiser_id: "222" }],
          account_geo: { for: "ca_1", countries: ["US"], timezones: ["America/New_York"], subjects: ["111"] },
        },
      ],
      noText,
    );
    expect(s.strong).toEqual([{ source: "stripe", country: "US" }]);
    expect(s.timezones).toEqual([]);
    expect(inferCompanyCountry(s).decision).not.toBe("write");
  });

  it("with no pick, the reading must cover every reachable advertiser", () => {
    const row = (subjects: string[]) => ({
      slug: "composio.tiktok_ads",
      team_id: "ca_1",
      ad_accounts: [{ advertiser_id: "1" }, { advertiser_id: "2" }],
      account_geo: { for: "ca_1", countries: ["US"], timezones: [], subjects },
    });
    expect(signalsFromRows([row(["1"])], noText).strong).toEqual([]);
    expect(signalsFromRows([row(["2", "1"])], noText).strong).toEqual([{ source: "tiktok", country: "US" }]);
  });
});

describe("Meta reader (review finding C-F1)", () => {
  const rowTeam = (team: string | null) =>
    vi.mocked(tenantClient).mockReturnValue({
      from: () => {
        const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { team_id: team }, error: null }) };
        return q;
      },
    } as never);

  beforeEach(() => {
    meta.creds.mockReset();
    meta.fbGet.mockReset();
  });

  it("refuses to label a cached credential's previous account with the newly connected one", async () => {
    meta.creds.mockResolvedValue({ ad_account_id: "act_OLD", access_token: "t" });
    rowTeam("act_NEW");
    const { realRefreshDeps } = await import("../country-inference");
    await expect(realRefreshDeps.meta("t1")).rejects.toThrow(/differ/);
    expect(meta.fbGet).not.toHaveBeenCalled();
  });

  it("reads when the credential and the connected account match (with or without act_)", async () => {
    meta.creds.mockResolvedValue({ ad_account_id: "act_9", access_token: "t" });
    meta.fbGet.mockResolvedValue({ business_country_code: "GB", timezone_name: "Europe/London" });
    rowTeam("9");
    const { realRefreshDeps } = await import("../country-inference");
    expect(await realRefreshDeps.meta("t1")).toEqual({ for: "9", countries: ["GB"], timezones: ["Europe/London"] });
  });
});

describe("refreshCountrySignals", () => {
  it("stores what each connected account says; one platform's failure keeps the others", async () => {
    const stored: Array<[string, unknown]> = [];
    const deps: RefreshDeps = {
      stripe: async () => {
        throw new Error("403 on accounts.retrieve");
      },
      meta: async () => ({ for: "act_1", countries: ["GB"], timezones: ["Europe/London"] }),
      tiktok: async () => null,
      google: async () => ({ for: "9", countries: [], timezones: ["Etc/UTC"] }),
      store: async (_t, slug, r) => {
        stored.push([slug, r]);
      },
    };
    expect(await refreshCountrySignals("t1", deps)).toEqual({ failed: ["stripe"] });
    expect(stored).toEqual([
      ["meta_ads", { for: "act_1", countries: ["GB"], timezones: ["Europe/London"] }],
      ["google_ads", { for: "9", countries: [], timezones: [] }],
    ]);
  });
});

describe("realRefreshDeps.tiktok: every covered advertiser must vote", () => {
  beforeEach(() => {
    tt.ensure.mockResolvedValue({ connected: true, selected_id: null, accounts: [{ advertiser_id: "111" }, { advertiser_id: "222" }] });
    tt.account.mockResolvedValue({ connected_account_id: "ca_1" });
  });

  it("throws (so the reading is not stored) when an advertiser is missing from the reply", async () => {
    tt.geo.mockResolvedValue([{ advertiser_id: "111", country: "US", display_timezone: "America/New_York" }]);
    await expect(realRefreshDeps.tiktok("t1")).rejects.toThrow(/every advertiser/);
  });

  it("throws when an advertiser comes back with a blank country", async () => {
    tt.geo.mockResolvedValue([
      { advertiser_id: "111", country: "US", display_timezone: "America/New_York" },
      { advertiser_id: "222", country: null, display_timezone: "America/New_York" },
    ]);
    await expect(realRefreshDeps.tiktok("t1")).rejects.toThrow(/every advertiser/);
  });

  it("reads when every advertiser reports a country", async () => {
    tt.geo.mockResolvedValue([
      { advertiser_id: "111", country: "US", display_timezone: "America/New_York" },
      { advertiser_id: "222", country: "CN", display_timezone: "America/Los_Angeles" },
    ]);
    expect(await realRefreshDeps.tiktok("t1")).toEqual({
      for: "ca_1",
      countries: ["US", "CN"],
      timezones: ["America/New_York", "America/Los_Angeles"],
      subjects: ["111", "222"],
    });
  });
});

describe("autoSetCompanyCountry", () => {
  const facts = (country?: { value: string; source: string }): CompanyFacts["facts"] =>
    (country ? { country: { ...country, verified_at: null } } : {}) as CompanyFacts["facts"];

  function deps(over: Partial<AutoSetDeps> & { signalsValue?: CountrySignals }): AutoSetDeps & { write: ReturnType<typeof vi.fn> } {
    return {
      facts: async () => facts(),
      refresh: async () => {},
      signals: async () => over.signalsValue ?? sig({}),
      write: vi.fn(async () => ({ written: true, error: null })),
      ...over,
    } as AutoSetDeps & { write: ReturnType<typeof vi.fn> };
  }

  const agreeing = sig({ strong: [{ source: "meta", country: "US" }, { source: "tiktok", country: "US" }] });

  it("an incomplete live read (a connected account could not be read) writes nothing, even when the rest agrees", async () => {
    const d = deps({ refresh: async () => ({ failed: ["meta"] }), signalsValue: agreeing });
    expect(await autoSetCompanyCountry("t1", {}, d)).toEqual({ outcome: "not_written", reason: "error", detail: "incomplete read: meta" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("writes the agreed country as source connector with the source in founder words", async () => {
    const d = deps({ signalsValue: agreeing });
    expect(await autoSetCompanyCountry("t1", {}, d)).toEqual({
      outcome: "written",
      country: "US",
      source_ref: "your Meta and TikTok ad accounts",
    });
    expect(d.write).toHaveBeenCalledWith("t1", "US", "your Meta and TikTok ad accounts");
  });

  it("never overwrites a founder value: no refresh, no write", async () => {
    const refresh = vi.fn(async () => {});
    const d = deps({ facts: async () => facts({ value: "CA", source: "human_confirmed" }), refresh, signalsValue: agreeing });
    expect(await autoSetCompanyCountry("t1", {}, d)).toEqual({ outcome: "already_set" });
    expect(refresh).not.toHaveBeenCalled();
    expect(d.write).not.toHaveBeenCalled();
  });

  it("a founder value set while the accounts were being read still wins", async () => {
    let n = 0;
    const d = deps({
      facts: async () => (n++ === 0 ? facts() : facts({ value: "CA", source: "human_confirmed" })),
      signalsValue: agreeing,
    });
    expect(await autoSetCompanyCountry("t1", {}, d)).toEqual({ outcome: "already_set" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("one strong signal alone writes nothing", async () => {
    const d = deps({ signalsValue: sig({ strong: [{ source: "stripe", country: "US" }] }) });
    expect(await autoSetCompanyCountry("t1", {}, d)).toEqual({ outcome: "not_written", reason: "suggest" });
    expect(d.write).not.toHaveBeenCalled();
  });

  it("a DB refusal (rank guard) is reported, not thrown", async () => {
    const d = deps({ signalsValue: agreeing, write: vi.fn(async () => ({ written: false, error: null })) });
    expect(await autoSetCompanyCountry("t1", {}, d)).toEqual({ outcome: "not_written", reason: "refused" });
  });

  it("never throws when a read fails", async () => {
    const d = deps({
      facts: async () => {
        throw new Error("db down");
      },
    });
    expect(await autoSetCompanyCountry("t1", {}, d)).toMatchObject({ outcome: "not_written", reason: "error" });
  });

  it("the real writer goes through projectCompanyFactValue as source connector", async () => {
    vi.mocked(getCompanyFacts).mockResolvedValue({ facts: {} } as unknown as CompanyFacts);
    vi.mocked(projectCompanyFactValue).mockResolvedValue({ written: true, error: null });
    const { realAutoSetDeps } = await import("../country-inference");
    await realAutoSetDeps.write("t1", "GB", "your Stripe account and your Meta ad account");
    expect(projectCompanyFactValue).toHaveBeenCalledWith(
      "t1",
      "country",
      "GB",
      "connector",
      "your Stripe account and your Meta ad account",
    );
  });
});

describe("sweepCompanyCountries", () => {
  beforeEach(() => {
    vi.mocked(fleetSweepClient).mockReset();
  });

  it("tries only tenants with a connected account and no country on file", async () => {
    const chain = (data: unknown) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "in", "eq"]) q[m] = () => q;
      q.limit = () => Promise.resolve({ data, error: null });
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
      return q;
    };
    vi.mocked(fleetSweepClient).mockReturnValue({
      from: (table: string) =>
        table === "connector_metadata"
          ? chain([{ tenant_id: "a" }, { tenant_id: "b" }, { tenant_id: "a" }])
          : chain([{ tenant_id: "b" }]),
    } as never);
    const tried: string[] = [];
    const out = await sweepCompanyCountries(async (t) => {
      tried.push(t);
      return { outcome: "written", country: "US", source_ref: "x" };
    });
    expect(tried).toEqual(["a"]);
    expect(out).toEqual({ checked: 1, written: 1 });
  });
});

describe("no write path runs inside a launch read", () => {
  it("TikTok launch readiness with no country returns the blocker and writes nothing", async () => {
    vi.mocked(getCompanyFacts).mockResolvedValue({ facts: {} } as unknown as CompanyFacts);
    vi.mocked(projectCompanyFactValue).mockClear();
    vi.mocked(tenantRpc).mockClear();
    const { allowedLaunchLocations } = await import("@/services/connectors/tiktok-ads/launch-readiness");
    const out = await allowedLaunchLocations("t1");
    expect(out.blocker?.code).toBe("tiktok_ads_no_country");
    expect(projectCompanyFactValue).not.toHaveBeenCalled();
    expect(tenantRpc).not.toHaveBeenCalled();
  });
});
