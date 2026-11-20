
import { describe, expect, it } from "vitest";
import {
  applicantOutcome,
  bookableLine,
  closedReasonLine,
  runningTotalLine,
  shortDate,
  usd,
  type ApplicantView,
  type CreatorFees,
  type CreatorVisibleBrief,
} from "./humanPostedBriefs";

const FEES: CreatorFees = {
  price_cents: 15_000,
  business_fee_cents: 1_500,
  business_total_cents: 16_500,
  creator_fee_cents: 2_250,
  creator_payout_cents: 12_750,
  zavi_gross_cents: 3_750,
  currency: "usd",
};

function brief(over: Partial<CreatorVisibleBrief> = {}): CreatorVisibleBrief {
  return {
    id: "b1",
    business_name: "Northwind Coffee",
    title: "3 ad videos",
    angle: "a",
    hook: "h",
    format: "9:16",
    deliverables: 3,
    budget_usd: 450,
    lane: "ugc_video",
    delivery_days: 7,
    posted_at: "2026-09-11T00:00:00.000Z",
    answer_by: "2026-09-16T00:00:00.000Z",
    applicant_cap: 20,
    applicant_count: 2,
    spots_left: 18,
    open: true,
    closed_reason: null,
    ...over,
  };
}

function applicant(over: Partial<ApplicantView> = {}): ApplicantView {
  return {
    application_id: "a1",
    human_member_id: "c1",
    display_name: "Maya R",
    slug: "maya",
    city: "Austin",
    country_code: "US",
    bookable: true,
    status: "applied",
    note: "I shoot handovers",
    applied_at: "2026-09-11T00:00:00.000Z",
    quoted_rate_usd: 150,
    fees: FEES,
    ...over,
  };
}

describe("money is read, never derived", () => {
  it("renders the running total straight off the API's fee object", () => {
    const line = runningTotalLine(FEES);
    expect(line).toContain("$165.00");
    expect(line).toContain("$150.00");
    expect(line).toContain("$15.00");
  });

  it("invents no figure when the API sent a DIFFERENT total than 10% of price", () => {
    const odd: CreatorFees = { ...FEES, business_total_cents: 12_345 };
    expect(runningTotalLine(odd)).toContain("$123.45");
    expect(runningTotalLine(odd)).not.toContain("$165.00");
  });

  it("says a missing price is missing, never $0.00", () => {
    expect(runningTotalLine(null)).toContain("did not leave a price");
    expect(runningTotalLine(null)).not.toContain("$0.00");
    expect(usd(null)).toBe("not given");
    expect(usd(Number.NaN)).toBe("not given");
  });

  it("formats cents to two places", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(1)).toBe("$0.01");
    expect(usd(16_500)).toBe("$165.00");
  });
});

describe("honest states on screen", () => {
  it("says nothing extra while the brief is open", () => {
    expect(closedReasonLine(brief())).toBeNull();
  });

  it("names the reason a brief is shut", () => {
    expect(closedReasonLine(brief({ open: false, closed_reason: "cap_reached" }))).toContain(
      "application limit",
    );
    expect(closedReasonLine(brief({ open: false, closed_reason: "answer_by_passed" }))).toContain(
      "answer-by date passed",
    );
    expect(closedReasonLine(brief({ open: false, closed_reason: "filled" }))).toContain("hired someone");
  });

  it("distinguishes an unposted draft from a closed brief", () => {
    expect(closedReasonLine(brief({ open: false, posted_at: null, closed_reason: null }))).toContain(
      "has not been posted yet",
    );
  });

  it("invariant 7: says why an unpayable creator cannot be hired", () => {
    expect(bookableLine(applicant())).toBeNull();
    const blocked = bookableLine(applicant({ bookable: false, country_code: "NG" }));
    expect(blocked).toContain("cannot pay creators");
    expect(blocked).toContain("Nothing would be charged");
  });

  it("says no date rather than rendering an invalid one", () => {
    expect(shortDate(null)).toBe("no date set");
    expect(shortDate("not-a-date")).toBe("no date set");
    expect(shortDate("2026-09-16T00:00:00.000Z")).toBe("2026-09-16");
  });
});

describe("copy rule", () => {
  it("uses no em dash, en dash or double hyphen", () => {
    const all = [
      runningTotalLine(FEES),
      runningTotalLine(null),
      closedReasonLine(brief({ open: false, closed_reason: "cap_reached" })) ?? "",
      closedReasonLine(brief({ open: false, closed_reason: "answer_by_passed" })) ?? "",
      closedReasonLine(brief({ open: false, closed_reason: "filled" })) ?? "",
      closedReasonLine(brief({ open: false, posted_at: null })) ?? "",
      bookableLine(applicant({ bookable: false })) ?? "",
      usd(null),
      shortDate(null),
    ].join(" ");
    expect(all).not.toMatch(/[–—]|--/);
  });
});

describe("applicantOutcome", () => {
  it("says what became of a hire, in the creator's own words", () => {
    expect(applicantOutcome({ status: "approved", hire_state: "hired" })).toBe("Hired");
    expect(applicantOutcome({ status: "approved", hire_state: "cancelled" })).toBe("Hired, then cancelled");
    expect(applicantOutcome({ status: "approved", hire_state: "unpaid" })).toBe("Hire not paid, nothing charged");
    expect(applicantOutcome({ status: "rejected", hire_state: null })).toBe("Not hired");
  });
});
