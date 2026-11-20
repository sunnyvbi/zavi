
import { describe, expect, it } from "vitest";
import { getBusinessJob, listBusinessJobs, type JobsViewDeps } from "../jobs-views";
import { deadlineCopy } from "../deadline-copy";
import { orderDeadlineForRow } from "../deadlines";
import { computeCreatorFees } from "../order-fees";
import type { BookablePackage, CreatorJobRow, CreatorSubmissionRow } from "../booking-db";
import type { CreatorOrderStatus } from "../order-state";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT = "99999999-9999-9999-9999-999999999999";
const ORDER = "22222222-2222-2222-2222-222222222222";
const CREATOR = "33333333-3333-3333-3333-333333333333";

const T0 = "2026-09-11T00:00:00.000Z";
const NOW = new Date("2026-09-12T00:00:00.000Z");

function job(over: Partial<CreatorJobRow> = {}): CreatorJobRow {
  const fees = computeCreatorFees(15_000);
  return {
    id: ORDER,
    tenant_id: TENANT,
    human_member_id: CREATOR,
    source: "booking",
    status: "awaiting_acceptance",
    closed_reason: null,
    created_at: T0,
    due_at: "2026-09-20T00:00:00.000Z",
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
    price_cents: fees.price_cents,
    business_fee_cents: fees.business_fee_cents,
    creator_fee_cents: fees.creator_fee_cents,
    business_total_cents: fees.business_total_cents,
    creator_payout_cents: fees.creator_payout_cents,
    package_snapshot: {
      title: "3 ad videos",
      creator_country_code: "US",
      creator_display_name: "Maya",
      creator_slug: "maya",
    },
    livemode: false,
    brief_id: null,
    application_id: null,
    package_id: null,
    offer_id: null,
    thread_id: null,
    currency: "usd",
    hold_expires_at: null,
    brief_snapshot: null,
    ...over,
  };
}

function submission(over: Partial<CreatorSubmissionRow> = {}): CreatorSubmissionRow {
  return {
    id: "sub-1",
    order_id: ORDER,
    version: 1,
    position: 0,
    kind: "video",
    storage_path: `${TENANT}/${ORDER}/v1.mp4`,
    mime_type: "video/mp4",
    bytes: 1024,
    note: null,
    created_at: "2026-09-11T12:00:00.000Z",
    ...over,
  };
}

const PACKAGE = "44444444-4444-4444-4444-444444444444";

function pkg(over: Partial<BookablePackage> = {}): BookablePackage {
  return {
    id: PACKAGE,
    human_member_id: CREATOR,
    kind: "ugc_video",
    title: "3 ad videos",
    description: null,
    price_cents: 18_000,
    currency: "usd",
    delivery_days: 7,
    video_count: 3,
    video_length_seconds: 30,
    ad_rights_days: 30,
    addons: null,
    active: true,
    ...over,
  };
}

function completedPackageJob(over: Partial<CreatorJobRow> = {}): CreatorJobRow {
  return job({
    status: "completed",
    closed_reason: "approved",
    closed_at: T0,
    source: "booking",
    package_id: PACKAGE,
    ...over,
  });
}

function desc(rows: CreatorSubmissionRow[]): CreatorSubmissionRow[] {
  return [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

function harness(
  over: {
    rows?: CreatorJobRow[];
    submissions?: CreatorSubmissionRow[];
    packages?: BookablePackage[];
    packageReadFails?: boolean;
    rounds?: number;
  } = {},
) {
  const rows = over.rows ?? [job()];
  const subs = over.submissions ?? [];
  const packages = over.packages ?? [];
  const packageReads: string[] = [];
  const tenantsSeen: string[] = [];
  const signed: string[] = [];
  const downloads: string[] = [];
  const deps: JobsViewDeps = {
    listJobs: async (tid) => {
      tenantsSeen.push(tid);
      return rows.filter((r) => r.tenant_id === tid);
    },
    loadJob: async (tid, id) => {
      tenantsSeen.push(tid);
      return rows.find((r) => r.tenant_id === tid && r.id === id) ?? null;
    },
    latestSubmissionAtByOrder: async (tid, ids) => {
      tenantsSeen.push(tid);
      const m = new Map<string, string>();
      for (const s of desc(subs)) {
        if (ids.includes(s.order_id) && !m.has(s.order_id)) m.set(s.order_id, s.created_at);
      }
      return m;
    },
    listSubmissions: async (tid) => {
      tenantsSeen.push(tid);
      return desc(subs);
    },
    submissionRounds: async (tid) => {
      tenantsSeen.push(tid);
      return over.rounds ?? new Set(subs.map((x) => x.version)).size;
    },
    loadDispute: async (tid) => {
      tenantsSeen.push(tid);
      return null;
    },
    loadCreator: async () => null,
    loadPackage: async (id) => {
      packageReads.push(id);
      if (over.packageReadFails) throw new Error("package read blew up");
      return packages.find((p) => p.id === id) ?? null;
    },
    thread: {
      readThread: async () => ({ available: false, thread_id: null, messages: [] }),
      postMessage: async () => ({ posted: false }),
    },
    signUrl: async (tid, p, download) => {
      signed.push(p);
      if (download) downloads.push(download);
      return p.startsWith(`${tid}/`) ? `https://signed.test/${p}` : null;
    },
    now: () => NOW,
  };
  return { deps, tenantsSeen, signed, downloads, packageReads };
}

function creatorSideLine(row: CreatorJobRow, last_submission_at: string | null): string | null {
  const d = orderDeadlineForRow(
    {
      status: row.status,
      source: row.source,
      created_at: row.created_at,
      due_at: row.due_at,
      cancel_requested_at: row.cancel_requested_at,
      last_submission_at,
    },
    NOW,
  );
  return d ? deadlineCopy(d.kind, d.deadline_at, { side: "business", other_name: "Maya" }).line : null;
}

describe("invariant 5: the same deadline on both sides, in the business's own words", () => {
  const WINDOWED: { status: CreatorOrderStatus; over?: Partial<CreatorJobRow> }[] = [
    { status: "awaiting_acceptance" },
    { status: "in_progress" },
    { status: "in_progress", over: { due_at: "2026-09-01T00:00:00.000Z" } },
    { status: "submitted" },
    { status: "cancel_requested", over: { cancel_requested_at: "2026-09-11T06:00:00.000Z" } },
    { status: "checkout_pending", over: { source: "offer" } },
  ];

  it("renders the shared instant and consequence, addressed to the business, in every windowed state", async () => {
    for (const c of WINDOWED) {
      const row = job({ status: c.status, ...(c.over ?? {}) });
      const subs = c.status === "submitted" ? [submission()] : [];
      const h = harness({ rows: [row], submissions: subs });

      const detail = await getBusinessJob(TENANT, ORDER, h.deps);
      const expected = creatorSideLine(row, subs[0]?.created_at ?? null);

      expect(detail?.job.deadline?.line, c.status).toBe(expected);
      expect(expected, `${c.status} should have a window`).not.toBeNull();
    }
  });

  it("shows NO deadline where the spec sets no window", async () => {
    for (const status of ["revision_requested", "in_dispute", "completed", "cancelled"] as const) {
      const row = job({
        status,
        ...(status === "completed" || status === "cancelled"
          ? { closed_reason: "approved" as const, closed_at: T0 }
          : {}),
      });
      const h = harness({ rows: [row] });
      const detail = await getBusinessJob(TENANT, ORDER, h.deps);
      expect(detail?.job.deadline, status).toBeNull();
    }
  });

  it("gives the LIST the same date as the DETAIL for a submitted job (Q5)", async () => {
    const row = job({ status: "submitted" });
    const subs = [
      submission({ id: "sub-2", version: 2, created_at: "2026-09-11T20:00:00.000Z" }),
      submission({ id: "sub-1", version: 1, created_at: "2026-09-11T08:00:00.000Z" }),
    ];
    const h = harness({ rows: [row], submissions: subs });

    const list = await listBusinessJobs(TENANT, h.deps);
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);

    expect(list.jobs[0].deadline?.line).toBe(detail?.job.deadline?.line);
    expect(list.jobs[0].deadline?.deadline_at).toBe(
      new Date(Date.parse("2026-09-11T20:00:00.000Z") + 72 * 3_600_000).toISOString(),
    );
  });

  it("a submitted job restored after a declined cancellation shows the stored, shifted review time on list and detail", async () => {
    const submittedAt = "2026-09-08T00:00:00.000Z";
    const shifted = new Date(Date.parse(submittedAt) + 112 * 3_600_000).toISOString();
    const row = job({ status: "submitted", next_deadline_at: shifted, next_deadline_kind: "review" });
    const h = harness({ rows: [row], submissions: [submission({ created_at: submittedAt })] });

    const list = await listBusinessJobs(TENANT, h.deps);
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    const expected = deadlineCopy("review", shifted, { side: "business", other_name: "Maya" });

    expect(list.jobs[0].deadline?.deadline_at).toBe(shifted);
    expect(detail?.job.deadline?.deadline_at).toBe(shifted);
    expect(list.jobs[0].deadline?.line).toBe(expected.line);
    expect(detail?.job.deadline?.line).toBe(expected.line);
    expect(detail?.job.deadline?.consequence_text).toBe(expected.consequence_text);
    expect(list.jobs[0].deadline?.deadline_at).not.toBe(
      new Date(Date.parse(submittedAt) + 72 * 3_600_000).toISOString(),
    );
  });

  it("a job with no stored deadline still gets the computed one", async () => {
    const submittedAt = "2026-09-11T08:00:00.000Z";
    const h = harness({ rows: [job({ status: "submitted" })], submissions: [submission({ created_at: submittedAt })] });
    const list = await listBusinessJobs(TENANT, h.deps);
    expect(list.jobs[0].deadline?.deadline_at).toBe(new Date(Date.parse(submittedAt) + 72 * 3_600_000).toISOString());
  });

  it("never writes its own sentence: the consequence comes from deadlineCopy", async () => {
    const h = harness({ rows: [job({ status: "awaiting_acceptance" })] });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.job.deadline?.consequence_text).toBe(
      deadlineCopy("accept", detail!.job.deadline!.deadline_at, { side: "business", other_name: "Maya" }).consequence_text,
    );
    expect(detail?.job.deadline?.consequence_text).toContain("If Maya doesn't accept by then");
    expect(detail?.job.deadline?.consequence_text).not.toMatch(/[–—]/);
  });
});

describe("invariant 8: the money on the screen is the frozen order", () => {
  it("shows price, fee and total that add up", async () => {
    const h = harness();
    const list = await listBusinessJobs(TENANT, h.deps);
    const m = list.jobs[0].money;
    expect(m.price_cents + m.business_fee_cents).toBe(m.business_total_cents);
    expect(m.business_fee_cents).toBe(computeCreatorFees(m.price_cents).business_fee_cents);
    expect(m.creator_payout_cents).toBe(computeCreatorFees(m.price_cents).creator_payout_cents);
    expect(m.business_fee_label).toBe("10%");
  });

  it("shows the mediated payout when staff set one (Q6 pay-part)", async () => {
    const h = harness({ rows: [job({ payout_amount_cents: 5_000 })] });
    const list = await listBusinessJobs(TENANT, h.deps);
    expect(list.jobs[0].money.creator_payout_cents).toBe(5_000);
  });

  it("says what a partial refund gave back, and unknown (never 0) when it cannot be read", async () => {
    const rows = [job({ id: "p", status: "completed", closed_reason: "mediation_pay_part" }), job({ id: "n", status: "completed", closed_reason: "approved" })];
    const h = harness({ rows });
    const reads: string[][] = [];
    h.deps.partialRefundsByOrder = async (tid, ids) => {
      expect(tid).toBe(TENANT);
      reads.push(ids);
      return new Map([["p", 3_000]]);
    };
    const list = await listBusinessJobs(TENANT, h.deps);
    expect(reads).toEqual([["p"]]);
    expect(list.jobs.find((j) => j.id === "p")?.refunded_cents).toBe(3_000);
    expect(list.jobs.find((j) => j.id === "n")).not.toHaveProperty("refunded_cents");

    h.deps.partialRefundsByOrder = async () => {
      throw new Error("read failed");
    };
    const failed = await listBusinessJobs(TENANT, h.deps);
    expect(failed.jobs.find((j) => j.id === "p")?.refunded_cents).toBeNull();
  });
});

describe("no job until it is paid", () => {
  it("an order still in checkout is on no business list and in no count", async () => {
    const h = harness({
      rows: [
        job({ id: "paid-1", status: "awaiting_acceptance" }),
        job({ id: "unpaid-booking", status: "checkout_pending", source: "booking" }),
        job({ id: "unpaid-offer", status: "checkout_pending", source: "offer" }),
        job({ id: "unpaid-hire", status: "checkout_pending", source: "applicant" }),
        job({ id: "abandoned", status: "cancelled", closed_reason: "checkout_abandoned" }),
        job({ id: "paid-then-cancelled", status: "cancelled", closed_reason: "mediation_refund" }),
      ],
    });
    const list = await listBusinessJobs(TENANT, h.deps);
    expect(list.jobs.map((j) => j.id)).toEqual(["paid-1", "paid-then-cancelled"]);
  });

  it("the single-job read still answers for an unpaid order (the Stripe-return poll)", async () => {
    const h = harness({ rows: [job({ status: "checkout_pending", source: "booking" })] });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.job.status).toBe("checkout_pending");
    expect(detail?.job.offer_expired).toBeUndefined();
  });

  it("marks an unpaid offer order whose offer expired, so the drawer offers no Pay", async () => {
    for (const [expired, want] of [
      [true, true],
      [false, false],
    ] as const) {
      const h = harness({ rows: [job({ status: "checkout_pending", source: "offer", offer_id: "of-1" })] });
      const asked: string[] = [];
      h.deps.offerExpired = async (_tid, id) => {
        asked.push(id);
        return expired;
      };
      const detail = await getBusinessJob(TENANT, ORDER, h.deps);
      expect(detail?.job.offer_expired).toBe(want);
      expect(asked).toEqual(["of-1"]);
    }
  });

  it("marks an unpaid order the agent proposed as waiting for the hire card, and only that one", async () => {
    for (const source of ["booking", "offer"] as const) {
      const h = harness({ rows: [job({ status: "checkout_pending", source, offer_id: "of-1", agent_run_id: "run-1" })] });
      h.deps.offerExpired = async () => false;
      expect((await getBusinessJob(TENANT, ORDER, h.deps))?.job.awaiting_hire_approval).toBe(true);
    }
    const founder = harness({ rows: [job({ status: "checkout_pending", source: "offer", offer_id: "of-1", agent_run_id: null })] });
    founder.deps.offerExpired = async () => false;
    expect((await getBusinessJob(TENANT, ORDER, founder.deps))?.job.awaiting_hire_approval).toBeUndefined();
    const paid = harness({ rows: [job({ status: "in_progress", agent_run_id: "run-1" })] });
    expect((await getBusinessJob(TENANT, ORDER, paid.deps))?.job.awaiting_hire_approval).toBeUndefined();
  });

  it("an offer whose expiry cannot be read reads as expired: no Pay", async () => {
    const h = harness({ rows: [job({ status: "checkout_pending", source: "offer", offer_id: "of-1" })] });
    h.deps.offerExpired = async () => {
      throw new Error("offer read failed");
    };
    expect((await getBusinessJob(TENANT, ORDER, h.deps))?.job.offer_expired).toBe(true);
  });
});

describe("cross-tenant", () => {
  it("reads another workspace's order as not found", async () => {
    const h = harness();
    expect(await getBusinessJob(OTHER_TENANT, ORDER, h.deps)).toBeNull();
  });

  it("lists nothing for a workspace with no orders", async () => {
    const h = harness();
    expect((await listBusinessJobs(OTHER_TENANT, h.deps)).jobs).toEqual([]);
  });

  it("issues every read with the caller's tenant and no other", async () => {
    const h = harness({ rows: [job({ status: "submitted" })], submissions: [submission()] });
    await listBusinessJobs(TENANT, h.deps);
    await getBusinessJob(TENANT, ORDER, h.deps);
    expect(new Set(h.tenantsSeen)).toEqual(new Set([TENANT]));
  });

  it("refuses to sign a storage path outside the caller's own folder", async () => {
    const stray = submission({ storage_path: `${OTHER_TENANT}/${ORDER}/v1.mp4` });
    const h = harness({ rows: [job({ status: "completed", closed_reason: "approved", closed_at: T0 })], submissions: [stray] });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.submissions[0].play_url).toBeNull();
  });

  it("signs a path inside the caller's own folder", async () => {
    const h = harness({ rows: [job({ status: "completed", closed_reason: "approved", closed_at: T0 })], submissions: [submission()] });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.submissions[0].play_url).toBe(
      `https://signed.test/${TENANT}/${ORDER}/v1.mp4`,
    );
  });
});

describe("the detail screen", () => {
  it("offers only the actions S3 allows from this status", async () => {
    const h = harness({ rows: [job({ status: "submitted" })], submissions: [submission()] });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    const actions = (detail?.actions ?? []).map((a) => a.action).sort();
    expect(actions).toEqual(
      ["approve", "ask_zavi", "request_cancellation", "request_change"].sort(),
    );
    for (const a of detail!.actions) {
      expect(a.consequence.length).toBeGreaterThan(20);
    }
  });

  it("surfaces an extension request so the business can answer it (Q23)", async () => {
    const h = harness({
      rows: [
        job({
          status: "in_progress",
          extension_state: "requested",
          extension_requested_due_at: "2026-09-25T00:00:00.000Z",
        }),
      ],
    });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.extension).toEqual({
      state: "requested",
      requested_due_at: "2026-09-25T00:00:00.000Z",
    });
    expect((detail?.actions ?? []).map((a) => a.action)).toEqual(
      expect.arrayContaining(["approve_extension", "decline_extension"]),
    );
  });

  it("says the thread is not wired up rather than showing an empty conversation", async () => {
    const h = harness();
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.thread).toEqual({ available: false, thread_id: null, messages: [] });
  });

  it("a thread read that throws does not break the job (an action may already have committed)", async () => {
    const h = harness();
    h.deps.thread = {
      readThread: async () => {
        throw new Error("thread lookup down");
      },
      postMessage: async () => ({ posted: false }),
    };
    const detail = await getBusinessJob(TENANT, ORDER, h.deps, "user-1");
    expect(detail).not.toBeNull();
    expect(detail?.thread).toEqual({ available: false, thread_id: null, messages: [] });
  });
});

describe("rebooking the same package", () => {
  it("offers the live package on a completed package-door job", async () => {
    const h = harness({ rows: [completedPackageJob()], packages: [pkg()] });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.rebook).toEqual({
      package_id: PACKAGE,
      title: "3 ad videos",
      price_cents: 18_000,
      currency: "usd",
    });
  });

  it("quotes TODAY'S price, not the price the finished job was charged", async () => {
    const row = completedPackageJob();
    const h = harness({ rows: [row], packages: [pkg({ price_cents: 25_000 })] });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.rebook?.price_cents).toBe(25_000);
    expect(detail?.rebook?.price_cents).not.toBe(row.price_cents);
    expect(detail?.job.money.price_cents).toBe(row.price_cents);
  });

  it("does NOT offer a rebook on an offer-door job", async () => {
    const h = harness({
      rows: [completedPackageJob({ source: "offer", package_id: null })],
      packages: [pkg()],
    });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.rebook).toBeNull();
    expect(h.packageReads).toEqual([]);
  });

  it("does NOT offer a rebook on an applicant-door job", async () => {
    const h = harness({
      rows: [completedPackageJob({ source: "applicant", package_id: null })],
      packages: [pkg()],
    });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.rebook).toBeNull();
    expect(h.packageReads).toEqual([]);
  });

  it("does NOT offer a rebook before the job is completed", async () => {
    const running: CreatorOrderStatus[] = [
      "checkout_pending",
      "awaiting_acceptance",
      "in_progress",
      "submitted",
      "revision_requested",
      "cancel_requested",
      "in_dispute",
      "cancelled",
    ];
    for (const status of running) {
      const h = harness({
        rows: [completedPackageJob({ status, closed_reason: null, closed_at: null })],
        packages: [pkg()],
      });
      const detail = await getBusinessJob(TENANT, ORDER, h.deps);
      expect(detail?.rebook, status).toBeNull();
      expect(h.packageReads, status).toEqual([]);
    }
  });

  it("does NOT offer a package the creator deleted or switched off", async () => {
    for (const packages of [[], [pkg({ active: false })]]) {
      const h = harness({ rows: [completedPackageJob()], packages });
      const detail = await getBusinessJob(TENANT, ORDER, h.deps);
      expect(detail?.rebook).toBeNull();
    }
  });

  it("still returns the job when the package read fails", async () => {
    const h = harness({
      rows: [completedPackageJob()],
      packages: [pkg()],
      packageReadFails: true,
    });
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.job.id).toBe(ORDER);
    expect(detail?.rebook).toBeNull();
  });
});

describe("S4: revisions used and left", () => {
  const round = (version: number, position = 0) =>
    submission({
      id: `sub-${version}-${position}`,
      version,
      position,
      storage_path: `${TENANT}/${ORDER}/v${version}-${position}.mp4`,
      created_at: new Date(Date.parse(T0) + version * 3_600_000 + position).toISOString(),
    });

  it("counts ROUNDS, not files: two files in the first round is still 0 of 2 used", async () => {
    const h = harness({ rows: [job({ status: "submitted" })], submissions: [round(1, 0), round(1, 1)] });
    const d = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(d?.revisions).toEqual({ used: 0, left: 2, max: 2 });
    expect(d?.actions.map((a) => a.action)).toContain("request_change");
  });

  it("a gap left by a refused submit is not a round: versions 1 and 3 is 1 of 2 used, like the gate", async () => {
    const h = harness({ rows: [job({ status: "submitted" })], submissions: [round(1), round(3)] });
    const d = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(d?.revisions).toEqual({ used: 1, left: 1, max: 2 });
    expect(d?.actions.map((a) => a.action)).toContain("request_change");
  });

  it("uses the gate's count, not the capped file list: a job whose old rounds fell off the list still has no Request a change", async () => {
    const h = harness({ rows: [job({ status: "submitted" })], submissions: [round(3)], rounds: 3 });
    const d = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(d?.revisions).toEqual({ used: 2, left: 0, max: 2 });
    expect(d?.actions.map((a) => a.action)).not.toContain("request_change");
  });

  it("after two rounds of changes the Request a change button is gone; approve and ask Zavi stay", async () => {
    const h = harness({
      rows: [job({ status: "submitted" })],
      submissions: [round(1), round(2), round(3)],
    });
    const d = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(d?.revisions).toEqual({ used: 2, left: 0, max: 2 });
    const actions = d?.actions.map((a) => a.action) ?? [];
    expect(actions).not.toContain("request_change");
    expect(actions).toContain("approve");
    expect(actions).toContain("ask_zavi");
  });

  it("shows the product flag and no due date while the product is on its way", async () => {
    const h = harness({
      rows: [job({ status: "in_progress", due_at: null, product_needed: true, product_received_at: null })],
    });
    const d = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(d?.job.product_needed).toBe(true);
    expect(d?.job.product_received_at).toBeNull();
    expect(d?.job.due_at).toBeNull();
    expect(d?.job.deadline).toBeNull();
  });
});

describe("the list says how many rounds of changes a job under review used (S5)", () => {
  it("counts from the highest delivered version, the same rule as the detail", async () => {
    const h = harness({ rows: [job({ status: "submitted" })] });
    h.deps.submissionRoundsByOrder = async (_tid, ids) => new Map(ids.map((id) => [id, 2]));
    const list = await listBusinessJobs(TENANT, h.deps);
    expect(list.jobs[0].revisions_used).toBe(1);
  });

  it("leaves the count off when the read fails, rather than showing 0", async () => {
    const h = harness({ rows: [job({ status: "submitted" })] });
    h.deps.submissionRoundsByOrder = async () => Promise.reject(new Error("down"));
    const list = await listBusinessJobs(TENANT, h.deps);
    expect(list.jobs[0].revisions_used).toBeUndefined();
  });
});

describe("the creator's original stays locked until the job is paid", () => {
  const ORIGINAL = `${TENANT}/${ORDER}/v1.mp4`;
  const PREVIEW = `${TENANT}/${ORDER}/preview/sub-1.mp4`;
  const paidJob = (closed_reason: CreatorJobRow["closed_reason"]) => job({ status: "completed", closed_reason, closed_at: T0 });

  function withRequests(h: ReturnType<typeof harness>) {
    const requested: Array<{ tenant_id: string; order_id: string; version: number }> = [];
    h.deps.requestPreviews = async (a) => {
      requested.push(a);
    };
    return requested;
  }

  it.each(["submitted", "revision_requested", "in_dispute", "cancel_requested"] as const)(
    "never signs the original while the job is %s, even with the preview not ready",
    async (status) => {
      const h = harness({ rows: [job({ status })], submissions: [submission()] });
      const requested = withRequests(h);
      const s = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions[0];
      expect(h.signed).not.toContain(ORIGINAL);
      expect(h.signed.some((p) => p.includes("v1.mp4"))).toBe(false);
      expect(s.play_url).toBeNull();
      expect(s.download_url).toBeNull();
      expect(s.preview).toBe("preparing");
      expect(requested).toEqual([{ tenant_id: TENANT, order_id: ORDER, version: 1 }]);
    },
  );

  it("plays the watermarked preview before payment and never the original", async () => {
    const h = harness({
      rows: [job({ status: "submitted" })],
      submissions: [submission({ preview_state: "ready", preview_path: PREVIEW, preview_updated_at: T0 })],
    });
    const requested = withRequests(h);
    const s = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions[0];
    expect(s.play_url).toBe(`https://signed.test/${PREVIEW}`);
    expect(s.watermarked).toBe(true);
    expect(s.download_url).toBeNull();
    expect(h.signed).toEqual([PREVIEW]);
    expect(requested).toEqual([]);
  });

  it.each(["approved", "auto_accepted", "mediation_pay_full", "mediation_pay_part"] as const)(
    "unlocks the original and a download once the job closes %s",
    async (closed_reason) => {
      const h = harness({
        rows: [paidJob(closed_reason)],
        submissions: [submission({ preview_state: "ready", preview_path: PREVIEW, preview_updated_at: T0 })],
      });
      const requested = withRequests(h);
      const s = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions[0];
      expect(s.play_url).toBe(`https://signed.test/${ORIGINAL}`);
      expect(s.watermarked).toBe(false);
      expect(s.preview).toBeNull();
      expect(s.download_url).toBe(`https://signed.test/${ORIGINAL}`);
      expect(h.downloads).toEqual([`zavi-job-${ORDER.slice(0, 8)}-v1-1.mp4`]);
      expect(h.signed).not.toContain(PREVIEW);
      expect(requested).toEqual([]);
    },
  );

  it.each([
    ["cancelled", "cancel_agreed"],
    ["cancelled", "no_show"],
    ["completed", "mediation_refund"],
  ] as const)("keeps the original locked on a %s job closed %s, where the business got its money back", async (status, closed_reason) => {
    const h = harness({
      rows: [job({ status, closed_reason: closed_reason as CreatorJobRow["closed_reason"], closed_at: T0 })],
      submissions: [submission({ preview_state: "ready", preview_path: PREVIEW, preview_updated_at: T0 })],
    });
    withRequests(h);
    const s = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions[0];
    expect(h.signed).toEqual([PREVIEW]);
    expect(s.watermarked).toBe(true);
    expect(s.download_url).toBeNull();
  });

  const disputeRow = (status: "open" | "resolved", outcome: string | null) =>
    ({
      status,
      opened_by: "tenant",
      reason: "This is not what I asked for.",
      outcome,
      resolution_note: null,
      created_at: T0,
    }) as unknown as Awaited<ReturnType<JobsViewDeps["loadDispute"]>>;

  it.each(["auto_accepted", "approved"] as const)(
    "withholds the original and the download on a %s job while a dispute is open, and plays only the preview",
    async (closed_reason) => {
      const h = harness({
        rows: [job({ status: "completed", closed_reason, closed_at: T0, payout_status: "ready" })],
        submissions: [submission({ preview_state: "ready", preview_path: PREVIEW, preview_updated_at: T0 })],
      });
      h.deps.loadDispute = async () => disputeRow("open", null);
      const requested = withRequests(h);
      const s = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions[0];
      expect(h.signed).toEqual([PREVIEW]);
      expect(h.downloads).toEqual([]);
      expect(s.play_url).toBe(`https://signed.test/${PREVIEW}`);
      expect(s.watermarked).toBe(true);
      expect(s.preview).toBe("ready");
      expect(s.download_url).toBeNull();
      expect(requested).toEqual([]);
    },
  );

  it("queues a preview instead of signing the original when a disputed job never had one built", async () => {
    const h = harness({
      rows: [job({ status: "completed", closed_reason: "auto_accepted", closed_at: T0, payout_status: "ready" })],
      submissions: [submission()],
    });
    h.deps.loadDispute = async () => disputeRow("open", null);
    const requested = withRequests(h);
    const s = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions[0];
    expect(h.signed).toEqual([]);
    expect(s.play_url).toBeNull();
    expect(s.download_url).toBeNull();
    expect(s.preview).toBe("preparing");
    expect(requested).toEqual([{ tenant_id: TENANT, order_id: ORDER, version: 1 }]);
  });

  it("gives the original and the download back once Zavi resolves the dispute pay in full", async () => {
    const h = harness({
      rows: [job({ status: "completed", closed_reason: "mediation_pay_full", closed_at: T0, payout_status: "ready" })],
      submissions: [submission({ preview_state: "ready", preview_path: PREVIEW, preview_updated_at: T0 })],
    });
    h.deps.loadDispute = async () => disputeRow("resolved", "pay_full");
    const s = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions[0];
    expect(s.play_url).toBe(`https://signed.test/${ORIGINAL}`);
    expect(s.watermarked).toBe(false);
    expect(s.download_url).toBe(`https://signed.test/${ORIGINAL}`);
    expect(h.downloads).toEqual([`zavi-job-${ORDER.slice(0, 8)}-v1-1.mp4`]);
    expect(h.signed).not.toContain(PREVIEW);
  });

  it("re-queues a failed or stuck preview from a read, and leaves a fresh one alone", async () => {
    const fresh = new Date(NOW.getTime() - 60_000).toISOString();
    const stuck = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    const h = harness({
      rows: [job({ status: "submitted" })],
      submissions: [
        submission({ id: "a", version: 3, preview_state: "pending", preview_updated_at: fresh }),
        submission({ id: "b", version: 2, preview_state: "pending", preview_updated_at: stuck }),
        submission({ id: "c", version: 1, preview_state: "failed", preview_updated_at: fresh }),
      ],
    });
    const requested = withRequests(h);
    const subs = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions;
    expect(requested.map((r) => r.version).sort()).toEqual([1, 2]);
    expect(subs.map((s) => s.preview)).toEqual(["preparing", "preparing", "failed"]);
    expect(h.signed).toEqual([]);
  });

  it("a file that failed three times says there is no preview, never the original, and is not queued again", async () => {
    const h = harness({
      rows: [job({ status: "submitted" })],
      submissions: [submission({ preview_state: "failed", preview_attempts: 3, preview_updated_at: T0 })],
    });
    const requested = withRequests(h);
    const s = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions[0];
    expect(s.preview).toBe("unavailable");
    expect(s.preview_unavailable_reason).toBe("not_built");
    expect(s.play_url).toBeNull();
    expect(h.signed).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("an unpaid file Zavi cannot preview says so and is never signed", async () => {
    const h = harness({ rows: [job({ status: "submitted" })], submissions: [submission({ mime_type: null, storage_path: `${TENANT}/${ORDER}/v1.bin` })] });
    const requested = withRequests(h);
    const s = (await getBusinessJob(TENANT, ORDER, h.deps))!.submissions[0];
    expect(s.preview).toBe("unavailable");
    expect(s.preview_unavailable_reason).toBe("file_type");
    expect(h.signed).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("still opens the job when queueing the preview fails", async () => {
    const h = harness({ rows: [job({ status: "submitted" })], submissions: [submission()] });
    h.deps.requestPreviews = async () => {
      throw new Error("inngest down");
    };
    const detail = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(detail?.submissions[0].preview).toBe("preparing");
    expect(h.signed).toEqual([]);
  });
});

describe("Ask Zavi to step in after an auto-accept", () => {
  const buffered = () => job({ status: "completed", closed_reason: "auto_accepted", closed_at: T0, payout_status: "ready" });
  const openDispute = {
    status: "open",
    opened_by: "tenant",
    reason: "Never delivered.",
    outcome: null,
    resolution_note: null,
    created_at: T0,
  };

  it("is offered inside the 10 days when no dispute is open", async () => {
    const h = harness({ rows: [buffered()] });
    const d = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(d!.actions.map((a) => a.action)).toContain("ask_zavi_in_buffer");
  });

  it("is not offered again while Zavi is already looking at the job", async () => {
    const h = harness({ rows: [buffered()] });
    h.deps.loadDispute = (async () => openDispute) as unknown as JobsViewDeps["loadDispute"];
    const d = await getBusinessJob(TENANT, ORDER, h.deps);
    expect(d!.dispute?.status).toBe("open");
    expect(d!.actions.map((a) => a.action)).not.toContain("ask_zavi_in_buffer");
  });
});
