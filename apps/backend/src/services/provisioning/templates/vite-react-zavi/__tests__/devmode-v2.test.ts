import { describe, it, expect } from "vitest";
import { createZavi, type KeyValueStorage } from "../files/src/zavi/client";
import { DevStore } from "../files/src/zavi/devstore";
import { createLocalServer } from "../files/src/zavi/local";
import { validateManifest } from "../manifest";
import { v2 } from "./fixtures/kernel-v2";

const ORIGIN = "http://localhost:5173";
const SITE = "00000000-0000-4000-8000-00000000d0e0";
const mem = (): KeyValueStorage => { const d = new Map<string, string>(); return { getItem: (k) => d.get(k) ?? null, setItem: (k, v) => void d.set(k, v), removeItem: (k) => void d.delete(k) }; };

function world() {
  const m = validateManifest(v2());
  if (!m.ok) throw new Error(JSON.stringify(m.issues));
  const store = new DevStore({ manifest: m.value });
  const server = createLocalServer({
    store, siteId: SITE, persist: null,
    seed: { users: [{ email: "admin@example.com", password: "preview-admin-1", role: "admin" }, { email: "seller@example.com", password: "preview-seller-1", role: "seller" }] },
  });
  const tab = async (email?: string, password?: string) => {
    const z = createZavi({ fetch: server.fetch, origin: ORIGIN, siteId: async () => SITE, storage: mem() });
    if (email) await z.auth.signIn({ email, password: password as string });
    return z;
  };
  return { store, tab, server };
}
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as { code: string; reason: string; status: number }; } throw new Error("expected failure"); };

describe("dev mode v2: a booking site end to end through the SDK", () => {
  it("publish, request, accept, reserve, sell out, cancel, aggregate, admin members", async () => {
    const w = world();
    const seller = await w.tab("seller@example.com", "preview-seller-1");
    const admin = await w.tab("admin@example.com", "preview-admin-1");
    const buyer = await w.tab();
    await buyer.auth.signUp({ email: "buyer@example.com", password: "buyer-pass-1" });
    const visitor = await w.tab();

    const { id: listing } = await seller.data.collection("listings").create({ title: "Kayak", status: "draft" });
    expect(await visitor.data.collection("listings").get(listing)).toBeNull();
    expect(await seller.data.collection("listings").transition(listing, "published")).toMatchObject({ from: "draft", to: "published", transitioned: true });
    expect((await visitor.data.collection("listings").get(listing))?.data.title).toBe("Kayak");

    const { id: request } = await buyer.data.collection("requests").create({ listing_id: listing, message: "Saturday?", status: "pending" });
    expect((await seller.data.collection("requests").list()).items.map((r) => r.id)).toEqual([request]);
    expect(await fail(buyer.data.collection("requests").transition(request, "accepted"))).toMatchObject({ code: "not_found", status: 404 });
    await seller.data.collection("requests").transition(request, "accepted");
    expect(await fail(buyer.data.collection("requests").create({ listing_id: "99999999-0000-4000-8000-000000000000", message: "x", status: "pending" })))
      .toMatchObject({ code: "validation", reason: "invalid_reference", status: 400 });

    const { id: slot } = await seller.data.collection("slots").create({ listing_id: listing, starts_at: "2026-10-03T09:00:00Z", capacity: 1, booked_count: 0 });
    const r1 = await buyer.actions.run("reserve_slot", { targetId: slot, data: { note: "two adults" } }, { idempotencyKey: "reserve-000000000001" });
    expect(r1).toMatchObject({ counter: 1, replayed: false });
    expect(await buyer.actions.run("reserve_slot", { targetId: slot, data: { note: "two adults" } }, { idempotencyKey: "reserve-000000000001" })).toMatchObject({ replayed: true });
    expect(await fail(admin.actions.run("reserve_slot", { targetId: slot }))).toMatchObject({ code: "conflict", reason: "action_bound", status: 409 });
    expect(await fail(visitor.actions.run("reserve_slot", { targetId: slot }))).toMatchObject({ code: "not_allowed", reason: "action_not_allowed" });
    expect(await admin.aggregates.run("booking_count", { filter: { status: "booked" } })).toEqual({ value: 1 });
    expect(await fail(buyer.aggregates.run("booking_count"))).toMatchObject({ reason: "aggregate_not_allowed", status: 403 });
    await buyer.actions.run("cancel_slot", { recordId: r1.record_id });
    expect((await visitor.data.collection("slots").get(slot))?.data.booked_count).toBe(0);

    const page = await admin.members.list();
    expect(page.items.map((x) => x.email).sort()).toEqual(["admin@example.com", "buyer@example.com", "seller@example.com"]);
    const buyerId = page.items.find((x) => x.email === "buyer@example.com")!.user_id!;
    expect(await admin.members.setRole(buyerId, "moderator")).toMatchObject({ role: "moderator", email: "buyer@example.com" });
    expect(await fail(admin.members.setRole(buyerId, "ghost"))).toMatchObject({ reason: "invalid_role" });
    expect(await fail(seller.members.list())).toMatchObject({ reason: "member_admin_required", status: 403 });
    const invited = await admin.members.invite({ email: "new@example.com", role: "seller" });
    expect(invited).toEqual({ email: "new@example.com", role: "seller", status: "invited" });
    expect(await admin.members.invite({ email: "seller@example.com", role: "user" })).toEqual({ email: "seller@example.com", role: "user", status: "invited" });
    const adminId = page.items.find((x) => x.email === "admin@example.com")!.user_id!;
    const sellerId = page.items.find((x) => x.email === "seller@example.com")!.user_id!;
    expect(await fail(admin.members.disable(adminId))).toMatchObject({ code: "conflict", reason: "last_admin" });

    expect(await fail(seller.members.reassignOwner("listings", listing, buyerId))).toMatchObject({ reason: "member_admin_required" });
    expect(await admin.members.reassignOwner("listings", listing, buyerId)).toEqual({ id: listing, owner_id: buyerId });
    expect((await buyer.data.collection("listings").get(listing))?.mine).toBe(true);
    expect(await fail(admin.members.reassignOwner("listings", listing, "99999999-0000-4000-8000-000000000000"))).toMatchObject({ reason: "member_not_found" });
    await admin.members.disable(sellerId);
    expect(await admin.members.reenableMember(sellerId)).toMatchObject({ user_id: sellerId, status: "active", email: "seller@example.com" });
    expect(await admin.members.remove(sellerId)).toEqual({ user_id: sellerId, removed: true });
    expect((await visitor.data.collection("slots").get(slot))?.data.capacity).toBe(1);
    await expect(admin.members.deleteUserData(sellerId, {} as never)).rejects.toMatchObject({ reason: "confirm_required" });
    expect(await admin.members.deleteUserData(sellerId, { confirm: true })).toMatchObject({ user_id: sellerId, records: 2, files: 0 });
    expect(await visitor.data.collection("slots").get(slot)).toBeNull();
  });
});
