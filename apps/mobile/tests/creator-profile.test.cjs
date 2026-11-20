const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/features/channels/creatorProfile.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Number, Math, String, Array, Object });
const p = mod.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

test("the cover is their photo, else the illustration, else initials", () => {
  assert.deepEqual(plain(p.coverOf({ display_name: "Jemis Lakhani", photo_url: "https://x/p.jpg", illustration_url: "https://x/i.jpg" })), { kind: "photo", url: "https://x/p.jpg" });
  assert.deepEqual(plain(p.coverOf({ display_name: "Jemis Lakhani", illustration_url: "https://x/i.jpg" })), { kind: "illustration", url: "https://x/i.jpg" });
  assert.deepEqual(plain(p.coverOf({ display_name: "Jemis Lakhani" })), { kind: "initials", text: "JL" });
  assert.equal(p.initials("tarun"), "T");
});

test("the review line says 'No reviews yet' rather than guessing", () => {
  assert.deepEqual(plain(p.ratingLine({ average: null, count: 0 })), { text: "No reviews yet", reviewed: false });
  assert.deepEqual(plain(p.ratingLine({ average: 5, count: 1 })), { text: "5 (1 review)", reviewed: true });
  assert.equal(p.ratingLine({ average: 4.5, count: 12 }).text, "4.5 (12 reviews)");
  assert.equal(p.ratingLine({ average: null, count: 3 }).reviewed, false);
});

test("follower counts are compact like web: 192k, 2.6k, 1.2M", () => {
  assert.equal(p.compactCount(192000), "192k");
  assert.equal(p.compactCount(2582), "2.6k");
  assert.equal(p.compactCount(1_200_000), "1.2M");
  assert.equal(p.compactCount(950), "950");
  assert.equal(p.compactCount(10_400), "10k");
});

test("handle chips show the count (else the handle) and link out", () => {
  const chips = plain(p.handleChips([
    { platform: "instagram", handle: "aeshthetic.addict", url: "https://instagram.com/a", followers: 192000, label: "Self-reported, not checked by Zavi" },
    { platform: "linkedin", handle: "jemis", url: null, followers: null, label: "x" },
  ]));
  assert.equal(chips[0].text, "192k");
  assert.equal(chips[0].url, "https://instagram.com/a");
  assert.equal(chips[0].hint, "@aeshthetic.addict: 192,000 followers on Instagram, self-reported");
  assert.equal(chips[1].text, "jemis");
  assert.equal(chips[1].hint, "jemis on LinkedIn");
  assert.equal(p.platformChannel("x"), "x_organic");
  assert.equal(p.platformChannel("snapchat"), null);
});

test("the follower disclosure is said once, only when a chip shows a count", () => {
  const s = [{ platform: "x", handle: "a", url: null, followers: 5, label: "Self-reported, not checked by Zavi" }];
  assert.equal(p.followersNote(s), "Follower numbers: Self-reported, not checked by Zavi");
  assert.equal(p.followersNote([{ platform: "x", handle: "a", url: null, followers: null, label: "x" }]), null);
});

test("meta line: place, then 'UGC video'; an old audience-post lane adds no words; an invited creator has none", () => {
  const socials = [{ platform: "instagram", handle: "a", url: null, followers: 1, label: "x" }, { platform: "x", handle: "b", url: null, followers: 1, label: "x" }];
  assert.equal(p.metaLine({ city: null, country_code: "US", lanes: ["ugc_video"], socials }), "US · UGC video");
  assert.equal(p.metaLine({ city: "Austin", country_code: "US", lanes: ["audience_post"], socials }), "Austin, US");
  assert.deepEqual([...p.laneWords(["ugc_video", "audience_post"])], ["UGC video"]);
  assert.equal(p.metaLine({ city: null, country_code: "US", lanes: ["ugc_video"], socials, invited: true }), "");
  assert.equal(p.metaLine({ city: null, country_code: null, socials: [] }), "");
});

test("the packages heading counts them and names the lowest price", () => {
  const m = (c) => `$${c / 100}`;
  assert.equal(p.packagesHeading([{ price_cents: 100 }, { price_cents: 1500 }], m), "2 packages · from $1");
  assert.equal(p.packagesHeading([{ price_cents: 5000 }], m), "1 package · from $50");
  assert.equal(p.packagesHeading([], m), "Packages");
});
