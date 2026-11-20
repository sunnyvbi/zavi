import { describe, it, expect } from "vitest";
import {
  guardMongoFind,
  guardMongoAggregate,
  guardMongoCount,
  stripHiddenDeep,
  effectivePolicy,
  type CatalogLike,
} from "@zavi/shared/db-guard";

const catalog: CatalogLike = {
  tables: [
    { name: "users", columns: [{ name: "_id" }, { name: "email" }, { name: "city" }, { name: "createdAt" }] },
    { name: "bookings", columns: [{ name: "_id" }, { name: "userId" }, { name: "city" }, { name: "total" }] },
    { name: "audit", columns: [{ name: "_id" }] },
  ],
};
const policy = effectivePolicy(
  { auto_hide: false, hidden_fields: ["users.email"], unhidden_fields: [], disabled_tables: ["audit"] },
  catalog,
  "mongodb",
);
const g = { policy };
const reason = (r: { ok: boolean } & Record<string, unknown>) => {
  expect(r.ok).toBe(false);
  return String((r as { reason?: string }).reason ?? "");
};

describe("Mongo guard must-catch", () => {
  it("wireframe refused query: projection includes email", () => {
    expect(reason(guardMongoFind("users", { createdAt: { $gte: "2026-01-01" } }, { projection: { email: 1, city: 1 } }, g))).toMatch(
      /users\.email is hidden/,
    );
  });
  it("filter on hidden (incl. inside $or / $elemMatch)", () => {
    expect(reason(guardMongoFind("users", { email: /@x/ }, {}, g))).toMatch(/hidden/);
    expect(reason(guardMongoFind("users", { $or: [{ city: "LA" }, { email: { $exists: true } }] }, {}, g))).toMatch(/hidden/);
    expect(reason(guardMongoCount("users", { tags: { $elemMatch: { email: "a" } } }, g))).toMatch(/hidden/);
  });
  it("sort on hidden", () => {
    expect(reason(guardMongoFind("users", {}, { sort: { email: 1 } }, g))).toMatch(/hidden/);
  });
  it("$project reference", () => {
    expect(reason(guardMongoAggregate("users", [{ $project: { e: "$email" } }], g))).toMatch(/hidden/);
    expect(reason(guardMongoAggregate("users", [{ $project: { e: "$$ROOT.email" } }], g))).toMatch(/hidden/);
    expect(reason(guardMongoAggregate("users", [{ $project: { e: { $getField: "email" } } }], g))).toMatch(/hidden/);
  });
  it("$lookup foreignField / localField", () => {
    expect(
      reason(guardMongoAggregate("bookings", [{ $lookup: { from: "users", localField: "userId", foreignField: "email", as: "u" } }], g)),
    ).toMatch(/users\.email is hidden/);
    expect(
      reason(guardMongoAggregate("users", [{ $lookup: { from: "bookings", localField: "email", foreignField: "userId", as: "b" } }], g)),
    ).toMatch(/hidden/);
  });
  it("$facet branch with a $lookup sub-pipeline projecting email", () => {
    expect(
      reason(
        guardMongoAggregate(
          "bookings",
          [{ $facet: { raw: [{ $lookup: { from: "users", pipeline: [{ $project: { email: 1 } }], as: "u" } }] } }],
          g,
        ),
      ),
    ).toMatch(/hidden/);
  });
  it("joined alias path into a hidden field", () => {
    expect(
      reason(guardMongoAggregate("bookings", [{ $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "u" } }, { $project: { x: "$u.email" } }], g)),
    ).toMatch(/hidden/);
  });
  it("$graphLookup and $unionWith", () => {
    expect(reason(guardMongoAggregate("bookings", [{ $graphLookup: { from: "users" } }], g))).toMatch(/not supported/);
    expect(reason(guardMongoAggregate("bookings", [{ $unionWith: "users" }], g))).toMatch(/not supported/);
  });
  it("collection missing from catalog, disabled, or wrong case", () => {
    expect(reason(guardMongoFind("sessions", {}, {}, g))).toMatch(/not a collection/);
    expect(reason(guardMongoFind("audit", {}, {}, g))).toMatch(/not a collection/);
    expect(reason(guardMongoFind("Users", {}, {}, g))).toMatch(/not a collection/);
    expect(reason(guardMongoAggregate("bookings", [{ $lookup: { from: "Users", localField: "a", foreignField: "b", as: "u" } }], g))).toMatch(
      /not a collection/,
    );
  });
  it("prefix of a nested hidden path", () => {
    const p2 = effectivePolicy({ auto_hide: false, hidden_fields: ["users.profile.email"], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
    expect(reason(guardMongoFind("users", { profile: { email: "a" } }, {}, { policy: p2 }))).toMatch(/hidden/);
  });
});

describe("Mongo guard: whole-document and array-index probes", () => {
  const p2 = effectivePolicy(
    { auto_hide: false, hidden_fields: ["users.email", "users.contacts.email"], unhidden_fields: [], disabled_tables: [] },
    catalog,
    "mongodb",
  );
  const g2 = { policy: p2 };
  it("$objectToArray of $$ROOT with $regexMatch on $$this.v", () => {
    const pipe = [
      { $match: { $expr: { $gt: [{ $size: { $filter: { input: { $objectToArray: "$$ROOT" }, cond: { $regexMatch: { input: "$$this.v", regex: "^a" } } } } }, 0] } } },
    ];
    expect(reason(guardMongoAggregate("users", pipe, g2))).toBeTruthy();
    const pipe2 = [{ $addFields: { k: { $filter: { input: { $objectToArray: "$$ROOT" }, cond: { $regexMatch: { input: "$$this.v", regex: "^a" } } } } } }];
    expect(reason(guardMongoAggregate("users", pipe2, g2))).toMatch(/not allowed/);
  });
  it.each([
    [{ "contacts.0.email": { $regex: "^a" } }],
    [{ "contacts.$[].email": "a" }],
    [{ "contacts.$[x].email": "a" }],
  ])("array-index path %j", (filter) => {
    expect(reason(guardMongoFind("users", filter, {}, g2))).toMatch(/hidden/);
  });
  it("$project with a positional path", () => {
    expect(reason(guardMongoFind("users", {}, { projection: { "contacts.$.email": 1 } }, g2))).toMatch(/hidden/);
  });
  it("let binding to $$ROOT, bare $$CURRENT, $setField, $unsetField, $jsonSchema, $text", () => {
    expect(reason(guardMongoAggregate("bookings", [{ $lookup: { from: "users", let: { r: "$$ROOT" }, pipeline: [], as: "u" } }], g2))).toMatch(/whole-document/);
    expect(reason(guardMongoAggregate("users", [{ $replaceRoot: { newRoot: "$$CURRENT" } }], g2))).toMatch(/whole-document/);
    expect(reason(guardMongoAggregate("users", [{ $addFields: { x: { $setField: { field: "a", input: "$x", value: 1 } } } }], g2))).toMatch(/not allowed/);
    expect(reason(guardMongoAggregate("users", [{ $addFields: { x: { $unsetField: { field: "a", input: "$x" } } } }], g2))).toMatch(/not allowed/);
    expect(reason(guardMongoFind("users", { $jsonSchema: { properties: { mail: { pattern: "^a" } } } }, {}, g2))).toMatch(/not allowed/);
    expect(reason(guardMongoFind("users", { $text: { $search: "a@b.c" } }, {}, g2))).toMatch(/not allowed/);
  });
  it("$where / $function / $accumulator / $expr are refused by the grammar", () => {
    expect(reason(guardMongoFind("users", { $where: "this.email.startsWith('a')" }, {}, g2))).toBeTruthy();
    expect(reason(guardMongoAggregate("users", [{ $addFields: { x: { $function: { body: "f", args: [], lang: "js" } } } }], g2))).toBeTruthy();
    expect(reason(guardMongoAggregate("users", [{ $group: { _id: null, x: { $accumulator: {} } } }], g2))).toBeTruthy();
    expect(reason(guardMongoAggregate("users", [{ $match: { $expr: { $eq: [{ $toString: "$$ROOT" }, "x"] } } }], g2))).toBeTruthy();
  });
  it("$$ROOT stays allowed when nothing involved is hidden; $objectToArray is refused always", () => {
    expect(guardMongoAggregate("bookings", [{ $replaceRoot: { newRoot: "$$ROOT" } }], g2).ok).toBe(true);
    expect(reason(guardMongoAggregate("bookings", [{ $addFields: { kv: { $objectToArray: "$$ROOT" } } }], g2))).toMatch(/not allowed/);
  });
  it("normal $group by city and $match on visible fields pass", () => {
    expect(guardMongoAggregate("users", [{ $match: { city: "LA" } }, { $group: { _id: "$city", n: { $sum: 1 } } }], g2).ok).toBe(true);
  });
});

describe("Mongo guard: one path normalizer for hidden and query paths", () => {
  it.each([[{ "scores.2024.x": 1 }], [{ "scores.2024": 1 }], [{ scores: { $exists: true } }]])("hidden scores.2024 refuses filter %j", (filter) => {
    const p = effectivePolicy({ auto_hide: false, hidden_fields: ["users.scores.2024"], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
    expect(reason(guardMongoFind("users", filter, {}, { policy: p }))).toMatch(/hidden/);
  });
  it("hidden scores.2024 refuses the $scores.2024 reference", () => {
    const p = effectivePolicy({ auto_hide: false, hidden_fields: ["users.scores.2024"], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
    expect(reason(guardMongoAggregate("users", [{ $project: { s: "$scores.2024" } }], { policy: p }))).toMatch(/hidden/);
  });
  it("a top-level numeric hidden key is still matched", () => {
    const p = effectivePolicy({ auto_hide: false, hidden_fields: ["users.2024"], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
    expect(reason(guardMongoFind("users", { "2024": 1 }, {}, { policy: p }))).toMatch(/hidden/);
  });
  it("hidden contacts.0.email behaves like contacts.email", () => {
    const p = effectivePolicy({ auto_hide: false, hidden_fields: ["users.contacts.0.email"], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
    expect(reason(guardMongoFind("users", { "contacts.email": "a" }, {}, { policy: p }))).toMatch(/hidden/);
    expect(reason(guardMongoFind("users", { "contacts.3.email": "a" }, {}, { policy: p }))).toMatch(/hidden/);
  });
  it("stripHiddenDeep uses the same normalization", () => {
    expect(stripHiddenDeep({ scores: { "2024": 5 }, city: "LA" }, ["scores.2024"])).toEqual({ city: "LA" });
  });
});

describe("Mongo guard: Codex review scenarios", () => {
  const p = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
  it("an email field outside the discovery sample: query refs refused, results stripped", async () => {
    expect(reason(guardMongoFind("bookings", { guestEmail: /^a/ }, {}, { policy: p }))).toMatch(/guestEmail|guestemail/i);
    const { mongoResultStripper } = await import("@zavi/shared/db-guard");
    const strip = mongoResultStripper(p, ["bookings"]);
    expect(strip({ _id: 1, city: "LA", guestEmail: "x@y.z", meta: { phone: "555" } })).toEqual({ _id: 1, city: "LA", meta: {} });
  });
  it("an exact un-hide keeps an unknown sensitive field", async () => {
    const p2 = effectivePolicy({ auto_hide: true, hidden_fields: [], unhidden_fields: ["bookings.guestEmail"], disabled_tables: [] }, catalog, "mongodb");
    const { mongoResultStripper } = await import("@zavi/shared/db-guard");
    expect(mongoResultStripper(p2, ["bookings"])({ guestEmail: "x@y.z" })).toEqual({ guestEmail: "x@y.z" });
  });
  it("a view over a switched-off collection is never readable (views are not allowed)", () => {
    const withView: CatalogLike = { tables: [...catalog.tables, { name: "public_users", columns: [{ name: "cohort" }], view_of: "users" }] };
    const p3 = effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: ["users"] }, withView, "mongodb");
    expect(reason(guardMongoFind("public_users", {}, {}, { policy: p3 }))).toMatch(/not a collection/);
    expect(reason(guardMongoAggregate("bookings", [{ $lookup: { from: "public_users", localField: "userId", foreignField: "_id", as: "u" } }], { policy: p3 }))).toMatch(/not a collection|not_allowlisted/);
  });
  it('computed $getField ("$selector") is refused; literal names go through hidden matching', () => {
    const p4 = effectivePolicy({ auto_hide: false, hidden_fields: ["users.a.b"], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
    expect(reason(guardMongoAggregate("users", [{ $project: { leak: { $getField: "$selector" } } }], { policy: p4 }))).toMatch(/computed field name/);
    expect(reason(guardMongoAggregate("users", [{ $project: { leak: { $getField: "a.b" } } }], { policy: p4 }))).toMatch(/hidden/);
  });
  it("a hidden name starting with $ makes the collection unreadable", () => {
    const p5 = effectivePolicy({ auto_hide: false, hidden_fields: ["users.$secret"], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
    expect(reason(guardMongoFind("users", {}, {}, { policy: p5 }))).toMatch(/starts with \$/);
  });
});

describe("Mongo guard transform", () => {
  it("plain find gets { email: 0 }", () => {
    const r = guardMongoFind("users", {}, {}, g);
    expect(r.ok && r.options.projection).toEqual({ email: 0 });
  });
  it("inclusion projection is left alone (it cannot include a hidden field)", () => {
    const r = guardMongoFind("users", {}, { projection: { city: 1 } }, g);
    expect(r.ok && r.options.projection).toEqual({ city: 1 });
  });
  it("top level, $facet branch and $lookup sub-pipeline each get their own $unset", () => {
    const r = guardMongoAggregate(
      "users",
      [{ $facet: { a: [{ $lookup: { from: "users", pipeline: [{ $match: { city: "LA" } }], as: "u" } }] } }],
      g,
    );
    expect(r.ok && r.pipeline).toEqual([
      { $unset: ["email"] },
      { $facet: { a: [{ $unset: ["email"] }, { $lookup: { from: "users", pipeline: [{ $unset: ["email"] }, { $match: { city: "LA" } }], as: "u" } }] } },
    ]);
  });
  it("concise $lookup into a protected collection gets pipeline [$unset]", () => {
    const r = guardMongoAggregate("bookings", [{ $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "u" } }], g);
    expect(r.ok && r.pipeline).toEqual([
      { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "u", pipeline: [{ $unset: ["email"] }] } },
    ]);
  });
});

describe("Mongo guard must-not-catch", () => {
  it("excluding a hidden field (projection 0, $project 0, $unset) is not a reference", () => {
    expect(guardMongoFind("users", {}, { projection: { email: 0 } }, g).ok).toBe(true);
    expect(guardMongoAggregate("users", [{ $project: { email: 0 } }], g).ok).toBe(true);
  });
  it("bookings aggregate grouping by city is unchanged", () => {
    const pipe = [{ $group: { _id: "$city", n: { $sum: 1 }, gmv: { $sum: "$total" } } }, { $sort: { n: -1 } }];
    const r = guardMongoAggregate("bookings", pipe, g);
    expect(r.ok && r.pipeline).toEqual(pipe);
  });
  it("find on an unprotected collection keeps options", () => {
    const r = guardMongoFind("bookings", { city: "LA" }, { limit: 5 }, g);
    expect(r.ok && r.options).toEqual({ limit: 5 });
  });
});

describe("stripHiddenDeep", () => {
  it("removes hidden keys at any depth and keeps Dates", () => {
    const d = new Date(0);
    expect(stripHiddenDeep({ a: 1, Email: "x", u: [{ email: "y", at: d }] }, ["email"])).toEqual({ a: 1, u: [{ at: d }] });
  });
  it("cuts beyond the depth cap", () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 14; i++) deep = { n: deep };
    const out = JSON.stringify(stripHiddenDeep(deep, ["email"]));
    expect(out).not.toContain('"v":1');
  });
});

describe("a guarded pipeline passes a second guard (the connector re-checks what the cloud sent)", () => {
  it("cloud $unset stages are accepted and still bound by the connector's own hidden set", () => {
    const first = guardMongoAggregate("users", [{ $match: { city: "LA" } }, { $group: { _id: "$city", n: { $sum: 1 } } }], g);
    expect(first.ok).toBe(true);
    const connectorPolicy = effectivePolicy({ auto_hide: false, hidden_fields: ["users.city"], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
    const again = guardMongoAggregate("users", (first as { pipeline: unknown[] }).pipeline, { policy: connectorPolicy });
    expect(reason(again)).toMatch(/users\.city is hidden/);
    const allowAll = effectivePolicy({ auto_hide: false, hidden_fields: [], unhidden_fields: [], disabled_tables: [] }, catalog, "mongodb");
    expect(guardMongoAggregate("users", (first as { pipeline: unknown[] }).pipeline, { policy: allowAll }).ok).toBe(true);
  });
  it("$unset stages do not count toward the stage cap; real stages still do", () => {
    const twelve = Array.from({ length: 12 }, () => ({ $match: { city: "LA" } }));
    const first = guardMongoAggregate("users", twelve, g);
    expect(first.ok && first.pipeline.length).toBe(13);
    expect(guardMongoAggregate("users", (first as { pipeline: unknown[] }).pipeline, g).ok).toBe(true);
    expect(reason(guardMongoAggregate("users", [...twelve, { $match: { city: "SF" } }], g))).toMatch(/too_many_stages/);
  });
  it("$unset takes field paths only", () => {
    expect(reason(guardMongoAggregate("bookings", [{ $unset: "$total" }], g))).toMatch(/bad_unset/);
    expect(reason(guardMongoAggregate("bookings", [{ $unset: [{ $literal: 1 }] }], g))).toMatch(/bad_unset/);
    expect(reason(guardMongoAggregate("bookings", [{ $unset: [] }], g))).toMatch(/bad_unset/);
    expect(guardMongoAggregate("bookings", [{ $unset: ["total", "city"] }], g).ok).toBe(true);
  });
});

describe("refusal origin: the workspace's settings vs Zavi's own guard", () => {
  it.each([
    ["a hidden field", () => guardMongoFind("users", {}, { projection: { email: 1 } }, g)],
    ["a switched-off collection", () => guardMongoFind("audit", {}, {}, g)],
    ["$setField while fields are hidden", () => guardMongoAggregate("users", [{ $addFields: { x: { $setField: { field: "a", input: "$$ROOT", value: 1 } } } }], g)],
  ])("%s is a settings refusal", (_name, run) => {
    expect(run()).toMatchObject({ ok: false, rule: "settings" });
  });
  it("$objectToArray is Zavi's guard, not the workspace's settings", () => {
    const r = guardMongoAggregate("bookings", [{ $addFields: { kv: { $objectToArray: "$$ROOT" } } }], g);
    expect(r.ok).toBe(false);
    expect((r as { rule?: string }).rule).toBeUndefined();
  });
});
