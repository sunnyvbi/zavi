import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";

await main({ n: "11", title: "shoe rental", url: import.meta.url }, async (x) => {
  const shoe = await x.step("admin.adds_shoe_stock_1", async () => ({ id: await x.create("admin", "shoes", { in_stock: 1, size: 10 }) }));
  if (!shoe) return;
  await x.step("visitor.filters_by_size", () => x.sees("visitor", "shoes", shoe.id, { listOpts: { filter: { size: 10 } } }));
  if (!x.v2) { x.rep.skip("v2.rent_action", "pending K3: actions"); return; }
  await x.step("counter.server_initialized", async () => must((await x.counter("shoes", shoe.id, "rented_count")) === 0, "rented_count is not 0"));
  await x.step("counter.immutable_outside_actions", () => x.refused(() => x.update("admin", "shoes", shoe.id, { rented_count: 1 }), EXPECT.serverOwned));
  await x.step("rentals.generic_create_refused", () => x.refused(() => x.create("a", "rentals", { shoe_id: shoe.id })));
  await x.step("visitor.cannot_rent", () => x.refused(() => x.actors.visitor.z.actions.run("rent_shoe", { targetId: shoe.id, data: x.values("rentals") }, { idempotencyKey: `kk-anon-${x.run}-0000000` }), EXPECT.actionDenied));
  const rent = await x.step("a.rents_replayed_once", async () => { const r = await x.action("a", "rent_shoe", { targetId: shoe.id, data: x.values("rentals") }); return { detail: r.createdId, id: r.createdId }; });
  if (!rent) return;
  await x.step("counter.is_1_after_replay", async () => must((await x.counter("shoes", shoe.id, "rented_count")) === 1, "counter is not 1 (replay applied twice?)"));
  await x.step("bound.b_refused_when_out_of_stock", () => x.refused(() => x.action("b", "rent_shoe", { targetId: shoe.id, data: x.values("rentals") }, { replay: false }), EXPECT.bound));
  await x.step("rental.owner_sees", () => x.sees("a", "rentals", rent.id));
  await x.step("rental.other_user_hidden", () => x.hidden("b", "rentals", rent.id));
  await x.step("rental.other_user_cannot_release", () => x.refused(() => x.action("b", "release_shoe", { recordId: rent.id }, { replay: false }), [...EXPECT.actionDenied, "not_found"]));
  const rel = await x.step("a.releases_replayed_once", () => x.action("a", "release_shoe", { recordId: rent.id }));
  if (rel) {
    await x.step("counter.back_to_0", async () => must((await x.counter("shoes", shoe.id, "rented_count")) === 0, "counter did not return to 0"));
    await x.step("rental.closed", async () => must((await x.stateOf("rentals", rent.id)) === "closed", "rental not closed"));
    await x.step("inverse.runs_once", () => x.refused(() => x.action("a", "release_shoe", { recordId: rent.id }, { replay: false }), EXPECT.transitionIllegal));
  }
  await x.step("bound.concurrent_rents_never_exceed_stock", async () => {
    const id = await x.create("admin", "shoes", { in_stock: 2 });
    const res = await Promise.allSettled(["a", "b", "c"].map((w) => x.action(w, "rent_shoe", { targetId: id, data: x.values("rentals") }, { replay: false })));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    const bound = res.filter((r) => r.status === "rejected" && r.reason?.reason === "action_bound").length;
    must(ok === 2 && bound === 1, `3 concurrent rents on stock 2: ${ok} ok, ${bound} action_bound (${res.map((r) => r.reason?.reason ?? "ok").join(",")})`);
    must((await x.counter("shoes", id, "rented_count")) === 2, "counter is not 2");
  });
  await x.step("aggregate.open_rentals", async () => { const v = await x.aggregate("admin", "open_rentals", { shoe_id: shoe.id, status: "closed" }); must(v === 1, `closed rentals ${v}`); });
});
