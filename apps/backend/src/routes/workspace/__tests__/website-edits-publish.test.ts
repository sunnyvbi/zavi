
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  getBoolSetting: vi.fn(),
  getBoolSettingStrict: vi.fn(),
}));
vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: async () => true }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: mocks.getBoolSetting,
  getBoolSettingStrict: mocks.getBoolSettingStrict,
}));

type Row = Record<string, unknown>;
let store: Row[] = [];
let resourceStore: Row[] = [];
let customDomainStore: Row[] = [];
function tableStore(table: string): Row[] {
  if (table === "tenant_resources") return resourceStore;
  if (table === "tenant_custom_domains") return customDomainStore;
  return store;
}
function makeClient() {
  function builder(table: string) {
    const data = tableStore(table);
    const state: {
      mode: "select" | "update" | "delete" | null;
      filters: [string, unknown][];
      likes: [string, RegExp][];
      ins: [string, unknown[]][];
      notNull: string[];
      order: [string, boolean][];
      vals: Row | null;
      returning: boolean;
    } = { mode: null, filters: [], likes: [], ins: [], notNull: [], order: [], vals: null, returning: false };
    const col = (r: Row, k: string): unknown => {
      const [base, ...path] = k.split("->>");
      let v: unknown = r[base];
      for (const seg of path) v = v && typeof v === "object" ? (v as Row)[seg] : undefined;
      return v;
    };
    const match = (r: Row) =>
      state.filters.every(([k, v]) => col(r, k) === v) &&
      state.likes.every(([k, re]) => typeof col(r, k) === "string" && re.test(col(r, k) as string)) &&
      state.ins.every(([k, vs]) => vs.includes(r[k])) &&
      state.notNull.every((k) => r[k] != null);
    const b = {
      select() {
        if (state.mode === null) state.mode = "select";
        else state.returning = true;
        tableSelects.push(table);
        return b;
      },
      update(v: Row) {
        state.mode = "update";
        state.vals = v;
        return b;
      },
      delete() {
        state.mode = "delete";
        return b;
      },
      upsert(v: Row) {
        data.push({
          id: `id-${String(v.selector ?? data.length)}`,
          published_patch: null,
          published_removed: false,
          published_at: null,
          ...v,
        });
        state.mode = "update";
        state.vals = {};
        return b;
      },
      eq(k: string, v: unknown) {
        state.filters.push([k, v]);
        return b;
      },
      ilike(k: string, pattern: string) {
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, "i");
        state.likes.push([k, re]);
        return b;
      },
      in(k: string, vs: unknown[]) {
        state.ins.push([k, vs]);
        return b;
      },
      is() {
        return b;
      },
      not(k: string) {
        state.notNull.push(k);
        return b;
      },
      order(k: string, opts?: { ascending?: boolean }) {
        state.order.push([k, opts?.ascending !== false]);
        return b;
      },
      then(resolve: (r: { data: Row[] | null; error: null }) => void) {
        if (state.mode === "update") {
          const changed = data.filter(match);
          for (const r of changed) Object.assign(r, state.vals);
          resolve({ data: state.returning ? changed : null, error: null });
        } else if (state.mode === "delete") {
          const changed = data.filter(match);
          for (let i = data.length - 1; i >= 0; i--) if (match(data[i])) data.splice(i, 1);
          resolve({ data: state.returning ? changed : null, error: null });
        } else {
          const rows = data.filter(match);
          if (state.order.length > 0) {
            rows.sort((x, y) => {
              for (const [k, asc] of state.order) {
                const a = x[k] as string | number | null;
                const c = y[k] as string | number | null;
                if (a === c) continue;
                if (a == null) return asc ? -1 : 1;
                if (c == null) return asc ? 1 : -1;
                return (a < c ? -1 : 1) * (asc ? 1 : -1);
              }
              return 0;
            });
          }
          resolve({ data: rows, error: null });
        }
      },
    };
    return b;
  }
  return { from: (table: string) => builder(table), rpc: (name: string, args: Row) => rpc(name, args) };
}
const rpcLog: Array<{ name: string; args: Row }> = [];
const tableSelects: string[] = [];
let rpcGate: Promise<void> | null = null;
async function rpc(name: string, args: Row) {
  rpcLog.push({ name, args });
  if (rpcGate) await rpcGate;
  const { mergeEditPatch } = await import("../website-edits");
  const idx = store.findIndex(
    (r) => r.tenant_id === args.p_tenant_id && r.app_id === args.p_app_id && r.selector === args.p_selector,
  );
  const prior = idx >= 0 ? store[idx] : null;
  const patch = args.p_remove
    ? {}
    : args.p_replace || !prior || prior.removed
      ? (args.p_patch as Row)
      : mergeEditPatch(prior.patch as never, args.p_patch as never);
  const before = prior ? { patch: prior.patch, removed: prior.removed } : null;
  if (prior) Object.assign(prior, { patch, removed: !!args.p_remove });
  else
    store.push(
      row({ selector: String(args.p_selector), tenant_id: args.p_tenant_id, app_id: args.p_app_id, patch, removed: !!args.p_remove }),
    );
  const current = store.find(
    (r) => r.tenant_id === args.p_tenant_id && r.app_id === args.p_app_id && r.selector === args.p_selector,
  )!;
  return {
    data: {
      existed: !!before,
      patch: before?.patch ?? null,
      removed: before?.removed ?? false,
      id: current.id,
      updated_at: current.updated_at,
      current_patch: current.patch,
    },
    error: null,
  };
}
vi.mock("@/services/supabase", () => ({ serviceClient: () => makeClient() }));

import {
  setWebsiteEditHandler,
  publishWebsiteEditsHandler,
  unpublishWebsiteEditsHandler,
  websitePublishStatusHandler,
  websitePendingChangesHandler,
  discardWebsiteEditsHandler,
  describePendingChange,
  getPublishedWebsiteEditsHandler,
  mergeEditPatch,
  sanitizePatch,
} from "../website-edits";

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  return res;
}

function row(over: Partial<Row> & { selector: string }): Row {
  return {
    id: `id-${over.selector}`,
    updated_at: "2026-10-08T10:00:00.000Z",
    tenant_id: "tnt-1",
    app_id: "app.onrender.com",
    patch: {},
    removed: false,
    published_patch: null,
    published_removed: false,
    published_at: null,
    ...over,
  };
}

beforeEach(() => {
  mocks.requireAuth.mockReset();
  mocks.requireAuth.mockResolvedValue({ tenant_id: "tnt-1", user_id: "u-1", access_token: "tok" });
  mocks.getBoolSetting.mockReset();
  mocks.getBoolSetting.mockResolvedValue(false);
  mocks.getBoolSettingStrict.mockReset();
  mocks.getBoolSettingStrict.mockResolvedValue(false);
  store = [];
  resourceStore = [
    {
      tenant_id: "tnt-1",
      resource_kind: "hosting",
      status: "ready",
      external_ref: { url: "https://app.onrender.com" },
    },
  ];
  customDomainStore = [];
  rpcLog.length = 0;
  rpcGate = null;
  tableSelects.length = 0;
});

describe("publishWebsiteEditsHandler", () => {
  it("refuses Publish on the tenant's own old-flow host with the freeze reply, nothing published", async () => {
    store = [row({ selector: "#h1", patch: { text: "Hi" } })];
    const res = mockRes();
    await publishWebsiteEditsHandler({ body: { app_id: "app.onrender.com" } } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("old_site_frozen");
    expect(store[0].published_at).toBeNull();
  });

  it("400s without app_id", async () => {
    const res = mockRes();
    await publishWebsiteEditsHandler({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
});

describe("unpublishWebsiteEditsHandler", () => {
  it("refuses Unpublish: the frozen live site keeps its published overrides", async () => {
    store = [row({ selector: "#h1", patch: { text: "Hi" }, published_patch: { text: "Hi" }, published_at: "2026-07-17T00:00:00Z" })];
    const res = mockRes();
    await unpublishWebsiteEditsHandler({ body: { app_id: "app.onrender.com" } } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("old_site_frozen");
    expect(store[0].published_at).toBe("2026-07-17T00:00:00Z");
  });
});

describe("websitePublishStatusHandler", () => {
  it("counts pending (never-published or draft≠published) and published", async () => {
    store = [
      row({ selector: "#a", patch: { text: "A" } }),
      row({ selector: "#b", patch: { text: "B" }, published_patch: { text: "B" }, published_at: "2026-07-17T00:00:00Z" }),
      row({ selector: "#c", patch: { text: "C2" }, published_patch: { text: "C1" }, published_at: "2026-07-17T00:00:00Z" }),
    ];
    const res = mockRes();
    await websitePublishStatusHandler(
      { query: { app: "app.onrender.com" } } as never,
      res as never,
    );
    const b = res.body as { pending: number; published: number; last_published_at: string | null };
    expect(b.pending).toBe(2);
    expect(b.published).toBe(2);
    expect(b.last_published_at).toBe("2026-07-17T00:00:00Z");
  });
});

describe("describePendingChange", () => {
  it("labels text / style / link / image / removed / mixed and previews the value", () => {
    expect(describePendingChange(row({ selector: "#h1", patch: { text: "  Hello   world " } }) as never)).toMatchObject({
      kind: "text",
      summary: "Text edited",
      detail: "Hello world",
      status: "new",
    });
    expect(describePendingChange(row({ selector: "#p", patch: { style: { color: "#ff0000" } } }) as never)).toMatchObject({
      kind: "style",
      summary: "Text color changed",
      detail: "Text color: #ff0000",
    });
    expect(describePendingChange(row({ selector: "a", patch: { attrs: { href: "https://x.io" } } }) as never)).toMatchObject({
      kind: "link",
      summary: "Link updated",
      detail: "https://x.io",
    });
    expect(describePendingChange(row({ selector: "img", patch: { attrs: { src: "https://x.io/a.png" } } }) as never)).toMatchObject({
      kind: "image",
      summary: "Image replaced",
    });
    expect(describePendingChange(row({ selector: "#d", removed: true }) as never)).toMatchObject({
      kind: "removed",
      summary: "Element hidden",
    });
    expect(
      describePendingChange(row({ selector: "#m", patch: { text: "hi", style: { color: "#000" } } }) as never),
    ).toMatchObject({ kind: "mixed", summary: "Multiple edits" });
  });

  it("marks a previously-published-but-diverged row as 'updated'", () => {
    const r = row({
      selector: "#h1",
      patch: { text: "New" },
      published_patch: { text: "Old" },
      published_at: "2026-07-17T00:00:00Z",
    });
    expect(describePendingChange(r as never).status).toBe("updated");
  });
});

describe("websitePendingChangesHandler", () => {
  it("returns only pending rows, described", async () => {
    store = [
      row({ selector: "#a", patch: { text: "A" } }),
      row({ selector: "#b", patch: { text: "B" }, published_patch: { text: "B" }, published_at: "2026-07-17T00:00:00Z" }),
      row({ selector: "#c", patch: { style: { color: "#f00" } } }),
    ];
    const res = mockRes();
    await websitePendingChangesHandler({ query: { app: "app.onrender.com" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const items = (res.body as { items: Array<{ id: string; selector: string; updated_at: string }> }).items;
    expect(items.map((i) => i.selector).sort()).toEqual(["#a", "#c"]);
    expect(items.find((item) => item.selector === "#a")).toMatchObject({
      id: "id-#a",
      updated_at: "2026-10-08T10:00:00.000Z",
    });
  });

  it("403s a host the tenant does not own", async () => {
    const res = mockRes();
    await websitePendingChangesHandler({ query: { app: "victim.onrender.com" } } as never, res as never);
    expect(res.statusCode).toBe(403);
  });
});

describe("discardWebsiteEditsHandler", () => {
  it("discards ONE change by selector: deletes a never-published row", async () => {
    store = [
      row({ selector: "#a", patch: { text: "A" } }),
      row({ selector: "#b", patch: { text: "B" } }),
    ];
    const current = store[0];
    const res = mockRes();
    await discardWebsiteEditsHandler(
      { body: { app_id: "app.onrender.com", selector: "#a", expected: { id: current.id, updated_at: current.updated_at } } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { discarded: number }).discarded).toBe(1);
    expect(store.map((r) => r.selector)).toEqual(["#b"]);
  });

  it("a text-only discard keeps the element's saved style and drops only the text", async () => {
    store = [
      row({ selector: "#h", patch: { text: "Summer", style: { color: "#ff0000" }, before: { text: "Class" } } }),
      row({ selector: "#t", patch: { text: "Only text", before: { text: "Old" } } }),
      row({ selector: "#s", patch: { segments: ["Summer", null], style: { fontWeight: "700" }, before: { segments: ["Class", null] } } }),
      row({
        selector: "#p",
        patch: { text: "P2", style: { color: "#00ff00" } },
        published_patch: { text: "P1" },
        published_removed: false,
        published_at: "2026-07-17T00:00:00Z",
      }),
      row({
        selector: "#q",
        patch: { segments: ["P2", null], style: { color: "#0000ff" } },
        published_patch: { segments: ["P1", null] },
        published_removed: false,
        published_at: "2026-07-17T00:00:00Z",
      }),
    ];
    for (const selector of ["#h", "#t", "#s", "#p", "#q"]) {
      const res = mockRes();
      const current = store.find((edit) => edit.selector === selector)!;
      await discardWebsiteEditsHandler({
        body: { app_id: "app.onrender.com", selector, only: "text", expected: { id: current.id, updated_at: current.updated_at } },
      } as never, res as never);
      expect(res.statusCode).toBe(200);
    }
    expect(store.map((r) => r.selector)).toEqual(["#h", "#s", "#p", "#q"]);
    expect(store[0].patch).toEqual({ style: { color: "#ff0000" }, before: { text: "Class" } });
    expect(store[1].patch).toEqual({ style: { fontWeight: "700" }, before: { segments: ["Class", null] } });
    expect(store[2].patch).toEqual({ text: "P1", style: { color: "#00ff00" } });
    expect(store[2].published_patch).toEqual({ text: "P1" });
    expect(store[3].patch).toEqual({ segments: ["P1", null], style: { color: "#0000ff" } });
  });

  it("resets a published-then-edited row back to its live snapshot (live untouched)", async () => {
    store = [
      row({
        selector: "#c",
        patch: { text: "C2" },
        published_patch: { text: "C1" },
        published_removed: false,
        published_at: "2026-07-17T00:00:00Z",
      }),
    ];
    const current = store[0];
    const res = mockRes();
    await discardWebsiteEditsHandler(
      { body: { app_id: "app.onrender.com", selector: "#c", expected: { id: current.id, updated_at: current.updated_at } } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(store).toHaveLength(1);
    expect(store[0].patch).toEqual({ text: "C1" });
    expect(store[0].published_at).toBe("2026-07-17T00:00:00Z");
  });

  it("discards ALL pending when no selector is given, leaving up-to-date rows alone", async () => {
    store = [
      row({ selector: "#a", patch: { text: "A" } }),
      row({ selector: "#b", patch: { text: "B" }, published_patch: { text: "B" }, published_at: "2026-07-17T00:00:00Z" }),
      row({ selector: "#c", patch: { text: "C2" }, published_patch: { text: "C1" }, published_at: "2026-07-17T00:00:00Z" }),
    ];
    const res = mockRes();
    await discardWebsiteEditsHandler({ body: { app_id: "app.onrender.com" } } as never, res as never);
    expect((res.body as { discarded: number }).discarded).toBe(2);
    expect(store.map((r) => r.selector).sort()).toEqual(["#b", "#c"]);
    expect(store.find((r) => r.selector === "#c")!.patch).toEqual({ text: "C1" });
  });

  it("403s a host the tenant does not own (no rows touched)", async () => {
    store = [row({ selector: "#a", app_id: "victim.onrender.com", patch: { text: "A" } })];
    const res = mockRes();
    await discardWebsiteEditsHandler(
      { body: { app_id: "victim.onrender.com" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(403);
    expect(store).toHaveLength(1);
  });
});

describe("app ownership gate (cross-tenant defacement guard)", () => {
  it("403s a write to a host the tenant does NOT own", async () => {
    const res = mockRes();
    await setWebsiteEditHandler(
      { body: { app_id: "victim-app.onrender.com", selector: "#h1", patch: { text: "HACKED" } } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe("not_your_app");
    expect(store).toHaveLength(0);
  });

  it("403s a publish to a host the tenant does NOT own", async () => {
    store = [row({ selector: "#h1", tenant_id: "tnt-1", app_id: "victim-app.onrender.com" })];
    const res = mockRes();
    await publishWebsiteEditsHandler(
      { body: { app_id: "victim-app.onrender.com" } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(403);
    expect(store[0].published_at).toBeNull();
  });

  it("refuses a write to the tenant's OWN old-flow host with the freeze reply, nothing written", async () => {
    const res = mockRes();
    await setWebsiteEditHandler(
      { body: { app_id: "app.onrender.com", selector: "#h1", patch: { text: "Hi" } } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string; action: { kind: string } } }).error.action.kind).toBe("rebuild_old_site");
    expect(store).toHaveLength(0);
    expect(rpcLog).toHaveLength(0);
  });
});

describe("getPublishedWebsiteEditsHandler (PUBLIC)", () => {
  it("returns ONLY published rows, projected to public copy, with permissive CORS", async () => {
    store = [
      row({ selector: "#live", published_patch: { text: "Live" }, published_removed: false, published_at: "2026-07-17T00:00:00Z" }),
      row({ selector: "#draft", patch: { text: "Draft" } }),
    ];
    const res = mockRes();
    await getPublishedWebsiteEditsHandler(
      { query: { app: "app.onrender.com" } } as never,
      res as never,
    );
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Cache-Control"]).toContain("max-age");
    const edits = (res.body as { edits: Array<{ selector: string; patch: unknown; removed: boolean }> }).edits;
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ selector: "#live", patch: { text: "Live" }, removed: false });
  });

  it("400s without app", async () => {
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it("does NOT serve a foreign/stale row published under a host it doesn't own", async () => {
    store = [
      row({ selector: "#live", tenant_id: "tnt-1", published_patch: { text: "Mine" }, published_at: "2026-07-17T00:00:00Z" }),
      row({ selector: "#evil", tenant_id: "tnt-2", id: "evil", published_patch: { text: "HACKED" }, published_at: "2026-07-17T00:00:00Z" }),
    ];
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, res as never);
    const edits = (res.body as { edits: Array<{ selector: string }> }).edits;
    expect(edits).toHaveLength(1);
    expect(edits[0].selector).toBe("#live");
  });

  it("serves nothing for an unknown host (no owner resolves)", async () => {
    store = [row({ selector: "#x", tenant_id: "tnt-9", app_id: "stranger.onrender.com", published_at: "2026-07-17T00:00:00Z" })];
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "stranger.onrender.com" } } as never, res as never);
    expect((res.body as { edits: unknown[] }).edits).toHaveLength(0);
  });

  const badgeOf = (res: ReturnType<typeof mockRes>) =>
    (res.body as { badge_hidden?: boolean }).badge_hidden;

  it("global gate OFF → badge_hidden:true, but real published edits STILL returned", async () => {
    store = [row({ selector: "#live", published_patch: { text: "Live" }, published_at: "2026-07-17T00:00:00Z" })];
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, res as never);
    expect(badgeOf(res)).toBe(true);
    expect((res.body as { edits: unknown[] }).edits).toHaveLength(1);
    expect(mocks.getBoolSettingStrict).not.toHaveBeenCalled();
  });

  it("gate ON + tenant flag unset → badge_hidden:false (shown)", async () => {
    mocks.getBoolSetting.mockResolvedValue(true);
    mocks.getBoolSettingStrict.mockResolvedValue(false);
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, res as never);
    expect(badgeOf(res)).toBe(false);
    expect(mocks.getBoolSettingStrict).toHaveBeenCalledWith("website_platform_badge_hidden", "tnt-1");
  });

  it("gate ON + tenant hid it → badge_hidden:true", async () => {
    mocks.getBoolSetting.mockResolvedValue(true);
    mocks.getBoolSettingStrict.mockResolvedValue(true);
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, res as never);
    expect(badgeOf(res)).toBe(true);
  });

  it("gate ON + per-tenant flag read ERRORS → badge_hidden:true (fail-closed), edits still returned", async () => {
    mocks.getBoolSetting.mockResolvedValue(true);
    mocks.getBoolSettingStrict.mockRejectedValue(new Error("settings store down"));
    store = [row({ selector: "#live", published_patch: { text: "Live" }, published_at: "2026-07-17T00:00:00Z" })];
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, res as never);
    expect(badgeOf(res)).toBe(true);
    expect((res.body as { edits: unknown[] }).edits).toHaveLength(1);
  });

  it("gate ON + zero published edits → still returns badge config (badge_hidden:false)", async () => {
    mocks.getBoolSetting.mockResolvedValue(true);
    mocks.getBoolSettingStrict.mockResolvedValue(false);
    store = [];
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, res as never);
    expect((res.body as { edits: unknown[] }).edits).toHaveLength(0);
    expect(badgeOf(res)).toBe(false);
  });

  it("shown badge + site_badge_reserves_space on → badge_reserve:true, read for the owning tenant", async () => {
    mocks.getBoolSetting.mockImplementation(async (key: string) => key === "platform_badge_global_enabled" || key === "site_badge_reserves_space");
    mocks.getBoolSettingStrict.mockResolvedValue(false);
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, res as never);
    expect(badgeOf(res)).toBe(false);
    expect((res.body as { badge_reserve?: boolean }).badge_reserve).toBe(true);
    expect(mocks.getBoolSetting).toHaveBeenCalledWith("site_badge_reserves_space", "tnt-1");
  });

  it("shown badge + site_badge_reserves_space off → no badge_reserve field (the runtime keeps the old badge)", async () => {
    mocks.getBoolSetting.mockImplementation(async (key: string) => key === "platform_badge_global_enabled");
    mocks.getBoolSettingStrict.mockResolvedValue(false);
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, res as never);
    expect(badgeOf(res)).toBe(false);
    expect(res.body).not.toHaveProperty("badge_reserve");
  });

  it("hidden badge never reserves space and never reads the key; a failing key read keeps the badge without reserve", async () => {
    mocks.getBoolSetting.mockImplementation(async () => true);
    mocks.getBoolSettingStrict.mockResolvedValue(true);
    const hidden = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, hidden as never);
    expect(badgeOf(hidden)).toBe(true);
    expect(hidden.body).not.toHaveProperty("badge_reserve");
    expect(mocks.getBoolSetting).not.toHaveBeenCalledWith("site_badge_reserves_space", expect.anything());

    mocks.getBoolSetting.mockImplementation(async (key: string) => {
      if (key === "site_badge_reserves_space") throw new Error("settings down");
      return true;
    });
    mocks.getBoolSettingStrict.mockResolvedValue(false);
    const failed = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, failed as never);
    expect(failed.statusCode ?? 200).toBe(200);
    expect(badgeOf(failed)).toBe(false);
    expect(failed.body).not.toHaveProperty("badge_reserve");
  });

  it("unknown host → {edits:[]} with an EXPLICIT badge_hidden:true (no reliance on an absent key)", async () => {
    mocks.getBoolSetting.mockResolvedValue(true);
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "stranger.onrender.com" } } as never, res as never);
    expect((res.body as { edits: unknown[] }).edits).toHaveLength(0);
    expect(badgeOf(res)).toBe(true);
    expect(mocks.getBoolSettingStrict).not.toHaveBeenCalled();
  });
});

describe("getPublishedWebsiteEditsHandler — every host the app answers on", () => {
  const badgeOf = (res: ReturnType<typeof mockRes>) =>
    (res.body as { badge_hidden?: boolean }).badge_hidden;
  const builtinDomainRow = {
    tenant_id: "tnt-1",
    resource_kind: "domain",
    status: "ready",
    external_ref: { hostname: "app.zaviagent.com" },
  };

  it("resolves the owner from the built-in subdomain, not just the hosting URL", async () => {
    resourceStore.push(builtinDomainRow);
    mocks.getBoolSetting.mockResolvedValue(true);
    mocks.getBoolSettingStrict.mockResolvedValue(false);
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.zaviagent.com" } } as never, res as never);
    expect(badgeOf(res)).toBe(false);
  });

  it("serves edits keyed under the HOSTING host to a visitor on the built-in host", async () => {
    resourceStore.push(builtinDomainRow);
    store = [
      row({ selector: "#h1", published_patch: { text: "Live" }, published_at: "2026-07-17T00:00:00Z" }),
    ];
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.zaviagent.com" } } as never, res as never);
    expect((res.body as { edits: Array<{ selector: string }> }).edits).toHaveLength(1);
    expect((res.body as { edits: Array<{ selector: string }> }).edits[0].selector).toBe("#h1");
  });

  it("serves the NEWEST publish when a selector exists under two hosts", async () => {
    resourceStore.push(builtinDomainRow);
    store = [
      row({
        selector: "#h1",
        app_id: "app.onrender.com",
        published_patch: { text: "old" },
        published_at: "2026-07-17T00:00:00Z",
      }),
      row({
        selector: "#h1",
        app_id: "app.zaviagent.com",
        published_patch: { text: "new" },
        published_at: "2026-07-23T00:00:00Z",
      }),
    ];
    for (const host of ["app.onrender.com", "app.zaviagent.com"]) {
      const res = mockRes();
      await getPublishedWebsiteEditsHandler({ query: { app: host } } as never, res as never);
      const edits = (res.body as { edits: Array<{ patch: { text: string } }> }).edits;
      expect(edits).toHaveLength(1);
      expect(edits[0].patch.text).toBe("new");
    }
  });

  it("is stable when two hosts publish the same selector in the same tick", async () => {
    resourceStore.push(builtinDomainRow);
    const at = "2026-07-23T00:00:00Z";
    store = [
      row({ selector: "#h1", app_id: "app.zaviagent.com", published_patch: { text: "z" }, published_at: at }),
      row({ selector: "#h1", app_id: "app.onrender.com", published_patch: { text: "o" }, published_at: at }),
    ];
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      await getPublishedWebsiteEditsHandler({ query: { app: "app.onrender.com" } } as never, res as never);
      seen.add((res.body as { edits: Array<{ patch: { text: string } }> }).edits[0].patch.text);
    }
    expect(seen.size).toBe(1);
  });

  it("resolves a verified custom domain too", async () => {
    customDomainStore = [{ tenant_id: "tnt-1", hostname: "shop.acme.com", status: "verified" }];
    mocks.getBoolSetting.mockResolvedValue(true);
    mocks.getBoolSettingStrict.mockResolvedValue(false);
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "shop.acme.com" } } as never, res as never);
    expect(badgeOf(res)).toBe(false);
  });

  it("ignores a custom domain that is not verified, and a failed/torn-down subdomain", async () => {
    customDomainStore = [{ tenant_id: "tnt-1", hostname: "pending.acme.com", status: "verifying" }];
    resourceStore.push({
      tenant_id: "tnt-1",
      resource_kind: "domain",
      status: "failed",
      external_ref: { hostname: "dead.zaviagent.com" },
    });
    mocks.getBoolSetting.mockResolvedValue(true);
    for (const host of ["pending.acme.com", "dead.zaviagent.com"]) {
      const res = mockRes();
      await getPublishedWebsiteEditsHandler({ query: { app: host } } as never, res as never);
      expect((res.body as { edits: unknown[] }).edits).toHaveLength(0);
      expect(badgeOf(res)).toBe(true);
    }
  });

  it("stays fail-closed when two tenants claim the same host", async () => {
    resourceStore.push(builtinDomainRow, { ...builtinDomainRow, tenant_id: "tnt-2" });
    mocks.getBoolSetting.mockResolvedValue(true);
    const res = mockRes();
    await getPublishedWebsiteEditsHandler({ query: { app: "app.zaviagent.com" } } as never, res as never);
    expect(badgeOf(res)).toBe(true);
    expect(mocks.getBoolSettingStrict).not.toHaveBeenCalled();
  });
});

describe("Discard's restore is an inline write on the frozen old-flow app", () => {
  it("is refused with the freeze reply and writes nothing", async () => {
    store = [row({ selector: "#h1", patch: { style: { fontWeight: "bold" }, text: "Chat words" } })];
    const res = mockRes();
    await discardWebsiteEditsHandler(
      { body: { app_id: "app.onrender.com", selector: "#h1", restore: { patch: { style: { fontWeight: "bold" } }, removed: false } } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("old_site_frozen");
    expect(store[0].patch).toEqual({ style: { fontWeight: "bold" }, text: "Chat words" });
    expect(rpcLog).toHaveLength(0);
  });

  it("a restore on another tenant's host is still 403, before any write", async () => {
    const res = mockRes();
    await discardWebsiteEditsHandler(
      { body: { app_id: "victim.onrender.com", selector: "#h1", restore: { patch: { text: "x" }, removed: false } } } as never,
      res as never,
    );
    expect(res.statusCode).toBe(403);
    expect(rpcLog).toHaveLength(0);
  });
});

describe("stored runs are validated", () => {
  it("keeps runs that are strings or null, with at least one real run", () => {
    expect(sanitizePatch({ segments: ["A", null, "C"] }).segments).toEqual(["A", null, "C"]);
  });

  it("drops runs that are all null, blank, over the per-run cap, too many, or not strings", () => {
    expect(sanitizePatch({ segments: [null, null] })).toEqual({});
    expect(sanitizePatch({ segments: ["A", "   "] })).toEqual({});
    expect(sanitizePatch({ segments: ["A", "x".repeat(5001)] })).toEqual({});
    expect(sanitizePatch({ segments: Array(41).fill("x") })).toEqual({});
    expect(sanitizePatch({ segments: ["A", 7] })).toEqual({});
    expect(sanitizePatch({ segments: "A" })).toEqual({});
    expect(sanitizePatch({ segments: [] })).toEqual({});
  });

});

describe("merge semantics (mirrors website_edit_merge_patch)", () => {
  it("style and attrs add key by key, newer keys win", () => {
    expect(
      mergeEditPatch(
        { style: { color: "#111111", fontWeight: "bold" }, attrs: { href: "/a" } },
        { style: { color: "#222222" }, attrs: { src: "https://x.test/i.png" } },
      ),
    ).toEqual({
      style: { color: "#222222", fontWeight: "bold" },
      attrs: { href: "/a", src: "https://x.test/i.png" },
    });
  });

  it("text and runs replace each other", () => {
    expect(mergeEditPatch({ text: "Old", style: { color: "#111111" } }, { segments: ["A", "B"] })).toEqual({
      style: { color: "#111111" },
      segments: ["A", "B"],
    });
    expect(mergeEditPatch({ segments: ["A", "B"] }, { text: "Flat" })).toEqual({ text: "Flat" });
  });

  it("a sparse rewrite keeps the earlier run where it says null, and a different run count replaces outright", () => {
    expect(mergeEditPatch({ segments: ["A1", null, "C1"] }, { segments: [null, null, "C2"] })).toEqual({
      segments: ["A1", null, "C2"],
    });
    expect(mergeEditPatch({ segments: ["A1", "B1"] }, { segments: [null, "B2", "C2"] })).toEqual({
      segments: [null, "B2", "C2"],
    });
  });
});
