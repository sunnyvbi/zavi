import { main, EXPECT } from "../lib/journey.mjs";

await main({ n: "10", title: "house rental", url: import.meta.url }, async (x) => {
  let owner = "admin";
  if (x.v2) {
    await x.step("admin.grants_landlord_to_a", () => x.grantRole("a", "landlord"));
    await x.step("non_landlord.cannot_list", () => x.refused(() => x.create("b", "listings"), EXPECT.hidden));
    owner = "a";
  }
  const home = await x.step(`${owner}.lists_home`, async () => ({ id: await x.create(owner, "listings", { bedrooms: 2, monthly_rent_cents: 150000 }) }));
  if (!home) return;
  await x.step("visitor.filters_homes", () => x.sees("visitor", "listings", home.id, { listOpts: { filter: { bedrooms: { gte: 2 } }, order: "monthly_rent_cents" } }));
  const inq = await x.step("visitor.inquires", async () => ({ id: await x.create("visitor", "inquiries", { listing_id: home.id }) }));
  if (inq) {
    await x.v2step("recipient.landlord_sees_inquiry", () => x.sees("a", "inquiries", inq.id));
    await x.step("other_user.cannot_see_inquiry", () => x.hidden("b", "inquiries", inq.id));
    await x.step("admin.sees_inquiry", () => x.sees("admin", "inquiries", inq.id));
  }
  await x.v2step("owner.withdraws_listing", () => x.transition("a", "listings", home.id, "withdrawn"));
  await x.v2step("withdrawn.hidden_from_visitor", () => x.hidden("visitor", "listings", home.id));
  await x.v2step("withdrawn.no_new_inquiries", () => x.refused(() => x.create("visitor", "inquiries", { listing_id: home.id }), EXPECT.invalidRef));
  await x.v2step("other_user.cannot_reopen", () => x.refused(() => x.transition("b", "listings", home.id, "available"), EXPECT.transitionDenied));
  await x.v2step("admin.revokes_landlord", async () => { await x.revokeRole("a"); return x.refused(() => x.create("a", "listings"), EXPECT.hidden); });
});
