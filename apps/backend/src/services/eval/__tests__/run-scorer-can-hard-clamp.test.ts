
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  meta: { tenant_id: "t-1", finished_at: new Date().toISOString() } as {
    tenant_id: string | null;
    finished_at: string | null;
  } | null,
  metaErr: null as { message: string } | null,
}));

vi.mock("@/services/supabase", () => {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: h.metaErr ? null : h.meta, error: h.metaErr }),
  };
  return { serviceClient: () => ({ from: () => q }) };
});

const groundMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/services/agents/negative-existence-grounding-verifier", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    isBackendSubsystemPath: actual.isBackendSubsystemPath,
    detectNegativeExistenceClaims: (text: string) =>
      /could not locate|does not exist|no [a-z]/i.test(text)
        ? [{ claim: text, symbol: "respondToCarReview", kind: "endpoint" }]
        : [],
    groundNegativeExistence: (...args: unknown[]) => groundMock.fn(...args),
  };
});

import { maybeGroundNegativeExistence, canHardClamp } from "../run-scorer";

function provenWrong(
  hit_type: "route" | "function" | "field" | "symbol",
  path: string,
) {
  return [
    {
      claim: "could not locate the endpoint",
      exists: true,
      evidence: {
        claimed_absent: "respondToCarReview",
        matched_symbol: "respondToCarReview",
        repo: "rravi149/upcar",
        path,
        line: 96,
        hit_type,
        checked_ref: "HEAD",
      },
    },
  ];
}

const engineerRun = {
  id: "r1",
  agent_slug: "engineer",
  status: "success",
  output_text: "I could not locate a respondToCarReview endpoint.",
  error: null,
  model_used: "claude",
  cost_usd: 0.1,
  tool_calls: 3,
};
const baseQuality = { score: 90, rationale: "ok", model: "gpt-5.5" };

describe("canHardClamp (L3 gate)", () => {
  it("TRUE only for precise hit_type (route/function/field) on a backend path", () => {
    expect(canHardClamp({ hit_type: "route", path: "src/routes/cars.route.ts" } as never)).toBe(true);
    expect(canHardClamp({ hit_type: "function", path: "apps/backend/src/svc/x.ts" } as never)).toBe(true);
    expect(canHardClamp({ hit_type: "field", path: "src/models/rating.model.ts" } as never)).toBe(true);
  });

  it("FALSE for the bare `symbol` fallback even on a backend path", () => {
    expect(canHardClamp({ hit_type: "symbol", path: "src/routes/cars.route.ts" } as never)).toBe(false);
  });

  it("FALSE for a cross-subsystem path even with a precise hit_type", () => {
    expect(canHardClamp({ hit_type: "route", path: "ContentView.swift" } as never)).toBe(false);
    expect(canHardClamp({ hit_type: "field", path: "apps/web/src/Card.tsx" } as never)).toBe(false);
  });
});

describe("maybeGroundNegativeExistence — L3 clamp gate", () => {
  beforeEach(() => {
    groundMock.fn.mockReset();
    h.meta = { tenant_id: "t-1", finished_at: new Date().toISOString() };
    h.metaErr = null;
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
  });
  afterEach(() => {
    delete process.env.NEG_EXISTENCE_GROUNDING_ENABLED;
  });

  it("route + backend path ⇒ CLAMPS (regression guard — real engineer catch preserved)", async () => {
    groundMock.fn.mockResolvedValue(provenWrong("route", "src/routes/cars.route.ts"));
    const out = await maybeGroundNegativeExistence(engineerRun, baseQuality, { remaining: 5 }, {
      info: () => {},
      warn: () => {},
    });
    expect(out.outcome).toBe("processed");
    if (out.outcome !== "processed") throw new Error("unreachable");
    expect(out.quality?.score).toBeLessThanOrEqual(49);
    expect(out.quality?.rationale).toBe("false_negative_existence");
    expect(out.evidence).toBeTruthy();
  });

  it("bare `symbol` hit ⇒ records evidence but does NOT clamp (score preserved → won't auto-queue)", async () => {
    groundMock.fn.mockResolvedValue(provenWrong("symbol", "src/routes/cars.route.ts"));
    const out = await maybeGroundNegativeExistence(engineerRun, baseQuality, { remaining: 5 }, {
      info: () => {},
      warn: () => {},
    });
    expect(out.outcome).toBe("processed");
    if (out.outcome !== "processed") throw new Error("unreachable");
    expect(out.quality).toBeUndefined();
    expect(out.evidence).toBeTruthy();
  });

  it("cross-subsystem path (.swift) ⇒ records evidence but does NOT clamp", async () => {
    groundMock.fn.mockResolvedValue(provenWrong("route", "ContentView.swift"));
    const out = await maybeGroundNegativeExistence(engineerRun, baseQuality, { remaining: 5 }, {
      info: () => {},
      warn: () => {},
    });
    expect(out.outcome).toBe("processed");
    if (out.outcome !== "processed") throw new Error("unreachable");
    expect(out.quality).toBeUndefined();
    expect(out.evidence).toBeTruthy();
  });
});

describe("maybeGroundNegativeExistence — L4 agent scope", () => {
  beforeEach(() => {
    groundMock.fn.mockReset();
    h.meta = { tenant_id: "t-1", finished_at: new Date().toISOString() };
    h.metaErr = null;
    process.env.NEG_EXISTENCE_GROUNDING_ENABLED = "1";
  });
  afterEach(() => {
    delete process.env.NEG_EXISTENCE_GROUNDING_ENABLED;
  });

  it("chief-of-staff run ⇒ grounding skipped entirely (no detector, no github)", async () => {
    const cosRun = {
      ...engineerRun,
      agent_slug: "chief-of-staff",
      output_text:
        "The `users` schema confirms paymentMethods are stored with no ownership gate on that endpoint.",
    };
    const out = await maybeGroundNegativeExistence(cosRun, baseQuality, { remaining: 5 }, {
      info: () => {},
      warn: () => {},
    });
    expect(out.outcome).toBe("processed");
    if (out.outcome !== "processed") throw new Error("unreachable");
    expect(out.quality).toBeUndefined();
    expect(groundMock.fn).not.toHaveBeenCalled();
  });

  it("engineer run ⇒ grounding RUNS (code-claiming agent)", async () => {
    groundMock.fn.mockResolvedValue(provenWrong("route", "src/routes/cars.route.ts"));
    await maybeGroundNegativeExistence(engineerRun, baseQuality, { remaining: 5 }, {
      info: () => {},
      warn: () => {},
    });
    expect(groundMock.fn).toHaveBeenCalled();
  });
});
