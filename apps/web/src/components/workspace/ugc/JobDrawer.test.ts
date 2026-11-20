import { describe, expect, it } from "vitest";
import { deliveryVersions, groupJobActions, isAcceptedJob, jobHistory, jobView, stageOf } from "./JobDrawer";
import type { CreatorJobDetail } from "@/components/humans/creatorJobTypes";

function detail(over: Partial<CreatorJobDetail["job"]> = {}, rest: Partial<CreatorJobDetail> = {}): CreatorJobDetail {
  return {
    job: {
      id: "o1",
      source: "offer",
      status: "checkout_pending",
      closed_reason: null,
      title: "3 UGC videos",
      creator_display_name: "Maya Films",
      creator_slug: null,
      created_at: "2026-09-20T00:00:00Z",
      due_at: null,
      money: { currency: "usd", price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500, business_fee_label: "10%", creator_payout_cents: 12750, payout_status: "held" },
      deadline: null,
      awaiting_creator: false,
      ...over,
    },
    package_snapshot: null,
    brief_snapshot: null,
    submissions: [],
    actions: [],
    rebook: null,
    extension: null,
    dispute: null,
    thread: { available: false, thread_id: null, messages: [] },
    ...rest,
  } as CreatorJobDetail;
}

describe("job drawer money words follow the capture rules", () => {
  it("an unpaid offer is charged when paid", () => {
    expect(jobView(detail()).body[0]).toMatch(/Paying charges your card/);
  });

  it("no job until it is paid: an unpaid booking or hire offers no Pay to start", () => {
    for (const source of ["booking", "applicant"] as const) {
      for (const payment of ["unpaid", "left"] as const) {
        const v = jobView(detail({ source }), payment);
        expect(v.pay).toBeFalsy();
        expect(v.title).toBe("Nothing was charged");
        expect(v.body.join(" ")).toMatch(/nothing was charged and no job was started/);
      }
    }
  });

  it("back from Stripe, never says nothing is paid while fulfil is still pending", () => {
    const v = jobView(detail(), "confirming");
    expect(v.title).toBe("Confirming your payment");
    expect(jobView(detail({ source: "booking" }), "confirming").title).toBe("Confirming the hold on your card");
    expect(v.body.join(" ")).toMatch(/Do not pay again/);
    expect(jobView(detail(), "slow").title).toBe("Still waiting on your bank");
  });

  it("after two rounds of changes says to ask Zavi for help", () => {
    const v = jobView(detail({ status: "submitted" }, { revisions: { used: 2, left: 0, max: 2 } }));
    expect(v.body[0]).toMatch(/Changes requested: 2 of 2, 0 left. If it still isn't right, ask Zavi for help./);
  });

  it("a staff-held payment never invites a second checkout", () => {
    const v = jobView(detail(), { problem: "needs_staff", message: "The payment went through but the job could not start. Zavi staff will sort it." });
    const text = [v.title, ...v.body].join(" ");
    expect(text).not.toMatch(/Nothing is charged yet/);
    expect(text).not.toMatch(/Pay to start|Pay \$/);
    expect(v.title).toBe("Zavi staff have to look at this");
    expect(v.body).toContain("Do not pay again.");
    expect(text).not.toMatch(/emails you/);
    expect(jobView(detail({ source: "booking" }), { problem: "cancelled", message: "Cancelled." }).body.join(" ")).not.toMatch(/Nothing is charged yet/);
  });

  it("an unpaid job offers ONE Pay to start; a staff-held or confirming one never does", () => {
    expect(jobView(detail()).pay).toBe(true);
    expect(jobView(detail(), "confirming").pay).toBeFalsy();
    expect(jobView(detail(), { problem: "needs_staff", message: "x" }).pay).toBeFalsy();
  });

  it("an unpaid offer past its expiry offers no Pay and says nothing was charged", () => {
    const v = jobView(detail({ offer_expired: true }));
    expect(v.pay).toBeFalsy();
    expect(v.title).toBe("This offer expired before it was paid");
    expect(v.body.join(" ")).toMatch(/Nothing was charged/);
    expect(jobView(detail({ offer_expired: false })).pay).toBe(true);
  });

  it("an agent's hire waiting on its card offers no Pay to start and points to the hire card", () => {
    for (const source of ["offer", "booking"] as const) {
      for (const payment of ["unpaid", "left"] as const) {
        const v = jobView(detail({ source, offer_expired: false, awaiting_hire_approval: true }), payment);
        expect(v.pay).toBeFalsy();
        expect(v.title).toBe("Approve the hire card to start");
        expect(v.body.join(" ")).toMatch(/hire card/);
        expect(v.body.join(" ")).toMatch(/Nothing is charged until you approve/);
      }
    }
    expect(jobView(detail({ awaiting_hire_approval: true }), "confirming").title).toBe("Confirming your payment");
  });

  it("back from Stripe with cancelled=1 says the payment was not finished and nothing was charged", () => {
    const v = jobView(detail(), "left");
    expect(v.title).toBe("Pay to start the job");
    expect(v.chip[1]).toBe("Not paid");
    expect(v.body[0]).toBe("You left the payment page, so nothing was charged.");
    expect(v.pay).toBe(true);
  });
});

describe("an approved job (wireframe drawer=review&state=approved)", () => {
  it("names the ad rights from the package, and never a post that stays up on the creator's account", () => {
    const v = jobView(
      detail({ status: "completed", closed_reason: "approved", source: "booking" }, { package_snapshot: { kind: "ugc_video", ad_rights_days: 90, stays_up_days: 30 } }),
    );
    expect(v.body).toContain("You can run this video as an ad for 90 days, the ad rights in the package.");
    const paid = detail({ status: "completed", closed_reason: "approved", closed_at: "2026-10-02T10:00:00Z" });
    paid.job.money.payout_status = "transferred";
    expect(jobView(paid).title).toBe("You approved on Oct 2. Maya's payout is released.");
    expect(v.body.join(" ")).not.toMatch(/stays up|labelled as an ad/);
  });

  it("an old audience-post job is not an ad video: no ad rights and no stays-up line", () => {
    for (const closed_reason of ["approved", "auto_accepted"]) {
      const v = jobView(
        detail(
          { status: "completed", closed_reason, source: "booking" },
          { package_snapshot: { kind: "audience_post", ad_rights_days: 90, stays_up_days: 30, platform: "tiktok", post_type: "video" } },
        ),
      );
      expect(v.body.join(" ")).not.toMatch(/ad rights|run this video as an ad|stays up|labelled as an ad/);
    }
  });

  it("a job accepted automatically is accepted too: ad rights, Book again and Next: run it as an ad", () => {
    const d = detail({ status: "completed", closed_reason: "auto_accepted", source: "booking" }, { package_snapshot: { ad_rights_days: 90 } });
    expect(isAcceptedJob(d.job)).toBe(true);
    expect(jobView(d).body).toContain("You can run this video as an ad for 90 days, the ad rights in the package.");
    expect(isAcceptedJob(detail({ status: "cancelled", closed_reason: "no_show" }).job)).toBe(false);
  });

  it("tells the business the price it agreed, never the creator's amount after Zavi's 15%", () => {
    const body = jobView(detail({ status: "completed", closed_reason: "approved" })).body.join(" ");
    expect(body).toContain("Your agreed $150 payment to Maya is released.");
    expect(body).not.toContain("$127.50");
    expect(body).not.toContain("15%");
  });

  it("an offer job with no package terms says neither", () => {
    const v = jobView(detail({ status: "completed", closed_reason: "approved" }));
    expect(v.body.join(" ")).not.toMatch(/ad rights|stays up/);
  });
});

describe("Ask Zavi on an auto-accepted job (Ravi 2026-09-27: 10 days after auto-approve)", () => {
  const ask = { action: "ask_zavi_in_buffer", label: "Ask Zavi to step in", consequence: "x", wants_note: true };
  const auto = { status: "completed", closed_reason: "auto_accepted", source: "booking", closed_at: "2026-10-01T12:00:00Z" } as const;

  it("inside the window: says the payout is held until Zavi decides, with the date", () => {
    const v = jobView(detail(auto, { actions: [ask] as CreatorJobDetail["actions"] }));
    expect(v.body[0]).toBe("Maya is paid on Oct 11, 12:00 UTC. Until then you can ask Zavi to step in, and the payout is held until Zavi decides.");
  });

  it("after the window the server offers no button, and the drawer promises none", () => {
    const d = detail(auto);
    d.job.money.payout_status = "transferred";
    const v = jobView(d);
    expect(v.body[0]).toBe("The 10 days to ask Zavi to step in have passed. Maya's payout is released.");
    const r = detail(auto);
    r.job.money.payout_status = "ready";
    expect(jobView(r).body[0]).toBe("The 10 days to ask Zavi to step in have passed. Zavi has not sent Maya's payout yet.");
    expect(v.body.join(" ")).not.toMatch(/you can ask Zavi/);
  });

  it("after the window, a payout parked on Stripe setup is not called released", () => {
    const d = detail(auto);
    d.job.money.payout_status = "awaiting_payout_account";
    expect(jobView(d).body[0]).toBe("The 10 days to ask Zavi to step in have passed. Zavi pays Maya once their Stripe setup is finished.");
  });
});

describe("a package booking's due date waits for the creator's accept (Ravi 2026-09-27)", () => {
  it("before the accept, the business reads the days after the accept, not a date", () => {
    const v = jobView(detail({ status: "awaiting_acceptance", source: "booking", due_after_accept: "7 days after Maya accepts" }));
    expect(v.body).toContain("The work is due 7 days after Maya accepts.");
  });
});

describe("waiting for the creator to accept (payment confirmation screen)", () => {
  it("says the deadline once, in the title, and shows the hold as icon facts", () => {
    const deadline = { kind: "accept", deadline_at: "2026-09-23T12:00:00Z", deadline_text: "", consequence_text: "", line: "" } as never;
    const v = jobView(detail({ status: "awaiting_acceptance", source: "booking", due_after_accept: "3 days after Maya accepts", deadline }));
    expect(v.chip[1]).toBe("Waiting for Maya");
    expect(v.title).toMatch(/^Maya has until .+ to accept$/);
    const facts = (v.facts ?? []).map((f) => f.text);
    expect(facts[0]).toMatch(/held on your card, not charged$/);
    expect(facts).toContain("Due 3 days after Maya accepts");
    expect(v.facts?.[0].sub).toMatch(/price \+ .+ Zavi fee\.$/);
  });
});

describe("stageOf", () => {
  it("places each live status on Booked > Accepted > Delivered > Paid", () => {
    expect(stageOf("awaiting_acceptance")).toBe(1);
    expect(stageOf("in_progress")).toBe(2);
    expect(stageOf("submitted")).toBe(3);
    expect(stageOf("completed", "approved", "transferred")).toBe(4);
    expect(stageOf("completed", "approved", "ready")).toBe(3);
    expect(stageOf("completed", "auto_accepted", "held")).toBe(3);
    expect(stageOf("completed", "approved", "awaiting_payout_account")).toBe(3);
    expect(stageOf("completed", "approved")).toBe(3);
  });

  it("shows no progress for a job that never started", () => {
    expect(stageOf("checkout_pending")).toBeNull();
    expect(stageOf("cancelled")).toBeNull();
    expect(stageOf("completed", "mediation_refund")).toBeNull();
  });
});

describe("groupJobActions: one primary, one secondary, the rest behind More options", () => {
  const a = (action: string) => ({ action });
  const names = (xs: { action: string }[]) => xs.map((x) => x.action);

  it("on a delivery: approve primary, request_change secondary, the rest grouped", () => {
    const g = groupJobActions([a("approve"), a("ask_zavi"), a("request_cancellation"), a("request_change")]);
    expect(names(g.primary)).toEqual(["approve"]);
    expect(names(g.secondary)).toEqual(["request_change"]);
    expect(names(g.others)).toEqual(["ask_zavi", "request_cancellation"]);
    expect(g.loose).toEqual([]);
  });

  it("a time request keeps both answers side by side", () => {
    const g = groupJobActions([a("approve_extension"), a("decline_extension")]);
    expect(names(g.primary)).toEqual(["approve_extension"]);
    expect(names(g.secondary)).toEqual(["decline_extension"]);
  });

  it("never hides the only way forward", () => {
    const g = groupJobActions([a("ask_zavi_in_buffer")]);
    expect(names(g.loose)).toEqual(["ask_zavi_in_buffer"]);
    expect(g.others).toEqual([]);
  });
});

describe("jobHistory: messages, change requests and versions in one timeline", () => {
  const sub = (id: string, version: number, created_at: string) => ({
    id, version, position: 0, kind: "video" as const, mime_type: "video/mp4", bytes: 1, note: null, created_at, play_url: "https://x.test/v",
  });

  it("orders everything by time and keeps each version", () => {
    const h = jobHistory(
      {
        submissions: [sub("s2", 2, "2026-09-30T10:00:00Z"), sub("s1", 1, "2026-09-29T08:07:00Z")],
        change_requests: [{ round: 1, note: "Show the streak screen", created_at: "2026-09-29T09:00:00Z" }],
      },
      [{ id: "m1", sender_kind: "creator", body: "On it", created_at: "2026-09-29T09:30:00Z" }],
    );
    expect(h.map((e) => e.kind)).toEqual(["delivery", "change", "msg", "delivery"]);
    expect(h[1]).toMatchObject({ round: 1, note: "Show the streak screen" });
    expect(h[3]).toMatchObject({ version: 2 });
  });

  it("shows a change note once even when it was also posted to the thread", () => {
    const h = jobHistory(
      { submissions: [], change_requests: [{ round: 1, note: "Show the streak screen", created_at: "2026-09-29T09:00:00Z" }] },
      [{ id: "m1", sender_kind: "tenant", body: "Show the streak screen", created_at: "2026-09-29T09:00:01Z" }],
    );
    expect(h.map((e) => e.kind)).toEqual(["change"]);
  });
});

describe("deliveryVersions", () => {
  it("one row per delivered version, counting its files and using the earliest file time", () => {
    const sub = (version: number, created_at: string) => ({ version, created_at }) as Parameters<typeof deliveryVersions>[0][number];
    expect(
      deliveryVersions([sub(2, "2026-10-02T10:05:00Z"), sub(1, "2026-10-01T09:00:00Z"), sub(2, "2026-10-02T10:00:00Z"), sub(1, "2026-10-01T09:30:00Z"), sub(1, "2026-10-01T08:59:00Z")]),
    ).toEqual([
      { version: 1, at: "2026-10-01T08:59:00Z", files: 3 },
      { version: 2, at: "2026-10-02T10:00:00Z", files: 2 },
    ]);
  });

  it("nothing delivered means no receipt rows", () => {
    expect(deliveryVersions([])).toEqual([]);
    expect(deliveryVersions(undefined as unknown as Parameters<typeof deliveryVersions>[0])).toEqual([]);
  });
});

describe("a dispute opened in the 10 days after an auto-accept", () => {
  const closedJob = { status: "completed", closed_reason: "auto_accepted", closed_at: "2026-10-20T00:00:00Z" } as Partial<CreatorJobDetail["job"]>;
  const dispute = (over: Partial<NonNullable<CreatorJobDetail["dispute"]>> = {}) => ({
    status: "open" as const,
    opened_by: "tenant" as const,
    reason: "Never delivered what we agreed.",
    outcome: null,
    resolution_note: null,
    created_at: "2026-10-21T00:00:00Z",
    ...over,
  });

  it("while open, shows Zavi stepping in instead of offering to ask Zavi again", () => {
    const v = jobView(detail(closedJob, { dispute: dispute(), actions: [] }));
    expect(v.chip[1]).toBe("Zavi is stepping in");
    expect(v.title).toBe("Zavi staff are looking at this job");
    expect([v.title, ...v.body].join(" ")).not.toMatch(/Until then you can ask Zavi to step in/);
  });

  it("once Zavi refunds, says so with Zavi's note first", () => {
    const v = jobView(
      detail(closedJob, { dispute: dispute({ status: "resolved", outcome: "refund", resolution_note: "The videos were never sent." }) }),
    );
    expect(v.chip[1]).toBe("Zavi decided");
    expect(v.title).toBe("Zavi decided: your card is refunded in full.");
    expect(v.body[0]).toBe("The videos were never sent.");
  });

  it("names a part payment and a full payment plainly", () => {
    expect(jobView(detail(closedJob, { dispute: dispute({ status: "resolved", outcome: "pay_part" }) })).title).toBe(
      "Zavi decided: Maya is paid part, and the rest goes back to your card.",
    );
    expect(jobView(detail(closedJob, { dispute: dispute({ status: "resolved", outcome: "pay_full" }) })).title).toBe(
      "Zavi decided: Maya is paid in full.",
    );
  });

  it("a job with no dispute reads exactly as before", () => {
    expect(jobView(detail(closedJob)).chip[1]).toBe("Accepted automatically");
  });
});

describe("the progress steps while Zavi is looking at a job", () => {
  it("keep Draft sent ticked when the work was already delivered", () => {
    expect(stageOf("in_dispute", null, null, true)).toBe(3);
    expect(stageOf("submitted")).toBe(3);
  });

  it("stay on In progress when nothing was delivered yet", () => {
    expect(stageOf("in_dispute", null, null, false)).toBe(2);
    expect(stageOf("in_dispute")).toBe(2);
  });
});

describe("an approved job only says paid once the payout left", () => {
  const approvedJob = (payout_status: string) =>
    detail({
      status: "completed",
      closed_reason: "approved",
      closed_at: "2026-10-20T00:00:00Z",
      money: { currency: "usd", price_cents: 15000, business_fee_cents: 1500, business_total_cents: 16500, business_fee_label: "10%", creator_payout_cents: 12750, payout_status },
    } as Partial<CreatorJobDetail["job"]>);

  it.each([
    ["awaiting_payout_account", "Zavi pays Maya once their Stripe setup is finished."],
    ["ready", "Zavi has not sent Maya's payout yet."],
    ["transferring", "Maya's payout is on its way."],
  ])("with the payout %s it says so and does not claim paid", (status, line) => {
    const v = jobView(approvedJob(status));
    expect(v.chip[1]).toBe("Approved");
    expect(v.title).toContain(line);
    expect(v.title).not.toContain("payout is released");
  });

  it("once transferred it reads approved and paid", () => {
    const v = jobView(approvedJob("transferred"));
    expect(v.chip[1]).toBe("Approved and paid");
    expect(v.title).toContain("Maya's payout is released.");
  });
});
