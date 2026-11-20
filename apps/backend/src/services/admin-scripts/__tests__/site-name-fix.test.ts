import { describe, expect, it, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({ staffCrossTenantClient: vi.fn(), asTenantId: (t: string) => t, tenantClient: vi.fn(), tenantRpc: vi.fn(), opsRpc: vi.fn() }));

import {
  applyNameFix,
  buildInputs,
  nameFixToken,
  overrideName,
  prepareNameFix,
  previewNameFix,
  siteNameFixSchema,
  SiteNameFixError,
  type NameRun,
  type NameSite,
  type SetNameOutcome,
  type SiteNameFixDeps,
} from "../site-name-fix";
import { getScript } from "../registry";

const SITE = "2b339139-183d-481f-84dd-d43ac493d94e";
const OWNER = "6fcb0904-4e2b-41dc-aa92-83810a902d2d";
const RUN = "5e2e5d2a-7e44-4b19-ae26-b4bea98888dc";

const site = (over: Partial<NameSite> = {}): NameSite => ({
  id: SITE,
  tenant_id: OWNER,
  label: "rise-amp-693dfbdb-2b3391",
  hostname: "rise-amp-693dfbdb-2b3391.zaviagent.com",
  status: "live",
  name: null,
  root_conductor_run_id: RUN,
  ...over,
});
const IDEA =
  "A website for Rise &amp; Shine Bakery, a bakery in Denver, with our breads and pastries with prices and an order form where customers place a pickup order that I can see on an admin page.";
const run = (over: Partial<NameRun> = {}): NameRun => ({
  objective: `Build product: Apna Tutor — ${IDEA}`,
  goal_graph: [
    { payload: { stage: "provision", company_name: "Apna Tutor", site_id: SITE } },
    { payload: { stage: "build", idea: IDEA } },
  ],
  ...over,
});

function db(row: NameSite | null, r: NameRun | null = run(), workspace: string | null = "Apna Tutor") {
  const state = { row: row ? { ...row } : null };
  const deps = {
    readSite: vi.fn(async (id: string) => (state.row && state.row.id === id ? { ...state.row } : null)),
    readRun: vi.fn(async (tenant: string, id: string) => (tenant === state.row?.tenant_id && id === RUN ? r : null)),
    readWorkspaceName: vi.fn(async () => workspace),
    setName: vi.fn(async (tenant: string, id: string, expected: string | null, name: string): Promise<SetNameOutcome> => {
      if (!state.row || state.row.id !== id || state.row.tenant_id !== tenant) return "not_found";
      if (state.row.name === name) return "already_applied";
      if (state.row.name !== expected) return "stale_preview";
      state.row.name = name;
      return "updated";
    }),
  } satisfies SiteNameFixDeps;
  return { state, deps };
}

describe("site-name-fix: the name new sites get, for an old site", () => {
  it("derives \"Rise & Shine Bakery\" for the prod Rise Amp site from its own build request; the address stays", async () => {
    const { deps } = db(site());
    const p = await previewNameFix({ site_id: SITE }, deps);
    expect(p.shown_now).toBe("Rise Amp");
    expect(p.new_name).toBe("Rise & Shine Bakery");
    expect(p.source).toBe("derived");
    expect(p.changes).toBe(true);
    expect(p.hostname).toBe("rise-amp-693dfbdb-2b3391.zaviagent.com");
    expect(p.confirm_phrase).toBe(`RENAME ${SITE}`);
    expect(p.not_updated.join(" ")).toMatch(/hostname/);
    expect(deps.readRun).toHaveBeenCalledWith(OWNER, RUN);
  });

  it("falls back to the objective when the graph has no idea, and a typed name wins over the derivation", async () => {
    expect(buildInputs(run({ goal_graph: [] }))).toEqual({ idea: expect.stringContaining("Rise & Shine Bakery"), company_name: "Apna Tutor" });
    expect(buildInputs(null)).toEqual({ idea: "", company_name: "" });
    const { deps } = db(site());
    const p = await previewNameFix({ site_id: SITE, name: "  Rise &amp; Shine  " }, deps);
    expect(p.new_name).toBe("Rise & Shine");
    expect(p.source).toBe("typed");
    expect(deps.readRun).not.toHaveBeenCalled();
  });

  it("a typed name that no site may carry is refused, not silently replaced by the derived one", () => {
    expect(() => overrideName("../etc")).toThrow(SiteNameFixError);
    expect(() => overrideName("!!!")).toThrow(/cannot be used/);
    expect(() => overrideName("   ")).toThrow(/cannot be used/);
  });

  it("the Dry Run changes nothing", async () => {
    const { deps, state } = db(site());
    await previewNameFix({ site_id: SITE }, deps);
    await previewNameFix({ site_id: SITE }, deps);
    expect(deps.setName).not.toHaveBeenCalled();
    expect(state.row!.name).toBeNull();
  });

  it("Apply stores the previewed name in the site's own workspace; a second Apply changes nothing", async () => {
    const { deps, state } = db(site());
    const p = await previewNameFix({ site_id: SITE }, deps);
    const prep = await prepareNameFix({ site_id: SITE }, deps, p.confirm_phrase, p.preview_token);
    expect(await applyNameFix(prep, deps)).toBe("updated");
    expect(deps.setName).toHaveBeenCalledWith(OWNER, SITE, null, "Rise & Shine Bakery");
    expect(state.row!.name).toBe("Rise & Shine Bakery");
    expect(state.row!.label).toBe("rise-amp-693dfbdb-2b3391");
    const again = await previewNameFix({ site_id: SITE }, deps);
    expect(again.changes).toBe(false);
    await expect(prepareNameFix({ site_id: SITE }, deps, again.confirm_phrase, again.preview_token)).rejects.toMatchObject({ code: "nothing_to_change" });
    expect(await applyNameFix(prep, deps)).toBe("already_applied");
    expect(deps.setName).toHaveBeenCalledTimes(2);
  });

  it("Apply needs the exact confirmation and the Dry Run's token", async () => {
    const { deps } = db(site());
    const p = await previewNameFix({ site_id: SITE }, deps);
    await expect(prepareNameFix({ site_id: SITE }, deps, "RENAME", p.preview_token)).rejects.toMatchObject({ code: "confirm_mismatch" });
    await expect(prepareNameFix({ site_id: SITE }, deps, p.confirm_phrase, undefined)).rejects.toMatchObject({ code: "list_changed" });
    await expect(prepareNameFix({ site_id: SITE, name: "Other Name" }, deps, p.confirm_phrase, p.preview_token)).rejects.toMatchObject({ code: "list_changed" });
    expect(deps.setName).not.toHaveBeenCalled();
  });

  it("a name changed between the Dry Run and the write is not overwritten", async () => {
    const { deps, state } = db(site());
    const p = await previewNameFix({ site_id: SITE }, deps);
    const prep = await prepareNameFix({ site_id: SITE }, deps, p.confirm_phrase, p.preview_token);
    state.row!.name = "Owner Renamed It";
    await expect(applyNameFix(prep, deps)).rejects.toMatchObject({ code: "list_changed" });
    expect(state.row!.name).toBe("Owner Renamed It");
  });

  it("an unknown site is not found; a write scoped to another workspace changes nothing", async () => {
    const { deps, state } = db(site());
    await expect(previewNameFix({ site_id: "00000000-0000-4000-8000-000000000000" }, deps)).rejects.toMatchObject({ code: "not_found" });
    const p = await previewNameFix({ site_id: SITE }, deps);
    await expect(applyNameFix({ ...p, tenant_id: "11111111-1111-4111-8111-111111111111" }, deps)).rejects.toMatchObject({ code: "not_found" });
    expect(state.row!.name).toBeNull();
  });

  it("the token binds the workspace, the site, the stored name and the new name", () => {
    const base = nameFixToken(site(), "A");
    expect(nameFixToken(site(), "B")).not.toBe(base);
    expect(nameFixToken(site({ name: "" }), "A")).not.toBe(base);
    expect(nameFixToken(site({ tenant_id: "x" }), "A")).not.toBe(base);
  });

  it("is registered with a schema that rejects a non-uuid and stores no names", () => {
    const s = getScript("site-name-fix")!;
    expect(s.applies).toBe(true);
    expect(siteNameFixSchema.safeParse({ site_id: "nope" }).success).toBe(false);
    const args = siteNameFixSchema.parse({ site_id: SITE.toUpperCase(), name: "" });
    expect(args).toEqual({ site_id: SITE });
    expect(s.storedArgs({ site_id: SITE, name: "Secret Name" }, {} as never)).toEqual({ site_id: SITE, typed_name: true });
  });
});
