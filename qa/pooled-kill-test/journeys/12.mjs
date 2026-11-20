import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";

await main({ n: "12", title: "runners members club", url: import.meta.url }, async (x) => {
  const runId = await x.step("admin.adds_run", async () => ({ id: await x.create("admin", "runs") }));
  if (!runId) return;
  await x.step("member.sees_upcoming_runs", () => x.sees("a", "runs", runId.id, { listOpts: { order: "starts_at" } }));
  await x.step("visitor.cannot_see_runs", () => x.hidden("visitor", "runs", runId.id));
  await x.step("member.cannot_add_run", () => x.refused(() => x.create("a", "runs")));
  const rsvp = await x.step("a.rsvps", async () => ({ id: await x.create("a", "rsvps", { run_id: runId.id, going: true }) }));
  if (rsvp) {
    await x.step("b.sees_who_is_going", () => x.sees("b", "rsvps", rsvp.id, { listOpts: { filter: { run_id: runId.id } } }));
    await x.step("b.cannot_change_a_rsvp", () => x.refused(() => x.update("b", "rsvps", rsvp.id, { going: false })));
  }
  if (!x.v2) { x.rep.skip("v2.organisers", "pending K3: roles, aggregates, references"); return; }
  await x.step("admin.makes_b_organiser", () => x.grantRole("b", "organiser"));
  const r2 = await x.step("organiser.adds_run", async () => ({ id: await x.create("b", "runs") }));
  if (r2) await x.step("organiser.edits_run", () => x.update("b", "runs", r2.id, { notes: "bring water" }));
  await x.step("organiser.edits_admin_run", () => x.update("b", "runs", runId.id, { notes: "moved" }));
  await x.step("plain_member.cannot_edit_run", () => x.refused(() => x.update("c", "runs", runId.id, { notes: "x" })));
  await x.step("aggregate.organiser_head_count", async () => { const v = await x.aggregate("b", "going_count", { run_id: runId.id, going: true }); must(v === 1, `going ${v}`); });
  await x.step("aggregate.plain_member_refused", () => x.refused(() => x.aggregate("c", "going_count", { run_id: runId.id, going: true }), EXPECT.aggregateDenied));
  await x.step("cascade.delete_run_removes_rsvps", async () => { await x.actors.admin.z.data.collection("runs").delete(runId.id); if (rsvp) must((await x.get("admin", "rsvps", rsvp.id)) === null, "rsvp survived its run"); x.gone(runId.id, ...(rsvp ? [rsvp.id] : [])); });
  await x.step("admin.revokes_organiser", async () => { await x.revokeRole("b"); return x.refused(() => x.create("b", "runs")); });
});
