import { main } from "../lib/journey.mjs";

await main({ n: "14", title: "members recipe club", url: import.meta.url }, async (x) => {
  const r = await x.step("a.saves_favourite_recipe", async () => ({ id: await x.create("a", "recipes", { favourite: true, cuisine: "thai" }) }));
  if (!r) return;
  await x.step("owner.filters_favourites", () => x.sees("a", "recipes", r.id, { listOpts: { filter: { favourite: true } } }));
  await x.step("other_member.cannot_see", () => x.hidden("b", "recipes", r.id));
  await x.step("other_member.cannot_edit", () => x.refused(() => x.update("b", "recipes", r.id, { title: "mine now" })));
  await x.step("other_member.cannot_delete", () => x.refused(async () => (await x.actor("b")).z.data.collection("recipes").delete(r.id)));
  await x.step("visitor.cannot_save", () => x.refused(() => x.create("visitor", "recipes")));
  await x.step("photo.private", async () => { const name = await x.upload("a", "recipe_photos", "dish"); return x.fileHidden("b", "recipe_photos", name); });
});
