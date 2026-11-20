import { describe, it, expect } from "vitest";
import {
  resolveMirrorTarget,
  refFromDbUri,
  planTable,
  secretAllowed,
  connectorKept,
  carriedFamilies,
  parseEnvText,
  assertProdSource,
  insertableColumns,
  schemaMismatches,
  scrubConfigBlob,
  parsePgUri,
  pickActiveTenant,
  fkRepair,
  TABLE_ALLOWLIST,
  PROD_REF,
  STAGING_REF,
  PROD_AUTH_HOOKS,
  authConfigGaps,
  syncAuthHooks,
  activeTenantClaim,
  planCreatorCopy,
  CREATOR_TABLES,
} from "../plan.mjs";

const MIRROR = "uwbkkuklvuytqfinbkgm";
const pooler = (ref, port = 5432) => `postgresql://postgres.${ref}:p@ss@aws-0-us-west-1.pooler.supabase.com:${port}/postgres`;

describe("resolveMirrorTarget", () => {
  it("accepts the one mirror project, by pooler or direct connection", () => {
    expect(resolveMirrorTarget({ apiUrl: `https://${MIRROR}.supabase.co`, dbUri: pooler(MIRROR), expectedRef: MIRROR })).toBe(MIRROR);
    expect(resolveMirrorTarget({ apiUrl: null, dbUri: `postgresql://postgres:x@db.${MIRROR}.supabase.co:5432/postgres`, expectedRef: MIRROR })).toBe(MIRROR);
  });
  it("refuses prod and staging however they are written", () => {
    expect(() => resolveMirrorTarget({ apiUrl: null, dbUri: pooler(MIRROR), expectedRef: "wmycgyjsenvgtczlupoe" })).toThrow("PROD");
    expect(() => resolveMirrorTarget({ apiUrl: "https://WMYCGYJSENVGTCZLUPOE.supabase.co", dbUri: pooler(MIRROR), expectedRef: MIRROR })).toThrow("PROD");
    expect(() => resolveMirrorTarget({ apiUrl: null, dbUri: "postgresql://postgres.%77mycgyjsenvgtczlupoe:x@aws-0-us-west-1.pooler.supabase.com:5432/postgres", expectedRef: MIRROR })).toThrow("PROD");
    expect(() => resolveMirrorTarget({ apiUrl: null, dbUri: "postgresql://postgres:x@DB.dgzgwclslzzzrjopbobp.SUPABASE.CO:5432/postgres", expectedRef: MIRROR })).toThrow("STAGING");
  });
  it("refuses a URL and a connection for different projects", () => {
    expect(() => resolveMirrorTarget({ apiUrl: "https://abcdefghijabcdefghij.supabase.co", dbUri: pooler(MIRROR), expectedRef: MIRROR })).toThrow("not MIRROR_PROJECT_REF");
  });
  it("refuses the transaction pooler and unknown hosts", () => {
    expect(() => resolveMirrorTarget({ apiUrl: null, dbUri: pooler(MIRROR, 6543), expectedRef: MIRROR })).toThrow("port 5432");
    expect(() => refFromDbUri("postgresql://postgres:x@localhost:5432/postgres")).toThrow();
    expect(() => refFromDbUri(`postgresql://postgres.${MIRROR}:x@evil.example.com:5432/postgres`)).toThrow();
  });
  it("refuses a connection whose user and host name different projects", () => {
    expect(() => refFromDbUri(`postgresql://postgres.${MIRROR}:x@db.wmycgyjsenvgtczlupoe.supabase.co:5432/postgres`)).toThrow("different");
  });
});

describe("planTable", () => {
  const cols = ["id", "tenant_id", "created_at"];
  it("never copies pending work, live credentials, prod Vault pointers or live sessions", () => {
    for (const t of ["slack_outbox", "agent_work_items", "tiktok_scheduled_posts", "ads_campaign_operations", "meta_ads_pending_connections",
      "discord_link_tokens", "telegram_link_tokens", "tenant_member_invites", "tenant_pats", "devices", "email_unsub_token",
      "tenant_resources", "tenant_db_config", "tenant_buffer_connection", "site_function_secrets", "site_design_briefs",
      "tenant_sandbox", "browser_sessions", "meeting_bots", "agent_run_events", "secrets", "tenant_users", "db_connectors",
      "tenant_subscriptions", "ads_wallets", "ads_wallet_orders", "ads_wallet_consents", "sites", "site_test_sites", "site_page_views", "site_inline_edit_calls"]) {
      expect(planTable(t, cols, 10).action).toBe("skip");
    }
  });
  it("skips a table nobody has put on the allowlist (fail closed)", () => {
    expect(planTable("brand_new_table", cols, 10)).toEqual({ action: "skip", reason: "not on the mirror allowlist" });
  });
  it("copies small tables whole and windows big ones", () => {
    expect(planTable("decisions", cols, 1500)).toEqual({ action: "copy", sinceDays: null, sinceColumn: null });
    expect(planTable("agent_runs", cols, 8248)).toEqual({ action: "copy", sinceDays: 14, sinceColumn: "created_at" });
    expect(planTable("decisions", cols, 0).action).toBe("skip");
  });
  it("the allowlist holds no credential-bearing table", () => {
    for (const t of TABLE_ALLOWLIST) expect(t).not.toMatch(/(_link_tokens|invites|_pats$|unsub|pending_connections|outbox|reservations|secrets)/);
  });
});

describe("credentials carried into the mirror", () => {
  it("carries connector tokens", () => {
    for (const k of ["google_ads.refresh_token", "meta_ads.access_token", "slack.bot_token:T123", "jira.refresh_token", "linkedin_ads.access_token", "tiktok.refresh_token"]) {
      expect(secretAllowed(k)).toBe(true);
    }
  });
  it("never carries anything else, including keys it has never seen", () => {
    for (const k of ["operator_db.connection_string", "stripe.api_key", "db.connection_uri", "app.session_secret", "github.token",
      "composio.x", "pipedream.y", "qa.upcar.password", "social.x.password", "agent_setup.foo", "brand_new.key"]) {
      expect(secretAllowed(k)).toBe(false);
    }
  });
  it("keeps a connector only when its credentials were carried", () => {
    const fam = carriedFamilies(["google_ads.refresh_token", "slack.bot_token:T1", "operator_db.connection_string", "stripe.api_key"]);
    expect([...fam].sort()).toEqual(["google_ads", "slack"]);
    for (const id of ["google_ads", "slack"]) expect(connectorKept(id, fam)).toBe(true);
    for (const id of ["github", "stripe", "operator_db", "composio", "composio.tiktok_ads", "pipedream_mysql", "pipedream.posthog", "meta_ads", "brand_new"]) {
      expect(connectorKept(id, fam)).toBe(false);
    }
  });
});

describe("schema and config helpers", () => {
  const col = (name, type = "text") => ({ column_name: name, data_type: type, udt_name: type, is_nullable: "YES", is_generated: "NEVER" });
  it("drops generated columns from inserts", () => {
    expect(insertableColumns([col("a"), { ...col("b"), is_generated: "ALWAYS" }])).toEqual(["a"]);
  });
  it("stops when the mirror is behind prod or a type differs", () => {
    const prod = new Map([["t1", [col("a"), col("b", "jsonb")]]]);
    const drift = schemaMismatches(prod, new Map([["t1", [col("a"), col("b", "text")]]]), ["t1"]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatch(/^t1\.b: prod jsonb:jsonb.*, mirror text:text/);
    expect(schemaMismatches(prod, new Map([["t1", [col("a")]]]), ["t1"])).toEqual(["t1.b: missing in mirror"]);
    expect(schemaMismatches(prod, new Map(), ["t1"])).toEqual(["t1: missing in mirror"]);
  });
  it("allows the mirror to be ahead with optional columns, not with a required one", () => {
    const prod = new Map([["t1", [col("a")]]]);
    expect(schemaMismatches(prod, new Map([["t1", [col("a"), col("new_optional")]]]), ["t1"])).toEqual([]);
    expect(schemaMismatches(prod, new Map([["t1", [col("a"), { ...col("new_req"), is_nullable: "NO", column_default: "now()" }]]]), ["t1"])).toEqual([]);
    expect(schemaMismatches(prod, new Map([["t1", [col("a"), { ...col("new_req"), is_nullable: "NO", column_default: null }]]]), ["t1"])).toEqual(["t1.new_req: mirror-only and required with no default"]);
  });
  it("enum labels: mirror may have more, never fewer", () => {
    const prod = new Map();
    expect(schemaMismatches(prod, prod, [], new Map([["s", ["a", "b"]]]), new Map([["s", ["a", "b", "c"]]]))).toEqual([]);
    expect(schemaMismatches(prod, prod, [], new Map([["s", ["a", "b"]]]), new Map([["s", ["a"]]]))).toEqual(["enum s: mirror lacks [b]"]);
  });
  it("scrubs credential-looking keys at any depth", () => {
    expect(scrubConfigBlob({ a: { b: 1, webhook_secret: "x", list: [{ token: "y", ok: 2 }] } })).toEqual({ a: { b: 1, list: [{ ok: 2 }] } });
  });
  it("catches a narrower varchar and a column that became NOT NULL in the mirror", () => {
    const prod = new Map([["t1", [{ ...col("a", "character varying"), character_maximum_length: 200 }, col("b")]]]);
    const mir = new Map([["t1", [{ ...col("a", "character varying"), character_maximum_length: 50 }, { ...col("b"), is_nullable: "NO" }]]]);
    expect(schemaMismatches(prod, mir, ["t1"])).toHaveLength(2);
  });
  it("never copies a credential-looking config key", () => {
    expect(scrubConfigBlob({ tier_gate_enforced: false, some_api_key: "x", slack_token: "y", free_daily_credits: 1000 })).toEqual({ tier_gate_enforced: false, free_daily_credits: 1000 });
  });
  it("keeps a raw password with URL-special characters", () => {
    expect(parsePgUri("postgresql://zavi_ro.ref:p@ss#w/rd?x@aws-1.pooler.supabase.com:5432/postgres")).toMatchObject({ user: "zavi_ro.ref", password: "p@ss#w/rd?x", host: "aws-1.pooler.supabase.com", port: 5432 });
  });
  it("lands each user on their own prod company when copied, else their first membership", () => {
    expect(pickActiveTenant("b", ["c", "b"])).toBe("b");
    expect(pickActiveTenant("z", ["c", "b"])).toBe("b");
    expect(pickActiveTenant("a", [])).toBe(null);
  });
  it("env files: duplicate keys are refused, export and quotes handled", () => {
    expect(parseEnvText("A=1\nexport B='x y'\n# c\n")).toEqual({ A: "1", B: "x y" });
    expect(() => parseEnvText("MIRROR_DB_URL=prod\nMIRROR_DB_URL=mirror\n")).toThrow("duplicate key MIRROR_DB_URL");
  });
  it("reads only from the exact prod project", () => {
    const ro = "postgresql://zavi_ro.wmycgyjsenvgtczlupoe:x@aws-1-us-west-2.pooler.supabase.com:5432/postgres";
    expect(() => assertProdSource({ apiUrl: "https://wmycgyjsenvgtczlupoe.supabase.co", dbUri: ro })).not.toThrow();
    expect(() => assertProdSource({ apiUrl: "https://evil.example/wmycgyjsenvgtczlupoe", dbUri: ro })).toThrow();
    expect(() => assertProdSource({ apiUrl: "https://wmycgyjsenvgtczlupoe.supabase.co", dbUri: pooler(MIRROR) })).toThrow();
  });
});

describe("fkRepair", () => {
  it("nulls only the optional component of a MATCH SIMPLE composite FK", () => {
    expect(fkRepair({ cols: ["tenant_id", "source_decision_id"], notnull: [true, false], match: "s" })).toEqual({ action: "null", cols: ["source_decision_id"] });
  });
  it("deletes when every component is required", () => {
    expect(fkRepair({ cols: ["tenant_id", "thread_id"], notnull: [true, true], match: "s" })).toEqual({ action: "delete" });
  });
  it("MATCH FULL nulls only when every component may be null", () => {
    expect(fkRepair({ cols: ["a", "b"], notnull: [true, false], match: "f" })).toEqual({ action: "delete" });
    expect(fkRepair({ cols: ["a", "b"], notnull: [false, false], match: "f" })).toEqual({ action: "null", cols: ["a", "b"] });
  });
  it("single nullable column is nulled", () => {
    expect(fkRepair({ cols: ["created_by"], notnull: [false], match: "s" })).toEqual({ action: "null", cols: ["created_by"] });
  });
});

describe("window column", () => {
  it("windows a big table that has no created_at on its own row-time column", () => {
    expect(planTable("agent_runs", ["tenant_id", "enqueued_at", "started_at"], 9000)).toEqual({ action: "copy", sinceDays: 14, sinceColumn: "enqueued_at" });
  });
  it("copies a big table whole when it has no known row-time column", () => {
    expect(planTable("agent_runs", ["tenant_id", "started_at"], 9000)).toEqual({ action: "copy", sinceDays: null, sinceColumn: null });
  });
});

function managementApi({ initial = {}, ignorePatch = false, patchStatus = 200 } = {}) {
  const config = { ...initial, site_url: "http://localhost:3000" };
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    if (init.method === "PATCH") {
      if (patchStatus !== 200) return { ok: false, status: patchStatus, json: async () => ({}) };
      if (!ignorePatch) Object.assign(config, JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ ...config }) };
    }
    return { ok: true, status: 200, json: async () => ({ ...config }) };
  };
  return { fetch, calls, config };
}

describe("syncAuthHooks", () => {
  it("turns on the custom access token hook on a mirror that lacks it, then reads it back", async () => {
    const api = managementApi({ initial: { hook_custom_access_token_enabled: false, hook_custom_access_token_uri: null } });
    await syncAuthHooks({ ref: MIRROR, token: "sbp_test", fetch: api.fetch });
    expect(api.config.hook_custom_access_token_enabled).toBe(true);
    expect(api.config.hook_custom_access_token_uri).toBe("pg-functions://postgres/public/custom_access_token_hook");
    expect(api.calls.map((c) => c.method)).toEqual(["PATCH", "GET"]);
    expect(api.calls.every((c) => c.url === `https://api.supabase.com/v1/projects/${MIRROR}/config/auth`)).toBe(true);
    expect(api.calls.every((c) => c.auth === "Bearer sbp_test")).toBe(true);
    expect(api.calls[0].body).toEqual(PROD_AUTH_HOOKS);
  });

  it("fails when the PATCH answers ok but the read-back still shows the hook off", async () => {
    const api = managementApi({ initial: { hook_custom_access_token_enabled: false }, ignorePatch: true });
    await expect(syncAuthHooks({ ref: MIRROR, token: "sbp_test", fetch: api.fetch })).rejects.toThrow(/hook_custom_access_token_enabled is false, prod has true/);
  });

  it("fails on a rejected PATCH instead of reporting success", async () => {
    const api = managementApi({ patchStatus: 401 });
    await expect(syncAuthHooks({ ref: MIRROR, token: "sbp_bad", fetch: api.fetch })).rejects.toThrow(/HTTP 401/);
    expect(api.calls.map((c) => c.method)).toEqual(["PATCH"]);
  });

  it("never sends a request at prod or shared staging", async () => {
    for (const ref of [PROD_REF, STAGING_REF]) {
      const api = managementApi();
      await expect(syncAuthHooks({ ref, token: "sbp_test", fetch: api.fetch })).rejects.toThrow(/refusing/);
      expect(api.calls).toEqual([]);
    }
  });

  it("stops before any request when the access token is missing", async () => {
    const api = managementApi();
    await expect(syncAuthHooks({ ref: MIRROR, token: "", fetch: api.fetch })).rejects.toThrow(/SUPABASE_ACCESS_TOKEN/);
    expect(api.calls).toEqual([]);
  });

  it("reports a hook pointed at the wrong function as a gap", () => {
    expect(authConfigGaps({ hook_custom_access_token_enabled: true, hook_custom_access_token_uri: "pg-functions://postgres/public/other_hook" })).toEqual([
      'hook_custom_access_token_uri is "pg-functions://postgres/public/other_hook", prod has "pg-functions://postgres/public/custom_access_token_hook"',
    ]);
    expect(authConfigGaps({ ...PROD_AUTH_HOOKS })).toEqual([]);
  });
});

describe("activeTenantClaim", () => {
  const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

  it("reads the claim from a base64url payload that standard base64 decoding would mangle", () => {
    const payload = { app_metadata: { active_tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204" }, pad: "??>>~~" };
    const token = jwt(payload);
    expect(token.split(".")[1]).toMatch(/[-_]/);
    expect(activeTenantClaim(token)).toBe("73db45ff-457e-4541-bc8f-bdb625390204");
  });

  it("returns null for a mirror token without the hook's claim", () => {
    expect(activeTenantClaim(jwt({ app_metadata: { provider: "email", providers: ["email"] } }))).toBeNull();
    expect(activeTenantClaim(jwt({ app_metadata: { active_tenant_id: "" } }))).toBeNull();
    expect(activeTenantClaim("not-a-jwt")).toBeNull();
    expect(activeTenantClaim("h.%%%.s")).toBeNull();
    expect(activeTenantClaim(undefined)).toBeNull();
  });
});

describe("planCreatorCopy", () => {
  const creator = (id, auth) => ({ id, auth_user_id: auth, display_name: `Creator ${id}`, vetting_state: "approved", country_code: "US" });
  const prodCreators = [creator("c1", "u1"), creator("c2", "u2")];
  const handles = [
    { id: "h1", human_member_id: "c1", platform: "tiktok", handle: "@one" },
    { id: "h2", human_member_id: "c2", platform: "instagram", handle: "@two" },
    { id: "h3", human_member_id: "pending-creator", platform: "tiktok", handle: "@pending" },
  ];
  const packages = [
    { id: "p1", human_member_id: "c1", active: true },
    { id: "p2", human_member_id: "c2", active: false },
    { id: "p3", human_member_id: "pending-creator", active: true },
  ];

  it("gives every creator a mirror login on an undeliverable address", () => {
    const plan = planCreatorCopy({ creators: prodCreators, handles, packages, memberIds: [] });
    expect(plan.logins).toEqual([
      { id: "u1", email: "u1@mirror.invalid" },
      { id: "u2", email: "u2@mirror.invalid" },
    ]);
    expect(plan.logins.every((l) => l.email.endsWith("@mirror.invalid"))).toBe(true);
  });

  it("does not make a second login for a creator who is already a copied company member", () => {
    const plan = planCreatorCopy({ creators: prodCreators, handles, packages, memberIds: ["u2"] });
    expect(plan.logins.map((l) => l.id)).toEqual(["u1"]);
    expect(plan.authUserIds).toEqual(["u1", "u2"]);
  });

  it("carries only handles and active packages of the copied creators", () => {
    const plan = planCreatorCopy({ creators: prodCreators, handles, packages, memberIds: [] });
    expect(plan.handles.map((h) => h.id)).toEqual(["h1", "h2"]);
    expect(plan.packages.map((p) => p.id)).toEqual(["p1"]);
  });

  it("wipes creators copied last time that prod no longer approves, along with this run's", () => {
    const plan = planCreatorCopy({ creators: prodCreators, handles, packages, memberIds: [], prevCreatorIds: ["gone", "c1"] });
    expect(plan.wipeIds.sort()).toEqual(["c1", "c2", "gone"]);
  });

  it("copies only the creator storefront tables, never PII or payout accounts", () => {
    expect(CREATOR_TABLES).toEqual(["human_members", "human_member_handles", "creator_packages"]);
    expect(CREATOR_TABLES).not.toContain("human_member_pii");
    expect(CREATOR_TABLES).not.toContain("creator_payout_accounts");
  });
});
