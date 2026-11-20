const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const F = loadTs(path.join(__dirname, "../src/features/build/feedback.ts"));
const D = loadTs(path.join(__dirname, "../src/features/build/siteDesign.ts"));
const T = loadTs(path.join(__dirname, "../src/features/build/templates.ts"));
const plain = (v) => JSON.parse(JSON.stringify(v));

test("feedback body: conductor_run target, comment trimmed, reasons only on a thumbs down", () => {
  assert.deepEqual(plain(F.ratingBody("r1", -1, "  too dark  ", ["look", "slow"])), {
    target_type: "conductor_run",
    target_id: "r1",
    rating: -1,
    comment: "too dark",
    reasons: ["look", "slow"],
  });
  assert.deepEqual(plain(F.ratingBody("r1", 1, "", ["look"])), {
    target_type: "conductor_run",
    target_id: "r1",
    rating: 1,
    comment: null,
    reasons: [],
  });
  assert.equal(F.ratingBody("r1", -1, "x".repeat(900), []).comment.length, F.REASON_MAX);
});

test("reason chips keep the option order whatever order they are tapped in", () => {
  let picked = [];
  picked = F.toggleReason(picked, "slow");
  picked = F.toggleReason(picked, "look");
  picked = F.toggleReason(picked, "copy");
  assert.deepEqual(plain(picked), ["look", "copy", "slow"]);
  assert.deepEqual(plain(F.toggleReason(picked, "copy")), ["look", "slow"]);
});

test("thanks line only when reasons were ticked and the workspace carries them over", () => {
  assert.equal(F.thanksLine(["look"], true), F.RATING_THANKS_CARRYOVER);
  assert.equal(F.thanksLine([], true), null);
  assert.equal(F.thanksLine(["look"], false), null);
  assert.equal(F.thanksLine(["look"], "true"), null);
});

test("saved ratings: unknown reasons dropped, bad ratings read as unrated", () => {
  const got = F.readSavedRatings({
    ratings: {
      a: { rating: -1, comment: "meh", reasons: ["look", "vibes", "slow"] },
      b: { rating: 3, comment: 5, reasons: "look" },
    },
  });
  assert.deepEqual(plain(got), {
    a: { rating: -1, comment: "meh", reasons: ["look", "slow"] },
    b: { rating: null, comment: null, reasons: [] },
  });
  assert.deepEqual(plain(F.readSavedRatings(null)), {});
});

test("a change is rated once it lands or fails, never an undo, restore or one still running", () => {
  assert.equal(F.canRateRefine({ status: "done" }), true);
  assert.equal(F.canRateRefine({ status: "failed", kind: "change" }), true);
  assert.equal(F.canRateRefine({ status: "active" }), false);
  assert.equal(F.canRateRefine({ status: "paused" }), false);
  assert.equal(F.canRateRefine({ status: "done", kind: "undo" }), false);
  assert.equal(F.canRateRefine({ status: "done", kind: "restore" }), false);
});

const look = (id, extra = {}) => ({
  id,
  label: `Look ${id}`,
  mood: "calm",
  recommended: false,
  fonts: { display: "Inter", body: "Inter" },
  swatches: { background: "#ffffff", foreground: "#111111", primary: "#2255ff", accent: "#ffcc00", muted: "#eeeeee" },
  radius: "0.5rem",
  layout: "split",
  theme_css: null,
  preview: { name: "Acme", headline: "Fresh bread daily", sections: [] },
  ...extra,
});
const design = (extra = {}) => ({
  design: {
    run_id: "run",
    awaiting_pick: true,
    look_deadline_in_ms: 12000,
    look_deadline_at: "2026-10-09T12:00:30Z",
    picked: false,
    looks: [look("a"), look("b", { recommended: true }), look("c")],
    chosen: "a",
    applied: null,
    structure: null,
    locked: null,
    plan: {},
    ...extra,
  },
});
const NOW = Date.parse("2026-10-09T12:00:00Z");

test("design read: the deadline comes from the server's ms left, malformed looks dropped", () => {
  const d = D.readSiteDesign(
    design({ looks: [look("a"), look("bad", { swatches: { background: "red" } }), look("c", { layout: "weird" })] }),
    NOW,
  );
  assert.equal(d.deadline_ms, NOW + 12000);
  assert.deepEqual(plain(d.looks.map((l) => l.id)), ["a", "c"]);
  assert.equal(d.looks[1].layout, "centered");
  assert.equal(D.readSiteDesign(design({ look_deadline_in_ms: -5 }), NOW).deadline_ms, Date.parse("2026-10-09T12:00:30Z"));
  assert.equal(D.readSiteDesign(design({ awaiting_pick: false }), NOW).deadline_ms, null);
  const live = design({ look_deadline_in_ms: undefined, look_deadline_at: undefined, auto_start_at: "2026-10-09T12:01:00Z" });
  assert.equal(D.readSiteDesign(live, NOW).deadline_ms, Date.parse("2026-10-09T12:01:00Z"));
  assert.equal(D.readSiteDesign({ design: { looks: "x" } }, NOW), null);
});

test("the picker shows only while a pick is awaited and nothing was picked or started", () => {
  const d = D.readSiteDesign(design(), NOW);
  assert.equal(D.awaitsPick(d, null), true);
  assert.equal(D.awaitsPick(d, "a"), false);
  assert.equal(D.awaitsPick({ ...d, picked: true }, null), false);
  assert.equal(D.awaitsPick({ ...d, awaiting_pick: false }, null), false);
  assert.equal(D.awaitsPick(null, null), false);
});

test("countdown names the recommended look and ends on Starting", () => {
  const d = D.readSiteDesign(design(), NOW);
  assert.equal(D.recommendedLook(d).id, "b");
  assert.equal(D.secondsLeft(NOW + 12000, NOW + 500), 12);
  assert.equal(D.secondsLeft(NOW, NOW + 3000), 0);
  assert.equal(D.countdownLine("Made for you", 12), "“Made for you” starts in 12s");
  assert.equal(D.countdownLine("Made for you", 0), "Starting “Made for you”…");
});

test("collapsed line: an open look names the started one and offers Change; a locked one asks for chat", () => {
  const d = D.readSiteDesign(design({ awaiting_pick: false, picked: true }), NOW);
  assert.deepEqual(plain(D.collapsedLook(d, "c")), { name: "Look c", canChange: true });
  assert.deepEqual(plain(D.collapsedLook(d, null)), { name: "Look a", canChange: true });
  const locked = D.readSiteDesign(design({ awaiting_pick: false, locked: "built", applied: "b" }), NOW);
  assert.deepEqual(plain(D.collapsedLook(locked, "c")), { name: "Look b", canChange: false });
});

test("mini landing page: own sections first, padded to three; a testimonial becomes the band", () => {
  const p = D.miniPage(
    look("a", {
      preview: {
        name: "Acme",
        headline: "Fresh bread",
        primary_action: "Order now",
        sections: [
          { title: "Our loaves", kind: "Features" },
          { title: "Kind words", body: "Best bakery in town", kind: "Testimonials" },
        ],
      },
    }),
    null,
  );
  assert.deepEqual(plain(p.features.map((f) => f.title)), ["Our loaves", "What we offer", "How it works"]);
  assert.deepEqual(plain(p.band), { kind: "quote", text: "Best bakery in town" });
  assert.deepEqual(plain(p.links), ["Our loaves", "What we offer", "Contact"]);
  assert.equal(p.action, "Order now");
  assert.equal(p.hero, "split");
  const empty = D.miniPage(look("x", { preview: null, layout: "centered" }), null);
  assert.equal(empty.headline, "Your new website");
  assert.deepEqual(plain(empty.band), { kind: "cta", text: "Ready to start with Your business?" });
  assert.equal(empty.hero, "centered");
});

test("template catalog read: a template without a valid id, an idea or a preview is dropped", () => {
  const ok = {
    id: "salon",
    label: "Salon or spa",
    blurb: "b",
    good_for: "Salons",
    idea: "A site for [salon name]",
    layout: "centered",
    preview: { name: "Your business", headline: "Relax", sections: [] },
  };
  const list = T.readSiteTemplates({ templates: [ok, { ...ok, id: "Bad Id" }, { ...ok, id: "x2", idea: "" }, { ...ok, id: "x3", preview: null }] });
  assert.deepEqual(plain(list.map((t) => t.id)), ["salon"]);
  assert.deepEqual(plain(T.readSiteTemplates({})), []);
});

test("template blanks become questions and fill the idea", () => {
  const idea = "A website for my [type of business] in [town or area]. We offer [services and their prices].";
  const blanks = T.templateBlanks(idea);
  assert.deepEqual(plain(blanks.map(T.blankQuestion)), [
    "What type of business is it?",
    "Which town or area is it in?",
    "What are your services and their prices?",
  ]);
  assert.equal(T.blankQuestion("[salon name]"), "What is the salon name?");
  assert.equal(T.blankQuestion("[address]"), "What is the address?");
  const filled = T.fillTemplateIdea(idea, { "[type of business]": " bakery\n", "[town or area]": "Leeds [north]" });
  assert.equal(filled, "A website for my bakery in Leeds north. We offer [services and their prices].");
  assert.deepEqual(plain(T.templateBlanks(filled)), ["[services and their prices]"]);
  assert.equal(T.blanksHint(["[a]"]), "Fill in the part in brackets first: [a].");
});

test("template tint: each catalog template gets its own soft hue on the app colours", () => {
  const t = (id) => ({ id, label: id, blurb: "", good_for: "", idea: "x", layout: "bold", preview: { name: "n", headline: "h", sections: [] } });
  const light = T.templateLook(t("salon"), { bg: "#ffffff", ink: "#111111" });
  assert.equal(light.swatches.foreground, "#111111");
  assert.notEqual(light.swatches.background, "#ffffff");
  assert.equal(light.layout, "split");
  const dark = T.templateLook(t("salon"), { bg: "#141414", ink: "#ececec" });
  assert.match(dark.swatches.background, /^#[0-9a-f]{6}$/);
  const ids = ["book-a-service", "menu-and-hours", "portfolio", "product-launch", "professional-services", "community", "salon", "clinic"];
  assert.equal(new Set(ids.map(T.templateHue)).size, ids.length);
});

const S = loadTs(path.join(__dirname, "../src/features/build/siteTheme.ts"));
const tokens = (extra = {}) => ({
  name: "Fresh",
  colors: { primary: "#2255FF", background: "#ffffff", foreground: "#111111", accent: "#ffcc00" },
  fonts: { display: "Fraunces", body: "Inter" },
  radius: "0.5rem",
  ...extra,
});

test("theme read: a bad theme is none, logo switches only with logo_ai", () => {
  const ok = S.readSiteTheme({ theme: tokens(), fonts: ["Inter", 3], radii: ["0"], logo_ai: true, logo_preview_free: true });
  assert.equal(ok.theme.fonts.display, "Fraunces");
  assert.deepEqual(plain(ok.fonts), ["Inter"]);
  assert.equal(ok.logo_preview_free, true);
  const off = S.readSiteTheme({ theme: { colors: {} }, logo_ai: false, logo_preview_free: true });
  assert.equal(off.theme, null);
  assert.equal(off.logo_preview_free, false);
});

test("site app id: only a uuid site id makes site:<id>", () => {
  assert.equal(S.siteAppId("0F8FAD5B-D9CB-469F-A165-70867728950E"), "site:0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(S.siteAppId("not-a-uuid"), null);
  assert.equal(S.siteAppId(null), null);
});

test("theme changes: only changed fields, colour case ignored; Apply adds the logo", () => {
  const cur = tokens();
  assert.equal(S.themeChanges(cur, tokens({ colors: { ...cur.colors, primary: "#2255ff" } })), null);
  assert.deepEqual(plain(S.themeChanges(cur, tokens({ colors: { ...cur.colors, accent: "#00aa00" }, radius: "1rem" }))), {
    kind: "theme",
    colors: { accent: "#00aa00" },
    radius: "1rem",
  });
  assert.deepEqual(plain(S.themeChanges(cur, tokens({ fonts: { display: "Fraunces", body: "Lora" } }))), { kind: "theme", fonts: { body: "Lora" } });
  assert.equal(S.applyOp(null, null), null);
  assert.deepEqual(plain(S.applyOp(null, { id: "p1", src: "data:image/svg+xml,x", free: true })), { kind: "theme", logo: { preview_id: "p1" } });
  assert.equal(S.applyScope(true, true), "Saves theme and logo");
  assert.equal(S.applyScope(false, true), "Saves the logo");
  assert.equal(S.applyScope(true, false), "Saves the theme");
  assert.equal(S.applyScope(false, false), null);
});

test("colour boxes take #rgb, #rrggbb or bare hex; anything else is not yet a colour", () => {
  assert.equal(S.readHex("#ABC"), "#aabbcc");
  assert.equal(S.readHex("12ab9F"), "#12ab9f");
  assert.equal(S.readHex("#12ab9"), null);
  assert.equal(S.readHex("red"), null);
});

test("logo: description bounds, cost line, preview read, refusals", () => {
  assert.equal(S.logoReady("  a  b "), true);
  assert.equal(S.logoReady("ab"), false);
  assert.equal(S.logoCostLine(true, false), "Your first logo for this site is free.");
  assert.equal(
    S.logoCostLine(false, true),
    "Each new logo uses AI credits. Made in the colours on the Theme tab, including ones you haven't applied.",
  );
  assert.equal(S.readLogoPreview({ preview: { id: "p", src: "data:image/png;base64,x", free: true } }), null);
  assert.deepEqual(plain(S.readLogoPreview({ preview: { id: "p", src: "data:image/svg+xml;base64,PHN2Zy8+", free: 1 } })), {
    id: "p",
    src: "data:image/svg+xml;base64,PHN2Zy8+",
    free: false,
  });
  assert.equal(S.refusalNote({ status: 403, code: "forbidden", message: "no" }).text, "Viewers can't change the site. Ask a workspace owner, admin or member.");
  assert.deepEqual(plain(S.refusalNote({ status: 409, code: "build_active", message: "A build is running." })), { tone: "busy", text: "A build is running." });
  assert.deepEqual(plain(S.refusalNote(new Error(""))), { tone: "error", text: S.SITE_DESIGN_FAILED });
});

test("logo data URL decodes base64 (UTF-8) and URL-encoded SVG", () => {
  const svg = '<svg viewBox="0 0 10 10"><title>Café</title></svg>';
  const b64 = Buffer.from(svg, "utf8").toString("base64");
  assert.equal(S.svgFromDataUrl(`data:image/svg+xml;base64,${b64}`), svg);
  assert.equal(S.svgFromDataUrl(`data:image/svg+xml,${encodeURIComponent(svg)}`), svg);
  assert.equal(S.svgFromDataUrl("data:image/png;base64,AAAA"), null);
  assert.equal(S.svgFromDataUrl("data:image/svg+xml;base64,@@@"), null);
});
