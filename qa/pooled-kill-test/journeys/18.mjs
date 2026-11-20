import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";
import { randomUUID } from "node:crypto";

const d = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

await main({ n: "18", title: "freelancer invoice tracker", url: import.meta.url }, async (x) => {
  const client = await x.step("admin.adds_client", async () => ({ id: await x.create("admin", "clients") }));
  if (!client) return;
  await x.step("user.cannot_see_clients", () => x.hidden("a", "clients", client.id));
  const num = `KK-${x.run}`;
  const amount = 12345;
  let inv;
  const create = async () => { inv = await x.create("admin", "invoices", { client_id: client.id, number: num, amount_cents: amount, issue_date: d(-40), due_date: d(-10) }); };
  if (x.v2) {
    await x.step("aggregate.outstanding_moves", async () => {
      const delta = await x.aggregateDelta("admin", "total_outstanding", { status: "unpaid" }, create);
      must(delta === amount, `outstanding moved ${delta} (want ${amount})`);
    });
  } else await x.step("admin.logs_invoice", create);
  if (!inv) return;
  await x.step("dashboard.overdue_list_sorted_by_lateness", async () => {
    const p = await x.list("admin", "invoices", { filter: { due_date: { lt: d(0) } }, order: "due_date" });
    const ds = p.items.map((i) => i.data.due_date);
    must(ds.includes(d(-10)) && ds.every((v, i) => i === 0 || ds[i - 1] <= v), `due dates ${ds}`);
  });
  await x.step("user.cannot_see_invoices", () => x.hidden("a", "invoices", inv));
  await x.v2step("unique.invoice_number", () => x.refused(() => x.create("admin", "invoices", { client_id: client.id, number: num }), EXPECT.unique));
  await x.v2step("reference.unknown_client_refused", () => x.refused(() => x.create("admin", "invoices", { client_id: randomUUID(), number: `KK-x-${x.run}` }), EXPECT.invalidRef));
  await x.v2step("restrict.client_with_invoices_not_deletable", () => x.refused(() => x.actors.admin.z.data.collection("clients").delete(client.id), EXPECT.restrict));
  await x.v2step("mark_paid.moves_paid_this_month", async () => {
    const month = d(0).slice(0, 7);
    const delta = await x.aggregateDelta("admin", "paid_in_month", { status: "paid", paid_month: month }, async () => {
      await x.update("admin", "invoices", inv, { paid_on: d(0), paid_month: month });
      await x.transition("admin", "invoices", inv, "paid");
    });
    must(delta === amount, `paid this month moved by ${delta}`);
  });
  await x.v2step("aggregate.user_refused", () => x.refused(() => x.aggregate("a", "total_outstanding", { status: "unpaid" }), EXPECT.aggregateDenied));
});
