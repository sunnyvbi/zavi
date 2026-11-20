const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/channels/ugc.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Date, Math, Number, URLSearchParams, Intl, String });
const u = mod.exports;

const plain = (v) => JSON.parse(JSON.stringify(v));
const job = (o) => ({
  id: "j1",
  status: "in_progress",
  closed_reason: null,
  title: "Spring ad",
  creator_display_name: "Maya Films",
  human_member_id: "m1",
  created_at: "2026-10-01T00:00:00Z",
  due_at: null,
  money: { currency: "usd", business_total_cents: 11000, business_fee_label: "10%" },
  deadline: null,
  awaiting_creator: false,
  ...o,
});

test("money formats cents without working any out", () => {
  assert.equal(u.money(165000), "$1,650");
  assert.equal(u.money(1250), "$12.50");
  assert.equal(u.money(100000000), "$1,000,000");
  assert.equal(u.money(-500), "-$5");
  assert.equal(u.money(1), "$0.01");
  assert.equal(u.money(null), "");
  assert.equal(u.money(Number.NaN), "");
});

test("receipt money always shows cents; other currencies keep their code", () => {
  assert.equal(u.formatCents(16500), "$165.00");
  assert.equal(u.formatCents(1234567), "$12,345.67");
  assert.equal(u.formatCents(-1500), "-$15.00");
  assert.equal(u.formatCents(16500, "eur"), "EUR 165.00");
  assert.equal(u.formatCents(undefined), "");
});

test("server instants are formatted, in UTC, the way web does", () => {
  assert.equal(u.dayTimeUtc("2026-10-04T16:40:00Z"), "Oct 4, 16:40 UTC");
  assert.equal(u.dayTimeUtc("2026-10-04T03:05:00Z"), "Oct 4, 03:05 UTC");
  assert.equal(u.dayTimeUtc("nope"), "");
  assert.equal(u.longDay("2026-10-02T23:00:00Z"), "Oct 2, 2026");
});

test("job status words are web's list words", () => {
  assert.equal(u.jobStatusLabel({ status: "submitted", closed_reason: null }), "Ready for your review");
  assert.equal(u.jobStatusLabel({ status: "awaiting_acceptance", closed_reason: null }), "Waiting for the creator");
  assert.equal(u.jobStatusLabel({ status: "in_dispute", closed_reason: null }), "Zavi is stepping in");
  assert.equal(u.jobStatusLabel({ status: "completed", closed_reason: "approved" }), "Done");
  assert.equal(u.jobStatusLabel({ status: "checkout_pending", closed_reason: null }), "Payment not finished");
});

test("lane job rows: a due date is a day, other deadlines an instant, delivered rows count changes", () => {
  const due = u.jobRow(job({ deadline: { line: "x", kind: "due", deadline_at: "2026-10-05T14:00:00Z" } }));
  assert.equal(due.line, "Due Oct 5");
  const review = u.jobRow(job({ status: "submitted", revisions_used: 1, deadline: { line: "x", kind: "review", deadline_at: "2026-10-05T14:00:00Z" } }));
  assert.equal(review.line, "Review by Oct 5, 14:00 UTC · 1 of 2 changes used");
  assert.equal(u.jobRow(job({ status: "submitted" })).line, "");
});

test("an abandoned checkout reads as not paid", () => {
  assert.equal(u.jobStatusLabel({ status: "cancelled", closed_reason: "checkout_abandoned" }), "Not paid");
  assert.equal(u.isNeverPaid({ status: "checkout_pending", closed_reason: null }), true);
  assert.equal(u.jobRow(job({ status: "checkout_pending" })), null);
});

test("a delivery or an ask for more time waits on you", () => {
  assert.equal(u.jobNeedsYou(job({ status: "submitted" })), true);
  assert.equal(u.jobNeedsYou(job({ extension_state: "requested" })), true);
  assert.equal(u.jobNeedsYou(job({ status: "cancelled", extension_state: "requested" })), false);
  assert.equal(u.jobNeedsYou(job({})), false);
});

test("keyword needs every word; search path carries the lane", () => {
  const c = { display_name: "Maya Films", niches: ["beauty"], platforms: ["tiktok"], location: { city: "Austin", country_code: "US" } };
  assert.equal(u.matchesKeyword(c, "maya tiktok"), true);
  assert.equal(u.matchesKeyword(c, "maya youtube"), false);
  assert.equal(u.matchesKeyword(c, ""), true);
  assert.equal(u.searchPath({ keyword: "", lane: "ugc_video", order: "newest" }), "/api/humans/creators/search?order=newest&limit=100&lane=ugc_video");
});

test("notification links open the phone screen, or nothing when web-only", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(u.noticeTarget("/workspace?tab=channels&channel=ugc&drawer=job&job=abc"))), { pathname: "/channels/ugc/job/[id]", params: { id: "abc" } });
  assert.deepEqual(JSON.parse(JSON.stringify(u.noticeTarget("/workspace?drawer=thread&creator=m1"))), { pathname: "/channels/ugc/thread/[id]", params: { id: "m1" } });
  assert.deepEqual(plain(u.noticeTarget("/workspace?drawer=hire&package=p")), { pathname: "/channels/ugc/hire", params: { package: "p" } });
  assert.deepEqual(plain(u.noticeTarget("/workspace?drawer=hire&offer=o1")), { pathname: "/channels/ugc/hire", params: { offer: "o1" } });
  assert.deepEqual(plain(u.noticeTarget("/workspace?drawer=hire&application=a1&brief=b1")), { pathname: "/channels/ugc/hire", params: { application: "a1", brief: "b1" } });
  assert.deepEqual(plain(u.noticeTarget("/workspace?drawer=applicants&brief=b1&hire_cancelled=1")), { pathname: "/channels/ugc/applicants/[id]", params: { id: "b1" } });
  assert.deepEqual(plain(u.noticeTarget("/workspace?drawer=brief&brief=b2")), { pathname: "/channels/ugc/brief/[id]", params: { id: "b2" } });
  assert.deepEqual(plain(u.noticeTarget("/workspace?drawer=find")), { pathname: "/channels/ugc/find", params: {} });
  assert.equal(u.noticeTarget("/workspace?drawer=hire"), null);
  assert.equal(u.noticeTarget("/humans/library"), null);
  assert.equal(u.noticeTarget(null), null);
});

test("lane: running first, then finished jobs, then closed briefs; unpaid never drawn", () => {
  const briefs = [
    { id: "b1", title: "Spring", status: "open", application_count: 3, posted_at: "2026-10-01", answer_by: "2026-10-09" },
    { id: "b2", title: "Old", status: "filled", application_count: 1, posted_at: "2026-09-01", closed_at: "2026-09-05" },
    { id: "b3", title: "Draft", status: "draft", application_count: 0, posted_at: null },
  ];
  const jobs = [job({ id: "j1", status: "completed", closed_reason: "approved" }), job({ id: "j2", status: "submitted" }), job({ id: "j3", status: "checkout_pending" })];
  const rows = u.laneRows(briefs, jobs);
  assert.deepEqual(Array.from(rows, (r) => r.id), ["brief-b1", "job-j2", "job-j1", "brief-b2"]);
  assert.equal(rows[0].line, "3 applied · answer by Oct 9");
  assert.equal(rows[2].status, "Approved");
});

test("hub numbers: web's four, and a number whose inputs did not load says why", () => {
  const n = u.hubNumbers([{ id: "b", title: "x", status: "open", application_count: 0, posted_at: "2026-10-01" }], [job({}), job({ id: "j2", human_member_id: "m2", status: "completed", closed_reason: "mediation_pay_part" })], 3);
  assert.deepEqual(Array.from(n, (m) => m.key), ["briefs_out", "creators_hired", "videos_delivered", "spent"]);
  assert.equal(n[0].value, 1);
  assert.equal(n[1].value, 2);
  assert.equal(n[2].value, 3);
  assert.ok(Number.isNaN(n[3].value));
  assert.equal(n[3].unmeasured, "Could not read a refund just now.");
  const unread = u.hubNumbers([], [], null);
  assert.equal(unread[2].unmeasured, "Could not read every delivery just now.");
  assert.equal(unread[3].value, 0);
});

test("videos delivered counts videos by each job's latest delivery, null when any read is missing", () => {
  const library = [{ id: "a1", order_id: "o1" }, { id: "a2", order_id: "o1" }, { id: "a3", order_id: "o2" }];
  const jobs = [job({ id: "o3", status: "submitted" }), job({ id: "o4", status: "in_progress" })];
  assert.equal(u.videosDelivered(jobs, library, { o1: 2, o2: 1, o3: 1 }), 4);
  assert.equal(u.videosDelivered(jobs, library, { o1: 2, o2: 1 }), null);
  assert.equal(u.videosDelivered([], [{ id: "x" }], {}), null);
  assert.equal(u.videosDelivered([], [], {}), 0);
  assert.deepEqual(Array.from(u.deliveryOrderIds(jobs, library)).sort(), ["o1", "o2", "o3"]);
  assert.equal(u.latestVideoCount([{ kind: "video", version: 1 }, { kind: "video", version: 2 }, { kind: "video", version: 2 }, { kind: "note", version: 3 }]), 2);
});

test("hire cards: draft, applicants, book direct, waiting", () => {
  const briefs = [{ id: "d", title: "Draft", status: "draft", application_count: 0, posted_at: null }, { id: "p", title: "Posted", status: "open", application_count: 2, posted_at: "2026-10-01" }];
  const cards = u.hireCards(briefs, [job({})], 4);
  assert.deepEqual(Array.from(cards, (c) => c.kind), ["Brief", "Applicants", "Book", "Waiting"]);
  assert.equal(cards[1].to, "applicants");
  assert.equal(cards[1].briefId, "p");
  assert.equal(u.hireCards([], [], 0).length, 0);
});

const asset = (o) => ({ id: "a1", created_at: "2026-10-01T00:00:00Z", rights_start_at: "2026-10-01T00:00:00Z", rights_end_at: "2026-12-30T00:00:00Z", rights_expired: false, meta: null, youtube: null, creator_display_name: "Maya Films", source_channel: "meta_ads", ...o });
const now = new Date("2026-10-05T00:00:00Z");

test("a video is ready while licensed, unused and recent", () => {
  assert.equal(u.assetIsReady(asset({}), now), true);
  assert.equal(u.assetIsReady(asset({ rights_expired: true }), now), false);
  assert.equal(u.assetIsReady(asset({ meta: { ad_id: "x" } }), now), false);
  assert.equal(u.assetIsReady(asset({ created_at: "2026-08-01T00:00:00Z" }), now), false);
});

test("library cards: UGC shows every ready video, a video channel only its own", () => {
  const lib = [asset({}), asset({ id: "a2", source_channel: "tiktok_ads" }), asset({ id: "a3", source_channel: null })];
  const meta = { name: "Meta Ads", placement: "Instagram and Facebook Reels", use: "ad", push: "meta" };
  assert.equal(u.readyVideoCards(lib, "ugc", null, now).length, 3);
  const cards = u.readyVideoCards(lib, "meta_ads", meta, now);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].webOnly, true);
  assert.equal(cards[0].title, "Maya's video is ready: run it as an ad");
  assert.equal(cards[0].rights, "90 days, from Maya Films");
  assert.equal(u.readyVideoCards(lib, "ugc", null, now)[0].webOnly, false);
});

test("settings: UGC declares where the asset runs and what a creator must not say", () => {
  assert.deepEqual(Array.from(u.UGC_SETTINGS, (f) => f.id), ["run_surface", "claims_off_limits"]);
});

const row = (over = {}) => ({
  human_member_id: "m1", display_name: "Jemis Test", lanes: ["ugc_video"], niches: ["Food and drink", "Pets", "Fitness", "Travel", "Beauty"],
  platforms: ["instagram"], location: { city: "Austin", country_code: "US" }, bookable: true, not_bookable_message: null,
  handles: [{ platform: "instagram", handle: "aeshthetic.addict", url: null, followers: 6_000_000, label: "x" }],
  packages: [{ title: "1 Instagram Reel" }], from_price_business_total_cents: 110, ...over,
});

test("every server filter goes on the search path; the keyword and follower floor stay local", () => {
  const f = { ...u.NO_FILTERS, platform: "instagram", niches: ["Food and drink", "Pets"], lane: "ugc_video", maxPriceCents: 10000, maxDeliveryDays: 7, country: "US", minFollowers: 1000, keyword: "food" };
  assert.equal(u.searchPath(f), "/api/humans/creators/search?order=newest&limit=100&platform=instagram&niches=Food+and+drink%2CPets&lane=ugc_video&max_price_cents=10000&max_delivery_days=7&country_code=US");
  assert.equal(u.searchPath(u.NO_FILTERS), "/api/humans/creators/search?order=newest&limit=100");
});

test("the keyword also reads handles and package titles; the follower floor reads the biggest account", () => {
  assert.equal(u.matchesKeyword(row(), "aeshthetic"), true);
  assert.equal(u.matchesKeyword(row(), "reel"), true);
  assert.equal(u.matchesKeyword(row(), "austin pets"), true);
  assert.equal(u.matchesKeyword(row(), "tiktok"), false);
  assert.equal(u.matchesLocally(row(), { keyword: "", minFollowers: 1_000_000 }), true);
  assert.equal(u.matchesLocally(row(), { keyword: "", minFollowers: 10_000_000 }), false);
  assert.equal(u.matchesLocally(row({ handles: [] }), { keyword: "", minFollowers: 1000 }), false);
});

test("active filters count, and a pill reads its choice or its own name", () => {
  assert.equal(u.activeCount(u.NO_FILTERS), 0);
  assert.equal(u.activeCount({ ...u.NO_FILTERS, platform: "x", niches: ["a", "b"], keyword: " ", maxPriceCents: 5000 }), 4);
  const list = [{ value: 5000, label: "A package up to $50" }];
  assert.equal(u.pillLabel(list, 5000, "Price"), "A package up to $50");
  assert.equal(u.pillLabel(list, null, "Price"), "Price");
  assert.equal(u.pillLabel(list, "", "Price"), "Price");
});

test("the results line and the niche chips on a row", () => {
  assert.equal(u.resultsLine(2, "Newest first", "Not ranked by Zavi · Followers self-reported"), "2 creators · Newest first · Not ranked by Zavi · Followers self-reported");
  assert.equal(u.resultsLine(1, undefined, undefined), "1 creator");
  const c = u.nicheChips(["a", "b", "c", "d", "e"]);
  assert.deepEqual(Array.from(c.shown), ["a", "b", "c"]);
  assert.equal(c.more, 2);
});

test("the results line is the count, then the order", () => {
  assert.deepEqual(plain(u.resultsParts(21, "Newest first")), { count: "21 creators", order: "Newest first" });
  assert.deepEqual(plain(u.resultsParts(1, undefined)), { count: "1 creator", order: null });
});
