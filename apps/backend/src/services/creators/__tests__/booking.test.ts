
import { describe, expect, it, vi } from "vitest";
import { ExpectedToolError } from "@/services/tools/types";
import {
  BOOKING_BRIEF_BODY_MAX,
  BOOKING_BRIEF_TITLE_MAX,
  LARGE_AMOUNT_CONFIRM_CENTS,
  bookingBriefSnapshot,
  defaultDueAt,
  needsLargeAmountConfirm,
  quoteCreatorBooking,
  chargeNowText,
  quotedRateToCents,
  startCreatorCheckout,
  validateDueAt,
  type BookingDeps,
} from "../booking";
import { computeCreatorFees } from "../order-fees";
import { CONTACT_REDACTION } from "../contact-scrub";
import { createCreatorCheckoutHold } from "../orders-money";
import { deadlineCopy } from "../deadline-copy";
import type { CreatorOrderStateRow } from "../orders-db";
import type { BookableCreator, BookablePackage, CreatorOrderInsert } from "../booking-db";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const CREATOR = "33333333-3333-3333-3333-333333333333";
const PACKAGE = "44444444-4444-4444-4444-444444444444";
const APPLICATION = "55555555-5555-5555-5555-555555555555";
const BRIEF = "66666666-6666-6666-6666-666666666666";
const ORDER = "22222222-2222-2222-2222-222222222222";
const T0 = "2026-09-11T00:00:00.000Z";

function creator(over: Partial<BookableCreator> = {}): BookableCreator {
  return {
    id: CREATOR,
    display_name: "Maya",
    slug: "maya",
    city: "Austin",
    country_code: "US",
    vetting_state: "approved",
    ...over,
  };
}

function pkg(over: Partial<BookablePackage> = {}): BookablePackage {
  return {
    id: PACKAGE,
    human_member_id: CREATOR,
    kind: "ugc_video",
    title: "3 ad videos",
    description: "Three hooks, one product",
    price_cents: 15_000,
    currency: "usd",
    delivery_days: 5,
    video_count: 3,
    video_length_seconds: 30,
    ad_rights_days: 90,
    addons: [],
    active: true,
    ...over,
  };
}

function orderRow(over: Partial<CreatorOrderStateRow> = {}): CreatorOrderStateRow {
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "checkout_pending",
    closed_reason: null,
    created_at: T0,
    due_at: null,
    extension_requested_due_at: null,
    extension_state: null,
    next_deadline_at: null,
    next_deadline_kind: null,
    responded_at: null,
    accepted_at: null,
    cancel_requested_at: null,
    status_before_cancel_request: null,
    closed_at: null,
    payout_status: "not_due",
    payout_ready_at: null,
    payout_amount_cents: null,
    price_cents: 15_000,
    business_fee_cents: 1_500,
    creator_fee_cents: 2_250,
    business_total_cents: 16_500,
    creator_payout_cents: 12_750,
    package_snapshot: { title: "3 ad videos", creator_country_code: "US" },
    livemode: false,
    ...over,
  };
}

type Harness = {
  deps: BookingDeps;
  inserts: CreatorOrderInsert[];
  checkouts: { tenant_id: string; order_id: string; creator_country: string; success_url: string }[];
  offersAccepted: string[];
};

function harness(
  over: {
    creator?: BookableCreator | null;
    pkg?: BookablePackage | null;
    application?: unknown;
    brief?: unknown;
    offer?: unknown;
    duplicateOn?: () => CreatorOrderStateRow | null;
    checkoutAmount?: number;
  } = {},
): Harness {
  const inserts: CreatorOrderInsert[] = [];
  const checkouts: Harness["checkouts"] = [];
  const offersAccepted: string[] = [];
  let inserted = 0;

  const deps: BookingDeps = {
    loadCreator: async () => (over.creator === undefined ? creator() : over.creator),
    loadPackage: async () => (over.pkg === undefined ? pkg() : over.pkg),
    loadOffer: async () => (over.offer as never) ?? null,
    loadApplication: async () => (over.application as never) ?? null,
    loadBrief: async (tenant_id: string) =>
      tenant_id === TENANT ? ((over.brief as never) ?? null) : null,
    insertOrder: async (row) => {
      inserts.push(row);
      inserted += 1;
      if (over.duplicateOn && inserted > 1) {
        return { ok: false, code: "duplicate", existing: over.duplicateOn() };
      }
      return {
        ok: true,
        order: orderRow({
          source: row.source,
          price_cents: row.price_cents,
          business_fee_cents: row.business_fee_cents,
          creator_fee_cents: row.creator_fee_cents,
          business_total_cents: row.price_cents + row.business_fee_cents,
          creator_payout_cents: row.price_cents - row.creator_fee_cents,
          due_at: row.due_at,
        }),
      };
    },
    attachSession: async () => {},
    markOfferAccepted: async (_t, id) => {
      offersAccepted.push(id);
      return true;
    },
    openCheckout: async (a) => {
      checkouts.push({
        tenant_id: a.tenant_id,
        order_id: a.order_id,
        creator_country: a.creator_country,
        success_url: a.success_url,
      });
      const last = inserts[inserts.length - 1];
      return {
        checkout_session_id: "cs_test_1",
        url: "https://checkout.stripe.test/cs_test_1",
        amount_cents:
          over.checkoutAmount ?? (last ? last.price_cents + last.business_fee_cents : 0),
      };
    },
    livemode: () => false,
    now: () => new Date(T0),
  };
  return { deps, inserts, checkouts, offersAccepted };
}

const URLS = {
  success_url: "https://app.test/humans/jobs/{ORDER_ID}?paid=1",
  cancel_url: "https://app.test/humans/jobs?cancelled=1",
};

describe("invariant 8: the money shown is the money charged", () => {
  it("quotes price, the 10% fee and the total from the ONE fee function", async () => {
    const h = harness();
    const q = await quoteCreatorBooking({ tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } }, h.deps);
    const truth = computeCreatorFees(15_000);

    expect(q.money.price_cents).toBe(truth.price_cents);
    expect(q.money.business_fee_cents).toBe(truth.business_fee_cents);
    expect(q.money.business_total_cents).toBe(truth.business_total_cents);
    expect(q.money.business_total_cents).toBe(16_500);
    expect(q.money.business_fee_label).toBe("10%");
  });

  it("a new unpaid booking carries its own close: 25h, an hour after Stripe's page expires, and arms it", async () => {
    const h = harness();
    const armDeadline = vi.fn(async () => {});
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      { ...h.deps, armDeadline },
    );
    const deadline = { kind: "checkout_expiry", deadline_at: new Date(Date.parse(T0) + 25 * 3_600_000).toISOString() };
    expect(h.inserts[0].checkout_deadline).toEqual(deadline);
    expect(armDeadline).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, deadline }));
  });

  it("a failed arm never fails the checkout (the hourly sweep is the net)", async () => {
    const h = harness();
    const started = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      { ...h.deps, armDeadline: async () => { throw new Error("inngest down"); } },
    );
    expect(started.checkout_url).toBeTruthy();
  });

  it("freezes exactly the quoted fees onto the order row", async () => {
    const h = harness();
    const started = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      h.deps,
    );
    const row = h.inserts[0];
    expect(row.price_cents).toBe(started.quote.money.price_cents);
    expect(row.business_fee_cents).toBe(started.quote.money.business_fee_cents);
    expect(row.price_cents + row.business_fee_cents).toBe(
      started.quote.money.business_total_cents,
    );
    expect(row.creator_fee_cents).toBe(computeCreatorFees(15_000).creator_fee_cents);
  });

  it("refuses if Stripe was asked to hold a different amount", async () => {
    const h = harness({ checkoutAmount: 16_499 });
    await expect(
      startCreatorCheckout(
        { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "checkout_amount_mismatch" });
  });

  it("prices every whole-dollar package the same way computeCreatorFees does", async () => {
    for (const price of [1, 99, 100, 1_250, 15_000, 99_999, 1_000_000]) {
      const h = harness({ pkg: pkg({ price_cents: price }) });
      const q = await quoteCreatorBooking(
        { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
        h.deps,
      );
      const truth = computeCreatorFees(price);
      expect(q.money.business_fee_cents).toBe(truth.business_fee_cents);
      expect(q.money.business_total_cents).toBe(truth.business_total_cents);
    }
  });
});

describe("the $500 extra confirm", () => {
  it("is off below the line and on above it", () => {
    expect(needsLargeAmountConfirm(LARGE_AMOUNT_CONFIRM_CENTS - 1)).toBe(false);
    expect(needsLargeAmountConfirm(LARGE_AMOUNT_CONFIRM_CENTS)).toBe(false);
    expect(needsLargeAmountConfirm(LARGE_AMOUNT_CONFIRM_CENTS + 1)).toBe(true);
  });

  it("flags the quote once the TOTAL crosses, not the price", async () => {
    const h = harness({ pkg: pkg({ price_cents: 46_000 }) });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
      h.deps,
    );
    expect(q.money.price_cents).toBeLessThan(LARGE_AMOUNT_CONFIRM_CENTS);
    expect(q.money.business_total_cents).toBeGreaterThan(LARGE_AMOUNT_CONFIRM_CENTS);
    expect(q.needs_large_amount_confirm).toBe(true);
  });

  it("REFUSES on the server without the confirm, and nothing is inserted", async () => {
    const h = harness({ pkg: pkg({ price_cents: 100_000 }) });
    await expect(
      startCreatorCheckout(
        { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "large_amount_confirm_required" });
    expect(h.inserts).toHaveLength(0);
    expect(h.checkouts).toHaveLength(0);
  });

  it("goes through once the confirm is given", async () => {
    const h = harness({ pkg: pkg({ price_cents: 100_000 }) });
    const started = await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        large_amount_confirmed: true,
        ...URLS,
      },
      h.deps,
    );
    expect(started.checkout_url).toContain("checkout.stripe.test");
    expect(h.checkouts).toHaveLength(1);
  });

  it("does not ask for the confirm on a small booking", async () => {
    const h = harness();
    const started = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      h.deps,
    );
    expect(started.quote.needs_large_amount_confirm).toBe(false);
  });
});

describe("invariant 7: a creator Zavi cannot pay is never charged for", () => {
  it("blocks the quote with an honest sentence", async () => {
    const h = harness({ creator: creator({ country_code: "IN" }) });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
      h.deps,
    );
    expect(q.creator.payout_supported).toBe(false);
    expect(q.blocked?.code).toBe("creator_payout_country_unsupported");
    expect(q.money.business_total_cents).toBe(16_500);
  });

  it("refuses to create the order at all", async () => {
    const h = harness({ creator: creator({ country_code: "IN" }) });
    await expect(
      startCreatorCheckout(
        { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "creator_payout_country_unsupported" });
    expect(h.inserts).toHaveLength(0);
  });

  it("blocks a creator who is not approved (Q31, Q37)", async () => {
    for (const state of ["pending", "under_review", "rejected"]) {
      const h = harness({ creator: creator({ vetting_state: state }) });
      const q = await quoteCreatorBooking(
        { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
        h.deps,
      );
      expect(q.blocked?.code).toBe("creator_not_available");
    }
  });

  it("blocks an inactive package", async () => {
    const h = harness({ pkg: pkg({ active: false }) });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
      h.deps,
    );
    expect(q.blocked?.code).toBe("package_inactive");
  });

  it("passes the creator's country to the money layer, which gates again", async () => {
    const h = harness();
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      h.deps,
    );
    expect(h.checkouts[0].creator_country).toBe("US");
    expect(h.inserts[0].package_snapshot.creator_country_code).toBe("US");
  });

  it("refuses to sell a leftover audience_post package even while its row is still active", async () => {
    const leftover = pkg({ kind: "audience_post", video_count: null, video_length_seconds: null, ad_rights_days: null, active: true });
    const quoted = harness({ pkg: leftover });
    const q = await quoteCreatorBooking({ tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } }, quoted.deps);
    expect(q.blocked?.code).toBe("package_inactive");
    expect(q.job.kind).toBe("ugc_video");

    const h = harness({ pkg: leftover });
    await expect(
      startCreatorCheckout({ tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS }, h.deps),
    ).rejects.toMatchObject({ code: "package_inactive" });
    expect(h.inserts).toHaveLength(0);
    expect(h.checkouts).toHaveLength(0);
  });

  it("freezes a UGC package with no post fields on the order", async () => {
    const ugc = harness();
    await startCreatorCheckout({ tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS }, ugc.deps);
    const snap = ugc.inserts[0].package_snapshot;
    expect(snap.kind).toBe("ugc_video");
    for (const k of ["platform", "post_type", "stays_up_days", "post_count", "ad_label_required"]) expect(k in snap, k).toBe(false);
  });
});

describe("a package booking's delivery days start when the creator accepts (Ravi 2026-09-27)", () => {
  it("quotes no fixed date for a booking, only the days after the accept", async () => {
    const h = harness();
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
      h.deps,
    );
    expect(q.due_at).toBeNull();
    expect(q.due_deadline).toBeNull();
    expect(q.due_after_accept).toMatch(/^5 days after \S+ accepts$/);
  });

  it("ignores a date typed at booking: the order is written with no due date", async () => {
    const h = harness();
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, due_at: "2026-09-20T00:00:00.000Z", ...URLS },
      h.deps,
    );
    expect(h.inserts[0].due_at).toBeNull();
  });

  it("still pre-fills from the delivery days where a date is written at booking (Q23)", () => {
    expect(defaultDueAt(new Date(T0), 5)).toBe("2026-09-16T00:00:00.000Z");
  });

  it("refuses a due date in the past or beyond a year", () => {
    const now = new Date(T0);
    expect(() => validateDueAt("2026-09-10T00:00:00.000Z", now)).toThrow();
    expect(() => validateDueAt("2028-09-10T00:00:00.000Z", now)).toThrow();
    expect(() => validateDueAt("not a date", now)).toThrow();
    expect(validateDueAt("2026-09-20T00:00:00.000Z", now)).toBe("2026-09-20T00:00:00.000Z");
  });

  it("shows the 72h accept rule for a booking and nothing for a hire", async () => {
    const booking = harness();
    const q1 = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
      booking.deps,
    );
    expect(q1.accept_window?.hours).toBe(72);
    expect(q1.accept_window?.consequence_text).toMatch(/^If \S+ doesn't accept by then, the booking is cancelled, the hold on your card is released/);
    expect(q1.accept_window?.consequence_text).toBe(
      deadlineCopy("accept", T0, { side: "business", other_name: q1.creator.display_name.split(" ")[0] }).consequence_text,
    );

    const hire = harness({
      application: {
        id: APPLICATION,
        tenant_id: TENANT,
        brief_id: BRIEF,
        human_member_id: CREATOR,
        status: "applied",
        quoted_rate_usd: 200,
        pitch: "I shoot in my kitchen",
      },
      brief: {
        id: BRIEF,
        title: "Spring hooks",
        lane: "ugc_video",
        delivery_days: 7,
        deliverables: 3,
        utm_campaign: "spring",
        answer_by: null,
      },
    });
    const q2 = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "applicant", application_id: APPLICATION } },
      hire.deps,
    );
    expect(q2.accept_window).toBeNull();
  });
});

describe("Q34: hiring an applicant", () => {
  const application = {
    id: APPLICATION,
    tenant_id: TENANT,
    brief_id: BRIEF,
    human_member_id: CREATOR,
    status: "applied",
    quoted_rate_usd: 200,
    pitch: "I shoot in my kitchen",
  };
  const brief = {
    id: BRIEF,
    title: "Spring hooks",
    lane: "ugc_video",
    delivery_days: 7,
    deliverables: 3,
    utm_campaign: "spring",
    answer_by: null,
  };

  it("prices the applicant's OWN quote plus the 10% fee (Q14)", async () => {
    const h = harness({ application, brief });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "applicant", application_id: APPLICATION } },
      h.deps,
    );
    expect(q.money.price_cents).toBe(20_000);
    expect(q.money.business_fee_cents).toBe(computeCreatorFees(20_000).business_fee_cents);
    expect(q.money.business_total_cents).toBe(22_000);
  });

  it("freezes the brief the business last saved (invariant 6)", async () => {
    const h = harness({ application, brief });
    await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "applicant", application_id: APPLICATION },
        ...URLS,
      },
      h.deps,
    );
    expect(h.inserts[0].brief_snapshot).toMatchObject({
      id: BRIEF,
      title: "Spring hooks",
      utm_campaign: "spring",
    });
    expect(h.inserts[0].source).toBe("applicant");
    expect(h.inserts[0].application_id).toBe(APPLICATION);
  });

  it("S6: carries the brief's ad rights onto the order, so the approved video can reach the library", async () => {
    const start = async (b: Record<string, unknown>) => {
      const h = harness({ application, brief: { ...brief, ...b } });
      await startCreatorCheckout(
        { tenant_id: TENANT, user_id: "u1", target: { source: "applicant", application_id: APPLICATION }, ...URLS },
        h.deps,
      );
      return h.inserts[0].package_snapshot.ad_rights_days;
    };
    expect(await start({ ad_rights_days: 90 })).toBe(90);
    expect(await start({})).toBeNull();
    expect(await start({ ad_rights_days: 45 })).toBeNull();
  });

  it("is IDEMPOTENT on double submit: one order, one charge", async () => {
    const first = orderRow({ source: "applicant", status: "checkout_pending" });
    const h = harness({ application, brief, duplicateOn: () => first });
    const args = {
      tenant_id: TENANT,
      user_id: "u1",
      target: { source: "applicant" as const, application_id: APPLICATION },
      ...URLS,
    };

    const a = await startCreatorCheckout(args, h.deps);
    const b = await startCreatorCheckout(args, h.deps);

    expect(a.order_id).toBe(b.order_id);
    expect(a.reused_existing).toBe(false);
    expect(b.reused_existing).toBe(true);
    expect(h.inserts).toHaveLength(2);
  });

  it("refuses a second attempt once the first was already paid", async () => {
    const paid = orderRow({ source: "applicant", status: "in_progress" });
    const h = harness({ application, brief, duplicateOn: () => paid });
    const args = {
      tenant_id: TENANT,
      user_id: "u1",
      target: { source: "applicant" as const, application_id: APPLICATION },
      ...URLS,
    };
    await startCreatorCheckout(args, h.deps);
    await expect(startCreatorCheckout(args, h.deps)).rejects.toMatchObject({
      code: "already_booked",
    });
  });

  it("blocks an applicant who quoted no price", async () => {
    const h = harness({ application: { ...application, quoted_rate_usd: null }, brief });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "applicant", application_id: APPLICATION } },
      h.deps,
    );
    expect(q.blocked?.code).toBe("applicant_has_no_price");
  });

  it("blocks an applicant who was already hired", async () => {
    const h = harness({ application: { ...application, status: "hired" }, brief });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "applicant", application_id: APPLICATION } },
      h.deps,
    );
    expect(q.blocked?.code).toBe("already_hired");
  });

  it("blocks an applicant on an old audience-post brief at quote and never opens checkout", async () => {
    for (const lane of ["audience_post", "AUDIENCE_POST", "influencer"]) {
      const h = harness({ application, brief: { ...brief, lane, ad_rights_days: null } });
      const q = await quoteCreatorBooking(
        { tenant_id: TENANT, target: { source: "applicant", application_id: APPLICATION } },
        h.deps,
      );
      expect(q.blocked?.code).toBe("application_closed");
      expect(h.inserts).toHaveLength(0);
    }
    for (const lane of ["ugc_video", null]) {
      const h = harness({ application, brief: { ...brief, lane } });
      const q = await quoteCreatorBooking(
        { tenant_id: TENANT, target: { source: "applicant", application_id: APPLICATION } },
        h.deps,
      );
      expect(q.blocked).toBeNull();
    }
  });

  it("turns a dollar quote into whole cents, or refuses", () => {
    expect(quotedRateToCents(200)).toBe(20_000);
    expect(quotedRateToCents(12.5)).toBe(1_250);
    expect(quotedRateToCents(0)).toBeNull();
    expect(quotedRateToCents(-5)).toBeNull();
    expect(quotedRateToCents(null)).toBeNull();
  });
});

describe("custom offers (Q35)", () => {
  const OFFER = "77777777-7777-7777-7777-777777777777";
  const openOffer = {
    id: OFFER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    thread_id: null,
    proposed_by: "creator" as const,
    kind: "ugc_video" as const,
    terms: { title: "One extra hook", hooks: 1 },
    price_cents: 8_000,
    currency: "usd",
    delivery_days: 3,
    note: "Same shoot, one more angle",
    status: "open" as const,
    expires_at: "2026-09-13T00:00:00.000Z",
  };

  it("books an open offer and closes it", async () => {
    const h = harness({ offer: openOffer });
    const started = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "offer", offer_id: OFFER }, ...URLS },
      h.deps,
    );
    expect(started.quote.money.business_total_cents).toBe(
      computeCreatorFees(8_000).business_total_cents,
    );
    expect(h.offersAccepted).toEqual([OFFER]);
    expect(h.inserts[0].offer_id).toBe(OFFER);
    expect(h.inserts[0].checkout_deadline).toEqual({ kind: "offer_expiry", deadline_at: openOffer.expires_at });
  });

  it("takes the job title from terms, and falls back to the lane when there is none", async () => {
    const h = harness({ offer: openOffer });
    const started = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "offer", offer_id: OFFER }, ...URLS },
      h.deps,
    );
    expect(h.inserts[0].package_snapshot.title).toBe("One extra hook");

    const bare = harness({ offer: { ...openOffer, terms: { hooks: 1 } } });
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "offer", offer_id: OFFER }, ...URLS },
      bare.deps,
    );
    expect(bare.inserts[0].package_snapshot.title).toBe("Custom video");
  });

  it("blocks an offer that already expired", async () => {
    const h = harness({ offer: { ...openOffer, expires_at: "2026-09-10T00:00:00.000Z" } });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } },
      h.deps,
    );
    expect(q.blocked?.code).toBe("offer_expired");
  });

  it("an offer that names a due date gives the order that date, not N days from checkout", async () => {
    const h = harness({ offer: { ...openOffer, terms: { ...openOffer.terms, due_date: "2026-09-12" } } });
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "offer", offer_id: OFFER }, ...URLS },
      h.deps,
    );
    expect(h.inserts[0].due_at).toBe("2026-09-12T23:59:59.000Z");
    expect(h.inserts[0].checkout_deadline).toEqual({ kind: "offer_expiry", deadline_at: "2026-09-12T23:59:59.000Z" });
  });

  it("a date typed at checkout never replaces the offer's agreed day", async () => {
    const h = harness({ offer: { ...openOffer, terms: { ...openOffer.terms, due_date: "2026-09-12" } } });
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "offer", offer_id: OFFER }, due_at: "2026-09-20T00:00:00.000Z", ...URLS },
      h.deps,
    );
    expect(h.inserts[0].due_at).toBe("2026-09-12T23:59:59.000Z");
  });

  it("blocks an offer whose agreed due date has already passed, like an expired one", async () => {
    const h = harness({ offer: { ...openOffer, terms: { ...openOffer.terms, due_date: "2026-09-10" } } });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } },
      h.deps,
    );
    expect(q.blocked?.code).toBe("offer_expired");
  });

  it("blocks an offer that is no longer open", async () => {
    const h = harness({ offer: { ...openOffer, status: "withdrawn" as const } });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } },
      h.deps,
    );
    expect(q.blocked?.code).toBe("offer_not_open");
  });

  it("blocks a leftover open audience_post offer, so it can never be paid", async () => {
    const h = harness({ offer: { ...openOffer, kind: "audience_post" } });
    const q = await quoteCreatorBooking({ tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } }, h.deps);
    expect(q.blocked?.code).toBe("offer_not_open");
    await expect(
      startCreatorCheckout({ tenant_id: TENANT, user_id: "u1", target: { source: "offer", offer_id: OFFER }, ...URLS }, h.deps),
    ).rejects.toMatchObject({ code: "offer_not_open" });
    expect(h.inserts).toHaveLength(0);
    expect(h.checkouts).toHaveLength(0);
  });

  it("the quote carries one charge-now sentence per door with no accept window", async () => {
    const h = harness({ offer: openOffer });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } },
      h.deps,
    );
    expect(q.accept_window).toBeNull();
    expect(q.charge_now_text).toContain("starts the job");
    expect(q.charge_now_text).not.toMatch(/applicant/i);
    expect(chargeNowText("applicant")).toContain("hires this applicant");
    expect(chargeNowText("booking")).toBeNull();
  });

  it("refuses to book an OPEN offer the business itself proposed: the creator has not agreed", async () => {
    const h = harness({ offer: { ...openOffer, proposed_by: "tenant" as const } });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } },
      h.deps,
    );
    expect(q.blocked?.code).toBe("offer_not_agreed");
    expect(q.charge_now_text).toBeNull();
    await expect(
      startCreatorCheckout(
        { tenant_id: TENANT, user_id: "u1", target: { source: "offer", offer_id: OFFER }, ...URLS },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "offer_not_agreed" });
    expect(h.inserts).toEqual([]);
    expect(h.offersAccepted).toEqual([]);
  });

  it("an EXPIRED business offer says expired, not 'pay once they accept' (the accept would be refused)", async () => {
    const h = harness({
      offer: { ...openOffer, proposed_by: "tenant" as const, expires_at: "2026-09-10T00:00:00.000Z" },
    });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } },
      h.deps,
    );
    expect(q.blocked?.code).toBe("offer_expired");
  });

  it("a creator-proposed open offer is payable from the book door (the business accepting it)", async () => {
    const h = harness({ offer: openOffer });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } },
      h.deps,
    );
    expect(q.blocked).toBeNull();
  });

  it("a business offer the creator already ACCEPTED is payable through the claimed (accept) path", async () => {
    const h = harness({ offer: { ...openOffer, proposed_by: "tenant" as const, status: "accepted" as const } });
    const started = await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: null,
        target: { source: "offer", offer_id: OFFER },
        offer_already_claimed: true,
        large_amount_confirmed: true,
        ...URLS,
      },
      h.deps,
    );
    expect(started.order_id).toBeTruthy();
    expect(h.inserts[0].offer_id).toBe(OFFER);
  });

  it("the book door still refuses an accepted offer (it was paid through the accept path)", async () => {
    const h = harness({ offer: { ...openOffer, proposed_by: "tenant" as const, status: "accepted" as const } });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } },
      h.deps,
    );
    expect(q.blocked?.code).toBe("offer_not_open");
  });

  it("reads the offer through the caller's tenant, never the body's", async () => {
    const seen: string[] = [];
    const h = harness({ offer: openOffer });
    const spied: BookingDeps = {
      ...h.deps,
      loadOffer: async (tid, id) => {
        seen.push(tid);
        return h.deps.loadOffer(tid, id);
      },
    };
    await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: OFFER } },
      spied,
    );
    expect(seen).toEqual([TENANT]);
    expect(seen).not.toContain(OTHER_TENANT);
  });
});

describe("spec item 29: any tenant member may pay", () => {
  it("records who booked without ever gating on a role", async () => {
    for (const user of ["owner-1", "admin-1", "member-1", null]) {
      const h = harness();
      await startCreatorCheckout(
        {
          tenant_id: TENANT,
          user_id: user,
          target: { source: "booking", package_id: PACKAGE },
          ...URLS,
        },
        h.deps,
      );
      expect(h.inserts[0].booked_by_user_id).toBe(user);
      expect(h.checkouts).toHaveLength(1);
    }
  });
});

describe("the Stripe return URL", () => {
  it("substitutes the real order id into the success URL", async () => {
    const h = harness();
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      h.deps,
    );
    expect(h.checkouts[0].success_url).toBe(
      `https://app.test/humans/jobs/${ORDER}?paid=1`,
    );
    expect(h.checkouts[0].success_url).not.toContain("{ORDER_ID}");
  });
});

describe("the checkout S7 opens is a HOLD, not a charge", () => {
  it("goes through S2's real createCreatorCheckoutHold with capture_method manual", async () => {
    const created: Record<string, unknown>[] = [];
    const moneyDeps = {
      stripe: () =>
        ({
          checkout: {
            sessions: {
              create: async (params: Record<string, unknown>) => {
                created.push(params);
                return { id: "cs_test_real", url: "https://checkout.stripe.test/cs_test_real" };
              },
            },
          },
        }) as never,
      loadOrder: async () => ({
        id: ORDER,
        tenant_id: TENANT,
        human_member_id: CREATOR,
        status: "checkout_pending",
        currency: "usd",
        price_cents: 15_000,
        business_fee_cents: 1_500,
        creator_fee_cents: 2_250,
        business_total_cents: 16_500,
        creator_payout_cents: 12_750,
        payout_amount_cents: null,
        payout_status: "not_due",
        livemode: false,
        stripe_payment_intent_id: null,
        stripe_transfer_id: null,
      }),
      recordEvent: async () => "inserted" as const,
      findEvent: async () => null,
      loadPayoutAccount: async () => null,
      claimTransfer: async () => null,
      markTransferred: async () => 1,
      releaseTransferClaim: async () => 1,
      platformKey: () => "sk_test_fake",
      log: (async () => {}) as never,
    } as never;

    const h = harness();
    const deps: BookingDeps = {
      ...h.deps,
      openCheckout: (a) => createCreatorCheckoutHold(a, moneyDeps),
    };
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      deps,
    );

    expect(created).toHaveLength(1);
    const params = created[0] as {
      payment_intent_data: { capture_method: string };
      line_items: { price_data: { unit_amount: number } }[];
      mode: string;
    };
    expect(params.mode).toBe("payment");
    expect(params.payment_intent_data.capture_method).toBe("manual");
    expect(params.line_items[0].price_data.unit_amount).toBe(16_500);
  });
});

describe("the optional brief on the browse door", () => {
  const application = {
    id: APPLICATION,
    tenant_id: TENANT,
    brief_id: BRIEF,
    human_member_id: CREATOR,
    status: "applied",
    quoted_rate_usd: 200,
    pitch: "I shoot in my kitchen",
  };
  const postedBrief = {
    id: BRIEF,
    title: "Spring hooks",
    lane: "ugc_video",
    delivery_days: 7,
    deliverables: 3,
    utm_campaign: "spring",
    answer_by: null,
  };

  it("books with NO brief at all, exactly as before, and stores null", async () => {
    const h = harness();
    const started = await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        ...URLS,
      },
      h.deps,
    );
    expect(started.order_id).toBe(ORDER);
    expect(started.checkout_url).toBe("https://checkout.stripe.test/cs_test_1");
    expect(h.inserts[0].brief_snapshot).toBeNull();
    expect(started.quote.money.business_total_cents).toBe(16_500);
  });

  it("stores a skipped (empty) brief as null, and still books", async () => {
    const h = harness();
    const started = await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        brief_snapshot_override: bookingBriefSnapshot({ title: "   ", brief: "\n \n" }),
        ...URLS,
      },
      h.deps,
    );
    expect(started.order_id).toBe(ORDER);
    expect(h.inserts[0].brief_snapshot).toBeNull();
  });

  it("stores what the business typed, as a plain object", async () => {
    const h = harness();
    await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        brief_snapshot_override: bookingBriefSnapshot({
          title: "  Beach launch  ",
          brief: "Film the unboxing outdoors.\nSay the name once.",
        }),
        ...URLS,
      },
      h.deps,
    );
    expect(h.inserts[0].brief_snapshot).toEqual({
      title: "Beach launch",
      brief: "Film the unboxing outdoors.\nSay the name once.",
    });
  });

  it("leaves the applicant door alone: the posted brief still freezes", async () => {
    const h = harness({ application, brief: postedBrief });
    await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "applicant", application_id: APPLICATION },
        ...URLS,
      },
      h.deps,
    );
    expect(h.inserts[0].brief_snapshot).toMatchObject({ id: BRIEF, title: "Spring hooks" });
  });

  it("ignores a brief on the offer door, whose terms were already agreed", async () => {
    const OFFER = "77777777-7777-7777-7777-777777777777";
    const h = harness({
      offer: {
        id: OFFER,
        tenant_id: TENANT,
        human_member_id: CREATOR,
        thread_id: null,
        proposed_by: "creator" as const,
        kind: "ugc_video" as const,
        terms: { title: "One extra hook" },
        price_cents: 8_000,
        currency: "usd",
        delivery_days: 3,
        note: "Same shoot",
        status: "open" as const,
        expires_at: "2026-09-13T00:00:00.000Z",
      },
    });
    await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "offer", offer_id: OFFER },
        brief_snapshot_override: { title: "Not this" },
        ...URLS,
      },
      h.deps,
    );
    expect(h.inserts[0].brief_snapshot).toBeNull();
  });

  it("builds nothing out of nothing, and cuts rather than refuses", () => {
    expect(bookingBriefSnapshot({})).toBeNull();
    expect(bookingBriefSnapshot({ title: null, brief: null })).toBeNull();
    expect(bookingBriefSnapshot({ title: "", brief: "  " })).toBeNull();
    expect(bookingBriefSnapshot({ title: "Just a name" })).toEqual({ title: "Just a name" });
    expect(bookingBriefSnapshot({ brief: "Just the words" })).toEqual({ brief: "Just the words" });
    const long = bookingBriefSnapshot({ title: "t".repeat(500), brief: "b".repeat(9000) });
    expect((long as { title: string }).title).toHaveLength(BOOKING_BRIEF_TITLE_MAX);
    expect((long as { brief: string }).brief).toHaveLength(BOOKING_BRIEF_BODY_MAX);
  });

  it("keeps contact details on Zavi, without refusing the brief (Q11/Q13)", () => {
    const out = bookingBriefSnapshot({
      title: "Beach launch",
      brief: "Great, mail me at maya@example.com and we can sort the rest there.",
    }) as { brief: string };
    expect(out.brief).not.toContain("maya@example.com");
    expect(out.brief).toContain(CONTACT_REDACTION);
    expect(out.brief).toContain("sort the rest there");
  });
});

describe("a brief carried alongside the package (the fatigue chain)", () => {
  const fatigueBrief = {
    id: BRIEF,
    title: "Winter hooks, round 2",
    angle: "Show the cold start, not the product shot",
    hook: "It was minus four this morning",
    format: "9:16 UGC talking head, 20-30s",
    lane: "ugc_video",
    delivery_days: 7,
    deliverables: 2,
    utm_campaign: "zavi_brief_winter",
    answer_by: null,
  };

  it("prefills the quote from a brief this workspace owns", async () => {
    const h = harness({ brief: fatigueBrief });
    const q = await quoteCreatorBooking(
      {
        tenant_id: TENANT,
        target: { source: "booking", package_id: PACKAGE },
        brief_id: BRIEF,
      },
      h.deps,
    );
    expect(q.brief_prefill).toEqual({
      brief_id: BRIEF,
      title: "Winter hooks, round 2",
      angle: "Show the cold start, not the product shot",
      hook: "It was minus four this morning",
      format: "9:16 UGC talking head, 20-30s",
      deliverables: 2,
    });
    expect(JSON.stringify(q.brief_prefill)).not.toContain("zavi_brief_winter");
    expect(q.job.package_id).toBe(PACKAGE);
    expect(q.money.business_total_cents).toBe(16_500);
  });

  it("records the brief on the order, which is what carries the tag onward", async () => {
    const h = harness({ brief: fatigueBrief });
    await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        brief_id: BRIEF,
        brief_snapshot_override: bookingBriefSnapshot({
          title: "Winter hooks, round 2",
          brief: "Angle: show the cold start",
        }),
        ...URLS,
      },
      h.deps,
    );
    expect(h.inserts[0].brief_id).toBe(BRIEF);
    expect(h.inserts[0].brief_snapshot).toEqual({
      title: "Winter hooks, round 2",
      brief: "Angle: show the cold start",
    });
  });

  it("gives a brief from ANOTHER workspace no prefill, and still books", async () => {
    const h = harness({ brief: fatigueBrief });
    const q = await quoteCreatorBooking(
      {
        tenant_id: OTHER_TENANT,
        target: { source: "booking", package_id: PACKAGE },
        brief_id: BRIEF,
      },
      h.deps,
    );
    expect(q.brief_prefill).toBeNull();
    expect(q.job.brief_id).toBeNull();
    expect(q.blocked).toBeNull();

    const started = await startCreatorCheckout(
      {
        tenant_id: OTHER_TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        brief_id: BRIEF,
        ...URLS,
      },
      h.deps,
    );
    expect(started.order_id).toBe(ORDER);
    expect(started.checkout_url).toBe("https://checkout.stripe.test/cs_test_1");
    expect(started.quote.money.business_total_cents).toBe(16_500);
    expect(h.inserts[0].brief_id).toBeNull();
    expect(h.inserts[0].brief_snapshot).toBeNull();
  });

  it("behaves exactly as before when no brief is named", async () => {
    const h = harness({ brief: fatigueBrief });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
      h.deps,
    );
    expect(q.brief_prefill).toBeNull();
    expect(q.job.brief_id).toBeNull();

    await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        ...URLS,
      },
      h.deps,
    );
    expect(h.inserts[0].brief_id).toBeNull();
    expect(h.inserts[0].brief_snapshot).toBeNull();
  });

  it("still books when the business skipped the words, and keeps the link", async () => {
    const h = harness({ brief: fatigueBrief });
    const started = await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        brief_id: BRIEF,
        brief_snapshot_override: bookingBriefSnapshot({ title: "  ", brief: "" }),
        ...URLS,
      },
      h.deps,
    );
    expect(started.order_id).toBe(ORDER);
    expect(started.checkout_url).toBe("https://checkout.stripe.test/cs_test_1");
    expect(h.inserts[0].brief_snapshot).toBeNull();
    expect(h.inserts[0].brief_id).toBe(BRIEF);
  });

  it("never lets a brief read failure cost a booking", async () => {
    const h = harness();
    h.deps.loadBrief = async () => {
      throw new Error("supabase is having a day");
    };
    const started = await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        brief_id: BRIEF,
        ...URLS,
      },
      h.deps,
    );
    expect(started.order_id).toBe(ORDER);
    expect(h.inserts[0].brief_id).toBeNull();
  });

  it("ignores a brief on the offer door, whose terms were already agreed", async () => {
    const offer = {
      id: "77777777-7777-7777-7777-777777777777",
      tenant_id: TENANT,
      human_member_id: CREATOR,
      kind: "ugc_video",
      status: "open",
      price_cents: 20_000,
      delivery_days: 6,
      note: "Two videos",
      terms: null,
      proposed_by: "creator",
      thread_id: null,
      expires_at: "2026-09-20T00:00:00.000Z",
    };
    const h = harness({ offer });
    const q = await quoteCreatorBooking(
      {
        tenant_id: TENANT,
        target: { source: "offer", offer_id: offer.id },
        brief_id: BRIEF,
      },
      h.deps,
    );
    expect(q.brief_prefill).toBeNull();
  });
});

describe("copy rule", () => {
  it("never puts an em dash, en dash or double hyphen in a message a person reads", async () => {
    const h = harness({ creator: creator({ country_code: "IN" }) });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
      h.deps,
    );
    const strings = [q.blocked?.message ?? "", q.due_deadline?.line ?? "", q.accept_window?.consequence_text ?? ""];
    for (const s of strings) {
      expect(s).not.toMatch(/[–—]/);
      expect(s).not.toContain("--");
    }
  });
});

describe("hermetic", () => {
  it("makes no fetch call", async () => {
    const spy = vi.spyOn(globalThis, "fetch" as never);
    const h = harness();
    await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "booking", package_id: PACKAGE } },
      h.deps,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("product_needed: no due date until the product arrives", () => {
  const S4_OFFER = "77777777-7777-7777-7777-777777777777";
  const offer = {
    id: S4_OFFER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    thread_id: null,
    proposed_by: "creator" as const,
    kind: "ugc_video" as const,
    terms: { title: "Unboxing" },
    price_cents: 8_000,
    currency: "usd",
    delivery_days: 3,
    note: null,
    status: "open" as const,
    expires_at: "2026-09-13T00:00:00.000Z",
  };

  it("a booking the business flags writes due_at null and the flag, and the quote says so", async () => {
    const h = harness();
    const started = await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "booking", package_id: PACKAGE },
        product_needed: true,
        ...URLS,
      },
      h.deps,
    );
    expect(h.inserts[0].due_at).toBeNull();
    expect(h.inserts[0].product_needed).toBe(true);
    expect(started.quote.due_at).toBeNull();
    expect(started.quote.due_deadline).toBeNull();
    expect(started.quote.product_needed).toBe(true);
  });

  it("an unflagged booking has no date until the creator accepts (Ravi 2026-09-27)", async () => {
    const h = harness();
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      h.deps,
    );
    expect(h.inserts[0].due_at).toBeNull();
    expect(h.inserts[0].product_needed).toBe(false);
  });

  it("an offer carries its own flag, and a caller cannot turn it on for the offer door", async () => {
    const flagged = harness({ offer: { ...offer, product_needed: true } });
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "offer", offer_id: S4_OFFER }, ...URLS },
      flagged.deps,
    );
    expect(flagged.inserts[0].due_at).toBeNull();

    const plain = harness({ offer });
    await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "offer", offer_id: S4_OFFER },
        product_needed: true,
        ...URLS,
      },
      plain.deps,
    );
    expect(plain.inserts[0].product_needed).toBe(false);
    expect(plain.inserts[0].due_at).not.toBeNull();
  });

  it("a hire off a product_needed brief gets no due date even when one was passed", async () => {
    const h = harness({
      application: {
        id: APPLICATION,
        tenant_id: TENANT,
        brief_id: BRIEF,
        human_member_id: CREATOR,
        status: "applied",
        quoted_rate_usd: 200,
        pitch: "hi",
      },
      brief: {
        id: BRIEF,
        title: "Try the product",
        lane: "ugc_video",
        delivery_days: 7,
        deliverables: 1,
        utm_campaign: "x",
        answer_by: null,
        product_needed: true,
      },
    });
    await startCreatorCheckout(
      {
        tenant_id: TENANT,
        user_id: "u1",
        target: { source: "applicant", application_id: APPLICATION },
        due_at: "2026-09-20T00:00:00.000Z",
        ...URLS,
      },
      h.deps,
    );
    expect(h.inserts[0].due_at).toBeNull();
    expect(h.inserts[0].product_needed).toBe(true);
  });

  it("an offer quote shows no 72h accept window: paying starts the job", async () => {
    const h = harness({ offer });
    const q = await quoteCreatorBooking(
      { tenant_id: TENANT, target: { source: "offer", offer_id: S4_OFFER } },
      h.deps,
    );
    expect(q.accept_window).toBeNull();
  });
});

describe("one pending checkout per direct booking (Back, then Book again)", () => {
  const PENDING = "77777777-7777-7777-7777-777777777777";
  const pending = (over: Partial<CreatorOrderStateRow & { brief_id: string | null }> = {}) =>
    ({ ...orderRow({ id: PENDING }), brief_id: null, ...over }) as CreatorOrderStateRow & { brief_id: string | null };

  function withDedupe(h: Harness, found: ReturnType<typeof pending> | null) {
    const refreshed: unknown[] = [];
    const superseded: string[] = [];
    const resumed: string[] = [];
    const deps: BookingDeps = {
      ...h.deps,
      findPendingBooking: async () => found,
      refreshPendingBooking: async (a) => {
        refreshed.push(a);
        return found ? { ...found, due_at: a.due_at } : null;
      },
      supersedePendingBooking: async (_t, id) => {
        superseded.push(id);
      },
      resumeCheckout: async (a) => {
        resumed.push(a.order_id);
        return { checkout_session_id: "cs_open", url: "https://checkout.stripe.test/cs_open", amount_cents: 16_500, reused_session: true };
      },
    };
    return { deps, refreshed, superseded, resumed };
  }

  const book = (deps: BookingDeps, extra: Record<string, unknown> = {}) =>
    startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS, ...extra } as never,
      deps,
    );

  it("same terms: reuses the open order and its open Stripe page, with the brief just typed", async () => {
    const h = harness();
    const d = withDedupe(h, pending());
    const out = await book(d.deps, { brief_snapshot_override: { brief: "New angle" } });
    expect(out.order_id).toBe(PENDING);
    expect(out.reused_existing).toBe(true);
    expect(out.checkout_url).toBe("https://checkout.stripe.test/cs_open");
    expect(h.inserts).toHaveLength(0);
    expect(h.checkouts).toHaveLength(0);
    expect(d.resumed).toEqual([PENDING]);
    expect(d.refreshed).toEqual([expect.objectContaining({ order_id: PENDING, brief_snapshot: { brief: "New angle" } })]);
  });

  it("different price: closes the old pending order first, then books a new one", async () => {
    const h = harness();
    const d = withDedupe(h, pending({ price_cents: 9_900 }));
    const out = await book(d.deps);
    expect(d.superseded).toEqual([PENDING]);
    expect(h.inserts).toHaveLength(1);
    expect(out.reused_existing).toBe(false);
    expect(d.resumed).toHaveLength(0);
  });

  it("a different product-shipping answer is different terms too", async () => {
    const h = harness();
    const d = withDedupe(h, pending({ product_needed: true }));
    await book(d.deps);
    expect(d.superseded).toEqual([PENDING]);
    expect(h.inserts).toHaveLength(1);
  });

  it("refuses, and books nothing, when the old order turns out to be paid", async () => {
    const h = harness();
    const d = withDedupe(h, pending({ price_cents: 9_900 }));
    d.deps.supersedePendingBooking = async () => {
      throw new ExpectedToolError("already_booked", "You already paid for this package with this creator. Open it from Jobs.");
    };
    await expect(book(d.deps)).rejects.toMatchObject({ code: "already_booked" });
    expect(h.inserts).toHaveLength(0);
  });

  it("a concurrent Book that wins the insert goes through the same terms check (R1)", async () => {
    const h = harness({ duplicateOn: () => pending({ price_cents: 9_900 }) });
    const d = withDedupe(h, null);
    let calls = 0;
    d.deps.insertOrder = async (row) => {
      calls += 1;
      h.inserts.push(row);
      if (calls === 1) return { ok: false, code: "duplicate", existing: pending({ price_cents: 9_900 }) };
      return { ok: true, order: orderRow({ id: "88888888-8888-8888-8888-888888888888" }) };
    };
    const out = await book(d.deps);
    expect(d.superseded).toEqual([PENDING]);
    expect(calls).toBe(2);
    expect(out.order_id).toBe("88888888-8888-8888-8888-888888888888");
  });

  it("a concurrent Book with the same terms reuses the winner", async () => {
    const h = harness();
    const d = withDedupe(h, null);
    d.deps.insertOrder = async () => ({ ok: false, code: "duplicate", existing: pending() });
    const out = await book(d.deps);
    expect(out.order_id).toBe(PENDING);
    expect(out.reused_existing).toBe(true);
    expect(d.resumed).toEqual([PENDING]);
    expect(d.superseded).toHaveLength(0);
  });
});

describe("a reused order reopens payment through resume, never a second create", () => {
  it("hands back the open session instead of calling create with the original key", async () => {
    const h = harness();
    const resumed: string[] = [];
    const deps: BookingDeps = {
      ...h.deps,
      insertOrder: async () => ({ ok: false, code: "duplicate", existing: orderRow() }),
      resumeCheckout: async (a) => {
        resumed.push(a.order_id);
        return { checkout_session_id: "cs_open", url: "https://pay/open", amount_cents: 16_500, reused_session: true };
      },
    };
    const out = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      deps,
    );
    expect(out.reused_existing).toBe(true);
    expect(resumed).toEqual([ORDER]);
    expect(h.checkouts).toHaveLength(0);
  });
});

describe("reuse keeps the first checkout's parameters and terms", () => {
  it("passes the booker's email to resume, like the first create did", async () => {
    const h = harness();
    const seen: unknown[] = [];
    const deps: BookingDeps = {
      ...h.deps,
      insertOrder: async () => ({ ok: false, code: "duplicate", existing: orderRow() }),
      resumeCheckout: async (a) => {
        seen.push(a.customer_email);
        return { checkout_session_id: "cs", url: "https://pay", amount_cents: 16_500, reused_session: true };
      },
    };
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", user_email: "owner@acme.test", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      deps,
    );
    expect(seen).toEqual(["owner@acme.test"]);
  });

  it("a changed total (fees moved) is different terms, not a reuse", async () => {
    const h = harness();
    const superseded: string[] = [];
    const deps: BookingDeps = {
      ...h.deps,
      findPendingBooking: async () => ({ ...orderRow({ business_total_cents: 16_000 }), brief_id: null }),
      supersedePendingBooking: async (_t, id) => {
        superseded.push(id);
      },
    };
    await startCreatorCheckout({ tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS }, deps);
    expect(superseded).toEqual([ORDER]);
    expect(h.inserts).toHaveLength(1);
  });
});

describe("an agent-initiated hire holds an order and opens no Checkout (S3, test 15)", () => {
  const RUN = "88888888-8888-4888-8888-888888888888";
  const AGENT_OFFER = "77777777-7777-7777-7777-777777777777";
  const HOLD_UNTIL = new Date(Date.parse(T0) + 72 * 3_600_000).toISOString();
  const agentDeadline = { kind: "checkout_expiry", deadline_at: HOLD_UNTIL };

  function stripeSpies(h: Harness) {
    const openCheckout = vi.fn(h.deps.openCheckout);
    const resumeCheckout = vi.fn(async () => ({
      checkout_session_id: "cs_resumed",
      url: "https://checkout.stripe.test/cs_resumed",
      amount_cents: 16_500,
      reused_session: false,
    }));
    const attachSession = vi.fn(async () => {});
    const armDeadline = vi.fn(async () => {});
    const deps: BookingDeps = { ...h.deps, openCheckout, resumeCheckout, attachSession, armDeadline };
    return { deps, openCheckout, resumeCheckout, attachSession, armDeadline };
  }

  function expectNoStripe(s: ReturnType<typeof stripeSpies>) {
    expect(s.openCheckout).not.toHaveBeenCalled();
    expect(s.resumeCheckout).not.toHaveBeenCalled();
    expect(s.attachSession).not.toHaveBeenCalled();
  }

  it("inserts the checkout_pending order, holds it exactly 72h, arms that deadline, and never touches Stripe", async () => {
    const h = harness();
    const s = stripeSpies(h);
    const out = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: null, target: { source: "booking", package_id: PACKAGE }, initiator: "agent", agent_run_id: RUN },
      s.deps,
    );
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({
      tenant_id: TENANT,
      source: "booking",
      package_id: PACKAGE,
      booked_by_user_id: null,
      price_cents: 15_000,
      business_fee_cents: 1_500,
    });
    expect(h.inserts[0].checkout_deadline).toEqual(agentDeadline);
    expect(Date.parse(HOLD_UNTIL) - Date.parse(T0)).toBe(259_200_000);
    expect(s.armDeadline).toHaveBeenCalledTimes(1);
    expect(s.armDeadline).toHaveBeenCalledWith({ order_id: ORDER, tenant_id: TENANT, deadline: agentDeadline });
    expectNoStripe(s);
    expect(h.checkouts).toHaveLength(0);
    expect(out).toMatchObject({ order_id: ORDER, checkout_session_id: null, checkout_url: null, reused_existing: false });
    expect(out.quote.money.business_total_cents).toBe(16_500);
  });

  it("does not need the $500 confirm (the founder's tap is the confirm) and still opens nothing", async () => {
    const h = harness({ pkg: pkg({ price_cents: 100_000 }) });
    const s = stripeSpies(h);
    const out = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: null, target: { source: "booking", package_id: PACKAGE }, initiator: "agent", agent_run_id: RUN },
      s.deps,
    );
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].price_cents).toBe(100_000);
    expect(out.checkout_session_id).toBeNull();
    expectNoStripe(s);
  });

  function agentOffer(over: Record<string, unknown> = {}) {
    return {
      id: AGENT_OFFER,
      tenant_id: TENANT,
      human_member_id: CREATOR,
      thread_id: null,
      proposed_by: "tenant",
      kind: "ugc_video",
      terms: { title: "One extra hook" },
      price_cents: 8_000,
      currency: "usd",
      delivery_days: 3,
      note: null,
      status: "accepted",
      expires_at: "2026-09-20T00:00:00.000Z",
      agent_run_id: RUN,
      ...over,
    };
  }
  const offerTarget = { source: "offer" as const, offer_id: AGENT_OFFER };

  it("stamps the order with the agent run that proposed it", async () => {
    const h = harness();
    const s = stripeSpies(h);
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: null, target: { source: "booking", package_id: PACKAGE }, initiator: "agent", agent_run_id: RUN },
      s.deps,
    );
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].agent_run_id).toBe(RUN);
    expectNoStripe(s);
  });

  it("an agent hire without its run id is refused before any order is written", async () => {
    const h = harness();
    const s = stripeSpies(h);
    await expect(
      startCreatorCheckout({ tenant_id: TENANT, user_id: null, target: { source: "booking", package_id: PACKAGE }, initiator: "agent" }, s.deps),
    ).rejects.toThrow(/agent_run_id/);
    expect(h.inserts).toHaveLength(0);
    expectNoStripe(s);
  });

  it("a human booking can never carry an agent run id", async () => {
    const h = harness();
    const s = stripeSpies(h);
    await expect(
      startCreatorCheckout(
        { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, agent_run_id: RUN, ...URLS },
        s.deps,
      ),
    ).rejects.toThrow(/agent_run_id/);
    expect(h.inserts).toHaveLength(0);
    expectNoStripe(s);
  });

  it("an accepted agent offer whose own expiry comes first closes at the offer's expiry, not 72h out", async () => {
    const h = harness({ offer: agentOffer({ expires_at: "2026-09-13T00:00:00.000Z" }) });
    const s = stripeSpies(h);
    const out = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: null, target: offerTarget, offer_already_claimed: true, initiator: "agent", agent_run_id: RUN },
      s.deps,
    );
    const offerClose = { kind: "checkout_expiry", deadline_at: "2026-09-13T00:00:00.000Z" };
    expect(h.inserts[0]).toMatchObject({ offer_id: AGENT_OFFER, agent_run_id: RUN, checkout_deadline: offerClose });
    expect(s.armDeadline).toHaveBeenCalledWith(expect.objectContaining({ deadline: offerClose }));
    expect(out.checkout_session_id).toBeNull();
    expectNoStripe(s);
  });

  it("an agent offer agreed to an earlier due day closes at the end of that day", async () => {
    const h = harness({ offer: agentOffer({ terms: { title: "x", due_date: "2026-09-12" } }) });
    const s = stripeSpies(h);
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: null, target: offerTarget, offer_already_claimed: true, initiator: "agent", agent_run_id: RUN },
      s.deps,
    );
    expect(Date.parse(h.inserts[0].checkout_deadline!.deadline_at)).toBeLessThan(Date.parse(HOLD_UNTIL));
    expect(h.inserts[0].checkout_deadline!.deadline_at.startsWith("2026-09-12")).toBe(true);
  });

  it("an accepted agent offer that outlives the hold still closes 72h from now", async () => {
    const h = harness({ offer: agentOffer({ expires_at: "2026-09-20T00:00:00.000Z" }) });
    const s = stripeSpies(h);
    await startCreatorCheckout(
      { tenant_id: TENANT, user_id: null, target: offerTarget, offer_already_claimed: true, initiator: "agent", agent_run_id: RUN },
      s.deps,
    );
    expect(h.inserts[0].checkout_deadline).toEqual(agentDeadline);
    expectNoStripe(s);
  });

  it("an agent offer taken to Checkout by a person is refused with no order and no Stripe call", async () => {
    const h = harness({ offer: agentOffer() });
    const s = stripeSpies(h);
    await expect(
      startCreatorCheckout(
        { tenant_id: TENANT, user_id: "u1", target: offerTarget, offer_already_claimed: true, large_amount_confirmed: true, ...URLS },
        s.deps,
      ),
    ).rejects.toMatchObject({ code: "creator_hire_awaiting_approval", message: "This hire is waiting for the founder's approval on its hire card." });
    expect(h.inserts).toHaveLength(0);
    expectNoStripe(s);
    expect(h.checkouts).toHaveLength(0);
  });

  it("an agent offer driven by a different run is refused before any order is written", async () => {
    const h = harness({ offer: agentOffer({ agent_run_id: "99999999-9999-4999-8999-999999999999" }) });
    const s = stripeSpies(h);
    await expect(
      startCreatorCheckout(
        { tenant_id: TENANT, user_id: null, target: offerTarget, offer_already_claimed: true, initiator: "agent", agent_run_id: RUN },
        s.deps,
      ),
    ).rejects.toThrow(/different agent run/);
    expect(h.inserts).toHaveLength(0);
  });

  it("a person reusing an order stamped by an agent gets the 409 copy and Checkout is never reopened", async () => {
    const h = harness();
    const s = stripeSpies(h);
    const loadCheckoutOrder = vi.fn(async () => ({ id: ORDER, agent_run_id: RUN }) as never);
    const deps: BookingDeps = {
      ...s.deps,
      loadCheckoutOrder,
      insertOrder: async () => ({ ok: false, code: "duplicate", existing: orderRow() }),
    };
    await expect(
      startCreatorCheckout({ tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS }, deps),
    ).rejects.toMatchObject({ code: "creator_hire_awaiting_approval" });
    expect(loadCheckoutOrder).toHaveBeenCalledWith(TENANT, ORDER);
    expectNoStripe(s);
    expect(h.checkouts).toHaveLength(0);
  });

  it("a person reusing their own unstamped order still resumes Checkout", async () => {
    const h = harness();
    const s = stripeSpies(h);
    const deps: BookingDeps = {
      ...s.deps,
      loadCheckoutOrder: async () => ({ id: ORDER, agent_run_id: null }) as never,
      insertOrder: async () => ({ ok: false, code: "duplicate", existing: orderRow() }),
    };
    const out = await startCreatorCheckout({ tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS }, deps);
    expect(s.resumeCheckout).toHaveBeenCalledTimes(1);
    expect(out.checkout_session_id).toBe("cs_resumed");
  });

  it("a repeated agent booking on the same terms reuses the held order: no second insert, no Stripe, no re-arm", async () => {
    const PENDING = "77777777-7777-7777-7777-777777777777";
    const h = harness();
    const s = stripeSpies(h);
    const refreshed: string[] = [];
    const lookedUpFor: (string | null)[] = [];
    const deps: BookingDeps = {
      ...s.deps,
      findPendingBooking: async (a) => {
        lookedUpFor.push(a.booked_by_user_id);
        return { ...orderRow({ id: PENDING }), brief_id: null };
      },
      refreshPendingBooking: async (a) => {
        refreshed.push(a.order_id);
        return { ...orderRow({ id: PENDING }), brief_id: null };
      },
      supersedePendingBooking: async () => {
        throw new Error("same terms must not supersede");
      },
    };
    const out = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: null, target: { source: "booking", package_id: PACKAGE }, initiator: "agent", agent_run_id: RUN },
      deps,
    );
    expect(lookedUpFor).toEqual([null]);
    expect(out).toMatchObject({ order_id: PENDING, reused_existing: true, checkout_session_id: null, checkout_url: null });
    expect(refreshed).toEqual([PENDING]);
    expect(h.inserts).toHaveLength(0);
    expect(s.armDeadline).not.toHaveBeenCalled();
    expectNoStripe(s);
  });

  it("an agent booking that loses the insert race to a held order hands back that order and opens nothing", async () => {
    const h = harness();
    const s = stripeSpies(h);
    const deps: BookingDeps = {
      ...s.deps,
      insertOrder: async (row) => {
        h.inserts.push(row);
        return { ok: false, code: "duplicate", existing: orderRow() };
      },
    };
    const out = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: null, target: { source: "booking", package_id: PACKAGE }, initiator: "agent", agent_run_id: RUN },
      deps,
    );
    expect(out).toMatchObject({ order_id: ORDER, reused_existing: true, checkout_session_id: null });
    expect(h.inserts).toHaveLength(1);
    expect(s.armDeadline).not.toHaveBeenCalled();
    expectNoStripe(s);
  });

  it("without the agent initiator the same booking still opens Checkout, attaches it and keeps the 25h close", async () => {
    const h = harness();
    const s = stripeSpies(h);
    const out = await startCreatorCheckout(
      { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
      s.deps,
    );
    const deadline = { kind: "checkout_expiry", deadline_at: new Date(Date.parse(T0) + 25 * 3_600_000).toISOString() };
    expect(s.openCheckout).toHaveBeenCalledTimes(1);
    expect(s.attachSession).toHaveBeenCalledWith({ tenant_id: TENANT, order_id: ORDER, checkout_session_id: "cs_test_1" });
    expect(s.resumeCheckout).not.toHaveBeenCalled();
    expect(h.inserts[0].checkout_deadline).toEqual(deadline);
    expect(out.checkout_session_id).toBe("cs_test_1");
    expect(out.checkout_url).toBe("https://checkout.stripe.test/cs_test_1");
  });

  it("without the agent initiator the $500 confirm is still enforced", async () => {
    const h = harness({ pkg: pkg({ price_cents: 100_000 }) });
    const s = stripeSpies(h);
    await expect(
      startCreatorCheckout(
        { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, ...URLS },
        s.deps,
      ),
    ).rejects.toMatchObject({ code: "large_amount_confirm_required" });
    expect(h.inserts).toHaveLength(0);
  });

  it("without the agent initiator a missing return URL refuses before any order is written", async () => {
    const h = harness();
    const s = stripeSpies(h);
    await expect(
      startCreatorCheckout(
        { tenant_id: TENANT, user_id: "u1", target: { source: "booking", package_id: PACKAGE }, success_url: URLS.success_url },
        s.deps,
      ),
    ).rejects.toThrow(/success_url and cancel_url are required/);
    expect(h.inserts).toHaveLength(0);
    expectNoStripe(s);
  });
});
