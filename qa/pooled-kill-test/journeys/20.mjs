import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";

await main({ n: "20", title: "barbershop booking", url: import.meta.url }, async (x) => {
  const b1 = await x.step("admin.adds_barbers_and_service", async () => {
    const one = await x.create("admin", "barbers");
    const two = await x.create("admin", "barbers");
    await x.create("admin", "services", { name: "cut_beard", price_cents: 3500, minutes: 45 });
    return { id: one, two };
  });
  if (!b1) return;
  const slot = x.values("appointments").slot_start;
  const ap = await x.step("visitor.books", async () => ({ id: await x.create("visitor", "appointments", { barber_id: b1.id, slot_start: slot }) }));
  if (!ap) return;
  await x.step("visitor.sees_slot_taken_without_customer", () => x.masked("visitor", "appointments", ap.id, ["customer_name", "phone"]));
  await x.step("admin.sees_customer", async () => { const r = await x.get("admin", "appointments", ap.id); must(typeof r?.data?.phone === "string", "admin cannot read phone"); });
  await x.v2step("unique.same_barber_same_slot_refused", () => x.refused(() => x.create("visitor", "appointments", { barber_id: b1.id, slot_start: slot }), EXPECT.unique));
  await x.v2step("unique.other_barber_same_slot_ok", () => x.create("visitor", "appointments", { barber_id: b1.two, slot_start: slot }));
  await x.step("owner.day_view_in_order", async () => {
    const dayStart = slot.slice(0, 10) + "T00:00:00Z";
    const dayEnd = slot.slice(0, 10) + "T23:59:59Z";
    const p = await x.list("admin", "appointments", { filter: { slot_start: { gte: dayStart, lte: dayEnd } }, order: "slot_start" });
    const t = p.items.map((i) => i.data.slot_start);
    must(p.items.some((i) => i.id === ap.id) && t.every((v, i) => i === 0 || t[i - 1] <= v), `day view: ${t}`);
  });
  await x.v2step("visitor.cannot_mark_done", () => x.refused(() => x.transition("visitor", "appointments", ap.id, "done"), EXPECT.transitionDenied));
  await x.v2step("aggregate.no_show_moves", async () => {
    const dd = await x.aggregateDelta("admin", "appointments_by_status", { barber_id: b1.id, status: "no_show" }, () => x.transition("admin", "appointments", ap.id, "no_show"));
    must(dd === 1, `no_show moved by ${dd}`);
  });
  await x.v2step("state.no_show_is_final", () => x.refused(() => x.transition("admin", "appointments", ap.id, "done"), EXPECT.transitionIllegal));
});
