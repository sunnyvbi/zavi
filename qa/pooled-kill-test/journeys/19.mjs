import { main, EXPECT } from "../lib/journey.mjs";
import { randomUUID } from "node:crypto";

await main({ n: "19", title: "home baker cake marketplace", url: import.meta.url }, async (x) => {
  const city = `Kk${x.run}`;
  const cake = await x.step("baker_a.lists_cake", async () => ({ id: await x.create("a", "cakes", { city, occasion: "wedding" }) }));
  if (!cake) return;
  await x.step("buyer.filters_city_occasion", () => x.sees("visitor", "cakes", cake.id, { listOpts: { filter: { city, occasion: "wedding" } } }));
  await x.step("photo.public", async () => { const name = await x.upload("a", "cake_photos", "cake"); const l = await x.actors.visitor.z.storage.list("cake_photos"); if (!l.some((f) => f.name === name)) throw new Error("visitor cannot list cake photos"); });
  await x.step("other_baker.cannot_edit_cake", () => x.refused(() => x.update("c", "cakes", cake.id, { price_cents: 1 })));
  const req = await x.step("buyer_b.sends_order_request", async () => ({ id: await x.create("b", "order_requests", { cake_id: cake.id }) }));
  if (!req) return;
  await x.step("buyer.sees_own_request", () => x.sees("b", "order_requests", req.id));
  await x.v2step("recipient.baker_sees_request", () => x.sees("a", "order_requests", req.id));
  await x.step("other_baker.cannot_see_request", () => x.hidden("c", "order_requests", req.id));
  await x.step("visitor.cannot_see_request", () => x.hidden("visitor", "order_requests", req.id));
  await x.v2step("buyer.cannot_accept_own_request", () => x.refused(() => x.transition("b", "order_requests", req.id, "accepted"), EXPECT.transitionDenied));
  await x.v2step("other_baker.cannot_accept", () => x.refused(() => x.transition("c", "order_requests", req.id, "accepted"), EXPECT.transitionDenied));
  await x.v2step("recipient.baker_accepts", () => x.transition("a", "order_requests", req.id, "accepted"));
  await x.v2step("accepted.cannot_be_cancelled", () => x.refused(() => x.transition("b", "order_requests", req.id, "cancelled"), EXPECT.transitionIllegal));
  await x.v2step("buyer.cancels_pending_request", async () => { const id = await x.create("b", "order_requests", { cake_id: cake.id }); return x.transition("b", "order_requests", id, "cancelled"); });
  await x.v2step("raw_recipient_id_refused", async () => x.refused(async () => x.create("b", "order_requests", { cake_id: cake.id, recipient_id: await x.userId("c") }), EXPECT.rawField));
  await x.v2step("reference.unknown_cake_refused", () => x.refused(() => x.create("b", "order_requests", { cake_id: randomUUID() }), EXPECT.invalidRef));
  await x.v2step("buyer.edits_message", () => x.update("b", "order_requests", req.id, { message: "two tiers please" }));
  await x.v2step("reference.source_immutable", async () => {
    const other = await x.create("c", "cakes", { city });
    return x.refused(() => x.update("b", "order_requests", req.id, { cake_id: other }), [...EXPECT.serverOwned, "invalid_reference"]);
  });
  await x.v2step("restrict.cake_with_orders_not_deletable", () => x.refused(async () => (await x.actor("a")).z.data.collection("cakes").delete(cake.id), EXPECT.restrict));
});
