import { describe, it, expect, vi } from "vitest";
import {
  resolveCohort,
  coerceBasis,
  BULK_COHORT_HARD_CAP,
  COHORT_SAMPLE_SIZE,
  type CohortRecord,
  type CohortSource,
  type CohortSelector,
} from "../cohort";

const selector: CohortSelector = { segment: "stalled_sellers" };

function fakeSource(
  byTenant: Record<string, CohortRecord[]>,
): CohortSource & { calls: Array<{ tenant_id: string; selector: CohortSelector }> } {
  const calls: Array<{ tenant_id: string; selector: CohortSelector }> = [];
  return {
    calls,
    async fetchCandidates(tenant_id, sel) {
      calls.push({ tenant_id, selector: sel });
      return byTenant[tenant_id] ?? [];
    },
  };
}

describe("resolveCohort — first-party + basis + cap trust boundary", () => {
  it("opt_in basis includes ONLY explicit-marketing-opt-in records", async () => {
    const src = fakeSource({
      t1: [
        { email: "a@x.com", opt_in_marketing: true },
        { email: "b@x.com", opt_in_marketing: false },
        { email: "c@x.com", has_relationship: true },
        { email: "d@x.com" },
      ],
    });
    const r = await resolveCohort("t1", selector, "opt_in", src);
    expect(r.recipients).toEqual(["a@x.com"]);
    expect(r.est_recipient_count).toBe(1);
    expect(r.basis).toBe("opt_in");
    expect(r.capped).toBe(false);
  });

  it("relationship basis includes ONLY existing-relationship records", async () => {
    const src = fakeSource({
      t1: [
        { email: "a@x.com", opt_in_marketing: true },
        { email: "b@x.com", has_relationship: true },
        { email: "c@x.com", has_relationship: true, opt_in_marketing: false },
        { email: "d@x.com" },
      ],
    });
    const r = await resolveCohort("t1", selector, "relationship", src);
    expect(new Set(r.recipients)).toEqual(new Set(["b@x.com", "c@x.com"]));
    expect(r.est_recipient_count).toBe(2);
  });

  it("normalizes (lowercase/trim), de-dupes, and drops invalid emails", async () => {
    const src = fakeSource({
      t1: [
        { email: "  A@X.com ", opt_in_marketing: true },
        { email: "a@x.com", opt_in_marketing: true },
        { email: "not-an-email", opt_in_marketing: true },
        { email: "b@x.com", opt_in_marketing: true },
      ],
    });
    const r = await resolveCohort("t1", selector, "opt_in", src);
    expect(r.recipients).toEqual(["a@x.com", "b@x.com"]);
  });

  it("hard-caps at BULK_COHORT_HARD_CAP and flags capped=true", async () => {
    const many: CohortRecord[] = Array.from({ length: BULK_COHORT_HARD_CAP + 500 }, (_, i) => ({
      email: `user${i}@x.com`,
      opt_in_marketing: true,
    }));
    const src = fakeSource({ t1: many });
    const r = await resolveCohort("t1", selector, "opt_in", src);
    expect(r.est_recipient_count).toBe(BULK_COHORT_HARD_CAP);
    expect(r.recipients.length).toBe(BULK_COHORT_HARD_CAP);
    expect(r.capped).toBe(true);
    expect(r.sample_recipients.length).toBe(COHORT_SAMPLE_SIZE);
  });

  it("passes the SERVER-derived tenant_id through to the source (tenant isolation)", async () => {
    const src = fakeSource({
      t1: [{ email: "a@x.com", opt_in_marketing: true }],
      t2: [{ email: "z@y.com", opt_in_marketing: true }],
    });
    const r1 = await resolveCohort("t1", selector, "opt_in", src);
    expect(r1.recipients).toEqual(["a@x.com"]);
    expect(src.calls.at(-1)?.tenant_id).toBe("t1");

    const r2 = await resolveCohort("t2", selector, "opt_in", src);
    expect(r2.recipients).toEqual(["z@y.com"]);
    expect(src.calls.at(-1)?.tenant_id).toBe("t2");
  });

  it("never trusts an agent list — the only addresses come from the source", async () => {
    const spy = vi.fn(async () => [{ email: "real@x.com", opt_in_marketing: true }]);
    const src: CohortSource = { fetchCandidates: spy };
    const forged = { segment: "x", recipients: ["evil@attacker.com"] } as unknown as CohortSelector;
    const r = await resolveCohort("t1", forged, "opt_in", src);
    expect(r.recipients).toEqual(["real@x.com"]);
    expect(JSON.stringify(r)).not.toContain("evil@attacker.com");
  });
});

describe("coerceBasis", () => {
  it("defaults unknown / missing to the conservative 'opt_in'", () => {
    expect(coerceBasis(undefined)).toBe("opt_in");
    expect(coerceBasis("garbage")).toBe("opt_in");
    expect(coerceBasis("opt_in")).toBe("opt_in");
    expect(coerceBasis("relationship")).toBe("relationship");
  });
});
