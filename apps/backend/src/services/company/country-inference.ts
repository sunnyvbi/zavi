
import { asTenantId, fleetSweepClient, tenantClient, tenantRpc } from "@/services/tenant-client";
import { countryFromText, normalizeCountryCode } from "@/services/ad-locations/country";
import { getCompanyFacts, projectCompanyFactValue, type CompanyFacts } from "@/services/company/facts";

export type StrongSource = "stripe" | "meta" | "tiktok";
export type ZoneSource = "meta" | "tiktok" | "google";

export type CountrySignals = {
  strong: Array<{ source: StrongSource; country: string }>;
  timezones: Array<{ source: ZoneSource; zone: string }>;
  text: { location?: string | null; markets?: string | null; story?: string | null };
};

export type CountryInference =
  | { decision: "write"; country: string; source_ref: string }
  | { decision: "suggest"; country: string; from: string }
  | { decision: "none" };

const ZONE_COUNTRY: Readonly<Record<string, string>> = (() => {
  const t: Record<string, string> = {};
  const add = (code: string, zones: string) => {
    for (const z of zones.split(" ")) t[z] = code;
  };
  add(
    "US",
    "America/New_York America/Chicago America/Denver America/Los_Angeles America/Phoenix America/Anchorage " +
      "America/Juneau America/Sitka America/Nome America/Yakutat America/Metlakatla America/Adak America/Boise " +
      "America/Detroit America/Menominee America/Indiana/Indianapolis America/Indianapolis America/Indiana/Knox " +
      "America/Indiana/Marengo America/Indiana/Petersburg America/Indiana/Tell_City America/Indiana/Vevay " +
      "America/Indiana/Vincennes America/Indiana/Winamac America/Kentucky/Louisville America/Louisville " +
      "America/Kentucky/Monticello America/North_Dakota/Beulah America/North_Dakota/Center " +
      "America/North_Dakota/New_Salem Pacific/Honolulu US/Eastern US/Central US/Mountain US/Pacific US/Arizona " +
      "US/Alaska US/Hawaii",
  );
  add(
    "CA",
    "America/Toronto America/Vancouver America/Edmonton America/Winnipeg America/Halifax America/St_Johns " +
      "America/Regina America/Moncton America/Glace_Bay America/Goose_Bay America/Whitehorse America/Dawson " +
      "America/Iqaluit America/Yellowknife America/Montreal Canada/Eastern Canada/Pacific Canada/Central " +
      "Canada/Mountain Canada/Atlantic Canada/Newfoundland",
  );
  add("MX", "America/Mexico_City America/Monterrey America/Merida America/Cancun America/Tijuana America/Chihuahua America/Hermosillo America/Mazatlan");
  add("BR", "America/Sao_Paulo America/Bahia America/Fortaleza America/Recife America/Manaus America/Belem");
  add("AR", "America/Argentina/Buenos_Aires America/Buenos_Aires America/Argentina/Cordoba");
  add("CL", "America/Santiago");
  add("CO", "America/Bogota");
  add("PE", "America/Lima");
  add("GB", "Europe/London");
  add("IE", "Europe/Dublin");
  add("FR", "Europe/Paris");
  add("DE", "Europe/Berlin");
  add("ES", "Europe/Madrid Atlantic/Canary");
  add("IT", "Europe/Rome");
  add("PT", "Europe/Lisbon");
  add("NL", "Europe/Amsterdam");
  add("BE", "Europe/Brussels");
  add("CH", "Europe/Zurich");
  add("AT", "Europe/Vienna");
  add("SE", "Europe/Stockholm");
  add("NO", "Europe/Oslo");
  add("DK", "Europe/Copenhagen");
  add("FI", "Europe/Helsinki");
  add("PL", "Europe/Warsaw");
  add("CZ", "Europe/Prague");
  add("GR", "Europe/Athens");
  add("RO", "Europe/Bucharest");
  add("HU", "Europe/Budapest");
  add("UA", "Europe/Kyiv Europe/Kiev");
  add("TR", "Europe/Istanbul");
  add("IL", "Asia/Jerusalem Asia/Tel_Aviv");
  add("AE", "Asia/Dubai");
  add("SA", "Asia/Riyadh");
  add("QA", "Asia/Qatar");
  add("EG", "Africa/Cairo");
  add("ZA", "Africa/Johannesburg");
  add("NG", "Africa/Lagos");
  add("KE", "Africa/Nairobi");
  add("IN", "Asia/Kolkata Asia/Calcutta");
  add("PK", "Asia/Karachi");
  add("BD", "Asia/Dhaka");
  add("LK", "Asia/Colombo");
  add("SG", "Asia/Singapore");
  add("MY", "Asia/Kuala_Lumpur");
  add("TH", "Asia/Bangkok");
  add("VN", "Asia/Ho_Chi_Minh Asia/Saigon");
  add("ID", "Asia/Jakarta");
  add("PH", "Asia/Manila");
  add("HK", "Asia/Hong_Kong");
  add("TW", "Asia/Taipei");
  add("CN", "Asia/Shanghai");
  add("JP", "Asia/Tokyo");
  add("KR", "Asia/Seoul");
  add(
    "AU",
    "Australia/Sydney Australia/Melbourne Australia/Brisbane Australia/Perth Australia/Adelaide Australia/Hobart " +
      "Australia/Darwin Australia/Canberra",
  );
  add("NZ", "Pacific/Auckland");
  return t;
})();

export function countryFromTimeZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  return ZONE_COUNTRY[zone.trim()] ?? null;
}

function strongPhrase(sources: ReadonlySet<StrongSource>): string {
  const ads = (["meta", "tiktok"] as const).filter((s) => sources.has(s)).map((s) => (s === "meta" ? "Meta" : "TikTok"));
  const adPart = ads.length === 0 ? null : ads.length === 1 ? `${ads[0]} ad account` : `${ads.join(" and ")} ad accounts`;
  if (sources.has("stripe")) return adPart ? `your Stripe account and your ${adPart}` : "your Stripe account";
  return adPart ? `your ${adPart}` : "";
}

export function describeSources(sources: ReadonlySet<StrongSource>, viaTimezones: boolean): string {
  const base = strongPhrase(sources);
  return viaTimezones ? `${base}, confirmed by your ad accounts' time zones` : base;
}

export function inferCompanyCountry(signals: CountrySignals): CountryInference {
  const strong = signals.strong
    .map((s) => ({ source: s.source, country: normalizeCountryCode(s.country) }))
    .filter((s): s is { source: StrongSource; country: string } => s.country !== null);

  const byCountry = new Map<string, Set<StrongSource>>();
  for (const s of strong) {
    const set = byCountry.get(s.country) ?? new Set<StrongSource>();
    set.add(s.source);
    byCountry.set(s.country, set);
  }
  const zoneCountries = signals.timezones.map((t) => countryFromTimeZone(t.zone));
  const textCountries = [signals.text.location, signals.text.markets]
    .map((t) => countryFromText(t)?.code ?? null)
    .filter((c): c is string => c !== null);

  if (byCountry.size === 1) {
    const [country, sources] = [...byCountry.entries()][0];
    const contradicted =
      zoneCountries.some((c) => c !== null && c !== country) || textCountries.some((c) => c !== country);
    if (!contradicted) {
      if (sources.size >= 2) return { decision: "write", country, source_ref: describeSources(sources, false) };
      if (zoneCountries.length > 0 && zoneCountries.every((c) => c === country)) {
        return { decision: "write", country, source_ref: describeSources(sources, true) };
      }
    }
  }

  const ranked = [...byCountry.entries()]
    .filter(([c]) => !zoneCountries.some((z) => z !== null && z !== c))
    .sort((a, b) => b[1].size - a[1].size);
  if (ranked.length > 0 && (ranked.length === 1 || ranked[0][1].size > ranked[1][1].size)) {
    return { decision: "suggest", country: ranked[0][0], from: strongPhrase(ranked[0][1]) };
  }
  const fromLocation = countryFromText(signals.text.location);
  if (fromLocation) return { decision: "suggest", country: fromLocation.code, from: "where your company is based" };
  const fromMarkets = countryFromText(signals.text.markets);
  if (fromMarkets) return { decision: "suggest", country: fromMarkets.code, from: "your markets" };
  const fromStory = countryFromText(signals.text.story);
  if (fromStory) return { decision: "suggest", country: fromStory.code, from: "your company story" };
  return { decision: "none" };
}

const GEO_SLUGS: ReadonlyArray<{ slug: string; strong: StrongSource | null; zone: ZoneSource | null }> = [
  { slug: "stripe", strong: "stripe", zone: null },
  { slug: "meta_ads", strong: "meta", zone: "meta" },
  { slug: "composio.tiktok_ads", strong: "tiktok", zone: "tiktok" },
  { slug: "google_ads", strong: null, zone: "google" },
];

type GeoRow = {
  slug: string;
  team_id: string | null;
  account_geo: unknown;
  selected_ad_account_id?: string | null;
  ad_accounts?: unknown;
};

export function currentTiktokSubjects(row: Pick<GeoRow, "selected_ad_account_id" | "ad_accounts">): string[] {
  if (row.selected_ad_account_id) return [row.selected_ad_account_id];
  const list = Array.isArray(row.ad_accounts) ? row.ad_accounts : [];
  return list
    .map((a) => (a && typeof a === "object" ? (a as { advertiser_id?: unknown }).advertiser_id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

export function signalsFromRows(rows: GeoRow[], text: CountrySignals["text"]): CountrySignals {
  const out: CountrySignals = { strong: [], timezones: [], text };
  for (const row of rows) {
    const spec = GEO_SLUGS.find((g) => g.slug === row.slug);
    const geo = row.account_geo as { for?: unknown; countries?: unknown; timezones?: unknown; subjects?: unknown } | null;
    if (!spec || !geo || typeof geo !== "object") continue;
    if ((geo.for ?? null) !== (row.team_id ?? null)) continue;
    if (row.slug === "composio.tiktok_ads") {
      const subjects = Array.isArray(geo.subjects) ? geo.subjects.filter((x): x is string => typeof x === "string") : [];
      if (!sameList(subjects, currentTiktokSubjects(row))) continue;
    }
    if (spec.strong && Array.isArray(geo.countries)) {
      const codes = new Set(geo.countries.map((c) => normalizeCountryCode(c)).filter((c): c is string => c !== null));
      for (const code of codes) out.strong.push({ source: spec.strong, country: code });
    }
    if (spec.zone && Array.isArray(geo.timezones)) {
      for (const z of geo.timezones) if (typeof z === "string" && z) out.timezones.push({ source: spec.zone, zone: z });
    }
  }
  return out;
}

function textOf(facts: CompanyFacts["facts"]): CountrySignals["text"] {
  return {
    location: facts.location?.value ?? null,
    markets: facts.markets?.value ?? null,
    story: facts.company_story?.value ?? null,
  };
}

export async function readCountrySignals(tenant_id: string, facts?: CompanyFacts["facts"]): Promise<CountrySignals> {
  const record = facts ?? (await getCompanyFacts(tenant_id)).facts;
  const { data, error } = await tenantClient(asTenantId(tenant_id))
    .from("connector_metadata")
    .select("slug, team_id, account_geo, selected_ad_account_id, ad_accounts")
    .in("slug", GEO_SLUGS.map((g) => g.slug));
  if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
  return signalsFromRows((data ?? []) as GeoRow[], textOf(record));
}

export type GeoReading = {
  for: string | null;
  countries: string[];
  timezones: string[];
  subjects?: string[];
};

export type RefreshDeps = {
  stripe(tenant_id: string): Promise<GeoReading | null>;
  meta(tenant_id: string): Promise<GeoReading | null>;
  tiktok(tenant_id: string): Promise<GeoReading | null>;
  google(tenant_id: string): Promise<GeoReading | null>;
  store(tenant_id: string, slug: string, reading: GeoReading): Promise<void>;
};

const isZoneName = (z: unknown): z is string =>
  typeof z === "string" && /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(z) && !z.startsWith("Etc/");

export function cleanReading(r: GeoReading): GeoReading {
  const out: GeoReading = {
    for: r.for,
    countries: [...new Set(r.countries.map((c) => normalizeCountryCode(c)).filter((c): c is string => c !== null))].slice(0, 20),
    timezones: [...new Set(r.timezones.filter(isZoneName))].slice(0, 20),
  };
  if (r.subjects) out.subjects = [...new Set(r.subjects)].sort().slice(0, 200);
  return out;
}

export function sameMetaAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (v: string | null | undefined) => (v ?? "").trim().replace(/^act_/, "");
  return n(a) !== "" && n(a) === n(b);
}

export const realRefreshDeps: RefreshDeps = {
  async stripe(tenant_id) {
    const { data } = await tenantClient(asTenantId(tenant_id))
      .from("connector_metadata")
      .select("team_id")
      .eq("slug", "stripe")
      .maybeSingle();
    if (!data) return null;
    const { stripeClient } = await import("@/services/tools/stripe/_client");
    const account = await (await stripeClient(tenant_id)).accounts.retrieve();
    return {
      for: (data as { team_id: string | null }).team_id ?? null,
      countries: account.country ? [account.country] : [],
      timezones: [],
    };
  },
  async meta(tenant_id) {
    const { metaAdsCreds, fbGet } = await import("@/services/tools/meta-ads/_client");
    let account: string;
    try {
      account = (await metaAdsCreds(tenant_id)).ad_account_id;
    } catch {
      return null;
    }
    const { data } = await tenantClient(asTenantId(tenant_id))
      .from("connector_metadata")
      .select("team_id")
      .eq("slug", "meta_ads")
      .maybeSingle();
    const team = (data as { team_id: string | null } | null)?.team_id ?? null;
    if (!sameMetaAccount(account, team)) {
      throw new Error("Meta credential and connected ad account differ (reconnect in progress)");
    }
    const j = (await fbGet(tenant_id, account, { fields: "business_country_code,timezone_name" })) as {
      business_country_code?: string;
      timezone_name?: string;
    } | null;
    return {
      for: team,
      countries: j?.business_country_code ? [j.business_country_code] : [],
      timezones: j?.timezone_name ? [j.timezone_name] : [],
    };
  },
  async tiktok(tenant_id) {
    const { ensureAdAccounts } = await import("@/services/connectors/tiktok-ads/ad-accounts");
    const state = await ensureAdAccounts(tenant_id);
    if (!state.connected || state.accounts.length === 0) return null;
    const { tiktokAdsAccount, readAdvertiserGeo } = await import("@/services/connectors/tiktok-ads/composio-read");
    const account = await tiktokAdsAccount(tenant_id);
    const ids = state.selected_id ? [state.selected_id] : state.accounts.map((a) => a.advertiser_id);
    const geo = await readAdvertiserGeo(account, ids);
    const voted = new Set(geo.filter((g) => !!g.country).map((g) => g.advertiser_id));
    if (ids.some((id) => !voted.has(id))) {
      throw new Error("TikTok did not report a country for every advertiser this reading covers");
    }
    return {
      for: account.connected_account_id,
      countries: geo.map((g) => g.country).filter((c): c is string => !!c),
      timezones: geo.map((g) => g.display_timezone).filter((z): z is string => !!z),
      subjects: ids,
    };
  },
  async google(tenant_id) {
    const { gadsCustomerId } = await import("@/services/tools/google-ads/_client");
    let customer: string;
    try {
      customer = await gadsCustomerId(tenant_id);
    } catch {
      return null;
    }
    const { data } = await tenantClient(asTenantId(tenant_id))
      .from("connector_metadata")
      .select("team_id")
      .eq("slug", "google_ads")
      .maybeSingle();
    const { googleAccountZone } = await import("@/services/growth/account-zone");
    const zone = await googleAccountZone(tenant_id, customer);
    return { for: (data as { team_id: string | null } | null)?.team_id ?? null, countries: [], timezones: [zone] };
  },
  async store(tenant_id, slug, r) {
    const { error } = await tenantRpc(asTenantId(tenant_id), "set_connector_account_geo", {
      p_slug: slug,
      p_for: r.for,
      p_countries: r.countries,
      p_timezones: r.timezones,
      p_subjects: r.subjects ?? null,
    });
    if (error) throw new Error(`set_connector_account_geo failed: ${error.message}`);
  },
};

export async function recordAccountGeo(tenant_id: string, slug: string, reading: GeoReading): Promise<void> {
  try {
    await realRefreshDeps.store(tenant_id, slug, cleanReading(reading));
  } catch (e) {
    console.warn(`[company-country] ${slug} reading not stored for ${tenant_id}: ${(e as Error).message}`);
  }
}

const READERS: ReadonlyArray<{ key: keyof Omit<RefreshDeps, "store">; slug: string }> = [
  { key: "stripe", slug: "stripe" },
  { key: "meta", slug: "meta_ads" },
  { key: "tiktok", slug: "composio.tiktok_ads" },
  { key: "google", slug: "google_ads" },
];

export async function refreshCountrySignals(tenant_id: string, deps: RefreshDeps = realRefreshDeps): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (const { key, slug } of READERS) {
    try {
      const reading = await deps[key](tenant_id);
      if (reading) await deps.store(tenant_id, slug, cleanReading(reading));
    } catch (e) {
      failed.push(key);
      console.warn(`[company-country] ${key} reading kept as before for ${tenant_id}: ${(e as Error).message}`);
    }
  }
  return { failed };
}

export type AutoSetDeps = {
  facts(tenant_id: string): Promise<CompanyFacts["facts"]>;
  refresh(tenant_id: string): Promise<{ failed: string[] } | void>;
  signals(tenant_id: string, facts: CompanyFacts["facts"]): Promise<CountrySignals>;
  write(tenant_id: string, country: string, source_ref: string): Promise<{ written: boolean; error: string | null }>;
};

export const realAutoSetDeps: AutoSetDeps = {
  facts: async (t) => (await getCompanyFacts(t)).facts,
  refresh: (t) => refreshCountrySignals(t),
  signals: (t, f) => readCountrySignals(t, f),
  write: (t, country, ref) => projectCompanyFactValue(t, "country", country, "connector", ref),
};

export type AutoSetResult =
  | { outcome: "already_set" }
  | { outcome: "written"; country: string; source_ref: string }
  | { outcome: "not_written"; reason: "refused" | "suggest" | "none" | "error"; detail?: string };

export async function autoSetCompanyCountry(
  tenant_id: string,
  opts: { refresh?: boolean } = {},
  deps: AutoSetDeps = realAutoSetDeps,
): Promise<AutoSetResult> {
  try {
    if (normalizeCountryCode((await deps.facts(tenant_id)).country?.value)) return { outcome: "already_set" };
    if (opts.refresh !== false) {
      const failed = (await deps.refresh(tenant_id))?.failed ?? [];
      if (failed.length) return { outcome: "not_written", reason: "error", detail: `incomplete read: ${failed.join(", ")}` };
    }
    const facts = await deps.facts(tenant_id);
    if (normalizeCountryCode(facts.country?.value)) return { outcome: "already_set" };
    const inference = inferCompanyCountry(await deps.signals(tenant_id, facts));
    if (inference.decision !== "write") return { outcome: "not_written", reason: inference.decision };
    const { written, error } = await deps.write(tenant_id, inference.country, inference.source_ref);
    if (error) return { outcome: "not_written", reason: "error", detail: error };
    return written
      ? { outcome: "written", country: inference.country, source_ref: inference.source_ref }
      : { outcome: "not_written", reason: "refused" };
  } catch (e) {
    console.warn(`[company-country] auto-set skipped for ${tenant_id}: ${(e as Error).message}`);
    return { outcome: "not_written", reason: "error", detail: (e as Error).message };
  }
}

export function autoSetCompanyCountryInBackground(tenant_id: string): void {
  void autoSetCompanyCountry(tenant_id).catch(() => {});
}

const SWEEP_LIMIT = 500;

export async function sweepCompanyCountries(
  autoSet: (tenant_id: string) => Promise<AutoSetResult> = (t) => autoSetCompanyCountry(t),
): Promise<{ checked: number; written: number }> {
  const sb = fleetSweepClient("company-country daily sweep: tenants with a connected account and no country");
  const { data: rows, error } = await sb
    .from("connector_metadata")
    .select("tenant_id")
    .in("slug", ["stripe", "meta_ads", "composio.tiktok_ads"])
    .limit(SWEEP_LIMIT);
  if (error) throw new Error(`connector_metadata read failed: ${error.message}`);
  const tenants = [...new Set(((rows ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id))];
  if (tenants.length === 0) return { checked: 0, written: 0 };
  const { data: set, error: factErr } = await sb
    .from("tenant_fact")
    .select("tenant_id")
    .eq("key", "country")
    .in("tenant_id", tenants);
  if (factErr) throw new Error(`tenant_fact read failed: ${factErr.message}`);
  const hasCountry = new Set(((set ?? []) as Array<{ tenant_id: string }>).map((r) => r.tenant_id));
  let checked = 0;
  let written = 0;
  for (const t of tenants) {
    if (hasCountry.has(t)) continue;
    checked++;
    const r = await autoSet(t);
    if (r.outcome === "written") written++;
  }
  return { checked, written };
}
