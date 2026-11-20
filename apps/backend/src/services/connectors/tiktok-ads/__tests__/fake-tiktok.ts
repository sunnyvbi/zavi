
export type Fault =
  | { method: "POST"; path: string; nth?: number; kind: "lost" | "lost_unapplied" | "http500" }
  | { method: "GET"; path?: string; nth?: number; kind: "fail" };

type Obj = Record<string, unknown> & { id: string; operation_status: string };

export const CUSTOM_IDENTITY_MESSAGE =
  "Custom identities are no longer supported. Use an authorized TikTok account or the post authorized by the account. If you've done this, select";
export const PAYMENT_MESSAGE = "Complete payment to continue";

export function makeFakeTiktok() {
  const f = {
    advertiser: { advertiser_id: "7689989546330849300", name: "Main", currency: "USD", status: "STATUS_ENABLE", timezone: "Etc/GMT+8" } as Record<string, unknown>,
    bcs: ["7695136887945789461"],
    identities: [
      { identity_id: "8f5d4c18-e601-5496-b38f-566335ea3ec3", identity_type: "BC_AUTH_TT", display_name: "brand handle", identity_authorized_bc_id: "7695136887945789461" },
      { identity_id: "7695135145485434887", identity_type: "CUSTOMIZED_USER", display_name: "custom" },
    ] as Array<Record<string, unknown>>,
    uploads: new Map<string, { width: number; height: number; duration: number; allowed_placements: string[] }>(),
    unreachable: new Set<string>(),
    videos: new Map<string, Record<string, unknown>>(),
    images: [] as string[],
    campaigns: new Map<string, Obj>(),
    adgroups: new Map<string, Obj>(),
    adgroupReadOverrides: {} as Record<string, unknown>,
    ads: new Map<string, Obj>(),
    languages: [{ code: "en", name: "English" }, { code: "es", name: "Spanish" }, { code: "zh-Hant", name: "Traditional Chinese" }, { code: "fi", name: " Finnish" }],
    places: [
      { geo_id: "6252001", geo_type: "COUNTRY", parent_id: "0", region_code: "US", name: "United States", enabled: true },
      { geo_id: "6251999", geo_type: "COUNTRY", parent_id: "0", region_code: "CA", name: "Canada", enabled: true },
      { geo_id: "4736286", geo_type: "PROVINCE", parent_id: "6252001", region_code: "US", name: "Texas", enabled: true },
      { geo_id: "4671654", geo_type: "CITY", parent_id: "4736286", region_code: "US", name: "Austin", enabled: true },
      { geo_id: "1269750", geo_type: "COUNTRY", parent_id: "0", region_code: "IN", name: "India", enabled: false },
    ] as Array<{ geo_id: string; geo_type: string; parent_id: string; region_code: string; name: string; enabled: boolean }>,
    paymentMissing: false,
    customOnly: false,
    dropScheduleEnd: false,
    review: "AD_STATUS_AUDIT",
    faults: [] as Fault[],
    listLag: 0,
    hidden: new Map<string, number>(),
    posts: [] as Array<{ endpoint: string; body: Record<string, unknown> }>,
    events: [] as string[],
    counts: new Map<string, number>(),
    nextId: 1878696308800400,
  };

  const ok = (data: unknown) => ({ ok: true, status: 200, json: { code: 0, message: "OK", request_id: "r", data } });
  const refuse = (code: number, message: string) => ({ ok: true, status: 200, json: { code, message, request_id: "r", data: {} } });
  const lost = { ok: false, status: 0, json: { error: "composio_transport_error" } };
  const id = () => String(++f.nextId);

  function secondary(level: "campaign" | "adgroup" | "ad", o: Obj): string {
    if (o.deleted) return level === "campaign" ? "CAMPAIGN_STATUS_DELETE" : level === "adgroup" ? "ADGROUP_STATUS_DELETE" : "AD_STATUS_DELETE";
    const c = f.campaigns.get(String(o.campaign_id));
    if (level === "campaign") return o.operation_status === "DISABLE" ? "CAMPAIGN_STATUS_DISABLE" : "CAMPAIGN_STATUS_ENABLE";
    if (c?.operation_status === "DISABLE") return level === "adgroup" ? "ADGROUP_STATUS_CAMPAIGN_DISABLE" : "AD_STATUS_CAMPAIGN_DISABLE";
    if (level === "adgroup") return o.operation_status === "DISABLE" ? "ADGROUP_STATUS_DISABLE" : f.review.includes("DELIVERY_OK") ? "ADGROUP_STATUS_DELIVERY_OK" : "ADGROUP_STATUS_NOT_DELIVER";
    const g = f.adgroups.get(String(o.adgroup_id));
    if (g?.operation_status === "DISABLE") return "AD_STATUS_ADGROUP_DISABLE";
    return o.operation_status === "DISABLE" ? "AD_STATUS_DISABLE" : f.review;
  }

  function view(level: "campaign" | "adgroup" | "ad", o: Obj) {
    const { id: oid, deleted: _d, ...rest } = o;
    const key = level === "campaign" ? "campaign_id" : level === "adgroup" ? "adgroup_id" : "ad_id";
    return { ...rest, ...(level === "adgroup" ? f.adgroupReadOverrides : {}), [key]: oid, secondary_status: secondary(level, o) };
  }

  function fault(method: "GET" | "POST", path: string): Fault | null {
    const n = (f.counts.get(`${method} ${path}`) ?? 0) + 1;
    f.counts.set(`${method} ${path}`, n);
    const all = (f.counts.get(method) ?? 0) + 1;
    f.counts.set(method, all);
    const i = f.faults.findIndex((x) => x.method === method && (x.path === undefined || x.path === path) && (x.nth === undefined || x.nth === (x.path === undefined ? all : n)));
    if (i < 0) return null;
    return f.faults.splice(i, 1)[0];
  }

  const tag = (p: (typeof f.places)[number], keyword?: string) => ({
    geo: { description: p.geo_type, geo_id: p.geo_id, geo_type: p.geo_type, parent_id: p.parent_id, region_code: p.region_code },
    isp: null,
    ...(keyword ? { keyword } : {}),
    name: p.name,
    status_info: p.enabled ? { reason: null, status: "ENABLED" } : { reason: "NOT_SUPPORTED", status: "DISABLED" },
    targeting_type: "GEO",
  });
  const parentsOf = (rows: typeof f.places) => {
    const out: typeof f.places = [];
    for (let r of rows) for (let i = 0; i < 5; i++) {
      const p = f.places.find((x) => x.geo_id === r.parent_id);
      if (!p || out.includes(p)) break;
      out.push(p);
      r = p;
    }
    return out;
  };

  function apply(endpoint: string, b: Record<string, unknown>): ReturnType<typeof ok> | ReturnType<typeof refuse> {
    switch (endpoint) {
      case "/tool/targeting/search/": {
        if (b.search_type !== "FUZZY_SEARCH" || !Array.isArray(b.keywords) || b.keywords.length !== 1) return refuse(40002, "bad search");
        const kw = String(b.keywords[0]).toLowerCase();
        const codes = Array.isArray(b.region_codes) ? (b.region_codes as string[]) : null;
        const hits = f.places.filter((p) => p.enabled && p.name.toLowerCase().includes(kw) && (!codes || codes.includes(p.region_code)));
        return ok({ parent_tags: parentsOf(hits).map((p) => tag(p)), targeting_tag_list: hits.map((p) => tag(p, String(b.keywords![0 as never]))) });
      }
      case "/tool/targeting/info/": {
        const ids = Array.isArray(b.targeting_ids) ? (b.targeting_ids as string[]) : [];
        const hits = f.places.filter((p) => ids.includes(p.geo_id));
        return ok({ parent_tags: parentsOf(hits).map((p) => tag(p)), targeting_tag_list: hits.map((p) => tag(p)) });
      }
      case "/file/video/ad/upload/": {
        const url = String(b.video_url);
        if (f.unreachable.has(url)) return refuse(40914, "Failed to fetch url data. Please try again.");
        const spec = f.uploads.get(url) ?? { width: 720, height: 1280, duration: 12, allowed_placements: ["PLACEMENT_TOPBUZZ", "PLACEMENT_TIKTOK", "PLACEMENT_PANGLE"] };
        const vid = `v10033g50000${id()}`;
        const info = { video_id: vid, format: "mp4", displayable: true, ...spec, video_cover_url: `http://p16-common-sign.tiktokcdn.com/${vid}~tplv-noop.image`, file_name: b.file_name };
        f.videos.set(vid, info);
        return ok([{ video_id: vid, format: "mp4", allowed_placements: spec.allowed_placements, displayable: true, material_id: "7062291627532320770" }]);
      }
      case "/file/image/ad/upload/": {
        const img = `ad-site-i18n-sg/${id()}`;
        f.images.push(img);
        return ok({ image_id: img, displayable: false, format: "jpeg", width: 720, height: 1280 });
      }
      case "/campaign/create/": {
        if (f.paymentMissing) return refuse(40002, PAYMENT_MESSAGE);
        const cid = id();
        if (f.listLag) f.hidden.set(cid, f.listLag);
        f.campaigns.set(cid, { id: cid, campaign_name: b.campaign_name, objective_type: b.objective_type, budget_mode: b.budget_mode, budget: 0, operation_status: String(b.operation_status) });
        return ok({ campaign_id: cid, operation_status: b.operation_status, budget_mode: b.budget_mode, secondary_status: "CAMPAIGN_STATUS_DISABLE", is_new_structure: true });
      }
      case "/adgroup/create/": {
        const c = f.campaigns.get(String(b.campaign_id));
        if (!c) return refuse(40002, "Campaign does not exist");
        const gid = id();
        if (f.listLag) f.hidden.set(gid, f.listLag);
        f.adgroups.set(gid, { id: gid, campaign_id: b.campaign_id, adgroup_name: b.adgroup_name, budget: b.budget, budget_mode: b.budget_mode, location_ids: b.location_ids, age_groups: b.age_groups ?? [], gender: b.gender ?? "GENDER_UNLIMITED", languages: b.languages ?? [], placements: b.placements, optimization_goal: b.optimization_goal, schedule_start_time: b.schedule_start_time, ...(b.schedule_type ? { schedule_type: f.dropScheduleEnd ? "SCHEDULE_FROM_NOW" : b.schedule_type } : {}), ...(b.schedule_end_time && !f.dropScheduleEnd ? { schedule_end_time: b.schedule_end_time } : {}), operation_status: String(b.operation_status) });
        return ok({ adgroup_id: gid, secondary_status: "ADGROUP_STATUS_CAMPAIGN_DISABLE", budget_mode: b.budget_mode, location_ids: b.location_ids });
      }
      case "/ad/create/": {
        const g = f.adgroups.get(String(b.adgroup_id));
        const cr = (b.creatives as Array<Record<string, unknown>>)[0];
        if (!g) return refuse(40002, "Ad group does not exist");
        if (f.customOnly || cr.identity_type === "CUSTOMIZED_USER") return refuse(40002, CUSTOM_IDENTITY_MESSAGE);
        const aid = id();
        if (f.listLag) f.hidden.set(aid, f.listLag);
        f.ads.set(aid, { id: aid, adgroup_id: g.id, campaign_id: g.campaign_id, ad_name: cr.ad_name, landing_page_url: cr.landing_page_url, video_id: cr.video_id, identity_id: cr.identity_id, ad_text: cr.ad_text, call_to_action: cr.call_to_action, operation_status: String(cr.operation_status) });
        return ok({ ad_ids: [aid], need_audit: false, creatives: [{ ...cr, ad_id: aid }] });
      }
      case "/campaign/status/update/":
      case "/adgroup/status/update/":
      case "/ad/status/update/": {
        const [map, key]: [Map<string, Obj>, string] = endpoint.startsWith("/campaign") ? [f.campaigns, "campaign_ids"] : endpoint.startsWith("/adgroup") ? [f.adgroups, "adgroup_ids"] : [f.ads, "ad_ids"];
        for (const x of b[key] as string[]) {
          const o = map.get(x);
          if (!o) return refuse(40002, "object does not exist");
          if (b.operation_status === "DELETE") o.deleted = true;
          else o.operation_status = String(b.operation_status);
        }
        return ok({ [key]: b[key], status: b.operation_status });
      }
    }
    return refuse(40002, `unknown endpoint ${endpoint}`);
  }

  async function proxy(a: { method: string; endpoint: string; body?: Record<string, unknown> }) {
    const url = new URL(a.endpoint, "https://business-api.tiktok.test");
    const path = url.pathname;
    if (a.method === "POST" && path.startsWith("/tool/")) {
      f.events.push(`READ ${path}`);
      return apply(path, a.body ?? {});
    }
    if (a.method === "POST") {
      const b = a.body ?? {};
      f.events.push(`POST ${path}${b.operation_status ? ` ${b.operation_status}` : ""}`);
      f.posts.push({ endpoint: path, body: b });
      const x = fault("POST", path);
      if (x?.kind === "lost_unapplied") return lost;
      if (x?.kind === "http500") return { ok: false, status: 500, json: {} };
      const r = apply(path, b);
      return x?.kind === "lost" ? lost : r;
    }
    f.events.push(`GET ${path}`);
    if (fault("GET", path)) return { ok: false, status: 500, json: {} };
    const p = url.searchParams;
    const filtering = JSON.parse(p.get("filtering") ?? "{}") as Record<string, string[]>;
    const shown = <T extends { id: string }>(o: T): boolean => {
      const n = f.hidden.get(o.id) ?? 0;
      if (n <= 0) return true;
      f.hidden.set(o.id, n - 1);
      return false;
    };
    const page = (list: unknown[]) => ok({ list, page_info: { page: 1, page_size: 1000, total_page: 1, total_number: list.length } });
    switch (path) {
      case "/tool/language/":
        return ok({ languages: f.languages });
      case "/tool/region/":
        return ok({ region_info: f.places.filter((p) => p.geo_type === "COUNTRY" && p.enabled).map((p) => ({ area_type: "ADMIN", level: "COUNTRY", location_id: p.geo_id, name: p.name, next_level_ids: [], parent_id: "0", region_code: p.region_code, support_below_18: true })) });
      case "/advertiser/info/": {
        const ids = JSON.parse(p.get("advertiser_ids") ?? "[]") as string[];
        return ok({ list: ids.includes(String(f.advertiser.advertiser_id)) ? [f.advertiser] : [] });
      }
      case "/bc/get/":
        return page(f.bcs.map((bc) => ({ bc_info: { bc_id: bc } })));
      case "/identity/get/": {
        const type = p.get("identity_type");
        const bc = p.get("identity_authorized_bc_id");
        const list = f.identities.filter((i) => i.identity_type === type && (type !== "BC_AUTH_TT" || i.identity_authorized_bc_id === bc));
        return ok({ identity_list: list, page_info: { page: 1, total_page: 1 } });
      }
      case "/file/video/ad/info/": {
        const ids = JSON.parse(p.get("video_ids") ?? "[]") as string[];
        return ok({ list: ids.map((v) => f.videos.get(v)).filter(Boolean) });
      }
      case "/campaign/get/":
        return page([...f.campaigns.values()].filter((c) => !filtering.campaign_ids || filtering.campaign_ids.includes(c.id)).filter(shown).map((c) => view("campaign", c)));
      case "/adgroup/get/":
        return page([...f.adgroups.values()].filter((g) => (!filtering.adgroup_ids || filtering.adgroup_ids.includes(g.id)) && (!filtering.campaign_ids || filtering.campaign_ids.includes(String(g.campaign_id)))).filter(shown).map((g) => view("adgroup", g)));
      case "/ad/get/":
        return page([...f.ads.values()].filter((x) => (!filtering.ad_ids || filtering.ad_ids.includes(x.id)) && (!filtering.campaign_ids || filtering.campaign_ids.includes(String(x.campaign_id)))).filter(shown).map((x) => view("ad", x)));
    }
    return { ok: false, status: 404, json: {} };
  }

  return { f, proxy };
}

export type FakeTiktok = ReturnType<typeof makeFakeTiktok>;
