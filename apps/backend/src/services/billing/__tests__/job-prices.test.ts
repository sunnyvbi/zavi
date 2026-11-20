import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { JOB_PRICES, JobPricesSchema, priceForJob, priceForMedia, channelAgentSlugs } from "../job-prices";
import { MEDIA_TASKS } from "@/services/media-router/types";

const id = (f: Parameters<typeof priceForJob>[0]) => priceForJob(f)?.id ?? null;

describe("flat job prices: the config", () => {
  it("parses: unique ids, every rule names its agent", () => {
    expect(() => JobPricesSchema.parse(JOB_PRICES)).not.toThrow();
  });

  it("prices every agent folder and every channel (a new agent must add a row)", () => {
    const agentsRoot = path.join(process.cwd(), "src", "agents");
    const slugs = fs
      .readdirSync(agentsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !["lib", "__tests__"].includes(d.name))
      .map((d) => d.name);
    const unpriced = slugs.filter((s) => !priceForJob({ agent_slug: s, trigger: "chat" }) && !priceForJob({ agent_slug: s, trigger: "channel_recipe" }));
    expect(unpriced).toEqual([]);
    for (const ch of channelAgentSlugs()) {
      expect(priceForJob({ agent_slug: ch, trigger: "channel_recipe" })?.id, ch).toMatch(/^channel-run/);
    }
  });

  it("prices every media task", () => {
    expect(MEDIA_TASKS.filter((t) => !priceForMedia(t))).toEqual([]);
  });
});

describe("flat job prices: which job a run is", () => {
  it("cgo: alarm, scheduled and founder reviews, plans, setup plan, chat", () => {
    const cgo = (trigger: string, payload: Record<string, unknown>) => id({ agent_slug: "cgo", trigger, payload });
    expect(cgo("a2a", { stage: "own_goals", note_kind: "alarm" })).toBe("cgo-goal-review-alarm");
    expect(cgo("a2a", { stage: "own_goals", note_kind: "scheduled" })).toBe("cgo-goal-review-scheduled");
    expect(cgo("a2a", { stage: "own_goals", note_kind: "founder" })).toBe("cgo-goal-review-founder");
    expect(cgo("manual", { stage: "draft_strategy" })).toBe("cgo-growth-plan");
    expect(cgo("a2a", { stage: "draft_strategy", origin: "setup_draft" })).toBe("cgo-growth-plan-setup");
    expect(cgo("chat", { thread_id: "t" })).toBe("cgo-chat");
  });

  it("channels: signup preview is free, runs priced per channel, subtasks cheaper", () => {
    expect(priceForJob({ agent_slug: "seo", trigger: "channel_recipe", cron_dedupe_key: "first-run-preview:t:seo" })).toMatchObject({ id: "channel-signup-preview", credits: 0 });
    expect(id({ agent_slug: "reddit_organic", trigger: "channel_recipe" })).toBe("channel-run-reddit_organic");
    expect(id({ agent_slug: "seo", trigger: "channel_recipe" })).toBe("channel-run");
    expect(id({ agent_slug: "meta_ads", trigger: "a2a", payload: { source_agent_slug: "cgo" } })).toBe("channel-subtask-growth");
    expect(id({ agent_slug: "meta_ads", trigger: "handoff", payload: { source_agent_slug: "operator" } })).toBe("channel-subtask");
    expect(priceForJob({ agent_slug: "meta_ads", trigger: "cron", payload: { stage: "cgo_ad_orders" } })).toMatchObject({ id: "ads-cron-record", credits: 0 });
  });

  it("builds: scaffold, repair, refine and build stages are told apart", () => {
    const eng = (payload: Record<string, unknown>) => id({ agent_slug: "engineer", trigger: "a2a", payload });
    expect(eng({ stage: "scaffold" })).toBe("build-scaffold");
    expect(eng({ stage: "scaffold", repair_mode: true })).toBe("build-repair");
    expect(eng({ stage: "build", repair_mode: "true" })).toBe("build-repair");
    expect(eng({ stage: "build", refine_mode: true })).toBe("build-refine");
    expect(eng({ stage: "build" })).toBe("build-build");
    expect(id({ agent_slug: "pm", trigger: "a2a", payload: { stage: "spec" } })).toBe("build-spec");
    expect(id({ agent_slug: "qa", trigger: "a2a", payload: { stage: "refine_gate" } })).toBe("build-qa");
    expect(id({ agent_slug: "engineer", trigger: "chat" })).toBe("engineer-chat");
    expect(id({ agent_slug: "engineer", trigger: "slack" })).toBe("engineer-code-task");
  });

  it("operator, custom agents, research", () => {
    expect(id({ agent_slug: "operator", trigger: "slack" })).toBe("operator-chat");
    expect(id({ agent_slug: "operator", trigger: "cron" })).toBe("operator-scheduled");
    expect(id({ agent_slug: "c-3f22c80dc1", trigger: "cron" })).toBe("custom-agent");
    expect(id({ agent_slug: "research", trigger: "a2a" })).toBe("research-for-growth");
    expect(id({ agent_slug: "research", trigger: "chat" })).toBe("research");
  });

  it("an unknown agent matches nothing (so the coverage test catches it)", () => {
    expect(priceForJob({ agent_slug: "brand-new-agent", trigger: "chat" })).toBeNull();
  });

  it("a founder-written payload never buys a cheaper job type", () => {
    expect(priceForJob({ agent_slug: "engineer", trigger: "manual", payload: { repair_mode: "true" } })?.credits).toBe(
      priceForJob({ agent_slug: "engineer", trigger: "manual" })?.credits,
    );
    expect(priceForJob({ agent_slug: "cgo", trigger: "manual", payload: { stage: "draft_strategy" } })?.id).toBe("cgo-growth-plan");
    expect(priceForJob({ agent_slug: "engineer", trigger: "a2a", payload: { repair_mode: "true" } })?.id).toBe("build-repair");
  });
  it("only scalar payload values match a rule", () => {
    expect(priceForJob({ agent_slug: "engineer", trigger: "a2a", payload: { repair_mode: ["true"] } })?.id).not.toBe("build-repair");
    expect(priceForJob({ agent_slug: "engineer", trigger: "a2a", payload: { repair_mode: true } })?.id).toBe("build-repair");
  });
});
