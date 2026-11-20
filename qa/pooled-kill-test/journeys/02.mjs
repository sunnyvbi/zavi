import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";
import { randomUUID } from "node:crypto";

await main({ n: "02", title: "dog grooming booking", url: import.meta.url }, async (x) => {
  const svc = await x.step("admin.creates_service", async () => ({ id: await x.create("admin", "services") }));
  if (!svc) return;
  await x.step("visitor.sees_services", () => x.sees("visitor", "services", svc.id));
  const slot = x.values("bookings").slot_start;
  const bk = await x.step("visitor.books_slot", async () => ({ id: await x.create("visitor", "bookings", { service_id: svc.id, slot_start: slot }) }));
  if (!bk) return;
  await x.step("visitor.sees_taken_slot_without_customer", () => x.masked("visitor", "bookings", bk.id, ["customer_name", "phone", "email", "dog_name", "notes"]));
  await x.step("user.sees_taken_slot_without_customer", () => x.masked("a", "bookings", bk.id, ["customer_name", "phone"]));
  await x.step("admin.sees_customer", async () => { const r = await x.get("admin", "bookings", bk.id); must(typeof r?.data?.phone === "string", "admin cannot read the phone"); });
  await x.step("admin.lists_by_slot", () => x.sees("admin", "bookings", bk.id, { listOpts: { filter: { slot_start: slot } } }));
  await x.v2step("unique.second_booking_same_slot_refused", () => x.refused(() => x.create("visitor", "bookings", { service_id: svc.id, slot_start: slot }), EXPECT.unique));
  await x.v2step("reference.unknown_service_refused", () => x.refused(() => x.create("visitor", "bookings", { service_id: randomUUID() }), EXPECT.invalidRef));
  await x.v2step("state.initial_booked", async () => must((await x.stateOf("bookings", bk.id)) === "booked", "initial state is not booked"));
  await x.v2step("state.user_cannot_mark_done", () => x.refused(() => x.transition("a", "bookings", bk.id, "done"), EXPECT.transitionDenied));
  await x.v2step("state.generic_patch_cannot_change_status", () => x.refused(() => x.update("admin", "bookings", bk.id, { status: "done" }), EXPECT.serverOwned));
  await x.v2step("aggregate.done_count_moves", async () => {
    const d = await x.aggregateDelta("admin", "bookings_by_status", { status: "done" }, () => x.transition("admin", "bookings", bk.id, "done"));
    must(d === 1, `done count moved by ${d}`);
  });
  await x.v2step("state.illegal_transition_refused", () => x.refused(() => x.transition("admin", "bookings", bk.id, "booked"), EXPECT.transitionIllegal));
  await x.v2step("restrict.service_with_bookings_not_deletable", () => x.refused(() => (x.actors.admin.z.data.collection("services").delete(svc.id)), EXPECT.restrict));
});
