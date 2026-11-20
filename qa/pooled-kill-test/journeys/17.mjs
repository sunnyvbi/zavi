import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";

await main({ n: "17", title: "phone marketplace", url: import.meta.url }, async (x) => {
  const ls = await x.step("seller_a.lists_phone", async () => ({ id: await x.create("a", "listings", { brand: "apple", contact_phone: "+1 555 0100" }) }));
  if (!ls) return;
  await x.step("visitor.browses_without_phone", () => x.masked("visitor", "listings", ls.id, ["contact_phone"]));
  await x.step("visitor.filters_brand", () => x.sees("visitor", "listings", ls.id, { listOpts: { filter: { brand: "apple" }, order: "price_cents" } }));
  await x.step("buyer_b.sees_phone", async () => { const r = await x.get("b", "listings", ls.id); must(r?.data?.contact_phone === "+1 555 0100", "signed-in buyer cannot read the phone"); });
  await x.step("buyer_b.cannot_edit_listing", () => x.refused(() => x.update("b", "listings", ls.id, { price_cents: 1 })));
  await x.step("photo.public", async () => { const name = await x.upload("a", "listing_photos", "phone"); const l = await x.actors.visitor.z.storage.list("listing_photos"); must(l.some((f) => f.name === name), "visitor cannot list photos"); });
  const msg = await x.v2step("buyer_b.messages_seller", async () => ({ id: await x.create("b", "messages", { listing_id: ls.id, body: "still available?" }) }));
  if (msg) {
    await x.step("recipient.seller_reads", () => x.sees("a", "messages", msg.id));
    await x.step("third_party.cannot_read", () => x.hidden("c", "messages", msg.id));
    await x.step("visitor.cannot_message", () => x.refused(() => x.create("visitor", "messages", { listing_id: ls.id, body: "hi" })));
  }
  const rep = await x.step("buyer_b.reports_listing", async () => ({ id: await x.create("b", "reports", { listing_id: ls.id }) }));
  if (rep) {
    await x.step("seller.cannot_see_report", () => x.hidden("a", "reports", rep.id));
    await x.step("admin.sees_report", () => x.sees("admin", "reports", rep.id));
    await x.v2step("admin.resolves_report", () => x.transition("admin", "reports", rep.id, "resolved"));
  }
  await x.v2step("seller.marks_sold", () => x.transition("a", "listings", ls.id, "sold"));
  await x.v2step("buyer.cannot_mark_sold", async () => { const id = await x.create("a", "listings", { brand: "google" }); return x.refused(() => x.transition("b", "listings", id, "sold"), EXPECT.transitionDenied); });
  await x.v2step("sold.still_public", () => x.sees("visitor", "listings", ls.id, { inList: false }));
  await x.v2step("removed.hidden_from_visitor", async () => { const id = await x.create("a", "listings", { brand: "other" }); await x.transition("a", "listings", id, "removed"); return x.hidden("visitor", "listings", id); });
  await x.v2step("generic_patch.cannot_change_status", () => x.refused(() => x.update("a", "listings", ls.id, { status: "available" }), EXPECT.serverOwned));
});
