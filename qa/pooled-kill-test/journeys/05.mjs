import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";

await main({ n: "05", title: "bakery with cake orders", url: import.meta.url }, async (x) => {
  const item = await x.step("admin.adds_menu_item", async () => ({ id: await x.create("admin", "menu_items", { category: "cakes", available: true }) }));
  if (item) await x.step("visitor.filters_menu", () => x.sees("visitor", "menu_items", item.id, { listOpts: { filter: { category: "cakes" } } }));
  const order = await x.step("visitor.orders_cake", async () => ({ id: await x.create("visitor", "cake_orders", { message_on_cake: "Happy 30th" }) }));
  if (!order) return;
  await x.step("user.cannot_see_order", () => x.hidden("a", "cake_orders", order.id));
  await x.step("admin.sees_order", () => x.sees("admin", "cake_orders", order.id));
  await x.v2step("state.visitor_cannot_confirm", () => x.refused(() => x.transition("visitor", "cake_orders", order.id, "confirmed"), EXPECT.transitionDenied));
  await x.v2step("aggregate.confirm_moves_counts", async () => {
    const d = await x.aggregateDelta("admin", "orders_by_status", { status: "confirmed" }, () => x.transition("admin", "cake_orders", order.id, "confirmed"));
    must(d === 1, `confirmed moved by ${d}`);
  });
  await x.v2step("state.ready_then_collected", async () => { await x.transition("admin", "cake_orders", order.id, "ready"); await x.transition("admin", "cake_orders", order.id, "collected"); must((await x.stateOf("cake_orders", order.id)) === "collected", "not collected"); });
  await x.v2step("state.collected_is_final", () => x.refused(() => x.transition("admin", "cake_orders", order.id, "new"), EXPECT.transitionIllegal));
});
