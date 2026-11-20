import { main, EXPECT } from "../lib/journey.mjs";

await main({ n: "16", title: "mosque website", url: import.meta.url }, async (x) => {
  const ev = await x.step("admin.adds_event", async () => ({ id: await x.create("admin", "events", { category: "youth" }) }));
  if (ev) await x.step("visitor.filters_events", () => x.sees("visitor", "events", ev.id, { listOpts: { filter: { category: "youth" }, order: "starts_at" } }));
  const dayVal = new Date(Date.UTC(2031 + Math.floor(Math.random() * 60), Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28))).toISOString().slice(0, 10);
  const pt = await x.step("admin.publishes_prayer_times", async () => ({ id: await x.create("admin", "prayer_times", { day: dayVal, fajr: "05:10", dhuhr: "12:30", asr: "15:45", maghrib: "18:20", isha: "19:40" }) }));
  if (pt) await x.step("visitor.reads_day", () => x.sees("visitor", "prayer_times", pt.id, { listOpts: { filter: { day: dayVal } } }));
  await x.v2step("unique.one_row_per_day", () => x.refused(() => x.create("admin", "prayer_times", { day: dayVal, fajr: "05:11", dhuhr: "12:31", asr: "15:46", maghrib: "18:21", isha: "19:41" }), EXPECT.unique));
  if (pt) await x.step("user.cannot_edit_prayer_times", () => x.refused(() => x.update("a", "prayer_times", pt.id, { fajr: "04:00" })));
  const msg = await x.step("visitor.sends_message", async () => ({ id: await x.create("visitor", "messages") }));
  if (msg) {
    await x.step("user.cannot_read_messages", () => x.hidden("a", "messages", msg.id));
    await x.v2step("admin.marks_handled", () => x.transition("admin", "messages", msg.id, "handled"));
  }
});
