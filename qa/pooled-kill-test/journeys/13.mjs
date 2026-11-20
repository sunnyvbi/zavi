import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";

await main({ n: "13", title: "blood donation slots", url: import.meta.url }, async (x) => {
  const donor = await x.step("a.creates_donor_profile", async () => ({ id: await x.create("a", "donors", { blood_group: "o_neg" }) }));
  if (donor) {
    await x.step("donor.owner_sees", () => x.sees("a", "donors", donor.id));
    await x.step("donor.other_user_hidden", () => x.hidden("b", "donors", donor.id));
  }
  const vals = x.values("slots", { capacity: 1 });
  const slot = await x.step("admin.opens_slot_capacity_1", async () => ({ id: await x.create("admin", "slots", vals) }));
  if (!slot) return;
  await x.step("visitor.sees_slots", () => x.sees("visitor", "slots", slot.id, { listOpts: { order: "starts_at" } }));
  if (!x.v2) { x.rep.skip("v2.book_action", "pending K3: actions, unique"); return; }
  await x.step("unique.same_centre_and_time_refused", () => x.refused(() => x.create("admin", "slots", { centre: vals.centre, starts_at: vals.starts_at, capacity: 3 }), EXPECT.unique));
  await x.step("appointments.generic_create_refused", () => x.refused(() => x.create("a", "appointments", { slot_id: slot.id })));
  const ap = await x.step("a.books_replayed_once", async () => { const r = await x.action("a", "book_slot", { targetId: slot.id, data: { blood_group: "o_neg" } }); return { detail: r.createdId, id: r.createdId }; });
  if (!ap) return;
  await x.step("counter.booked_1", async () => must((await x.counter("slots", slot.id, "booked_count")) === 1, "booked_count is not 1"));
  await x.step("bound.full_slot_refused", () => x.refused(() => x.action("b", "book_slot", { targetId: slot.id, data: { blood_group: "a_pos" } }, { replay: false }), EXPECT.bound));
  await x.step("appointment.owner_sees", () => x.sees("a", "appointments", ap.id));
  await x.step("appointment.other_user_hidden", () => x.hidden("b", "appointments", ap.id));
  await x.step("appointment.owner_cannot_mark_donated", () => x.refused(() => x.transition("a", "appointments", ap.id, "donated"), EXPECT.transitionDenied));
  await x.step("a.cancels_inverse_replayed_once", () => x.action("a", "cancel_appointment", { recordId: ap.id }));
  await x.step("counter.freed", async () => must((await x.counter("slots", slot.id, "booked_count")) === 0, "booked_count not back to 0"));
  await x.step("b.books_freed_slot", async () => { const r = await x.action("b", "book_slot", { targetId: slot.id, data: { blood_group: "a_pos" } }, { replay: false }); must(r.createdId, "no appointment"); });
  await x.step("aggregate.cancelled_count", async () => { const v = await x.aggregate("admin", "appointments_by_status", { slot_id: slot.id, status: "cancelled" }); must(v === 1, `cancelled ${v}`); });
  await x.step("restrict.slot_with_appointments_not_deletable", () => x.refused(() => x.actors.admin.z.data.collection("slots").delete(slot.id), EXPECT.restrict));
});
