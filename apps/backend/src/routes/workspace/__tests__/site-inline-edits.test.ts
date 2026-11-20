import { beforeEach, describe, expect, it, vi } from "vitest";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER_T = "22222222-2222-4222-8222-222222222222";
const SITE = "aaaaaaaa-0000-4000-8000-000000000001";
const FOREIGN_SITE = "bbbbbbbb-0000-4000-8000-000000000002";
const ROOT = "cccccccc-0000-4000-8000-000000000003";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  edits: [] as Array<Record<string, unknown>>,
  resources: [] as Array<Record<string, unknown>>,
  sites: [] as Array<Record<string, unknown>>,
  role: "owner" as string,
  builderOn: true,
  clock: 0,
  failDeleteIds: new Set<string>(),
  beforeMutation: null as null | (() => void),
  resolveInlineEdit: null as null | ((...a: unknown[]) => unknown),
  resolveChatEditFromOutline: null as null | ((...a: unknown[]) => unknown),
  quotaState: "ok" as string,
  quotaDown: false,
  quotaCalls: 0,
}));

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn(async () => ({ tenant_id: "11111111-1111-4111-8111-111111111111", user_id: "u1", access_token: "tok" })),
}));
vi.mock("@/services/auth/tenant-role", () => ({
  requireTenantRole: vi.fn(async (_auth: unknown, allowed: readonly string[], res: { status: (n: number) => { json: (b: unknown) => void } }) => {
    if (allowed.includes(state.role)) return true;
    res.status(403).json({ error: { code: "forbidden" } });
    return false;
  }),
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({ isProductBuilderEnabled: async () => state.builderOn }));
vi.mock("@/services/agents/company-fact-sheet", () => ({ buildCompanyFactSheet: async () => undefined }));
vi.mock("@/services/settings", () => ({
  getBoolSetting: async () => false,
  getBoolSettingStrict: async () => false,
}));
vi.mock("@/services/website-edits/resolve-inline-edit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/website-edits/resolve-inline-edit")>()),
  resolveInlineEdit: (...a: unknown[]) => state.resolveInlineEdit!(...a),
  resolveChatEditFromOutline: (...a: unknown[]) => state.resolveChatEditFromOutline!(...a),
}));
vi.mock("@/services/sites/store", () => ({
  siteStore: () => ({
    get: async (tid: string, id: string) => state.sites.find((s) => s.tenant_id === tid && s.id === id) ?? null,
    listForTenant: async (tid: string) => state.sites.filter((s) => s.tenant_id === tid),
  }),
}));
vi.mock("@/services/tenant-client", () => {
  function table(tid: string, name: string) {
    const rows = (): Array<Record<string, unknown>> => (name === "website_edits" ? state.edits : name === "tenant_resources" ? state.resources : []);
    const f: Array<(r: Record<string, unknown>) => boolean> = [(r) => r.tenant_id === tid];
    let mode: "select" | "delete" | "update" = "select";
    let vals: Record<string, unknown> = {};
    let order: [string, boolean] | null = null;
    const q: Record<string, unknown> = {
      select: () => q,
      delete: () => {
        mode = "delete";
        return q;
      },
      update: (v: Record<string, unknown>) => {
        mode = "update";
        vals = v;
        return q;
      },
      eq: (k: string, v: unknown) => {
        f.push((r) => r[k] === v);
        return q;
      },
      lt: (k: string, v: string) => {
        f.push((r) => typeof r[k] === "string" && (r[k] as string) < v);
        return q;
      },
      not: (k: string, op: string, v: unknown) => {
        if (op === "like") {
          const prefix = String(v).replace(/%$/, "");
          f.push((r) => !String(r[k]).startsWith(prefix));
        } else f.push((r) => r[k] != null);
        return q;
      },
      in: (k: string, vs: unknown[]) => {
        f.push((r) => vs.includes(r[k]));
        return q;
      },
      is: () => q,
      order: (k: string, o?: { ascending?: boolean }) => {
        order = [k, o?.ascending !== false];
        return q;
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => {
        const all = rows();
        if (mode !== "select" && state.beforeMutation) {
          const beforeMutation = state.beforeMutation;
          state.beforeMutation = null;
          beforeMutation();
        }
        const hit = all.filter((r) => f.every((p) => p(r)));
        if (mode === "delete") {
          if (hit.some((r) => state.failDeleteIds.has(String(r.id)))) return resolve({ data: null, error: { message: "delete failed" } });
          for (const r of hit) all.splice(all.indexOf(r), 1);
          return resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
        }
        if (mode === "update") {
          for (const r of hit) Object.assign(r, vals);
          return resolve({ data: hit.map((r) => ({ id: r.id })), error: null });
        }
        if (order) {
          const [k, asc] = order;
          hit.sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0) * (asc ? 1 : -1));
        }
        return resolve({ data: hit.map((r) => structuredClone(r)), error: null });
      },
    };
    return q;
  }
  return {
    asTenantId: (t: string) => t,
    tenantClient: (tid: string) => ({ from: (name: string) => table(tid, name) }),
    publicHostClient: () => ({ from: (name: string) => table("__none__", name) }),
    tenantRpc: async (tid: string, name: string, args: Record<string, unknown>) => {
      if (name === "take_inline_edit_call") {
        state.quotaCalls += 1;
        if (state.quotaDown) return { data: null, error: { message: "db down" } };
        return { data: state.quotaState, error: null };
      }
      if (name !== "merge_website_edit") throw new Error(`unexpected rpc ${name}`);
      const { mergeEditPatch } = await import("../website-edits");
      const prior = state.edits.find((r) => r.tenant_id === tid && r.app_id === args.p_app_id && r.selector === args.p_selector);
      const priorShape = prior ? { patch: prior.patch, removed: prior.removed } : null;
      const patch = args.p_remove
        ? {}
        : args.p_replace || !prior || prior.removed
          ? (args.p_patch as Record<string, unknown>)
          : mergeEditPatch(prior.patch as never, args.p_patch as never);
      state.clock += 1;
      const updated_at = new Date(Date.UTC(2026, 9, 2, 10, 0, state.clock)).toISOString();
      let current = prior;
      if (prior) Object.assign(prior, { patch, removed: !!args.p_remove, updated_at });
      else {
        current = {
          id: `e${state.edits.length + 1}-${String(args.p_selector)}`,
          tenant_id: tid,
          app_id: args.p_app_id,
          selector: args.p_selector,
          patch,
          removed: !!args.p_remove,
          published_patch: null,
          published_removed: false,
          published_at: null,
          updated_at,
        };
        state.edits.push(current);
      }
      return {
        data: {
          existed: !!priorShape,
          patch: priorShape?.patch ?? null,
          removed: priorShape?.removed ?? false,
          id: current!.id,
          updated_at: current!.updated_at,
          current_patch: current!.patch,
        },
        error: null,
      };
    },
  };
});

import {
  clearWebsiteEditsForTenant,
  discardWebsiteEditsHandler,
  getWebsiteEditsHandler,
  publishWebsiteEditsHandler,
  refuseInlineEdit,
  setWebsiteEditHandler,
  unpublishWebsiteEditsHandler,
  websitePendingChangesHandler,
  websitePublishStatusHandler,
} from "../website-edits";
import { resolveChatWebsiteEditHandler, resolveWebsiteEditHandler } from "../resolve-website-edit";
import { appliedEditsLabel, handleApplySiteEdits, type ApplySiteEditsDeps } from "../site-inline-edits";
import { clearAppliedSiteEdits, loadSiteEditRows, siteEditsAppId, siteEditsRefineMessage } from "@/services/sites/site-inline-edits";
import { asTenantId } from "@/services/tenant-client";
import { DoubleBuildInFlight } from "@/services/agents/start-product-build";
import { FreeEditsUsed, SitePreviewRestarting } from "@/services/agents/refine-product";

const APP = siteEditsAppId(SITE);
const FOREIGN_APP = siteEditsAppId(FOREIGN_SITE);
const OLD_HOST = "old-app.onrender.com";
const KEY = { "idempotency-key": "11111111-aaaa-4bbb-8ccc-000000000001" };

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
  };
  return res;
}

type Res = ReturnType<typeof mockRes>;
const code = (r: Res) => (r.body as { error?: { code?: string } }).error?.code;

async function call(handler: (req: never, res: never) => Promise<void>, req: Row): Promise<Res> {
  const res = mockRes();
  await handler(req as never, res as never);
  return res;
}

function edit(over: Row): Row {
  state.clock += 1;
  return {
    id: `seed-${state.clock}`,
    tenant_id: T,
    app_id: APP,
    selector: "h1",
    patch: {},
    removed: false,
    published_patch: null,
    published_removed: false,
    published_at: null,
    updated_at: new Date(Date.UTC(2026, 9, 2, 9, 0, state.clock)).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  state.edits = [];
  state.resources = [{ tenant_id: T, resource_kind: "hosting", status: "ready", external_ref: { url: `https://${OLD_HOST}` } }];
  state.sites = [
    { id: SITE, tenant_id: T, status: "live", root_conductor_run_id: ROOT, hostname: "lucky.zavi.site", live_url: null },
    { id: FOREIGN_SITE, tenant_id: OTHER_T, status: "live", root_conductor_run_id: ROOT, hostname: "other.zavi.site", live_url: null },
  ];
  state.role = "owner";
  state.builderOn = true;
  state.clock = 0;
  state.failDeleteIds = new Set();
  state.beforeMutation = null;
  state.resolveInlineEdit = null;
  state.resolveChatEditFromOutline = null;
  state.quotaState = "ok";
  state.quotaDown = false;
  state.quotaCalls = 0;
});

describe("inline edits keyed by site:<id>", () => {
  it("saves a draft for the caller's own site, keeping the element's original state as before", async () => {
    const r = await call(setWebsiteEditHandler, {
      body: {
        app_id: APP,
        selector: "h1.hero",
        patch: { text: "Fresh bread daily" },
        before: { text: "Welcome", style: { color: "rgb(0, 0, 0)", width: "10px" }, attrs: { href: "javascript:alert(1)" } },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(state.edits).toHaveLength(1);
    expect(state.edits[0]).toMatchObject({
      tenant_id: T,
      app_id: APP,
      selector: "h1.hero",
      patch: { text: "Fresh bread daily", before: { text: "Welcome", style: { color: "rgb(0, 0, 0)" } } },
    });
    expect(r.body).toMatchObject({
      ok: true,
      edit: { selector: "h1.hero", id: state.edits[0].id, updated_at: state.edits[0].updated_at, text_only: true },
    });
    expect((state.edits[0].patch as { before: Row }).before).not.toHaveProperty("attrs");
  });

  it("keeps the FIRST captured original when the same element is edited again", async () => {
    await call(setWebsiteEditHandler, { body: { app_id: APP, selector: "h1", patch: { text: "One" }, before: { text: "Original" } } });
    await call(setWebsiteEditHandler, { body: { app_id: APP, selector: "h1", patch: { text: "Two" }, before: { text: "One" } } });
    expect(state.edits).toHaveLength(1);
    expect(state.edits[0].patch).toEqual({ text: "Two", before: { text: "Original" } });
  });

  it("marks a text save as combined when the row already contains an unsent style edit", async () => {
    await call(setWebsiteEditHandler, { body: { app_id: APP, selector: "h1", patch: { style: { color: "red" } } } });
    const r = await call(setWebsiteEditHandler, { body: { app_id: APP, selector: "h1", patch: { text: "Two" }, before: { text: "One" } } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ edit: { selector: "h1", text_only: false } });
  });

  it("refuses another tenant's site on every read and write, touching nothing", async () => {
    state.edits = [edit({ tenant_id: OTHER_T, app_id: FOREIGN_APP, patch: { text: "theirs" } })];
    const snapshot = JSON.stringify(state.edits);
    const results = [
      await call(setWebsiteEditHandler, { body: { app_id: FOREIGN_APP, selector: "h1", patch: { text: "x" } } }),
      await call(getWebsiteEditsHandler, { query: { app: FOREIGN_APP } }),
      await call(websitePublishStatusHandler, { query: { app: FOREIGN_APP } }),
      await call(websitePendingChangesHandler, { query: { app: FOREIGN_APP } }),
      await call(discardWebsiteEditsHandler, { body: { app_id: FOREIGN_APP } }),
      await call(discardWebsiteEditsHandler, { body: { app_id: FOREIGN_APP, selector: "h1", restore: { patch: { text: "y" } } } }),
      await call(publishWebsiteEditsHandler, { body: { app_id: FOREIGN_APP } }),
    ];
    for (const r of results) {
      expect(r.statusCode).toBe(403);
      expect(code(r)).toBe("not_your_app");
    }
    expect(JSON.stringify(state.edits)).toBe(snapshot);
  });

  it("refuses a deleted site and every malformed site key", async () => {
    state.sites.push({ id: "dddddddd-0000-4000-8000-000000000004", tenant_id: T, status: "deleted", root_conductor_run_id: ROOT });
    const deleted = await call(setWebsiteEditHandler, {
      body: { app_id: siteEditsAppId("dddddddd-0000-4000-8000-000000000004"), selector: "h1", patch: { text: "x" } },
    });
    expect(deleted.statusCode).toBe(403);
    for (const bad of ["site:not-a-uuid", `SITE:${SITE}`, `site:${SITE.toUpperCase()}`, `site:${SITE} `]) {
      const r = await call(setWebsiteEditHandler, { body: { app_id: bad, selector: "h1", patch: { text: "x" } } });
      expect(r.statusCode).toBe(403);
    }
    expect(state.edits).toHaveLength(0);
  });

  it("reads only the caller's own drafts for its site", async () => {
    state.edits = [
      edit({ selector: "h1", patch: { text: "mine" } }),
      edit({ tenant_id: OTHER_T, selector: "h2", patch: { text: "same key, other tenant" } }),
    ];
    const r = await call(getWebsiteEditsHandler, { query: { app: APP } });
    expect(r.statusCode).toBe(200);
    expect((r.body as { edits: Row[] }).edits.map((e) => e.selector)).toEqual(["h1"]);
  });

  it("a site's drafts are never published as runtime overlays", async () => {
    state.edits = [edit({ patch: { text: "x" } })];
    for (const handler of [publishWebsiteEditsHandler, unpublishWebsiteEditsHandler]) {
      const r = await call(handler, { body: { app_id: APP } });
      expect(r.statusCode).toBe(409);
      expect(code(r)).toBe("site_edits_apply");
    }
    expect(state.edits[0].published_at).toBeNull();
  });

  it("restores an earlier draft on a site (the Ask AI revert)", async () => {
    state.edits = [edit({ selector: "h1", patch: { text: "AI words", before: { text: "Original" } } })];
    const expected = { id: state.edits[0].id, updated_at: state.edits[0].updated_at };
    const r = await call(discardWebsiteEditsHandler, {
      body: { app_id: APP, selector: "h1", restore: { patch: { text: "Mine", before: { text: "Original" } }, removed: false }, expected },
    });
    expect(r.statusCode).toBe(200);
    expect(state.edits[0].patch).toEqual({ text: "Mine", before: { text: "Original" } });
  });

  it("refuses to restore an earlier draft over a newer edit", async () => {
    state.edits = [edit({ selector: "h1", patch: { text: "AI words", before: { text: "Original" } } })];
    const expected = { id: state.edits[0].id, updated_at: state.edits[0].updated_at };
    state.beforeMutation = () => {
      state.edits[0].patch = { text: "Newer words", before: { text: "Original" } };
      state.edits[0].updated_at = "2026-10-08T12:00:00.000Z";
    };
    const r = await call(discardWebsiteEditsHandler, {
      body: { app_id: APP, selector: "h1", restore: { patch: { text: "Mine", before: { text: "Original" } }, removed: false }, expected },
    });
    expect(r.statusCode).toBe(409);
    expect(state.edits[0].patch).toEqual({ text: "Newer words", before: { text: "Original" } });
  });

  it("a text-only discard refuses to overwrite a newer row version", async () => {
    state.edits = [edit({
      selector: "h1",
      patch: { text: "Draft", style: { color: "red" }, before: { text: "Original" } },
    })];
    const expected = { id: state.edits[0].id, updated_at: state.edits[0].updated_at };
    state.beforeMutation = () => {
      state.edits[0].patch = { text: "Draft", style: { color: "blue" }, before: { text: "Original" } };
      state.edits[0].updated_at = "2026-10-08T12:00:00.000Z";
    };
    const r = await call(discardWebsiteEditsHandler, { body: { app_id: APP, selector: "h1", only: "text", expected } });
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe("edit_changed");
    expect(state.edits[0].patch).toEqual({ text: "Draft", style: { color: "blue" }, before: { text: "Original" } });
  });

  it("a text-only discard requires the row version the browser observed", async () => {
    state.edits = [edit({ selector: "h1", patch: { text: "Draft", before: { text: "Original" } } })];
    const r = await call(discardWebsiteEditsHandler, { body: { app_id: APP, selector: "h1", only: "text" } });
    expect(r.statusCode).toBe(400);
    expect(code(r)).toBe("missing_edit_version");
    expect(state.edits).toHaveLength(1);
  });

  it("a viewer cannot apply a site's drafts", async () => {
    state.role = "viewer";
    state.edits = [edit({ patch: { text: "x" } })];
    const refine = vi.fn();
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(403);
    expect(refine).not.toHaveBeenCalled();
  });

  it("a member applies a site's drafts like an owner (Ravi 2026-10-02, option C)", async () => {
    state.role = "member";
    state.edits = [edit({ patch: { text: "x" } })];
    const refine = vi.fn(async () => ({ conductor_run_id: "cr-apply" }));
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(200);
    expect(refine).toHaveBeenCalledTimes(1);
    expect(refine).toHaveBeenCalledWith(expect.objectContaining({ request: "Applied 1 edit" }));
    expect(appliedEditsLabel(2)).toBe("Applied 2 edits");
  });
});

describe("the old-flow app stays frozen", () => {
  it("refuses every inline write on the tenant's own old host with old_site_frozen", async () => {
    state.edits = [edit({ app_id: OLD_HOST, selector: "h1", patch: { text: "live" }, published_patch: { text: "live" }, published_at: "2026-07-01T00:00:00Z" })];
    const snapshot = JSON.stringify(state.edits);
    state.resolveInlineEdit = vi.fn(async () => ({ text: "AI" }));
    state.resolveChatEditFromOutline = vi.fn(async () => ({ selector: "h1", patch: { text: "AI" } }));
    const results = [
      await call(setWebsiteEditHandler, { body: { app_id: OLD_HOST, selector: "h1", patch: { text: "x" } } }),
      await call(publishWebsiteEditsHandler, { body: { app_id: OLD_HOST } }),
      await call(unpublishWebsiteEditsHandler, { body: { app_id: OLD_HOST } }),
      await call(discardWebsiteEditsHandler, { body: { app_id: OLD_HOST, selector: "h1", restore: { patch: { text: "y" } } } }),
      await call(resolveWebsiteEditHandler, { body: { app_id: OLD_HOST, selector: "h1", text: "live", message: "shorter" } }),
      await call(resolveChatWebsiteEditHandler, { body: { app_id: OLD_HOST, outline: [{ selector: "h1", tag: "h1", text: "live" }], message: "shorter" } }),
    ];
    for (const r of results) {
      expect(r.statusCode).toBe(409);
      expect(code(r)).toBe("old_site_frozen");
    }
    expect(state.resolveInlineEdit).not.toHaveBeenCalled();
    expect(state.resolveChatEditFromOutline).not.toHaveBeenCalled();
    expect(JSON.stringify(state.edits)).toBe(snapshot);
  });

  it("the apply route never takes an old host", async () => {
    const refine = vi.fn();
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine })), { body: { app_id: OLD_HOST } });
    expect(r.statusCode).toBe(400);
    expect(code(r)).toBe("not_a_site");
    expect(refine).not.toHaveBeenCalled();
  });

  it("clearing the old app's overrides never deletes a site's drafts", async () => {
    state.edits = [edit({ app_id: OLD_HOST, selector: "h1" }), edit({ app_id: APP, selector: "h2", patch: { text: "draft" } })];
    const out = await clearWebsiteEditsForTenant(T);
    expect(out.deleted).toBe(1);
    expect(state.edits.map((e) => e.app_id)).toEqual([APP]);
  });
});

describe("Ask AI on a site element", () => {
  it("stores the AI patch as a site draft with the element's state as before", async () => {
    state.resolveInlineEdit = vi.fn(async () => ({ text: "Bread baked at 5am", style: { color: "#b00" } }));
    const r = await call(resolveWebsiteEditHandler, {
      body: { app_id: APP, selector: "p.lead", tag: "p", text: "We bake bread", style: { color: "rgb(1, 2, 3)" }, message: "make it punchier" },
      headers: KEY,
    });
    expect(r.statusCode).toBe(200);
    expect(state.edits[0]).toMatchObject({
      app_id: APP,
      selector: "p.lead",
      patch: { text: "Bread baked at 5am", style: { color: "#b00" }, before: { text: "We bake bread", style: { color: "rgb(1, 2, 3)" } } },
    });
    expect(r.body).toMatchObject({
      version: { id: state.edits[0].id, updated_at: state.edits[0].updated_at },
    });
  });

  it("refuses a foreign site before calling the model", async () => {
    state.resolveInlineEdit = vi.fn(async () => ({ text: "x" }));
    const r = await call(resolveWebsiteEditHandler, { body: { app_id: FOREIGN_APP, selector: "p", text: "a", message: "shorter" } });
    expect(r.statusCode).toBe(403);
    expect(state.resolveInlineEdit).not.toHaveBeenCalled();
    expect(state.edits).toHaveLength(0);
  });

  it("chat edit on a site picks an outline element and records its text as before", async () => {
    state.resolveChatEditFromOutline = vi.fn(async () => ({ selector: "h2.title", patch: { text: "Our menu" } }));
    const r = await call(resolveChatWebsiteEditHandler, {
      body: { app_id: APP, outline: [{ selector: "h2.title", tag: "h2", text: "Menu" }], message: "rename the menu title" },
      headers: KEY,
    });
    expect(r.statusCode).toBe(200);
    expect(state.edits[0].patch).toEqual({ text: "Our menu", before: { text: "Menu" } });
    expect(r.body).toMatchObject({
      version: { id: state.edits[0].id, updated_at: state.edits[0].updated_at },
    });
  });
});

describe("Ask AI for more than this element (size-routed edits)", () => {
  it("offers a site change scoped to the element: no model call, no quota, no draft", async () => {
    state.resolveInlineEdit = vi.fn(async () => ({ text: "x" }));
    const r = await call(resolveWebsiteEditHandler, {
      headers: KEY,
      body: { app_id: APP, selector: "section.menu h2", tag: "h2", text: "Our cakes", message: "add a testimonials section below this" },
    });
    expect(r.statusCode).toBe(409);
    const err = (r.body as { error: { code: string; chat: string; request: string } }).error;
    expect(err.code).toBe("needs_site_change");
    expect(err.chat).toMatch(/change to the site itself/);
    expect(err.request).toBe('On the page I\'m looking at, at the element `section.menu h2` (it reads "Our cakes"): add a testimonials section below this');
    expect(state.resolveInlineEdit).not.toHaveBeenCalled();
    expect(state.quotaCalls).toBe(0);
    expect(state.edits).toHaveLength(0);
  });

  it("names the page the element is on when the preview sends it", async () => {
    const r = await call(resolveWebsiteEditHandler, {
      headers: KEY,
      body: { app_id: APP, selector: "footer p", tag: "p", text: "", message: "add a map next to this", path: "/visit" },
    });
    expect(r.statusCode).toBe(409);
    expect((r.body as { error: { request: string } }).error.request).toBe("On the page `/visit`, at the element `footer p`: add a map next to this");
  });

  it("still refuses a foreign site first", async () => {
    const r = await call(resolveWebsiteEditHandler, { headers: KEY, body: { app_id: FOREIGN_APP, selector: "p", text: "a", message: "add a new page for this" } });
    expect(r.statusCode).toBe(403);
  });
});

describe("Ask AI on a site: any member, tenant/site-scoped, once per action, under the site rate and the daily cap", () => {
  const ask = () =>
    call(resolveWebsiteEditHandler, { headers: KEY, body: { app_id: APP, selector: "p.lead", tag: "p", text: "We bake bread", message: "shorter" } });

  it("a member may use both AI routes and manual drafts, publish and discard (Ravi 2026-10-02); the caps still bound the spend", async () => {
    state.role = "member";
    state.resolveInlineEdit = vi.fn(async () => ({ text: "x" }));
    state.resolveChatEditFromOutline = vi.fn(async () => ({ selector: "h2", patch: { text: "y" } }));
    expect((await ask()).statusCode).toBe(200);
    const chat = await call(resolveChatWebsiteEditHandler, { headers: KEY, body: { app_id: APP, outline: [{ selector: "h2", tag: "h2", text: "a" }], message: "x" } });
    expect(chat.statusCode).toBe(200);
    expect(state.quotaCalls).toBe(2);
    const set = await call(setWebsiteEditHandler, { body: { app_id: APP, selector: "h1", patch: { text: "z" } } });
    expect(set.statusCode).toBe(200);
    const saved = (set.body as { edit: { id: string; updated_at: string } }).edit;
    const discard = await call(discardWebsiteEditsHandler, { body: { app_id: APP, selector: "h1", expected: saved } });
    expect(discard.statusCode).toBe(200);
    state.quotaState = "daily_cap";
    const capped = await ask();
    expect(capped.statusCode).toBe(429);
    expect(state.resolveInlineEdit).toHaveBeenCalledTimes(1);
  });

  it("a member can never reach another tenant's site: refused before the model, the counter or any write", async () => {
    state.role = "member";
    state.resolveInlineEdit = vi.fn(async () => ({ text: "x" }));
    state.resolveChatEditFromOutline = vi.fn(async () => ({ selector: "h2", patch: { text: "y" } }));
    const ai = await call(resolveWebsiteEditHandler, { headers: KEY, body: { app_id: FOREIGN_APP, selector: "p", text: "a", message: "shorter" } });
    const chat = await call(resolveChatWebsiteEditHandler, { headers: KEY, body: { app_id: FOREIGN_APP, outline: [{ selector: "h2", tag: "h2", text: "a" }], message: "x" } });
    const set = await call(setWebsiteEditHandler, { body: { app_id: FOREIGN_APP, selector: "h1", patch: { text: "z" } } });
    const discard = await call(discardWebsiteEditsHandler, { body: { app_id: FOREIGN_APP } });
    for (const r of [ai, chat, set, discard]) expect(r.statusCode).toBe(403);
    expect(state.resolveInlineEdit).not.toHaveBeenCalled();
    expect(state.resolveChatEditFromOutline).not.toHaveBeenCalled();
    expect(state.quotaCalls).toBe(0);
    expect(state.edits).toHaveLength(0);
  });

  it("needs an Idempotency-Key header (so the shared middleware can replay a retry instead of calling the model again)", async () => {
    state.resolveInlineEdit = vi.fn(async () => ({ text: "x" }));
    const r = await call(resolveWebsiteEditHandler, { body: { app_id: APP, selector: "p", text: "a", message: "shorter" } });
    expect(r.statusCode).toBe(400);
    expect(code(r)).toBe("missing_idempotency_key");
    expect(state.resolveInlineEdit).not.toHaveBeenCalled();
    expect(state.quotaCalls).toBe(0);
  });

  it("the per-site rate and the daily cap refuse with founder copy and never call the model; an unreadable counter fails closed", async () => {
    state.resolveInlineEdit = vi.fn(async () => ({ text: "x" }));
    state.quotaState = "site_rate_limited";
    const rate = await ask();
    expect(rate.statusCode).toBe(429);
    expect(code(rate)).toBe("rate_limited");
    state.quotaState = "daily_cap";
    const cap = await ask();
    expect(cap.statusCode).toBe(429);
    expect(code(cap)).toBe("daily_limit");
    state.quotaDown = true;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const down = await ask();
    expect(down.statusCode).toBe(503);
    expect(state.resolveInlineEdit).not.toHaveBeenCalled();
  });

  it("each call that reaches the model takes one count", async () => {
    state.resolveInlineEdit = vi.fn(async () => ({ text: "Bread at 5am" }));
    expect((await ask()).statusCode).toBe(200);
    expect(state.quotaCalls).toBe(1);
  });

  it("a model failure answers with fixed copy, never the internal error text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    state.resolveInlineEdit = vi.fn(async () => {
      throw new Error("anthropic 529 overloaded_error req_abc123");
    });
    const r = await ask();
    expect(r.statusCode).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain("anthropic");
    expect(JSON.stringify(r.body)).not.toContain("req_abc123");
  });
});

function deps(over: Partial<ApplySiteEditsDeps> = {}): ApplySiteEditsDeps {
  return {
    store: {
      get: async (tid: string, id: string) =>
        (state.sites.find((s) => s.tenant_id === tid && s.id === id) as never) ?? null,
    },
    loadRows: loadSiteEditRows,
    refine: vi.fn(async () => ({ conductor_run_id: "run-1" })),
    tick: vi.fn(async () => true),
    ...over,
  };
}

describe("applying a site's drafts as one small-edit refine", () => {
  function seedDrafts() {
    state.edits = [
      edit({ selector: "h1.hero", patch: { text: "Fresh bread daily", before: { text: "Welcome" } } }),
      edit({ selector: "a.cta", patch: { style: { color: "#ff0000" }, attrs: { href: "/order" }, before: { style: { color: "rgb(0, 0, 0)" }, attrs: { href: "/shop" } } } }),
      edit({ selector: "div.promo", removed: true, patch: {} }),
      edit({ tenant_id: OTHER_T, app_id: FOREIGN_APP, selector: "h1", patch: { text: "not mine" } }),
    ];
  }

  it("sends one refine on the site's root build listing every edit precisely, carrying those drafts and deleting none", async () => {
    seedDrafts();
    const refine = vi.fn(async (_input: Parameters<ApplySiteEditsDeps["refine"]>[0]) => ({ conductor_run_id: "run-1" }));
    const tick = vi.fn(async () => true);
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, tick })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ applied: 3, remaining: 0, applied_selectors: ["h1.hero", "a.cta", "div.promo"], conductor_run_id: "run-1" });
    expect(refine).toHaveBeenCalledTimes(1);
    const input = refine.mock.calls[0][0] as { tenant_id: string; conductor_run_id: string; small_edit: boolean; message: string };
    expect(input.tenant_id).toBe(T);
    expect(input.conductor_run_id).toBe(ROOT);
    expect(input.small_edit).toBe(true);
    const lines = input.message.split("\n");
    expect(lines[0]).toMatch(/^Apply these exact edits the founder made/);
    expect(lines.slice(1)).toEqual([
      '1. `h1.hero`: change its text from "Welcome" to "Fresh bread daily".',
      '2. `a.cta`: set its text color to #ff0000 (was rgb(0, 0, 0)); change its link target (href) from "/shop" to "/order".',
      "3. `div.promo`: remove this element from the page.",
    ]);
    expect(input.message).not.toContain("not mine");
    expect(tick).toHaveBeenCalledWith("run-1");
    const mine = state.edits.filter((e) => e.app_id === APP);
    expect((input as unknown as { site_inline_edits: unknown }).site_inline_edits).toEqual(
      mine.map((e) => ({ id: e.id, updated_at: e.updated_at })),
    );
    expect(state.edits).toHaveLength(4);
  });

  it("applies only the exact text snapshots submitted with Send and leaves newer drafts alone", async () => {
    const sent = edit({ selector: "h1.hero", patch: { text: "Fresh bread daily", before: { text: "Welcome" } } });
    const later = edit({ selector: "p.tagline", patch: { text: "Added while Send waited", before: { text: "Old tagline" } } });
    state.edits = [sent, later];
    const refine = vi.fn(async () => ({ conductor_run_id: "run-batch" }));
    const r = await call(
      (req, res) => handleApplySiteEdits(req, res, deps({ refine })),
      { body: { app_id: APP, edits: [{ selector: sent.selector, text: "Fresh bread daily" }] } },
    );
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ applied: 1, remaining: 1, applied_selectors: ["h1.hero"], conductor_run_id: "run-batch" });
    const input = (refine.mock.calls[0] as unknown as [{ message: string; site_inline_edits: unknown }])[0];
    expect(input.message).toContain("`h1.hero`");
    expect(input.message).not.toContain("p.tagline");
    expect(input.site_inline_edits).toEqual([{ id: sent.id, updated_at: sent.updated_at }]);
  });

  it("does not apply a selector whose saved text changed after the submitted snapshot", async () => {
    state.edits = [edit({ selector: "h1.hero", patch: { text: "Newer text", before: { text: "Welcome" } } })];
    const refine = vi.fn();
    const r = await call(
      (req, res) => handleApplySiteEdits(req, res, deps({ refine })),
      { body: { app_id: APP, edits: [{ selector: "h1.hero", text: "Older submitted text" }] } },
    );
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ applied: 0, remaining: 1, applied_selectors: [] });
    expect(refine).not.toHaveBeenCalled();
  });

  it("matches hydrated drafts by immutable id and updated_at", async () => {
    const sent = edit({ selector: "h1.hero", patch: { text: "Hydrated text", before: { text: "Welcome" } } });
    const later = edit({ selector: "p.tagline", patch: { text: "Later", before: { text: "Old" } } });
    state.edits = [sent, later];
    const refine = vi.fn(async () => ({ conductor_run_id: "run-hydrated" }));
    const r = await call(
      (req, res) => handleApplySiteEdits(req, res, deps({ refine })),
      { body: { app_id: APP, edits: [{ selector: sent.selector, id: sent.id, updated_at: sent.updated_at }] } },
    );
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ applied: 1, remaining: 1, applied_selectors: ["h1.hero"], conductor_run_id: "run-hydrated" });
    expect((refine.mock.calls[0] as unknown as [{ site_inline_edits: unknown }])[0].site_inline_edits).toEqual([{ id: sent.id, updated_at: sent.updated_at }]);
  });

  it("keeps every draft when the refine is refused, and says why", async () => {
    seedDrafts();
    const before = JSON.stringify(state.edits);
    for (const err of [new DoubleBuildInFlight(T), new FreeEditsUsed(), new Error("boom")]) {
      const tick = vi.fn();
      const r = await call(
        (req, res) => handleApplySiteEdits(req, res, deps({ refine: vi.fn(async () => { throw err; }), tick })),
        { body: { app_id: APP } },
      );
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect((r.body as { kept: number }).kept).toBe(3);
      expect(tick).not.toHaveBeenCalled();
      expect(JSON.stringify(state.edits)).toBe(before);
    }
    const busy = await call(
      (req, res) => handleApplySiteEdits(req, res, deps({ refine: vi.fn(async () => { throw new DoubleBuildInFlight(T); }) })),
      { body: { app_id: APP } },
    );
    expect(busy.statusCode).toBe(409);
    expect(code(busy)).toBe("build_already_in_progress");
    const restarting = await call(
      (req, res) => handleApplySiteEdits(req, res, deps({ refine: vi.fn(async () => { throw new SitePreviewRestarting(SITE); }) })),
      { body: { app_id: APP } },
    );
    expect(restarting.statusCode).toBe(409);
    expect(code(restarting)).toBe("preview_restarting");
    expect((restarting.body as { kept: number }).kept).toBe(3);
  });

  it("the refine's success clears only the carried drafts whose updated_at still matches", async () => {
    seedDrafts();
    let carried: Array<{ id: string; updated_at: string }> = [];
    const refine = vi.fn(async (input: { site_inline_edits?: Array<{ id: string; updated_at: string }> }) => {
      carried = input.site_inline_edits ?? [];
      return { conductor_run_id: "run-1" };
    });
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine: refine as never })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(200);
    expect(state.edits.filter((e) => e.app_id === APP)).toHaveLength(3);
    await call(setWebsiteEditHandler, { body: { app_id: APP, selector: "h1.hero", patch: { text: "Changed after Apply" } } });
    await call(setWebsiteEditHandler, { body: { app_id: APP, selector: "p.new", patch: { text: "New after Apply" } } });
    const out = await clearAppliedSiteEdits(asTenantId(T), APP, carried);
    expect(out.cleared).toBe(2);
    const left = state.edits.filter((e) => e.app_id === APP);
    expect(left.map((e) => e.selector).sort()).toEqual(["h1.hero", "p.new"]);
    expect((left.find((e) => e.selector === "h1.hero")!.patch as { text: string }).text).toBe("Changed after Apply");
    expect(state.edits.some((e) => e.app_id === FOREIGN_APP)).toBe(true);
  });

  it("a foreign site is refused before any read or refine", async () => {
    seedDrafts();
    const refine = vi.fn();
    const loadRows = vi.fn(loadSiteEditRows);
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, loadRows })), { body: { app_id: FOREIGN_APP } });
    expect(r.statusCode).toBe(403);
    expect(code(r)).toBe("not_your_app");
    expect(refine).not.toHaveBeenCalled();
    expect(loadRows).not.toHaveBeenCalled();
  });

  it("nothing to apply answers 0 without starting a refine", async () => {
    const refine = vi.fn();
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine })), { body: { app_id: APP } });
    expect(r.body).toEqual({ applied: 0, remaining: 0, applied_selectors: [] });
    expect(refine).not.toHaveBeenCalled();
  });

  it("applies what fits in one refine message and leaves the rest as drafts", async () => {
    state.edits = Array.from({ length: 30 }, (_, i) =>
      edit({ selector: `p.item-${i}`, patch: { text: `${"word ".repeat(30)}${i}`, before: { text: "old" } } }),
    );
    let carried: Array<{ id: string; updated_at: string }> = [];
    const refine = vi.fn(async (input: { message: string; site_inline_edits?: Array<{ id: string; updated_at: string }> }) => {
      expect(input.message.length).toBeLessThanOrEqual(4000);
      carried = input.site_inline_edits ?? [];
      return { conductor_run_id: "run-1" };
    });
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine: refine as never })), { body: { app_id: APP } });
    const body = r.body as { applied: number; remaining: number };
    expect(body.applied).toBeGreaterThan(0);
    expect(body.remaining).toBeGreaterThan(0);
    expect(body.applied + body.remaining).toBe(30);
    expect(state.edits).toHaveLength(30);
    expect(carried).toHaveLength(body.applied);
    const message = (refine.mock.calls[0][0] as { message: string }).message;
    for (const c of carried) {
      const row = state.edits.find((e) => e.id === c.id)!;
      expect(message).toContain(`\`${String(row.selector)}\``);
    }
    await clearAppliedSiteEdits(asTenantId(T), APP, carried);
    expect(state.edits).toHaveLength(body.remaining);
  });
});

describe("removing a site element keeps what it said", () => {
  it("a removal stores the element's original so the refine names the text being removed", async () => {
    const r = await call(setWebsiteEditHandler, {
      body: { app_id: APP, selector: "p.note", remove: true, before: { text: "Closed Mondays" } },
    });
    expect(r.statusCode).toBe(200);
    expect(state.edits[0]).toMatchObject({ app_id: APP, selector: "p.note", removed: true, patch: { before: { text: "Closed Mondays" } } });
    const rows = await loadSiteEditRows(asTenantId(T), APP);
    const { message } = siteEditsRefineMessage(rows as never);
    expect(message.split("\n")[1]).toBe('1. `p.note` (currently reads "Closed Mondays"): remove this element from the page.');
  });

  it("removing an element already edited keeps the FIRST original, not the edited text", async () => {
    await call(setWebsiteEditHandler, { body: { app_id: APP, selector: "h1", patch: { text: "Edited" }, before: { text: "Original" } } });
    await call(setWebsiteEditHandler, { body: { app_id: APP, selector: "h1", remove: true, before: { text: "Edited" } } });
    expect(state.edits).toHaveLength(1);
    expect(state.edits[0]).toMatchObject({ removed: true, patch: { before: { text: "Original" } } });
    expect(state.edits[0].patch).not.toHaveProperty("text");
  });

  it("restoring a removal (Ask AI revert) keeps its original too", async () => {
    state.edits = [edit({ selector: "h2", patch: { text: "AI" } })];
    const expected = { id: state.edits[0].id, updated_at: state.edits[0].updated_at };
    const r = await call(discardWebsiteEditsHandler, {
      body: { app_id: APP, selector: "h2", restore: { patch: { before: { text: "Menu" } }, removed: true }, expected },
    });
    expect(r.statusCode).toBe(200);
    expect(state.edits[0]).toMatchObject({ removed: true, patch: { before: { text: "Menu" } } });
  });
});

describe("refuseInlineEdit always answers", () => {
  it("answers the caller's own site key with the Apply code instead of leaving the request hanging", async () => {
    const res = mockRes();
    await refuseInlineEdit(T as never, APP, res as never);
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe("site_edits_apply");
  });

  it("still answers a foreign site key with 403", async () => {
    const res = mockRes();
    await refuseInlineEdit(T as never, FOREIGN_APP, res as never);
    expect(res.statusCode).toBe(403);
    expect(code(res)).toBe("not_your_app");
  });
});

describe("an unreadable drafts table never reaches the founder as database text", () => {
  it("answers with fixed copy and logs the database error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ loadRows: async () => ({ error: "relation \"public.website_edits\" does not exist" }) })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("relation");
    expect((r.body as { error: { message: string } }).error.message).toMatch(/still saved/);
    expect(warn.mock.calls.some(([l]) => String(l).includes("does not exist"))).toBe(true);
  });
});

describe("text-only drafts go straight into the code (site_text_edit_direct)", () => {
  type DirectInput = Parameters<NonNullable<ApplySiteEditsDeps["direct"]>["apply"]>[0];
  type DirectResult = Awaited<ReturnType<NonNullable<ApplySiteEditsDeps["direct"]>["apply"]>>;
  function seed() {
    state.edits = [
      edit({ selector: "h1.hero", patch: { text: "Fresh bread daily", before: { text: "Welcome" } } }),
      edit({ selector: "a.cta", patch: { style: { color: "#ff0000" }, before: { style: { color: "rgb(0, 0, 0)" } } } }),
    ];
  }
  function directDeps(applied: (rows: DirectInput["rows"]) => DirectInput["rows"], enabled = true) {
    const apply = vi.fn(async (input: DirectInput): Promise<DirectResult> => {
      const ok = applied(input.rows);
      const ids = new Set(ok.map((r) => r.id));
      return { applied: ok, fallback: input.rows.filter((r) => !ids.has(r.id)), conductor_run_id: null, reason: null };
    });
    return { enabled: vi.fn(async () => enabled), apply };
  }

  it("all rows applied directly: no refine, no tick, the answer says direct", async () => {
    state.edits = [edit({ selector: "h1.hero", patch: { text: "Fresh bread daily", before: { text: "Welcome" } } })];
    const direct = directDeps((rows) => rows);
    const refine = vi.fn();
    const tick = vi.fn();
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, tick, direct })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ applied: 1, remaining: 0, applied_selectors: ["h1.hero"], direct: true, rows_direct: 1, rows_fallback: 0 });
    expect(refine).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    const input = direct.apply.mock.calls[0][0];
    expect(input.tenant_id).toBe(T);
    expect(input.app_id).toBe(APP);
    expect(input.site.id).toBe(SITE);
    expect(input.rows.map((x) => x.selector)).toEqual(["h1.hero"]);
  });

  it("a direct apply names its change record, so the chat can swap its saving line for the real change", async () => {
    state.edits = [edit({ selector: "h1.hero", patch: { text: "Fresh bread daily", before: { text: "Welcome" } } })];
    const direct = directDeps((rows) => rows);
    direct.apply.mockImplementationOnce(async (input: DirectInput) => ({ applied: input.rows, fallback: [], conductor_run_id: "chg-77", reason: null }));
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine: vi.fn(), tick: vi.fn(), direct })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ applied: 1, remaining: 0, applied_selectors: ["h1.hero"], direct: true, rows_direct: 1, rows_fallback: 0, change_id: "chg-77" });
    expect((r.body as Record<string, unknown>).conductor_run_id).toBeUndefined();
  });

  it("partial: only the rows the direct path could not place go to the refine, and the answer counts both", async () => {
    seed();
    const direct = directDeps((rows) => rows.filter((x) => x.selector === "h1.hero"));
    const refine = vi.fn(async (_input: Parameters<ApplySiteEditsDeps["refine"]>[0]) => ({ conductor_run_id: "run-9" }));
    const tick = vi.fn(async () => true);
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, tick, direct })), { body: { app_id: APP } });
    expect(r.body).toEqual({ applied: 2, remaining: 0, applied_selectors: ["h1.hero", "a.cta"], conductor_run_id: "run-9", direct: true, rows_direct: 1, rows_fallback: 1 });
    const input = refine.mock.calls[0][0];
    expect(input.message).toContain("`a.cta`");
    expect(input.message).not.toContain("h1.hero");
    expect(input.request).toBe("Applied 1 edit");
    const cta = state.edits.find((e) => e.selector === "a.cta")!;
    expect(input.site_inline_edits).toEqual([{ id: cta.id, updated_at: cta.updated_at }]);
    expect(tick).toHaveBeenCalledWith("run-9");
  });

  it("nothing placed directly: today's refine with every row and today's answer shape", async () => {
    seed();
    const direct = directDeps(() => []);
    const refine = vi.fn(async () => ({ conductor_run_id: "run-2" }));
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, direct })), { body: { app_id: APP } });
    expect(r.body).toEqual({ applied: 2, remaining: 0, applied_selectors: ["h1.hero", "a.cta"], conductor_run_id: "run-2" });
  });

  it("a throwing direct path never loses the edits: they all go to the refine", async () => {
    seed();
    const direct = { enabled: vi.fn(async () => true), apply: vi.fn(async () => { throw new Error("boom"); }) };
    const refine = vi.fn(async () => ({ conductor_run_id: "run-3" }));
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, direct })), { body: { app_id: APP } });
    expect(r.body).toEqual({ applied: 2, remaining: 0, applied_selectors: ["h1.hero", "a.cta"], conductor_run_id: "run-3" });
  });

  it("a preview that is still starting says so, keeps the rows, and never sends them through the refine path", async () => {
    seed();
    const direct = directDeps(() => []);
    direct.apply.mockImplementationOnce(async (input: DirectInput) => ({
      applied: [],
      fallback: input.rows,
      conductor_run_id: null,
      reason: "preview_starting",
    }));
    const refine = vi.fn();
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, direct })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe("preview_starting");
    expect(JSON.stringify(r.body)).toContain("Your preview is starting up");
    expect(refine).not.toHaveBeenCalled();
  });

  it("a held direct-edit lease stays busy instead of duplicating the rows through the refine path", async () => {
    seed();
    const direct = directDeps(() => []);
    direct.apply.mockImplementationOnce(async (input: DirectInput) => ({
      applied: [],
      fallback: input.rows,
      conductor_run_id: null,
      reason: "lease_held",
    }));
    const refine = vi.fn();
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, direct })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(409);
    expect(code(r)).toBe("edits_busy");
    expect((r.body as { kept: number }).kept).toBe(2);
    expect(refine).not.toHaveBeenCalled();
  });

  it("setting off: the direct path is never tried and every row rides today's refine", async () => {
    seed();
    const direct = directDeps((rows) => rows, false);
    const refine = vi.fn(async () => ({ conductor_run_id: "run-4" }));
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, direct })), { body: { app_id: APP } });
    expect(direct.enabled).toHaveBeenCalledWith(T);
    expect(direct.apply).not.toHaveBeenCalled();
    expect(r.body).toEqual({ applied: 2, remaining: 0, applied_selectors: ["h1.hero", "a.cta"], conductor_run_id: "run-4" });
  });

  it("a failed setting read keeps every edit saved instead of bypassing direct-edit coordination", async () => {
    seed();
    const direct = { enabled: vi.fn(async () => { throw new Error("settings down"); }), apply: vi.fn() };
    const refine = vi.fn();
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ refine, direct })), { body: { app_id: APP } });
    expect(r.statusCode).toBe(503);
    expect(code(r)).toBe("settings_unavailable");
    expect((r.body as { error: { message: string } }).error.message).toMatch(/still saved/);
    expect(direct.apply).not.toHaveBeenCalled();
    expect(refine).not.toHaveBeenCalled();
  });

  it("another tenant's site is refused before the direct path sees it", async () => {
    state.edits = [edit({ tenant_id: OTHER_T, app_id: FOREIGN_APP, patch: { text: "x", before: { text: "y" } } })];
    const direct = directDeps((rows) => rows);
    const r = await call((req, res) => handleApplySiteEdits(req, res, deps({ direct })), { body: { app_id: FOREIGN_APP } });
    expect(r.statusCode).toBe(403);
    expect(direct.enabled).not.toHaveBeenCalled();
    expect(direct.apply).not.toHaveBeenCalled();
  });

  it("the refine for the leftover rows is refused: the direct rows are still reported", async () => {
    seed();
    const direct = directDeps((rows) => rows.filter((x) => x.selector === "h1.hero"));
    const r = await call(
      (req, res) => handleApplySiteEdits(req, res, deps({ refine: vi.fn(async () => { throw new DoubleBuildInFlight(T); }), direct })),
      { body: { app_id: APP } },
    );
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.body).toMatchObject({ kept: 1, direct: true, rows_direct: 1 });
  });
});
