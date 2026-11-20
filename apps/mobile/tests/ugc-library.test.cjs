const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const shared = loadTs(path.join(__dirname, "../../../packages/shared/src/creators/ad-metrics.ts"));
const lib = loadTs(path.join(__dirname, "../src/features/channels/ugcLibrary.ts"), { "@zavi/shared": shared });
const plain = (v) => JSON.parse(JSON.stringify(v));
const eq = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));

const asset = (o = {}) => ({
  id: "a1",
  order_id: "o1",
  rights_start_at: "2026-10-02T09:00:00Z",
  rights_end_at: "2026-12-31T09:00:00Z",
  rights_expired: false,
  tracking_tag: "zavi_spring_ad",
  two_clocks_warning: null,
  video: { kind: "video", storage_path: "x", mime_type: "video/mp4", bytes: 13002342 },
  meta: null,
  ad_performance: null,
  youtube: null,
  creator_display_name: "Maya Films",
  ...o,
});

test("the row heading names the creator and the file size, and leaves out what is unknown", () => {
  assert.equal(lib.libraryHeading(asset()), "Approved video from Maya Films · 12.4 MB");
  assert.equal(lib.libraryHeading(asset({ creator_display_name: null, video: null })), "Approved video");
  assert.equal(lib.libraryHeading(asset({ video: { mime_type: null, bytes: null } })), "Approved video from Maya Films");
});

test("sizes follow web fmtBytes: one decimal in MB from a mebibyte, whole KB below, never 0 KB", () => {
  assert.equal(lib.fmtBytes(1024 * 1024), "1.0 MB");
  assert.equal(lib.fmtBytes(655360), "640 KB");
  assert.equal(lib.fmtBytes(10), "1 KB");
  assert.equal(lib.fmtBytes(null), null);
  assert.equal(lib.fmtBytes(Number.NaN), null);
});

test("rights dates read in UTC as 'Oct 2, 2026'; an unreadable one says unknown", () => {
  assert.equal(lib.rightsLine(asset()), "Ad rights run Oct 2, 2026 to Dec 31, 2026.");
  assert.equal(lib.rightsLine(asset({ rights_end_at: "nope" })), "Ad rights run Oct 2, 2026 to unknown.");
  assert.equal(lib.trackingLine(asset()), "Tracking tag zavi_spring_ad");
  assert.equal(lib.trackingLine(asset({ tracking_tag: undefined })), null);
});

test("chips: rights active or ended, and the Meta chip only once the video is an ad", () => {
  eq(lib.rightsChip(asset()), { label: "Rights active", tone: "ok" });
  eq(lib.rightsChip(asset({ rights_expired: true })), { label: "Rights ended", tone: "bad" });
  assert.equal(lib.metaChip(asset()), null);
  assert.equal(lib.metaChip(asset({ meta: { ad_id: null } })), null);
  eq(lib.metaChip(asset({ meta: { ad_id: "ad1", auto_paused_at: null } })), { label: "In Meta as a paused ad", tone: "info" });
  eq(lib.metaChip(asset({ meta: { ad_id: "ad1", auto_paused_at: "2026-12-31T09:00:00Z" } })), {
    label: "Meta ad paused by Zavi",
    tone: "warn",
  });
});

const perf = (o = {}) => ({
  enough_evidence: true,
  conversions: 62,
  needed_conversions: 50,
  progress_label: null,
  read_at: "2026-10-05T12:00:00Z",
  scope_note: shared.CREATOR_AD_METRICS_SCOPE_NOTE,
  numbers: { spend_usd: 1234.6, impressions: 1234567, clicks: 4321, reach: 98765, conversions: 62, purchases: 40, purchase_value_usd: 2500 },
  ...o,
});

test("no ad numbers at all draws nothing", () => {
  assert.equal(lib.adNumbersView(null), null);
});

test("below the evidence bar the phone abstains with the server's progress line, never a number", () => {
  const v = lib.adNumbersView(perf({ enough_evidence: false, conversions: 18, progress_label: "18 of 50 conversions", numbers: null }));
  eq(v, {
    kind: "abstain",
    title: "Not enough evidence yet",
    body: "18 of 50 conversions. Zavi shows this ad's own numbers once it has recorded enough conversions to be worth reading. Until then the totals move on luck.",
  });
});

test("it abstains when numbers are missing, or when the count is under 50 whatever the flag says", () => {
  assert.equal(lib.adNumbersView(perf({ numbers: null })).kind, "abstain");
  assert.equal(lib.adNumbersView(perf({ conversions: 49 })).kind, "abstain");
  assert.equal(lib.adNumbersView(perf({ numbers: null })).body, shared.CREATOR_AD_METRICS_ABSTAIN_BODY);
});

test("at or over the bar: seven absolute totals, whole dollars and grouped counts, and the read day", () => {
  const v = plain(lib.adNumbersView(perf()));
  assert.equal(v.kind, "numbers");
  assert.equal(v.title, "What this ad recorded");
  eq(v.cells, [
    { label: "Spend", value: "$1,235" },
    { label: "Impressions", value: "1,234,567" },
    { label: "Clicks", value: "4,321" },
    { label: "Reach", value: "98,765" },
    { label: "Conversions", value: "62" },
    { label: "Purchases", value: "40" },
    { label: "Purchase value", value: "$2,500" },
  ]);
  assert.equal(v.foot, `${shared.CREATOR_AD_METRICS_SCOPE_NOTE} Read Oct 5, 2026.`);
  assert.equal(lib.adNumbersView(perf({ conversions: 50, numbers: { ...perf().numbers, conversions: 50 } })).kind, "numbers");
});

test("number formatting is by hand, so Hermes cannot drop the grouping", () => {
  assert.equal(lib.fmtCount(0), "0");
  assert.equal(lib.fmtCount(999.6), "1,000");
  assert.equal(lib.fmtWholeUsd(0), "$0");
  assert.equal(lib.fmtWholeUsd(1000000), "$1,000,000");
  assert.equal(lib.fmtWholeUsd(-12.4), "-$12");
  assert.equal(lib.fmtCount(null), "Not read");
});

test("Meta panel words: who it posts as, ad set options, and the success line", () => {
  assert.equal(
    lib.metaIntro({ page_name: null, page_id: "p9", ad_account_id: "act_1" }),
    "Posting as p9 on act_1. The ad is created paused in the ad set you pick. Zavi never creates a campaign, an ad set or a budget here.",
  );
  assert.ok(lib.metaIntro({ page_name: "Upcar", page_id: "p9", ad_account_id: "act_1" }).startsWith("Posting as Upcar on act_1."));
  eq(lib.adSetOptions([{ id: "s1", name: "Spring", status: "ACTIVE" }, { id: "s2", name: "Retarget", status: null }]), [
    { value: "s1", label: "Spring (active)" },
    { value: "s2", label: "Retarget" },
  ]);
  assert.equal(
    lib.metaCreatedLine({ ad_id: "ad42", status: "PAUSED", rights_end_at: "2026-12-31T09:00:00Z" }, asset()),
    "Created ad ad42, status PAUSED. Nothing spends until you turn it on in Meta Ads Manager. Zavi pauses it again on Dec 31, 2026.",
  );
  assert.equal(lib.metaCreatedLine({}, asset()), null);
  assert.equal(lib.metaCreatedLine(undefined, asset()), null);
});

test("the paused-ad body carries the ad set and trimmed primary text only, never a status", () => {
  eq(lib.metaAdBody("s1", ""), { ad_set_id: "s1" });
  eq(lib.metaAdBody("s1", "   "), { ad_set_id: "s1" });
  eq(lib.metaAdBody("s1", " Try it today \n"), { ad_set_id: "s1", message: "Try it today" });
});

test("library paths put the id in the path, encoded", () => {
  assert.equal(lib.libraryPaths.metaAd("a/1"), "/api/creators/library/a%2F1/meta-ad");
  assert.equal(lib.libraryPaths.metaEligibility("a1"), "/api/creators/library/a1/meta-eligibility");
  assert.equal(lib.libraryPaths.youtubeVideo("a1"), "/api/creators/library/a1/youtube-video");
  assert.equal(lib.libraryPaths.youtubeEligibility("a1"), "/api/creators/library/a1/youtube-eligibility");
});

test("write errors: the server's words, else web's '(HTTP n)' fallback, else the plain fallback", () => {
  const apiErr = (status, code, message) => Object.assign(new Error(message), { status, code });
  assert.equal(lib.writeError(apiErr(409, "rights_expired", "The ad rights on this video have ended."), "Could not create the ad"), "The ad rights on this video have ended.");
  assert.equal(lib.writeError(apiErr(502, "http_502", "Request failed (502)"), "Could not create the ad"), "Could not create the ad (HTTP 502)");
  assert.equal(lib.writeError(new TypeError("Network request failed"), "Could not create the ad"), "Network request failed");
  assert.equal(lib.writeError(null, "Could not save the video id"), "Could not save the video id");
});

test("YouTube: Save until an id is stored, then Replace, and the saved line", () => {
  assert.equal(lib.youtubeSaveLabel(null), "Save");
  assert.equal(lib.youtubeSaveLabel("dQw4w9WgXcQ"), "Replace");
  assert.equal(lib.youtubeSavedLine("dQw4w9WgXcQ"), "Saved video id dQw4w9WgXcQ");
  assert.equal(lib.youtubeSavedLine(null), null);
  eq(lib.youtubeVideoBody("  https://youtu.be/dQw4w9WgXcQ "), { youtube_video: "https://youtu.be/dQw4w9WgXcQ" });
});

function loadHooks() {
  const calls = [];
  const invalidated = [];
  let mutating = 0;
  const hooks = loadTs(path.join(__dirname, "../src/features/channels/ugcLibraryHooks.ts"), {
    "@tanstack/react-query": {
      useQuery: (o) => o,
      useMutation: (o) => o,
      useQueryClient: () => ({ invalidateQueries: (x) => invalidated.push(x) }),
      useIsMutating: (filter) => {
        calls.push({ isMutating: filter });
        return mutating;
      },
    },
    "../../lib/api": {
      apiJson: (p, opts) => {
        calls.push({ path: p, opts: opts ?? null });
        return Promise.resolve({ ad_id: "ad1", status: "PAUSED" });
      },
    },
    "../workspaces/useActiveTenant": { useActiveTenant: () => "t1" },
    "./ugcHooks": { ugcKey: (tenant, ...rest) => ["ugc", tenant, ...rest] },
    "@zavi/shared": shared,
  });
  return { hooks, calls, invalidated, setMutating: (n) => (mutating = n) };
}

test("Create paused ad: one POST with an Idempotency-Key (the route is server-deduped), keyed per video", async () => {
  const { hooks, calls, invalidated } = loadHooks();
  const m = hooks.useCreateMetaAd("a1");
  eq(m.mutationKey, ["ugc", "t1", "meta-ad", "a1"]);
  await m.mutationFn({ adSetId: "s1", message: "Hi" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/creators/library/a1/meta-ad");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.idempotent, true);
  eq(JSON.parse(calls[0].opts.body), { ad_set_id: "s1", message: "Hi" });
  m.onSuccess();
  eq(invalidated, [{ queryKey: ["ugc", "t1"] }]);
});

test("a create still running for this video, from any mount, blocks the button", () => {
  const { hooks, calls, setMutating } = loadHooks();
  assert.equal(hooks.useMetaAdPending("a1"), false);
  setMutating(1);
  assert.equal(hooks.useMetaAdPending("a1"), true);
  eq(calls[0].isMutating, { mutationKey: ["ugc", "t1", "meta-ad", "a1"] });
});

test("eligibility reads are per workspace and per video, and only when the panel is open", async () => {
  const { hooks, calls } = loadHooks();
  const q = hooks.useMetaEligibility("a1", false);
  eq(q.queryKey, ["ugc", "t1", "meta-eligibility", "a1"]);
  assert.equal(q.enabled, false);
  assert.equal(hooks.useMetaEligibility("a1", true).enabled, true);
  await hooks.useYoutubeEligibility("a1", true).queryFn();
  assert.equal(calls[0].path, "/api/creators/library/a1/youtube-eligibility");
});

test("Save the YouTube id: a plain POST of the pasted link, not replayed", async () => {
  const { hooks, calls } = loadHooks();
  await hooks.useSaveYoutubeVideo("a1").mutationFn(" https://youtu.be/x ");
  assert.equal(calls[0].path, "/api/creators/library/a1/youtube-video");
  assert.equal(calls[0].opts.method, "POST");
  assert.equal(calls[0].opts.idempotent, undefined);
  eq(JSON.parse(calls[0].opts.body), { youtube_video: "https://youtu.be/x" });
});

test("a failed Meta create keeps its key only while the outcome is unknown, so a second tap cannot make a second ad", () => {
  assert.equal(lib.keepMetaAdKey(new TypeError("Network request failed")), true);
  assert.equal(lib.keepMetaAdKey({ status: 409, code: "idempotency_in_progress", message: "x" }), true);
  assert.equal(lib.keepMetaAdKey({ status: 409, code: "meta_ad_already_created", message: "x" }), false);
  assert.equal(lib.keepMetaAdKey({ status: 502, code: "meta_ads_video_not_ready", message: "x" }), false);
  assert.equal(lib.keepMetaAdKey({ status: 400, code: "bad_meta_ad_request", message: "x" }), false);
  assert.match(lib.metaCreateError({ status: 409, code: "idempotency_in_progress", message: "x" }), /still creating/);
  assert.match(lib.metaCreateError(new TypeError("Network request failed")), /will not make a second ad/);
  assert.equal(lib.metaCreateError({ status: 409, code: "meta_ad_already_created", message: "This video is already in your Meta ad account as a paused ad." }), "This video is already in your Meta ad account as a paused ad.");
});

test("a reused key with another body is still an unknown outcome: the key stays, no second ad", () => {
  assert.equal(lib.keepMetaAdKey({ status: 422, code: "idempotency_key_reused", message: "x" }), true);
  assert.match(lib.metaCreateError({ status: 422, code: "idempotency_key_reused", message: "x" }), /still creating/);
});
