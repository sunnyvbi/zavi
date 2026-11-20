import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RefinePipelineCard,
  type RefineCardTurn,
} from "./RefinePipelineCard";
import { deriveGateLaneState } from "./builderThreadFormat";
import type {
  GateEvidenceView,
  DeployStatusView,
} from "./builderThreadFormat";

const BASE: RefineCardTurn = {
  id: "refine-1",
  message: "Add a contact email field",
  status: "success",
  created_at: new Date(Date.now() - 30_000).toISOString(),
  summary: "Added an email input + validation to the signup form.",
  pr_url: "https://github.com/acme/app/pull/2",
  files: [{ path: "src/SignupForm.tsx", action: "modify" }],
  gate_evidence: null,
  preview_url: null,
};

const SHIPPED_DIRECT: RefineCardTurn = {
  ...BASE,
  status: "done",
  pr_url: null,
};

const PASS_GATE: GateEvidenceView = {
  build_ok: true,
  tests: { passed: 12, failed: 0 },
  typecheck_ok: true,
  preview_smoke: { verdict: "pass", evidence_md: "Looks good." },
  gate_verdict: "pass",
};

const FAIL_GATE: GateEvidenceView = {
  build_ok: false,
  tests: { passed: 3, failed: 2 },
  typecheck_ok: false,
  preview_smoke: { verdict: "skipped", evidence_md: "" },
  gate_verdict: "fail",
};

const PROTECTED_GATE: GateEvidenceView = {
  build_ok: true,
  tests: { passed: 5, failed: 0 },
  typecheck_ok: true,
  preview_smoke: { verdict: "pass", evidence_md: "" },
  gate_verdict: "fail",
  protected_paths: [{ path: "supabase/migrations/0099_x.sql", glob: "supabase/migrations/**" }],
};

function render(props: Partial<Parameters<typeof RefinePipelineCard>[0]> & { turn: RefineCardTurn }) {
  return renderToStaticMarkup(
    React.createElement(RefinePipelineCard, {
      isUndoable: false,
      ...props,
    }),
  );
}

describe("deriveGateLaneState", () => {
  it("checking — in-flight refine, no evidence yet", () => {
    expect(deriveGateLaneState("active", null)).toBe("checking");
    expect(deriveGateLaneState("provisioning", undefined)).toBe("checking");
  });
  it("none — terminal refine with no evidence", () => {
    expect(deriveGateLaneState("failed", null)).toBe("none");
    expect(deriveGateLaneState("cancelled", null)).toBe("none");
  });
  it("review_ready — gate passed", () => {
    expect(deriveGateLaneState("success", PASS_GATE)).toBe("review_ready");
  });
  it("gate_failed — gate failed on build/tests/preview", () => {
    expect(deriveGateLaneState("success", FAIL_GATE)).toBe("gate_failed");
  });
  it("protected_hold — gate failed because a protected path was touched", () => {
    expect(deriveGateLaneState("success", PROTECTED_GATE)).toBe("protected_hold");
  });
});

describe("RefinePipelineCard — gate results", () => {
  it("gate-pending — running refine with no evidence shows the checks-running line", () => {
    const html = render({ turn: { ...BASE, status: "active", gate_evidence: null } });
    expect(html).toContain("Running checks");
    expect(html).toContain('data-gate-state="checking"');
    expect(html).not.toContain("Blocked by gate");
    expect(html).not.toContain("ready to review");
  });

  it("review-ready — passing gate shows green checks + the parked-for-publish state", () => {
    const html = render({ turn: { ...BASE, gate_evidence: PASS_GATE } });
    expect(html).toContain('data-gate-state="review_ready"');
    expect(html).toContain("Checks passed");
    expect(html).toContain("Build passed");
    expect(html).toContain("12 tests passed");
    expect(html).toContain("Preview smoke passed");
    expect(html).toContain("Parked for Zavi to publish");
    expect(html).not.toContain("open PR to merge");
    expect(html).not.toContain("https://github.com/acme/app/pull/2");
    expect(html).not.toContain("Blocked");
  });

  it("gate-failed — failing gate shows the Blocked banner + the failing evidence", () => {
    const html = render({ turn: { ...BASE, gate_evidence: FAIL_GATE } });
    expect(html).toContain('data-gate-state="gate_failed"');
    expect(html).toContain("Blocked by gate");
    expect(html).toContain("Build broken");
    expect(html).toContain("2 failed");
    expect(html).toContain("Preview smoke skipped");
  });

  it("protected-hold — a protected-path change forces an always-human hold + names the path", () => {
    const html = render({ turn: { ...BASE, gate_evidence: PROTECTED_GATE } });
    expect(html).toContain('data-gate-state="protected_hold"');
    expect(html).toContain("Blocked: human review required (protected path)");
    expect(html).toContain("supabase/migrations/0099_x.sql");
  });
});

describe("RefinePipelineCard — preview URL", () => {
  it("renders the branch-preview link when present", () => {
    const html = render({
      turn: { ...BASE, preview_url: "https://preview.example.dev/abc" },
    });
    expect(html).toContain("view preview");
    expect(html).toContain("https://preview.example.dev/abc");
  });
  it("omits the preview link when absent (the common case)", () => {
    const html = render({ turn: { ...BASE, preview_url: null } });
    expect(html).not.toContain("view preview");
  });
});

describe("RefinePipelineCard — deploy status", () => {
  const watching: DeployStatusView = {
    state: "deploy_watching",
    pr_url: "https://github.com/acme/app/pull/2",
    merged_sha: "abc1234",
    served_sha: null,
    health_url: null,
    reason: "render deploy still in progress",
    merged_at: null,
    updated_at: null,
    rollback_available: false,
  };
  const healthy: DeployStatusView = {
    ...watching,
    state: "deploy_healthy",
    served_sha: "abc1234",
    health_url: "https://acme-app.onrender.com",
    reason: "merged SHA is the served SHA and the app health-probed 2xx",
    rollback_available: true,
  };
  const failed: DeployStatusView = {
    ...watching,
    state: "deploy_failed",
    reason: "render build failed for the merged commit (build_failed)",
    rollback_available: true,
  };

  it("deploy-watching — spinner + Deploying…", () => {
    const html = render({ turn: BASE, isUndoable: true, deploy: watching });
    expect(html).toContain('data-deploy-state="deploy_watching"');
    expect(html).toContain("Deploying…");
    expect(html).toContain("animate-spin");
  });

  it("deploy-healthy — green Deployed + a live-app link", () => {
    const html = render({ turn: BASE, isUndoable: true, deploy: healthy });
    expect(html).toContain('data-deploy-state="deploy_healthy"');
    expect(html).toContain("Deployed");
    expect(html).toContain("View live app");
    expect(html).toContain("https://acme-app.onrender.com");
  });

  it("deploy-failed — red Deploy failed + the reason", () => {
    const html = render({ turn: BASE, isUndoable: true, deploy: failed });
    expect(html).toContain('data-deploy-state="deploy_failed"');
    expect(html).toContain("Deploy failed");
    expect(html).toContain("render build failed for the merged commit");
    expect(html).not.toContain("View live app");
  });

  it("renders no deploy block when there is no deploy record", () => {
    const html = render({ turn: BASE, isUndoable: true, deploy: null });
    expect(html).not.toContain("data-deploy-state");
  });
});

describe("RefinePipelineCard — undo/rollback", () => {
  it("rollback-available — Undo shows on a DIRECT-MERGE shipped refine (done, no PR, no deploy record)", () => {
    const html = render({ turn: SHIPPED_DIRECT, isUndoable: true, deploy: null });
    expect(html).toContain(">Undo<");
  });

  it("hides Undo on a `done` refine that only parked a review PR (not merged/live)", () => {
    const parked: RefineCardTurn = { ...BASE, status: "done", pr_url: "https://github.com/acme/app/pull/9" };
    const html = render({ turn: parked, isUndoable: true, deploy: null });
    expect(html).not.toContain(">Undo<");
  });

  it("rollback-available — Undo shows once a settled deploy reports rollback_available", () => {
    const deploy: DeployStatusView = {
      state: "deploy_healthy",
      pr_url: "x",
      merged_sha: "abc1234",
      served_sha: "abc1234",
      health_url: "https://acme-app.onrender.com",
      reason: null,
      merged_at: null,
      updated_at: null,
      rollback_available: true,
    };
    const html = render({ turn: BASE, isUndoable: true, deploy });
    expect(html).toContain(">Undo<");
  });

  it("hides Undo while a deploy is still watching (rollback not available yet)", () => {
    const deploy: DeployStatusView = {
      state: "deploy_watching",
      pr_url: "x",
      merged_sha: "abc1234",
      served_sha: null,
      health_url: null,
      reason: null,
      merged_at: null,
      updated_at: null,
      rollback_available: false,
    };
    const html = render({ turn: BASE, isUndoable: true, deploy });
    expect(html).not.toContain(">Undo<");
  });

  it("hides Undo when this is not the latest shipped refine", () => {
    const html = render({ turn: BASE, isUndoable: false, deploy: null });
    expect(html).not.toContain(">Undo<");
  });

  it("clicking Undo calls onUndo with the refine id (confirm-then-POST is the owner's job)", () => {
    const onUndo = vi.fn();
    const el = RefinePipelineCard({ turn: SHIPPED_DIRECT, isUndoable: true, onUndo, deploy: null });
    type Node =
      | { type?: unknown; props?: { onClick?: () => void; children?: unknown } }
      | unknown;
    let clickedId: string | null = null;
    const visit = (node: Node) => {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: unknown; props?: { onClick?: () => void; children?: unknown } };
      const props = n.props;
      if (n.type === "button" && props?.onClick && props.children === "Undo") {
        props.onClick();
        clickedId = "invoked";
      }
      const children = props?.children;
      if (Array.isArray(children)) children.forEach(visit);
      else if (children) visit(children as Node);
    };
    visit(el as Node);
    expect(clickedId).toBe("invoked");
    expect(onUndo).toHaveBeenCalledWith("refine-1");
  });
});

describe("RefinePipelineCard — no-ship failure (DEL-686)", () => {
  const HALTED_NOSHIP: RefineCardTurn = {
    ...BASE,
    status: "halted",
    pr_url: null,
    summary: null,
    files: [],
    failure_message:
      "I prepared the change in the sandbox but couldn't push the review branch. This is a platform-side issue worth reporting; nothing shipped.",
    no_ship_reason: "defer_pr_push_failed",
  };

  it("surfaces the engineer's failure message + a 'Nothing shipped' header", () => {
    const html = render({ turn: HALTED_NOSHIP, isUndoable: false });
    expect(html).toContain("Nothing shipped");
    expect(html).toContain("push the review branch");
    expect(html).toContain(">Stopped<");
    expect(html).not.toContain("open PR to merge");
    expect(html).not.toContain("Parked for Zavi to publish");
  });

  it("shows a 'Try again' button wired to onRetry with the refine message", () => {
    const onRetry = vi.fn();
    const el = RefinePipelineCard({
      turn: HALTED_NOSHIP,
      isUndoable: false,
      onRetry,
      runActive: false,
    });
    type Node = { type?: unknown; props?: { onClick?: () => void; children?: unknown } } | unknown;
    let found = false;
    const visit = (node: Node) => {
      if (!node || typeof node !== "object") return;
      const n = node as { type?: unknown; props?: { onClick?: () => void; children?: unknown } };
      if (n.type === "button" && n.props?.children === "Try again" && n.props.onClick) {
        n.props.onClick();
        found = true;
      }
      const c = n.props?.children;
      if (Array.isArray(c)) c.forEach(visit);
      else if (c) visit(c as Node);
    };
    visit(el as Node);
    expect(found).toBe(true);
    expect(onRetry).toHaveBeenCalledWith(HALTED_NOSHIP.message);
  });

  it("does NOT show 'Try again' while a run is in flight", () => {
    const html = render({ turn: HALTED_NOSHIP, isUndoable: false, onRetry: () => {}, runActive: true });
    expect(html).not.toContain("Try again");
  });
});

describe("RefinePipelineCard — what changed", () => {
  it("renders the message, summary, and changed-files changelog", () => {
    const html = render({ turn: BASE });
    expect(html).toContain("Add a contact email field");
    expect(html).toContain("Added an email input + validation to the signup form.");
    expect(html).toContain("Changed 1 file");
    expect(html).toContain("src/SignupForm.tsx");
    expect(html).toContain("modify");
  });

  it("renders a bare refine (no summary/files/gate/deploy) as just the message + status", () => {
    const html = render({
      turn: {
        ...BASE,
        summary: null,
        files: [],
        gate_evidence: null,
        pr_url: null,
        status: "success",
      },
    });
    expect(html).toContain("Add a contact email field");
    expect(html).toContain("Shipped");
    expect(html).not.toContain("data-gate-state");
    expect(html).not.toContain("data-deploy-state");
    expect(html).not.toContain("Changed");
  });
});
