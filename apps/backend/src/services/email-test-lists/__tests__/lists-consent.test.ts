import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ lists: [] as unknown[] }));
vi.mock("@/services/comms/bulk-outbound/lists", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/lists")>()),
  listSummaries: async () => store.lists,
}));

import { readTestLists, zaviListsFor } from "../lists";

const active = (sendable: number) => ({ id: "v1", source_kind: "csv", contact_count: sendable, sendable, unsubscribed_or_bounced: 0 });
const summary = (id: string, name: string, over: Record<string, unknown>) => ({ id, name, created_at: "2026-10-01T00:00:00Z", latest: null, active: active(12), needs_consent: false, ...over });

describe("Zavi lists in the campaign picker say which ones Zavi may not send to", () => {
  it("an unconfirmed list and a list with no active version carry needs_consent; a confirmed one does not", async () => {
    store.lists = [
      summary("11111111-1111-4111-8111-111111111111", "Members", {}),
      summary("22222222-2222-4222-8222-222222222222", "Imported leads", { needs_consent: true }),
      summary("33333333-3333-4333-8333-333333333333", "Half uploaded", { active: null }),
    ];
    const v = await readTestLists("t", {
      caller: async () => null,
      marks: async () => new Set(),
      zaviLists: zaviListsFor(false),
      sendgridNeedsPermissions: async () => false,
    });
    const zavi = v.routes.find((r) => r.route === "zavi_list")!;
    expect(zavi.status).toBe("complete");
    const by = Object.fromEntries(zavi.lists.map((l) => [l.name, l]));
    expect(by["Members"].needs_consent).toBeUndefined();
    expect(by["Members"].people).toBe(12);
    expect(by["Imported leads"].needs_consent).toBe(true);
    expect(by["Imported leads"].people).toBe(12);
    expect(by["Half uploaded"].needs_consent).toBe(true);
    expect(by["Half uploaded"].people).toBeNull();
  });

  it("must catch: a list with a newer import waiting says it still has a confirmed version; the others do not", async () => {
    store.lists = [
      summary("11111111-1111-4111-8111-111111111111", "Members", {}),
      summary("22222222-2222-4222-8222-222222222222", "Imported leads", { needs_consent: true }),
      summary("33333333-3333-4333-8333-333333333333", "Half uploaded", { active: null, needs_consent: true }),
    ];
    const v = await readTestLists("t", { caller: async () => null, marks: async () => new Set(), zaviLists: zaviListsFor(false), sendgridNeedsPermissions: async () => false });
    const by = Object.fromEntries(v.routes.find((r) => r.route === "zavi_list")!.lists.map((l) => [l.name, l]));
    expect(by["Imported leads"]).toMatchObject({ needs_consent: true, consented_version: true });
    expect(by["Members"].consented_version).toBeUndefined();
    expect(by["Half uploaded"].needs_consent).toBe(true);
    expect(by["Half uploaded"].consented_version).toBeUndefined();
  });
});
