const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadTs } = require("./helpers/load-ts.cjs");

const J = loadTs(path.join(__dirname, "../src/features/channels/ugcJob.ts"));
const plain = (v) => JSON.parse(JSON.stringify(v));

const ID = "1a2b3c4d-0000-4000-8000-000000000001";
const job = (o = {}) => ({
  id: ID,
  source: "booking",
  status: "in_progress",
  closed_reason: null,
  title: "1 UGC video",
  creator_display_name: "Maya Films",
  human_member_id: "m1",
  created_at: "2026-10-01T10:00:00Z",
  due_at: "2026-10-09T00:00:00Z",
  closed_at: null,
  money: { currency: "usd", price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500, business_fee_label: "10%", payout_status: "not_due" },
  deadline: null,
  awaiting_creator: false,
  ...o,
});
const detail = (jo = {}, o = {}) => ({
  job: job(jo),
  package_snapshot: { kind: "ugc_video", delivery_days: 7, video_count: 1, video_length_seconds: 30, ad_rights_days: 90 },
  brief_snapshot: null,
  submissions: [],
  actions: [],
  rebook: null,
  revisions: { used: 0, left: 2, max: 2 },
  extension: null,
  dispute: null,
  thread: { available: true, thread_id: "t1", messages: [] },
  change_requests: [],
  receipt: null,
  ...o,
});
const deadline = (at, kind = "review") => ({ kind, deadline_at: at, deadline_text: "x", consequence_text: "y", line: "Deadline: x. y" });
const sub = (o = {}) => ({ id: "s1", version: 1, position: 0, kind: "video", note: null, created_at: "2026-10-04T16:40:00Z", play_url: "https://signed/1", ...o });
const act = (action, label, consequence = `${label} does a thing.`, wants_note) => ({ action, label, consequence, ...(wants_note === undefined ? {} : { wants_note }) });
const view = (d, p) => plain(J.jobView(d, p));

test("the top bar: Job before load, Payment not finished for an unpaid order, Review on a delivery, else the job number", () => {
  assert.equal(J.screenTitle(undefined), "Job");
  assert.equal(J.screenTitle(detail({ status: "checkout_pending" })), "Payment not finished");
  assert.equal(J.screenTitle(detail({ status: "cancelled", closed_reason: "checkout_abandoned" })), "Payment not finished");
  assert.equal(J.screenTitle(detail({ status: "submitted" })), "Review Maya's video");
  assert.equal(J.screenTitle(detail({ status: "submitted", creator_display_name: null })), "Review the creator's video");
  assert.equal(J.screenTitle(detail({ status: "in_progress" })), "Job #1a2b3c4d");
});

test("the header says the total with the fee, and the job number only once it is paid", () => {
  assert.equal(J.headerTitle(job()), "Maya Films: 1 UGC video");
  assert.equal(J.headerTitle(job({ creator_display_name: null })), "Creator: 1 UGC video");
  assert.equal(J.headerSub(job()), "$165 with Zavi's fee · Job #1a2b3c4d");
  assert.equal(J.headerSub(job({ status: "checkout_pending" })), "$165 with Zavi's fee");
});

test("stageOf: where the job is, and no stepper for an unpaid, cancelled or mediated job", () => {
  assert.equal(J.stageOf("awaiting_acceptance"), 1);
  for (const s of ["in_progress", "revision_requested", "cancel_requested", "in_dispute"]) assert.equal(J.stageOf(s), 2);
  assert.equal(J.stageOf("submitted"), 3);
  assert.equal(J.stageOf("completed", "approved"), 4);
  assert.equal(J.stageOf("completed", "auto_accepted"), 4);
  assert.equal(J.stageOf("completed", "mediation_pay_full"), null);
  assert.equal(J.stageOf("checkout_pending"), null);
  assert.equal(J.stageOf("cancelled", "withdrawn"), null);
});

test("checkout_pending: a staff hold or a cancel shows the server's message and never a pay button", () => {
  const staff = view(detail({ status: "checkout_pending" }), { problem: "needs_staff", message: "Captured before the job." });
  assert.deepEqual(staff.chip, ["red", "Zavi staff are checking this"]);
  assert.equal(staff.title, "Zavi staff have to look at this");
  assert.deepEqual(staff.body, ["Captured before the job.", "Do not pay again."]);
  assert.equal(staff.button, undefined);
  const gone = view(detail({ status: "checkout_pending", source: "offer", offer_id: "o1" }), { problem: "cancelled", message: "This offer expired." });
  assert.deepEqual(gone.chip, ["red", "Cancelled"]);
  assert.equal(gone.title, "This job was cancelled");
  assert.deepEqual(gone.body, ["This offer expired."]);
  assert.equal(gone.button, undefined);
});

test("checkout_pending while confirming: a hold for a booking, a payment otherwise, and no button", () => {
  const booking = view(detail({ status: "checkout_pending" }), "confirming");
  assert.deepEqual(booking.chip, ["amber", "Confirming your payment"]);
  assert.equal(booking.title, "Confirming the hold on your card");
  assert.deepEqual(booking.body, ["This takes a few seconds. Do not pay again."]);
  assert.equal(booking.button, undefined);
  assert.equal(view(detail({ status: "checkout_pending", source: "applicant" }), "confirming").title, "Confirming your payment");
  assert.equal(view(detail({ status: "checkout_pending", source: "offer" }), "confirming").title, "Confirming your payment");
});

test("checkout_pending slow: still waiting on the bank, no pay button, only Check again", () => {
  const v = view(detail({ status: "checkout_pending" }), "slow");
  assert.equal(v.title, "Still waiting on your bank");
  assert.match(v.body[0], /^The hold has not come back from your bank yet\./);
  assert.deepEqual(v.button, { kind: "check", label: "Check again", busyLabel: "Checking" });
  assert.match(view(detail({ status: "checkout_pending", source: "offer" }), "slow").body[0], /^The payment has not come back/);
});

test("checkout_pending left: a booking or hire says nothing was charged and resumes the same order", () => {
  for (const source of ["booking", "applicant"]) {
    const v = view(detail({ status: "checkout_pending", source }), "left");
    assert.deepEqual(v.chip, ["amber", "Not paid"]);
    assert.equal(v.title, "Nothing was charged");
    assert.deepEqual(v.body, ["You left the payment page, so nothing was charged and no job was started."]);
    assert.deepEqual(v.button, { kind: "resume", label: "Try again", busyLabel: "Opening the payment page" });
  }
});

test("checkout_pending offer: Pay to start, unless the offer expired (then no button)", () => {
  const pay = view(detail({ status: "checkout_pending", source: "offer", offer_id: "o1" }), "left");
  assert.deepEqual(pay.chip, ["amber", "Not paid"]);
  assert.equal(pay.title, "Pay to start the job");
  assert.deepEqual(pay.body, [
    "You left the payment page, so nothing was charged.",
    "Nothing is charged yet. Paying charges your card and the job starts as soon as the payment goes through.",
  ]);
  assert.equal(pay.button.kind, "pay");
  assert.equal(pay.button.label, "Pay to start");
  const expired = view(detail({ status: "checkout_pending", source: "offer", offer_id: "o1", offer_expired: true }), "left");
  assert.deepEqual(expired.chip, ["zinc", "Closed, not paid"]);
  assert.equal(expired.title, "This offer expired before it was paid");
  assert.deepEqual(expired.body, ["Nothing was charged and no job was started. Send Maya a new offer to work together."]);
  assert.equal(expired.button, undefined);
});

test("a viewer sees the unpaid order without any way to pay or confirm it", () => {
  const v = view(detail({ status: "checkout_pending", source: "offer", offer_id: "o1" }), "viewer");
  assert.equal(v.title, "Payment not finished");
  assert.equal(v.button, undefined);
});

test("awaiting_acceptance: facts from the server's own price and fee (no subtraction) and the accept deadline", () => {
  const d = detail({ status: "awaiting_acceptance", due_at: null, due_after_accept: "7 days after Maya accepts", deadline: deadline("2026-10-04T16:40:00Z", "accept"), money: { ...job().money, business_fee_cents: 1499 } });
  const v = view(d);
  assert.deepEqual(v.chip, ["amber", "Waiting for Maya"]);
  assert.equal(v.title, "Maya has until Oct 4, 16:40 UTC to accept");
  assert.deepEqual(v.facts, [
    { icon: "lock", text: "$165 held on your card, not charged", sub: "Charged only when Maya accepts. $150 price + $14.99 Zavi fee." },
    { icon: "due", text: "Due 7 days after Maya accepts" },
    { icon: "release", text: "No answer by Oct 4, 16:40 UTC? The hold is released", sub: "Same if Maya declines. Nothing is charged." },
    { icon: "mail", text: "We email you when Maya answers" },
  ]);
  assert.equal(v.work, false);
  assert.equal(view(detail({ status: "awaiting_acceptance", deadline: deadline("2026-10-04T16:40:00Z", "accept") })).facts.length, 3);
});

test("in_progress: a new-date ask, waiting for the product, product received, or plain progress", () => {
  const ext = view(detail({ status: "in_progress" }, { extension: { state: "requested", requested_due_at: "2026-10-14T00:00:00Z" } }));
  assert.deepEqual(ext.chip, ["amber", "New date requested"]);
  assert.equal(ext.title, "Maya asked to move the due date from Oct 9 to Oct 14");
  assert.deepEqual(ext.body, ["A creator can ask for one new date before the due date. It only changes if you agree."]);

  const product = view(detail({ status: "in_progress", product_needed: true, product_received_at: null, due_at: null }));
  assert.deepEqual(product.chip, ["amber", "Waiting for your product"]);
  assert.equal(product.title, "Send Maya the product");
  assert.deepEqual(product.body, [
    "Ask Maya for a delivery address in the job chat below, then ship the product.",
    "The 7 days to deliver start when Maya marks Product received. Zavi holds your $165 until you approve the work.",
  ]);

  const received = view(detail({ status: "in_progress", product_needed: true, product_received_at: "2026-10-02T09:00:00Z" }));
  assert.deepEqual(received.chip, ["blue", "Product received, due Oct 9"]);
  assert.equal(received.title, "Maya marked Product received on Oct 2");
  assert.deepEqual(received.body, ["The 7 days to deliver started then, so the work is due Oct 9."]);

  const plainJob = view(detail({ status: "in_progress" }));
  assert.deepEqual(plainJob.chip, ["blue", "In progress, due Oct 9"]);
  assert.equal(plainJob.title, "Maya is working on it. Due Oct 9");
  assert.deepEqual(plainJob.body, ["Zavi holds your $165 until you approve the work."]);
});

test("submitted: delivered or a new version, review-by from the deadline, changes counter, and the work tile", () => {
  const dl = deadline("2026-10-07T16:40:00Z");
  const first = view(detail({ status: "submitted", deadline: dl }, { submissions: [sub()] }));
  assert.deepEqual(first.chip, ["green", "Delivered, review by Oct 7, 16:40 UTC"]);
  assert.equal(first.title, "Maya delivered on Oct 4, 16:40 UTC");
  assert.deepEqual(first.body, [
    "Approve it, or ask for changes that match what you ordered. Changes requested: 0 of 2, 2 left.",
    "If you don't answer by Oct 7, 16:40 UTC (72 hours), the job closes as accepted and Maya is paid 10 days later.",
  ]);
  assert.equal(first.work, true);
  const again = view(
    detail({ status: "submitted", deadline: dl }, { revisions: { used: 2, left: 0, max: 2 }, submissions: [sub({ id: "s3", version: 3, created_at: "2026-10-06T08:05:00Z" }), sub()] }),
  );
  assert.deepEqual(again.chip, ["green", "New version, review by Oct 7, 16:40 UTC"]);
  assert.equal(again.title, "Maya sent a new version on Oct 6, 08:05 UTC");
  assert.equal(again.body[0], "Changes requested: 2 of 2, 0 left. If it still isn't right, ask Zavi for help.");
});

test("revision_requested, cancel_requested and in_dispute say who acts next", () => {
  const once = view(detail({ status: "revision_requested" }, { revisions: { used: 1, left: 1, max: 2 } }));
  assert.deepEqual(once.chip, ["amber", "Changes requested: 1 of 2"]);
  assert.equal(once.title, "You asked Maya for changes");
  assert.deepEqual(once.body, ["Maya is making the change and sends a new version here. Changes requested: 1 of 2, 1 left."]);
  const twice = view(detail({ status: "revision_requested" }, { revisions: { used: 2, left: 0, max: 2 } }));
  assert.equal(twice.title, "You asked Maya for changes again");
  assert.deepEqual(twice.body, ["Maya is making the change and sends a new version here. Changes requested: 2 of 2, 0 left: after this version you can approve it or ask Zavi for help."]);

  const cancel = view(detail({ status: "cancel_requested", deadline: deadline("2026-10-08T10:00:00Z", "cancel_response") }));
  assert.deepEqual(cancel.chip, ["amber", "You asked to cancel, Maya answers by Oct 8, 10:00 UTC"]);
  assert.equal(cancel.title, "Maya has until Oct 8, 10:00 UTC to answer");

  const dispute = view(detail({ status: "in_dispute" }));
  assert.deepEqual(dispute.chip, ["amber", "Zavi is stepping in"]);
  assert.equal(dispute.title, "Zavi staff are looking at this job");
  assert.equal(dispute.body[1], "Both of you get an email when Zavi decides.");
  assert.equal(dispute.work, true);
});

test("closed jobs: every reason's chip, title and body", () => {
  const closed = (closed_reason, o = {}) => view(detail({ status: o.status ?? "cancelled", closed_reason, ...o }));
  const rows = {
    checkout_abandoned: ["Closed, not paid", "The payment was never finished", "Nothing was charged."],
    payment_failed: ["Payment failed, job cancelled", "The charge didn't go through", "The job is cancelled. Nothing was charged."],
    declined: ["Declined, hold released", "Maya passed on this booking", "Nothing was charged and the hold on your card is released."],
    expired: ["No answer, hold released", "Maya didn't answer in 72 hours", "Nothing was charged and the hold on your card is released."],
    withdrawn: ["You cancelled, hold released", "You cancelled before the creator accepted", "Nothing was charged and the hold on your card is released."],
    creator_removed: ["Creator removed, hold released", "Maya is no longer on Zavi", "Nothing was charged and the hold on your card is released."],
    no_show: ["Not delivered, refunded", "Maya didn't deliver in time", "The job is cancelled and your payment is refunded in full."],
    cancel_agreed: ["Cancelled, refunded", "Maya agreed to cancel", "Your payment is refunded in full, including the 10% Zavi fee."],
    cancel_no_response: ["Cancelled, refunded", "Maya didn't answer the cancellation", "72 hours without an answer counts as agreeing. Your payment is refunded in full, including the 10% Zavi fee."],
    mediation_refund: ["Zavi decided: refund", "Zavi decided you are refunded", "Your payment is refunded in full."],
  };
  for (const [reason, [chip, title, body]] of Object.entries(rows)) {
    const v = closed(reason);
    assert.deepEqual(v.chip, ["zinc", chip], reason);
    assert.equal(v.title, title, reason);
    assert.deepEqual(v.body, [body], reason);
    assert.equal(v.work, false, reason);
    assert.equal(v.button, undefined, reason);
  }
  const full = closed("mediation_pay_full", { status: "completed" });
  assert.deepEqual([full.chip[1], full.title, full.body], ["Zavi decided: pay in full", "Zavi decided the creator is paid in full", ["Nothing is refunded."]]);
  assert.equal(full.work, true);
  const part = closed("mediation_pay_part", { status: "completed" });
  assert.deepEqual([part.chip[1], part.title, part.body], ["Zavi decided: pay part", "Zavi decided the creator is paid part", ["The rest of your payment is refunded to your card."]]);
});

test("an applicant hire that never went through says another hire may have filled the brief", () => {
  const v = view(detail({ status: "cancelled", closed_reason: "checkout_abandoned", source: "applicant" }));
  assert.deepEqual(v.chip, ["zinc", "Not hired, hold released"]);
  assert.equal(v.title, "The hire didn't go through");
  assert.deepEqual(v.body, ["The payment was not finished, or another hire filled the brief first. Nothing was charged."]);
});

test("an unknown closed reason is 'This job is closed', never 'Maya This job is closed'", () => {
  for (const reason of [null, "something_new"]) {
    const v = view(detail({ status: "cancelled", closed_reason: reason }));
    assert.deepEqual(v.chip, ["zinc", "Closed"]);
    assert.equal(v.title, "This job is closed");
    assert.deepEqual(v.body, []);
  }
});

test("approved: the agreed price is released, with the package's rights", () => {
  const v = view(detail({ status: "completed", closed_reason: "approved", closed_at: "2026-10-02T12:00:00Z" }));
  assert.deepEqual(v.chip, ["zinc", "Approved and paid"]);
  assert.equal(v.title, "You approved on Oct 2. Maya's payout is released.");
  assert.deepEqual(v.body, [
    "Your agreed $150 payment to Maya is released. If Maya's Stripe setup isn't finished yet, Zavi holds it until it is.",
    "You can run this video as an ad for 90 days, the ad rights in the package.",
  ]);
  assert.equal(v.work, true);
  const old = view(detail({ status: "completed", closed_reason: "approved" }, { package_snapshot: { kind: "audience_post", ad_rights_days: 90, stays_up_days: 30 } }));
  assert.equal(old.title, "You approved. Maya's payout is released.");
  assert.equal(old.body.length, 1);
  assert.ok(!/ad rights|stays up|labelled as an ad/.test(JSON.stringify(old)));
});

test("auto-accepted: inside the 10 days it never adds days to closed_at; after, it says where the payout is", () => {
  const ask = act("ask_zavi_in_buffer", "Ask Zavi to step in", "c", true);
  const open = view(detail({ status: "completed", closed_reason: "auto_accepted", closed_at: "2026-10-02T12:00:00Z" }, { actions: [ask] }));
  assert.deepEqual(open.chip, ["zinc", "Accepted automatically"]);
  assert.equal(open.title, "Nobody reviewed in 72 hours, so the job closed as accepted");
  assert.equal(open.body[0], "Maya is paid 10 days after the job closed. Until then you can ask Zavi to step in, and the payout is held until Zavi decides.");
  assert.equal(open.body[1], "You can run this video as an ad for 90 days, the ad rights in the package.");
  assert.ok(!JSON.stringify(open).includes("Oct 12"), "no date worked out on the phone");
  const after = (payout_status) =>
    view(detail({ status: "completed", closed_reason: "auto_accepted", money: { ...job().money, payout_status } })).body[0];
  assert.equal(after("transferred"), "The 10 days to ask Zavi to step in have passed. Maya's payout is released.");
  assert.equal(after("transferring"), "The 10 days to ask Zavi to step in have passed. Maya's payout is on its way.");
  assert.equal(after("awaiting_payout_account"), "The 10 days to ask Zavi to step in have passed. Zavi pays Maya once their Stripe setup is finished.");
  assert.equal(after("ready"), "The 10 days to ask Zavi to step in have passed. Zavi has not sent Maya's payout yet.");
});

test("an order with no creator name reads 'the creator', never 'The has until'", () => {
  const v = view(detail({ status: "awaiting_acceptance", creator_display_name: null, deadline: deadline("2026-10-04T16:40:00Z", "accept") }));
  assert.equal(v.title, "The creator has until Oct 4, 16:40 UTC to accept");
  assert.deepEqual(v.chip, ["amber", "Waiting for the creator"]);
  assert.equal(view(detail({ status: "cancelled", closed_reason: "declined", creator_display_name: "  " })).title, "The creator passed on this booking");
});

test("the payment check: fulfilled stops at once and re-reads the job", () => {
  let p = J.pollStarted();
  assert.equal(J.paymentState(p), "confirming");
  const r = J.pollAfterTry(p, { state: "fulfilled", order_id: ID, status: "awaiting_acceptance" });
  assert.equal(r.next, "refetch");
  assert.equal(r.poll.running, false);
  assert.equal(J.paymentState(r.poll), "confirming");
  assert.equal(J.pollAfterTry(p, { state: "already_done", status: "in_progress" }).next, "refetch");
});

test("the payment check: cancelled and needs_staff keep the server's message", () => {
  const p = J.pollStarted();
  const c = J.pollAfterTry(p, { state: "cancelled", status: "cancelled", message: "This brief was already filled." });
  assert.equal(c.next, "refetch");
  assert.deepEqual(plain(J.paymentState(c.poll)), { problem: "cancelled", message: "This brief was already filled." });
  const s = J.pollAfterTry(p, { state: "needs_staff", message: "Zavi staff have to sort it out." });
  assert.deepEqual(plain(J.paymentState(s.poll)), { problem: "needs_staff", message: "Zavi staff have to sort it out." });
});

test("the payment check: 12 tries every 2.5 s; a left page ends as 'left', a slow bank as 'slow'", () => {
  assert.equal(J.FULFIL_POLL_MS, 2500);
  assert.equal(J.FULFIL_MAX_TRIES, 12);
  const runOut = (answers) => {
    let p = J.pollStarted();
    const nexts = [];
    for (const a of answers) {
      const r = J.pollAfterTry(p, a);
      p = r.poll;
      nexts.push(r.next);
    }
    return { p, nexts };
  };
  const pending = (reason) => ({ state: "pending", reason });
  for (const reason of ["no_checkout", "no_payment_intent"]) {
    const { p, nexts } = runOut(Array(12).fill(pending(reason)));
    assert.deepEqual(nexts, [...Array(11).fill("wait"), "stop"]);
    assert.equal(J.paymentState(p), "left");
  }
  for (const reason of ["not_held", "brief_held"]) assert.equal(J.paymentState(runOut(Array(12).fill(pending(reason))).p), "slow");
  assert.equal(J.paymentState(runOut(Array(11).fill(pending("no_checkout"))).p), "confirming");
});

test("the payment check: a failed request counts as a try, and an unknown last answer never invites paying again", () => {
  const p = [...Array(11).fill({ state: "pending", reason: "no_payment_intent" }), null].reduce((acc, a) => J.pollAfterTry(acc, a).poll, J.pollStarted());
  assert.equal(p.tries, 12);
  assert.equal(p.running, false);
  assert.equal(J.paymentState(p), "slow");
  const errorsOnly = Array(12).fill(null).reduce((acc, a) => J.pollAfterTry(acc, a).poll, J.pollStarted());
  assert.equal(J.paymentState(errorsOnly), "slow");
  assert.equal(J.paymentState(J.POLL_IDLE), "confirming");
});

test("paying again goes to THIS order: the offer's own checkout, else the order's; never a new order", () => {
  assert.equal(J.checkoutPath(job({ source: "offer", offer_id: "of/1" })), "/api/creators/offers/of%2F1/checkout");
  assert.equal(J.checkoutPath(job({ source: "offer", offer_id: null })), `/api/humans/orders/${ID}/checkout`);
  assert.equal(J.checkoutPath(job({ source: "booking" })), `/api/humans/orders/${ID}/checkout`);
  assert.equal(J.checkoutPath(job({ source: "applicant" })), `/api/humans/orders/${ID}/checkout`);
  assert.equal(J.fulfilPath("a/b"), "/api/humans/orders/a%2Fb/fulfil");
});

const A = {
  approve: act("approve", "Approve and pay", "The job closes and the creator's payout is released straight away.", false),
  request_change: act("request_change", "Request a change", "The creator gets your notes.", true),
  request_cancellation: act("request_cancellation", "Request cancellation", "The creator has 72 hours to agree.", true),
  revoke_cancellation: act("revoke_cancellation", "Take the request back", "The cancellation request disappears.", false),
  withdraw: act("withdraw", "Cancel this booking", "The creator has not accepted yet, so the hold on your card is released and nothing is charged.", false),
  approve_extension: act("approve_extension", "Approve the new date", "The delivery date moves.", false),
  decline_extension: act("decline_extension", "Keep the agreed date", "The agreed delivery date stays.", false),
  ask_zavi: act("ask_zavi", "Ask Zavi to step in", "Zavi staff read the order.", true),
  ask_zavi_in_buffer: act("ask_zavi_in_buffer", "Ask Zavi to step in", "The creator's payout is held until Zavi decides.", true),
};
const grouped = (d) => {
  const g = J.groupActions(J.jobActions(d));
  const ids = (xs) => xs.map((a) => a.action);
  return plain({ primary: ids(g.primary), secondary: ids(g.secondary), loose: ids(g.loose), others: ids(g.others) });
};

test("2.8: the server's list per status, grouped as the drawer does", () => {
  const submitted = detail({ status: "submitted" }, { actions: [A.approve, A.ask_zavi, A.request_cancellation, A.request_change] });
  assert.deepEqual(grouped(submitted), { primary: ["approve"], secondary: ["request_change"], loose: [], others: ["ask_zavi", "request_cancellation"] });
  const ext = detail({ status: "in_progress" }, { actions: [A.approve_extension, A.ask_zavi, A.decline_extension, A.request_cancellation] });
  assert.deepEqual(grouped(ext), { primary: ["approve_extension"], secondary: ["decline_extension"], loose: [], others: ["ask_zavi", "request_cancellation"] });
  assert.deepEqual(grouped(detail({ status: "in_progress" }, { actions: [A.ask_zavi, A.request_cancellation] })).loose, ["ask_zavi", "request_cancellation"]);
  assert.deepEqual(grouped(detail({ status: "awaiting_acceptance" }, { actions: [A.withdraw] })).loose, ["withdraw"]);
  assert.deepEqual(grouped(detail({ status: "cancel_requested" }, { actions: [A.ask_zavi, A.revoke_cancellation] })).loose, ["ask_zavi", "revoke_cancellation"]);
  assert.deepEqual(grouped(detail({ status: "completed", closed_reason: "auto_accepted" }, { actions: [A.ask_zavi_in_buffer] })).loose, ["ask_zavi_in_buffer"]);
  assert.deepEqual(grouped(detail({ status: "in_dispute" }, { actions: [] })), { primary: [], secondary: [], loose: [], others: [] });
});

test("2.8: approve names the price it releases; ask_zavi becomes Ask Zavi for help once no changes are left", () => {
  const labels = (d) => J.jobActions(d).map((a) => a.label);
  assert.deepEqual(labels(detail({ status: "submitted" }, { actions: [A.approve, A.ask_zavi, A.request_cancellation, A.request_change] })), [
    "Approve and release $150",
    "Ask Zavi to step in",
    "Request cancellation",
    "Request a change",
  ]);
  assert.deepEqual(labels(detail({ status: "submitted" }, { revisions: { used: 2, left: 0, max: 2 }, actions: [A.approve, A.ask_zavi, A.request_cancellation] })), [
    "Approve and release $150",
    "Ask Zavi for help",
    "Request cancellation",
  ]);
  assert.deepEqual(labels(detail({ status: "completed" }, { revisions: { used: 2, left: 0, max: 2 }, actions: [A.ask_zavi_in_buffer] })), ["Ask Zavi to step in"]);
});

test("2.8: a tap asks for a note, asks once more (approve, withdraw), or runs at once", () => {
  assert.equal(J.pressKind(A.approve), "approve");
  assert.equal(J.pressKind(A.withdraw), "withdraw");
  for (const k of ["request_change", "request_cancellation", "ask_zavi", "ask_zavi_in_buffer"]) assert.equal(J.pressKind(A[k]), "note", k);
  for (const k of ["revoke_cancellation", "approve_extension", "decline_extension"]) assert.equal(J.pressKind(A[k]), "run", k);
  assert.equal(J.pressKind({ action: "request_change" }), "note");
  assert.equal(J.pressKind({ action: "approve_extension" }), "run");
});

test("the note box asks the right question for each action", () => {
  assert.equal(J.noteLabel(A.request_change), "Request a change: what should change?");
  assert.equal(J.noteLabel(A.request_cancellation), "Request cancellation: why do you want to cancel?");
  assert.equal(J.noteLabel(A.ask_zavi), "Ask Zavi to step in: what should Zavi know?");
  assert.equal(J.noteLabel(A.ask_zavi_in_buffer), "Ask Zavi to step in: what should Zavi know?");
  assert.equal(J.NOTE_MAX, 4000);
});

test("the approve and withdraw dialogs say exactly what they do", () => {
  assert.deepEqual(plain(J.approveDialog(detail({ status: "submitted" }))), {
    title: "Approve and release?",
    message: "Approving releases the agreed $150 price to Maya. The job closes and this cannot be undone.",
    cancelLabel: "Not now",
    confirmLabel: "Yes, release $150",
  });
  assert.deepEqual(plain(J.withdrawDialog(A.withdraw)), {
    title: "Cancel this booking",
    message: "The creator has not accepted yet, so the hold on your card is released and nothing is charged.",
    cancelLabel: "Keep it",
    confirmLabel: "Cancel this booking",
    destructive: true,
  });
});

test("the /actions body carries the action and a trimmed note, never an id", () => {
  assert.deepEqual(plain(J.actionBody("approve")), { action: "approve" });
  assert.deepEqual(plain(J.actionBody("request_change", "  shorter intro \n")), { action: "request_change", note: "shorter intro" });
  assert.deepEqual(plain(J.actionBody("ask_zavi", "   ")), { action: "ask_zavi" });
  assert.equal(J.actionPath(ID), `/api/humans/orders/${ID}/actions`);
});

test("the video tile: the latest version's video, its caption, and only when the status shows work", () => {
  const subs = [sub({ id: "img", version: 2, kind: "image", created_at: "2026-10-05T10:00:00Z" }), sub({ id: "v2", version: 2, position: 1, created_at: "2026-10-05T10:00:00Z" }), sub()];
  const d = detail({ status: "submitted" }, { submissions: subs });
  const t = J.videoTile(d, J.jobView(d));
  assert.equal(t.file.id, "v2");
  assert.equal(t.caption, "30s video · Oct 5");
  const noLen = detail({ status: "submitted" }, { submissions: [sub({ kind: "image" })], package_snapshot: { kind: "ugc_video" } });
  assert.equal(J.videoTile(noLen, { work: true }).caption, "Video · Oct 4");
  assert.equal(J.videoTile(detail({ status: "in_progress" }, { submissions: subs }), { work: false }), null);
  assert.equal(J.videoTile(detail({ status: "submitted" }), { work: true }), null);
});

test("a signed link older than 50 minutes is re-read before playing; videos play in the app when it can", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(J.linkIsStale(now - 49 * 60_000, now), false);
  assert.equal(J.linkIsStale(now - 51 * 60_000, now), true);
  assert.equal(J.linkIsStale(0, now), true);
  assert.equal(J.playMode("video", true), "video");
  assert.equal(J.playMode("raw_footage", true), "video");
  assert.equal(J.playMode("video", false), "open");
  assert.equal(J.playMode("image", false), "image");
  assert.equal(J.playMode("other", true), "open");
  assert.equal(J.NO_VIEW_LINK, "Zavi could not make a viewing link for this file. Try again.");
});

test("history: messages, change requests and versions, oldest first; a change note sent as a message shows once", () => {
  const d = detail(
    { status: "revision_requested" },
    {
      submissions: [sub({ id: "b", version: 1, position: 1, created_at: "2026-10-04T16:41:00Z" }), sub({ id: "a", version: 1, position: 0 })],
      change_requests: [{ round: 1, note: "Shorter intro", created_at: "2026-10-05T09:00:00Z" }],
    },
  );
  const messages = [
    { id: "m1", sender_kind: "tenant", body: "Hi Maya", created_at: "2026-10-03T08:00:00Z" },
    { id: "m2", sender_kind: "tenant", body: " Shorter intro ", created_at: "2026-10-05T09:00:01Z" },
    { id: "m3", sender_kind: "creator", body: "On it", created_at: "2026-10-05T10:00:00Z" },
    { id: "m4", sender_kind: "staff", body: "Zavi here", created_at: "2026-10-05T11:00:00Z" },
  ];
  const h = plain(J.jobHistory(d, messages));
  assert.deepEqual(h.map((e) => e.key), ["m:m1", "v:1", "c:1", "m:m3", "m:m4"]);
  assert.deepEqual(h[1].files.map((f) => f.id), ["a", "b"]);
  assert.equal(h[1].at, "2026-10-04T16:40:00Z");
  assert.equal(h[0].from, "me");
  assert.equal(h[3].from, "creator");
  assert.equal(h[4].from, "zavi");
  assert.equal(J.changeTitle(1, 2), "You asked for changes · round 1 of 2");
  assert.equal(J.deliveryTitle("Maya", 2), "Maya delivered version 2");
  assert.equal(J.NO_CHANGE_NOTE, "No note was added to this request.");
});

test("history: file link words, the empty lines, and when the message box shows", () => {
  assert.equal(J.fileLinkLabel({ kind: "video", play_url: "u" }, 0, 1), "Watch video");
  assert.equal(J.fileLinkLabel({ kind: "video", play_url: "u" }, 1, 2), "Watch file 2");
  assert.equal(J.fileLinkLabel({ kind: "image", play_url: "u" }, 0, 1), "Open file");
  assert.equal(J.fileLinkLabel({ kind: "other", play_url: "u" }, 2, 3), "Open file 3");
  assert.equal(J.fileLinkLabel({ kind: "video", play_url: null }, 0, 2), "File 1: link unavailable right now");
  assert.equal(J.historyEmptyLine(detail({}, { thread: { available: false, thread_id: null, messages: [] } }), 0, "Maya"), "Messages for this job aren't available right now.");
  assert.equal(J.historyEmptyLine(detail(), 0, "Maya"), "No messages with Maya yet.");
  assert.equal(J.historyEmptyLine(detail(), 3, "Maya"), null);
  assert.equal(J.canCompose(detail()), true);
  assert.equal(J.canCompose(detail({ human_member_id: "m1" }, { thread: { available: true, thread_id: null, messages: [] } })), true);
  assert.equal(J.canCompose(detail({ human_member_id: undefined }, { thread: { available: true, thread_id: null, messages: [] } })), false);
  assert.equal(J.canCompose(detail({}, { thread: { available: false, thread_id: "t1", messages: [] } })), false);
  assert.equal(J.historyHeading("Maya"), "History and messages with Maya");
});

test("message stamps: the time today, the day otherwise, on the phone's clock", () => {
  const now = new Date(2026, 9, 7, 18, 0);
  assert.equal(J.stamp(new Date(2026, 9, 7, 15, 5).toISOString(), now), "3:05 PM");
  assert.equal(J.stamp(new Date(2026, 9, 7, 0, 9).toISOString(), now), "12:09 AM");
  assert.equal(J.stamp(new Date(2026, 9, 7, 12, 30).toISOString(), now), "12:30 PM");
  assert.equal(J.stamp(new Date(2026, 8, 24, 9, 0).toISOString(), now), "Sep 24");
  assert.equal(J.stamp("nonsense", now), "");
});

test("receipt: server cents only, Refunded and You paid only after a refund", () => {
  const r = { currency: "usd", price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500, refunded_cents: 0, paid_at: "2026-10-02T09:00:00Z", receipt_url: null, chargeback_status: null };
  assert.deepEqual(plain(J.receiptRows(r)), [
    { label: "Creator price", value: "$150.00", strong: false },
    { label: "Zavi fee", value: "$15.00", strong: false },
    { label: "Charged to your card", value: "$165.00", strong: true },
  ]);
  const refunded = plain(J.receiptRows({ ...r, refunded_cents: 1500 }));
  assert.deepEqual(refunded.slice(3), [
    { label: "Refunded", value: "-$15.00", strong: false },
    { label: "You paid", value: "$150.00", strong: true },
  ]);
  assert.equal(J.receiptStamp(r, ID), "Paid Oct 2, 2026 · Job #1a2b3c4d");
  assert.equal(J.chargebackNote({ chargeback_status: "open" }), "Your bank is disputing this charge. The creator's payout is on hold until it is decided.");
  assert.equal(J.chargebackNote({ chargeback_status: "won" }), null);
  assert.equal(J.receiptRows({ ...r, currency: "eur" })[0].value, "EUR 150.00");
});

test("dispute notice: who asked, the reason, and Zavi's decision", () => {
  assert.deepEqual(plain(J.disputeNotice({ status: "open", opened_by: "tenant", reason: "The video is blurry." })), {
    tone: "warn",
    title: "Zavi is stepping in",
    body: "You asked Zavi to step in: The video is blurry. Zavi staff read the order, the thread and everything submitted, then decide: pay in full, pay part, or refund. The money waits until they do.",
  });
  assert.match(J.disputeNotice({ status: "open", opened_by: "creator", reason: "No reply" }).body, /^The creator asked Zavi to step in: No reply\./);
  assert.deepEqual(plain(J.disputeNotice({ status: "resolved", outcome: "pay_part", resolution_note: "Half was usable.", reason: "x" })), {
    tone: "ok",
    title: "Zavi has decided",
    body: "Zavi paid the creator part of the price and refunded you the rest. Half was usable.",
  });
  assert.equal(J.disputeNotice({ status: "resolved", outcome: "pay_full", reason: "x" }).body, "Zavi paid the creator in full.");
  assert.equal(J.disputeNotice({ status: "resolved", outcome: "refund", reason: "x" }).body, "Zavi refunded you in full.");
  assert.equal(J.disputeNotice(null), null);
});

test("termsLine: the frozen package in Find creators' words", () => {
  assert.equal(J.termsLine({ kind: "ugc_video", video_count: 1, video_length_seconds: 30, ad_rights_days: 90, delivery_days: 7 }), "1 UGC video · 30s · ad rights 90 days · delivered in 7 days · 2 rounds of changes");
  assert.equal(J.termsLine({ kind: "ugc_video", video_count: 3, delivery_days: 10 }), "3 UGC videos · delivered in 10 days · 2 rounds of changes");
  assert.equal(J.termsLine({ kind: "audience_post", platform: "instagram", post_type: "story", post_count: 2, stays_up_days: 30, delivery_days: 5 }), null);
  assert.equal(J.termsLine({ kind: "custom" }), null);
  assert.equal(J.termsLine(null), null);
});

test("What you ordered: the terms, then the brief in the business's words", () => {
  assert.deepEqual(plain(J.orderedLines({ package_snapshot: { kind: "ugc_video", video_count: 1, delivery_days: 7 }, brief_snapshot: { brief: "  ", title: "Show the app" } })), [
    "1 UGC video · delivered in 7 days · 2 rounds of changes",
    "Show the app",
  ]);
  assert.deepEqual(plain(J.orderedLines({ package_snapshot: null, brief_snapshot: { brief: "Unbox it\nthen smile" } })), ["Unbox it\nthen smile"]);
  assert.deepEqual(plain(J.orderedLines({ package_snapshot: null, brief_snapshot: null })), []);
});

test("Book again and the Meta Ads line appear only on an accepted job", () => {
  const approved = detail({ status: "completed", closed_reason: "approved" }, { rebook: { package_id: "p9", title: "x", price_cents: 1, currency: "usd" } });
  assert.deepEqual(plain(J.bookAgain(approved)), { label: "Book Maya again", pathname: "/channels/ugc/hire", params: { package: "p9" } });
  assert.deepEqual(plain(J.bookAgain(detail({ status: "completed", closed_reason: "auto_accepted" }))), { label: "Book Maya again", pathname: "/channels/ugc/find", params: {} });
  assert.equal(J.bookAgain(detail({ status: "completed", closed_reason: "mediation_pay_full" })), null);
  assert.equal(J.bookAgain(detail({ status: "submitted" })), null);

  assert.deepEqual(plain(J.nextAdLine(approved)), { rights: " Ad rights last 90 days, from Maya's package." });
  assert.deepEqual(plain(J.nextAdLine(detail({ status: "completed", closed_reason: "approved" }, { package_snapshot: { kind: "ugc_video" } }))), { rights: "" });
  assert.equal(J.nextAdLine(detail({ status: "completed", closed_reason: "approved" }, { package_snapshot: { kind: "audience_post" } })), null);
  assert.equal(J.nextAdLine(detail({ status: "in_progress" })), null);
  assert.equal(J.META_ADS_SLUG, "meta_ads");
});

test("which parts show: review and publications once completed; a 30 s re-read while someone has to act", () => {
  assert.deepEqual(plain(J.jobSections(detail({ status: "completed", closed_reason: "approved" }))), { review: true, publish: true, receipt: false, next: true });
  assert.deepEqual(plain(J.jobSections(detail({ status: "submitted" }, { receipt: { refunded_cents: 0 } }))), { review: false, publish: false, receipt: true, next: false });
  for (const s of ["awaiting_acceptance", "in_progress", "submitted", "revision_requested", "cancel_requested", "in_dispute"]) assert.equal(J.refreshesLive(s), true, s);
  for (const s of ["checkout_pending", "completed", "cancelled"]) assert.equal(J.refreshesLive(s), false, s);
  assert.equal(J.LIVE_REFETCH_MS, 30_000);
});

test("review: all three ratings before posting, the body web sends, and the average", () => {
  assert.equal(J.reviewReady(J.NO_SCORES), false);
  assert.equal(J.reviewReady({ communication: 5, timeliness: 4, satisfaction: 0 }), false);
  const s = { communication: 5, timeliness: 4, satisfaction: 4 };
  assert.equal(J.reviewReady(s), true);
  assert.deepEqual(plain(J.reviewBody(s, "  Great work \n")), { communication: 5, timeliness: 4, satisfaction: 4, body: "Great work" });
  assert.deepEqual(plain(J.reviewBody(s, "   ")), { communication: 5, timeliness: 4, satisfaction: 4, body: null });
  assert.equal(J.reviewAverage(s), 4.3);
  assert.equal(J.reviewThanks(s, "Maya"), "Thanks. Your review (4.3 out of 5) is on Maya's card.");
  assert.equal(J.reviewedLine("Maya"), "You reviewed Maya. It is on Maya's card.");
  assert.equal(J.starLabel("On time", 3), "On time: 3 out of 5");
  assert.deepEqual(plain(J.REVIEW_AXES.map((a) => [a.id, a.label])), [["communication", "Communication"], ["timeliness", "On time"], ["satisfaction", "Happy with the result"]]);
  assert.equal(J.REVIEW_NOTE_MAX, 2000);
});

const pub = (o = {}) => ({
  id: "p1",
  publisher: "business",
  platform: "tiktok",
  account: "@shop",
  post_url: "https://tiktok.com/@shop/video/1",
  status: "published",
  scheduled_for: null,
  published_at: "2026-10-05T10:00:00Z",
  verification: "pending",
  verification_note: null,
  verified_at: null,
  created_at: "2026-10-05T10:00:00Z",
  ...o,
});

test("publications: the badge, the line and when Check again shows", () => {
  assert.deepEqual(plain(J.publicationBadge(pub({ status: "scheduled" }))), { text: "Planned", tone: "zinc" });
  assert.deepEqual(plain(J.publicationBadge(pub({ verification: "verified" }))), { text: "Verified", tone: "green" });
  assert.deepEqual(plain(J.publicationBadge(pub())), { text: "Not checked yet", tone: "zinc" });
  assert.deepEqual(plain(J.publicationBadge(pub({ verification: "manual" }))), { text: "Check manually", tone: "amber" });
  assert.deepEqual(plain(J.publicationBadge(pub({ verification: "failed" }))), { text: "Did not match", tone: "red" });
  assert.equal(J.publicationTitle(pub()), "TikTok · @shop");
  assert.equal(J.publicationTitle(pub({ platform: "x", account: null })), "X");
  assert.equal(J.publicationLine(pub({ verified_at: "2026-10-05T10:01:00Z" }), "Maya"), "Posted Oct 5, 10:00 UTC · verified Oct 5, 10:01 UTC · by you");
  assert.equal(J.publicationLine(pub({ status: "scheduled", scheduled_for: "2026-10-09T14:30:00Z", publisher: "creator" }), "Maya"), "Planned for Oct 9, 14:30 UTC · by Maya");
  assert.equal(J.canCheckAgain(pub()), true);
  assert.equal(J.canCheckAgain(pub({ verification: "failed" })), true);
  assert.equal(J.canCheckAgain(pub({ verification: "manual" })), false);
  assert.equal(J.canCheckAgain(pub({ post_url: null })), false);
  assert.match(J.publishSub("business", "Maya"), /^You publish this video\. Approved and paid is not the same as posted/);
  assert.match(J.publishSub("creator", "Maya"), /^Maya publishes this post\./);
  assert.deepEqual(plain(J.PUBLISH_PLATFORMS.map((p) => p.value)), ["tiktok", "instagram", "youtube", "facebook", "x", "linkedin", "pinterest", "other"]);
});

test("a typed local time becomes the ISO instant web's datetime-local would send; nonsense is refused", () => {
  assert.equal(J.parseLocalDateTime("2026-10-09 14:30"), new Date(2026, 9, 9, 14, 30).toISOString());
  assert.equal(J.parseLocalDateTime(" 2026-10-09T09:05 "), new Date(2026, 9, 9, 9, 5).toISOString());
  for (const bad of ["", "2026-10-09", "2026-02-31 10:00", "2026-13-01 10:00", "2026-10-09 24:00", "tomorrow 9am"]) assert.equal(J.parseLocalDateTime(bad), null, bad);
  assert.equal(J.localDateTimeText(new Date(2026, 0, 5, 7, 3)), "2026-01-05 07:03");
});

test("add a post: live needs a link, planned needs a time; the body is web's", () => {
  const f = (o) => ({ ...J.EMPTY_PUBLISH_FORM, ...o });
  assert.equal(J.publishBody(f({})), null);
  assert.deepEqual(plain(J.publishBody(f({ url: " https://tiktok.com/@shop/video/1 ", account: " @shop " }))), {
    platform: "tiktok",
    account: "@shop",
    post_url: "https://tiktok.com/@shop/video/1",
  });
  assert.deepEqual(plain(J.publishBody(f({ platform: "youtube", url: "https://youtu.be/x", when: "2026-10-05 10:00" }))), {
    platform: "youtube",
    post_url: "https://youtu.be/x",
    published_at: new Date(2026, 9, 5, 10, 0).toISOString(),
  });
  assert.equal(J.publishBody(f({ url: "https://youtu.be/x", when: "soon" })), null, "a typed time must be real");
  assert.equal(J.publishBody(f({ mode: "planned" })), null);
  assert.deepEqual(plain(J.publishBody(f({ mode: "planned", url: "ignored", when: "2026-10-09 14:30" }))), {
    platform: "tiktok",
    scheduled_for: new Date(2026, 9, 9, 14, 30).toISOString(),
  });
  assert.equal(J.whenInvalid({ when: "soon" }), true);
  assert.equal(J.whenInvalid({ when: "" }), false);
});

function loadHooks({ answers = [], tenant = "t1" } = {}) {
  const calls = [];
  const effects = [];
  const states = [];
  const appListeners = [];
  const invalidated = [];
  const setData = [];
  let pendingResolvers = [];
  const queryClient = {
    invalidateQueries: (o) => invalidated.push(o.queryKey),
    setQueryData: (key, v) => setData.push({ key, v: typeof v === "function" ? v({ publications: [{ id: "p1" }] }) : v }),
  };
  const apiJson = (p, o = {}) => {
    calls.push({ path: p, method: o.method ?? "GET", body: o.body === undefined ? undefined : JSON.parse(o.body), options: { ...o, body: undefined } });
    if (answers.length) {
      const a = answers.shift();
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    }
    return new Promise((resolve) => pendingResolvers.push(resolve));
  };
  const hooks = loadTs(path.join(__dirname, "../src/features/channels/ugcJobHooks.ts"), {
    react: {
      useState: (init) => [init, (v) => states.push(v)],
      useRef: (v) => ({ current: v }),
      useCallback: (f) => f,
      useEffect: (f) => effects.push(f),
    },
    "react-native": { AppState: { currentState: "active", addEventListener: (_e, fn) => (appListeners.push(fn), { remove() {} }) } },
    "@tanstack/react-query": { useMutation: (o) => o, useQuery: (o) => o, useQueryClient: () => queryClient },
    "../../lib/api": { apiJson },
    "../workspaces/useActiveTenant": { useActiveTenant: () => tenant },
    "./ugcHooks": { ugcKey: (t, ...rest) => ["ugc", t, ...rest] },
  });
  return { hooks, calls, effects, states, appListeners, invalidated, setData, resolveAll: (v) => (pendingResolvers.forEach((r) => r(v)), (pendingResolvers = [])) };
}

const tick = () => new Promise((r) => setImmediate(r));

test("money writes are never replayed: no idempotency key and no network retry on actions, fulfil and checkout", async () => {
  const h = loadHooks({ answers: [{ ok: true, detail: { job: { id: ID } } }, { checkout_url: "https://checkout.stripe.com/x" }, { ok: true }, { publication: { id: "p2" } }, { publication: { id: "p1", verification: "verified" } }] });
  await h.hooks.useJobAction(ID).mutationFn({ action: "request_change", note: "  shorter  " });
  await h.hooks.useResumeCheckout().mutationFn({ id: ID, source: "offer", offer_id: "o1" });
  await h.hooks.usePostReview(ID).mutationFn({ scores: { communication: 5, timeliness: 5, satisfaction: 4 }, note: "" });
  await h.hooks.useAddPublication(ID).mutationFn({ platform: "tiktok", post_url: "https://tiktok.com/x" });
  await h.hooks.useVerifyPublication(ID).mutationFn("p1");
  assert.deepEqual(
    h.calls.map((c) => [c.method, c.path, c.body]),
    [
      ["POST", `/api/humans/orders/${ID}/actions`, { action: "request_change", note: "shorter" }],
      ["POST", "/api/creators/offers/o1/checkout", {}],
      ["POST", `/api/humans/orders/${ID}/review`, { communication: 5, timeliness: 5, satisfaction: 4, body: null }],
      ["POST", `/api/humans/orders/${ID}/publications`, { platform: "tiktok", post_url: "https://tiktok.com/x" }],
      ["POST", "/api/humans/publications/p1/verify", {}],
    ],
  );
  for (const c of h.calls) {
    assert.equal(c.options.idempotent, undefined, c.path);
    assert.equal(c.options.retryOnNetworkError, false, c.path);
  }
  for (const c of h.calls) for (const k of ["tenant_id", "member_id", "human_member_id", "order_id"]) assert.ok(!(c.body && k in c.body), `${k} in ${c.path}`);
});

test("an action's answer replaces the job on screen and refreshes the workspace's UGC reads", () => {
  const h = loadHooks();
  const fresh = { job: { id: ID, status: "completed" } };
  h.hooks.useJobAction(ID).onSuccess({ ok: true, detail: fresh });
  assert.deepEqual(plain(h.setData[0]), { key: ["ugc", "t1", "job", ID], v: fresh });
  assert.deepEqual(plain(h.invalidated), [["ugc", "t1"]]);
  const v = loadHooks();
  v.hooks.useVerifyPublication(ID).onSuccess({ publication: { id: "p1", verification: "verified" } });
  assert.deepEqual(plain(v.setData[0]), { key: ["ugc", "t1", "publications", ID], v: { publications: [{ id: "p1", verification: "verified" }] } });
});

test("reads are per workspace and wait for one", () => {
  const h = loadHooks();
  const r = h.hooks.useJobReview(ID, true);
  assert.deepEqual(plain(r.queryKey), ["ugc", "t1", "review", ID]);
  assert.equal(r.enabled, true);
  assert.equal(h.hooks.useJobReview(ID, false).enabled, false);
  assert.deepEqual(plain(h.hooks.usePublications(ID, true).queryKey), ["ugc", "t1", "publications", ID]);
  const none = loadHooks({ tenant: "none" });
  assert.equal(none.hooks.usePublications(ID, true).enabled, false);
  assert.equal(none.hooks.useJobReview(ID, true).enabled, false);
});

test("the payment check asks /fulfil at once, re-reads the job on an answer, and drops an answer after it stopped", async () => {
  const h = loadHooks({ answers: [{ state: "fulfilled", status: "awaiting_acceptance" }] });
  const r = h.hooks.useFulfilPoll(ID, true, true);
  assert.equal(r.state, "confirming");
  const cleanup = h.effects[0]();
  await tick();
  assert.deepEqual(h.calls.map((c) => [c.method, c.path, c.body, c.options.retryOnNetworkError, c.options.idempotent]), [["POST", `/api/humans/orders/${ID}/fulfil`, {}, false, undefined]]);
  assert.deepEqual(plain(h.invalidated), [["ugc", "t1"]]);
  cleanup();

  const late = loadHooks();
  late.hooks.useFulfilPoll(ID, true, true);
  const stop = late.effects[0]();
  stop();
  late.resolveAll({ state: "cancelled", message: "x" });
  await tick();
  assert.equal(late.invalidated.length, 0);
  assert.equal(late.states.filter((s) => s && s.problem).length, 0);
});

test("the payment check starts again from try 1 when the app comes back, and never runs for a viewer or a paid job", async () => {
  const h = loadHooks({ answers: [{ state: "pending", reason: "no_payment_intent" }, { state: "fulfilled" }] });
  h.hooks.useFulfilPoll(ID, true, true);
  const cleanup = h.effects[0]();
  await tick();
  h.appListeners[0]("background");
  assert.equal(h.calls.length, 1);
  h.appListeners[0]("active");
  await tick();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(plain(h.states.at(-1)), { tries: 1, running: false, lastReason: null, problem: null, settled: true });
  cleanup();

  for (const [pending, enabled] of [[true, false], [false, true]]) {
    const v = loadHooks();
    v.hooks.useFulfilPoll(ID, pending, enabled);
    v.effects[0]();
    await tick();
    assert.equal(v.calls.length, 0);
  }
});

test("every path the job screen calls is a route the backend mounts, and none is replay-safe by key", () => {
  const REPO = path.join(__dirname, "../../..");
  const routes = fs.readFileSync(path.join(REPO, "apps/backend/src/routes/index.ts"), "utf8");
  const mounted = [...routes.matchAll(/app\.(get|post|patch|put|delete)\(\s*"(\/api\/[^"]*)"/g)].map((m) => ({ method: m[1].toUpperCase(), pattern: m[2] }));
  const used = [
    ["GET", `/api/humans/orders/${ID}`],
    ["POST", J.fulfilPath(ID)],
    ["POST", J.checkoutPath(job())],
    ["POST", J.checkoutPath(job({ source: "offer", offer_id: "o1" }))],
    ["POST", J.actionPath(ID)],
    ["GET", J.reviewPath(ID)],
    ["POST", J.reviewPath(ID)],
    ["GET", J.publicationsPath(ID)],
    ["POST", J.publicationsPath(ID)],
    ["POST", J.verifyPath("p1")],
    ["GET", "/api/humans/creators/m1/card"],
    ["POST", "/api/creators/threads/t1/messages"],
    ["POST", "/api/creators/m1/threads"],
  ];
  for (const [method, p] of used) {
    const hit = mounted.find((m) => m.method === method && new RegExp(`^${m.pattern.replace(/:[A-Za-z_]+/g, "[^/]+")}$`).test(p));
    assert.ok(hit, `${method} ${p} is not a route the backend mounts`);
  }
  const idem = fs.readFileSync(path.join(REPO, "apps/backend/src/services/http/idempotent-routes.ts"), "utf8");
  for (const p of ["/fulfil", "/checkout", "/actions"]) assert.ok(!idem.includes(`${p}"`), `${p} must not be sent with an Idempotency-Key`);
});
