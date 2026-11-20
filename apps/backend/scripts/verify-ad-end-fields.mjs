
const TENANT = process.env.TENANT_ID?.trim();
if (!TENANT || !/^[0-9a-f-]{36}$/i.test(TENANT)) throw new Error("set TENANT_ID to the tenant whose ad accounts this checks");
const STAMP = new Date().toISOString().slice(0, 10);
const NAME = (what) => `ZAVI-VERIFY-DELETE-${STAMP}-${what}`;
const SURL = process.env.SUPABASE_URL;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SURL || !SRK || !SURL.includes("wmycgyjsenvgtczlupoe")) throw new Error("needs the PROD SUPABASE_URL + service role (prodqa.env)");

const out = [];
const log = (o) => { out.push(o); console.log(JSON.stringify(o)); };

function guard(vendor, method, path, body) {
  const fail = (why) => { throw new Error(`GUARD (${vendor} ${method} ${path}): ${why}`); };
  if (method === "GET") return;
  if (vendor === "chatgpt") {
    if (path === "/campaigns" || path === "/ad_groups") { if (body?.status !== "paused") fail("create must be paused"); if (!String(body?.name ?? "").startsWith("ZAVI-VERIFY-DELETE-")) fail("name"); return; }
    if (/^\/(campaigns|ad_groups)\/[A-Za-z0-9_-]+$/.test(path)) { if (JSON.stringify(body) !== JSON.stringify({ status: "archived" })) fail("only archive"); return; }
    fail("path not allowed");
  }
  if (vendor === "tiktok") {
    if (path === "/campaign/create/" || path === "/adgroup/create/") {
      if (body?.operation_status !== "DISABLE") fail("create must be DISABLE");
      const n = body.campaign_name ?? body.adgroup_name;
      if (!String(n ?? "").startsWith("ZAVI-VERIFY-DELETE-")) fail("name");
      return;
    }
    if (path === "/campaign/status/update/" || path === "/adgroup/status/update/") { if (body?.operation_status !== "DELETE") fail("only DELETE"); return; }
    fail("path not allowed");
  }
  if (vendor === "meta") {
    if (/^\/act_\d+\/campaigns$/.test(path)) { if (body?.status !== "PAUSED") fail("campaign must be PAUSED"); if (!String(body?.name ?? "").startsWith("ZAVI-VERIFY-DELETE-")) fail("name"); return; }
    if (/^\/act_\d+\/adsets$/.test(path)) { if (!String(body?.execution_options ?? "").includes("validate_only")) fail("ad sets are validate_only"); if (body?.status !== "PAUSED") fail("ad set must be PAUSED"); return; }
    if (method === "DELETE" && /^\/\d+$/.test(path)) return;
    fail("path not allowed");
  }
  if (vendor === "google") {
    if (body?.validateOnly !== true) fail("google calls must be validateOnly");
    for (const op of body.mutateOperations ?? []) {
      const c = op.campaignOperation?.create;
      if (c && c.status !== "PAUSED") fail("campaign must be PAUSED");
      if (op.campaignOperation?.update || op.campaignBudgetOperation?.update) fail("no updates");
    }
    return;
  }
  fail("unknown vendor");
}

async function rpc(name, args) {
  const r = await fetch(`${SURL}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
  return r.json();
}
async function row(table, query) {
  const r = await fetch(`${SURL}/rest/v1/${table}?${query}`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
  if (!r.ok) throw new Error(`${table} HTTP ${r.status}`);
  return (await r.json())[0] ?? null;
}

async function chatgpt() {
  const key = await rpc("get_platform_secret", { p_key: "chatgpt_ads_api_key" });
  if (!key) return log({ vendor: "chatgpt", result: "not run", reason: "no platform key" });
  const call = async (method, path, body) => {
    guard("chatgpt", method, path, body);
    const r = await fetch(`https://api.ads.openai.com/v1${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(method === "POST" ? { "Idempotency-Key": crypto.randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
  };
  const now = Math.floor(Date.now() / 1000);
  const camp = await call("POST", "/campaigns", { name: NAME("chatgpt-lifetime"), status: "paused", bidding_type: "clicks", budget: { lifetime_spend_limit_micros: 58_000_000 }, start_time: now + 86400, end_time: now + 3 * 86400, targeting: { locations: { countries: ["US"] } } });
  log({ vendor: "chatgpt", step: "campaign create (paused, lifetime $58)", http: camp.status, id: camp.json?.id ?? null, status: camp.json?.status ?? null, budget: camp.json?.budget ?? null, error: camp.json?.error?.message ?? null });
  if (!camp.json?.id) return;
  const grp = await call("POST", "/ad_groups", { campaign_id: camp.json.id, name: NAME("chatgpt-group"), context_hints: [], status: "paused", bidding_config: { billing_event_type: "click", strategy: "maximize_clicks" } });
  log({ vendor: "chatgpt", step: "ad group create (paused, maximize_clicks on lifetime)", http: grp.status, id: grp.json?.id ?? null, status: grp.json?.status ?? null, bidding: grp.json?.bidding_config ?? null, error: grp.json?.error?.message ?? null });
  if (grp.json?.id) {
    const a = await call("POST", `/ad_groups/${grp.json.id}`, { status: "archived" });
    log({ vendor: "chatgpt", step: "ad group archive", http: a.status, status: a.json?.status ?? null });
  }
  const a = await call("POST", `/campaigns/${camp.json.id}`, { status: "archived" });
  log({ vendor: "chatgpt", step: "campaign archive", http: a.status, status: a.json?.status ?? null });
}

async function tiktok() {
  const meta = await row("connector_metadata", `tenant_id=eq.${TENANT}&slug=eq.composio.tiktok_ads&select=team_id,selected_ad_account_id`);
  const ck = process.env.COMPOSIO_API_KEY;
  if (!meta?.team_id || !meta?.selected_ad_account_id || !ck) return log({ vendor: "tiktok", result: "not run", reason: "no composio tiktok_ads account / advertiser / key" });
  const adv = meta.selected_ad_account_id;
  const call = async (method, endpoint, body) => {
    guard("tiktok", method, endpoint, body);
    const r = await fetch("https://backend.composio.dev/api/v3.1/tools/execute/proxy", { method: "POST", redirect: "manual", headers: { "x-api-key": ck, "Content-Type": "application/json" }, body: JSON.stringify({ connected_account_id: meta.team_id, method, endpoint, ...(body ? { body } : {}) }) });
    const j = await r.json().catch(() => ({}));
    return { http: r.status, code: j?.data?.code ?? null, message: j?.data?.message ?? j?.error?.message ?? null, data: j?.data?.data ?? null };
  };
  const info = await call("GET", `/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify([adv]))}&fields=${encodeURIComponent(JSON.stringify(["timezone", "currency", "status"]))}`);
  const tz = info.data?.list?.[0]?.timezone ?? "UTC";
  const fmt = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d).replace("T", " ");
  log({ vendor: "tiktok", step: "advertiser info", http: info.http, code: info.code, timezone: tz, currency: info.data?.list?.[0]?.currency ?? null });
  const camp = await call("POST", "/campaign/create/", { advertiser_id: adv, campaign_name: NAME("tiktok-campaign"), objective_type: "TRAFFIC", budget_mode: "BUDGET_MODE_INFINITE", operation_status: "DISABLE" });
  log({ vendor: "tiktok", step: "campaign create (DISABLE)", http: camp.http, code: camp.code, message: camp.message, id: camp.data?.campaign_id ?? null });
  const cid = camp.data?.campaign_id;
  if (!cid) return;
  const start = new Date(Date.now() + 86400_000), end = new Date(Date.now() + 3 * 86400_000);
  const grp = await call("POST", "/adgroup/create/", {
    advertiser_id: adv, campaign_id: cid, adgroup_name: NAME("tiktok-adgroup"), promotion_type: "WEBSITE",
    placement_type: "PLACEMENT_TYPE_NORMAL", placements: ["PLACEMENT_TIKTOK"], location_ids: ["6252001"],
    budget_mode: "BUDGET_MODE_DAY", budget: 20.01,
    schedule_type: "SCHEDULE_START_END", schedule_start_time: fmt(start), schedule_end_time: fmt(end),
    optimization_goal: "CLICK", billing_event: "CPC", bid_type: "BID_TYPE_NO_BID", pacing: "PACING_MODE_SMOOTH",
    operation_status: "DISABLE",
  });
  log({ vendor: "tiktok", step: "ad group create (DISABLE, SCHEDULE_START_END)", http: grp.http, code: grp.code, message: grp.message, id: grp.data?.adgroup_id ?? null, start: fmt(start), end: fmt(end) });
  const gid = grp.data?.adgroup_id;
  if (gid) {
    const rb = await call("GET", `/adgroup/get/?advertiser_id=${adv}&filtering=${encodeURIComponent(JSON.stringify({ adgroup_ids: [gid] }))}&fields=${encodeURIComponent(JSON.stringify(["adgroup_id", "schedule_type", "schedule_start_time", "schedule_end_time", "operation_status", "budget"]))}`);
    log({ vendor: "tiktok", step: "ad group read-back", code: rb.code, row: rb.data?.list?.[0] ?? null });
    const d = await call("POST", "/adgroup/status/update/", { advertiser_id: adv, adgroup_ids: [gid], operation_status: "DELETE" });
    log({ vendor: "tiktok", step: "ad group delete", code: d.code, message: d.message });
  }
  const d = await call("POST", "/campaign/status/update/", { advertiser_id: adv, campaign_ids: [cid], operation_status: "DELETE" });
  log({ vendor: "tiktok", step: "campaign delete", code: d.code, message: d.message });
}

async function meta() {
  const [token, acct] = await Promise.all(["meta_ads.access_token", "meta_ads.ad_account_id"].map((k) => rpc("get_secret", { p_tenant_id: TENANT, p_key: k })));
  if (!token || !acct) return log({ vendor: "meta", result: "not run", reason: "no meta credential" });
  const account = String(acct).startsWith("act_") ? String(acct) : `act_${acct}`;
  const call = async (method, path, body) => {
    guard("meta", method, path, body);
    const form = new URLSearchParams({ access_token: token });
    for (const [k, v] of Object.entries(body ?? {})) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const r = await fetch(`https://graph.facebook.com/v25.0${path}${method === "DELETE" ? `?access_token=${encodeURIComponent(token)}` : ""}`, method === "DELETE" ? { method } : { method, body: form });
    const j = await r.json().catch(() => ({}));
    return { http: r.status, json: j, error: j?.error ? `${j.error.code}/${j.error.error_subcode ?? ""}: ${String(j.error.error_user_msg ?? j.error.message ?? "").slice(0, 200)}` : null };
  };
  const camp = await call("POST", `/${account}/campaigns`, { name: NAME("meta-campaign"), objective: "OUTCOME_TRAFFIC", status: "PAUSED", special_ad_categories: [], daily_budget: "100", bid_strategy: "LOWEST_COST_WITHOUT_CAP" });
  log({ vendor: "meta", step: "campaign create (PAUSED, CBO $1/day)", http: camp.http, id: camp.json?.id ?? null, error: camp.error });
  const cid = camp.json?.id;
  if (!cid) return;
  const end = new Date(Date.now() + 3 * 86400_000).toISOString().replace(/\.\d{3}Z$/, "+0000");
  const adset = await call("POST", `/${account}/adsets`, { name: NAME("meta-adset"), campaign_id: cid, optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: { geo_locations: { countries: ["US"] }, age_min: 18 }, end_time: end, status: "PAUSED", execution_options: ["validate_only"] });
  log({ vendor: "meta", step: "ad set validate_only (PAUSED, end_time)", http: adset.http, accepted: adset.http === 200 && !adset.error, success: adset.json?.success ?? null, end_time: end, error: adset.error });
  const del = await call("DELETE", `/${cid}`);
  log({ vendor: "meta", step: "campaign delete", http: del.http, success: del.json?.success ?? null, error: del.error });
}

async function google() {
  const [refresh, customer, login] = await Promise.all(["google_ads.refresh_token", "google_ads.customer_id", "google_ads.login_customer_id"].map((k) => rpc("get_secret", { p_tenant_id: TENANT, p_key: k })));
  const { GOOGLE_ADS_CLIENT_ID: id, GOOGLE_ADS_CLIENT_SECRET: secret, GOOGLE_ADS_DEVELOPER_TOKEN: dev } = process.env;
  if (!refresh || !customer || !id || !secret || !dev) return log({ vendor: "google", result: "not run", reason: "missing google credential" });
  const t = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }) });
  const tok = (await t.json().catch(() => ({}))).access_token;
  if (!tok) return log({ vendor: "google", result: "not run", reason: `token exchange HTTP ${t.status}` });
  const cid = String(customer).replace(/-/g, "");
  const day = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
  const body = {
    validateOnly: true, partialFailure: false,
    mutateOperations: [
      { campaignBudgetOperation: { create: { resourceName: `customers/${cid}/campaignBudgets/-1`, name: NAME("google-budget"), amountMicros: "1000000", deliveryMethod: "STANDARD", explicitlyShared: false } } },
      { campaignOperation: { create: { resourceName: `customers/${cid}/campaigns/-2`, name: NAME("google-campaign"), status: "PAUSED", advertisingChannelType: "SEARCH", campaignBudget: `customers/${cid}/campaignBudgets/-1`, containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING", manualCpc: {}, networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false }, startDateTime: `${day(1)} 00:00:00`, endDateTime: `${day(3)} 23:59:59` } } },
    ],
  };
  guard("google", "POST", "googleAds:mutate", body);
  const headers = { Authorization: `Bearer ${tok}`, "developer-token": dev, "Content-Type": "application/json", ...(login ? { "login-customer-id": String(login).replace(/-/g, "") } : {}) };
  const r = await fetch(`https://googleads.googleapis.com/v25/customers/${cid}/googleAds:mutate`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  const errs = (() => { try { return (JSON.parse(text).error?.details ?? []).flatMap((d) => (d.errors ?? []).map((e) => `${Object.values(e.errorCode ?? {}).join("/")}: ${e.message}`)); } catch { return [text.slice(0, 300)]; } })();
  log({ vendor: "google", step: "validateOnly create (PAUSED Search, end_date_time)", http: r.status, accepted: r.ok, errors: r.ok ? [] : errs });
}

const which = process.argv[2] ?? "all";
for (const [name, fn] of [["chatgpt", chatgpt], ["tiktok", tiktok], ["google", google], ["meta", meta]]) {
  if (which !== "all" && which !== name) continue;
  try { await fn(); } catch (e) { log({ vendor: name, result: "error", message: String(e.message).slice(0, 300) }); }
}
