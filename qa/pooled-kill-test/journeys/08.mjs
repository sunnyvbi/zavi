import { main, EXPECT } from "../lib/journey.mjs";

await main({ n: "08", title: "photo studio", url: import.meta.url }, async (x) => {
  const inq = await x.step("visitor.sends_inquiry", async () => ({ id: await x.create("visitor", "inquiries", { service: "portrait", preferred_date: "2030-01-15" }) }));
  if (inq) {
    await x.step("admin.sees_inquiry_by_date", () => x.sees("admin", "inquiries", inq.id, { listOpts: { order: "preferred_date" } }));
    await x.step("user.cannot_see_inquiry", () => x.hidden("a", "inquiries", inq.id));
    await x.v2step("state.user_cannot_reply", () => x.refused(() => x.transition("a", "inquiries", inq.id, "replied"), EXPECT.transitionDenied));
    await x.v2step("state.replied_booked_closed", async () => { await x.transition("admin", "inquiries", inq.id, "replied"); await x.transition("admin", "inquiries", inq.id, "booked"); await x.transition("admin", "inquiries", inq.id, "closed"); });
    await x.v2step("state.skip_refused", async () => { const id = await x.create("visitor", "inquiries", { service: "event" }); return x.refused(() => x.transition("admin", "inquiries", id, "booked"), EXPECT.transitionIllegal); });
  }
  await x.step("portfolio.public", async () => { const name = await x.upload("admin", "portfolio", "shot"); const l = await x.actors.visitor.z.storage.list("portfolio"); if (!l.some((f) => f.name === name)) throw new Error("visitor cannot list the portfolio"); });
  await x.step("portfolio.user_cannot_upload", () => x.refused(async () => (await x.actor("a")).z.storage.upload("portfolio", new Blob(["x"], { type: "text/plain" }), { name: `kk-u-${x.run}.txt` })));
});
