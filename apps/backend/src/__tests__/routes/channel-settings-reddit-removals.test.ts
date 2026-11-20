import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

type Row = {
  item: string;
  item_type: string | null;
  status: string | null;
  position: number | null;
  note: string | null;
  origin: string | null;
  detail: string | null;
};

const h = vi.hoisted(() => ({
  fields: {} as Record<string, Row[]>,
  record: ["Acme"] as string[] | Error,
}));

vi.mock("@/services/tenant-client", () => ({
  tenantRpc: vi.fn(async (_t: string, fn: string, args: Record<string, unknown>) => {
    if (fn === "get_channel_settings") return { data: { fields: h.fields }, error: null };
    h.fields[String(args.p_field_id)] = (args.p_items as Row[]).map((r) => ({ ...r }));
    return { data: { ok: true, written: 0, deleted: 0, dropped: 0, fields: h.fields }, error: null };
  }),
}));
vi.mock("@/services/auth/middleware", () => ({
  requireAuth: vi.fn().mockResolvedValue({ user_id: "u1", tenant_id: "t1", access_token: "jwt" }),
}));
vi.mock("@/services/auth/tenant-role", () => ({ requireTenantRole: vi.fn().mockResolvedValue(true) }));
vi.mock("@/services/company/facts", () => ({
  getCompanyFacts: vi.fn(async () => {
    if (h.record instanceof Error) throw h.record;
    return { name: "Bakely", nameIsWorkspaceLabel: false, website: "bakely.com", competitors: h.record, facts: {} };
  }),
}));

import { channelSettingsPut } from "../../routes/channels/settings";
import { mergedTrackedCompetitors, type RedditWorkspace } from "@/services/channels/reddit/workspace";
import { brandKeywordAction } from "@/services/channels/reddit/suggest";

const row = (item: string, extra: Partial<Row> = {}): Row => ({
  item,
  item_type: null,
  status: "tracking",
  position: null,
  note: null,
  origin: "custom",
  detail: null,
  ...extra,
});

async function save(fieldId: string, keep: Row[]) {
  let code = 200;
  const res = { status: (c: number) => ((code = c), res), json: () => res } as unknown as Response;
  await channelSettingsPut({ params: { slug: "reddit_organic", fieldId }, body: { items: keep } } as unknown as Request, res);
  return code;
}

const stored = (field: string, item: string) => h.fields[field]?.find((r) => r.item === item);

function workspace(): RedditWorkspace {
  return {
    keywords: (h.fields.keywords ?? []).map((r, i) => ({
      id: `k${i}`,
      term: r.item,
      type: (r.item_type ?? "problem") as RedditWorkspace["keywords"][number]["type"],
      origin: "custom",
      status: r.status as RedditWorkspace["keywords"][number]["status"],
      why: null,
    })),
    competitors: (h.fields.competitors ?? []).map((r, i) => ({
      id: `c${i}`,
      name: r.item,
      domain: r.detail,
      origin: "custom",
      status: r.status as RedditWorkspace["competitors"][number]["status"],
      why: null,
    })),
    communities: [],
  };
}

describe("removing a reddit competitor or the brand keyword in the Settings tab", () => {
  beforeEach(() => {
    h.record = ["Acme"];
    h.fields = {
      competitors: [row("Acme", { detail: "acme.com" }), row("Rando")],
      keywords: [row("Bakely", { item_type: "brand" }), row("eggless cake", { item_type: "problem" })],
    };
  });

  it("keeps a removed competitor that is on the company record as dismissed, so the run stops tracking it", async () => {
    expect(await save("competitors", [row("Rando")])).toBe(200);

    expect(stored("competitors", "Acme")).toMatchObject({ status: "dismissed", detail: "acme.com" });
    expect(mergedTrackedCompetitors(workspace(), ["Acme"]).map((c) => c.name)).toEqual(["Rando"]);
  });

  it("really deletes a removed competitor the record does not carry", async () => {
    await save("competitors", [row("Acme")]);
    expect(stored("competitors", "Rando")).toBeUndefined();
  });

  it("keeps the brand keyword as dismissed, so opening the panel does not insert it again", async () => {
    await save("keywords", [row("eggless cake", { item_type: "problem" })]);

    expect(stored("keywords", "Bakely")).toMatchObject({ status: "dismissed", item_type: "brand" });
    const facts = { name: "Bakely", nameIsWorkspaceLabel: false, website: "bakely.com" };
    expect(brandKeywordAction(facts, workspace().keywords)).toBeNull();
  });

  it("really deletes a removed keyword that is not the brand", async () => {
    await save("keywords", [row("Bakely", { item_type: "brand" })]);
    expect(stored("keywords", "eggless cake")).toBeUndefined();
  });

  it("keeps the removed competitor dismissed when the company record cannot be read", async () => {
    h.record = new Error("facts down");
    await save("competitors", []);
    expect(stored("competitors", "Acme")?.status).toBe("dismissed");
    expect(stored("competitors", "Rando")?.status).toBe("dismissed");
  });

  it("puts a kept dismissed row after everything the founder listed", async () => {
    await save("competitors", [row("Rando", { position: 0 })]);
    const acme = stored("competitors", "Acme")!;
    expect(acme.position).toBeGreaterThan(stored("competitors", "Rando")!.position ?? 0);
    expect(h.fields.competitors.map((r) => r.item)).toEqual(["Rando", "Acme"]);
  });

  it("refuses a full list rather than letting the 200 cap cut a kept row", async () => {
    const full = Array.from({ length: 200 }, (_, i) => row(`kw ${i}`));
    h.fields.competitors = [row("Acme"), ...full];
    const before = h.fields.competitors.map((r) => r.item);

    expect(await save("competitors", full)).toBe(400);
    expect(h.fields.competitors.map((r) => r.item)).toEqual(before);
  });

  it("still saves, as before, when the pre-read of the list fails", async () => {
    const { tenantRpc } = await import("@/services/tenant-client");
    vi.mocked(tenantRpc).mockReturnValueOnce(
      Promise.resolve({ data: null, error: { message: "timeout" } }) as unknown as ReturnType<typeof tenantRpc>,
    );

    expect(await save("competitors", [row("Rando")])).toBe(200);
    expect(stored("competitors", "Acme")).toBeUndefined();
  });

  it("does not treat a case change as a removal", async () => {
    await save("competitors", [row("acme", { detail: "acme.com" }), row("Rando")]);
    expect(h.fields.competitors.filter((r) => r.item.toLowerCase() === "acme")).toHaveLength(1);
  });
});
