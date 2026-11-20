
import { describe, expect, it } from "vitest";
import {
  BRIEF_BOARD_ORDER,
  CREATOR_BRIEF_COLUMNS,
  answerByCopy,
  briefBoardCountLine,
  briefOpenState,
  briefSpotsLine,
  creatorVisibleBrief,
  type CreatorBriefSourceRow,
} from "../brief-projection";

const T0 = "2026-09-11T00:00:00.000Z";
const D = 24 * 3_600_000;
const plus = (ms: number) => new Date(new Date(T0).getTime() + ms).toISOString();

function row(over: Partial<CreatorBriefSourceRow> = {}): CreatorBriefSourceRow {
  return {
    id: "b1111111-1111-1111-1111-111111111111",
    title: "3 ad videos for the spring push",
    angle: "Show the car being handed over, not the app",
    hook: "I almost did not book this car",
    format: "9:16 UGC, 30 seconds",
    deliverables: 3,
    budget_usd: 450,
    lane: "ugc_video",
    delivery_days: 7,
    posted_at: T0,
    answer_by: plus(5 * D),
    applicant_cap: 20,
    closed_at: null,
    ...over,
  };
}

const DENIED = [
  "rationale",
  "evidence",
  "source_campaign_ref",
  "source_run_id",
  "utm_campaign",
  "tenant_id",
  "decline_note",
  "status",
  "updated_at",
  "source_channel",
] as const;

describe("the creator-visible field allowlist", () => {
  it("never serializes a denied column, even when the row carries one", () => {
    const polluted = {
      ...row(),
      tenant_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      status: "sent",
      rationale: "CTR on ad set 9912 fell 41% over 14 days",
      evidence: [{ ad_set: "9912", ctr_drop: 0.41 }],
      source_campaign_ref: "spring-retarget-2026",
      source_run_id: "run-7788",
      utm_campaign: "zavi-brief-4f2a91bc77de",
      decline_note: "we loved your intro",
      source_channel: "meta_ads",
      updated_at: plus(1),
    } as unknown as CreatorBriefSourceRow;

    const projected = creatorVisibleBrief(polluted, {
      business_name: "Northwind Coffee",
      applicant_count: 2,
    });
    const payload = JSON.stringify(projected);

    for (const key of DENIED) {
      expect(payload, `denied column '${key}' reached the wire`).not.toContain(`"${key}"`);
    }
    expect(payload).not.toContain("CTR on ad set");
    expect(payload).not.toContain("spring-retarget-2026");
    expect(payload).not.toContain("zavi-brief-");
    expect(payload).not.toContain("we loved your intro");
    expect(payload).not.toContain("ctr_drop");
    expect(payload).not.toContain("aaaaaaaa-aaaa");
  });

  it("carries exactly the agreed creator-visible keys and nothing else", () => {
    const projected = creatorVisibleBrief(row(), {
      business_name: "Northwind Coffee",
      applicant_count: 0,
    });
    expect(Object.keys(projected).sort()).toEqual(
      [
        "angle",
        "answer_by",
        "applicant_cap",
        "ad_rights_days",
        "applicant_count",
        "budget_usd",
        "business_name",
        "closed_reason",
        "deliverables",
        "delivery_days",
        "format",
        "hook",
        "id",
        "lane",
        "open",
        "posted_at",
        "spots_left",
        "title",
      ].sort(),
    );
  });

  it("keeps the SQL select list free of denied columns too", () => {
    for (const key of DENIED) {
      expect(CREATOR_BRIEF_COLUMNS).not.toContain(key);
    }
    expect(CREATOR_BRIEF_COLUMNS).not.toContain("*");
  });

  it("shows the business name and nothing else about the workspace", () => {
    const projected = creatorVisibleBrief(row(), {
      business_name: "  Northwind Coffee  ",
      applicant_count: 0,
    });
    expect(projected.business_name).toBe("Northwind Coffee");
  });

  it("names an unnamed business rather than rendering a blank", () => {
    const projected = creatorVisibleBrief(row(), { business_name: "", applicant_count: 0 });
    expect(projected.business_name).toBe("A Zavi business");
  });
});

describe("open state (the cap, the answer-by date, the hire)", () => {
  it("is open with places left", () => {
    const s = briefOpenState(row(), 3, new Date(T0));
    expect(s).toEqual({ open: true, closed_reason: null, spots_left: 17 });
  });

  it("closes at the cap", () => {
    const s = briefOpenState(row({ applicant_cap: 20 }), 20, new Date(T0));
    expect(s.open).toBe(false);
    expect(s.closed_reason).toBe("cap_reached");
    expect(s.spots_left).toBe(0);
  });

  it("closes when the answer-by date passes", () => {
    const s = briefOpenState(row(), 2, new Date(plus(5 * D + 1)));
    expect(s.open).toBe(false);
    expect(s.closed_reason).toBe("answer_by_passed");
  });

  it("reports a hire as filled, not as a cap or a date", () => {
    const s = briefOpenState(row({ closed_at: plus(1) }), 2, new Date(T0));
    expect(s.open).toBe(false);
    expect(s.closed_reason).toBe("filled");
  });

  it("treats an unposted draft as not a board brief at all", () => {
    const s = briefOpenState(row({ posted_at: null }), 0, new Date(T0));
    expect(s).toEqual({ open: false, closed_reason: null, spots_left: 20 });
  });

  it("has no places-left number when there is no cap", () => {
    const s = briefOpenState(row({ applicant_cap: null }), 99, new Date(T0));
    expect(s.open).toBe(true);
    expect(s.spots_left).toBeNull();
  });
});

describe("honesty on screen (invariant 4)", () => {
  it("states a neutral order and never mentions fit", () => {
    expect(BRIEF_BOARD_ORDER).toContain("Newest first");
    expect(BRIEF_BOARD_ORDER.toLowerCase()).toContain("never ranked");
  });

  it("calls a thin board thin and a zero a real zero", () => {
    expect(briefBoardCountLine(0, 1)).toContain("real zero");
    expect(briefBoardCountLine(0, 0)).toContain("real zero");
    expect(briefBoardCountLine(1, 1)).toBe("1 brief is open right now.");
    expect(briefBoardCountLine(4, 2)).toBe("4 briefs are open right now.");
  });

  it("tells an applicant how many places are left", () => {
    expect(briefSpotsLine({ applicant_cap: 20, spots_left: 17 })).toContain("17 places left");
    expect(briefSpotsLine({ applicant_cap: 20, spots_left: 1 })).toContain("1 place left");
    expect(briefSpotsLine({ applicant_cap: 20, spots_left: 0 })).toContain("all the applications");
    expect(briefSpotsLine({ applicant_cap: null, spots_left: null })).toContain("no application limit");
  });

  it("words the answer-by promise once, for both sides (invariant 5)", () => {
    const copy = answerByCopy(plus(5 * D));
    expect(copy.line).toContain("2026-09-16");
    expect(copy.line).toContain("hears back by");
    expect(copy.line).toContain("the brief closes");
    expect(copy.at).toBe(plus(5 * D));
  });

  it("says plainly when no date was set rather than inventing one", () => {
    expect(answerByCopy(null).at).toBeNull();
    expect(answerByCopy(null).line).toContain("has not set a date");
    expect(answerByCopy("not-a-date").at).toBeNull();
  });

  it("uses no em dash, en dash or double hyphen in creator-facing copy", () => {
    const copy = [
      BRIEF_BOARD_ORDER,
      briefBoardCountLine(0, 0),
      briefBoardCountLine(3, 1),
      briefSpotsLine({ applicant_cap: 20, spots_left: 2 }),
      answerByCopy(plus(5 * D)).line,
      answerByCopy(null).line,
    ].join(" ");
    expect(copy).not.toMatch(/[–—]|--/);
  });
});

describe("invariant 6: the creator sees the saved row", () => {
  it("reads every creator-visible field off the row it was handed", () => {
    const before = creatorVisibleBrief(row(), { business_name: "Northwind", applicant_count: 0 });
    const after = creatorVisibleBrief(
      row({ title: "2 ad videos, new angle", hook: "I nearly walked away", budget_usd: 600 }),
      { business_name: "Northwind", applicant_count: 0 },
    );
    expect(before.title).toBe("3 ad videos for the spring push");
    expect(after.title).toBe("2 ad videos, new angle");
    expect(after.hook).toBe("I nearly walked away");
    expect(after.budget_usd).toBe(600);
  });

  it("reads a numeric budget that Postgres returned as a string", () => {
    const projected = creatorVisibleBrief(row({ budget_usd: "450.00" }), {
      business_name: "Northwind",
      applicant_count: 0,
    });
    expect(projected.budget_usd).toBe(450);
  });
});
