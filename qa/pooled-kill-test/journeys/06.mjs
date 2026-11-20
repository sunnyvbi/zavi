import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";

await main({ n: "06", title: "wedding website", url: import.meta.url }, async (x) => {
  let rsvp;
  if (x.v2) {
    await x.v2step("aggregate.guests_attending_moves", async () => {
      const d = await x.aggregateDelta("admin", "guests_attending", { attending: true }, async () => { rsvp = await x.create("visitor", "rsvps", { attending: true, party_size: 3, meal: "fish" }); });
      must(d === 3, `guests moved by ${d}, want 3`);
    });
  } else rsvp = (await x.step("visitor.rsvps", async () => ({ id: await x.create("visitor", "rsvps", { attending: true, party_size: 3, meal: "fish" }) })))?.id;
  if (rsvp) {
    await x.step("admin.sees_rsvp", () => x.sees("admin", "rsvps", rsvp));
    await x.step("user.cannot_see_rsvps", () => x.hidden("a", "rsvps", rsvp));
  }
  await x.v2step("aggregate.user_refused", () => x.refused(() => x.aggregate("a", "guests_attending", { attending: true }), EXPECT.aggregateDenied));
  const entry = await x.step("visitor.signs_guestbook", async () => ({ id: await x.create("visitor", "guestbook", { message: "Congratulations!" }) }));
  if (entry) {
    await x.v2step("moderation.pending_hidden_from_visitor", () => x.hidden("visitor", "guestbook", entry.id));
    await x.v2step("moderation.pending_hidden_from_user", () => x.hidden("a", "guestbook", entry.id));
    await x.v2step("moderation.user_cannot_approve", () => x.refused(() => x.transition("a", "guestbook", entry.id, "approved"), EXPECT.transitionDenied));
    await x.v2step("moderation.admin_approves", () => x.transition("admin", "guestbook", entry.id, "approved"));
    await x.v2step("moderation.approved_visible_to_visitor", () => x.sees("visitor", "guestbook", entry.id));
    await x.v2step("moderation.hidden_again", async () => { await x.transition("admin", "guestbook", entry.id, "hidden"); return x.hidden("visitor", "guestbook", entry.id); });
  }
  await x.step("gallery.admin_uploads_visitor_sees", async () => {
    const name = await x.upload("admin", "gallery", "photo");
    const listed = await x.actors.visitor.z.storage.list("gallery");
    must(listed.some((f) => f.name === name), "visitor does not see the gallery photo");
  });
  await x.step("gallery.visitor_cannot_upload", () => x.refused(() => x.actors.visitor.z.storage.upload("gallery", new Blob(["x"], { type: "text/plain" }), { name: `kk-anon-${x.run}.txt` })));
});
