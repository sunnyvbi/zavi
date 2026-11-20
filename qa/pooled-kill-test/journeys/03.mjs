import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";

await main({ n: "03", title: "equestrian early access", url: import.meta.url }, async (x) => {
  let id;
  await x.v2step("aggregate.signup_counts", async () => {
    const d = await x.aggregateDelta("admin", "signups", {}, async () => { id = await x.create("visitor", "early_access", { looking_for: ["riding_partner", "friendship"], horses: 2 }); });
    must(d === 1, `signups moved by ${d}`);
  });
  if (!id) id = (await x.step("visitor.signs_up", async () => ({ id: await x.create("visitor", "early_access", { looking_for: ["riding_partner", "friendship"], horses: 2 }) })))?.id;
  if (!id) return;
  await x.step("admin.sees_signup_with_choices", async () => { const r = await x.sees("admin", "early_access", id); must(r.data.looking_for.length === 2, "choices lost"); });
  await x.step("user.cannot_see_signup", () => x.hidden("a", "early_access", id));
  await x.v2step("aggregate.user_refused", () => x.refused(() => x.aggregate("a", "signups"), EXPECT.aggregateDenied));
  await x.step("bad_choice_refused", () => x.refused(() => x.create("visitor", "early_access", { looking_for: ["not_a_tile"] }), ["validation", "schema_violation"]));
});
