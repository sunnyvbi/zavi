import { describe, expect, it } from "vitest";
import {
  doneForYouAttemptOf,
  doneForYouKey,
  isDoneForYouIdentity,
  isDoneForYouRun,
  DEFAULT_TIER_AGENT_MIN,
} from "@/services/billing/tiers";
import { CREDIT_USD } from "@/services/agents/credits";
import {
  cannotDoOf,
  classifyAttempt,
  doneForYouEligibility,
  doneForYouNote,
  doneForYouResult,
  doneForYouState,
  isDoneForYouClaim,
  summarizeDoneForYou,
  DONE_FOR_YOU_MAX_BUDGET_USD,
  DONE_FOR_YOU_STALE_MS,
  type DfyActionRow,
  type DfyAttemptRow,
} from "../done-for-you";
import { isDoneForYouAllowedTool, withDoneForYouBudget } from "../done-for-you-tools";

const T = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ACTION = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-10-29T12:00:00Z");
const facts = { hasRecipe: () => true };

function row(over: Partial<DfyActionRow> & { deliverable?: string | null; intent?: string; action_type?: string; target?: string } = {}): DfyActionRow {
  const { deliverable = null, intent, action_type, target, ...rest } = over;
  return {
    id: ACTION,
    channel_slug: "seo",
    status: "pending",
    snoozed_until: null,
    exec_class: null,
    exec_status: null,
    card_kind: "task",
    body: {
      ...(intent ? { intent } : {}),
      step: { title: "Check /pricing", body: "why", ...(action_type ? { action_type } : {}), ...(target ? { target: { kind: target } } : {}), ...(deliverable ? { deliverable: { kind: deliverable } } : {}) },
    },
    ...rest,
  };
}

const elig = (r: DfyActionRow, prior = new Set<string>()) => doneForYouEligibility(r, NOW, prior, facts);

describe("doneForYouEligibility", () => {
  it("a research task on a Starter channel is eligible in research mode", () => {
    for (const d of [null, "list", "brief", "proof_topics", "other"]) {
      expect(elig(row({ deliverable: d }))).toEqual({ eligible: true, mode: "research" });
    }
    for (const slug of ["geo", "reddit_organic", "x_organic", "linkedin_organic", "instagram_organic"]) {
      expect(elig(row({ channel_slug: slug }))).toEqual({ eligible: true, mode: "research" });
    }
  });

  it("an instagram or pinterest post with a post or script deliverable is visual", () => {
    expect(elig(row({ channel_slug: "instagram_organic", card_kind: "post", deliverable: "post" }))).toEqual({ eligible: true, mode: "visual" });
    expect(elig(row({ channel_slug: "pinterest_organic", card_kind: "copy_to_site", deliverable: "script" }))).toEqual({ eligible: true, mode: "visual" });
  });

  it("refuses with the spec's reason codes", () => {
    expect(elig(row({ channel_slug: "x_organic", card_kind: "post", deliverable: "post" }))).toEqual({ eligible: false, reason: "needs_account" });
    expect(elig(row({ card_kind: "message" }))).toEqual({ eligible: false, reason: "needs_account" });
    for (const d of ["page_copy", "code", "comment"]) {
      expect(elig(row({ card_kind: "copy_to_site", deliverable: d }))).toEqual({ eligible: false, reason: "already_final" });
    }
    expect(elig(row({ intent: "answer" }))).toEqual({ eligible: false, reason: "needs_founder" });
    expect(elig(row({ action_type: "connect_account" }))).toEqual({ eligible: false, reason: "needs_founder" });
    expect(elig(row({ card_kind: "plan" }))).toEqual({ eligible: false, reason: "not_a_card_task" });
    expect(elig(row({ deliverable: "strategy" }))).toEqual({ eligible: false, reason: "not_a_card_task" });
    expect(elig(row({ deliverable: "page_copy" }))).toEqual({ eligible: false, reason: "not_a_card_task" });
    expect(elig(row({ channel_slug: "instagram_organic", card_kind: "post", deliverable: "page_copy" }))).toEqual({ eligible: false, reason: "not_a_card_task" });
    expect(elig(row(), new Set([ACTION]))).toEqual({ eligible: false, reason: "cannot_do_before" });
  });

  it("never offers a change to the founder's own social profile, whatever else the channel can do", () => {
    for (const slug of ["instagram_organic", "x_organic", "linkedin_organic", "reddit_organic"]) {
      expect(elig(row({ channel_slug: slug, target: "profile" }))).toEqual({ eligible: false, reason: "needs_account" });
      expect(elig(row({ channel_slug: slug, target: "post" }))).toEqual({ eligible: true, mode: "research" });
    }
    expect(elig(row({ channel_slug: "geo", target: "profile" }))).toEqual({ eligible: true, mode: "research" });
  });

  it("never offers an ad or spend change", () => {
    expect(elig(row({ exec_class: "meta_ads.update_budget" }))).toEqual({ eligible: false, reason: "not_a_card_task" });
    expect(elig(row({ exec_status: "failed" }))).toEqual({ eligible: false, reason: "not_a_card_task" });
  });

  it("only Starter channels Free can preview, never generated_video, a Pro channel or one with no recipe", () => {
    expect(elig(row({ channel_slug: "generated_video" }))).toEqual({ eligible: false, reason: "channel_not_free_previewable" });
    expect(elig(row({ channel_slug: "meta_ads" }))).toEqual({ eligible: false, reason: "channel_not_free_previewable" });
    expect(elig(row({ channel_slug: "tiktok_organic" }))).toEqual({ eligible: false, reason: "channel_not_free_previewable" });
    expect(doneForYouEligibility(row(), NOW, new Set(), { hasRecipe: () => false })).toEqual({ eligible: false, reason: "channel_not_free_previewable" });
    expect(doneForYouEligibility(row(), NOW, new Set(), { hasRecipe: () => true, agentMin: { ...DEFAULT_TIER_AGENT_MIN, seo: "pro" } })).toEqual({
      eligible: false,
      reason: "channel_not_free_previewable",
    });
  });

  it("a closed card, or one snoozed until later, is not offered; an expired snooze is", () => {
    expect(elig(row({ status: "acted" }))).toEqual({ eligible: false, reason: "not_open" });
    expect(elig(row({ status: "snoozed", snoozed_until: "2026-10-30T00:00:00Z" }))).toEqual({ eligible: false, reason: "snoozed" });
    expect(elig(row({ status: "snoozed", snoozed_until: "2026-10-28T00:00:00Z" }))).toEqual({ eligible: true, mode: "research" });
  });
});

describe("the run identity", () => {
  const run = (over: Record<string, unknown> = {}) => ({
    trigger: "channel_recipe",
    enqueuedByUser: false,
    payload: null,
    cronDedupeKey: doneForYouKey(T, 1),
    ...over,
  });

  it("keys name the tenant and an attempt 1..3", () => {
    expect(doneForYouKey(T, 2)).toBe(`done-for-you:${T}:2`);
    expect(doneForYouAttemptOf(T, doneForYouKey(T, 3))).toBe(3);
    expect(doneForYouAttemptOf(T, `done-for-you:${T}:4`)).toBeNull();
    expect(doneForYouAttemptOf(T, doneForYouKey(OTHER, 1))).toBeNull();
  });

  it("is a server-written channel_recipe row with its own tenant's key", () => {
    expect(isDoneForYouIdentity(T, run())).toBe(true);
    expect(isDoneForYouRun(T, "seo", run())).toBe(true);
    expect(isDoneForYouIdentity(OTHER, run())).toBe(false);
    expect(isDoneForYouIdentity(T, run({ trigger: "chat" }))).toBe(false);
    expect(isDoneForYouIdentity(T, run({ enqueuedByUser: true }))).toBe(false);
    expect(isDoneForYouIdentity(T, run({ cronDedupeKey: `done-for-you:${T}:4` }))).toBe(false);
    expect(isDoneForYouRun(T, "meta_ads", run())).toBe(false);
    expect(isDoneForYouRun(T, "engineer", run())).toBe(false);
    expect(isDoneForYouClaim({ tenant_id: T, trigger: "channel_recipe", enqueued_by: null, cron_dedupe_key: doneForYouKey(T, 1) })).toBe(true);
    expect(isDoneForYouClaim({ tenant_id: T, trigger: "channel_recipe", enqueued_by: USER, cron_dedupe_key: doneForYouKey(T, 1) })).toBe(false);
  });
});

describe("the run's limits", () => {
  it("caps model spend at 1,000 credits, keeping a lower cap, and leaves other runs alone", () => {
    expect(DONE_FOR_YOU_MAX_BUDGET_USD).toBeCloseTo(1000 * CREDIT_USD, 10);
    expect(withDoneForYouBudget({ effort: "high" }, true)).toEqual({ effort: "high", maxBudgetUsd: DONE_FOR_YOU_MAX_BUDGET_USD });
    expect(withDoneForYouBudget({ maxBudgetUsd: 1 }, true)).toEqual({ maxBudgetUsd: 1 });
    expect(withDoneForYouBudget({ maxBudgetUsd: 50 }, true)).toEqual({ maxBudgetUsd: DONE_FOR_YOU_MAX_BUDGET_USD });
    expect(withDoneForYouBudget({ effort: "high" }, false)).toEqual({ effort: "high" });
  });

  it("allows reads, memory search and one social render; denies every write and paid generation", () => {
    for (const t of ["web_fetch__fetch", "web_search__search", "memory__search", "report__render_social_image", "mcp__praxis-server__web_fetch__fetch"]) {
      expect(isDoneForYouAllowedTool(t)).toBe(true);
    }
    for (const t of ["social__propose_post", "memory__write", "seo__propose_pr", "geo__propose_pr", "report__generate_image", "report__render_pdf", "praxis__remind", "meta_ads__update_budget"]) {
      expect(isDoneForYouAllowedTool(t)).toBe(false);
    }
  });

  it("builds the note on the server from the mode and the card's own why", () => {
    expect(doneForYouNote("research", "Google can't read it")).toContain("check it with your read tools");
    expect(doneForYouNote("visual", null)).toContain("make the finished post images and caption");
  });
});

const att = (n: number, over: Partial<DfyAttemptRow> = {}): DfyAttemptRow => ({
  id: `run-${n}`,
  cron_dedupe_key: doneForYouKey(T, n),
  trigger: "channel_recipe",
  enqueued_by: null,
  status: "success",
  enqueued_at: new Date(NOW - 60_000).toISOString(),
  payload: { done_for_you: { action_id: ACTION, attempt: n, mode: "research", by_user_id: USER }, channel_slug: "seo" },
  parsed: { rendered_markdown: "Google reads the pricing text fine. Next: add the FAQ block.", steps: [{ title: "Pricing text is readable", body: "x" }] },
  output_text: null,
  ...over,
});
const gates = { enabled: true, tier: "free" as const };

describe("attempts and state", () => {
  it("classifies success, can't do (title or first markdown line), failure and stale runs", () => {
    expect(classifyAttempt(T, att(1), NOW)?.outcome).toBe("executed");
    expect(classifyAttempt(T, att(1, { parsed: { rendered_markdown: "", steps: [{ title: "Can't do: your sales numbers" }] } }), NOW)?.outcome).toBe("cannot_do");
    expect(cannotDoOf({ rendered_markdown: "**Can't do:** the account login\n\nmore", steps: [] })).toBe("the account login");
    expect(classifyAttempt(T, att(1, { parsed: { rendered_markdown: "", steps: [] } }), NOW)?.outcome).toBe("failed");
    for (const st of ["failed", "dispatch_error", "error", "parse_failed", "cancelled"]) {
      expect(classifyAttempt(T, att(1, { status: st }), NOW)?.outcome).toBe("failed");
    }
    expect(classifyAttempt(T, att(1, { status: "running" }), NOW)?.outcome).toBe("running");
    expect(classifyAttempt(T, att(1, { status: "queued", enqueued_at: new Date(NOW - DONE_FOR_YOU_STALE_MS).toISOString() }), NOW)).toMatchObject({
      outcome: "failed",
      stale: true,
    });
  });

  it("a row that is not a server-written run is not an attempt, but still holds its key", () => {
    expect(classifyAttempt(T, att(1, { trigger: "chat" }), NOW)).toBeNull();
    expect(classifyAttempt(T, att(1, { enqueued_by: USER }), NOW)).toBeNull();
    const s = summarizeDoneForYou(T, [att(1, { trigger: "chat" })], gates, NOW);
    expect(s).toMatchObject({ state: "available", nextAttempt: 2 });
  });

  it("follows the spec's precedence: running, done, unavailable, used up, available", () => {
    const c = (n: number, over: Partial<DfyAttemptRow> = {}) => classifyAttempt(T, att(n, over), NOW)!;
    expect(doneForYouState([], gates)).toMatchObject({ state: "available", nextAttempt: 1 });
    expect(doneForYouState([c(1, { status: "running" })], gates).state).toBe("running");
    expect(doneForYouState([c(1)], { enabled: false, tier: "pro" }).state).toBe("done");
    expect(doneForYouState([], { enabled: false, tier: "free" }).state).toBe("unavailable");
    expect(doneForYouState([], { enabled: true, tier: "starter" }).state).toBe("unavailable");
    expect(doneForYouState([], { enabled: null, tier: "free" }).state).toBe("unavailable");
    expect(doneForYouState([], { enabled: true, tier: null }).state).toBe("unavailable");
    expect(doneForYouState([c(1, { status: "failed" })], gates)).toMatchObject({ state: "available", nextAttempt: 2 });
    const cant = c(1, { parsed: { rendered_markdown: "Can't do: a login", steps: [] } });
    const s = doneForYouState([cant], gates);
    expect(s).toMatchObject({ state: "available", nextAttempt: 2 });
    expect([...s.priorCantDo]).toEqual([ACTION]);
    const three = [1, 2, 3].map((n) => c(n, { status: "failed" }));
    expect(doneForYouState(three, gates)).toMatchObject({ state: "used_up", nextAttempt: null });
    expect(doneForYouState([c(1, { status: "failed" }), c(2, { status: "failed" }), c(3)], gates).state).toBe("done");
    const stale = c(1, { status: "running", enqueued_at: new Date(NOW - DONE_FOR_YOU_STALE_MS - 1).toISOString() });
    expect(doneForYouState([stale], gates)).toMatchObject({ state: "available", nextAttempt: 2 });
  });

  it("the first success is the one winner", () => {
    const a = classifyAttempt(T, att(1), NOW)!;
    const b = classifyAttempt(T, att(2), NOW)!;
    expect(doneForYouState([b, a], gates).winner?.run_id).toBe("run-1");
  });

  it("the result is the run's markdown plus the post caption", () => {
    expect(
      doneForYouResult({
        parsed: { rendered_markdown: "Two slides ready.", steps: [{ title: "Post", deliverable: { kind: "post", content: "Caption here" } }] },
        output_text: null,
      }),
    ).toEqual({ markdown: "Two slides ready.", caption: "Caption here" });
    expect(doneForYouResult({ parsed: null, output_text: "fallback text" })).toEqual({ markdown: "fallback text", caption: null });
    expect(doneForYouResult({ parsed: null, output_text: null })).toBeNull();
  });
});

describe("a done-for-you run is never re-run on the house", () => {
  it("is pinned to the inline Claude funnel (where its spend cap lives), past any override, canary or staff model", async () => {
    const { resolveLiveSdkFunnel } = await import("@/services/agents/engine/sdk-funnel-route");
    for (const args of [
      { agentSlug: "seo", resolvedProvider: "openai" as const, anthropicEngineEnabled: false },
      { agentSlug: "seo", resolvedProvider: "anthropic" as const, anthropicEngineEnabled: true },
      { agentSlug: "seo", resolvedProvider: "anthropic" as const, anthropicEngineEnabled: false, staffModel: true },
    ]) {
      expect(resolveLiveSdkFunnel({ ...args, pinInline: true })).toMatchObject({ route: "inline_anthropic", useAnthropicEngine: false, providerForRun: "anthropic" });
    }
    expect(resolveLiveSdkFunnel({ agentSlug: "seo", resolvedProvider: "anthropic", anthropicEngineEnabled: true }).route).toBe("anthropic_engine");
  });

  it("is not infra-retried (the outage retry never takes channel_recipe runs)", async () => {
    const { willBeInfraRetried } = await import("@/services/agents/infra-retry");
    const base = { id: "r", tenant_id: T, agent_slug: "seo", status: "dispatch_error", error: "x", infra_retry_count: 0, last_progress_at: null };
    expect(willBeInfraRetried(base)).toBe(true);
    expect(willBeInfraRetried({ ...base, payload: { done_for_you: { action_id: ACTION } } })).toBe(false);
  });
});
