
import type { ScaleSegment } from "./useBuildProduct";
export type { ScaleSegment };

export type WorkspaceSegment = "fresh_build" | "has_product";

export type GettingStartedCopy = {
  milestones: readonly [string, string, string];
  railLabel: string;
};

export type StackCopy = {
  heading: string;
  showConnectorPush: boolean;
  emptyValueLine: string;
};

export function resolveWorkspaceSegment(
  buildAppIntent: "fresh" | "existing",
): WorkspaceSegment {
  return buildAppIntent === "fresh" ? "fresh_build" : "has_product";
}

const FRESH_BUILD_GETTING_STARTED: GettingStartedCopy = {
  milestones: ["Describe your app", "Build & preview", "Refine it live"],
  railLabel: "Build your app",
};

const FRESH_BUILD_STACK: StackCopy = {
  heading: "Your app",
  showConnectorPush: false,
  emptyValueLine:
    "No product yet. Describe your app above and Zavi will build it, then you can refine it by chat.",
};

type HasProductCopy = { gettingStarted: GettingStartedCopy; stack: StackCopy };

const HAS_PRODUCT_BY_SEGMENT: Record<ScaleSegment | "", HasProductCopy> = {
  pre_revenue: {
    gettingStarted: {
      milestones: ["Connect a data source", "Run a growth agent", "Approve an output"],
      railLabel: "Get your first customers",
    },
    stack: {
      heading: "Connectors",
      showConnectorPush: true,
      emptyValueLine:
        "Connect your ads + Slack so the demand engine can start finding your first customers.",
    },
  },
  early: {
    gettingStarted: {
      milestones: ["Connect a data source", "Run a growth agent", "Approve an output"],
      railLabel: "Grow toward your first $1M",
    },
    stack: {
      heading: "Connectors",
      showConnectorPush: true,
      emptyValueLine:
        "Connect your ads, analytics + Slack so the demand engine can drive your 0→$1M growth.",
    },
  },
  scaling: {
    gettingStarted: {
      milestones: ["Connect your ops data", "Run an ops agent", "Approve an output"],
      railLabel: "Run your ops without hiring",
    },
    stack: {
      heading: "Connectors",
      showConnectorPush: true,
      emptyValueLine:
        "Connect Stripe, your ads + Slack so support, finance + ads-optimization agents can run your ops.",
    },
  },
  mature: {
    gettingStarted: {
      milestones: ["Set approval policies", "Connect a function", "Review the audit log"],
      railLabel: "Give your team superpowers, safely",
    },
    stack: {
      heading: "Connectors",
      showConnectorPush: true,
      emptyValueLine:
        "Connect a function under approval gates. Every agent action is logged + reviewable. Start with the controls.",
    },
  },
  "": {
    gettingStarted: {
      milestones: ["Connect a data source", "Run an agent", "Approve an output"],
      railLabel: "Getting started",
    },
    stack: {
      heading: "Connectors",
      showConnectorPush: true,
      emptyValueLine: "Connect Slack or GitHub to unlock more agents.",
    },
  },
};

export function gettingStartedCopy(
  buildAppIntent: "fresh" | "existing",
  segment: ScaleSegment | "",
): GettingStartedCopy {
  if (resolveWorkspaceSegment(buildAppIntent) === "fresh_build") {
    return FRESH_BUILD_GETTING_STARTED;
  }
  return HAS_PRODUCT_BY_SEGMENT[segment].gettingStarted;
}

export function stackCopy(
  buildAppIntent: "fresh" | "existing",
  segment: ScaleSegment | "",
): StackCopy {
  if (resolveWorkspaceSegment(buildAppIntent) === "fresh_build") {
    return FRESH_BUILD_STACK;
  }
  return HAS_PRODUCT_BY_SEGMENT[segment].stack;
}
