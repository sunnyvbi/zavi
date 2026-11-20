import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";
import { randomUUID } from "node:crypto";

await main({ n: "04", title: "healthcare professional network", url: import.meta.url }, async (x) => {
  const pa = await x.step("a.creates_profile", async () => ({ id: await x.create("a", "profiles", { profession: "doctor", city: "Lagos" }) }));
  const pb = await x.step("b.creates_profile", async () => ({ id: await x.create("b", "profiles", { profession: "hospital" }) }));
  if (!pa || !pb) return;
  await x.step("signed_in.directory", () => x.sees("b", "profiles", pa.id, { listOpts: { filter: { profession: "doctor" } } }));
  await x.step("visitor.no_directory", () => x.hidden("visitor", "profiles", pa.id));
  await x.step("a.cannot_self_verify", () => x.refused(() => x.update("a", "profiles", pa.id, { verified: true }), ["not_allowed", "field_not_writable", "forbidden"]));
  await x.step("admin.verifies", async () => { await x.update("admin", "profiles", pa.id, { verified: true }); const r = await x.get("b", "profiles", pa.id); must(r.data.verified === true, "verified flag not visible"); });

  if (!x.v2) { x.rep.skip("v2.recruiter_flows", "pending K3: roles, recipient, states"); return; }
  await x.step("admin.grants_recruiter_to_b", () => x.grantRole("b", "recruiter"));
  await x.step("non_recruiter.cannot_post_job", () => x.refused(() => x.create("a", "jobs"), EXPECT.hidden));
  const job = await x.step("recruiter.posts_job", async () => ({ id: await x.create("b", "jobs") }));
  if (!job) return;
  await x.step("visitor.sees_open_job", () => x.sees("visitor", "jobs", job.id));
  const app = await x.step("a.applies", async () => ({ id: await x.create("a", "applications", { job_id: job.id, cover_note: "hello", cv_text: "cv" }) }));
  if (app) {
    await x.step("recipient.recruiter_sees_application", () => x.sees("b", "applications", app.id));
    await x.step("other_user.cannot_see_application", () => x.hidden("c", "applications", app.id));
    await x.step("visitor.cannot_see_application", () => x.hidden("visitor", "applications", app.id));
    await x.step("owner.cannot_shortlist_self", () => x.refused(() => x.transition("a", "applications", app.id, "shortlisted"), EXPECT.transitionDenied));
    await x.step("other_user.cannot_shortlist", () => x.refused(() => x.transition("c", "applications", app.id, "shortlisted"), EXPECT.transitionDenied));
    await x.step("recipient.shortlists", () => x.transition("b", "applications", app.id, "shortlisted"));
    await x.step("owner.cannot_withdraw_after_shortlist", () => x.refused(() => x.transition("a", "applications", app.id, "withdrawn"), EXPECT.transitionIllegal));
    await x.step("aggregate.applications_per_job", async () => { const v = await x.aggregate("admin", "applications_per_job", { job_id: job.id }); must(v === 1, `count ${v}`); });
    await x.step("aggregate.recruiter_refused", () => x.refused(() => x.aggregate("b", "applications_per_job", { job_id: job.id }), EXPECT.aggregateDenied));
  }
  await x.step("raw_recipient_id_refused", async () => x.refused(async () => x.create("a", "applications", { job_id: job.id, recipient_id: await x.userId("c") }), EXPECT.rawField));
  await x.step("reference.unknown_job_refused", () => x.refused(() => x.create("a", "applications", { job_id: randomUUID() }), EXPECT.invalidRef));

  const conn = await x.step("a.requests_connection_to_b", async () => ({ id: await x.create("a", "connections", { profile_id: pb.id, note: "hi" }) }));
  if (conn) {
    await x.step("recipient.sees_connection_request", () => x.sees("b", "connections", conn.id));
    await x.step("third_party.cannot_see_connection", () => x.hidden("c", "connections", conn.id));
    await x.step("sender.cannot_accept_own_request", () => x.refused(() => x.transition("a", "connections", conn.id, "accepted"), EXPECT.transitionDenied));
    await x.step("recipient.accepts", () => x.transition("b", "connections", conn.id, "accepted"));
  }
  const msg = await x.step("a.messages_b", async () => ({ id: await x.create("a", "messages", { profile_id: pb.id, body: "can we talk?" }) }));
  if (msg) {
    await x.step("recipient.reads_message", () => x.sees("b", "messages", msg.id));
    await x.step("third_party.cannot_read_message", () => x.hidden("c", "messages", msg.id));
    await x.step("recipient.cannot_edit_message", () => x.refused(() => x.update("b", "messages", msg.id, { body: "edited" })));
  }
  await x.step("recruiter.closes_job", () => x.transition("b", "jobs", job.id, "closed"));
  await x.step("closed_job.hidden_from_visitor", () => x.hidden("visitor", "jobs", job.id));
  await x.step("closed_job.cannot_be_applied_to", () => x.refused(() => x.create("c", "applications", { job_id: job.id }), EXPECT.invalidRef));
  await x.step("files.cv_private", async () => { const name = await x.upload("a", "cvs", "cv"); return x.fileHidden("b", "cvs", name); });
  await x.step("admin.revokes_recruiter", async () => { await x.revokeRole("b"); return x.refused(() => x.create("b", "jobs"), EXPECT.hidden); });
});
