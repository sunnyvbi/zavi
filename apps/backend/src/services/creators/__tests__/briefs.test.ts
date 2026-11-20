
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANSWER_BY_DAYS,
  DEFAULT_APPLICANT_CAP,
  DEFAULT_DECLINE_NOTE,
  briefWorkbench,
  listApplicantsForBusiness,
  publishBrief,
  quoteFeeSplit,
  repostBrief,
  quotedRateToCents,
  resolveAnswerBy,
  saveBrief,
  validateBriefInput,
  type BriefWorkbenchDeps,
  type PublishBriefDeps,
  type SaveBriefDeps,
} from "../briefs";
import { computeCreatorFees } from "../order-fees";
import type { BriefApplicationRow, BriefWritableFields, TenantBriefRow } from "../briefs-db";

const TENANT = "11111111-1111-1111-1111-111111111111";
const BRIEF = "b1111111-1111-1111-1111-111111111111";
const CREATOR_A = "c1111111-1111-1111-1111-111111111111";
const CREATOR_B = "c2222222-2222-2222-2222-222222222222";

const T0 = "2026-09-11T00:00:00.000Z";
const D = 24 * 3_600_000;
const plus = (ms: number) => new Date(new Date(T0).getTime() + ms).toISOString();

function brief(over: Partial<TenantBriefRow> = {}): TenantBriefRow {
  return {
    id: BRIEF,
    tenant_id: TENANT,
    status: "draft",
    title: "3 ad videos for the spring push",
    angle: "Show the handover, not the app",
    hook: "I almost did not book this car",
    format: "9:16 UGC, 30 seconds",
    deliverables: 3,
    rationale: "CTR on ad set 9912 fell 41% over 14 days",
    evidence: [{ ad_set: "9912", ctr_drop: 0.41 }],
    source_campaign_ref: "spring-retarget-2026",
    source_run_id: null,
    budget_usd: 450,
    utm_campaign: "zavi-brief-4f2a91bc77de",
    lane: "ugc_video",
    filters: { niches: ["travel"], platforms: ["tiktok"] },
    delivery_days: 7,
    ad_rights_days: 90,
    posted_at: null,
    answer_by: null,
    applicant_cap: null,
    decline_note: null,
    closed_at: null,
    created_at: T0,
    updated_at: null,
    ...over,
  };
}

function store(initial: TenantBriefRow) {
  let row = { ...initial };
  const deps: SaveBriefDeps & PublishBriefDeps & BriefWorkbenchDeps & { applications: BriefApplicationRow[] } = {
    applications: [],
    load: async (_t, id) => (id === row.id ? { ...row } : null),
    insert: async (_t, fields: BriefWritableFields) => {
      row = { ...row, ...(fields as Partial<TenantBriefRow>) };
      return { ...row };
    },
    update: async (_t, id, patch: BriefWritableFields) => {
      if (id !== row.id) return null;
      if (row.status !== "draft" || row.posted_at) return null;
      row = { ...row, ...(patch as Partial<TenantBriefRow>) };
      return { ...row };
    },
    publish: async ({ brief_id, posted_at, answer_by, applicant_cap }) => {
      if (brief_id !== row.id) return null;
      if (row.posted_at) return null;
      row = { ...row, posted_at, answer_by, applicant_cap, status: "sent" };
      return { ...row };
    },
    count: async () => deps.applications.length,
    businessName: async () => "Northwind Coffee",
  };
  return { deps, current: () => ({ ...row }) };
}

describe("invariant 6 and spec item 30: the founder's edit reaches the creator", () => {
  it("THE PANEL'S BUG: an edit to a draft brief moves the creator view", async () => {
    const s = store(brief());

    const before = await briefWorkbench({ tenant_id: TENANT, brief_id: BRIEF }, s.deps);
    expect(before?.creator_preview.title).toBe("3 ad videos for the spring push");
    expect(before?.creator_preview.hook).toBe("I almost did not book this car");

    await saveBrief(
      {
        tenant_id: TENANT,
        brief_id: BRIEF,
        input: {
          title: "2 ad videos, new angle",
          hook: "I nearly walked away from this booking",
          angle: "Open on the keys changing hands",
          budget_usd: 600,
          deliverables: 2,
          delivery_days: 5,
        },
      },
      s.deps,
    );

    const after = await briefWorkbench({ tenant_id: TENANT, brief_id: BRIEF }, s.deps);
    expect(after?.creator_preview.title).toBe("2 ad videos, new angle");
    expect(after?.creator_preview.hook).toBe("I nearly walked away from this booking");
    expect(after?.creator_preview.angle).toBe("Open on the keys changing hands");
    expect(after?.creator_preview.budget_usd).toBe(600);
    expect(after?.creator_preview.deliverables).toBe(2);
    expect(after?.creator_preview.delivery_days).toBe(5);
    expect(JSON.stringify(after?.creator_preview)).not.toContain("3 ad videos for the spring push");

    const posted = await publishBrief({ tenant_id: TENANT, brief_id: BRIEF, now: new Date(T0) }, s.deps);
    expect(posted.ok && posted.brief.title).toBe("2 ad videos, new angle");
  });

  it("S4: a POSTED brief refuses every edit with brief_locked and stays exactly as posted", async () => {
    const s = store(brief());
    await publishBrief({ tenant_id: TENANT, brief_id: BRIEF, now: new Date(T0) }, s.deps);
    await expect(
      saveBrief({ tenant_id: TENANT, brief_id: BRIEF, input: { title: "Changed after posting" } }, s.deps),
    ).rejects.toMatchObject({ code: "brief_locked" });
    expect(s.current().title).toBe("3 ad videos for the spring push");
    const same = await saveBrief({ tenant_id: TENANT, brief_id: BRIEF, input: {} }, s.deps);
    expect(same.title).toBe("3 ad videos for the spring push");
  });

  it("S4: a save that loses the race to a publish is refused, not written onto the posted brief", async () => {
    const s = store(brief());
    const staleLoad = s.deps.load;
    const racing = {
      ...s.deps,
      load: async (t: string, id: string) => {
        const r = await staleLoad(t, id);
        await publishBrief({ tenant_id: TENANT, brief_id: BRIEF, now: new Date(T0) }, s.deps);
        return r;
      },
    };
    await expect(
      saveBrief({ tenant_id: TENANT, brief_id: BRIEF, input: { title: "Changed mid-publish" } }, racing),
    ).rejects.toMatchObject({ code: "brief_locked" });
    expect(s.current().posted_at).toBe(T0);
    expect(s.current().title).toBe("3 ad videos for the spring push");
  });

  it("S4: repost copies the posted brief into a NEW draft and closes the old one", async () => {
    const posted = brief({ status: "sent", posted_at: T0, product_needed: true });
    const inserted: BriefWritableFields[] = [];
    const closed: string[] = [];
    const res = await repostBrief(
      { tenant_id: TENANT, brief_id: BRIEF },
      {
        load: async (_t, id) => (id === BRIEF ? posted : null),
        insert: async (_t, fields) => {
          inserted.push(fields);
          return brief({ ...(fields as Partial<TenantBriefRow>), id: "b2222222-2222-2222-2222-222222222222", status: "draft", posted_at: null });
        },
        closeOld: async ({ brief_id }) => {
          closed.push(brief_id);
        },
      },
    );
    expect(res.brief.status).toBe("draft");
    expect(res.brief.id).not.toBe(BRIEF);
    expect(res.closed_brief_id).toBe(BRIEF);
    expect(closed).toEqual([BRIEF]);
    expect(inserted[0]).toMatchObject({
      title: posted.title,
      hook: posted.hook,
      budget_usd: 450,
      delivery_days: 7,
      product_needed: true,
    });
    expect(inserted[0]).not.toHaveProperty("posted_at");
  });

  it("repost of an old audience-post brief makes a draft with no removed lane", async () => {
    for (const [lane, want] of [["audience_post", null], ["ugc_video", "ugc_video"], [null, null]] as const) {
      const posted = brief({ status: "sent", posted_at: T0, lane } as Partial<TenantBriefRow>);
      const inserted: BriefWritableFields[] = [];
      await repostBrief(
        { tenant_id: TENANT, brief_id: BRIEF },
        {
          load: async (_t, id) => (id === BRIEF ? posted : null),
          insert: async (_t, fields) => {
            inserted.push(fields);
            return brief({ ...(fields as Partial<TenantBriefRow>), id: "b2222222-2222-2222-2222-222222222222", status: "draft", posted_at: null });
          },
          closeOld: async () => {},
        },
      );
      expect(inserted[0].lane).toBe(want);
    }
  });

  it("S4: repost refuses a draft (edit it instead) and a brief from another workspace", async () => {
    const deps = {
      load: async (_t: string, id: string) => (id === BRIEF ? brief() : null),
      insert: async () => brief(),
      closeOld: async () => undefined,
    };
    await expect(repostBrief({ tenant_id: TENANT, brief_id: BRIEF }, deps)).rejects.toMatchObject({
      code: "brief_not_posted",
    });
    await expect(
      repostBrief({ tenant_id: TENANT, brief_id: "b9999999-9999-9999-9999-999999999999" }, deps),
    ).rejects.toMatchObject({ code: "brief_not_found" });
  });

  it("S6: a brief cannot be posted without its ad rights, even a leftover audience post draft", async () => {
    for (const lane of [null, "ugc_video", "audience_post"]) {
      const noRights = store(brief({ ad_rights_days: null, lane }));
      const refused = await publishBrief({ tenant_id: TENANT, brief_id: BRIEF, now: new Date(T0) }, noRights.deps);
      expect(refused, String(lane)).toMatchObject({ ok: false, code: "brief_incomplete" });
      expect(refused.ok === false && refused.message).toMatch(/Ad rights/);
      expect(noRights.current().posted_at).toBeNull();
    }
  });

  it("S6: source_channel is one of the video channels and ad rights are 30, 90 or 365", () => {
    expect(validateBriefInput({ source_channel: "meta_ads", ad_rights_days: 90 }, { partial: true })).toEqual({
      source_channel: "meta_ads",
      ad_rights_days: 90,
    });
    expect(validateBriefInput({ source_channel: null, ad_rights_days: "" }, { partial: true })).toEqual({
      source_channel: null,
      ad_rights_days: null,
    });
    expect(() => validateBriefInput({ source_channel: "seo" }, { partial: true })).toThrow();
    expect(() => validateBriefInput({ ad_rights_days: 60 }, { partial: true })).toThrow();
  });

  it("S4: product_needed is a yes or no, nothing else", () => {
    expect(validateBriefInput({ product_needed: true }, { partial: true })).toEqual({ product_needed: true });
    expect(() => validateBriefInput({ product_needed: "yes" }, { partial: true })).toThrow();
  });

  it("never leaks the agent's rationale or the attribution tag into the preview", async () => {
    const s = store(brief());
    const bench = await briefWorkbench({ tenant_id: TENANT, brief_id: BRIEF }, s.deps);
    const payload = JSON.stringify(bench?.creator_preview);
    expect(payload).not.toContain("CTR on ad set");
    expect(payload).not.toContain("zavi-brief-");
    expect(payload).not.toContain("spring-retarget-2026");
    expect(bench?.brief.rationale).toContain("CTR on ad set");
    expect(bench?.brief.utm_campaign).toBe("zavi-brief-4f2a91bc77de");
  });

  it("returns the saved row, not the patch it was handed", async () => {
    const s = store(brief());
    await expect(
      saveBrief({ tenant_id: TENANT, brief_id: BRIEF, input: { title: "x".repeat(201) } }, s.deps),
    ).rejects.toThrow(/200 characters or fewer/);
    expect(s.current().title).toBe("3 ad videos for the spring push");
  });

  it("404s an edit to a brief that is not this tenant's", async () => {
    const s = store(brief());
    await expect(
      saveBrief(
        { tenant_id: TENANT, brief_id: "b9999999-9999-9999-9999-999999999999", input: { title: "x" } },
        s.deps,
      ),
    ).rejects.toThrow(/does not exist/);
  });
});

describe("starting blank (spec item 30)", () => {
  it("seeds a visibly unfinished body rather than empty strings", async () => {
    const s = store(brief({ title: "", angle: "", hook: "", format: "" }));
    const created = await saveBrief({ tenant_id: TENANT, input: {}, blank: true }, s.deps);
    expect(created.title).toBe("Untitled brief");
    expect(created.angle).toContain("Write what this brief is for");
    expect(created.rationale).toContain("No agent argued for this brief");
  });

  it("refuses to publish a brief whose body is still empty", async () => {
    const s = store(brief({ title: "   " }));
    const res = await publishBrief({ tenant_id: TENANT, brief_id: BRIEF, now: new Date(T0) }, s.deps);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("brief_incomplete");
      expect(res.message).toContain("Title is empty");
    }
  });
});

describe("publishing (spec item 16 defaults)", () => {
  it("defaults to 5 days to answer and a cap of 20", async () => {
    const s = store(brief());
    const res = await publishBrief({ tenant_id: TENANT, brief_id: BRIEF, now: new Date(T0) }, s.deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.first_publish).toBe(true);
    expect(res.answer_by).toBe(plus(DEFAULT_ANSWER_BY_DAYS * D));
    expect(res.applicant_cap).toBe(DEFAULT_APPLICANT_CAP);
  });

  it("takes the founder's own date and cap when they set them", async () => {
    const s = store(brief());
    const res = await publishBrief(
      {
        tenant_id: TENANT,
        brief_id: BRIEF,
        answer_by: plus(10 * D),
        applicant_cap: 5,
        now: new Date(T0),
      },
      s.deps,
    );
    expect(res.ok && res.answer_by).toBe(plus(10 * D));
    expect(res.ok && res.applicant_cap).toBe(5);
  });

  it("ignores a date in the past and falls back to the 5 day default", () => {
    expect(resolveAnswerBy(plus(-D), new Date(T0))).toBe(plus(DEFAULT_ANSWER_BY_DAYS * D));
    expect(resolveAnswerBy(null, new Date(T0))).toBe(plus(DEFAULT_ANSWER_BY_DAYS * D));
  });

  it("accepts no cap at all when the founder asks for none", async () => {
    const s = store(brief());
    const res = await publishBrief(
      { tenant_id: TENANT, brief_id: BRIEF, applicant_cap: null, now: new Date(T0) },
      s.deps,
    );
    expect(res.ok && res.applicant_cap).toBeNull();
  });

  it("refuses a cap outside the schema's range instead of clamping it", async () => {
    const s = store(brief());
    await expect(
      publishBrief({ tenant_id: TENANT, brief_id: BRIEF, applicant_cap: 9_999, now: new Date(T0) }, s.deps),
    ).rejects.toThrow(/between 1 and 500/);
  });

  it("publishing twice is a no-op, so alerts and timers fan out once", async () => {
    const s = store(brief());
    const first = await publishBrief({ tenant_id: TENANT, brief_id: BRIEF, now: new Date(T0) }, s.deps);
    const second = await publishBrief(
      { tenant_id: TENANT, brief_id: BRIEF, now: new Date(plus(60_000)) },
      s.deps,
    );
    expect(first.ok && first.first_publish).toBe(true);
    expect(second.ok && second.first_publish).toBe(false);
    expect(second.ok && second.answer_by).toBe(first.ok ? first.answer_by : "");
  });

  it("404s a brief that is not this tenant's", async () => {
    const s = store(brief());
    const res = await publishBrief(
      { tenant_id: TENANT, brief_id: "b9999999-9999-9999-9999-999999999999" },
      s.deps,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("brief_not_found");
  });
});

describe("the polite no the business can edit (spec item 16)", () => {
  it("defaults to a note that claims nobody watched anything", async () => {
    const s = store(brief());
    const bench = await briefWorkbench({ tenant_id: TENANT, brief_id: BRIEF }, s.deps);
    expect(bench?.decline_note).toBe(DEFAULT_DECLINE_NOTE);
    expect(bench?.decline_note_is_default).toBe(true);
    const lowered = DEFAULT_DECLINE_NOTE.toLowerCase();
    for (const claim of ["loved", "watched", "enjoyed", "impressed", "reviewed your"]) {
      expect(lowered).not.toContain(claim);
    }
    expect(DEFAULT_DECLINE_NOTE).not.toMatch(/[–—]|--/);
  });

  it("uses the founder's note once they write one", async () => {
    const s = store(brief());
    await saveBrief(
      { tenant_id: TENANT, brief_id: BRIEF, input: { decline_note: "Not this time. Try the next one." } },
      s.deps,
    );
    const bench = await briefWorkbench({ tenant_id: TENANT, brief_id: BRIEF }, s.deps);
    expect(bench?.decline_note).toBe("Not this time. Try the next one.");
    expect(bench?.decline_note_is_default).toBe(false);
  });
});

describe("invariant 8: one fee function", () => {
  it("a quote's split is literally computeCreatorFees on its cents", () => {
    for (const usd of [1, 12.34, 150, 499.99, 1_000]) {
      expect(quoteFeeSplit(usd)).toEqual(computeCreatorFees(Math.round(usd * 100)));
    }
  });

  it("matches the spec's worked example: $150 quote", () => {
    const fees = quoteFeeSplit(150);
    expect(fees.price_cents).toBe(15_000);
    expect(fees.business_total_cents).toBe(16_500);
    expect(fees.creator_payout_cents).toBe(12_750);
    expect(fees.zavi_gross_cents).toBe(3_750);
  });

  it("reads a numeric quote Postgres returned as a string, identically", () => {
    expect(quoteFeeSplit("150.00")).toEqual(quoteFeeSplit(150));
  });

  it("refuses a quote that is not a positive dollar amount", () => {
    for (const bad of [0, -5, Number.NaN, null, undefined, ""]) {
      expect(() => quotedRateToCents(bad as number)).toThrow();
    }
  });

  it("rounds a sub-cent quote to the cent before the fee rule sees it", () => {
    expect(quotedRateToCents(10.005)).toBe(1_001);
    expect(quoteFeeSplit(10.005)).toEqual(computeCreatorFees(1_001));
  });
});

describe("the applicant list the founder hires from (spec item 14)", () => {
  const applications: BriefApplicationRow[] = [
    {
      id: "a1111111-1111-1111-1111-111111111111",
      tenant_id: TENANT,
      brief_id: BRIEF,
      brief_kind: "creative",
      human_member_id: CREATOR_A,
      status: "applied",
      pitch: "I shoot handover scenes in Austin",
      quoted_rate_usd: "150.00",
      created_at: plus(1),
    },
    {
      id: "a2222222-2222-2222-2222-222222222222",
      tenant_id: TENANT,
      brief_id: BRIEF,
      brief_kind: "creative",
      human_member_id: CREATOR_B,
      status: "applied",
      pitch: "",
      quoted_rate_usd: null,
      created_at: plus(2),
    },
  ];

  const deps = {
    load: async () => brief({ posted_at: T0, answer_by: plus(5 * D), applicant_cap: 20 }),
    listApplications: async () => applications,
    profiles: async () =>
      new Map([
        [CREATOR_A, { display_name: "Maya R", slug: "maya", city: "Austin", country_code: "US", bookable: true }],
        [CREATOR_B, { display_name: "Tolu A", slug: "tolu", city: "Lagos", country_code: "NG", bookable: false }],
      ]),
  };

  it("shows each creator's OWN price with the business total beside it", async () => {
    const res = await listApplicantsForBusiness({ tenant_id: TENANT, brief_id: BRIEF }, deps);
    const a = res?.applicants[0];
    expect(a?.quoted_rate_usd).toBe(150);
    expect(a?.fees?.business_total_cents).toBe(16_500);
    expect(a?.fees).toEqual(computeCreatorFees(15_000));
  });

  it("shows a missing quote as missing, never as zero", async () => {
    const res = await listApplicantsForBusiness({ tenant_id: TENANT, brief_id: BRIEF }, deps);
    const b = res?.applicants[1];
    expect(b?.quoted_rate_usd).toBeNull();
    expect(b?.fees).toBeNull();
  });

  it("marks a creator Zavi cannot pay as not bookable (invariant 7)", async () => {
    const res = await listApplicantsForBusiness({ tenant_id: TENANT, brief_id: BRIEF }, deps);
    expect(res?.applicants[0]?.bookable).toBe(true);
    expect(res?.applicants[1]?.bookable).toBe(false);
  });

  it("says what became of a hire: hired, hired then cancelled, or never paid", async () => {
    for (const [order, want] of [
      [{ status: "in_progress", closed_reason: null }, "hired"],
      [{ status: "cancelled", closed_reason: "mediation_refund" }, "cancelled"],
      [{ status: "cancelled", closed_reason: "checkout_abandoned" }, "unpaid"],
    ] as const) {
      const asked: string[][] = [];
      const res = await listApplicantsForBusiness(
        { tenant_id: TENANT, brief_id: BRIEF },
        {
          ...deps,
          listApplications: async () => [{ ...applications[0], status: "approved" }, applications[1]],
          hireOrders: async (_t, ids) => {
            asked.push(ids);
            return new Map([[applications[0].id, order]]);
          },
        },
      );
      expect(res?.applicants[0]?.hire_state).toBe(want);
      expect(res?.applicants[1]?.hire_state).toBeNull();
      expect(asked).toEqual([[applications[0].id]]);
    }
  });

  it("states a neutral order and never a ranking (invariant 4)", async () => {
    const res = await listApplicantsForBusiness({ tenant_id: TENANT, brief_id: BRIEF }, deps);
    expect(res?.order).toContain("Oldest first");
    expect(res?.order.toLowerCase()).toContain("never ranked");
    expect(res?.order).not.toMatch(/[–—]|--/);
  });

  it("carries no creator email or legal name", async () => {
    const res = await listApplicantsForBusiness({ tenant_id: TENANT, brief_id: BRIEF }, deps);
    const payload = JSON.stringify(res);
    expect(payload).not.toContain("@");
    expect(payload).not.toContain("date_of_birth");
  });

  it("never shows the business contact details an older pitch was stored with", async () => {
    const res = await listApplicantsForBusiness(
      { tenant_id: TENANT, brief_id: BRIEF },
      {
        ...deps,
        listApplications: async () => [
          { ...applications[0], pitch: "  WhatsApp +1 512 555 0199 or maya.r@gmail.com, I shoot handovers  " },
        ],
      },
    );
    const note = res?.applicants[0]?.note ?? "";
    expect(note).not.toContain("0199");
    expect(note).not.toContain("gmail");
    expect(note).toContain("[contact removed, keep it on Zavi]");
    expect(note).toContain("I shoot handovers");
    expect(note).toBe(note.trim());
  });
});

describe("validation refuses bad input before any write", () => {
  it("requires the body on a create and accepts one field on an edit", () => {
    expect(() => validateBriefInput({}, { partial: false })).toThrow(/Title is required/);
    expect(validateBriefInput({ hook: "new hook" }, { partial: true })).toEqual({ hook: "new hook" });
  });

  it("refuses every lane but ugc_video, the audience post lane included", () => {
    for (const lane of ["podcast", "audience_post", "AUDIENCE_POST", "influencer", " ugc_video"]) {
      let thrown: unknown = null;
      try {
        validateBriefInput({ lane }, { partial: true });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, lane).toMatchObject({ code: "brief_lane_invalid" });
      expect(String((thrown as Error).message)).not.toMatch(/audience_post/);
    }
    expect(validateBriefInput({ lane: "ugc_video" }, { partial: true })).toEqual({ lane: "ugc_video" });
    expect(validateBriefInput({ lane: null }, { partial: true })).toEqual({ lane: null });
    expect(validateBriefInput({ lane: "" }, { partial: true })).toEqual({ lane: null });
  });

  it("keeps filters to lists of short strings", () => {
    expect(
      validateBriefInput({ filters: { niches: ["travel", ""], platforms: ["tiktok"] } }, { partial: true }),
    ).toEqual({ filters: { niches: ["travel"], platforms: ["tiktok"] } });
    expect(() => validateBriefInput({ filters: { niches: "travel" } }, { partial: true })).toThrow(
      /has to be a list/,
    );
  });

  it("refuses a negative budget and keeps cents", () => {
    expect(() => validateBriefInput({ budget_usd: -1 }, { partial: true })).toThrow(/zero or more/);
    expect(validateBriefInput({ budget_usd: "450.555" }, { partial: true })).toEqual({
      budget_usd: 450.56,
    });
  });

  it("refuses delivery days outside the schema's range", () => {
    expect(() => validateBriefInput({ delivery_days: 0 }, { partial: true })).toThrow(/between 1 and 90/);
    expect(() => validateBriefInput({ delivery_days: 91 }, { partial: true })).toThrow(/between 1 and 90/);
  });
});
