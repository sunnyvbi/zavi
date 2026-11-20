import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

type Row = Record<string, any>;

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CARD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CARD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT = "5001";

const h = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  role: "owner" as string,
  tables: {} as Record<string, Array<Record<string, any>>>,
  accounts: {} as Record<string, Array<{ id: string; name: string; currency: string | null; status: string | null }>>,
  templates: [] as Array<Record<string, any>>,
  gets: [] as Array<{ token: string; path: string; params: Record<string, any> }>,
  posts: [] as Array<{ token: string; path: string; method: string; body: Record<string, any>; step?: string }>,
  refuse: null as null | ((body: Record<string, any>) => string | null),
  closeFails: false,
  rpcCalls: [] as Array<{ tenant: string; name: string; args: Record<string, any> }>,
}));

const facetUrn = (f: string) => `urn:li:adTargetingFacet:${f}`;
const CATALOG: Array<{ urn: string; name: string; facet: string }> = [
  { urn: "urn:li:seniority:3", name: "Entry", facet: "seniorities" },
  { urn: "urn:li:seniority:2", name: "Training", facet: "seniorities" },
  { urn: "urn:li:seniority:5", name: "Manager", facet: "seniorities" },
  { urn: "urn:li:seniority:6", name: "Director", facet: "seniorities" },
  { urn: "urn:li:seniority:10", name: "Owner", facet: "seniorities" },
  { urn: "urn:li:staffCountRange:(11,50)", name: "11-50 employees", facet: "staffCountRanges" },
  { urn: "urn:li:staffCountRange:(51,200)", name: "51-200 employees", facet: "staffCountRanges" },
  { urn: "urn:li:function:18", name: "Operations", facet: "jobFunctions" },
  { urn: "urn:li:industry:14", name: "Hospitals and Health Care", facet: "industries" },
  { urn: "urn:li:industry:2115", name: "Hospitals", facet: "industries" },
  { urn: "urn:li:industry:13", name: "Medical Practices", facet: "industries" },
  { urn: "urn:li:seniority:4", name: "Senior", facet: "seniorities" },
  { urn: "urn:li:seniority:9", name: "Partner", facet: "seniorities" },
  { urn: "urn:li:seniority:8", name: "CXO", facet: "seniorities" },
  { urn: "urn:li:staffCountRange:(1,1)", name: "Myself Only", facet: "staffCountRanges" },
  { urn: "urn:li:staffCountRange:(2,10)", name: "2-10 employees", facet: "staffCountRanges" },
  { urn: "urn:li:function:3", name: "Arts and Design", facet: "jobFunctions" },
  { urn: "urn:li:function:19", name: "Product Management", facet: "jobFunctions" },
  { urn: "urn:li:function:20", name: "Program and Project Management", facet: "jobFunctions" },
  { urn: "urn:li:function:4", name: "Business Development", facet: "jobFunctions" },
  { urn: "urn:li:function:9", name: "Entrepreneurship", facet: "jobFunctions" },
  { urn: "urn:li:industry:6", name: "Technology, Information and Internet", facet: "industries" },
  { urn: "urn:li:industry:4", name: "Software Development", facet: "industries" },
  { urn: "urn:li:industry:96", name: "IT Services and IT Consulting", facet: "industries" },
  { urn: "urn:li:industry:80", name: "Advertising Services", facet: "industries" },
  { urn: "urn:li:industry:3231", name: "Technology, Information and Media", facet: "industries" },
  { urn: "urn:li:title:100", name: "Audiologist", facet: "titles" },
  { urn: "urn:li:geo:103644278", name: "United States", facet: "locations" },
  { urn: "urn:li:geo:101174742", name: "Canada", facet: "locations" },
];

vi.mock("@/services/auth/middleware", () => ({ requireAuth: h.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: async (_a: unknown, allowed: string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(h.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  },
}));
vi.mock("@/services/agents/entitlement", () => ({ checkAgentTier: async () => ({ allowed: true }) }));
vi.mock("@/services/channels/lock", () => ({ comingSoonMessage: () => "soon", isChannelLockedStrict: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async () => undefined }));
vi.mock("@/services/connectors/linkedin-ads/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  linkedinAdsToken: async (tenant: string) => `token-of-${tenant}`,
  listLinkedInAdAccounts: async (tenant: string) => h.accounts[tenant] ?? [],
}));
vi.mock("@/services/connectors/linkedin-ads/http", async (orig) => {
  const real = await orig<typeof import("@/services/connectors/linkedin-ads/http")>();
  const { ExpectedToolError } = await import("@/services/tools/types");
  const entity = (e: { urn: string; name: string; facet: string }) => ({ urn: e.urn, name: e.name, facetUrn: `urn:li:adTargetingFacet:${e.facet}` });
  return {
    ...real,
    linkedinAdsGet: async (token: string, path: string, params: Record<string, any> = {}) => {
      h.gets.push({ token, path, params });
      if (path === "adTargetTemplates") return { elements: h.templates.filter((t) => t.account === params.account).map((t) => ({ ...t })) };
      if (path !== "adTargetingEntities") throw new Error(`unexpected LinkedIn read ${path}`);
      if (params.q === "urns") return { elements: CATALOG.filter((e) => (params.urns as string[]).includes(e.urn)).map(entity) };
      const facet = String(params.facet).replace("urn:li:adTargetingFacet:", "");
      const pool = CATALOG.filter((e) => e.facet === facet);
      if (params.q === "adTargetingFacet") return { elements: pool.map(entity) };
      return { elements: pool.filter((e) => e.name.toLowerCase().includes(String(params.query).toLowerCase())).map(entity) };
    },
    linkedinAdsPost: async (token: string, path: string, method: string, body: Record<string, any>, step?: string) => {
      h.posts.push({ token, path, method, body, step });
      const reason = h.refuse?.(body) ?? null;
      if (reason) throw new ExpectedToolError("linkedin_ads_write_refused", real.linkedinCreateRefused(step as never, reason), { http_status: 422, linkedin_reason: reason });
      const id = String(9000 + h.templates.length);
      h.templates.push({ id, ...body });
      return { id };
    },
  };
});
vi.mock("@/services/tenant-client", async (orig) => {
  const real = await orig<typeof import("@/services/tenant-client")>();
  const query = (table: string, tenant: string | null) => {
    const filters: Array<(r: Row) => boolean> = [];
    const rows = () => (h.tables[table] ?? []).filter((r) => (tenant === null || r.tenant_id === undefined || r.tenant_id === tenant) && filters.every((f) => f(r)));
    const b: any = {
      select: () => b,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), b),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), b),
      range: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok, bad),
    };
    return b;
  };
  return {
    ...real,
    tenantClient: (tenant: string) => ({ from: (table: string) => query(table, tenant) }),
    globalClient: () => ({ from: (table: string) => query(table, null) }),
    tenantRpc: async (tenant: string, name: string, args: Record<string, any>) => {
      h.rpcCalls.push({ tenant, name, args });
      if (name !== "set_channel_action") throw new Error(`unexpected rpc ${name}`);
      if (h.closeFails) return { data: null, error: { message: "db down" } };
      const row = (h.tables.channel_actions ?? []).find((r) => r.id === args.p_action_id && r.tenant_id === tenant);
      if (!row) return { data: { ok: false, code: "not_found" }, error: null };
      if (row.status !== "pending") return { data: { ok: false, code: "illegal_transition" }, error: null };
      row.status = args.p_status;
      row.note = args.p_note;
      return { data: { ok: true, status: row.status }, error: null };
    },
  };
});

import { linkedinCreateAudiences } from "../linkedin-ads";
import { savedAudienceName } from "@/services/connectors/linkedin-ads/saved-audience";

const SHEET = [
  "AUDIENCE 1: operations leads at mid-size clinics (hypothesis)",
  "Locations:      United States (Zavi's suggestion); Canada",
  "Company size:   11-50, 51-200",
  "Industries:     Hospitals and Health Care; Medical Practices",
  "Job functions:  Operations          Job seniorities: Manager, Director",
  "Exclude:        Current customers (upload list) | Seniority: Entry, Training",
  "Audience Expansion: OFF      LinkedIn Audience Network: OFF",
  "",
  "AUDIENCE 2: clinic owners",
  "Locations:      United States",
  "Company size:   11-50",
  "Job seniorities: Owner",
  "Audience Expansion: OFF      LinkedIn Audience Network: OFF",
].join("\n");

const FOUNDER_SHEET = [
  "AUDIENCE 1: product people at small software companies",
  "Locations:      United States",
  "Company size:   2-10, 11-50, 51-200",
  "Industries:     Software Development, Technology, Information and Internet",
  "Job functions:  Product Management, Design",
  "Job seniorities: Senior, Manager, Director",
  "",
  "AUDIENCE 2: founders of small agencies",
  "Locations:      United States",
  "Company size:   Self-employed, 2-10, 11-50",
  "Industries:     Software Development, IT Services and IT Consulting, Advertising Services",
  "Job functions:  Entrepreneurship, Business Development",
  "Job seniorities: Owner, Partner, CXO",
].join("\n");

const cardRow = (id: string, tenant: string, content: string) => ({
  id,
  tenant_id: tenant,
  channel_slug: "linkedin_ads",
  title: "Review these two audiences",
  status: "pending",
  note: null,
  exec_class: null,
  exec_status: null,
  body: { step: { responsibility: "client", deliverable: { kind: "list", label: "Two LinkedIn audiences", content } } },
});

function seed(content = SHEET) {
  h.tables = {
    channel_actions: [cardRow(CARD, A, content), cardRow(OTHER_CARD, B, content)],
    ads_account_binding_details: [{ id: "bind-a", tenant_id: A, platform: "linkedin", provider_account_id: ACCOUNT, funding_source: "provider", credential_tenant_id: A }],
    ads_account_selections: [{ account_binding_id: "bind-a", tenant_id: A, platform: "linkedin" }],
    ads_account_binding_status: [],
    ads_provider_accounts: [{ platform: "linkedin", provider_account_id: ACCOUNT, credential_source: "tenant_connector", credential_tenant_id: A, claim_released_at: null }],
    ads_campaign_binding_details: [],
  };
  h.accounts = { [A]: [{ id: ACCOUNT, name: "Clinic Ads", currency: "USD", status: "ACTIVE" }] };
}

async function press(actionId = CARD, body: unknown = {}, tenant = A) {
  h.requireAuth.mockResolvedValue({ tenant_id: tenant, user_id: "user-1" });
  let status = 200;
  let payload: any = null;
  const res: any = { status: (n: number) => ((status = n), res), json: (b: unknown) => ((payload = b), res) };
  await linkedinCreateAudiences({ params: { actionId }, body } as any, res);
  return { status, body: payload };
}

const card = () => h.tables.channel_actions.find((r) => r.id === CARD)!;
const created = () => h.posts.filter((p) => p.path === "adTargetTemplates");

beforeEach(() => {
  process.env.LINKEDIN_ADS_WRITE_ENABLED = "1";
  h.requireAuth.mockReset();
  h.role = "owner";
  h.templates = [];
  h.gets = [];
  h.posts = [];
  h.refuse = null;
  h.closeFails = false;
  h.rpcCalls = [];
  seed();
});
afterEach(() => {
  delete process.env.LINKEDIN_ADS_WRITE_ENABLED;
});

describe("LinkedIn Ads: Create audience saves the card's audiences to the workspace's own account", () => {
  it("saves one saved audience per audience with LinkedIn's own ids, closes the card, and names what a saved audience cannot hold", async () => {
    const out = await press();
    expect(out.status).toBe(200);
    expect(created()).toHaveLength(2);
    const [one, two] = created();
    expect(one.token).toBe(`token-of-${A}`);
    expect(one.method).toBe("CREATE");
    expect(one.body.account).toBe(`urn:li:sponsoredAccount:${ACCOUNT}`);
    expect(one.body.name).toBe("Operations leads at mid-size clinics");
    expect(one.body.targetingCriteria).toEqual({
      include: {
        and: [
          { or: { [facetUrn("locations")]: ["urn:li:geo:103644278", "urn:li:geo:101174742"] } },
          { or: { [facetUrn("interfaceLocales")]: ["urn:li:locale:en_US"] } },
          { or: { [facetUrn("seniorities")]: ["urn:li:seniority:5", "urn:li:seniority:6"] } },
          { or: { [facetUrn("industries")]: ["urn:li:industry:14", "urn:li:industry:13"] } },
          { or: { [facetUrn("staffCountRanges")]: ["urn:li:staffCountRange:(11,50)", "urn:li:staffCountRange:(51,200)"] } },
          { or: { [facetUrn("jobFunctions")]: ["urn:li:function:18"] } },
        ],
      },
      exclude: { or: { [facetUrn("seniorities")]: ["urn:li:seniority:3", "urn:li:seniority:2"] } },
    });
    expect(two.body.name).toBe("Clinic owners");
    expect(two.body.targetingCriteria.exclude).toBeUndefined();
    expect(card().status).toBe("acted");
    expect(card().note).toBe(out.body.line);
    expect(out.body.line).toContain('"Operations leads at mid-size clinics" and "Clinic owners"');
    expect(out.body.line).toContain("Clinic Ads");
    expect(out.body.line).toContain("Audience 1, Exclude: Current customers (upload list)");
    expect(out.body.line).toContain("Audience Expansion and LinkedIn Audience Network are campaign settings");
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0]).toMatchObject({ tenant: A, name: "set_channel_action", args: { p_action_id: CARD, p_status: "acted", p_actor_user_id: "user-1" } });
  });

  it("a double click sends each audience to LinkedIn once, and a press after the card is done sends nothing", async () => {
    const [first, second] = await Promise.all([press(), press()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(created()).toHaveLength(2);
    expect(h.rpcCalls).toHaveLength(1);
    const again = await press();
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, line: first.body.line });
    expect(created()).toHaveLength(2);
    expect(h.templates).toHaveLength(2);
  });

  it("when LinkedIn refuses the second audience the card stays open with LinkedIn's reason, and the retry saves only the missing one", async () => {
    h.refuse = (body) => (String(body.name) === "Clinic owners" ? "Audience size is too small for urn:li:seniority:10" : null);
    const out = await press();
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(out.body.error.code).toBe("linkedin_ads_write_refused");
    expect(out.body.error.message).toContain('Saved to LinkedIn on Clinic Ads: "Operations leads at mid-size clinics".');
    expect(out.body.error.message).toContain("Audience 2 was not saved.");
    expect(out.body.error.message).toContain("Audience size is too small");
    expect(out.body.error.message).not.toContain("urn:li:");
    expect(card().status).toBe("pending");
    expect(card().note).toBeNull();
    expect(h.rpcCalls).toHaveLength(0);
    expect(h.templates).toHaveLength(1);

    h.refuse = null;
    const retry = await press();
    expect(retry.status).toBe(200);
    expect(created()).toHaveLength(3);
    expect(created()[2].body.name).toBe("Clinic owners");
    expect(h.templates.map((t) => t.name)).toEqual(["Operations leads at mid-size clinics", "Clinic owners"]);
    expect(card().status).toBe("acted");
    expect(retry.body.line).toContain('"Operations leads at mid-size clinics" and "Clinic owners"');
  });

  it("when LinkedIn saved both but the card could not be closed, the retry closes it without saving anything twice", async () => {
    h.closeFails = true;
    const out = await press();
    expect(out.status).toBe(409);
    expect(out.body.error.message).toContain("could not close this card");
    expect(card().status).toBe("pending");
    expect(created()).toHaveLength(2);
    h.closeFails = false;
    const retry = await press();
    expect(retry.status).toBe(200);
    expect(created()).toHaveLength(2);
    expect(card().status).toBe("acted");
  });

  it("an account another workspace holds is refused before LinkedIn is asked to save anything, and no request can name the account", async () => {
    h.tables.ads_provider_accounts = [{ platform: "linkedin", provider_account_id: ACCOUNT, credential_source: "tenant_connector", credential_tenant_id: B, claim_released_at: null }];
    const held = await press();
    expect(held.status).toBe(422);
    expect(held.body.error.code).toBe("linkedin_ads_account_not_in_use");
    expect(created()).toHaveLength(0);
    expect(card().status).toBe("pending");

    seed();
    const named = await press(CARD, { account_id: "7777" });
    expect(named.status).toBe(400);
    expect(created()).toHaveLength(0);

    const wallet = { id: "bind-w", tenant_id: A, platform: "linkedin", provider_account_id: "8888", funding_source: "wallet", credential_tenant_id: null };
    h.tables.ads_account_binding_details = [wallet];
    h.tables.ads_account_selections = [{ account_binding_id: "bind-w", tenant_id: A, platform: "linkedin" }];
    const shared = await press();
    expect(shared.status).toBe(422);
    expect(created()).toHaveLength(0);

    seed();
    h.accounts[A] = [{ id: "6000", name: "Someone else", currency: "USD", status: "ACTIVE" }];
    const hidden = await press();
    expect(hidden.status).toBe(422);
    expect(created()).toHaveLength(0);
    expect(h.gets.filter((g) => g.path === "adTargetingEntities")).toHaveLength(0);
  });

  it("another workspace's card is not found, and nothing reaches LinkedIn", async () => {
    const out = await press(OTHER_CARD);
    expect(out.status).toBe(404);
    expect(h.gets).toHaveLength(0);
    expect(created()).toHaveLength(0);
    expect(h.tables.channel_actions.find((r) => r.id === OTHER_CARD)!.status).toBe("pending");
  });

  it("with the write switch off nothing is read from or sent to LinkedIn and the card stays open", async () => {
    process.env.LINKEDIN_ADS_WRITE_ENABLED = "0";
    const out = await press();
    expect(out.status).toBe(403);
    expect(out.body.error.code).toBe("linkedin_ads_writes_off");
    expect(h.gets).toHaveLength(0);
    expect(created()).toHaveLength(0);
    expect(card().status).toBe("pending");
  });

  it("a name LinkedIn cannot match exactly is named, never swapped for a near hit, and nothing is saved", async () => {
    seed(SHEET.replace("Hospitals and Health Care; Medical Practices", "Hospital; Dental Wizardry"));
    const out = await press();
    expect(out.status).toBe(422);
    expect(out.body.error.code).toBe("linkedin_ads_audience_unresolved");
    expect(out.body.error.message).toContain('Audience 1: Industries: LinkedIn has no match for "Hospital", "Dental Wizardry".');
    expect(out.body.error.message).toContain("Nothing was saved");
    expect(created()).toHaveLength(0);
    expect(card().status).toBe("pending");
  });

  it("the card Mohit pressed saves in one click: a LinkedIn name with a comma stays one industry, and Design and Self-employed are saved under LinkedIn's names and said so", async () => {
    seed(FOUNDER_SHEET);
    const out = await press();
    expect(out.status).toBe(200);
    expect(created()).toHaveLength(2);
    const [one, two] = created().map((p) => p.body.targetingCriteria.include.and);
    expect(one).toContainEqual({ or: { [facetUrn("industries")]: ["urn:li:industry:4", "urn:li:industry:6"] } });
    expect(one).toContainEqual({ or: { [facetUrn("jobFunctions")]: ["urn:li:function:19", "urn:li:function:3"] } });
    expect(one).toContainEqual({ or: { [facetUrn("seniorities")]: ["urn:li:seniority:4", "urn:li:seniority:5", "urn:li:seniority:6"] } });
    expect(one).toContainEqual({ or: { [facetUrn("staffCountRanges")]: ["urn:li:staffCountRange:(2,10)", "urn:li:staffCountRange:(11,50)", "urn:li:staffCountRange:(51,200)"] } });
    expect(two).toContainEqual({ or: { [facetUrn("industries")]: ["urn:li:industry:4", "urn:li:industry:96", "urn:li:industry:80"] } });
    expect(two).toContainEqual({ or: { [facetUrn("staffCountRanges")]: ["urn:li:staffCountRange:(1,1)", "urn:li:staffCountRange:(2,10)", "urn:li:staffCountRange:(11,50)"] } });
    expect(two).toContainEqual({ or: { [facetUrn("jobFunctions")]: ["urn:li:function:9", "urn:li:function:4"] } });
    expect(two).toContainEqual({ or: { [facetUrn("seniorities")]: ["urn:li:seniority:10", "urn:li:seniority:9", "urn:li:seniority:8"] } });
    expect(out.body.line).toContain('Saved under LinkedIn\'s own names: Design as "Arts and Design"; Self-employed as "Myself Only".');
    expect(card().status).toBe("acted");
    expect(card().note).toBe(out.body.line);
    const reads = h.gets.filter((g) => g.path === "adTargetingEntities" && g.params.q !== "urns");
    expect(reads.filter((g) => String(g.params.facet).endsWith(":industries")).every((g) => g.params.q === "typeahead" && String(g.params.query).length >= 2)).toBe(true);
    expect(reads.filter((g) => String(g.params.facet).endsWith(":industries")).map((g) => g.params.query)).toContain("Technology, Information and Internet");
  });

  it("Self-employed still saves when LinkedIn's one-person size has another id but the same name", async () => {
    const one = CATALOG.find((e) => e.name === "Myself Only")!;
    const real = one.urn;
    one.urn = "urn:li:staffCountRange:(0,1)";
    onTestFinished(() => void (one.urn = real));
    seed(FOUNDER_SHEET);
    const out = await press();
    expect(out.status).toBe(200);
    expect(created()[1].body.targetingCriteria.include.and).toContainEqual({ or: { [facetUrn("staffCountRanges")]: ["urn:li:staffCountRange:(0,1)", "urn:li:staffCountRange:(2,10)", "urn:li:staffCountRange:(11,50)"] } });
  });

  it("a short name that fits more than one LinkedIn name is refused with the names it fits, and nothing is saved", async () => {
    seed(FOUNDER_SHEET.replace("Product Management, Design", "Management, Design").replace("Software Development, Technology, Information and Internet", "Software Development, Technology"));
    const out = await press();
    expect(out.status).toBe(422);
    expect(out.body.error.code).toBe("linkedin_ads_audience_unresolved");
    expect(out.body.error.message).toContain('Job functions: "Management" fits more than one LinkedIn name (Product Management; Program and Project Management). Write the full name with Edit.');
    expect(out.body.error.message).toContain('Industries: LinkedIn has no match for "Technology".');
    expect(out.body.error.message).not.toContain('"Design"');
    expect(created()).toHaveLength(0);
    expect(card().status).toBe("pending");
  });

  it("a blank left on the card, a field Zavi cannot save, and titles with seniorities each stop the save and are named", async () => {
    seed(SHEET.replace("Company size:   11-50\n", "Company size:   [fill in: the size you sell to]\nSkills:         Scheduling\nJob titles:     Audiologist\n"));
    const out = await press();
    expect(out.status).toBe(422);
    expect(out.body.error.message).toContain("Audience 2: Company size: this still has a blank to fill in.");
    expect(out.body.error.message).toContain("Skills: Zavi cannot save this field");
    expect(out.body.error.message).toContain("LinkedIn does not allow both");
    expect(created()).toHaveLength(0);
    expect(card().status).toBe("pending");
  });

  it("the founder's filled-in text is what gets saved, but text with a different set of audiences is refused", async () => {
    seed(SHEET.replace("Company size:   11-50\n", "Company size:   [fill in: the size you sell to]\n"));
    const filled = SHEET.replace("Company size:   11-50\n", "Company size:   51-200\n");
    const swapped = await press(CARD, { content: `${filled}\n\nAUDIENCE 3: everyone\nLocations: United States\nJob seniorities: Owner` });
    expect(swapped.status).toBe(409);
    expect(created()).toHaveLength(0);
    const out = await press(CARD, { content: filled });
    expect(out.status).toBe(200);
    expect(created()[1].body.targetingCriteria.include.and).toContainEqual({ or: { [facetUrn("staffCountRanges")]: ["urn:li:staffCountRange:(51,200)"] } });
  });

  it("a retargeting audience is never saved as a locations-only shell; the facet audience is saved and the other is named", async () => {
    const sheet = `${SHEET.split("\n\n")[0]}\n\nAUDIENCE 2: people who visited your site\nSource:        Website visitors, from the Insight Tag\nLocations:      United States\nWindow:        90 days (Zavi's suggestion)`;
    seed(sheet);
    const out = await press();
    expect(out.status).toBe(200);
    expect(created()).toHaveLength(1);
    expect(created()[0].body.description).toContain("Zavi ref aaaaaaaa-1");
    expect(out.body.line).toContain("Audience 2 is a retargeting audience");
    expect(card().status).toBe("acted");
  });

  it("a member cannot create audiences", async () => {
    h.role = "member";
    const out = await press();
    expect(out.status).toBe(403);
    expect(h.gets).toHaveLength(0);
    expect(created()).toHaveLength(0);
  });
});

describe("LinkedIn Ads: a saved audience gets a short name that says who it is", () => {
  it.each([
    ["people LinkedIn can find by job and company size: product managers and designers at startups", "1", "Product managers and designers at startups"],
    ["people LinkedIn can find by job: founders and small agency owners who scope MVPs", "2", "Founders and small agency owners who scope MVPs"],
    ["operations leads at mid-size clinics (hypothesis)", "1", "Operations leads at mid-size clinics"],
    ["people LinkedIn can find by job: heads of revenue operations and sales enablement leaders at venture backed software companies in North America", "3", "Heads of revenue operations and sales enablement leaders"],
    ["people LinkedIn can find by job:   ", "4", "People LinkedIn can find by job"],
    ["", "5", "Audience 5"],
  ])("%s", (who, n, name) => {
    const got = savedAudienceName(who, n);
    expect(got).toBe(name);
    expect(got.length).toBeLessThanOrEqual(60);
    expect(got).not.toMatch(/Zavi [0-9a-f]{8}/);
  });

  it("a founder's own audience with the same name is never taken for this card's: Zavi saves its own under the name with (Zavi)", async () => {
    h.templates = [{ id: "1", account: `urn:li:sponsoredAccount:${ACCOUNT}`, name: "Clinic owners", description: "My own list" }];
    const out = await press();
    expect(out.status).toBe(200);
    expect(created()).toHaveLength(2);
    expect(created().map((c) => (c.body as { name: string }).name)).toContain("Clinic owners (Zavi)");
    expect(out.body.line).toContain('"Clinic owners (Zavi)"');
  });

  it("a retry finds an audience the founder renamed in Campaign Manager by Zavi's reference, and one saved under the old name form by its prefix", async () => {
    h.closeFails = true;
    await press();
    expect(created()).toHaveLength(2);
    h.templates[0] = { ...h.templates[0], name: "My renamed audience" };
    h.templates[1] = { ...h.templates[1], name: "Zavi aaaaaaaa-2: clinic owners", description: "Edited by hand" };
    h.closeFails = false;
    const retry = await press();
    expect(retry.status).toBe(200);
    expect(created()).toHaveLength(2);
    expect(retry.body.line).toContain('"My renamed audience"');
  });

  it("another card's audience with a different name is not taken for this card's, so both are saved", async () => {
    h.templates = [{ id: "1", account: `urn:li:sponsoredAccount:${ACCOUNT}`, name: "Clinic owners in Texas", description: "Saved by Zavi from the card \"x\". Zavi ref bbbbbbbb-2." }];
    const out = await press();
    expect(out.status).toBe(200);
    expect(created()).toHaveLength(2);
  });
});
