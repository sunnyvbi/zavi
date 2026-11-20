import { describe, expect, it } from "vitest";
import type { CreatorJob } from "@/lib/creator/api";
import { briefRows, jobCounts, jobState, jobSteps, jobTerms, listLabel, payoutStep, viewFor } from "./CreatorJobs";

const job = (over: Partial<CreatorJob>): CreatorJob =>
  ({
    id: "j", source: "booking", status: "in_progress", closed_reason: null, created_at: "", due_at: "2999-01-01T00:00:00Z",
    accepted_at: null, closed_at: null, extension_state: null, extension_requested_due_at: null, package: { title: "1 video", kind: "ugc_video", delivery_days: 7, video_count: 1, video_length_seconds: 30, ad_rights_days: 90 },
    brief: null, currency: "usd", price_cents: 15000, creator_fee_cents: 2250, creator_payout_cents: 12750, amount_cents: 12750, part_paid: false,
    payout_status: "not_due", payout_ready_at: null, deadline: null, submissions: [], has_thread: false, ...over,
  }) as CreatorJob;

describe("jobState: the wireframe state from the real order", () => {
  it.each([
    [{ status: "checkout_pending" }, "checkout_pending"],
    [{ status: "in_progress", product_needed: true, product_received_at: null }, "product_pending"],
    [{ status: "in_progress", can_mark_product_received: true }, "product_pending"],
    [{ status: "in_progress", due_at: "2000-01-01T00:00:00Z" }, "late"],
    [{ status: "submitted", revisions_used: 0 }, "submitted"],
    [{ status: "submitted", revisions_used: 1 }, "resubmitted"],
    [{ status: "submitted", revisions_used: 2 }, "resubmitted_2"],
    [{ status: "revision_requested", revisions_used: 1 }, "revision_requested"],
    [{ status: "revision_requested", revisions_used: 2 }, "revision_requested_2"],
    [{ status: "completed", closed_reason: "approved", payout_status: "awaiting_payout_account" }, "approved_setup"],
    [{ status: "completed", closed_reason: "auto_accepted", payout_status: "ready" }, "auto_accepted"],
    [{ status: "completed", closed_reason: "auto_accepted", payout_status: "transferred" }, "approved"],
    [{ status: "cancelled", closed_reason: "cancel_no_response" }, "cancel_no_response"],
    [{ status: "cancelled", closed_reason: "checkout_abandoned" }, "withdrawn"],
  ] as const)("%o -> %s", (over, want) => {
    expect(jobState(job(over as Partial<CreatorJob>))).toBe(want);
  });

  it("steps and terms follow who proposed the offer", () => {
    const mine = job({ source: "offer", offer_proposed_by: "creator", product_needed: true, package: { terms: { title: "3 UGC videos", due_date: "2026-10-06" } } });
    expect(jobSteps(mine, "Acme")).toEqual(["Offer accepted", "Product received", "Draft sent", "Approved", "Paid"]);
    expect(jobTerms(mine, "Acme")).toBe("Your custom offer. Due Oct 6. 2 rounds of changes.");
    const theirs = job({ source: "offer", offer_proposed_by: "tenant", package: { terms: { title: "2 TikTok videos", due_date: "2026-10-09" } } });
    expect(jobSteps(theirs, "Acme")[1]).toBe("Acme pays");
    expect(jobTerms(theirs, "Acme")).toBe("Custom offer from Acme. Due Oct 9. 2 rounds of changes.");
  });

  it("a paid job you are not looking at reads Paid", () => {
    expect(listLabel("approved", "Acme")).toBe("Paid");
    expect(listLabel("approved", "Acme", "transferred")).toBe("Paid");
    expect(listLabel("in_progress", "Acme")).toBe("In progress");
  });

  it("never says Paid before Stripe transferred the money", () => {
    expect(listLabel("approved", "Acme", "awaiting_payout_account")).toBe("Set up payouts");
    expect(listLabel("approved", "Acme", "ready")).toBe("On the way");
    expect(payoutStep("ready")).toEqual({ label: "On the way", paid: false });
    expect(payoutStep("transferred")).toEqual({ label: "Paid", paid: true });
    expect(payoutStep("not_due")).toEqual({ label: "Paid", paid: false });
    expect(payoutStep("reversed")).toEqual({ label: "Pending", paid: false });
    expect(jobSteps(job({ source: "booking", payout_status: "awaiting_payout_account" }), "Acme").at(-1)).toBe("Set up payouts");
  });
});

describe("the brief a creator was hired for reads as labels, not field keys (E2E 2026-09-27 P3)", () => {
  it("labels known fields and drops ids and tracking fields", () => {
    expect(briefRows({ id: "b1", title: "Spring launch", brief: "Show the app", utm_campaign: "zavi-x", delivery_days: 7 })).toEqual([
      ["Title", "Spring launch"],
      ["What they asked for", "Show the app"],
      ["Days to deliver", "7"],
    ]);
  });
});

describe("an auto-accepted job says where the 10 days stand, like the business's drawer", () => {
  const auto = job({
    status: "completed", closed_reason: "auto_accepted", payout_status: "ready",
    created_at: "2026-09-01T00:00:00Z", closed_at: "2026-09-12T10:00:00Z", payout_ready_at: "2026-09-10T00:00:00Z",
  });
  it("inside the window: step-in still possible, released 10 days after close", () => {
    const body = viewFor("auto_accepted", auto, "Acme", new Date("2026-09-15T00:00:00Z")).body;
    expect(body).toContain("on 22 Sep 2026");
    expect(body).toContain("Acme can still ask Zavi to step in");
  });
  it("after the window: says it has passed, no release date, no step-in promise", () => {
    const body = viewFor("auto_accepted", auto, "Acme", new Date("2026-09-28T00:00:00Z")).body;
    expect(body).toContain("The 10 days to ask Zavi to step in have passed.");
    expect(body).not.toContain("can still ask");
    expect(body).not.toContain("10 Sep");
  });
  it("never names a release date earlier than the job", () => {
    const body = viewFor("auto_accepted", { ...auto, closed_at: null, created_at: "2026-09-11T00:00:00Z" }, "Acme", new Date("2026-09-13T00:00:00Z")).body;
    expect(body).not.toContain("10 Sep");
  });
});

describe("jobCounts: the Jobs tab badge and status chips", () => {
  it("buckets open jobs and leaves closed ones out of pending", () => {
    const c = jobCounts([
      job({ status: "awaiting_acceptance" }),
      job({ status: "in_progress" }),
      job({ status: "in_progress", due_at: "2000-01-01T00:00:00Z" }),
      job({ status: "revision_requested", revisions_used: 1 }),
      job({ status: "submitted", revisions_used: 0 }),
      job({ status: "checkout_pending" }),
      job({ status: "completed", closed_reason: "approved", payout_status: "transferred" }),
    ]);
    expect(c).toEqual({ awaiting_acceptance: 1, in_progress: 3, awaiting_approval: 1, pending: 5 });
  });
});
