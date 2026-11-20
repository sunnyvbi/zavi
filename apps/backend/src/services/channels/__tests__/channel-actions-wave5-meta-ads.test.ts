
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { actionsStoreFor, allowedActionTypes } from "@zavi/shared";
import { metaExecActionType } from "@/services/tools/meta-ads/write/_exec-action";
import { PENDING_STRATEGIST_CLASS } from "@/services/meta-ads/strategist-gate/constants";

const SLUG = "meta_ads";
const BACKEND = process.cwd();

describe("wave 5: meta_ads is switched, and its rail is what makes that safe", () => {
  it("meta_ads reads and writes channel_actions", () => {
    expect(actionsStoreFor(SLUG)).toBe("channel_actions");
  });

  it("youtube_ads is no longer held: wave 7 put it on google's own pin", () => {
    expect(actionsStoreFor("youtube_ads")).toBe("channel_actions");
    const gads = fs.readFileSync(
      path.join(BACKEND, "src/services/tools/google-ads/write/_exec-action.ts"),
      "utf8",
    );
    expect(gads).toContain('new Set(["google_ads", "youtube_ads"])');
  });

  it("the two rails are still per-PLATFORM, so one can move without the other", () => {
    const meta = fs.readFileSync(
      path.join(BACKEND, "src/services/tools/meta-ads/write/_exec-action.ts"),
      "utf8",
    );
    expect(meta).toContain('new Set(["meta_ads"])');
    const pin = meta.match(/SWITCHED_META_CHANNELS[^\n]*\n?[^\n]*/)?.[0] ?? "";
    expect(pin).not.toContain("google_ads");
    expect(pin).not.toContain("youtube_ads");
  });
});

describe("every class the meta propose tools emit has a home, and it is the right one", () => {
  const EXECUTABLE = [
    "meta_ads.update_ad_set_budget",
    "meta_ads.update_ad_set_budget_review",
    "meta_ads.set_status",
    "meta_ads.set_status_review",
    "meta_ads.create_ad_set",
  ];

  it("the rail's allowlist is exactly those five", () => {
    const src = fs.readFileSync(
      path.join(BACKEND, "src/services/tools/meta-ads/write/_exec-action.ts"),
      "utf8",
    );
    for (const cls of EXECUTABLE) expect(src, cls).toContain(`"${cls}"`);
  });

  it("each one is registered as a dispatch handler, so Approve has something to run", () => {
    const worker = fs.readFileSync(
      path.join(BACKEND, "workers/functions/dispatch-decision.ts"),
      "utf8",
    );
    for (const cls of EXECUTABLE) {
      expect(worker, `${cls} has no HANDLERS entry`).toContain(`"${cls}": async (d`);
    }
  });

  it("each one derives an action type this channel can render", () => {
    const allowed = allowedActionTypes(SLUG);
    for (const cls of EXECUTABLE) {
      for (const status of ["PAUSED", "ACTIVE"]) {
        expect(allowed, cls).toContain(metaExecActionType(cls, { status }));
      }
    }
  });

  it("the parked strategist review is NOT one of them, and is not a meta_ads class", () => {
    expect(EXECUTABLE).not.toContain(PENDING_STRATEGIST_CLASS);
    expect(PENDING_STRATEGIST_CLASS.startsWith("meta_ads.")).toBe(false);
  });

  it("the archive statement leaves the create class alone, because it has a second emitter", () => {
    const sql = fs.readFileSync(
      path.join(BACKEND, "../../supabase/migrations/20260920030100_channel_actions_meta_ads_exec_archive.sql"),
      "utf8",
    );
    expect(sql).toContain("<> 'meta_ads.create_ad_set'");
    expect(sql).toContain("r.channel_slug = 'meta_ads'");
    expect(sql).toContain("status = 'archived'");
    expect(sql).not.toContain("dispatched_at =");
  });

  it("the wave file itself closes recipe steps and nothing else", () => {
    const sql = fs.readFileSync(
      path.join(BACKEND, "../../supabase/migrations/20260920030000_channel_actions_wave5_meta_ads_archive.sql"),
      "utf8",
    );
    const statements = sql.replace(/--[^\n]*/g, "").split(";").filter((s) => /update decisions/i.test(s));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("d.decision_class = 'channel.recipe_step'");
    expect(statements[0]).toContain("r.channel_slug = 'meta_ads'");
  });
});

vi.mock("@/services/growth/channel-stopped", () => ({ readChannelStopped: async () => false }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => {
    throw new Error("serviceClient must not be reached: the claim is injected");
  },
}));
vi.mock("../../../../workers/client", () => ({
  inngest: { createFunction: () => ({ id: "dispatch-channel-action" }), send: vi.fn() },
}));
const metaWriteEnabled = vi.fn(async () => false);
vi.mock("@/services/tools/meta-ads/write/_flag-check", () => ({
  isMetaAdsWriteEnabled: () => metaWriteEnabled(),
}));
const googleWriteEnabled = vi.fn(async () => true);
vi.mock("@/services/tools/google-ads/write/_flag-check", () => ({
  isGoogleAdsWriteEnabled: () => googleWriteEnabled(),
}));

import { runChannelActionMutation } from "../../../../workers/functions/dispatch-channel-action";

vi.mock("@/services/growth/preview-plan", () => ({
  channelPlanLock: vi.fn(async () => null),
  planIncludesChannel: vi.fn(async () => true),
}));

const TENANT = "22222222-2222-4222-8222-222222222222";
const ACTION = "99999999-9999-4999-8999-999999999999";

function metaDeps(execClass: string, graph: { calls: unknown[] }) {
  return {
    claim: vi.fn(async () => ({
      ok: true as const,
      row: {
        claim_id: "claim-1",
        tenant_id: TENANT,
        channel_slug: "meta_ads",
        exec_class: execClass,
        exec_payload: { object_id: "23851", level: "adset", status: "PAUSED" },
        approved_by: "aaaaaaaa-0000-4000-8000-000000000001",
        approved_by_source: null,
        agent_run_id: "run-1",
      },
    })),
    settle: vi.fn(async () => ({ ok: true, replayed: false })),
    loadHandler: async () => async (d: { body: Record<string, unknown> }) => {
      graph.calls.push(d.body);
      return { ok: true, notice: "done" };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  metaWriteEnabled.mockResolvedValue(false);
  googleWriteEnabled.mockResolvedValue(true);
});

describe("a meta card reaches the platform kill switch, which was dead before this wave", () => {
  it("a switched-off Meta surface stops the Graph call, and the Meta reader is what said so", async () => {
    const graph = { calls: [] as unknown[] };
    const out = await runChannelActionMutation(ACTION, metaDeps("meta_ads.set_status", graph));

    expect(metaWriteEnabled).toHaveBeenCalledTimes(1);
    expect(graph.calls).toHaveLength(0);
    expect(out.outcome).toMatchObject({ ok: false, skipped: "kill_switch" });
    expect(out.settle?.ok).toBe(false);
    expect(out.settle?.error).toMatch(/Meta Ads changes are switched off/);
    expect(out.settle?.result).toMatchObject({ kill_switch: true, platform: "meta_ads" });
  });

  it("GOOGLE's switch does not answer for Meta: the two are read independently", async () => {
    const graph = { calls: [] as unknown[] };
    await runChannelActionMutation(ACTION, metaDeps("meta_ads.update_ad_set_budget", graph));
    expect(googleWriteEnabled).not.toHaveBeenCalled();
    expect(graph.calls).toHaveLength(0);
  });

  it("with the Meta surface ON, the same row executes — so the gate is the only thing stopping it", async () => {
    metaWriteEnabled.mockResolvedValue(true);
    const graph = { calls: [] as unknown[] };
    const out = await runChannelActionMutation(ACTION, metaDeps("meta_ads.set_status", graph));

    expect(metaWriteEnabled).toHaveBeenCalledTimes(1);
    expect(graph.calls).toHaveLength(1);
    expect(out.outcome.ok).toBe(true);
  });

  it("an unreadable switch refuses the write rather than letting it through", async () => {
    metaWriteEnabled.mockRejectedValue(new Error("system_config down"));
    const graph = { calls: [] as unknown[] };
    const out = await runChannelActionMutation(ACTION, metaDeps("meta_ads.set_status", graph));
    expect(graph.calls).toHaveLength(0);
    expect(out.outcome).toMatchObject({ ok: false, skipped: "kill_switch" });
  });
});
