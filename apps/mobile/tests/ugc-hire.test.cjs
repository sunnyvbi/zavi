const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const shared = loadTs(path.join(__dirname, "../../../packages/shared/src/creators/fees.ts"));
const h = loadTs(path.join(__dirname, "../src/features/channels/ugcHire.ts"), { "@zavi/shared": shared });
const plain = (v) => JSON.parse(JSON.stringify(v));

const NOW = Date.parse("2026-10-07T12:00:00Z");
const brief = (o = {}) => ({ id: "b1", title: "Spring launch", status: "sent", application_count: 3, created_at: "2026-10-07T09:00:00Z", posted_at: "2026-10-06T00:00:00Z", answer_by: "2026-10-09T23:59:59Z", closed_at: null, utm_campaign: null, ...o });
const fees = (price, fee, total) => ({ price_cents: price, business_fee_cents: fee, business_total_cents: total, creator_fee_cents: 0, creator_payout_cents: 0, zavi_gross_cents: 0, currency: "usd" });
const applicant = (o = {}) => ({ application_id: "app1", human_member_id: "m1", display_name: "Maya Films", city: "Austin", country_code: "US", bookable: true, status: "applied", note: "I shoot food.", fees: fees(15000, 1500, 16500), hire_state: null, ...o });
const quote = (o = {}) => ({
  source: "booking",
  creator: { human_member_id: "m1", display_name: "Maya Films", city: "Austin", country_code: "US" },
  job: { title: "Starter video", kind: "ugc_video", delivery_days: 7, package_id: "p1", offer_id: null, application_id: null, brief_id: null },
  money: { currency: "usd", price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500, business_fee_label: "10%" },
  due_at: null,
  due_after_accept: "7 days after Maya accepts",
  product_needed: false,
  needs_large_amount_confirm: false,
  large_amount_confirm_cents: 50000,
  blocked: null,
  ...o,
});
const pkg = (o = {}) => ({ id: "p1", kind: "ugc_video", title: "Starter video", price_cents: 15000, business_total_cents: 16500, delivery_days: 7, video_count: 1, video_length_seconds: 30, ad_rights_days: 90, ...o });
const offer = (o = {}) => ({
  id: "o1",
  human_member_id: "m1",
  proposed_by: "creator",
  kind: "ugc_video",
  terms: { title: "2 UGC videos" },
  price_cents: 20000,
  delivery_days: 5,
  note: null,
  status: "open",
  created_at: "2026-10-04T16:40:00Z",
  product_needed: false,
  fees: { price_cents: 20000, business_fee_cents: 2000, business_total_cents: 22000 },
  expired: false,
  ...o,
});
const ctx = (mode, o = {}) => ({ mode, quote: null, offer: null, card: null, bench: null, ...o });
const NO_IDS = ["tenant_id", "tenant", "member_id", "human_member_id", "user_id"];
const noIds = (body) => {
  for (const k of NO_IDS) assert.ok(!(k in body), `body carries ${k}`);
};

test("brief rows: plain-word chips, the lane words, and where a tap goes", () => {
  const open = plain(h.briefListRow(brief(), NOW));
  assert.equal(open.title, "Spring launch");
  assert.equal(open.sub, "Written 3 hours ago");
  assert.equal(open.line, "3 applied · answer by Oct 9");
  assert.deepEqual(open.chip, { label: "Open", tone: "alert" });
  assert.deepEqual(open.to, { pathname: "/channels/ugc/applicants/[id]", params: { id: "b1" } });

  const draft = plain(h.briefListRow(brief({ status: "draft", posted_at: null, title: "", utm_campaign: "zavi-spring" }), NOW));
  assert.equal(draft.title, "Untitled brief");
  assert.equal(draft.sub, "Written 3 hours ago · zavi-spring");
  assert.equal(draft.line, "Not posted yet");
  assert.equal(draft.chip.label, "Draft");
  assert.deepEqual(draft.to, { pathname: "/channels/ugc/brief/[id]", params: { id: "b1" } });

  const closed = plain(h.briefListRow(brief({ closed_at: "2026-10-05T10:00:00Z" }), NOW));
  assert.equal(closed.line, "3 applied · closed Oct 5");
  assert.deepEqual(closed.chip, { label: "Closed", tone: "soft" });
  assert.equal(h.briefChip(brief({ status: "filled", closed_at: "2026-10-05T10:00:00Z" })).label, "Hired");
  assert.equal(h.briefChip(brief({ status: "cancelled" })).label, "Cancelled");
  assert.deepEqual(plain(h.NEW_BRIEF_ROUTE), { pathname: "/channels/ugc/brief/[id]", params: { id: "new" } });
  assert.ok(!/[–—]/.test(h.BRIEFS_EMPTY_BODY), "no dashes in the empty copy");
});

test("the applicants lead and status card use web's words and the server's lines", () => {
  const d = {
    applicants: [applicant(), applicant({ application_id: "app2" })],
    order: "Oldest first. Applicants are never ranked by fit or quality.",
    brief: { id: "b1", title: "Spring launch", posted_at: "2026-10-06T00:00:00Z", answer_by: "2026-10-09T23:59:59Z", open: true, closed_reason: null },
    applicant_count: 2,
    spots_line: "18 places left before this brief closes to new applications.",
    answer_by_line: "Everyone who applies hears back by 2026-10-09.",
    decline_note: "Thanks for applying.",
  };
  assert.equal(
    h.applicantsLead(d),
    "2 creators applied. Answer everyone by Oct 9. The brief closes only after your hire payment goes through; then everyone else gets your note: “Thanks for applying.”",
  );
  const s = plain(h.applicantsStatus(d));
  assert.equal(s.chip, "Open for applications");
  assert.equal(s.closed, null);
  assert.equal(s.spots, d.spots_line);
  assert.equal(h.applicantsLead({ ...d, applicants: [applicant()], brief: { ...d.brief, answer_by: null } }).startsWith("1 creator applied. The brief"), true);
  const shut = { ...d.brief, open: false };
  assert.equal(h.closedReasonLine({ ...shut, closed_reason: "filled" }), "Closed: you hired someone and everyone else has been told.");
  assert.equal(h.closedReasonLine({ ...shut, closed_reason: "cap_reached" }), "Closed to new applications: the application limit was reached.");
  assert.equal(h.closedReasonLine({ ...shut, closed_reason: "answer_by_passed" }), "Closed: the answer-by date passed and everyone who applied has been told.");
  assert.equal(h.closedReasonLine({ ...shut, posted_at: null }), "This brief has not been posted yet, so no creator can see it.");
  assert.equal(plain(h.applicantsStatus({ ...d, brief: { ...shut, closed_reason: null } })).chip, "Closed to new applications");
});

test("an applicant card: price, You pay, note, Hire and pay only when hireable, Message always", () => {
  const v = plain(h.applicantCard(applicant(), "b1", true, true, null));
  assert.equal(v.name, "Maya Films");
  assert.equal(v.location, "Austin, US");
  assert.equal(v.price, "$150");
  assert.equal(v.youPay, "You pay $165");
  assert.equal(v.note, "“I shoot food.”");
  assert.equal(v.outcome, null);
  assert.deepEqual(v.hire, { label: "Hire and pay $165", to: { pathname: "/channels/ugc/hire", params: { application: "app1", brief: "b1" } } });
  assert.deepEqual(v.message, { label: "Message Maya", to: { pathname: "/channels/ugc/thread/[id]", params: { id: "m1" } } });

  assert.equal(h.applicantCard(applicant(), "b1", false, true, null).hire, null);
  const noPrice = plain(h.applicantCard(applicant({ fees: null }), "b1", true, true, null));
  assert.equal(noPrice.hire, null);
  assert.equal(noPrice.price, null);
  const abroad = plain(h.applicantCard(applicant({ bookable: false }), "b1", true, true, null));
  assert.equal(abroad.hire, null);
  assert.equal(abroad.notBookable, "Zavi cannot pay creators in this creator's country yet, so they cannot be hired.");
  assert.equal(h.applicantCard(applicant(), "b1", true, false, null).hire, null);
  assert.equal(plain(h.applicantCard(applicant({ status: "rejected" }), "b1", true, true, null)).outcome, "Not hired");
  assert.equal(plain(h.applicantCard(applicant({ display_name: "", note: "" }), "b1", true, true, null)).name, "A Zavi creator");
  assert.equal(plain(h.applicantCard(applicant({ note: "" }), "b1", true, true, null)).note, "They did not leave a note.");
});

test("an unpaid hire offers Finish paying only with the order this device stored", () => {
  const unpaid = applicant({ status: "approved", hire_state: "unpaid" });
  const without = plain(h.applicantCard(unpaid, "b1", true, true, null));
  assert.equal(without.outcome, "Hire not paid, nothing charged");
  assert.equal(without.finishPaying, null);
  assert.equal(without.hire, null);
  const withId = plain(h.applicantCard(unpaid, "b1", true, true, "ord-9"));
  assert.deepEqual(withId.finishPaying, { label: "Finish paying", to: { pathname: "/channels/ugc/job/[id]", params: { id: "ord-9" } } });
  assert.equal(h.applicantCard(unpaid, "b1", true, false, "ord-9").finishPaying, null, "a viewer gets no pay button");
  assert.equal(h.applicantCard(applicant({ status: "approved", hire_state: "hired" }), "b1", true, true, "ord-9").finishPaying, null);
  assert.equal(h.applicantOutcome({ status: "approved", hire_state: "cancelled" }), "Hired, then cancelled");
  assert.equal(h.applicantOutcome({ status: "approved", hire_state: "hired" }), "Hired");
  assert.equal(h.applicationAnswered(unpaid), "Hire not paid, nothing charged.");
  assert.equal(h.applicationAnswered(applicant({ status: "shortlisted" })), null);
});

test("Answer everyone and close: shown while open with someone applied, and its words", () => {
  const d = { applicants: [applicant()], brief: { open: true } };
  assert.equal(h.canAnswerEveryone(d, true), true);
  assert.equal(h.canAnswerEveryone(d, false), false);
  assert.equal(h.canAnswerEveryone({ ...d, brief: { open: false } }, true), false);
  assert.equal(h.canAnswerEveryone({ applicants: [applicant({ status: "shortlisted" })], brief: { open: true } }, true), false);
  const c = plain(h.answerEveryoneCopy("2026-10-09T23:59:59Z"));
  assert.equal(c.lead, "Not hiring anybody from this brief? You can answer everyone now instead of waiting for Oct 9.");
  assert.equal(c.body, "Your note goes to everyone still waiting and the brief closes. Notes cannot be taken back.");
  assert.equal(h.CLOSE_DIALOG.confirmLabel, "Answer everyone");
  assert.equal(h.CLOSE_DIALOG.cancelLabel, "Not now");
  assert.equal(h.closeBriefPath("b 1"), "/api/humans/briefs/b%201/close");
  assert.equal(h.closedMessage({ undo_message: "2 applicants have been told. Notes cannot be taken back." }), "2 applicants have been told. Notes cannot be taken back.");
  assert.equal(h.closedMessage({}), "The brief is closed.");
});

test("the creator summary: reviews, lanes, typed follower counts, packages with web's terms", () => {
  const card = {
    human_member_id: "m1",
    display_name: "Maya Films",
    lanes: ["ugc_video"],
    rating: { average: 4.8, count: 12 },
    socials: [{ platform: "instagram", handle: "maya", url: "https://instagram.com/maya", followers: 192000, label: "self-reported" }],
    packages: [pkg(), pkg({ id: "p2", title: "Three videos", video_count: 3, video_length_seconds: null, ad_rights_days: 30 })],
  };
  const s = plain(h.creatorSummary(card));
  assert.equal(s.rating, "4.8 (12 reviews)");
  assert.equal(s.lanes, "UGC video");
  assert.deepEqual(s.socials[0], { key: "instagram:maya", handle: "@maya", followers: "192,000 followers", url: "https://instagram.com/maya", platform: "instagram", viewLabel: "View on Instagram" });
  assert.equal(s.followersNote, "Follower numbers: self-reported");
  assert.deepEqual(s.packages[0], { id: "p1", head: "Starter video, $150", terms: "1 UGC video · 30s · ad rights 90 days · delivered in 7 days · 2 rounds of changes" });
  assert.equal(s.packages[1].terms, "3 UGC videos · ad rights 30 days · delivered in 7 days · 2 rounds of changes");
  assert.equal(plain(h.creatorSummary({ ...card, rating: { average: null, count: 0 } })).rating, "No reviews yet");
  assert.equal(h.termsLine(pkg({ video_count: 3, video_length_seconds: null, ad_rights_days: null })), "3 UGC videos · delivered in 7 days · 2 rounds of changes");
});

test("the door comes from the link: application, else offer, else package", () => {
  assert.equal(h.hireMode({ application: "a", brief: "b", offer: "o" }), "application");
  assert.equal(h.hireMode({ offer: "o", package: "p" }), "offer");
  assert.equal(h.hireMode({ package: "p" }), "package");
  assert.equal(h.hireMode({}), null);
});

test("the quote body: the target alone, plus product_needed when the founder says Yes", () => {
  assert.deepEqual(plain(h.quoteBody("package", { package: "p1" }, false)), { target: { package_id: "p1" } });
  assert.deepEqual(plain(h.quoteBody("package", { package: "p1" }, true)), { target: { package_id: "p1" }, product_needed: true });
  assert.deepEqual(plain(h.quoteBody("application", { application: "app1", brief: "b1" }, true)), { target: { application_id: "app1" } });
});

test("titles per door, and an unknown creator stays 'the creator', never 'the'", () => {
  const q = quote();
  assert.equal(h.hireTitle(ctx("package", { quote: q })), "Book Maya Films");
  assert.equal(h.hireTitle(ctx("application", { quote: q })), "Hire Maya Films");
  assert.equal(h.hireTitle(ctx("offer", { offer: offer(), card: { display_name: "Maya Films", city: null, packages: [] } })), "Accept Maya's offer");
  assert.equal(h.hireTitle(ctx("offer", { offer: offer({ proposed_by: "tenant" }), card: { display_name: "Maya Films", city: null, packages: [] } })), "Maya accepted. Pay to start");
  assert.equal(h.hireTitle(ctx("offer", { offer: offer() })), "Accept the creator's offer");
  assert.equal(h.hireTitle(ctx("offer", { offer: offer({ proposed_by: "tenant" }) })), "The creator accepted. Pay to start");
  assert.equal(h.hireLoadingTitle, "Checkout");
});

test("the job card per door: title, terms line and who", () => {
  const card = { display_name: "Maya Films", city: "Austin", packages: [pkg()] };
  const p = plain(h.jobCard(ctx("package", { quote: quote(), card, packageId: "p1" })));
  assert.deepEqual(p, { title: "Starter video", terms: "1 UGC video · 30s · ad rights 90 days · delivered in 7 days · 2 rounds of changes", who: "Maya Films · Austin" });

  const app = plain(
    h.jobCard(ctx("application", { quote: quote({ job: { ...quote().job, title: "Spring launch" } }), bench: { deliverables: 2, lane: "ugc_video", format: "Vertical 9:16", delivery_days: 10 } })),
  );
  assert.equal(app.title, "Spring launch");
  assert.equal(app.terms, "2 UGC videos · Vertical 9:16 · delivered in 10 days after hire · 2 rounds of changes");
  assert.equal(plain(h.jobCard(ctx("application", { quote: quote(), bench: { deliverables: null, lane: null, format: null, delivery_days: null } }))).terms, "1 UGC video · 2 rounds of changes");

  const off = plain(h.jobCard(ctx("offer", { offer: offer(), card })));
  assert.equal(off.title, "Custom offer from Maya Films");
  assert.equal(off.terms, "2 UGC videos · delivered in 5 days after it starts · 2 rounds of changes");
  assert.equal(plain(h.jobCard(ctx("offer", { offer: offer({ proposed_by: "tenant", terms: { title: "1 Reel", due_date: "2026-10-11" } }), card }))).terms, "1 Reel · due Oct 11 · 2 rounds of changes");
  assert.equal(plain(h.jobCard(ctx("offer", { offer: offer({ proposed_by: "tenant" }), card }))).title, "Your custom offer to Maya Films");
});

test("the card under the job per door", () => {
  const app = plain(h.modeCard(ctx("application", { quote: quote({ product_needed: true }) }), "I shoot food."));
  assert.deepEqual(app, { kind: "application", noteTitle: "Maya's note", note: "“I shoot food.”", product: "Yes, from your brief." });
  assert.equal(plain(h.modeCard(ctx("application", { quote: quote(), bench: { product_needed: false } }), null)).product, "No, from your brief.");
  const off = plain(h.modeCard(ctx("offer", { offer: offer(), card: { display_name: "Maya Films", city: null, packages: [] } }), null));
  assert.equal(off.heading, "The offer, as Maya sent it on Oct 4, 16:40 UTC");
  assert.equal(off.product, "No, from the offer.");
  assert.equal(plain(h.modeCard(ctx("offer", { offer: offer({ proposed_by: "tenant", product_needed: true }) }), null)).heading, "The offer, as you sent it on Oct 4, 16:40 UTC");
  const p = plain(h.modeCard(ctx("package", { quote: quote() }), null));
  assert.equal(p.showLabel, "What the video should show");
  assert.equal(p.productQuestion, "Do you need to send Maya a product?");
});

test("summary rows read the server's numbers; Due only for a package without a product", () => {
  const q = quote();
  const rows = plain(h.summaryRows(ctx("package", { quote: q }), h.moneyOf(ctx("package", { quote: q })), false));
  assert.deepEqual(rows, [
    { label: "Package", value: "$150" },
    { label: "Zavi fee (10%)", value: "$15" },
    { label: "Due", value: "7 days after Maya accepts" },
    { label: "Total", value: "$165", strong: true },
  ]);
  assert.equal(h.summaryRows(ctx("package", { quote: q }), q.money, true).length, 3);
  assert.equal(plain(h.summaryRows(ctx("application", { quote: q }), q.money, false))[0].label, "Maya's price");
  const o = offer();
  const m = h.moneyOf(ctx("offer", { offer: o }));
  assert.deepEqual(plain(m), { price_cents: 20000, business_fee_cents: 2000, business_total_cents: 22000 });
  assert.deepEqual(plain(h.summaryRows(ctx("offer", { offer: o }), m, false)).map((r) => r.label), ["Offer", "Zavi fee (10%)", "Total"]);
  assert.equal(h.payLabel("package", q.money), "Hold $165");
  assert.equal(h.payLabel("application", q.money), "Pay $165");
  assert.equal(h.payLabel("offer", m), "Pay $220");
});

test("the shield sentence per door, and the package one follows the re-quote", () => {
  assert.equal(
    h.shieldNote(ctx("package", { quote: quote() })),
    "Your card is held now, not charged. Maya has 72 hours to accept. If Maya accepts, you are charged and the job starts, due 7 days after Maya accepts. If Maya declines or doesn't answer, the hold is released.",
  );
  assert.equal(
    h.shieldNote(ctx("package", { quote: quote({ due_after_accept: null }) })),
    "Your card is held now, not charged. Maya has 72 hours to accept. If Maya accepts, you are charged and the job starts. If Maya declines or doesn't answer, the hold is released.",
  );
  assert.equal(
    h.shieldNote(ctx("application", { quote: quote() })),
    "Charged now. When the payment goes through, Maya is hired, the brief closes and everyone else gets your note. If it doesn't go through, the brief stays open and nobody is told anything.",
  );
  assert.equal(h.shieldNote(ctx("offer", { offer: offer() })), "Charged now. The job starts as soon as the payment goes through. Zavi keeps the money until you approve the work.");
});

test("blocked quotes, unpayable offers and the over-$500 tick box", () => {
  assert.equal(h.blockOf(ctx("package", { quote: quote({ blocked: { code: "package_inactive", message: "This package is not being offered right now." } }) })), "This package is not being offered right now.");
  assert.equal(h.blockOf(ctx("package", { quote: quote() })), null);
  assert.equal(h.blockOf(ctx("offer", { offer: offer() })), null);
  assert.equal(h.blockOf(ctx("offer", { offer: offer({ status: "accepted", proposed_by: "tenant", awaiting_payment: true }) })), null);
  assert.equal(h.blockOf(ctx("offer", { offer: offer({ status: "accepted", proposed_by: "tenant" }) })), h.OFFER_CHECKING);
  assert.equal(h.blockOf(ctx("offer", { offer: offer({ status: "accepted", proposed_by: "tenant", awaiting_payment: false }) })), h.OFFER_PAID);
  assert.match(h.blockOf(ctx("offer", { offer: offer({ status: "accepted", proposed_by: "tenant", awaiting_payment: false, closed_unpaid: true }) })), /expired/);
  const flagged = h.withPaymentFlags(offer({ id: "of-1", status: "accepted" }), [{ id: "of-2", awaiting_payment: true }, { id: "of-1", awaiting_payment: false, closed_unpaid: false }]);
  assert.equal(flagged.awaiting_payment, false);
  assert.equal(h.withPaymentFlags(offer({ id: "of-1", status: "accepted" }), null).awaiting_payment, undefined);
  assert.equal(h.blockOf(ctx("offer", { offer: offer({ expired: true }) })), "This offer has expired. Ask the creator to send a new one.");
  assert.equal(h.blockOf(ctx("offer", { offer: offer({ status: "declined" }) })), "This offer was already declined.");
  assert.equal(h.blockOf(ctx("offer", { offer: offer({ proposed_by: "tenant" }) })), "The creator has not accepted this offer yet. You can pay once they accept it.");

  const big = quote({ needs_large_amount_confirm: true, money: { currency: "usd", price_cents: 50000, business_fee_cents: 5000, business_total_cents: 55000 } });
  assert.equal(h.largeConfirm(ctx("package", { quote: big }), big.money), "This is over $500. I want Zavi to hold $550 on this card.");
  assert.equal(h.largeConfirm(ctx("package", { quote: quote() }), quote().money), null);
});

test("package order body: return_path ugc, the brief only when typed, confirm only when ticked on a big total", () => {
  const p = { package: "p1" };
  const plainBody = plain(h.payRequest(ctx("package", { quote: quote() }), p, { confirmed: false, show: "   ", product: false }));
  assert.deepEqual(plainBody, { path: "/api/humans/orders", body: { target: { package_id: "p1" }, return_path: "ugc", product_needed: false } });
  noIds(plainBody.body);

  const typed = plain(h.payRequest(ctx("package", { quote: quote({ due_at: "2026-10-20T12:00:00Z" }) }), p, { confirmed: true, show: "  Show the app  ", product: true }));
  assert.deepEqual(typed.body, {
    target: { package_id: "p1" },
    due_at: "2026-10-20T12:00:00Z",
    return_path: "ugc",
    brief_title: "Starter video",
    brief: "Show the app",
    product_needed: true,
  });
  assert.ok(!("large_amount_confirmed" in typed.body));

  const big = quote({ needs_large_amount_confirm: true });
  assert.equal(plain(h.payRequest(ctx("package", { quote: big }), p, { confirmed: true, show: "", product: false })).body.large_amount_confirmed, true);
  assert.ok(!("large_amount_confirmed" in plain(h.payRequest(ctx("package", { quote: big }), p, { confirmed: false, show: "", product: false })).body));
  assert.equal(h.payRequest(ctx("package", { quote: null }), p, { confirmed: false, show: "", product: false }), null);
});

test("hire body: the application id in the body, the brief in the path, confirm only when ticked", () => {
  const q = quote({ source: "applicant", needs_large_amount_confirm: true, job: { ...quote().job, brief_id: "b-from-quote" } });
  const r = plain(h.payRequest(ctx("application", { quote: q }), { application: "app1", brief: "b 1" }, { confirmed: true, show: "ignored", product: true }));
  assert.deepEqual(r, { path: "/api/humans/briefs/b%201/hire", body: { application_id: "app1", large_amount_confirmed: true } });
  noIds(r.body);
  assert.deepEqual(plain(h.payRequest(ctx("application", { quote: q }), { application: "app1" }, { confirmed: false, show: "", product: false })), {
    path: "/api/humans/briefs/b-from-quote/hire",
    body: { application_id: "app1" },
  });
});

test("offer doors: accept an open creator offer, resume an accepted one, both with an empty body", () => {
  assert.deepEqual(plain(h.payRequest(ctx("offer", { offer: offer() }), { offer: "o1" }, { confirmed: true, show: "", product: false })), { path: "/api/creators/offers/o1/accept", body: {} });
  assert.deepEqual(plain(h.payRequest(ctx("offer", { offer: offer({ status: "accepted" }) }), { offer: "o1" }, { confirmed: false, show: "", product: false })), {
    path: "/api/creators/offers/o1/checkout",
    body: {},
  });
});

test("what each door answered, and the total-changed guard", () => {
  const pk = plain(h.readPayAnswer("package", { order_id: "ord1", checkout_url: "https://checkout.stripe.com/x", quote: { money: { price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500 } } }));
  assert.deepEqual(pk, { orderId: "ord1", url: "https://checkout.stripe.com/x", money: { price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500 } });
  const hire = plain(h.readPayAnswer("application", { order_id: "ord2", checkout_url: null, fees: fees(16000, 1600, 17600) }));
  assert.deepEqual(hire, { orderId: "ord2", url: null, money: { price_cents: 16000, business_fee_cents: 1600, business_total_cents: 17600 } });
  assert.deepEqual(plain(h.readPayAnswer("offer", { offer: {}, order: { order_id: "ord3", checkout_url: "u" } })), { orderId: "ord3", url: "u", money: null });
  assert.deepEqual(plain(h.readPayAnswer("offer", { order_id: "ord4", checkout_url: "v" })), { orderId: "ord4", url: "v", money: null });

  assert.equal(h.priceMoved(16500, pk.money), false);
  assert.equal(h.priceMoved(16500, hire.money), true);
  assert.equal(h.priceMoved(16500, null), false, "an offer answers no total: nothing to compare");
  assert.equal(h.priceMovedNote(17600), "The price changed to $176. Check it and pay again.");
  assert.equal(h.NO_CHECKOUT, "Zavi could not open the payment page. Nothing was charged. Try again in a moment.");
});

test("the unpaid-hire memory: per workspace, newest last, at most 50, junk reads as empty", () => {
  assert.equal(h.pendingHireKey("t1"), "zavi.ugc.pendingHire.t1");
  assert.deepEqual(plain(h.readPendingHires(null)), {});
  assert.deepEqual(plain(h.readPendingHires("not json")), {});
  assert.deepEqual(plain(h.readPendingHires("[1,2]")), {});
  assert.deepEqual(plain(h.readPendingHires('{"a":"o1","b":7}')), { a: "o1" });

  let raw = h.withPendingHire(null, "a", "o1");
  raw = h.withPendingHire(raw, "b", "o2");
  raw = h.withPendingHire(raw, "a", "o3");
  assert.deepEqual(Object.entries(JSON.parse(raw)), [["b", "o2"], ["a", "o3"]]);
  for (let i = 0; i < 60; i++) raw = h.withPendingHire(raw, `app${i}`, `ord${i}`);
  const kept = JSON.parse(raw);
  assert.equal(Object.keys(kept).length, 50);
  assert.equal(kept.app59, "ord59");
  assert.equal(kept.app9, undefined);
});

test("offer card buttons: Decline and Accept and pay on a creator's open offer, Pay on an accepted unpaid one", () => {
  const answer = plain(h.offerCardActions(offer(), "Maya"));
  assert.deepEqual(answer, { kind: "answer", decline: "Decline", accept: "Accept and pay", to: { pathname: "/channels/ugc/hire", params: { offer: "o1" } } });
  assert.equal(h.offerCardActions(offer({ proposed_by: "tenant" }), "Maya"), null, "your own open offer keeps Withdraw");
  assert.equal(h.offerCardActions(offer({ expired: true }), "Maya"), null);
  const pay = plain(h.offerCardActions(offer({ status: "accepted", proposed_by: "tenant", awaiting_payment: true }), "Maya"));
  assert.equal(pay.kind, "pay");
  assert.equal(pay.title, "Maya accepted. Pay to start");
  assert.equal(pay.body, "Charged now. The job starts as soon as the payment goes through. Zavi keeps the money until you approve the work.");
  assert.equal(pay.label, "Pay $220");
  assert.equal(plain(h.offerCardActions(offer({ status: "accepted", awaiting_payment: true }), "Maya")).title, "You accepted. Pay to start");
  assert.equal(h.offerCardActions(offer({ status: "accepted", awaiting_payment: true, closed_unpaid: true }), "Maya"), null);
  assert.equal(h.offerCardActions(offer({ status: "accepted", awaiting_payment: false }), "Maya"), null);

  assert.equal(h.offerCardHint(offer(), "Maya"), "Accept and pay charges your card now and the job starts. No 72 hour wait, because Maya made the offer.");
  assert.equal(h.offerCardHint(offer({ status: "accepted", awaiting_payment: true }), "Maya"), null);
  assert.equal(h.offerCardHint(offer({ proposed_by: "tenant" }), "Maya"), "If Maya accepts, you are asked to pay and the job starts.");
  assert.equal(h.offerDeclinePath("o1"), "/api/creators/offers/o1/decline");
});

test("the published brief and the profile's Book buttons", () => {
  assert.equal(h.seeApplicantsLabel(1), "See 1 applicant");
  assert.equal(h.seeApplicantsLabel(4), "See 4 applicants");
  assert.deepEqual(plain(h.applicantsRoute("b1")), { pathname: "/channels/ugc/applicants/[id]", params: { id: "b1" } });
  assert.equal(h.REPOST_DIALOG.message, "This closes the brief and sends every pending applicant your note, then opens an editable copy to post again. Continue?");
  assert.equal(h.REPOST_DIALOG.confirmLabel, "Close and repost");
  assert.equal(h.bookLabel(pkg()), "Book · $165");
  assert.deepEqual(plain(h.bookRoute(pkg())), { pathname: "/channels/ugc/hire", params: { package: "p1" } });
});

function loadHooks() {
  const calls = [];
  const invalidated = [];
  const cache = [];
  const store = new Map();
  class ApiFetchError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  const hooks = loadTs(path.join(__dirname, "../src/features/channels/ugcHireHooks.ts"), {
    "@zavi/shared": shared,
    react: { useCallback: (f) => f },
    "@react-native-async-storage/async-storage": {
      __esModule: true,
      default: { getItem: async (k) => (store.has(k) ? store.get(k) : null), setItem: async (k, v) => void store.set(k, v) },
    },
    "@tanstack/react-query": {
      useQuery: (o) => o,
      useMutation: (o) => o,
      useQueryClient: () => ({
        invalidateQueries: (x) => {
          invalidated.push(x);
          return new Promise(() => {});
        },
        setQueryData: (k, v) => cache.push([k, v]),
      }),
    },
    "../../lib/api": {
      ApiFetchError,
      apiJson: async (p, o) => {
        calls.push({ path: p, ...(o ?? {}) });
        return { ok: true };
      },
    },
    "../workspaces/useActiveTenant": { useActiveTenant: () => "t1" },
    "./ugcHooks": { ugcKey: (t, ...rest) => ["ugc", t, ...rest] },
  });
  return { hooks, calls, invalidated, cache, store, ApiFetchError };
}

test("every money write is one POST: no Idempotency-Key, no network retry, invalidates the workspace", async () => {
  const { hooks, calls, invalidated } = loadHooks();
  const pay = hooks.usePayCheckout();
  const req = h.payRequest(ctx("package", { quote: quote() }), { package: "p1" }, { confirmed: false, show: "", product: false });
  await pay.mutationFn(req);
  const close = hooks.useCloseBrief();
  await close.mutationFn("b1");
  const decline = hooks.useDeclineOffer();
  await decline.mutationFn("o1");
  assert.deepEqual(
    calls.map((c) => [c.path, c.method]),
    [
      ["/api/humans/orders", "POST"],
      ["/api/humans/briefs/b1/close", "POST"],
      ["/api/creators/offers/o1/decline", "POST"],
    ],
  );
  for (const c of calls) {
    assert.equal(c.idempotent, undefined, `${c.path} sends no Idempotency-Key`);
    assert.equal(c.retryOnNetworkError, false, `${c.path} is never replayed`);
  }
  assert.deepEqual(JSON.parse(calls[0].body), { target: { package_id: "p1" }, return_path: "ugc", product_needed: false });
  assert.deepEqual(JSON.parse(calls[1].body), {});
  for (const m of [pay, close, decline]) assert.equal(m.onSuccess(), undefined);
  assert.deepEqual(plain(invalidated), [{ queryKey: ["ugc", "t1"] }, { queryKey: ["ugc", "t1"] }, { queryKey: ["ugc", "t1"] }]);
});

test("reads: the quote is a POST of its body keyed per workspace, applicants and the offer are GETs", async () => {
  const { hooks, calls, ApiFetchError } = loadHooks();
  const q = hooks.useQuote({ target: { package_id: "p1" }, product_needed: true });
  assert.deepEqual(plain(q.queryKey), ["ugc", "t1", "quote", '{"target":{"package_id":"p1"},"product_needed":true}']);
  assert.equal(q.enabled, true);
  await q.queryFn().catch(() => {});
  assert.deepEqual([calls[0].path, calls[0].method, JSON.parse(calls[0].body)], ["/api/humans/orders/quote", "POST", { target: { package_id: "p1" }, product_needed: true }]);
  assert.equal(hooks.useQuote(null).enabled, false, "a viewer asks for no price");
  assert.equal(q.placeholderData("prev", { queryKey: ["ugc", "t1", "quote", "x"] }), "prev");
  assert.equal(q.placeholderData("prev", { queryKey: ["ugc", "t2", "quote", "x"] }), undefined);
  assert.equal(q.retry(0, new ApiFetchError(404, "package_not_found", "gone")), false);
  assert.equal(q.retry(0, new ApiFetchError(503, "down", "down")), true);

  const a = hooks.useBriefApplicants("b1");
  assert.deepEqual(plain(a.queryKey), ["ugc", "t1", "applicants", "b1"]);
  await a.queryFn();
  const o = hooks.useOffer("o 1");
  await o.queryFn().catch(() => {});
  assert.deepEqual(calls.slice(1).map((c) => [c.path, c.method]), [["/api/humans/briefs/b1/applicants", undefined], ["/api/creators/offers/o%201", undefined]]);
  assert.equal(hooks.useBriefApplicants("").enabled, false);
});

test("a hire's order is stored before Stripe, per workspace, and read back for Finish paying", async () => {
  const { hooks, store, cache } = loadHooks();
  const remember = hooks.useRememberHire();
  await remember("t1", "app1", "ord1");
  await remember("t1", "app2", "ord2");
  assert.deepEqual(JSON.parse(store.get("zavi.ugc.pendingHire.t1")), { app1: "ord1", app2: "ord2" });
  assert.deepEqual(plain(cache.at(-1)), [["ugc", "t1", "pending-hires"], { app1: "ord1", app2: "ord2" }]);
  const read = hooks.usePendingHires();
  assert.deepEqual(plain(read.queryKey), ["ugc", "t1", "pending-hires"]);
  assert.deepEqual(plain(await read.queryFn()), { app1: "ord1", app2: "ord2" });
});

test("an offer accept the server had already done comes back with its order and no payment page", () => {
  const replay = h.readPayAnswer("offer", { ok: true, order: { order_id: "o-9", status: "in_progress", already_existed: true } });
  assert.equal(replay.orderId, "o-9");
  assert.equal(replay.url, null);
});
