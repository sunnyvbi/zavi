import { describe, expect, it } from "vitest";
import { RESEARCH_SCOPE_REASON, researchScopeRefusal, tenantRecordsNamed, withoutTenantRecordResearch } from "../research-scope";
import type { GoalMoves } from "../goal-owner";

const TABLES = ["trips", "users", "host_payouts", "ab"];

describe("tenantRecordsNamed", () => {
  it("catches the live asks: a catalog table named beside a data noun, quoted or not", () => {
    expect(tenantRecordsNamed("Read only, change nothing. From the trips data, take the 112 booking trips created since Oct 1", TABLES)).toBe("trips");
    expect(tenantRecordsNamed("Use the trips data alone, with no listings or calendars.", TABLES)).toBe("trips");
    expect(tenantRecordsNamed("Use the `trips` data alone", TABLES)).toBe("trips");
    expect(tenantRecordsNamed("Use records from trips since Oct 1", TABLES)).toBe("trips");
    expect(tenantRecordsNamed("Count records of the trips since Oct 1", TABLES)).toBe("trips");
    expect(tenantRecordsNamed("Sum the host payouts table by week", TABLES)).toBe("host_payouts");
    expect(tenantRecordsNamed("Count rows in our users collection who came from google", TABLES)).toBe("users");
    expect(tenantRecordsNamed("From the trips data, count cancellations that start on the booking page", TABLES)).toBe("trips");
    expect(tenantRecordsNamed("Read the trips table since the public launch", TABLES)).toBe("trips");
  });
  it("leaves ordinary English and public-web studies alone", () => {
    for (const intent of [
      "Read the trips offer and how it is framed",
      "Pull users into the paid plan with a stronger first week",
      "What drives growth in users this quarter",
      "Research the needs of our users using public G2 reviews",
      "What do users say about rental apps on reddit?",
      "Read the trips page on a rival's site",
      "Price the three rivals' booking pages",
      "Study a collection of users discussing car share on forums",
      "Read the comparison table of users on G2",
      "Build a database of trips competitors publish",
      "Compare the dataset of trips listed on Kayak",
    ]) {
      expect(tenantRecordsNamed(intent, TABLES)).toBeNull();
    }
  });
  it("never checks a name too short to mean anything, or a tenant with no catalog", () => {
    expect(tenantRecordsNamed("from the ab data", TABLES)).toBeNull();
    expect(tenantRecordsNamed("From the trips data", [])).toBeNull();
  });
});

describe("withoutTenantRecordResearch", () => {
  const moves = {
    goals: [
      {
        goal_id: "g1",
        moves: [
          { target_agent_slug: "research ", intent: "From the trips data, count host cancellations" },
          { target_agent_slug: "research", intent: "Price the three rivals' booking pages" },
          { target_agent_slug: "meta_ads", intent: "Read the trips data budget" },
        ],
      },
    ],
  } as unknown as GoalMoves;
  it("takes out only research moves asking for the tenant's records, and says why", () => {
    const r = withoutTenantRecordResearch(moves, () => "GMV push", TABLES);
    expect(r.moves.goals?.[0].moves.map((m) => m.intent)).toEqual(["Price the three rivals' booking pages", "Read the trips data budget"]);
    expect(r.refused).toEqual([researchScopeRefusal("GMV push", "trips")]);
    expect(r.refused[0]).toBe(`Work for research on "GMV push": ${RESEARCH_SCOPE_REASON} (it asked for your "trips" data).`);
  });
  it("with no catalog names, nothing changes", () => {
    expect(withoutTenantRecordResearch(moves, () => "x", []).moves).toBe(moves);
  });
});
