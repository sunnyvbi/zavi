import { main, EXPECT } from "../lib/journey.mjs";
import { must } from "../lib/kit.mjs";
import { randomUUID } from "node:crypto";

await main({ n: "01", title: "group puzzle game", url: import.meta.url }, async (x) => {
  const puzzle = await x.step("admin.creates_puzzle", () => x.create("admin", "puzzles", { answer: "secret-answer" }).then((id) => ({ detail: id, id })));
  if (!puzzle) return;
  await x.step("visitor.sees_puzzle_without_answer", () => x.masked("visitor", "puzzles", puzzle.id, ["answer"]));
  await x.step("user.sees_puzzle_without_answer", () => x.masked("a", "puzzles", puzzle.id, ["answer"]));
  await x.step("admin.sees_answer", async () => { const r = await x.get("admin", "puzzles", puzzle.id); must(r?.data?.answer === "secret-answer", "admin cannot read the answer"); });

  const group = await x.step("a.creates_group", async () => ({ id: await x.create("a", "groups", { mode: "offline", offline_players: ["Ann", "Bo"] }) }));
  if (!group) return;
  await x.step("a.lists_own_group", () => x.sees("a", "groups", group.id));
  await x.step("b.opens_group_by_share_link", () => x.sees("b", "groups", group.id, { inList: false }));
  await x.step("b.does_not_list_others_groups", async () => { const p = await x.list("b", "groups"); must(!p.items.some((r) => r.id === group.id), "b lists a's group"); });
  await x.step("b.cannot_rename_group", () => x.refused(() => x.update("b", "groups", group.id, { name: "hijacked" })));

  const playA = await x.step("a.records_play", async () => ({ id: await x.create("a", "plays", { group_id: group.id, puzzle_id: puzzle.id, player_name: "Ann", score: 40 }) }));
  const playB = await x.step("b.records_play", async () => ({ id: await x.create("b", "plays", { group_id: group.id, puzzle_id: puzzle.id, player_name: "Bo", score: 70 }) }));
  if (playA && playB) {
    await x.step("a.sees_group_scoreboard", async () => {
      const p = await x.list("a", "plays", { filter: { group_id: group.id }, order: "-score" });
      must(p.items.length >= 2 && p.items[0].id === playB.id, `scoreboard order: ${p.items.map((r) => r.data.score).join(",")}`);
    });
    await x.step("b.cannot_edit_a_score", () => x.refused(() => x.update("b", "plays", playA.id, { score: 0 })));
  }
  await x.v2step("unique.same_player_same_puzzle_refused", () => x.refused(() => x.create("a", "plays", { group_id: group.id, puzzle_id: puzzle.id, player_name: "Ann", score: 1 }), EXPECT.unique));
  await x.v2step("reference.unknown_group_refused", () => x.refused(() => x.create("a", "plays", { group_id: randomUUID(), player_name: "Zed", score: 1 }), EXPECT.invalidRef));
  await x.v2step("aggregate.plays_in_group", async () => { const v = await x.aggregate("admin", "plays_in_group", { group_id: group.id }); must(v === 2, `count ${v}, want 2`); });
  await x.v2step("aggregate.user_refused", () => x.refused(() => x.aggregate("a", "plays_in_group", { group_id: group.id }), EXPECT.aggregateDenied));
  await x.v2step("cascade.delete_group_removes_plays", async () => {
    await (await x.actor("a")).z.data.collection("groups").delete(group.id);
    for (const p of [playA, playB].filter(Boolean)) must((await x.get("admin", "plays", p.id)) === null, `play ${p.id} survived its group`);
    x.gone(group.id, ...[playA, playB].filter(Boolean).map((p) => p.id));
  });
});
