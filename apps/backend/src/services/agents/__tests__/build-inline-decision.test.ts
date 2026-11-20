
import { describe, it, expect, vi } from "vitest";
import {
  buildInlineDecisionBody,
  maybeEmitInlineConfirmCard,
  type MaybeEmitInlineCardInput,
  type MaybeEmitInlineCardDeps,
} from "../build-inline-decision";

type EmitFn = MaybeEmitInlineCardDeps["emit"];

const DECISION_ID = "11111111-1111-4111-8111-111111111111";

describe("buildInlineDecisionBody — budget-review (spend) card", () => {
  it("builds an enriched card for a gated (review) budget decision", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "meta_ads.update_ad_set_budget_review",
      body: {
        ad_set_id: "act_123_adset_999",
        daily_budget_usd: 144,
        expected_current_daily_budget_usd: 72,
        rationale: "ROAS dropped from 3.1 to 1.4 over 7d — secret strategy",
        over_cap: true,
        origin: "user_initiated_chat",
      },
    });
    expect(card).not.toBeNull();
    expect(card!.decision_id).toBe(DECISION_ID);
    expect(card!.decision_class).toBe("meta_ads.update_ad_set_budget_review");
    expect(card!.before_usd).toBe(72);
    expect(card!.after_usd).toBe(144);
    expect(card!.subject).toBe("act_123_adset_999");
    expect(card!.summary).toBe("Tap below to apply this budget change.");
    expect(card!.title).toBe("Raise ad set act_123_adset_999 from $72 to $144 a day");
  });

  it("never copies the rationale / raw content into the card (C14)", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "meta_ads.update_ad_set_budget_review",
      body: {
        ad_set_id: "adset_1",
        daily_budget_usd: 10,
        expected_current_daily_budget_usd: 5,
        rationale: "SECRET-RATIONALE-SENTINEL",
        over_cap: true,
        origin: "user_initiated_chat",
      },
    });
    const json = JSON.stringify(card);
    expect(json).not.toContain("SECRET-RATIONALE-SENTINEL");
  });

  it("asks which campaign only when the propose tool stamped an ambiguous match", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "meta_ads.update_ad_set_budget_review",
      body: {
        ad_set_id: "adset_maybe",
        daily_budget_usd: 80,
        expected_current_daily_budget_usd: 40,
        rationale: "x",
        over_cap: false,
        match_unsure: "ambiguous_match",
      },
    });
    expect(card).not.toBeNull();
    expect(card!.summary).toMatch(/which campaign/i);
  });

  it("an agent's own gated proposal (no origin, no ambiguity) never asks which campaign (bug #13)", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "meta_ads.update_ad_set_budget_review",
      body: {
        ad_set_id: "adset_7",
        name: "Austin prospecting",
        daily_budget_usd: 50,
        expected_current_daily_budget_usd: 40,
        rationale: "x",
        over_cap: true,
      },
    });
    expect(card!.summary).toBe("Tap below to apply this budget change.");
    expect(card!.summary).not.toMatch(/which campaign/i);
    expect(card!.title).toBe("Raise “Austin prospecting” (ad set adset_7) from $40 to $50 a day");
  });

  it("returns NULL for the auto (executes-directly) budget class — no card", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "meta_ads.update_ad_set_budget",
      body: {
        ad_set_id: "adset_1",
        daily_budget_usd: 50,
        expected_current_daily_budget_usd: 40,
        rationale: "x",
        over_cap: false,
      },
    });
    expect(card).toBeNull();
  });

  it("returns NULL for an unrelated decision class", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "engineer.open_pr",
      body: { repo: "x", branch: "y" },
    });
    expect(card).toBeNull();
  });

  it("returns NULL for a non-budget meta_ads review class (no card design yet)", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "meta_ads.set_status_review",
      body: { object_id: "c1", level: "campaign", status: "ACTIVE", over_cap: false },
    });
    expect(card).toBeNull();
  });

  it("degrades gracefully on a malformed body (no numeric budgets)", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "meta_ads.update_ad_set_budget_review",
      body: { ad_set_id: "adset_1", origin: "user_initiated_chat" },
    });
    expect(card).not.toBeNull();
    expect(card!.before_usd).toBeUndefined();
    expect(card!.after_usd).toBeUndefined();
    expect(card!.title).toMatch(/confirm budget change/i);
  });
});

describe("buildInlineDecisionBody — agent.urgent_advisory card", () => {
  it("builds a Got-it/Dismiss advisory card from an advisory body", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "agent.urgent_advisory",
      body: {
        title: "Runway dips below 3 months in May",
        summary:
          "At current burn you cross the 3-month line on May 14. Acknowledge or dismiss.",
        subject: "finance",
      },
    });
    expect(card).not.toBeNull();
    expect(card!.decision_class).toBe("agent.urgent_advisory");
    expect(card!.title).toBe("Runway dips below 3 months in May");
    expect(card!.summary).toMatch(/acknowledge or dismiss/i);
    expect(card!.subject).toBe("finance");
    expect(card!.before_usd).toBeUndefined();
    expect(card!.after_usd).toBeUndefined();
  });

  it("falls back to safe default copy when the advisory body omits title/summary", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "agent.urgent_advisory",
      body: {},
    });
    expect(card).not.toBeNull();
    expect(card!.title.length).toBeGreaterThan(0);
    expect(card!.summary!.length).toBeGreaterThan(0);
  });

  it("caps over-long advisory strings to the schema bound (fails soft, not a throw)", () => {
    const card = buildInlineDecisionBody({
      decision_id: DECISION_ID,
      decision_class: "agent.urgent_advisory",
      body: { title: "T".repeat(400), summary: "S".repeat(400) },
    });
    expect(card).not.toBeNull();
    expect(card!.title.length).toBeLessThanOrEqual(280);
    expect(card!.summary!.length).toBeLessThanOrEqual(280);
  });

  it.each([
    ["ad_set_id", { ad_set_id: "adset_1", title: "x", summary: "y" }],
    ["daily_budget", { daily_budget: 100, title: "x", summary: "y" }],
    ["daily_budget_usd", { daily_budget_usd: 100, title: "x", summary: "y" }],
    [
      "authorized_effective_cap",
      { authorized_effective_cap: 500, title: "x", summary: "y" },
    ],
    ["amount_usd", { amount_usd: 50, title: "x", summary: "y" }],
    ["object_id", { object_id: "c1", title: "x", summary: "y" }],
  ])(
    "REFUSES an advisory body carrying a spend/executable field (%s) — returns null",
    (_label, body) => {
      const card = buildInlineDecisionBody({
        decision_id: DECISION_ID,
        decision_class: "agent.urgent_advisory",
        body,
      });
      expect(card).toBeNull();
    },
  );
});

describe("maybeEmitInlineConfirmCard (per-class flag gate)", () => {
  const budgetChat: MaybeEmitInlineCardInput = {
    decision_id: DECISION_ID,
    decision_class: "meta_ads.update_ad_set_budget_review",
    body: {
      ad_set_id: "adset_1",
      daily_budget_usd: 144,
      expected_current_daily_budget_usd: 72,
      rationale: "x",
      over_cap: true,
      origin: "user_initiated_chat",
    },
    run_trigger: "chat",
    thread_id: "thread-abc",
    agent_run_id: "run-abc",
    agent_slug: "performance-marketer",
    tenant_id: "tenant-abc",
  };

  const advisoryChat: MaybeEmitInlineCardInput = {
    decision_id: DECISION_ID,
    decision_class: "agent.urgent_advisory",
    body: { title: "Runway alert", summary: "Acknowledge or dismiss." },
    run_trigger: "chat",
    thread_id: "thread-abc",
    agent_run_id: "run-abc",
    agent_slug: "advisor",
    tenant_id: "tenant-abc",
  };

  const bothOn = {
    isSpendFlagOn: async () => true,
    isUrgentCardsFlagOn: async () => true,
  };
  const bothOff = {
    isSpendFlagOn: async () => false,
    isUrgentCardsFlagOn: async () => false,
  };

  it("emits an inline budget card when the SPEND flag is ON", async () => {
    let captured: Parameters<EmitFn>[0] | undefined;
    const emit: EmitFn = async (e) => {
      captured = e;
    };
    const emitted = await maybeEmitInlineConfirmCard(budgetChat, {
      ...bothOn,
      emit,
    });
    expect(emitted).toBe(true);
    expect(captured!.kind).toBe("decision");
    expect(captured!.agent_run_id).toBe("run-abc");
    expect(captured!.thread_id).toBe("thread-abc");
    expect(captured!.body.after_usd).toBe(144);
  });

  it("emits an advisory card when the URGENT-CARDS flag is ON", async () => {
    let captured: Parameters<EmitFn>[0] | undefined;
    const emit: EmitFn = async (e) => {
      captured = e;
    };
    const emitted = await maybeEmitInlineConfirmCard(advisoryChat, {
      ...bothOn,
      emit,
    });
    expect(emitted).toBe(true);
    expect(captured!.body.decision_class).toBe("agent.urgent_advisory");
    expect(captured!.body.title).toBe("Runway alert");
  });

  it("BOTH flags OFF → emits nothing for either class (byte-identical to pre-feature)", async () => {
    const emit = vi.fn(async () => {});
    expect(await maybeEmitInlineConfirmCard(budgetChat, { ...bothOff, emit })).toBe(false);
    expect(await maybeEmitInlineConfirmCard(advisoryChat, { ...bothOff, emit })).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("INDEPENDENCE: urgent ON + spend OFF → advisory card emits, budget card does NOT", async () => {
    const flags = {
      isSpendFlagOn: async () => false,
      isUrgentCardsFlagOn: async () => true,
    };
    const advisoryEmit = vi.fn(async () => {});
    const budgetEmit = vi.fn(async () => {});

    const advisoryEmitted = await maybeEmitInlineConfirmCard(advisoryChat, {
      ...flags,
      emit: advisoryEmit,
    });
    const budgetEmitted = await maybeEmitInlineConfirmCard(budgetChat, {
      ...flags,
      emit: budgetEmit,
    });

    expect(advisoryEmitted).toBe(true);
    expect(advisoryEmit).toHaveBeenCalledOnce();
    expect(budgetEmitted).toBe(false);
    expect(budgetEmit).not.toHaveBeenCalled();
  });

  it("INDEPENDENCE: spend ON + urgent OFF → budget card emits, advisory card does NOT", async () => {
    const flags = {
      isSpendFlagOn: async () => true,
      isUrgentCardsFlagOn: async () => false,
    };
    const advisoryEmit = vi.fn(async () => {});
    const budgetEmit = vi.fn(async () => {});

    expect(
      await maybeEmitInlineConfirmCard(budgetChat, { ...flags, emit: budgetEmit }),
    ).toBe(true);
    expect(
      await maybeEmitInlineConfirmCard(advisoryChat, { ...flags, emit: advisoryEmit }),
    ).toBe(false);
    expect(budgetEmit).toHaveBeenCalledOnce();
    expect(advisoryEmit).not.toHaveBeenCalled();
  });

  it("REGRESSION: a non-chat (cron/scheduled/autonomous) decision is NOT inlined", async () => {
    const emit = vi.fn(async () => {});
    const emitted = await maybeEmitInlineConfirmCard(
      { ...advisoryChat, run_trigger: "scheduled", thread_id: null },
      { ...bothOn, emit },
    );
    expect(emitted).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("REGRESSION: a chat run without a thread_id is NOT inlined", async () => {
    const emit = vi.fn(async () => {});
    const emitted = await maybeEmitInlineConfirmCard(
      { ...advisoryChat, thread_id: null },
      { ...bothOn, emit },
    );
    expect(emitted).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("an AUTO-class budget decision in chat emits no card (executes directly)", async () => {
    const emit = vi.fn(async () => {});
    const emitted = await maybeEmitInlineConfirmCard(
      { ...budgetChat, decision_class: "meta_ads.update_ad_set_budget" },
      { ...bothOn, emit },
    );
    expect(emitted).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("E3: an advisory body carrying a spend field emits NOTHING even with urgent flag ON", async () => {
    const emit = vi.fn(async () => {});
    const emitted = await maybeEmitInlineConfirmCard(
      {
        ...advisoryChat,
        body: { title: "x", summary: "y", ad_set_id: "adset_1", daily_budget_usd: 999 },
      },
      { ...bothOn, emit },
    );
    expect(emitted).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("email send cards (email_campaign.create_and_send, bulk_outbound.send)", () => {
  for (const cls of ["email_campaign.create_and_send", "bulk_outbound.send"]) {
    it(`${cls}: the inline card carries the id only, and is emitted with every flag off`, async () => {
      const body = buildInlineDecisionBody({ decision_id: DECISION_ID, decision_class: cls, body: { variants: [{ html: "<p>x</p>" }], audience_id: "L1" } });
      expect(body).toEqual({ decision_id: DECISION_ID, decision_class: cls, title: "Email to send" });
      const emit = vi.fn<Parameters<EmitFn>, ReturnType<EmitFn>>(async () => {});
      const emitted = await maybeEmitInlineConfirmCard(
        { decision_id: DECISION_ID, decision_class: cls, body: {}, run_trigger: "chat", thread_id: "thread-abc", agent_run_id: "run-abc", agent_slug: "email_marketing", tenant_id: "tenant-abc" },
        { isSpendFlagOn: async () => false, isUrgentCardsFlagOn: async () => false, emit },
      );
      expect(emitted).toBe(true);
      expect(emit.mock.calls[0][0].body).toEqual({ decision_id: DECISION_ID, decision_class: cls, title: "Email to send" });
    });
  }
});
