import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/agents/runner", () => ({
  enqueueAgentRun: vi.fn(),
}));
const stoppedSlugs = vi.hoisted(() => new Set<string>());
vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async (_t: string, slug: string) => stoppedSlugs.has(slug) }));
vi.mock("@/services/channels/budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/channels/budget")>()),
  channelBudgetAllows: async () => ({ allowed: true }),
}));
const siteCheck = vi.hoisted(() => ({ calls: [] as Array<{ ctx: Record<string, unknown>; args: unknown }> }));
vi.mock("@/services/start-card/site-check-tool", () => ({
  runSiteCheck: vi.fn(async (ctx: Record<string, unknown>, args: unknown) => {
    siteCheck.calls.push({ ctx, args });
    return { status: "pending", domain: "vercel.com", card_url: "https://x/r/P", credits_reserved: 195, message: "m" };
  }),
}));
const tierState = vi.hoisted(() => ({
  decision: { enforced: false, tier: "free", required_tier: "free", allowed: true } as Record<string, unknown>,
  throws: false,
  calls: [] as Array<Record<string, unknown> | undefined>,
}));
vi.mock("@/services/agents/entitlement", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/entitlement")>()),
  checkAgentTier: async (_t: string, _s: string, opts?: Record<string, unknown>) => {
    tierState.calls.push(opts);
    if (tierState.throws) throw new Error("db down");
    return tierState.decision;
  },
}));
vi.mock("@/services/agents/visibility", () => ({
  getVisibleAgentSlugs: vi.fn(),
}));
vi.mock("@/services/decisions/operator-action-execute", () => ({
  executeOperatorAction: vi.fn(),
}));
vi.mock("@/agents/engineer/decompose", () => ({
  decomposeMessage: vi.fn(),
}));
const repoIsEmptyMock = vi.hoisted(() => vi.fn(async (_a: unknown): Promise<boolean> => false));
vi.mock("@/services/connectors/github/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/connectors/github/oauth")>()),
  repoIsEmpty: repoIsEmptyMock,
}));
vi.mock("@/services/sandbox/repo-picker", () => ({
  pickRepoForTask: vi.fn(),
}));
vi.mock("@/services/sandbox/repo-access-gate", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/services/sandbox/repo-access-gate")
  >()),
  isUmbrellaProvisionedTenant: vi.fn().mockResolvedValue(false),
  checkSandboxRepoAccess: vi.fn().mockResolvedValue("ok"),
}));
vi.mock("@/services/agents/start-product-build", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/agents/start-product-build")>();
  return { ...actual, startProductBuild: vi.fn() };
});
const heavyState = vi.hoisted(() => ({
  confirmOn: true,
  armed: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/services/agents/heavy-dispatch-confirm-flag", () => ({
  isHeavyDispatchConfirmEnabled: async () => heavyState.confirmOn,
}));
vi.mock("@/services/agents/heavy-dispatch-pending", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/heavy-dispatch-pending")>()),
  armHeavyDispatchPending: async (p: Record<string, unknown>) => {
    heavyState.armed.push(p);
    return { nonce: "n1", ...p };
  },
}));
vi.mock("@/agents/engineer/product-builder-flag", () => ({
  isProductBuilderEnabled: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/services/agents/conductor-kick", () => ({
  requestConductorTick: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/agents/refine-product", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/agents/refine-product")>();
  return { ...actual, refineProduct: vi.fn() };
});
vi.mock("@/services/agents/schedules", () => ({
  getSchedule: vi.fn(),
}));
vi.mock("@/services/logging/logEvent", () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  LOG_META_KEYS: ["agent_slug"],
}));
vi.mock("@/services/agents/pm-interactive-handoff-flag", () => ({
  isPmInteractiveHandoffEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/services/agents/_render-launch-video-flag-check", () => ({
  isRenderLaunchVideoEnabled: vi.fn().mockResolvedValue(true),
  isGenerativeVideoEnabled: vi.fn().mockResolvedValue(true),
}));
const videoBlock = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock("@/services/launch-video/video-block", () => ({
  channelVideoBlock: async () => videoBlock.reason,
}));

const batchInserts: Array<Record<string, unknown>> = [];
const lineageInserts: Array<Record<string, unknown>> = [];
let batchInsertError: { message: string } | null = null;
let lineageStats: { max_depth: number; target_slugs: string[]; cumulative_cost: number } = {
  max_depth: 0,
  target_slugs: [],
  cumulative_cost: 0,
};
let lineageStatsError: { message: string } | null = null;
let parentRunPayload: Record<string, unknown> = {};
let agentRunsReadFails = false;
const runUpdates: Array<Record<string, unknown>> = [];
let connectedReposFixture: string[] = [];
let threadRepoFixture: string | null = null;
let latestUserMessageFixture: { body: string; attachments: unknown } | null = null;
let existingPendingBatch: { batch_id: string; child_run_ids: string[] } | null = null;
let claimHandoffBatchReturn: string | null = "claimed-id";
let tenantRoleFixture: string | null = "owner";
let firstBuildFreeFixture: boolean | "error" = false;
let tenantDisplayNameFixture: string | null = null;
const rpcCalls: string[] = [];
let urlGroundingSources: { productHosts: string[]; userTexts: string[] } = {
  productHosts: ["upcar.ai"],
  userTexts: [],
};
let urlGroundingLoadError: Error | null = null;
vi.mock("@/services/launch-video/url-grounding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/launch-video/url-grounding")>()),
  loadUrlGroundingSources: async () => {
    if (urlGroundingLoadError) throw urlGroundingLoadError;
    return urlGroundingSources;
  },
}));
const customRunMock = vi.hoisted(() => ({
  resolve: vi.fn(async (): Promise<Record<string, unknown>> => ({ state: "not_custom" })),
  registerCalls: [] as Array<Record<string, unknown>>,
  registerReturn: true as boolean,
}));
vi.mock("@/services/agents/custom-agent-writes", () => ({
  resolveCustomWriteRun: (...a: unknown[]) => customRunMock.resolve(...(a as [])),
}));
const handToHumanMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/services/agents/custom-agent-decisions", () => ({
  handCustomDecisionToHuman: (...a: unknown[]) => handToHumanMock(...(a as [])),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async (fn: string, _args: unknown) => {
      rpcCalls.push(fn);
      if (fn === "first_build_free_eligible") {
        return firstBuildFreeFixture === "error"
          ? { data: null, error: { message: "rpc down" } }
          : { data: firstBuildFreeFixture, error: null };
      }
      if (fn === "custom_agent_handoff_register") {
        customRunMock.registerCalls.push(_args as Record<string, unknown>);
        return { data: customRunMock.registerReturn, error: null };
      }
      if (fn === "claim_handoff_batch") {
        return { data: claimHandoffBatchReturn, error: null };
      }
      if (fn === "tick_enrichment_rate_limit") {
        return { data: true, error: null };
      }
      return lineageStatsError
        ? { data: null, error: lineageStatsError }
        : { data: [lineageStats], error: null };
    },
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        if (table === "delegation_lineage") {
          lineageInserts.push(row);
          return { error: null };
        }
        batchInserts.push(row);
        return { error: batchInsertError };
      },
      select: (_c?: string) => {
        const builder: {
          eq: (k: string, v: unknown) => typeof builder;
          order: (k: string, o?: unknown) => typeof builder;
          limit: (n: number) => typeof builder;
          maybeSingle: () => Promise<{ data: unknown; error: null }>;
        } = {
          eq: (_k: string, _v: unknown) => builder,
          order: () => builder,
          limit: () => builder,
          maybeSingle: async () => {
            if (table === "agent_thread_messages") {
              return { data: latestUserMessageFixture, error: null };
            }
            if (table === "connector_metadata") {
              return { data: { repo_full_names: connectedReposFixture }, error: null };
            }
            if (table === "handoff_batches") {
              return { data: existingPendingBatch, error: null };
            }
            if (table === "agent_threads") {
              return { data: { repo_full_name: threadRepoFixture }, error: null };
            }
            if (table === "tenant_users") {
              return { data: tenantRoleFixture === null ? null : { role: tenantRoleFixture }, error: null };
            }
            if (table === "tenants") {
              return { data: { display_name: tenantDisplayNameFixture }, error: null };
            }
            if (agentRunsReadFails) return { data: null, error: { message: "read failed" } } as never;
            return { data: { payload: parentRunPayload }, error: null };
          },
        };
        return builder;
      },
      update: (row: Record<string, unknown>) => ({
        eq: (_k: string, _v: string) => ({
          eq: async (_k2: string, _v2: string) => {
            runUpdates.push(row);
            return { error: null };
          },
          then: (resolve: (v: { error: null }) => void) => {
            runUpdates.push(row);
            resolve({ error: null });
          },
        }),
      }),
    }),
  }),
}));
const sentEvents: Array<{ name: string; data: unknown }> = [];
let joinSendShouldThrow = false;
vi.mock("../../../../../workers/client", () => ({
  inngest: {
    send: async (e: { name: string; data: unknown }) => {
      if (joinSendShouldThrow) throw new Error("inngest send boom");
      sentEvents.push(e);
      return { ids: ["evt-1"] };
    },
  },
}));

import { extractUserMessageFromPayload } from "@/services/agents/post-text-trust-guard";
import { callPraxisTool, listPraxisTools } from "../praxis";
import { enqueueAgentRun } from "@/services/agents/runner";
import { getVisibleAgentSlugs } from "@/services/agents/visibility";
import { isUmbrellaProvisionedTenant, checkSandboxRepoAccess } from "@/services/sandbox/repo-access-gate";
import {
  startProductBuild,
  DoubleBuildInFlight,
  BuildRepoNotProvisioned,
  SiteSetupUnavailable,
  SiteBackendUnavailable,
  BUILD_REPO_NOT_PROVISIONED_COPY,
  SITE_SETUP_UNAVAILABLE_COPY,
} from "@/services/agents/start-product-build";
import { requiredBuildCredits } from "@/services/agents/build-credit-preflight";
import { reserveEstimateFor } from "@/services/agents/credits";
import { isProductBuilderEnabled } from "@/agents/engineer/product-builder-flag";
import { requestConductorTick } from "@/services/agents/conductor-kick";
import { refineProduct, NoProvisionedRepo, OldSiteFrozen } from "@/services/agents/refine-product";
import { OLD_SITE_FROZEN_MESSAGE } from "@/services/sites/old-site-freeze";
import { InsufficientCreditsForBuild } from "@/services/agents/build-credit-preflight";
import { executeOperatorAction } from "@/services/decisions/operator-action-execute";
import { decomposeMessage } from "@/agents/engineer/decompose";
import { pickRepoForTask } from "@/services/sandbox/repo-picker";
import { getSchedule } from "@/services/agents/schedules";
import { isPmInteractiveHandoffEnabled } from "@/services/agents/pm-interactive-handoff-flag";
import { isRenderLaunchVideoEnabled } from "@/services/agents/_render-launch-video-flag-check";

const pmFlagMock = isPmInteractiveHandoffEnabled as unknown as ReturnType<typeof vi.fn>;
const renderVideoFlagMock = isRenderLaunchVideoEnabled as unknown as ReturnType<typeof vi.fn>;

describe("listPraxisTools — JSON Schema generation (regression for PR #127 prod crash)", () => {
  it("does not throw and returns one entry per declared tool", () => {
    expect(() => listPraxisTools()).not.toThrow();
    const tools = listPraxisTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.server_id).toBe("praxis");
      expect(typeof t.tool_name).toBe("string");
      expect(t.input_schema.type).toBe("object");
    }
  });
  it("includes both handoff and action with valid input_schema", () => {
    const tools = listPraxisTools();
    const handoff = tools.find((t) => t.tool_name === "handoff");
    const action = tools.find((t) => t.tool_name === "action");
    expect(handoff).toBeDefined();
    expect(action).toBeDefined();
    const actionSchema = action!.input_schema as unknown as {
      type: string;
      properties: Record<string, { enum?: string[] }>;
      required?: string[];
      oneOf?: unknown[];
    };
    expect(actionSchema.type).toBe("object");
    expect(actionSchema.oneOf).toBeUndefined();
    expect(actionSchema.properties.verb.enum).toEqual([
      "file-jira-issue",
      "file-linear-issue",
      "post-slack-message",
    ]);
    expect(actionSchema.required).toEqual(["verb"]);
  });
});

const enqueueMock = enqueueAgentRun as unknown as ReturnType<typeof vi.fn>;
const visibleMock = getVisibleAgentSlugs as unknown as ReturnType<typeof vi.fn>;

const baseCtx = {
  tenant_id: "t1",
  agent_slug: "operator",
  trigger: "chat",
  chat_thread_id: "th1",
  user_id: "u1",
};
const baseArgs = {
  target_agent_slug: "pm",
  intent: "file a SCRUM about the refresh-on-401 bug",
};

function parseContent(s: string): Record<string, unknown> {
  return JSON.parse(s) as Record<string, unknown>;
}

describe("callPraxisTool — handoff", () => {
  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(
      new Set(["operator", "pm", "engineer", "dispute-response"]),
    );
    enqueueMock.mockResolvedValue({ run_id: "r-new-1" });
    lineageInserts.length = 0;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    lineageStatsError = null;
    parentRunPayload = {};
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: enqueues handoff with correct payload + returns run_id", async () => {
    const res = await callPraxisTool(baseCtx, "handoff", baseArgs);
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.tenant_id).toBe("t1");
    expect(enqArg.agent_slug).toBe("pm");
    expect(enqArg.trigger).toBe("handoff");
    expect(enqArg.payload.operator_thread_id).toBe("th1");
    expect(enqArg.payload.intent).toBe(baseArgs.intent);
    expect(enqArg.payload.user_id).toBe("u1");
    const body = parseContent(res.content);
    expect(body.run_id).toBe("r-new-1");
    expect(body.target).toBe("pm");
  });

  it("enqueues a handoff to a visible `fundraising` target", async () => {
    visibleMock.mockResolvedValue(
      new Set(["operator", "pm", "fundraising"]),
    );
    const res = await callPraxisTool(baseCtx, "handoff", {
      ...baseArgs,
      target_agent_slug: "fundraising",
    });
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.agent_slug).toBe("fundraising");
    expect(enqArg.trigger).toBe("handoff");
    expect(parseContent(res.content).target).toBe("fundraising");
  });

  it("staff-console origin blocks handoff (no enqueue)", async () => {
    parentRunPayload = { origin: "staff_console" };
    const res = await callPraxisTool({ ...baseCtx, run_id: "op-run-staff" }, "handoff", baseArgs);
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_disabled_staff_console");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("staff-console origin blocks handoff_parallel (no enqueue)", async () => {
    parentRunPayload = { origin: "staff_console" };
    const res = await callPraxisTool({ ...baseCtx, run_id: "op-run-staff" }, "handoff_parallel", {
      targets: [{ target_agent_slug: "pm", intent: "x" }],
    });
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_disabled_staff_console");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("tool_unknown: only 'handoff' is registered", async () => {
    const res = await callPraxisTool(baseCtx, "nope", {});
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("tool_unknown");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("caller-identity gate: non-operator agent_slug rejected (codex C-P2-3)", async () => {
    const res = await callPraxisTool(
      { ...baseCtx, agent_slug: "engineer" },
      "handoff",
      baseArgs,
    );
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("caller-identity gate: non-chat trigger rejected", async () => {
    const res = await callPraxisTool(
      { ...baseCtx, trigger: "cron" },
      "handoff",
      baseArgs,
    );
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
  });

  it("caller-identity gate: missing user_id rejected", async () => {
    const res = await callPraxisTool(
      { ...baseCtx, user_id: undefined },
      "handoff",
      baseArgs,
    );
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
  });

  it("missing chat_thread_id → distinct handoff_no_thread (codex regression R2)", async () => {
    const res = await callPraxisTool(
      { ...baseCtx, chat_thread_id: undefined },
      "handoff",
      baseArgs,
    );
    expect(parseContent(res.content).error).toBe("handoff_no_thread");
  });

  it("self-loop: target=operator rejected", async () => {
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "operator",
      intent: "anything",
    });
    expect(parseContent(res.content).error).toBe("handoff_self_loop");
  });

  it("hidden target: rejected with visible list in message", async () => {
    visibleMock.mockResolvedValueOnce(new Set(["operator", "engineer"]));
    const res = await callPraxisTool(baseCtx, "handoff", baseArgs);
    const body = parseContent(res.content);
    expect(body.error).toBe("handoff_target_invalid");
    expect(String(body.message)).toContain("engineer");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("intent > 8000 chars rejected by zod", async () => {
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "x".repeat(9000),
    });
    expect(parseContent(res.content).error).toBe("input_invalid");
  });
});

describe("callPraxisTool — handoff from Slack surface (Phase 2)", () => {
  const slackCtx = {
    tenant_id: "t1",
    run_id: "op-run-slack",
    agent_slug: "operator",
    trigger: "slack",
    slack_routing: {
      channel_id: "C123",
      thread_ts: "1700.1",
      original_ts: "1700.1",
      event_id: "Ev123",
    },
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "engineer", "pm"]));
    enqueueMock.mockResolvedValue({ run_id: "child-1" });
    runUpdates.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("slack handoff: child enqueued trigger='slack' + payload.slack, NO operator_thread_id", async () => {
    const res = await callPraxisTool(slackCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "debug trip 10927",
    });
    expect(res.ok).toBe(true);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.agent_slug).toBe("engineer");
    expect(enqArg.trigger).toBe("slack");
    expect(enqArg.payload.slack).toEqual(slackCtx.slack_routing);
    expect(enqArg.payload.operator_thread_id).toBeUndefined();
    expect(enqArg.payload.source).toBe("slack");
    expect(enqArg.payload.slack_handoff_child).toBe(true);
  });

  it("provenance: attaches current_user_text_raw resolved from the PARENT run payload", async () => {
    parentRunPayload = {
      slack: { text: "we can pay them maybe like $50 and the other Host gets a one month trial" },
    };
    const res = await callPraxisTool(slackCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "AGENT-AUTHORED brief that adds constraints the user never stated",
    });
    expect(res.ok).toBe(true);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.payload.current_user_text_raw).toBe(
      "we can pay them maybe like $50 and the other Host gets a one month trial",
    );
    expect(enqArg.payload.intent).toContain("AGENT-AUTHORED");
  });

  it("provenance: the child payload now yields the USER's words, not the agent's brief", async () => {
    parentRunPayload = { slack: { text: "the real user request" } };
    await callPraxisTool(slackCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "the agent's invented framing",
    });
    const childPayload = enqueueMock.mock.calls[0][0].payload;
    expect(extractUserMessageFromPayload(childPayload)).toBe("the real user request");
  });

  it("provenance: key is ABSENT (not empty) when the parent has no human text", async () => {
    parentRunPayload = {};
    await callPraxisTool(slackCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "scheduled sweep",
    });
    const childPayload = enqueueMock.mock.calls[0][0].payload;
    expect("current_user_text_raw" in childPayload).toBe(false);
  });

  it("slack handoff: sets slack_reply_delegated on the parent operator run before enqueue", async () => {
    enqueueMock.mockImplementationOnce(async () => {
      expect(runUpdates.length).toBe(1);
      expect((runUpdates[0].payload as Record<string, unknown>).slack_reply_delegated).toBe(
        true,
      );
      return { run_id: "child-1" };
    });
    await callPraxisTool(slackCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "debug trip 10927",
    });
    expect(runUpdates.length).toBe(1);
    expect((runUpdates[0].payload as Record<string, unknown>).slack_reply_delegated).toBe(true);
  });

  it("slack handoff without slack_routing → handoff_no_thread (not authorized-vs-thread distinction preserved)", async () => {
    const noRouting = { ...slackCtx, slack_routing: undefined };
    const res = await callPraxisTool(noRouting, "handoff", {
      target_agent_slug: "engineer",
      intent: "x",
    });
    expect(parseContent(res.content).error).toBe("handoff_no_thread");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("non-operator from slack → handoff_not_authorized", async () => {
    const res = await callPraxisTool(
      { ...slackCtx, agent_slug: "engineer" },
      "handoff",
      { target_agent_slug: "pm", intent: "x" },
    );
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("handoff_parallel from slack → handoff_parallel_slack_unsupported (deferred)", async () => {
    const res = await callPraxisTool({ ...slackCtx }, "handoff_parallel", {
      targets: [
        { target_agent_slug: "engineer", intent: "a" },
        { target_agent_slug: "pm", intent: "b" },
      ],
    });
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_parallel_slack_unsupported");
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("callPraxisTool — handoff from MCP surface (zavi_ask front-door)", () => {
  const mcpCtx = {
    tenant_id: "t1",
    run_id: "op-run-mcp",
    agent_slug: "operator",
    trigger: "mcp",
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "engineer", "pm"]));
    enqueueMock.mockResolvedValue({ run_id: "child-mcp-1" });
    runUpdates.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mcp handoff: child enqueued trigger='mcp' + intent, NO slack/operator_thread_id", async () => {
    const res = await callPraxisTool(mcpCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "debug trip 10927",
    });
    expect(res.ok).toBe(true);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.agent_slug).toBe("engineer");
    expect(enqArg.trigger).toBe("mcp");
    expect(enqArg.payload.intent).toBe("debug trip 10927");
    expect(enqArg.payload.source).toBe("mcp");
    expect(enqArg.payload.slack).toBeUndefined();
    expect(enqArg.payload.operator_thread_id).toBeUndefined();
  });

  it("mcp handoff: records delegated_child_run_id on the parent operator run (poll-follow link)", async () => {
    await callPraxisTool(mcpCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "debug trip 10927",
    });
    expect(runUpdates.length).toBe(1);
    expect((runUpdates[0].payload as Record<string, unknown>).delegated_child_run_id).toBe("child-mcp-1");
  });

  it("non-operator from mcp → handoff_not_authorized", async () => {
    const res = await callPraxisTool(
      { ...mcpCtx, agent_slug: "engineer" },
      "handoff",
      { target_agent_slug: "pm", intent: "x" },
    );
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("handoff_parallel from mcp → unsupported (deferred, same as slack)", async () => {
    const res = await callPraxisTool(mcpCtx, "handoff_parallel", {
      targets: [
        { target_agent_slug: "engineer", intent: "a" },
        { target_agent_slug: "pm", intent: "b" },
      ],
    });
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_parallel_slack_unsupported");
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("callPraxisTool — handoff_parallel (slice 8)", () => {
  const parallelCtx = { ...baseCtx, run_id: "op-run-1" };
  const parallelArgs = {
    targets: [
      { target_agent_slug: "engineer", intent: "investigate the 404" },
      { target_agent_slug: "pm", intent: "rice-rank the fix" },
    ],
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(
      new Set(["operator", "pm", "engineer", "dispute-response"]),
    );
    let n = 0;
    enqueueMock.mockImplementation(async () => ({ run_id: `child-${++n}` }));
    batchInserts.length = 0;
    batchInsertError = null;
    sentEvents.length = 0;
    lineageInserts.length = 0;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    lineageStatsError = null;
    parentRunPayload = {};
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: enqueues N children w/ batch_id, inserts batch row, fires join event", async () => {
    const res = await callPraxisTool(parallelCtx, "handoff_parallel", parallelArgs);
    expect(res.ok).toBe(true);
    const body = parseContent(res.content);
    expect(body.batch_id).toBeTruthy();
    expect(body.run_ids).toEqual(["child-1", "child-2"]);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    const p0 = enqueueMock.mock.calls[0][0].payload;
    const p1 = enqueueMock.mock.calls[1][0].payload;
    expect(p0.handoff_batch_id).toBe(body.batch_id);
    expect(p1.handoff_batch_id).toBe(body.batch_id);
    expect(batchInserts).toHaveLength(1);
    expect(batchInserts[0].batch_id).toBe(body.batch_id);
    expect(batchInserts[0].parent_run_id).toBe("op-run-1");
    expect(batchInserts[0].child_run_ids).toEqual(["child-1", "child-2"]);
    expect(batchInserts[0].status).toBe("pending");
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0].name).toBe("handoff.batch.join.requested");
    expect((sentEvents[0].data as { batch_id: string }).batch_id).toBe(body.batch_id);
  });

  it("a channel the founder stopped is dropped from the batch; the rest start (Growth J6)", async () => {
    visibleMock.mockResolvedValue(new Set(["operator", "pm", "engineer", "seo"]));
    stoppedSlugs.add("seo");
    try {
      const res = await callPraxisTool(parallelCtx, "handoff_parallel", {
        targets: [
          { target_agent_slug: "seo", intent: "audit the site" },
          { target_agent_slug: "pm", intent: "rice-rank the fix" },
        ],
      });
      expect(enqueueMock).toHaveBeenCalledTimes(1);
      expect(enqueueMock.mock.calls[0][0].agent_slug).toBe("pm");
      expect(parseContent(res.content).run_ids).toEqual(["child-1"]);

      enqueueMock.mockClear();
      const all = await callPraxisTool(parallelCtx, "handoff_parallel", {
        targets: [{ target_agent_slug: "seo", intent: "audit the site" }],
      });
      expect(parseContent(all.content).error).toBe("channel_stopped");
      expect(enqueueMock).not.toHaveBeenCalled();
    } finally {
      stoppedSlugs.clear();
    }
  });

  it("caller-identity gate applies (non-operator rejected)", async () => {
    const res = await callPraxisTool(
      { ...parallelCtx, agent_slug: "engineer" },
      "handoff_parallel",
      parallelArgs,
    );
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("missing thread → handoff_no_thread", async () => {
    const res = await callPraxisTool(
      { ...parallelCtx, chat_thread_id: undefined },
      "handoff_parallel",
      parallelArgs,
    );
    expect(parseContent(res.content).error).toBe("handoff_no_thread");
  });

  it("self-loop in any target rejected before any enqueue", async () => {
    const res = await callPraxisTool(parallelCtx, "handoff_parallel", {
      targets: [
        { target_agent_slug: "engineer", intent: "ok" },
        { target_agent_slug: "operator", intent: "loop" },
      ],
    });
    expect(parseContent(res.content).error).toBe("handoff_self_loop");
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(batchInserts).toHaveLength(0);
  });

  it("hidden target rejected before any enqueue", async () => {
    visibleMock.mockResolvedValueOnce(new Set(["operator", "engineer"]));
    const res = await callPraxisTool(parallelCtx, "handoff_parallel", parallelArgs);
    expect(parseContent(res.content).error).toBe("handoff_target_invalid");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("cap: >5 targets rejected by zod", async () => {
    const res = await callPraxisTool(parallelCtx, "handoff_parallel", {
      targets: Array.from({ length: 6 }, (_, i) => ({
        target_agent_slug: "engineer",
        intent: `t${i}`,
      })),
    });
    expect(parseContent(res.content).error).toBe("input_invalid");
  });

  it("empty targets rejected by zod", async () => {
    const res = await callPraxisTool(parallelCtx, "handoff_parallel", { targets: [] });
    expect(parseContent(res.content).error).toBe("input_invalid");
  });

  it("batch row persist failure surfaces handoff_batch_persist_failed", async () => {
    batchInsertError = { message: "insert boom" };
    const res = await callPraxisTool(parallelCtx, "handoff_parallel", parallelArgs);
    expect(parseContent(res.content).error).toBe("handoff_batch_persist_failed");
    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(sentEvents).toHaveLength(0);
  });
});

const LINEAGE_ID_KEY = "_delegation_lineage_id";
const LINEAGE_DEPTH_KEY = "_delegation_depth";

describe("callPraxisTool — handoff delegation guard (Gap 2)", () => {
  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(
      new Set(["operator", "pm", "engineer", "qa", "performance-marketer"]),
    );
    enqueueMock.mockResolvedValue({ run_id: "child-guarded" });
    lineageInserts.length = 0;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    lineageStatsError = null;
    parentRunPayload = {};
    batchInserts.length = 0;
    batchInsertError = null;
    sentEvents.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ROOT operator turn: stamps a fresh lineage (depth 1) on the child + records the edge", async () => {
    const res = await callPraxisTool({ ...baseCtx, run_id: "op-run-root" }, "handoff", baseArgs);
    expect(res.ok).toBe(true);
    const payload = enqueueMock.mock.calls[0][0].payload;
    expect(typeof payload[LINEAGE_ID_KEY]).toBe("string");
    expect(payload[LINEAGE_DEPTH_KEY]).toBe(1);
    expect(lineageInserts).toHaveLength(1);
    expect(lineageInserts[0]).toMatchObject({
      depth: 1,
      target_agent_slug: "pm",
      source_agent_slug: "operator",
      child_run_id: "child-guarded",
      lineage_id: payload[LINEAGE_ID_KEY],
    });
  });

  it("CONTINUING tree: a delegated parent (depth N) → child depth N+1, same lineage", async () => {
    parentRunPayload = { [LINEAGE_ID_KEY]: "lin-existing", [LINEAGE_DEPTH_KEY]: 2 };
    lineageStats = { max_depth: 2, target_slugs: ["engineer"], cumulative_cost: 1.5 };
    const res = await callPraxisTool(
      { ...baseCtx, run_id: "op-run-deep" },
      "handoff",
      { target_agent_slug: "qa", intent: "verify the fix" },
    );
    expect(res.ok).toBe(true);
    const payload = enqueueMock.mock.calls[0][0].payload;
    expect(payload[LINEAGE_ID_KEY]).toBe("lin-existing");
    expect(payload[LINEAGE_DEPTH_KEY]).toBe(3);
  });

  it("DEPTH exceeded: a tree at MAX depth refuses the next hop — NO enqueue", async () => {
    parentRunPayload = { [LINEAGE_ID_KEY]: "lin-deep", [LINEAGE_DEPTH_KEY]: 8 };
    lineageStats = { max_depth: 8, target_slugs: [], cumulative_cost: 1 };
    const res = await callPraxisTool(
      { ...baseCtx, run_id: "op-run-deep" },
      "handoff",
      { target_agent_slug: "qa", intent: "x" },
    );
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_depth_exceeded");
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(lineageInserts).toHaveLength(0);
  });

  it("CYCLE: target already in the lineage is refused — NO enqueue", async () => {
    parentRunPayload = { [LINEAGE_ID_KEY]: "lin-cyc", [LINEAGE_DEPTH_KEY]: 2 };
    lineageStats = { max_depth: 2, target_slugs: ["engineer", "qa"], cumulative_cost: 2 };
    const res = await callPraxisTool(
      { ...baseCtx, run_id: "op-run-cyc" },
      "handoff",
      { target_agent_slug: "engineer", intent: "loop back" },
    );
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_cycle_detected");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("COST ceiling: a tree over $25 halts + escalates — NO enqueue", async () => {
    parentRunPayload = { [LINEAGE_ID_KEY]: "lin-rich", [LINEAGE_DEPTH_KEY]: 1 };
    lineageStats = { max_depth: 1, target_slugs: ["engineer"], cumulative_cost: 30 };
    const res = await callPraxisTool(
      { ...baseCtx, run_id: "op-run-rich" },
      "handoff",
      { target_agent_slug: "performance-marketer", intent: "x" },
    );
    expect(res.is_error).toBe(true);
    const body = parseContent(res.content);
    expect(body.error).toBe("handoff_cost_ceiling_exceeded");
    expect(body.escalate).toBe(true);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: lineage stats lookup error refuses the handoff — NO enqueue", async () => {
    parentRunPayload = { [LINEAGE_ID_KEY]: "lin-x", [LINEAGE_DEPTH_KEY]: 2 };
    lineageStatsError = { message: "db down" };
    const res = await callPraxisTool(
      { ...baseCtx, run_id: "op-run-x" },
      "handoff",
      { target_agent_slug: "qa", intent: "x" },
    );
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_lookup_failed");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a normal ≤5 fan-out off a root turn passes + records N edges, all sharing one lineage", async () => {
    let n = 0;
    enqueueMock.mockImplementation(async () => ({ run_id: `fc-${++n}` }));
    const res = await callPraxisTool({ ...baseCtx, run_id: "op-run-fan" }, "handoff_parallel", {
      targets: [
        { target_agent_slug: "engineer", intent: "a" },
        { target_agent_slug: "qa", intent: "b" },
        { target_agent_slug: "performance-marketer", intent: "c" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(3);
    expect(lineageInserts).toHaveLength(3);
    const ids = new Set(lineageInserts.map((r) => r.lineage_id));
    expect(ids.size).toBe(1);
    for (const edge of lineageInserts) expect(edge.depth).toBe(1);
  });

  it("fan-out is ALL-OR-NOTHING on a depth trip: NO child enqueued", async () => {
    parentRunPayload = { [LINEAGE_ID_KEY]: "lin-deep", [LINEAGE_DEPTH_KEY]: 8 };
    lineageStats = { max_depth: 8, target_slugs: [], cumulative_cost: 1 };
    const res = await callPraxisTool({ ...baseCtx, run_id: "op-run-fan-deep" }, "handoff_parallel", {
      targets: [
        { target_agent_slug: "engineer", intent: "a" },
        { target_agent_slug: "qa", intent: "b" },
      ],
    });
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_depth_exceeded");
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(lineageInserts).toHaveLength(0);
  });
});

const execMock = executeOperatorAction as unknown as ReturnType<typeof vi.fn>;

describe("callPraxisTool — action (direct emit)", () => {
  const emitMock = vi.fn();
  const actionCtx = {
    ...baseCtx,
    emit_decision: emitMock,
  };

  beforeEach(() => {
    emitMock.mockReset();
    emitMock.mockResolvedValue("d-1234");
    execMock.mockReset();
    execMock.mockResolvedValue({ ok: true, status: "race_lost", already_claimed: true });
  });

  it("happy: file-jira-issue renders markdown link from result.url", async () => {
    execMock.mockResolvedValueOnce({
      ok: true,
      status: "executed",
      result: {
        external_key: "SCRUM-4861",
        url: "https://upcar-team.atlassian.net/browse/SCRUM-4861",
      },
    });
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "file-jira-issue",
      project_key: "SCRUM",
      summary: "test direct action",
      description_markdown: "PR #116 smoke",
      issue_type: "Bug",
    });
    expect(res.ok).toBe(true);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0][0]).toBe("operator.file-jira-issue");
    const body = emitMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body.project_key).toBe("SCRUM");
    expect(body.summary).toBe("test direct action");
    expect(body.issue_type).toBe("Bug");
    expect(body.description_markdown).toBe("PR #116 smoke");
    expect((body as { description?: string }).description).toBeUndefined();
    expect((body as { verb?: string }).verb).toBeUndefined();
    expect(execMock).toHaveBeenCalledWith("d-1234");
    const parsed = parseContent(res.content);
    expect(parsed.decision_id).toBe("d-1234");
    expect(parsed.verb).toBe("file-jira-issue");
    expect(String(parsed.message)).toContain(
      "[SCRUM-4861](https://upcar-team.atlassian.net/browse/SCRUM-4861)",
    );
    expect(String(parsed.message).toLowerCase()).not.toContain("assigned");
  });

  it("happy: file-jira-issue without result.url → bare key, no invented domain", async () => {
    execMock.mockResolvedValueOnce({
      ok: true,
      status: "executed",
      result: { external_key: "SCRUM-4861" },
    });
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "file-jira-issue",
      project_key: "SCRUM",
      summary: "x",
      description_markdown: "y",
    });
    const parsed = parseContent(res.content);
    expect(String(parsed.message)).toContain("**SCRUM-4861**");
    expect(String(parsed.message)).not.toContain("atlassian.net");
    expect(String(parsed.message)).not.toContain("hii.");
  });

  it("happy: file-linear-issue emits operator.file-linear-issue", async () => {
    execMock.mockResolvedValueOnce({
      ok: true,
      status: "executed",
      result: { external_key: "ENG-42" },
    });
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "file-linear-issue",
      team_id: "team-uuid-123",
      title: "test",
      description_markdown: "body",
    });
    expect(res.ok).toBe(true);
    expect(emitMock.mock.calls[0][0]).toBe("operator.file-linear-issue");
    const parsed = parseContent(res.content);
    expect(String(parsed.message)).toContain("ENG-42");
  });

  it("happy: post-slack-message emits operator.post-slack-message; thread_ts optional", async () => {
    execMock.mockResolvedValueOnce({
      ok: true,
      status: "executed",
      result: { channel: "C0123ABC", ts: "1700000000.0001" },
    });
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "post-slack-message",
      channel_id: "C0123ABC",
      text: "hi",
    });
    expect(res.ok).toBe(true);
    expect(emitMock.mock.calls[0][0]).toBe("operator.post-slack-message");
    const body = emitMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body.channel_id).toBe("C0123ABC");
    expect(body.thread_ts).toBeUndefined();
    const parsed = parseContent(res.content);
    expect(String(parsed.message)).toContain("1700000000.0001");
  });

  it("dispatch fails → response surfaces decision_id + error context", async () => {
    execMock.mockResolvedValueOnce({
      ok: false,
      status: "failed",
      error: "jira_auth_expired",
    });
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "file-jira-issue",
      project_key: "SCRUM",
      summary: "x",
      description_markdown: "y",
    });
    expect(res.ok).toBe(true);
    const parsed = parseContent(res.content);
    expect(parsed.decision_id).toBe("d-1234");
    expect(parsed.dispatch_error).toBe("jira_auth_expired");
    expect(String(parsed.message)).toContain("jira_auth_expired");
  });

  it("description_markdown round-trips into the decision body verbatim", async () => {
    const longDesc = "## Test plan\n- step 1\n- step 2\n";
    await callPraxisTool(actionCtx, "action", {
      verb: "file-jira-issue",
      project_key: "SCRUM",
      summary: "x",
      description_markdown: longDesc,
    });
    const body = emitMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body.description_markdown).toBe(longDesc);
  });

  it("caller-identity: non-operator agent_slug rejected", async () => {
    const res = await callPraxisTool(
      { ...actionCtx, agent_slug: "engineer" },
      "action",
      { verb: "file-jira-issue", project_key: "SCRUM", summary: "x", description_markdown: "y" },
    );
    expect(parseContent(res.content).error).toBe("praxis_action_not_authorized");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("caller-identity: non-chat trigger rejected", async () => {
    const res = await callPraxisTool(
      { ...actionCtx, trigger: "cron" },
      "action",
      { verb: "file-jira-issue", project_key: "SCRUM", summary: "x", description_markdown: "y" },
    );
    expect(parseContent(res.content).error).toBe("praxis_action_not_authorized");
  });

  it("caller-identity: missing user_id rejected", async () => {
    const res = await callPraxisTool(
      { ...actionCtx, user_id: undefined },
      "action",
      { verb: "file-jira-issue", project_key: "SCRUM", summary: "x", description_markdown: "y" },
    );
    expect(parseContent(res.content).error).toBe("praxis_action_not_authorized");
  });

  it("emit_decision closure missing → fails closed", async () => {
    const res = await callPraxisTool(
      { ...actionCtx, emit_decision: undefined },
      "action",
      { verb: "file-jira-issue", project_key: "SCRUM", summary: "x", description_markdown: "y" },
    );
    expect(parseContent(res.content).error).toBe("praxis_action_not_authorized");
  });

  it("args: file-jira-issue missing summary rejected by superRefine", async () => {
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "file-jira-issue",
      project_key: "SCRUM",
      description_markdown: "body but no summary",
    });
    expect(parseContent(res.content).error).toBe("input_invalid");
    expect(String(parseContent(res.content).message)).toContain("summary required");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("args: file-linear-issue missing team_id rejected by superRefine", async () => {
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "file-linear-issue",
      title: "x",
      description_markdown: "y",
    });
    expect(parseContent(res.content).error).toBe("input_invalid");
    expect(String(parseContent(res.content).message)).toContain("team_id required");
  });

  it("args: post-slack-message missing channel_id rejected by superRefine", async () => {
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "post-slack-message",
      text: "hi",
    });
    expect(parseContent(res.content).error).toBe("input_invalid");
    expect(String(parseContent(res.content).message)).toContain("channel_id required");
  });

  it("args: invalid project_key (lowercase) rejected by zod", async () => {
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "file-jira-issue",
      project_key: "scrum",
      summary: "x",
      description_markdown: "y",
    });
    expect(parseContent(res.content).error).toBe("input_invalid");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("args: invalid Slack channel_id (lowercase) rejected by zod", async () => {
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "post-slack-message",
      channel_id: "general",
      text: "hi",
    });
    expect(parseContent(res.content).error).toBe("input_invalid");
  });

  it("unknown verb rejected by zod enum", async () => {
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "refund-stripe",
      amount: 100,
    });
    expect(parseContent(res.content).error).toBe("input_invalid");
  });

  it("emit_decision throwing propagates as decision_emit_failed", async () => {
    emitMock.mockRejectedValueOnce(new Error("kill_switch active"));
    const res = await callPraxisTool(actionCtx, "action", {
      verb: "file-jira-issue",
      project_key: "SCRUM",
      summary: "x",
      description_markdown: "y",
    });
    const parsed = parseContent(res.content);
    expect(parsed.error).toBe("decision_emit_failed");
    expect(String(parsed.message)).toContain("kill_switch active");
  });
});

describe("callPraxisTool — handoff from email surface (AgentMail D1)", () => {
  const emailCtx = {
    tenant_id: "t1",
    run_id: "op-run-email",
    agent_slug: "operator",
    trigger: "email",
    email_routing: {
      thread_id: "thr-1",
      email_message_id: "msg-1",
      rfc_message_id: "<root@x>",
      from: "host@example.com",
      envelope_to: "operator@acme.inbox.zaviagent.com",
      identity_id: "id-1",
    },
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "engineer", "supply-onboarding"]));
    enqueueMock.mockResolvedValue({ run_id: "child-e1" });
    runUpdates.length = 0;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    lineageStatsError = null;
    parentRunPayload = {};
    batchInsertError = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("email handoff: child enqueued trigger='email' + payload.email, source='email'", async () => {
    const res = await callPraxisTool(emailCtx, "handoff", {
      target_agent_slug: "supply-onboarding",
      intent: "host stuck on KYC",
    });
    expect(res.ok).toBe(true);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.agent_slug).toBe("supply-onboarding");
    expect(enqArg.trigger).toBe("email");
    expect(enqArg.payload.email).toEqual(emailCtx.email_routing);
    expect(enqArg.payload.source).toBe("email");
    expect(enqArg.payload.operator_thread_id).toBeUndefined();
    expect(enqArg.payload.slack).toBeUndefined();
  });

  it("email handoff: sets email_reply_delegated on the parent operator run", async () => {
    await callPraxisTool(emailCtx, "handoff", {
      target_agent_slug: "supply-onboarding",
      intent: "host stuck on KYC",
    });
    expect(runUpdates.length).toBe(1);
    expect((runUpdates[0].payload as Record<string, unknown>).email_reply_delegated).toBe(true);
  });

  it("email handoff without email_routing → handoff_no_thread", async () => {
    const noRouting = { ...emailCtx, email_routing: undefined };
    const res = await callPraxisTool(noRouting, "handoff", {
      target_agent_slug: "supply-onboarding",
      intent: "x",
    });
    expect(parseContent(res.content).error).toBe("handoff_no_thread");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("non-operator from email → handoff_not_authorized", async () => {
    const res = await callPraxisTool(
      { ...emailCtx, agent_slug: "supply-onboarding" },
      "handoff",
      { target_agent_slug: "engineer", intent: "x" },
    );
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("callPraxisTool — propose_dispatch (chief-of-staff Lever 5)", () => {
  const emitMock = vi.fn();
  const cosCtx = {
    tenant_id: "t1",
    agent_slug: "chief-of-staff",
    trigger: "chat",
    chat_thread_id: "th1",
    user_id: "u1",
    emit_decision: emitMock,
  };
  const cosArgs = { target_agent_slug: "dispute-response", intent: "draft evidence for du_1" };

  beforeEach(() => {
    emitMock.mockReset();
    emitMock.mockResolvedValue("dec-cos-1");
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["dispute-response", "support-lead", "qa", "pm"]));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: emits approval-gated dispatch decision, returns pending_approval", async () => {
    const res = await callPraxisTool(cosCtx, "propose_dispatch", cosArgs);
    const body = parseContent(res.content);
    expect(res.is_error).toBe(false);
    expect(emitMock).toHaveBeenCalledWith("chief-of-staff.dispatch-specialist", {
      target_agent_slug: "dispute-response",
      intent: "draft evidence for du_1",
    });
    expect(body.decision_id).toBe("dec-cos-1");
    expect(body.status).toBe("pending_approval");
  });

  it("rejects a non-chief-of-staff caller", async () => {
    const res = await callPraxisTool({ ...cosCtx, agent_slug: "operator" }, "propose_dispatch", cosArgs);
    expect(parseContent(res.content).error).toBe("propose_dispatch_not_authorized");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects a non-chat trigger", async () => {
    const res = await callPraxisTool({ ...cosCtx, trigger: "cron" }, "propose_dispatch", cosArgs);
    expect(parseContent(res.content).error).toBe("propose_dispatch_not_authorized");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects when emit_decision is not wired", async () => {
    const { emit_decision: _omit, ...noEmit } = cosCtx;
    const res = await callPraxisTool(noEmit, "propose_dispatch", cosArgs);
    expect(parseContent(res.content).error).toBe("propose_dispatch_not_authorized");
  });

  it("rejects self / operator targets", async () => {
    const r1 = await callPraxisTool(cosCtx, "propose_dispatch", { target_agent_slug: "chief-of-staff", intent: "x" });
    const r2 = await callPraxisTool(cosCtx, "propose_dispatch", { target_agent_slug: "operator", intent: "x" });
    expect(parseContent(r1.content).error).toBe("target_not_dispatchable");
    expect(parseContent(r2.content).error).toBe("target_not_dispatchable");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects a target not in the visible fleet", async () => {
    const res = await callPraxisTool(cosCtx, "propose_dispatch", { target_agent_slug: "advisor", intent: "x" });
    expect(parseContent(res.content).error).toBe("target_not_visible");
    expect(emitMock).not.toHaveBeenCalled();
  });
});

const decomposeMock = decomposeMessage as unknown as ReturnType<typeof vi.fn>;
const pickRepoMock = pickRepoForTask as unknown as ReturnType<typeof vi.fn>;

describe("callPraxisTool — engineer multi-repo fan-out", () => {
  const engCtx = {
    tenant_id: "t1",
    run_id: "op-run-1",
    agent_slug: "operator",
    trigger: "chat",
    chat_thread_id: "th-eng",
    user_id: "u1",
  };
  const engArgs = {
    target_agent_slug: "engineer",
    intent: "send PRs for iOS and Android and web to add a banner",
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "engineer", "pm"]));
    enqueueMock.mockReset();
    let n = 0;
    enqueueMock.mockImplementation(async () => ({ run_id: `child-${++n}` }));
    decomposeMock.mockReset();
    pickRepoMock.mockReset();
    pickRepoMock.mockResolvedValue({ decision: "pick", repo: "rravi149/OraiCar" });
    batchInserts.length = 0;
    sentEvents.length = 0;
    lineageInserts.length = 0;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    lineageStatsError = null;
    parentRunPayload = {};
    batchInsertError = null;
    connectedReposFixture = [];
    threadRepoFixture = null;
    existingPendingBatch = null;
    joinSendShouldThrow = false;
    claimHandoffBatchReturn = "claimed-id";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("≤1 connected repo → no decompose, falls through to single handoff", async () => {
    connectedReposFixture = ["rravi149/upcar"];
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(decomposeMock).not.toHaveBeenCalled();
    expect(batchInserts).toHaveLength(0);
  });

  it("multi-repo split → fans out one engineer child per platform, posts combined result", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/OraiCarAndroid", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({
      kind: "multi",
      tasks: [
        { title: "iOS: add banner", task_description: "add banner on iOS" },
        { title: "Android: add banner", task_description: "add banner on Android" },
        { title: "Web: add banner", task_description: "add banner on web" },
      ],
    });
    pickRepoMock
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCar" })
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCarAndroid" })
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/upcar" });

    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    const body = parseContent(res.content);
    expect(body.run_ids).toHaveLength(3);
    expect(body.batch_id).toBeTruthy();

    expect(enqueueMock).toHaveBeenCalledTimes(3);
    const hints = enqueueMock.mock.calls.map((c) => c[0].payload.repo_hint).sort();
    expect(hints).toEqual(["rravi149/OraiCar", "rravi149/OraiCarAndroid", "rravi149/upcar"]);
    for (const c of enqueueMock.mock.calls) {
      expect(c[0].agent_slug).toBe("engineer");
      expect(c[0].trigger).toBe("handoff");
      expect(c[0].payload.operator_thread_id).toBe("th-eng");
      expect(c[0].payload.handoff_batch_id).toBe(body.batch_id);
    }
    expect(batchInserts).toHaveLength(1);
    expect(batchInserts[0].operator_thread_id).toBe("th-eng");
    expect(batchInserts[0].child_run_ids).toEqual(["child-1", "child-2", "child-3"]);
    expect(sentEvents.some((e) => e.name === "handoff.batch.join.requested")).toBe(true);
  });

  it("routes the picker on title+description (platform keyword may be in title only) — Grok #2", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/OraiCarAndroid", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({
      kind: "multi",
      tasks: [
        { title: "iOS: add banner", task_description: "add the banner" },
        { title: "Web: add banner", task_description: "add the banner" },
      ],
    });
    pickRepoMock
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCar" })
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/upcar" });
    await callPraxisTool(engCtx, "handoff", engArgs);
    expect(pickRepoMock.mock.calls[0][0].task_description).toContain("iOS: add banner");
    expect(pickRepoMock.mock.calls[1][0].task_description).toContain("Web: add banner");
  });

  it("decompose returns single → single handoff; the single path now picks a repo_hint (P0.d failing-path fix)", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({ kind: "single" });
    pickRepoMock.mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCar" });
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(batchInserts).toHaveLength(0);
    expect(pickRepoMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].payload.repo_hint).toBe("rravi149/OraiCar");
  });

  it("single handoff + picker 'ask' (ambiguous) → repo picker, NOTHING enqueued", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({ kind: "single" });
    pickRepoMock.mockResolvedValueOnce({ decision: "ask", message: "which repo?" });
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
    const body = parseContent(res.content);
    expect(body.needs_repo_pick).toBe(true);
    expect(String(body.message)).toContain("I need a repo to work in. Pick one:");
    expect(String(body.message)).toContain("rravi149/OraiCar");
    expect(body.meta).toEqual({
      awaiting_repo_pick: true,
      repos: ["rravi149/OraiCar", "rravi149/upcar"],
      pending_task_description: engArgs.intent,
    });
  });

  it("the picker result is not a dispatch, and its meta survives into the reply (C2/C3)", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({ kind: "single" });
    pickRepoMock.mockResolvedValueOnce({ decision: "ask", message: "which repo?" });
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    const { repoPickFromToolCalls, reconcileSideEffectClaims } = await import(
      "@/services/agents/side-effect-claim-reconciler"
    );
    const previews = [
      JSON.stringify(res.content),
      JSON.stringify([{ type: "text", text: res.content }]),
    ];
    for (const output_preview of previews) {
      const tool_calls = [{ name: "mcp__server__praxis__handoff", status: "ok", output_preview }];
      expect(repoPickFromToolCalls(tool_calls)).toEqual({
        awaiting_repo_pick: true,
        repos: ["rravi149/OraiCar", "rravi149/upcar"],
        pending_task_description: engArgs.intent,
      });
      const r = reconcileSideEffectClaims(
        { agent_slug: "operator", output_text: "Handed off to the engineer.", parsed: null, tool_calls },
        "rewrite",
      );
      expect(r.mismatch?.claim_type).toBe("dispatch");
      expect(r.corrected).toBe(true);
    }
  });

  it("single handoff + picker THROWS on a multi-repo tenant → repo picker, nothing enqueued", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({ kind: "single" });
    pickRepoMock.mockReset();
    pickRepoMock.mockRejectedValue(new Error("haiku down"));
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(parseContent(res.content).needs_repo_pick).toBe(true);
  });

  it("picked repo is empty, others connected → repo picker without it, NOTHING enqueued", async () => {
    connectedReposFixture = ["acme/empty", "acme/web", "acme/api"];
    decomposeMock.mockResolvedValue({ kind: "single" });
    pickRepoMock.mockResolvedValueOnce({ decision: "pick", repo: "acme/empty" });
    repoIsEmptyMock.mockResolvedValueOnce(true);
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(res.is_error).toBe(false);
    const body = parseContent(res.content);
    expect(body.needs_repo_pick).toBe(true);
    expect(String(body.message)).toContain("acme/empty has no branches yet");
    expect((body.meta as { repos: string[] }).repos).toEqual(["acme/web", "acme/api"]);
  });

  it("the only connected repo is empty → refused with the reason, NOTHING enqueued", async () => {
    connectedReposFixture = ["acme/empty"];
    repoIsEmptyMock.mockResolvedValueOnce(true);
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    const body = parseContent(res.content);
    expect(body.error).toBe("handoff_repo_empty");
    expect(String(body.message)).toContain("acme/empty has no branches yet");
  });

  it("picked repo has commits → handoff proceeds on it", async () => {
    connectedReposFixture = ["acme/web", "acme/api"];
    decomposeMock.mockResolvedValue({ kind: "single" });
    pickRepoMock.mockResolvedValueOnce({ decision: "pick", repo: "acme/web" });
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(repoIsEmptyMock).toHaveBeenCalledWith(expect.objectContaining({ repo_full_name: "acme/web" }));
    expect(enqueueMock.mock.calls[0][0].payload.repo_hint).toBe("acme/web");
  });

  it("exactly ONE connected repo → child carries repo_hint (no longer left for the worker)", async () => {
    connectedReposFixture = ["acme/web"];
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].payload.repo_hint).toBe("acme/web");
    expect(pickRepoMock).not.toHaveBeenCalled();
  });

  it("the thread's sticky repo pick wins over the picker (the user already chose here)", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({ kind: "single" });
    threadRepoFixture = "rravi149/upcar";
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].payload.repo_hint).toBe("rravi149/upcar");
    expect(pickRepoMock).not.toHaveBeenCalled();
  });

  it("a sticky repo that is no longer connected is ignored", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({ kind: "single" });
    threadRepoFixture = "rravi149/removed";
    await callPraxisTool(engCtx, "handoff", engArgs);
    expect(enqueueMock.mock.calls[0][0].payload.repo_hint).toBe("rravi149/OraiCar");
  });

  it("a leftover Praxis-build/* repo is never a candidate for a handoff", async () => {
    connectedReposFixture = ["Praxis-build/old-app-1f02d7f0", "acme/web"];
    decomposeMock.mockResolvedValue({ kind: "single" });
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].payload.repo_hint).toBe("acme/web");
    expect(pickRepoMock).not.toHaveBeenCalled();
  });

  it("ambiguous repo routing (picker 'ask') → aborts fan-out, single handoff (no over-fanout)", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/OraiCarAndroid", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({
      kind: "multi",
      tasks: [
        { title: "iOS: x", task_description: "x on iOS" },
        { title: "Web: x", task_description: "x on web" },
      ],
    });
    pickRepoMock
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCar" })
      .mockResolvedValueOnce({ decision: "ask", message: "which repo?" });
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(batchInserts).toHaveLength(0);
  });

  it("non-engineer target never fans out (decompose not called)", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    const res = await callPraxisTool(engCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "fix iOS and Android and web",
    });
    expect(res.ok).toBe(true);
    expect(decomposeMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("slack surface engineer handoff never fans out (join worker is chat-only)", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    const slackEng = {
      tenant_id: "t1",
      run_id: "op-run-slack",
      agent_slug: "operator",
      trigger: "slack",
      slack_routing: { channel_id: "C1", thread_ts: "1.2", original_ts: "1.2", event_id: "Ev1" },
    };
    const res = await callPraxisTool(slackEng, "handoff", {
      target_agent_slug: "engineer",
      intent: "fix iOS and Android",
    });
    expect(res.ok).toBe(true);
    expect(decomposeMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].trigger).toBe("slack");
  });

  it("missing operator run_id → no fan-out (handoff_batches.parent_run_id is NOT NULL)", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    const res = await callPraxisTool({ ...engCtx, run_id: undefined }, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(decomposeMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("same-run idempotency: existing pending batch is surfaced cheaply, no second fan-out", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/OraiCarAndroid", "rravi149/upcar"];
    existingPendingBatch = { batch_id: "prev-batch", child_run_ids: ["c-a", "c-b"] };
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    const body = parseContent(res.content);
    expect(body.idempotent_retry).toBe(true);
    expect(body.batch_id).toBe("prev-batch");
    expect(decomposeMock).not.toHaveBeenCalled();
    expect(pickRepoMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(batchInserts).toHaveLength(0);
  });

  it("partial enqueue failure: still records the batch with the children that succeeded", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/OraiCarAndroid", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({
      kind: "multi",
      tasks: [
        { title: "iOS: x", task_description: "x ios" },
        { title: "Android: x", task_description: "x android" },
      ],
    });
    pickRepoMock
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCar" })
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCarAndroid" });
    let n = 0;
    enqueueMock.mockImplementation(async () => {
      n++;
      if (n === 2) throw new Error("enqueue boom");
      return { run_id: "child-ok" };
    });
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    const body = parseContent(res.content);
    expect(body.run_ids).toEqual(["child-ok"]);
    expect(batchInserts).toHaveLength(1);
    expect(batchInserts[0].child_run_ids).toEqual(["child-ok"]);
    expect(body.failed_targets).toEqual(["rravi149/OraiCarAndroid"]);
    expect(String(body.message)).toMatch(/could NOT be enqueued/);
  });

  it("multi tasks routed to the SAME repo → not a multi-repo fan-out, single handoff (Codex P2)", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({
      kind: "multi",
      tasks: [
        { title: "fix login", task_description: "fix the login redirect" },
        { title: "add dark mode", task_description: "add a dark-mode toggle" },
      ],
    });
    pickRepoMock
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/upcar" })
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/upcar" });
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(batchInserts).toHaveLength(0);
  });

  it("join event send failure → degrades to individual posts (clears handoff_batch_id), surfaces honestly (Codex P1)", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/OraiCarAndroid", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({
      kind: "multi",
      tasks: [
        { title: "iOS: x", task_description: "x ios" },
        { title: "Android: x", task_description: "x android" },
      ],
    });
    pickRepoMock
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCar" })
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCarAndroid" });
    joinSendShouldThrow = true;
    parentRunPayload = { handoff_batch_id: "some-batch", operator_thread_id: "th-eng" };
    runUpdates.length = 0;
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_batch_join_unfired");
    expect(batchInserts).toHaveLength(1);
    expect(runUpdates.length).toBe(2);
    joinSendShouldThrow = false;
  });

  it("join-send failure but claim LOST → children stay batch-flagged (no duplicate post) — Codex P2 r2", async () => {
    connectedReposFixture = ["rravi149/OraiCar", "rravi149/OraiCarAndroid", "rravi149/upcar"];
    decomposeMock.mockResolvedValue({
      kind: "multi",
      tasks: [
        { title: "iOS: x", task_description: "x ios" },
        { title: "Android: x", task_description: "x android" },
      ],
    });
    pickRepoMock
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCar" })
      .mockResolvedValueOnce({ decision: "pick", repo: "rravi149/OraiCarAndroid" });
    joinSendShouldThrow = true;
    claimHandoffBatchReturn = null;
    parentRunPayload = { handoff_batch_id: "some-batch", operator_thread_id: "th-eng" };
    runUpdates.length = 0;
    const res = await callPraxisTool(engCtx, "handoff", engArgs);
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_batch_join_unfired");
    expect(runUpdates.length).toBe(0);
    joinSendShouldThrow = false;
  });
});

const getScheduleMock = getSchedule as unknown as ReturnType<typeof vi.fn>;

describe("callPraxisTool — propose_standing_order (operator standing orders)", () => {
  const emitMock = vi.fn();
  const opCtx = {
    tenant_id: "t1",
    agent_slug: "operator",
    trigger: "chat",
    chat_thread_id: "11111111-1111-1111-1111-111111111111",
    user_id: "u1",
    emit_decision: emitMock,
  };
  const goodArgs = {
    cron_expression: "0 16 * * 1",
    prompt: "Post stalled approvals + GMV summary",
    destination: "this_thread",
  };

  beforeEach(() => {
    emitMock.mockReset();
    emitMock.mockResolvedValue("dec-so-1");
    getScheduleMock.mockReset();
    getScheduleMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path (chat, this_thread): emits approval-gated decision bound to the SERVER-side thread id", async () => {
    const res = await callPraxisTool(opCtx, "propose_standing_order", goodArgs);
    const body = parseContent(res.content);
    expect(res.is_error).toBe(false);
    expect(body.status).toBe("pending_approval");
    expect(body.decision_id).toBe("dec-so-1");
    expect(body.replaces_existing).toBe(false);
    expect(emitMock).toHaveBeenCalledWith("operator.create-standing-order", {
      cron_expression: "0 16 * * 1",
      standing_order: {
        prompt: "Post stalled approvals + GMV summary",
        deliver: {
          kind: "chat_thread",
          thread_id: "11111111-1111-1111-1111-111111111111",
        },
      },
    });
  });

  it("flags replacement when a schedule row already exists (one per tenant)", async () => {
    getScheduleMock.mockResolvedValue({
      agent_slug: "operator",
      cron_expression: "0 9 * * *",
      enabled: true,
      last_fired_at: null,
      payload_template: {},
    });
    const res = await callPraxisTool(opCtx, "propose_standing_order", goodArgs);
    expect(parseContent(res.content).replaces_existing).toBe(true);
  });

  it("slack_channel destination requires slack_channel_id and rides verbatim", async () => {
    const missing = await callPraxisTool(opCtx, "propose_standing_order", {
      ...goodArgs,
      destination: "slack_channel",
    });
    expect(parseContent(missing.content).error).toBe("input_invalid");
    expect(emitMock).not.toHaveBeenCalled();

    const ok = await callPraxisTool(opCtx, "propose_standing_order", {
      ...goodArgs,
      destination: "slack_channel",
      slack_channel_id: "C0123ABC",
    });
    expect(parseContent(ok.content).status).toBe("pending_approval");
    expect(emitMock).toHaveBeenCalledWith(
      "operator.create-standing-order",
      expect.objectContaining({
        standing_order: expect.objectContaining({
          deliver: { kind: "slack_channel", channel_id: "C0123ABC" },
        }),
      }),
    );
  });

  it("slack-trigger this_thread resolves to the CURRENT slack channel (server-side)", async () => {
    const res = await callPraxisTool(
      {
        ...opCtx,
        trigger: "slack",
        chat_thread_id: undefined,
        slack_routing: {
          channel_id: "C0SLACK1",
          thread_ts: "1.2",
          original_ts: "1.2",
          event_id: "ev1",
        },
      },
      "propose_standing_order",
      goodArgs,
    );
    expect(parseContent(res.content).status).toBe("pending_approval");
    expect(emitMock).toHaveBeenCalledWith(
      "operator.create-standing-order",
      expect.objectContaining({
        standing_order: expect.objectContaining({
          deliver: { kind: "slack_channel", channel_id: "C0SLACK1" },
        }),
      }),
    );
  });

  it("rejects a non-operator caller (gate)", async () => {
    const res = await callPraxisTool(
      { ...opCtx, agent_slug: "chief-of-staff" },
      "propose_standing_order",
      goodArgs,
    );
    expect(parseContent(res.content).error).toBe("propose_standing_order_not_authorized");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects a cron trigger (a scheduled run can never reschedule itself)", async () => {
    const res = await callPraxisTool(
      { ...opCtx, trigger: "cron" },
      "propose_standing_order",
      goodArgs,
    );
    expect(parseContent(res.content).error).toBe("propose_standing_order_not_authorized");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid cron expression", async () => {
    const res = await callPraxisTool(opCtx, "propose_standing_order", {
      ...goodArgs,
      cron_expression: "every monday",
    });
    expect(parseContent(res.content).error).toBe("bad_cron");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects a prompt carrying a secret literal", async () => {
    const res = await callPraxisTool(opCtx, "propose_standing_order", {
      ...goodArgs,
      prompt: "post GMV using key sk-abcdefghijklmnopqrstuvwxyz1234",
    });
    expect(parseContent(res.content).error).toBe("prompt_contains_secret");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects when emit_decision is not wired", async () => {
    const { emit_decision: _omit, ...noEmit } = opCtx;
    const res = await callPraxisTool(noEmit, "propose_standing_order", goodArgs);
    expect(parseContent(res.content).error).toBe("propose_standing_order_not_authorized");
  });
});

describe("callPraxisTool — propose_research_watch (research monitor mode)", () => {
  const emitMock = vi.fn();
  const resCtx = {
    tenant_id: "t1",
    agent_slug: "research",
    trigger: "chat",
    chat_thread_id: "22222222-2222-2222-2222-222222222222",
    user_id: "u1",
    emit_decision: emitMock,
  };
  const goodArgs = {
    cron_expression: "0 16 * * 1",
    prompt: "Watch Turo pricing + plan changes; report only what changed since last week",
    destination: "this_thread",
  };

  beforeEach(() => {
    emitMock.mockReset();
    emitMock.mockResolvedValue("dec-rw-1");
    getScheduleMock.mockReset();
    getScheduleMock.mockResolvedValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path (chat, this_thread): emits research.create-watch bound to the SERVER-side research thread id", async () => {
    const res = await callPraxisTool(resCtx, "propose_research_watch", goodArgs);
    const body = parseContent(res.content);
    expect(res.is_error).toBe(false);
    expect(body.status).toBe("pending_approval");
    expect(body.decision_id).toBe("dec-rw-1");
    expect(body.decision_class).toBe("research.create-watch");
    expect(body.replaces_existing).toBe(false);
    expect(emitMock).toHaveBeenCalledWith("research.create-watch", {
      cron_expression: "0 16 * * 1",
      standing_order: {
        prompt:
          "Watch Turo pricing + plan changes; report only what changed since last week",
        deliver: {
          kind: "chat_thread",
          thread_id: "22222222-2222-2222-2222-222222222222",
        },
      },
    });
  });

  it("checks the EXISTING research schedule row (one watch per tenant) and flags replacement", async () => {
    getScheduleMock.mockResolvedValue({
      agent_slug: "research",
      cron_expression: "0 9 * * 1",
      enabled: true,
      last_fired_at: null,
      payload_template: {},
    });
    const res = await callPraxisTool(resCtx, "propose_research_watch", goodArgs);
    expect(parseContent(res.content).replaces_existing).toBe(true);
    expect(getScheduleMock).toHaveBeenCalledWith("t1", "research");
  });

  it("slack_channel destination requires slack_channel_id and rides verbatim", async () => {
    const missing = await callPraxisTool(resCtx, "propose_research_watch", {
      ...goodArgs,
      destination: "slack_channel",
    });
    expect(parseContent(missing.content).error).toBe("input_invalid");
    expect(emitMock).not.toHaveBeenCalled();

    const ok = await callPraxisTool(resCtx, "propose_research_watch", {
      ...goodArgs,
      destination: "slack_channel",
      slack_channel_id: "C0123ABC",
    });
    expect(parseContent(ok.content).status).toBe("pending_approval");
    expect(emitMock).toHaveBeenCalledWith(
      "research.create-watch",
      expect.objectContaining({
        standing_order: expect.objectContaining({
          deliver: { kind: "slack_channel", channel_id: "C0123ABC" },
        }),
      }),
    );
  });

  it("rejects a non-research caller (operator cannot propose a research watch)", async () => {
    const res = await callPraxisTool(
      { ...resCtx, agent_slug: "operator" },
      "propose_research_watch",
      goodArgs,
    );
    expect(parseContent(res.content).error).toBe(
      "propose_research_watch_not_authorized",
    );
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects a cron trigger (a scheduled watch run can never reschedule itself)", async () => {
    const res = await callPraxisTool(
      { ...resCtx, trigger: "cron", chat_thread_id: undefined },
      "propose_research_watch",
      goodArgs,
    );
    expect(parseContent(res.content).error).toBe(
      "propose_research_watch_not_authorized",
    );
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects a chat turn with no authenticated user", async () => {
    const { user_id: _omit, ...noUser } = resCtx;
    const res = await callPraxisTool(noUser, "propose_research_watch", goodArgs);
    expect(parseContent(res.content).error).toBe(
      "propose_research_watch_not_authorized",
    );
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid cron expression", async () => {
    const res = await callPraxisTool(resCtx, "propose_research_watch", {
      ...goodArgs,
      cron_expression: "every monday",
    });
    expect(parseContent(res.content).error).toBe("bad_cron");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects a prompt carrying a secret literal", async () => {
    const res = await callPraxisTool(resCtx, "propose_research_watch", {
      ...goodArgs,
      prompt: "watch competitor using key sk-abcdefghijklmnopqrstuvwxyz1234",
    });
    expect(parseContent(res.content).error).toBe("prompt_contains_secret");
    expect(emitMock).not.toHaveBeenCalled();
  });

  it("rejects when emit_decision is not wired", async () => {
    const { emit_decision: _omit, ...noEmit } = resCtx;
    const res = await callPraxisTool(noEmit, "propose_research_watch", goodArgs);
    expect(parseContent(res.content).error).toBe(
      "propose_research_watch_not_authorized",
    );
  });

  it("is exposed in listPraxisTools with a research-scoped description", () => {
    const tool = listPraxisTools().find(
      (t) => t.tool_name === "propose_research_watch",
    );
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/research only/i);
    expect(tool?.input_schema.type).toBe("object");
  });
});

describe("callPraxisTool — PM interactive handoff gate (Slice 2)", () => {
  const pmChatCtx = {
    tenant_id: "t1",
    run_id: "pm-run-1",
    agent_slug: "pm",
    trigger: "chat",
    chat_thread_id: "pm-th1",
    user_id: "u-pm",
  };
  const toEngineer = {
    target_agent_slug: "engineer",
    intent: "have the engineer add a /healthz route",
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "pm", "engineer"]));
    enqueueMock.mockResolvedValue({ run_id: "child-eng-1" });
    lineageInserts.length = 0;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    lineageStatsError = null;
    parentRunPayload = {};
    connectedReposFixture = [];
    existingPendingBatch = null;
    pmFlagMock.mockReset();
    pmFlagMock.mockResolvedValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ALLOWS pm + chat + flag ON + target=engineer → enqueues handoff, source_agent_slug=pm", async () => {
    pmFlagMock.mockResolvedValue(true);
    const res = await callPraxisTool(pmChatCtx, "handoff", toEngineer);
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.agent_slug).toBe("engineer");
    expect(enqArg.trigger).toBe("handoff");
    expect(enqArg.payload.operator_thread_id).toBe("pm-th1");
    expect(enqArg.payload.intent).toBe(toEngineer.intent);
    expect(enqArg.payload.source_agent_slug).toBe("pm");
    expect(parseContent(res.content).target).toBe("engineer");
  });

  it("REJECTS pm when flag OFF → handoff_not_authorized, nothing enqueued", async () => {
    pmFlagMock.mockResolvedValue(false);
    const res = await callPraxisTool(pmChatCtx, "handoff", toEngineer);
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("REJECTS pm on the slack surface even with flag ON (chat-only)", async () => {
    pmFlagMock.mockResolvedValue(true);
    const res = await callPraxisTool(
      {
        tenant_id: "t1",
        run_id: "pm-run-slack",
        agent_slug: "pm",
        trigger: "slack",
        slack_routing: {
          channel_id: "C1",
          thread_ts: "1.1",
          original_ts: "1.1",
          event_id: "Ev1",
        },
      },
      "handoff",
      toEngineer,
    );
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("REJECTS pm on the email surface even with flag ON (chat-only)", async () => {
    pmFlagMock.mockResolvedValue(true);
    const res = await callPraxisTool(
      {
        tenant_id: "t1",
        run_id: "pm-run-email",
        agent_slug: "pm",
        trigger: "email",
        email_routing: {
          thread_id: "et1",
          email_message_id: "em1",
          rfc_message_id: null,
          from: "x@y.com",
          envelope_to: "z@y.com",
          identity_id: null,
        },
      },
      "handoff",
      toEngineer,
    );
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("REJECTS pm on the mcp surface even with flag ON (chat-only)", async () => {
    pmFlagMock.mockResolvedValue(true);
    const res = await callPraxisTool(
      { tenant_id: "t1", run_id: "pm-run-mcp", agent_slug: "pm", trigger: "mcp" },
      "handoff",
      toEngineer,
    );
    expect(res.is_error).toBe(true);
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("REJECTS pm + chat + flag ON but target != engineer → handoff_target_invalid", async () => {
    pmFlagMock.mockResolvedValue(true);
    const res = await callPraxisTool(pmChatCtx, "handoff", {
      target_agent_slug: "dispute-response",
      intent: "do a thing",
    });
    expect(res.is_error).toBe(true);
    const body = parseContent(res.content);
    expect(body.error).toBe("handoff_target_invalid");
    expect(String(body.message)).toContain("engineer");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("pm caller does NOT fan out — even with 2+ connected repos (single handoff only)", async () => {
    pmFlagMock.mockResolvedValue(true);
    connectedReposFixture = ["rravi149/a", "rravi149/b"];
    pickRepoMock.mockResolvedValueOnce({ decision: "pick", repo: "rravi149/a" });
    const res = await callPraxisTool(pmChatCtx, "handoff", toEngineer);
    expect(res.ok).toBe(true);
    expect(decomposeMessage).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.agent_slug).toBe("engineer");
    expect(enqArg.trigger).toBe("handoff");
    const body = parseContent(res.content);
    expect(body.batch_id).toBeUndefined();
    expect(body.run_id).toBe("child-eng-1");
  });

  it("operator path is UNCHANGED on every surface (flag irrelevant for operator)", async () => {
    pmFlagMock.mockResolvedValue(true);
    const res = await callPraxisTool(
      {
        tenant_id: "t1",
        agent_slug: "operator",
        trigger: "chat",
        chat_thread_id: "op-th",
        user_id: "u-op",
      },
      "handoff",
      { target_agent_slug: "pm", intent: "rank the backlog" },
    );
    expect(res.ok).toBe(true);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.agent_slug).toBe("pm");
    expect(enqArg.trigger).toBe("handoff");
    expect(enqArg.payload.source_agent_slug).toBe("operator");
    expect(pmFlagMock).not.toHaveBeenCalled();
  });
});

describe("callPraxisTool — render_video alias (P2)", () => {
  const renderCtx = {
    tenant_id: "t1",
    run_id: "op-run-render",
    agent_slug: "operator",
    trigger: "slack" as const,
    slack_routing: {
      channel_id: "C999",
      thread_ts: "1700.9",
      original_ts: "1700.9",
      event_id: "EvRender",
    },
  };
  const intake = {
    product_name: "Upcar",
    one_liner: "Rent the perfect car from local hosts.",
    url: "https://upcar.ai",
    audience: "weekend renters",
    tone: "bold",
    features: [{ title: "Book in two minutes", detail: "Reserve a car near you instantly." }],
    cta_text: "Start your trip",
    cta_url: "https://upcar.ai",
  };

  beforeEach(() => {
    sentEvents.length = 0;
    renderVideoFlagMock.mockResolvedValue(true);
    urlGroundingSources = { productHosts: ["upcar.ai"], userTexts: [] };
    urlGroundingLoadError = null;
  });

  it("REFUSES a CTA url the customer never supplied (upcar.com incident)", async () => {
    urlGroundingSources = {
      productHosts: [],
      userTexts: ["can you generate a video on how Upcar works", "new hosts", "Go and build it"],
    };
    const res = await callPraxisTool(renderCtx, "render_launch_video", {
      ...intake,
      url: "https://upcar.com",
      cta_url: "https://upcar.com",
    });
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("render_launch_video_ungrounded_url");
    expect(res.content).toContain("upcar.com");
    expect(sentEvents.find((e) => e.name === "video.render.requested")).toBeUndefined();
  });

  const ugcScenes = [
    { kind: "broll", prompt: "vlog-style young woman gasps, hand over mouth, then smiles, 9:16", duration_frames: 75 },
    {
      kind: "productui",
      header: { title: "Find a car" },
      items: [{ title: "Book in two minutes", chips: ["Free"] }],
      duration_frames: 375,
    },
  ];

  it("reads a broll scene sent under `prompt` as a paid AI clip and sends it to a priced card, not a chat render", async () => {
    const res = await callPraxisTool(renderCtx, "render_video", { ...intake, scenes: ugcScenes });
    expect(res.is_error).toBe(false);
    const reply = JSON.parse(res.content as string);
    expect(reply.status).toBe("needs_priced_card");
    expect(reply.message).toMatch(/Nothing was charged/);
    expect(reply.next).toMatch(/generative_intent/);
    expect(reply.next).toMatch(/without the AI clip/);
    expect(sentEvents.find((e) => e.name === "video.render.requested")).toBeUndefined();
  });

  it("REFUSES a broll scene with no clip prompt instead of rendering without it", async () => {
    const res = await callPraxisTool(renderCtx, "render_video", {
      ...intake,
      scenes: [{ kind: "broll" }, ugcScenes[1]],
    });
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("video_prompt");
    expect(sentEvents.find((e) => e.name === "video.render.requested")).toBeUndefined();
  });

  it("a bare broll scene filled by the intake-level broll_prompt passes validation and is refused as a paid clip", async () => {
    const res = await callPraxisTool(renderCtx, "render_video", {
      ...intake,
      broll_prompt: "slow dolly past cars at golden hour",
      scenes: [{ kind: "broll" }, ugcScenes[1]],
    });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content as string).status).toBe("needs_priced_card");
    expect(sentEvents.find((e) => e.name === "video.render.requested")).toBeUndefined();
  });

  it("REFUSES a promptless broll hidden in an A/B variant, and sends a prompted A/B broll to a priced card", async () => {
    const bad = await callPraxisTool(renderCtx, "render_video", {
      ...intake,
      scripts: [{ scenes: [{ kind: "broll" }, ugcScenes[1]] }],
    });
    expect(bad.is_error).toBe(true);
    expect(sentEvents.find((e) => e.name === "video.render.requested")).toBeUndefined();
    const clip = await callPraxisTool(renderCtx, "render_video", { ...intake, scripts: [{ scenes: ugcScenes }] });
    expect(clip.is_error).toBe(false);
    expect(JSON.parse(clip.content as string).status).toBe("needs_priced_card");
    expect(sentEvents.find((e) => e.name === "video.render.requested")).toBeUndefined();
  });

  it("A/B motion graphics with no AI clip still render from chat and omit planned_scenes", async () => {
    const res = await callPraxisTool(renderCtx, "render_video", { ...intake, scripts: [{ scenes: [ugcScenes[1]] }] });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content as string).planned_scenes).toBeUndefined();
    expect(sentEvents.filter((e) => e.name === "video.render.requested")).toHaveLength(1);
  });

  it("a blank video_prompt does not hide a real `prompt` alias", async () => {
    const res = await callPraxisTool(renderCtx, "render_video", {
      ...intake,
      scenes: [{ ...ugcScenes[0], video_prompt: "  " }, ugcScenes[1]],
    });
    expect(res.is_error).toBe(false);
    expect(JSON.parse(res.content as string).status).toBe("needs_priced_card");
  });

  it("a testimonial carries no generated b-roll (would read as a customer endorsement)", async () => {
    const res = await callPraxisTool(renderCtx, "render_video", {
      ...intake,
      video_type: "testimonial",
      testimonials: [{ quote: "Booked in two minutes.", attribution: "Maria G.", source: "Google review" }],
      broll_prompt: "a happy customer smiling at the camera holding car keys",
    });
    expect(res.ok).toBe(true);
    const ev = sentEvents.find((e) => e.name === "video.render.requested");
    expect((ev?.data as { intake: { broll_prompt?: string } }).intake.broll_prompt).toBeUndefined();
  });

  it("a testimonial's A/B overlays cannot bring the b-roll back", async () => {
    const res = await callPraxisTool(renderCtx, "render_video", {
      ...intake,
      video_type: "testimonial",
      testimonials: [{ quote: "Booked in two minutes.", attribution: "Maria G.", source: "Google review" }],
      scripts: [{ broll_prompt: "a happy customer smiling", scenes: [{ kind: "broll", video_prompt: "a happy customer" }] }],
    });
    expect(res.ok).toBe(true);
    const ev = sentEvents.find((e) => e.name === "video.render.requested");
    expect((ev?.data as { intake: { scripts?: unknown } }).intake.scripts).toBeUndefined();
  });

  it("a testimonial overlay with a real difference survives, minus its b-roll", async () => {
    const res = await callPraxisTool(renderCtx, "render_video", {
      ...intake,
      video_type: "testimonial",
      testimonials: [{ quote: "Booked in two minutes.", attribution: "Maria G.", source: "Google review" }],
      scripts: [{ cta_text: "Book today", broll_prompt: "a happy customer smiling" }],
    });
    expect(res.ok).toBe(true);
    const ev = sentEvents.find((e) => e.name === "video.render.requested");
    const scripts = (ev?.data as { intake: { scripts: Array<Record<string, unknown>> } }).intake.scripts;
    expect(scripts).toHaveLength(1);
    expect(scripts[0].cta_text).toBe("Book today");
    expect(scripts[0].broll_prompt).toBeUndefined();
  });

  it("allows a CTA url the customer typed themselves", async () => {
    urlGroundingSources = { productHosts: [], userTexts: ["send hosts to upcar.ai/host"] };
    const res = await callPraxisTool(renderCtx, "render_launch_video", {
      ...intake,
      url: "https://upcar.ai/host",
      cta_url: "https://upcar.ai/host",
    });
    expect(res.ok).toBe(true);
    expect(sentEvents.find((e) => e.name === "video.render.requested")).toBeTruthy();
  });

  it("allows the tenant's recorded product_url", async () => {
    urlGroundingSources = { productHosts: ["upcar.ai"], userTexts: [] };
    const res = await callPraxisTool(renderCtx, "render_launch_video", intake);
    expect(res.ok).toBe(true);
  });

  it("tells the agent to ASK rather than retry with a guess", async () => {
    urlGroundingSources = { productHosts: [], userTexts: [] };
    const res = await callPraxisTool(renderCtx, "render_launch_video", intake);
    expect(res.is_error).toBe(true);
    expect(String(res.content)).toMatch(/ASK them/i);
    expect(String(res.content)).toMatch(/do NOT guess/i);
  });

  it("refuses to render when the grounding check itself cannot run (fail-closed)", async () => {
    urlGroundingLoadError = new Error("db down");
    const res = await callPraxisTool(renderCtx, "render_launch_video", intake);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("render_launch_video_url_check_failed");
    expect(sentEvents.find((e) => e.name === "video.render.requested")).toBeUndefined();
  });

  it("render_video is registered with the SAME schema shape as render_launch_video", () => {
    const tools = listPraxisTools();
    const rv = tools.find((t) => t.tool_name === "render_video");
    const rlv = tools.find((t) => t.tool_name === "render_launch_video");
    expect(rv).toBeTruthy();
    expect(rlv).toBeTruthy();
    expect(rv!.input_schema).toEqual(rlv!.input_schema);
  });

  it("render_video enqueues the SAME event ('video.render.requested') as render_launch_video", async () => {
    const a = await callPraxisTool(renderCtx, "render_video", intake);
    expect(a.ok).toBe(true);
    expect(JSON.parse(a.content as string).status).toBe("rendering");
    const ev1 = sentEvents.find((e) => e.name === "video.render.requested");
    expect(ev1).toBeTruthy();
    expect((ev1!.data as { run_id: string }).run_id).toBe("op-run-render");

    sentEvents.length = 0;
    const b = await callPraxisTool(renderCtx, "render_launch_video", intake);
    expect(b.ok).toBe(true);
    const ev2 = sentEvents.find((e) => e.name === "video.render.requested");
    expect(ev2).toBeTruthy();
    expect(ev1!.name).toBe(ev2!.name);
    expect(Object.keys(ev1!.data as object).sort()).toEqual(Object.keys(ev2!.data as object).sort());
  });

  it("render_video carries an A/B scripts intake through to the event unchanged", async () => {
    const ab = { ...intake, scripts: [{ one_liner: "There's a car parked near you.", cta_text: "Find your car" }] };
    const res = await callPraxisTool(renderCtx, "render_video", ab);
    expect(res.ok).toBe(true);
    const ev = sentEvents.find((e) => e.name === "video.render.requested");
    const fwd = (ev!.data as { intake: { scripts?: unknown[] } }).intake;
    expect(Array.isArray(fwd.scripts)).toBe(true);
    expect(fwd.scripts).toHaveLength(1);
  });
});

const umbrellaMock =
  isUmbrellaProvisionedTenant as unknown as ReturnType<typeof vi.fn>;
const refineMock = refineProduct as unknown as ReturnType<typeof vi.fn>;

describe("callPraxisTool — umbrella app-edit reroute to refineProduct", () => {
  beforeEach(() => {
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({ run_id: "r-new-1" });
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "pm", "engineer"]));
    umbrellaMock.mockReset();
    refineMock.mockReset();
    refineMock.mockResolvedValue({
      conductor_run_id: "cr-refine-1",
      parent_conductor_run_id: null,
      target: { github_full_name: "Praxis-build/i-want-to-build-3d6ef8be" },
      direct_merge_enabled: true,
    });
    lineageInserts.length = 0;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    parentRunPayload = {};
  });
  afterEach(() => {
    umbrellaMock.mockResolvedValue(false);
    vi.restoreAllMocks();
  });

  it("umbrella tenant + engineer handoff → refineProduct, NOT a generic enqueue", async () => {
    umbrellaMock.mockResolvedValue(true);
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "make the hero headline say Welcome",
    });
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    expect(refineMock).toHaveBeenCalledTimes(1);
    expect(refineMock.mock.calls[0][0]).toMatchObject({
      tenant_id: "t1",
      message: "make the hero headline say Welcome",
    });
    expect(enqueueMock).not.toHaveBeenCalled();
    const body = parseContent(res.content);
    expect(body.routed_to).toBe("refine_product");
    expect(body.conductor_run_id).toBe("cr-refine-1");
    expect(String(body.message)).toMatch(/automatically|going live/i);
    expect(String(body.message)).not.toMatch(/pull request|review/i);
  });

  it("kill-switch OFF → PR wording, and no auto-deploy / post-back promise", async () => {
    umbrellaMock.mockResolvedValue(true);
    refineMock.mockResolvedValue({
      conductor_run_id: "cr-refine-2",
      parent_conductor_run_id: null,
      target: { github_full_name: "Praxis-build/i-want-to-build-3d6ef8be" },
      direct_merge_enabled: false,
    });
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "make the hero headline say Welcome",
    });
    const body = parseContent(res.content);
    expect(body.routed_to).toBe("refine_product");
    expect(String(body.message)).toMatch(/pull request/i);
    expect(String(body.message)).not.toMatch(/automatically|post back here/i);
  });

  it("reroutes even when the phrasing wouldn't match isAppEditIntent", async () => {
    umbrellaMock.mockResolvedValue(true);
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent:
        "Instead of browse the catalog button, can you make it such that it says open the catalog?",
    });
    expect(res.ok).toBe(true);
    expect(refineMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("hands the engineer the image the user attached to their message, never another tenant's", async () => {
    umbrellaMock.mockResolvedValue(true);
    const T = "b92dcbf1-bac9-457a-af81-0bbe5984339b";
    const mine = `${T}/0f0f0f0f-1c87-483f-9930-4a18bc701015.jpg`;
    latestUserMessageFixture = {
      body: "can you use this img",
      attachments: [
        { path: mine, kind: "image" },
        { path: `73db45ff-457e-4541-bc8f-bdb625390204/1f0f0f0f-1c87-483f-9930-4a18bc701015.jpg`, kind: "image" },
        { path: `${T}/2f0f0f0f-1c87-483f-9930-4a18bc701015.pdf`, kind: "doc" },
      ],
    };
    try {
      await callPraxisTool({ ...baseCtx, tenant_id: T }, "handoff", {
        target_agent_slug: "engineer",
        intent: "use the uploaded photo as the hero background",
      });
    } finally {
      latestUserMessageFixture = null;
    }
    expect(refineMock).toHaveBeenCalledTimes(1);
    expect(refineMock.mock.calls[0][0]).toMatchObject({
      tenant_id: T,
      message: "use the uploaded photo as the hero background",
      request: "can you use this img",
      photo_paths: [mine],
    });
  });

  it("umbrella tenant + NON-engineer handoff (pm) is NOT rerouted", async () => {
    umbrellaMock.mockResolvedValue(true);
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "file a SCRUM about the refresh bug",
    });
    expect(res.ok).toBe(true);
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].agent_slug).toBe("pm");
  });

  it("non-umbrella tenant + engineer handoff takes the normal enqueue path", async () => {
    umbrellaMock.mockResolvedValue(false);
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "fix the failing test in the api package",
    });
    expect(res.ok).toBe(true);
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].agent_slug).toBe("engineer");
  });

  it("refineProduct rejection surfaces a friendly message, still no enqueue", async () => {
    umbrellaMock.mockResolvedValue(true);
    refineMock.mockRejectedValue(new NoProvisionedRepo("t1"));
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "make the footer smaller",
    });
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(parseContent(res.content).routed_to).toBe("refine_product");
  });

  it("a frozen old-flow app gets the one freeze reply with the Rebuild action, no enqueue", async () => {
    umbrellaMock.mockResolvedValue(true);
    refineMock.mockRejectedValue(new OldSiteFrozen("t1"));
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "make the footer smaller",
    });
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
    const body = parseContent(res.content);
    expect(body.code).toBe("old_site_frozen");
    expect(body.message).toBe(OLD_SITE_FROZEN_MESSAGE);
    expect(body.action).toEqual({ kind: "rebuild_old_site", label: "Rebuild on the new builder" });
  });

  it("an out-of-credits refine tells the user to top up, not that something broke", async () => {
    umbrellaMock.mockResolvedValue(true);
    refineMock.mockRejectedValue(new InsufficientCreditsForBuild(2000, 800));
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "make the footer smaller",
    });
    const body = parseContent(res.content);
    expect(res.is_error).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(body.message).toMatch(/top up/i);
    expect(body.message).toContain("2,000");
    expect(body.message).not.toMatch(/hit a problem/i);
  });
});

describe("callPraxisTool — handoff from Teams surface", () => {
  const teamsCtx = {
    tenant_id: "t1",
    run_id: "op-run-teams",
    agent_slug: "operator",
    trigger: "teams",
  };
  const teamsRouting = {
    conversation_reference: { conversation: { id: "19:abc@thread.tacv2" } },
    conversation_id: "19:abc@thread.tacv2",
    service_url: "https://smba.trafficmanager.net/amer/",
    activity_id: "1700000000001",
    m365_tenant_id: "3f86f84a-c360-479c-b4d2-4831f8d9baf2",
    text: "how did our ads do last week?",
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "engineer", "pm"]));
    enqueueMock.mockResolvedValue({ run_id: "child-teams-1" });
    runUpdates.length = 0;
    parentRunPayload = { teams: teamsRouting };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    parentRunPayload = {};
  });

  it("child is enqueued trigger='teams' + payload.teams so its answer threads back", async () => {
    const res = await callPraxisTool(teamsCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "pull last week's ad performance",
    });
    expect(res.ok).toBe(true);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.agent_slug).toBe("pm");
    expect(enqArg.trigger).toBe("teams");
    expect(enqArg.payload.teams).toEqual(teamsRouting);
    expect(enqArg.payload.source).toBe("teams");
    expect(enqArg.payload.operator_thread_id).toBeUndefined();
  });

  it("pre-marks teams_reply_delegated on the parent BEFORE enqueue (no interim post)", async () => {
    enqueueMock.mockImplementationOnce(async () => {
      expect(runUpdates.length).toBe(1);
      expect(
        (runUpdates[0].payload as Record<string, unknown>).teams_reply_delegated,
      ).toBe(true);
      return { run_id: "child-teams-1" };
    });
    await callPraxisTool(teamsCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "pull last week's ad performance",
    });
    expect(runUpdates.length).toBe(1);
  });

  it("provenance: the child yields the USER's words from payload.teams.text", async () => {
    await callPraxisTool(teamsCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "the agent's own invented framing",
    });
    const childPayload = enqueueMock.mock.calls[0][0].payload;
    expect(extractUserMessageFromPayload(childPayload)).toBe(
      "how did our ads do last week?",
    );
  });

  it("no conversation_reference → generic handoff child, parent NOT flagged", async () => {
    parentRunPayload = { teams: { text: "hi", conversation_id: "19:abc" } };
    const res = await callPraxisTool(teamsCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "something",
    });
    expect(res.ok).toBe(true);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.trigger).toBe("handoff");
    expect(enqArg.payload.teams).toBeUndefined();
    expect(runUpdates.length).toBe(0);
  });
});

describe("callPraxisTool — handoff from WhatsApp surface", () => {
  const waCtx = {
    tenant_id: "t1",
    run_id: "op-run-wa",
    agent_slug: "operator",
    trigger: "whatsapp",
  };
  const waRouting = {
    wa_id: "15551234567",
    phone_number_id: "PN1",
    text: "how did our ads do last week?",
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "engineer", "pm"]));
    enqueueMock.mockResolvedValue({ run_id: "child-wa-1" });
    runUpdates.length = 0;
    parentRunPayload = { whatsapp: waRouting };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    parentRunPayload = {};
  });

  it("child is enqueued trigger='whatsapp' + payload.whatsapp (was: generic 'handoff', answer lost)", async () => {
    const res = await callPraxisTool(waCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "pull last week's ad performance",
    });
    expect(res.ok).toBe(true);
    const enqArg = enqueueMock.mock.calls[0][0];
    expect(enqArg.trigger).toBe("whatsapp");
    expect(enqArg.payload.whatsapp).toEqual(waRouting);
    expect(enqArg.payload.source).toBe("whatsapp");
  });

  it("pre-marks whatsapp_reply_delegated on the parent BEFORE enqueue", async () => {
    enqueueMock.mockImplementationOnce(async () => {
      expect(
        (runUpdates[0].payload as Record<string, unknown>).whatsapp_reply_delegated,
      ).toBe(true);
      return { run_id: "child-wa-1" };
    });
    await callPraxisTool(waCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "pull last week's ad performance",
    });
    expect(runUpdates.length).toBe(1);
  });

  it("no wa_id in the parent payload → falls back to the generic child, never a broken whatsapp child", async () => {
    parentRunPayload = { whatsapp: { phone_number_id: "PN1" } };
    await callPraxisTool(waCtx, "handoff", {
      target_agent_slug: "pm",
      intent: "pull last week's ad performance",
    });
    expect(enqueueMock.mock.calls[0][0].trigger).not.toBe("whatsapp");
  });
});

describe("callPraxisTool — handoff, three-tier pricing", () => {
  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "pm", "engineer"]));
    enqueueMock.mockResolvedValue({ run_id: "r-new-1" });
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    lineageStatsError = null;
    parentRunPayload = {};
    tierState.decision = { enforced: false, tier: "free", required_tier: "free", allowed: true };
    tierState.throws = false;
  });

  it("target the tier cannot run → plain-words tool result, no enqueue, no throw", async () => {
    const { notePlanWallMap } = await import("@/services/agents/entitlement");
    const { DEFAULT_TIER_AGENT_MIN, DEFAULT_TIER_ALWAYS_PRO } = await import("@/services/billing/tiers");
    notePlanWallMap(DEFAULT_TIER_AGENT_MIN, DEFAULT_TIER_ALWAYS_PRO);
    tierState.decision = { enforced: true, tier: "starter", required_tier: "pro", allowed: false };
    const res = await callPraxisTool(baseCtx, "handoff", { ...baseArgs, target_agent_slug: "engineer" });
    expect(res.ok).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
    const body = parseContent(res.content);
    expect(body.error).toBe("plan_upgrade_required");
    expect(body.required_tier).toBe("pro");
    expect(String(body.message).startsWith("Engineer needs the Pro plan ($240/mo).")).toBe(true);
    expect(body.message).toContain("Free included");
    expect(body.message).toContain("Settings → Billing");
    expect(body.do_it_yourself).toBeUndefined();
  });

  it("linke-qr: a Free 'design Instagram posts' handoff points operator at its own image tool", async () => {
    tierState.decision = { enforced: true, tier: "free", required_tier: "starter", allowed: false };
    const res = await callPraxisTool(baseCtx, "handoff", {
      ...baseArgs,
      target_agent_slug: "instagram_organic",
      intent: "Design a set of Instagram posts for my product",
    });
    expect(enqueueMock).not.toHaveBeenCalled();
    const body = parseContent(res.content);
    expect(body.error).toBe("plan_upgrade_required");
    expect(body.required_tier).toBe("starter");
    expect(String(body.message).startsWith("Instagram needs the Starter plan ($20/mo).")).toBe(true);
    expect(body.do_it_yourself).toContain("report__render_social_image");
  });

  it("enqueue-time refusal (DB backstop) is also returned in plain words, not thrown", async () => {
    tierState.throws = true;
    enqueueMock.mockRejectedValueOnce(
      Object.assign(new Error("Pm needs the Starter plan ($20/mo)."), {
        code: "plan_upgrade_required",
        agent_slug: "pm",
        required_tier: "starter",
        body: {},
      }),
    );
    const res = await callPraxisTool(baseCtx, "handoff", baseArgs);
    expect(res.ok).toBe(false);
    const body = parseContent(res.content);
    expect(body.error).toBe("plan_upgrade_required");
    expect(body.required_tier).toBe("starter");
  });

  it("gate allows → handoff enqueues as before", async () => {
    tierState.decision = { enforced: true, tier: "pro", required_tier: "pro", allowed: true };
    const res = await callPraxisTool(baseCtx, "handoff", { ...baseArgs, target_agent_slug: "engineer" });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(res.is_error).toBe(false);
  });
});

describe("callPraxisTool — handoff on an addressed (@agent) turn", () => {
  const pinnedCtx = { ...baseCtx, run_id: "op-1" };
  beforeEach(() => {
    enqueueMock.mockReset();
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "pm", "engineer", "cgo"]));
    enqueueMock.mockResolvedValue({ run_id: "r-new-1" });
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    lineageStatsError = null;
    parentRunPayload = {};
    agentRunsReadFails = false;
    tierState.decision = { enforced: false, tier: "free", required_tier: "free", allowed: true };
    tierState.throws = false;
    tierState.calls.length = 0;
  });
  afterEach(() => {
    agentRunsReadFails = false;
    parentRunPayload = {};
  });

  it("@engineer: the pre-enqueue check is a founder ask and the child is stamped", async () => {
    parentRunPayload = { mention_target: "engineer" };
    tierState.decision = { enforced: true, tier: "pro", required_tier: "pro", allowed: true };
    await callPraxisTool(pinnedCtx, "handoff", { target_agent_slug: "engineer", intent: "fix the login bug" });
    expect(tierState.calls[0]?.engineerBackendRun).toBe(false);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].payload.founder_direct_agent_mention).toBe(true);
  });

  it("@engineer on a Starter tenant is refused before anything is enqueued", async () => {
    parentRunPayload = { mention_target: "engineer" };
    tierState.decision = { enforced: true, tier: "starter", required_tier: "pro", allowed: false };
    const res = await callPraxisTool(pinnedCtx, "handoff", { target_agent_slug: "engineer", intent: "fix it" });
    expect(parseContent(res.content).error).toBe("plan_upgrade_required");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("an unaddressed engineer handoff stays exempt server work, unstamped", async () => {
    await callPraxisTool(pinnedCtx, "handoff", { target_agent_slug: "engineer", intent: "fix the login bug" });
    expect(tierState.calls[0]?.engineerBackendRun).toBe(true);
    expect(enqueueMock.mock.calls[0][0].payload.founder_direct_agent_mention).toBeUndefined();
  });

  it("@cgo: the child is stamped and goes to cgo", async () => {
    parentRunPayload = { mention_target: "cgo" };
    await callPraxisTool(pinnedCtx, "handoff", { target_agent_slug: "cgo", intent: "what's holding growth back?" });
    const call = enqueueMock.mock.calls[0][0];
    expect(call.agent_slug).toBe("cgo");
    expect(call.trigger).toBe("handoff");
    expect(call.payload.operator_thread_id).toBe("th1");
    expect(call.payload.founder_direct_agent_mention).toBe(true);
  });

  it("fails closed when the pin cannot be read", async () => {
    agentRunsReadFails = true;
    const res = await callPraxisTool(pinnedCtx, "handoff", { target_agent_slug: "cgo", intent: "x" });
    expect(parseContent(res.content).error).toBe("handoff_pin_unreadable");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("refuses a parallel fan-out on an addressed turn", async () => {
    parentRunPayload = { mention_target: "engineer" };
    const res = await callPraxisTool(pinnedCtx, "handoff_parallel", {
      targets: [
        { target_agent_slug: "engineer", intent: "a" },
        { target_agent_slug: "pm", intent: "b" },
      ],
    });
    expect(res.ok).toBe(false);
    expect(parseContent(res.content).error).toBe("handoff_target_invalid");
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe("callPraxisTool — a verified custom agent (S3b)", () => {
  const SLUG = "c-abcdefghij";
  const admitted = { state: "admitted", tenant_id: "t1", run_id: "cr-1", agent_id: "a1", slug: SLUG };
  const cronCtx = { tenant_id: "t1", agent_slug: SLUG, trigger: "cron", run_id: "cr-1" };
  const args = { target_agent_slug: "research", intent: "Dig into Brightly's new free plan" };

  beforeEach(() => {
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({ run_id: "child-1" });
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "research", "pm"]));
    customRunMock.resolve.mockReset();
    customRunMock.resolve.mockResolvedValue(admitted);
    customRunMock.registerCalls.length = 0;
    customRunMock.registerReturn = true;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    lineageStatsError = null;
    parentRunPayload = {};
  });

  it("on its schedule: hands off (a2a child) and registers the join for ONE combined message", async () => {
    const res = await callPraxisTool(cronCtx, "handoff", args);
    expect(res.is_error).toBe(false);
    expect(customRunMock.resolve).toHaveBeenCalledWith("t1", "cr-1", SLUG);
    const enq = enqueueMock.mock.calls[0][0];
    expect(enq.trigger).toBe("a2a");
    expect(enq.agent_slug).toBe("research");
    expect(customRunMock.registerCalls).toEqual([
      expect.objectContaining({ p_tenant_id: "t1", p_parent_run_id: "cr-1", p_child_run_id: "child-1" }),
    ]);
    expect(String(parseContent(res.content).message)).toContain("scheduled message");
  });

  it("not an admitted run (paused, unverified): refused before anything is enqueued", async () => {
    for (const state of ["blocked", "unverified", "error"]) {
      customRunMock.resolve.mockResolvedValueOnce({ state });
      const res = await callPraxisTool(cronCtx, "handoff", args);
      expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    }
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a built-in non-operator agent on a schedule is still refused, and never consults the custom check", async () => {
    const res = await callPraxisTool({ ...cronCtx, agent_slug: "research" }, "handoff", args);
    expect(parseContent(res.content).error).toBe("handoff_not_authorized");
    expect(customRunMock.resolve).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("cannot hand off to itself", async () => {
    const res = await callPraxisTool(cronCtx, "handoff", { ...args, target_agent_slug: SLUG });
    expect(parseContent(res.content).error).toBe("handoff_self_loop");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("praxis__action on a schedule: allowed, and the emit tells the runner not to dispatch it twice", async () => {
    const emit = vi.fn(async () => "d-9");
    execMock.mockReset();
    execMock.mockResolvedValue({ ok: true, status: "executed", result: { ts: "1.2" } });
    const res = await callPraxisTool({ ...cronCtx, emit_decision: emit }, "action", {
      verb: "post-slack-message",
      channel_id: "C0123ABC",
      text: "Brightly launched a free plan.",
    });
    expect(res.is_error).toBe(false);
    expect(emit).toHaveBeenCalledWith("operator.post-slack-message", expect.anything(), { selfDispatch: true });
    expect(execMock).toHaveBeenCalledWith("d-9");
    expect(handToHumanMock).not.toHaveBeenCalled();
  });

  it("praxis__action that did not run (rate cap, fleet halt): handed to a human, not left invisible", async () => {
    handToHumanMock.mockClear();
    const emit = vi.fn(async () => "d-10");
    execMock.mockReset();
    execMock.mockResolvedValue({ ok: true, status: "rate_capped" });
    await callPraxisTool({ ...cronCtx, emit_decision: emit }, "action", {
      verb: "post-slack-message",
      channel_id: "C0123ABC",
      text: "x",
    });
    expect(handToHumanMock).toHaveBeenCalledWith("t1", "d-10", "cr-1");
  });

  it("praxis__action that failed before any external call (invalid body): handed to a human", async () => {
    handToHumanMock.mockClear();
    execMock.mockReset();
    execMock.mockResolvedValue({ ok: false, status: "failed", error: "slack.post_message body invalid: x", not_started: true });
    await callPraxisTool({ ...cronCtx, emit_decision: vi.fn(async () => "d-12") }, "action", {
      verb: "post-slack-message",
      channel_id: "C0123ABC",
      text: "x",
    });
    expect(handToHumanMock).toHaveBeenCalledWith("t1", "d-12", "cr-1");
  });

  it("praxis__action whose handler ran and failed: NOT handed to a human (the write may have landed)", async () => {
    handToHumanMock.mockClear();
    execMock.mockReset();
    execMock.mockResolvedValue({ ok: false, status: "failed", error: "slack 500 after post" });
    await callPraxisTool({ ...cronCtx, emit_decision: vi.fn(async () => "d-11") }, "action", {
      verb: "post-slack-message",
      channel_id: "C0123ABC",
      text: "x",
    });
    expect(handToHumanMock).not.toHaveBeenCalled();
  });
});

describe("callPraxisTool — fresh tenant whole-app build goes to the product builder", () => {
  const repoAccessMock = checkSandboxRepoAccess as unknown as ReturnType<typeof vi.fn>;
  const startBuildMock = startProductBuild as unknown as ReturnType<typeof vi.fn>;
  const builderFlagMock = isProductBuilderEnabled as unknown as ReturnType<typeof vi.fn>;
  const tickMock = requestConductorTick as unknown as ReturnType<typeof vi.fn>;
  const confirmedCtx = { ...baseCtx, heavy_confirm_preclaimed: true };
  const blogBuild = {
    target_agent_slug: "engineer",
    intent: "Build a blog posting website where writers publish stories and readers browse a feed",
    context: { full_build: true },
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({ run_id: "r-engineer-1" });
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "pm", "engineer"]));
    umbrellaMock.mockResolvedValue(false);
    repoAccessMock.mockReset();
    repoAccessMock.mockResolvedValue("not_connected");
    builderFlagMock.mockReset();
    builderFlagMock.mockResolvedValue(true);
    startBuildMock.mockReset();
    startBuildMock.mockResolvedValue({ conductor_run_id: "cr-build-1" });
    tickMock.mockClear();
    lineageInserts.length = 0;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    parentRunPayload = {};
  });
  afterEach(() => {
    repoAccessMock.mockResolvedValue("ok");
    builderFlagMock.mockResolvedValue(true);
  });

  it("confirmed build on a tenant with no GitHub starts a product build and never enqueues the engineer", async () => {
    const res = await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(startBuildMock).toHaveBeenCalledTimes(1);
    const input = startBuildMock.mock.calls[0][0];
    expect(input.tenant_id).toBe("t1");
    expect(input.idea).toContain("blog posting website");
    expect(input.company_name.length).toBeGreaterThan(0);
    expect(tickMock).toHaveBeenCalledWith(expect.anything(), "cr-build-1");
    const body = parseContent(res.content);
    expect(body.routed_to).toBe("product_build");
    expect(body.conductor_run_id).toBe("cr-build-1");
  });

  it("the build is started by the server-derived chat user, never an LLM-supplied one", async () => {
    await callPraxisTool(confirmedCtx, "handoff", { ...blogBuild, started_by_user_id: "u-forged" } as never);
    expect(startBuildMock.mock.calls[0][0].started_by_user_id).toBe("u1");
  });

  it("a chat or Slack build never waits for a look pick, even when the model asks for it", async () => {
    await callPraxisTool(confirmedCtx, "handoff", { ...blogBuild, await_look_pick: true, context: { full_build: true, await_look_pick: true } } as never);
    expect(startBuildMock).toHaveBeenCalledTimes(1);
    expect(startBuildMock.mock.calls[0][0]).not.toHaveProperty("await_look_pick");
  });

  it("a plain whole-app phrasing with modifiers also reroutes without the full_build flag", async () => {
    const res = await callPraxisTool(confirmedCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "Help me make a blog posting website",
    });
    expect(parseContent(res.content).routed_to).toBe("product_build");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("the idea is sanitised before it reaches the build", async () => {
    await callPraxisTool(confirmedCtx, "handoff", {
      ...blogBuild,
      intent: "Build a blog website <script>alert(1)</script> for writers",
    });
    const idea = startBuildMock.mock.calls[0][0].idea as string;
    expect(idea).not.toContain("<script>");
    expect(idea).not.toContain("<");
  });

  it("a tenant with GitHub connected keeps the engineer handoff and starts no product build", async () => {
    repoAccessMock.mockResolvedValue("ok");
    const res = await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(res.ok).toBe(true);
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0].agent_slug).toBe("engineer");
  });

  it("a GitHub tenant whose install died is not turned into a fresh product build", async () => {
    repoAccessMock.mockResolvedValue("install_dead");
    await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  it("a small engineer task on a no-GitHub tenant is not turned into a product build", async () => {
    await callPraxisTool(confirmedCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "fix the typo in the footer",
    });
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  it("with the product builder switched off nothing is built", async () => {
    builderFlagMock.mockResolvedValue(false);
    await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(startBuildMock).not.toHaveBeenCalled();
  });

  it("a build already running is a failed start with the reason, so the Start card stays retryable", async () => {
    startBuildMock.mockRejectedValue(new DoubleBuildInFlight("t1"));
    const res = await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(res.ok).toBe(false);
    expect(res.is_error).toBe(true);
    expect(String(parseContent(res.content).message)).toMatch(/already running/i);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(tickMock).not.toHaveBeenCalled();
  });
});

describe("callPraxisTool — a chat whole-app build on a tenant with no GitHub, before and after Start", () => {
  const repoAccessMock = checkSandboxRepoAccess as unknown as ReturnType<typeof vi.fn>;
  const startBuildMock = startProductBuild as unknown as ReturnType<typeof vi.fn>;
  const builderFlagMock = isProductBuilderEnabled as unknown as ReturnType<typeof vi.fn>;
  const confirmedCtx = { ...baseCtx, heavy_confirm_preclaimed: true };
  const blogBuild = {
    target_agent_slug: "engineer",
    intent: "Build a blog posting website where writers publish stories and readers browse a feed",
    context: { full_build: true },
  };

  beforeEach(() => {
    enqueueMock.mockReset();
    enqueueMock.mockResolvedValue({ run_id: "r-engineer-1" });
    visibleMock.mockReset();
    visibleMock.mockResolvedValue(new Set(["operator", "pm", "engineer"]));
    umbrellaMock.mockResolvedValue(false);
    repoAccessMock.mockReset();
    repoAccessMock.mockResolvedValue("not_connected");
    builderFlagMock.mockReset();
    builderFlagMock.mockResolvedValue(true);
    startBuildMock.mockReset();
    startBuildMock.mockResolvedValue({ conductor_run_id: "cr-build-1" });
    refineMock.mockReset();
    refineMock.mockResolvedValue({
      conductor_run_id: "cr-refine-1",
      target: { github_full_name: "Praxis-build/x" },
      direct_merge_enabled: true,
    });
    heavyState.confirmOn = true;
    heavyState.armed.length = 0;
    tenantRoleFixture = "owner";
    firstBuildFreeFixture = false;
    tenantDisplayNameFixture = null;
    rpcCalls.length = 0;
    lineageInserts.length = 0;
    lineageStats = { max_depth: 0, target_slugs: [], cumulative_cost: 0 };
    parentRunPayload = {};
  });
  afterEach(() => {
    repoAccessMock.mockResolvedValue("ok");
    builderFlagMock.mockResolvedValue(true);
    umbrellaMock.mockResolvedValue(false);
    heavyState.confirmOn = true;
    tenantRoleFixture = "owner";
    firstBuildFreeFixture = false;
    tenantDisplayNameFixture = null;
  });

  const separateGame = {
    target_agent_slug: "engineer",
    intent: "Build a standalone 3D block-world game that runs in the browser, separate from the existing app.",
  };

  it.each(["not_connected", "ok"])("a separate game keeps Start and uses a fresh build with repo access %s", async (access) => {
    repoAccessMock.mockResolvedValue(access);
    umbrellaMock.mockResolvedValue(access === "not_connected");
    connectedReposFixture = access === "ok" ? ["example/existing-app"] : [];
    const pending = parseContent((await callPraxisTool(baseCtx, "handoff", separateGame)).content);
    expect(pending.pending_confirmation).toBe(true);
    expect(pending.est_credits).toBe(requiredBuildCredits());
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(heavyState.armed).toHaveLength(1);

    const confirmed = parseContent((await callPraxisTool(confirmedCtx, "handoff", separateGame)).content);
    expect(confirmed.routed_to).toBe("product_build");
    expect(startBuildMock).toHaveBeenCalledTimes(1);
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("an explicit Spanish separate app keeps the Start gate and does not refine the bound app", async () => {
    parentRunPayload = { build_session_id: "11111111-1111-4111-8111-111111111111" };
    const ask = { target_agent_slug: "engineer", intent: "Crea una aplicación separada de mi aplicación actual" };
    const pending = parseContent((await callPraxisTool({ ...baseCtx, run_id: "bound-run" }, "handoff", ask)).content);
    expect(pending.pending_confirmation).toBe(true);
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(refineMock).not.toHaveBeenCalled();
    const confirmed = parseContent((await callPraxisTool({ ...confirmedCtx, run_id: "bound-run" }, "handoff", ask)).content);
    expect(confirmed.routed_to).toBe("product_build");
    expect(startBuildMock).toHaveBeenCalledTimes(1);
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("an explicit separate game is not bound to the app currently open in Build", async () => {
    parentRunPayload = { build_session_id: "11111111-1111-4111-8111-111111111111" };
    const body = parseContent((await callPraxisTool({ ...confirmedCtx, run_id: "bound-run" }, "handoff", separateGame)).content);
    expect(body.routed_to).toBe("product_build");
    expect(startBuildMock).toHaveBeenCalledTimes(1);
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("an existing bound app still receives a game-component edit", async () => {
    parentRunPayload = { build_session_id: "11111111-1111-4111-8111-111111111111" };
    await callPraxisTool({ ...baseCtx, run_id: "bound-run" }, "handoff", {
      target_agent_slug: "engineer",
      intent: "Build a game inside my app",
    });
    expect(refineMock).toHaveBeenCalledTimes(1);
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(heavyState.armed).toHaveLength(0);
  });

  it("an unavailable builder setting read cannot redirect a separate app to the connected repo", async () => {
    repoAccessMock.mockResolvedValue("ok");
    connectedReposFixture = ["example/existing-app"];
    builderFlagMock.mockRejectedValue(new Error("read unavailable"));
    const body = parseContent((await callPraxisTool(confirmedCtx, "handoff", separateGame)).content);
    expect(body.error).toBe("product_build_unavailable");
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a separate app request outside web chat cannot silently edit an existing repo", async () => {
    repoAccessMock.mockResolvedValue("ok");
    connectedReposFixture = ["example/existing-app"];
    const body = parseContent((await callPraxisTool({
      ...baseCtx,
      trigger: "slack",
      slack_routing: { channel_id: "C1", thread_ts: "1.2", original_ts: "1.2", event_id: "Ev1" },
    }, "handoff", separateGame)).content);
    expect(body.error).toBe("product_build_unavailable");
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(heavyState.armed).toHaveLength(0);
  });

  it.each([
    "Create a login page for my app",
    "Create a signup form for the app",
    "Create a checkout flow for my marketplace",
    "Build a checkout flow for my marketplace",
    "Create an admin dashboard for the platform",
    "Build an admin dashboard for the platform",
    "Create a separate login page for my app",
    "Create a game level for the current game",
    "Create a separate game mode in my existing game",
    "Build a standalone game widget from scratch inside the existing website",
    "Make an independent app settings page from scratch",
    "Build a standalone game from scratch inside my existing app",
  ])("a component edit still refines instead of making another app: %s", async (intent) => {
    umbrellaMock.mockResolvedValue(true);
    await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent,
    });
    expect(refineMock).toHaveBeenCalledTimes(1);
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(heavyState.armed).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("an unavailable builder never redirects a separate game into the connected repo", async () => {
    repoAccessMock.mockResolvedValue("ok");
    connectedReposFixture = ["example/existing-app"];
    builderFlagMock.mockResolvedValue(false);
    const body = parseContent((await callPraxisTool(confirmedCtx, "handoff", separateGame)).content);
    expect(body.error).toBe("product_build_unavailable");
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(heavyState.armed).toHaveLength(0);
  });

  it("a member cannot start a separate game through a connected repo", async () => {
    repoAccessMock.mockResolvedValue("ok");
    connectedReposFixture = ["example/existing-app"];
    tenantRoleFixture = "member";
    const body = parseContent((await callPraxisTool(baseCtx, "handoff", separateGame)).content);
    expect(body.not_permitted).toBe(true);
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(heavyState.armed).toHaveLength(0);
  });

  it("an unconfirmed build asks for Start and starts nothing", async () => {
    const res = await callPraxisTool(baseCtx, "handoff", blogBuild);
    expect(res.ok).toBe(true);
    const body = parseContent(res.content);
    expect(body.pending_confirmation).toBe(true);
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(heavyState.armed).toHaveLength(1);
    expect(heavyState.armed[0]).toMatchObject({ target: "engineer", thread_id: "th1", intent: blogBuild.intent });
  });

  it("with the confirm switch off the build starts at once", async () => {
    heavyState.confirmOn = false;
    const res = await callPraxisTool(baseCtx, "handoff", blogBuild);
    expect(parseContent(res.content).routed_to).toBe("product_build");
    expect(startBuildMock).toHaveBeenCalledTimes(1);
    expect(heavyState.armed).toHaveLength(0);
  });

  it("the Start card quotes the product build price, not the engineer estimate", async () => {
    const res = await callPraxisTool(baseCtx, "handoff", blogBuild);
    const body = parseContent(res.content);
    expect(requiredBuildCredits()).not.toBe(reserveEstimateFor("engineer"));
    expect(body.est_credits).toBe(requiredBuildCredits());
    expect(heavyState.armed[0].est_credits).toBe(requiredBuildCredits());
    expect(rpcCalls).toContain("first_build_free_eligible");
  });

  it("a first build that is free is quoted as 0 and the message says it is free", async () => {
    firstBuildFreeFixture = true;
    const res = await callPraxisTool(baseCtx, "handoff", blogBuild);
    const body = parseContent(res.content);
    expect(body.est_credits).toBe(0);
    expect(body.est_usd).toBe(0);
    expect(heavyState.armed[0].est_credits).toBe(0);
    expect(String(body.message)).toMatch(/free/i);
    expect(String(body.message)).not.toMatch(/about 0 credits/i);
  });

  it("when the free-build check fails the full price is quoted, never free", async () => {
    firstBuildFreeFixture = "error";
    const body = parseContent((await callPraxisTool(baseCtx, "handoff", blogBuild)).content);
    expect(body.est_credits).toBe(requiredBuildCredits());
  });

  it("a GitHub tenant keeps the engineer estimate and never asks about a free build", async () => {
    repoAccessMock.mockResolvedValue("ok");
    firstBuildFreeFixture = true;
    const body = parseContent((await callPraxisTool(baseCtx, "handoff", blogBuild)).content);
    expect(body.est_credits).toBe(reserveEstimateFor("engineer"));
    expect(rpcCalls).not.toContain("first_build_free_eligible");
  });

  it("an umbrella tenant's whole-app request takes the fresh-build route, not an edit of the frozen app", async () => {
    umbrellaMock.mockResolvedValue(true);
    firstBuildFreeFixture = true;
    const body = parseContent((await callPraxisTool(baseCtx, "handoff", blogBuild)).content);
    expect(body.est_credits).toBe(0);
    expect(body.est_credits).not.toBe(reserveEstimateFor("engineer"));
  });

  it.each([
    ["code project", () => new BuildRepoNotProvisioned("github 500"), BUILD_REPO_NOT_PROVISIONED_COPY],
    ["site", () => new SiteSetupUnavailable("repo: github 500"), SITE_SETUP_UNAVAILABLE_COPY],
    ["prerequisite", () => new SiteBackendUnavailable(["GITHUB_PROVISION_TOKEN"]), SITE_SETUP_UNAVAILABLE_COPY],
  ])("a %s setup failure uses the same copy as the Build page", async (_n, make, copy) => {
    startBuildMock.mockRejectedValue(make());
    const res = await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(res.ok).toBe(false);
    const body = parseContent(res.content);
    expect(body.message).toBe(copy);
    expect(String(body.message)).not.toMatch(/500/);
  });

  it("with no usable workspace name the build is called My App, not words from the request", async () => {
    tenantDisplayNameFixture = "   ";
    await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(startBuildMock.mock.calls[0][0].company_name).toBe("My App");
  });

  it("a valid workspace name is used as the build name", async () => {
    tenantDisplayNameFixture = "Acme Bakery";
    await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(startBuildMock.mock.calls[0][0].company_name).toBe("Acme Bakery");
  });

  it.each(["member", "viewer", null])("a %s cannot start a product build", async (role) => {
    tenantRoleFixture = role;
    const res = await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(res.ok).toBe(true);
    expect(res.is_error).toBe(false);
    const body = parseContent(res.content);
    expect(String(body.message)).toMatch(/only an owner or admin/i);
    expect(body.conductor_run_id).toBeUndefined();
    expect(startBuildMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("a member is told before any Start card is set up", async () => {
    tenantRoleFixture = "member";
    const res = await callPraxisTool(baseCtx, "handoff", blogBuild);
    expect(parseContent(res.content).pending_confirmation).toBeUndefined();
    expect(heavyState.armed).toHaveLength(0);
  });

  it("a member cannot change an umbrella app through chat", async () => {
    tenantRoleFixture = "member";
    umbrellaMock.mockResolvedValue(true);
    const res = await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "make the hero headline say Welcome",
    });
    expect(res.ok).toBe(true);
    expect(String(parseContent(res.content).message)).toMatch(/only an owner or admin/i);
    expect(refineMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("an admin can change an umbrella app and start a build", async () => {
    tenantRoleFixture = "admin";
    umbrellaMock.mockResolvedValue(true);
    await callPraxisTool(baseCtx, "handoff", {
      target_agent_slug: "engineer",
      intent: "make the hero headline say Welcome",
    });
    expect(refineMock).toHaveBeenCalledTimes(1);
    umbrellaMock.mockResolvedValue(false);
    await callPraxisTool(confirmedCtx, "handoff", blogBuild);
    expect(startBuildMock).toHaveBeenCalledTimes(1);
  });

  it("a Slack member mapped by the actor envelope cannot change an umbrella app; an unmapped Slack sender cannot either", async () => {
    umbrellaMock.mockResolvedValue(true);
    const slackCtx = { tenant_id: baseCtx.tenant_id, agent_slug: "operator", trigger: "slack", run_id: "r-slack", slack_routing: { channel_id: "C1", thread_ts: "1.2", original_ts: "1.2", event_id: "Ev1" } };
    tenantRoleFixture = "member";
    const mapped = await callPraxisTool(
      { ...slackCtx, actor: { actor_user_id: "u-member", actor_source: "slack", resolved_tenant_member: true, provenance_label: "x" } } as never,
      "handoff",
      { target_agent_slug: "engineer", intent: "make the hero headline say Welcome" },
    );
    expect(String(parseContent(mapped.content).message)).toMatch(/only an owner or admin/i);
    tenantRoleFixture = "owner";
    const unmapped = await callPraxisTool(
      { ...slackCtx, actor: { actor_user_id: null, actor_source: "slack", resolved_tenant_member: false, provenance_label: "x" } } as never,
      "handoff",
      { target_agent_slug: "engineer", intent: "make the hero headline say Welcome" },
    );
    expect(String(parseContent(unmapped.content).message)).toMatch(/only an owner or admin/i);
    expect(refineMock).not.toHaveBeenCalled();
  });

  it("a Slack owner mapped by the actor envelope can change an umbrella app", async () => {
    umbrellaMock.mockResolvedValue(true);
    tenantRoleFixture = "owner";
    await callPraxisTool(
      { tenant_id: baseCtx.tenant_id, agent_slug: "operator", trigger: "slack", run_id: "r-slack", slack_routing: { channel_id: "C1", thread_ts: "1.2", original_ts: "1.2", event_id: "Ev1" }, actor: { actor_user_id: "u-owner", actor_source: "slack", resolved_tenant_member: true, provenance_label: "x" } } as never,
      "handoff",
      { target_agent_slug: "engineer", intent: "make the hero headline say Welcome" },
    );
    expect(refineMock).toHaveBeenCalledTimes(1);
  });

  it("a member's ordinary engineer task on a GitHub tenant is not blocked", async () => {
    tenantRoleFixture = "member";
    repoAccessMock.mockResolvedValue("ok");
    await callPraxisTool(baseCtx, "handoff", { target_agent_slug: "engineer", intent: "fix the typo in the footer" });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});

describe("praxis__run_site_check wiring", () => {
  it("is listed with a url-only schema and a write effect (it spends credits)", () => {
    const tool = listPraxisTools().find((t) => t.tool_name === "run_site_check");
    expect(tool).toBeTruthy();
    expect(tool!.effect).toBe("write");
    expect(Object.keys((tool!.input_schema as { properties?: object }).properties ?? {})).toEqual(["url"]);
  });

  it("passes only server context to the tool; model args cannot set the tenant or run", async () => {
    siteCheck.calls.length = 0;
    const ctx = {
      tenant_id: "t-1",
      run_id: "r-1",
      tool_use_id: "tu-1",
      trigger: "slack",
      slack_routing: { channel_id: "C1", thread_ts: "1.2", original_ts: "1.2", event_id: "e" },
      writes_suppressed: false,
    } as never;
    const r = await callPraxisTool(ctx, "run_site_check", { url: "vercel.com", tenant_id: "t-evil", run_id: "r-evil" });
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content as string).status).toBe("pending");
    expect(siteCheck.calls[0].ctx).toEqual({
      tenant_id: "t-1",
      run_id: "r-1",
      tool_use_id: "tu-1",
      trigger: "slack",
      chat_thread_id: undefined,
      slack_routing: { channel_id: "C1", thread_ts: "1.2", original_ts: "1.2", event_id: "e" },
      writes_suppressed: false,
    });
  });
});

describe("callPraxisTool — generative render from Zavi chat or Slack", () => {
  const ctx = {
    tenant_id: "t1",
    run_id: "op-run-gen",
    agent_slug: "operator",
    trigger: "slack" as const,
    slack_routing: { channel_id: "C9", thread_ts: "1.9", original_ts: "1.9", event_id: "EvGen" },
  };
  const args = {
    generative_intent: "talking_head",
    prompt: "A presenter in a bright kitchen explains UpcarAI",
    script: "Book a car near you in two taps and drive away today, no counter and no queue.",
    presenter_gender: "female",
  };

  beforeEach(async () => {
    sentEvents.length = 0;
    videoBlock.reason = null;
    const flag = await import("@/services/agents/_render-launch-video-flag-check");
    vi.mocked(flag.isGenerativeVideoEnabled).mockResolvedValue(true);
  });

  it.each([
    "your plan does not include AI UGC Videos (it needs starter), so the video was not made",
    "AI UGC Videos is switched off right now, so the video was not made",
  ])("queues nothing and says why when the channel is blocked: %s", async (reason) => {
    videoBlock.reason = reason;
    const res = await callPraxisTool(ctx, "render_video", args);
    const body = JSON.parse(res.content as string);
    expect(body.status).toBe("not_enabled");
    expect(body.message.toLowerCase()).toContain(reason.toLowerCase());
    expect(sentEvents.find((e) => e.name === "video.generate.requested")).toBeUndefined();
  });

  it("starts no paid render from chat when the plan has the channel and it is on", async () => {
    const res = await callPraxisTool(ctx, "render_video", args);
    expect(res.content).not.toContain("generating");
    expect(sentEvents.filter((e) => e.name === "video.generate.requested")).toHaveLength(0);
  });

  it("refuses a presenter script spoken as a customer before anything is queued", async () => {
    const res = await callPraxisTool(ctx, "render_video", { ...args, script: "I bought a rental on UpcarAI last month and it was the easiest trip I have ever taken." });
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("render_video_testimonial_no_talking_head");
    expect(sentEvents.find((e) => e.name === "video.generate.requested")).toBeUndefined();
  });
});
