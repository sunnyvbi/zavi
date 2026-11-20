import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";
import { randomUUID } from "node:crypto";

await main({ n: "09", title: "movie posters and reviews", url: import.meta.url }, async (x) => {
  const title = `Kk Film ${x.run}`;
  const mv = await x.step("admin.adds_movie", async () => ({ id: await x.create("admin", "movies", { title, rating: 8.5 }) }));
  if (!mv) return;
  await x.step("visitor.title_prefix_search", () => x.sees("visitor", "movies", mv.id, { listOpts: { filter: { title: { prefix: `Kk Film ${x.run.slice(0, 3)}` } } } }));
  await x.step("visitor.sorted_by_rating", async () => { const p = await x.list("visitor", "movies", { order: "-rating" }); const r = p.items.map((i) => i.data.rating ?? 0); must(r.every((v, i) => i === 0 || r[i - 1] >= v), `not sorted: ${r}`); });
  await x.step("user.cannot_add_movie", () => x.refused(() => x.create("a", "movies")));
  await x.step("poster.public", async () => { const name = await x.upload("admin", "posters", "poster"); const l = await x.actors.visitor.z.storage.list("posters"); must(l.some((f) => f.name === name), "visitor cannot list posters"); });
  const rv = await x.step("a.reviews", async () => ({ id: await x.create("a", "reviews", { movie_id: mv.id, stars: 4 }) }));
  if (rv) {
    await x.step("visitor.reads_review", () => x.sees("visitor", "reviews", rv.id, { listOpts: { filter: { movie_id: mv.id } } }));
    await x.step("b.cannot_edit_review", () => x.refused(() => x.update("b", "reviews", rv.id, { stars: 1 })));
    await x.step("visitor.cannot_review", () => x.refused(() => x.create("visitor", "reviews", { movie_id: mv.id, stars: 5 })));
  }
  await x.v2step("reference.unknown_movie_refused", () => x.refused(() => x.create("a", "reviews", { movie_id: randomUUID(), stars: 3 }), EXPECT.invalidRef));
  await x.v2step("aggregate.avg_stars", async () => { await x.create("b", "reviews", { movie_id: mv.id, stars: 2 }); const v = await x.aggregate("admin", "avg_stars", { movie_id: mv.id }); must(Math.abs(v - 3) < 1e-9, `avg ${v}, want 3`); });
  await x.v2step("aggregate.public_refused", () => x.refused(() => x.aggregate("a", "avg_stars", { movie_id: mv.id }), EXPECT.aggregateDenied));
  await x.v2step("cascade.delete_movie_removes_reviews", async () => {
    await x.actors.admin.z.data.collection("movies").delete(mv.id);
    const reviews = x.created.filter((r) => r.coll === "reviews").map((r) => r.id);
    for (const id of reviews) must((await x.get("admin", "reviews", id)) === null, `review ${id} survived its movie`);
    x.gone(mv.id, ...reviews);
  });
});
