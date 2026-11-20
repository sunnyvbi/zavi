import { describe, it, expect, beforeEach } from "vitest";
import {
  verifyPlanGrounding,
  detectOwnSystemClaims,
  type PlanTextSurfaces,
} from "@/services/agents/plan-grounding-verifier";
import {
  recordGroundingReceipt,
  groundingReceipts,
  __resetGroundingReceiptsForTest,
} from "@/services/agents/engine/grounding-receipt-ledger";
import type { GroundingReceiptKind } from "@/services/agents/engine/grounding-receipt-ledger";

const NONE = new Set<GroundingReceiptKind>();
const REPO_READ = new Set<GroundingReceiptKind>(["repo_read"]);

const FAILING_PLAN: PlanTextSurfaces = {
  title: "Zavi Video Agent: Multi-Model Higgsfield Strategy",
  sectionText: [
    "The gap: render_video today generates motion-graphic scenes. It cannot render a person speaking on camera.",
    "The fix: The existing render_video tool would need a new video_type: 'talking_avatar' branch that calls fal.ai. Nothing needs to be built at the model level.",
    "P1: Connect the Higgsfield MCP to Zavi agent. It exposes 30+ models and already exists. Hours of work, not weeks.",
  ],
};

describe("detectOwnSystemClaims", () => {
  it("flags the exact claims that made the video plan 2/10", () => {
    const claims = detectOwnSystemClaims(FAILING_PLAN);
    expect(claims.length).toBeGreaterThanOrEqual(3);
  });

  it("does NOT flag a pure market/research plan (no false positive)", () => {
    const marketPlan: PlanTextSurfaces = {
      title: "Q3 growth wedge",
      sectionText: [
        "Competitors charge $49/mo; we should target the underserved solo-operator segment.",
        "The market wants faster onboarding and a clearer pricing page.",
        "Recommendation: run a 2-week landing-page test against the marketplaces vertical.",
      ],
    };
    expect(detectOwnSystemClaims(marketPlan)).toHaveLength(0);
  });
});

describe("verifyPlanGrounding", () => {
  it("CASE 1 (the failure replay): own-system claims + NO receipt + repo connected => ungrounded", () => {
    const r = verifyPlanGrounding({
      surfaces: FAILING_PLAN,
      receipts: NONE,
      hasRepoConnector: true,
    });
    expect(r.verdict).toBe("ungrounded");
    expect(r.claims.length).toBeGreaterThan(0);
  });

  it("CASE 2 (grounded passes): same claims + a repo_read receipt => ok", () => {
    const r = verifyPlanGrounding({
      surfaces: FAILING_PLAN,
      receipts: REPO_READ,
      hasRepoConnector: true,
    });
    expect(r.verdict).toBe("ok");
  });

  it("CASE 3a (no connector, no disclosure): => needs_disclosure", () => {
    const r = verifyPlanGrounding({
      surfaces: FAILING_PLAN,
      receipts: NONE,
      hasRepoConnector: false,
    });
    expect(r.verdict).toBe("needs_disclosure");
  });

  it("CASE 3b (no connector, WITH disclosure): => ok", () => {
    const disclosed: PlanTextSurfaces = {
      title: FAILING_PLAN.title,
      sectionText: [
        ...FAILING_PLAN.sectionText,
        "Note: no code repository is connected, so this plan is not code-grounded — verify against the codebase before building.",
      ],
    };
    const r = verifyPlanGrounding({
      surfaces: disclosed,
      receipts: NONE,
      hasRepoConnector: false,
    });
    expect(r.verdict).toBe("ok");
  });

  it("CASE 4 (no own-system claims): market plan + empty receipts => ok (never bricks a research plan)", () => {
    const marketPlan: PlanTextSurfaces = {
      title: "Pricing experiment",
      sectionText: ["Test $29 vs $49 on the solo tier for two weeks; measure activation."],
    };
    const r = verifyPlanGrounding({
      surfaces: marketPlan,
      receipts: NONE,
      hasRepoConnector: true,
    });
    expect(r.verdict).toBe("ok");
    expect(r.claims).toHaveLength(0);
  });
});

describe("grounding-receipt-ledger", () => {
  beforeEach(() => __resetGroundingReceiptsForTest());

  it("maps a successful github__search_code call to a repo_read receipt", () => {
    recordGroundingReceipt("run-1", "github__search_code");
    expect(groundingReceipts("run-1").has("repo_read")).toBe(true);
  });

  it("maps github__list_commits to a repo_history receipt", () => {
    recordGroundingReceipt("run-2", "github__list_commits");
    expect(groundingReceipts("run-2").has("repo_history")).toBe(true);
    expect(groundingReceipts("run-2").has("repo_read")).toBe(false);
  });

  it.each([
    "code_index__code_def",
    "code_index__code_refs",
    "code_index__code_callers",
  ])("maps %s to a repo_read receipt", (tool) => {
    recordGroundingReceipt("run-sym", tool);
    expect(groundingReceipts("run-sym").has("repo_read")).toBe(true);
  });

  it("ignores a non-grounding tool + absent run_id", () => {
    recordGroundingReceipt("run-3", "slack__send_message");
    recordGroundingReceipt(undefined, "github__search_code");
    expect(groundingReceipts("run-3").size).toBe(0);
  });

  it("end-to-end: a run that only ToolSearch'd (never called) a repo tool has no receipt", () => {
    recordGroundingReceipt("run-4", "ToolSearch");
    const gated = verifyPlanGrounding({
      surfaces: FAILING_PLAN,
      receipts: groundingReceipts("run-4"),
      hasRepoConnector: true,
    });
    expect(gated.verdict).toBe("ungrounded");
  });
});
