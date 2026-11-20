import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  modelOut: [] as Array<Record<string, unknown>>,
  prompts: [] as Array<{ system: string; user: string }>,
  writes: [] as Array<Record<string, unknown>>,
  writeIds: [] as string[],
  writeThrows: false,
  deleted: [] as string[],
  rawText: null as string | null,
  maxTokens: [] as number[],
}));

vi.mock("@/services/llm/call-model", () => ({
  callModel: vi.fn(async (req: { system: string; max_tokens: number; messages: Array<{ content: string }> }) => {
    H.prompts.push({ system: req.system, user: req.messages[0].content });
    H.maxTokens.push(req.max_tokens);
    const text = H.rawText ?? JSON.stringify({ artifacts: H.modelOut });
    return { text, usage: { input_tokens: 1, output_tokens: 1 } };
  }),
}));
vi.mock("../index", () => ({
  writeNote: vi.fn(async (_tid: string, input: Record<string, unknown>) => {
    if (H.writeThrows) throw new Error("db down");
    H.writes.push(input);
    return { note_id: H.writeIds.shift() ?? `new-${H.writes.length}`, chunks: 1, entities: 0, created: true };
  }),
  deleteNote: vi.fn(async (_tid: string, id: string) => {
    H.deleted.push(id);
  }),
  persistTypedGraph: vi.fn(async () => ({ entities: 0, relations: 0 })),
}));
vi.mock("../llm-entity-extract-flag", () => ({ isLlmEntityExtractEnabledForTenant: vi.fn(async () => true) }));
vi.mock("../extract", () => ({ extractEntitiesAndRelations: vi.fn(async () => ({ entities: [], relations: [] })) }));
vi.mock("@/services/logging/log-review", () => ({ logReview: vi.fn() }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../write-path", () => ({
  MAX_PROPOSALS_PER_RUN: 10,
  PROPOSAL_PROMPT_BODY_CHARS: 8000,
  defaultWriteGateDeps: {
    markProposalsDecided: vi.fn(async () => {}),
    loadExistingFacts: vi.fn(async () => []),
    recordWrites: vi.fn(async () => {}),
    supersedeForUpdate: vi.fn(async () => true),
    openConflictPair: vi.fn(async () => {}),
  },
}));

import { logReview } from "@/services/logging/log-review";
import { logEvent } from "@/services/logging/logEvent";
import {
  runDistill,
  distillBudgetTokens,
  operatorSentencesFor,
  CHAT_DISTILL_SYSTEM_PROMPT,
  AGENT_RUN_DISTILL_SYSTEM_PROMPT,
  type RunDistillInput,
} from "../distill";
import type { ExistingFact } from "../write-gate";

const TENANT = "11111111-1111-1111-1111-111111111111";
const RUN = "22222222-2222-2222-2222-222222222222";

const E1: ExistingFact = {
  ref: "E1",
  note_id: "old-launch",
  title: "Launch month",
  body: "The India launch is planned for June.",
  note_type: "tenant_project",
  subject: "india launch",
  attribute: "month",
  value_kind: "other",
  source_class: "user_stated",
  trust_tier: 2,
  recalled: false,
};
const R1: ExistingFact = {
  ...E1,
  ref: "R1",
  note_id: "recalled-rate",
  title: "Take rate",
  body: "Current take rate is 15%.",
  note_type: "tenant_reference",
  subject: "take rate",
  attribute: "current value",
  value_kind: "rate",
  recalled: true,
};

function makeDeps(existing: ExistingFact[]) {
  return {
    loadExistingFacts: vi.fn(async () => existing),
    recordWrites: vi.fn(async (_t: string, _e: Array<Record<string, unknown>>) => {}),
    supersedeForUpdate: vi.fn(async () => true),
    openConflictPair: vi.fn(async () => {}),
    markProposalsDecided: vi.fn(async (_t: string, _ids: string[]) => {}),
    stampCustomAgentProvenance: vi.fn(async () => true),
  };
}

function input(deps: ReturnType<typeof makeDeps>, over: Partial<RunDistillInput> = {}): RunDistillInput {
  return {
    tenant_id: TENANT,
    source: "auto_distill_chat" as const,
    source_ref: RUN,
    systemPrompt: CHAT_DISTILL_SYSTEM_PROMPT,
    userPrompt: "## This turn\n**user**: the India launch moved to July",
    baseTags: [],
    thread_id: "33333333-3333-3333-3333-333333333333",
    gate: { ceiling: 0, queryText: "the India launch moved to July", run_id: RUN, thread_message_id: "44444444-4444-4444-4444-444444444444", deps },
    ...over,
  };
}

beforeEach(() => {
  H.modelOut = [];
  H.prompts = [];
  H.writes = [];
  H.writeIds = [];
  H.writeThrows = false;
  H.deleted = [];
  H.rawText = null;
  H.maxTokens = [];
  vi.mocked(logReview).mockClear();
  vi.mocked(logEvent).mockClear();
});

describe("runDistill with the write gate", () => {
  it("shows the extractor the saved notes in the same (single) call", async () => {
    const deps = makeDeps([E1, R1]);
    await runDistill(input(deps));
    expect(H.prompts).toHaveLength(1);
    expect(H.prompts[0].user).toContain("[E1]");
    expect(H.prompts[0].user).toContain("[R1] (recalled into this turn)");
    expect(deps.loadExistingFacts).toHaveBeenCalledWith(TENANT, { queryText: "the India launch moved to July", run_id: RUN });
  });

  it("an update on a key match writes the new note, marks the old out of date, logs 'updated'", async () => {
    const deps = makeDeps([E1]);
    H.modelOut = [
      {
        action: "update", target: "E1", note_type: "tenant_project", title: "Launch month",
        body_markdown: "The India launch moved to July.", subject: "India launch", attribute: "month",
        value_kind: "other", source: "user_stated", tags: [],
      },
    ];
    H.writeIds = ["new-launch"];
    const res = await runDistill(input(deps));
    expect(res.written).toBe(1);
    expect(H.writes[0]).toMatchObject({ subject: "india launch", attribute: "month", source_class: "user_stated", trust_tier: 0 });
    expect(deps.supersedeForUpdate).toHaveBeenCalledWith(TENANT, "new-launch", "old-launch");
    const log = deps.recordWrites.mock.calls[0][1];
    expect(log).toEqual([
      expect.objectContaining({
        action: "updated",
        note_id: "new-launch",
        matched_note_id: "old-launch",
        run_id: RUN,
        thread_message_id: "44444444-4444-4444-4444-444444444444",
      }),
    ]);
  });

  it("a duplicate and a reject are never written, but both are logged with their text", async () => {
    const deps = makeDeps([E1]);
    H.modelOut = [
      { action: "duplicate", target: "E1", note_type: "tenant_project", title: "Launch month", body_markdown: "India launch is in June.", subject: "india launch", attribute: "month", source: "user_stated" },
      { action: "reject", note_type: "tenant_reference", title: "Export", body_markdown: "The export worked today.", reason: "one-off status" },
    ];
    const res = await runDistill(input(deps));
    expect(res.written).toBe(0);
    expect(res.skipped).toBe(2);
    expect(H.writes).toHaveLength(0);
    const log = deps.recordWrites.mock.calls[0][1];
    expect(log.map((l) => l.action)).toEqual(["duplicate", "rejected"]);
    expect(log[0]).toMatchObject({ matched_note_id: "old-launch", candidate_body: "India launch is in June." });
  });

  it("restating a recalled note is a duplicate even when the model says add", async () => {
    const deps = makeDeps([R1]);
    H.modelOut = [
      { action: "add", note_type: "tenant_reference", title: "Take rate", body_markdown: "Current take rate is 15%.", subject: "take rate", attribute: "current value", source: "agent_inferred" },
    ];
    await runDistill(input(deps));
    expect(H.writes).toHaveLength(0);
    const log = deps.recordWrites.mock.calls[0][1];
    expect(log[0]).toMatchObject({ action: "duplicate", matched_note_id: "recalled-rate", reason: "restates_recalled_note" });
  });

  it("a new rate for the same key keeps both and opens a two-values pair", async () => {
    const deps = makeDeps([R1]);
    H.modelOut = [
      { action: "update", target: "R1", note_type: "tenant_reference", title: "Take rate", body_markdown: "Current take rate is 18%.", subject: "take rate", attribute: "current value", value_kind: "rate", source: "user_stated" },
    ];
    H.writeIds = ["new-rate"];
    await runDistill(input(deps));
    expect(deps.supersedeForUpdate).not.toHaveBeenCalled();
    expect(deps.openConflictPair).toHaveBeenCalledWith(TENANT, expect.objectContaining({
      existing_note_id: "recalled-rate",
      new_note_id: "new-rate",
      reason: "protected_value",
    }));
    const log = deps.recordWrites.mock.calls[0][1];
    expect(log[0]).toMatchObject({ action: "conflict", note_id: "new-rate", matched_note_id: "recalled-rate" });
  });

  it("a conflict pair that could not be opened counts as a failed write (the worker retries)", async () => {
    const deps = makeDeps([R1]);
    deps.openConflictPair.mockRejectedValueOnce(new Error("conflict pair insert failed"));
    H.modelOut = [
      { action: "update", target: "R1", note_type: "tenant_reference", title: "Take rate", body_markdown: "Current take rate is 18%.", subject: "take rate", attribute: "current value", value_kind: "rate", source: "user_stated" },
    ];
    H.writeIds = ["new-rate"];
    const res = await runDistill(input(deps));
    expect(res.failed).toBe(1);
    expect(res.written).toBe(0);
    expect(H.deleted).toEqual(["new-rate"]);
  });

  it("junk is logged as junk and never written", async () => {
    const deps = makeDeps([]);
    H.modelOut = [{ action: "add", note_type: "tenant_reference", title: "Moves", body_markdown: '<goal_moves> {"a":1}' }];
    await runDistill(input(deps));
    expect(H.writes).toHaveLength(0);
    const log = deps.recordWrites.mock.calls[0][1];
    expect(log[0]).toMatchObject({ action: "junk", reason: "junk:tagged_envelope" });
  });

  it("an agent narrating what it saw or what memory holds never becomes a fact or a two-values choice, while a plain fact beside it still lands", async () => {
    const account: ExistingFact = {
      ...E1,
      ref: "R1",
      note_id: "li-account",
      title: "LinkedIn ad account",
      body: 'The only LinkedIn ad account the connection can access is "Developer\'s Ad Account" (ID 559880687, USD, ACTIVE).',
      note_type: "tenant_reference",
      subject: "linkedin ads",
      attribute: "delivery state",
      value_kind: "other",
      source_class: "connector",
      trust_tier: 1,
      recalled: true,
    };
    const deps = makeDeps([account]);
    H.modelOut = [
      {
        action: "update",
        target: "R1",
        note_type: "tenant_reference",
        title: "LinkedIn Ads delivery",
        body_markdown:
          "The agent said it saw no record of a LinkedIn campaign launching or delivering, but explicitly did not confirm this. Saved memory already holds the verified zero-delivery state with 16 draft campaigns.",
        subject: "linkedin ads",
        attribute: "delivery state",
        value_kind: "other",
        source: "agent_inferred",
      },
      {
        action: "update",
        target: "R1",
        note_type: "tenant_reference",
        title: "LinkedIn Ads delivery",
        body_markdown: "LinkedIn Ads has 16 draft campaigns and none has delivered an impression yet.",
        subject: "linkedin ads",
        attribute: "delivery state",
        value_kind: "other",
        source: "agent_inferred",
      },
    ];
    H.writeIds = ["plain-fact"];
    const res = await runDistill(
      input(deps, {
        source: "auto_distill_agent_run",
        systemPrompt: AGENT_RUN_DISTILL_SYSTEM_PROMPT,
        gate: { ceiling: 2, queryText: "How is LinkedIn Ads doing?", run_id: RUN, deps },
      }),
    );
    expect(H.writes.map((w) => w.body_markdown)).toEqual([
      "LinkedIn Ads has 16 draft campaigns and none has delivered an impression yet.",
    ]);
    expect(res.written).toBe(1);
    expect(deps.openConflictPair).toHaveBeenCalledTimes(1);
    expect(deps.openConflictPair).toHaveBeenCalledWith(TENANT, expect.objectContaining({ existing_note_id: "li-account", new_note_id: "plain-fact" }));
    const log = deps.recordWrites.mock.calls[0][1];
    expect(log.map((l) => l.action)).toEqual(["junk", "conflict"]);
    expect(log[0]).toMatchObject({ reason: "junk:meta_narration" });
  });

  it("QA 8199 re-check: a run-narrating sentence that agrees with saved memory is dropped before any two-values pair, and the real fact beside it is the only write", async () => {
    const saved: ExistingFact = {
      ...E1,
      ref: "R1",
      note_id: "li-account",
      title: "LinkedIn ad account",
      body: 'The only LinkedIn ad account the connection can access is "Developer\'s Ad Account" (ID 559880687, USD, ACTIVE). As of the agent\'s read, the last 30 days show 0 impressions, 0 clicks, $0 spend, 0 conversions and 0 leads. All 16 campaigns in the account are drafts.',
      note_type: "tenant_reference",
      subject: "linkedin ads",
      attribute: "delivery state",
      value_kind: "other",
      source_class: "connector",
      trust_tier: 1,
      recalled: true,
    };
    const qa =
      "The run mentioned draft campaigns including a $200/day 'test1' draft, which is consistent with the saved state of 16 draft campaigns and zero delivery.";
    const fact = "The LinkedIn Ads monthly budget cap is $3,000.";
    const deps = makeDeps([saved]);
    H.modelOut = [
      {
        action: "update",
        target: "R1",
        note_type: "tenant_reference",
        title: "LinkedIn Ads drafts",
        body_markdown: qa,
        subject: "linkedin ads",
        attribute: "delivery state",
        value_kind: "other",
        source: "agent_inferred",
      },
      {
        action: "add",
        note_type: "tenant_reference",
        title: "LinkedIn Ads budget cap",
        body_markdown: fact,
        subject: "linkedin ads",
        attribute: "monthly budget cap",
        value_kind: "money",
        source: "agent_inferred",
      },
    ];
    H.writeIds = ["budget-fact"];
    const res = await runDistill(
      input(deps, {
        source: "auto_distill_chat",
        gate: {
          ceiling: 2,
          queryText: "Run the LinkedIn Ads channel again and refresh its recommendations.",
          run_id: RUN,
          thread_message_id: "44444444-4444-4444-4444-444444444444",
          deps,
        },
      }),
    );
    expect(H.writes.map((w) => w.body_markdown)).toEqual([fact]);
    expect(res.written).toBe(1);
    expect(deps.openConflictPair).not.toHaveBeenCalled();
    expect(deps.supersedeForUpdate).not.toHaveBeenCalled();
    expect(H.deleted).toEqual([]);
    const log = deps.recordWrites.mock.calls[0][1];
    expect(log.map((l) => l.action)).toEqual(["junk", "added"]);
    expect(log[0]).toMatchObject({ reason: "junk:meta_narration", candidate_body: qa });
    expect(log[1]).toMatchObject({ note_id: "budget-fact" });
  });

  it("an agent run can never write a tier-0 fact, and a fetched fact is tier 3", async () => {
    const deps = makeDeps([]);
    H.modelOut = [
      { action: "add", note_type: "tenant_reference", title: "Geo", body_markdown: "Primary geo is California.", subject: "primary geo", attribute: "region", source: "user_stated" },
      { action: "add", note_type: "tenant_reference", title: "Competitor", body_markdown: "Rival Co sells in Texas.", subject: "rival co", attribute: "market", source: "fetched_web" },
    ];
    await runDistill(input(deps, { source: "auto_distill_agent_run", systemPrompt: AGENT_RUN_DISTILL_SYSTEM_PROMPT, gate: { ceiling: 2, queryText: "x", run_id: RUN, deps } }));
    expect(H.writes.map((w) => w.trust_tier)).toEqual([2, 3]);
  });

  it("a note-row write failure is reported as failed so the caller can retry", async () => {
    const deps = makeDeps([]);
    H.writeThrows = true;
    H.modelOut = [{ action: "add", note_type: "tenant_reference", title: "Geo", body_markdown: "Primary geo is California.", source: "user_stated" }];
    const res = await runDistill(input(deps));
    expect(res.failed).toBe(1);
  });

  it("without `gate` the old behaviour is unchanged: no lookup, no log, every artifact written", async () => {
    const deps = makeDeps([E1]);
    H.modelOut = [{ note_type: "tenant_reference", title: "Geo", body_markdown: "Primary geo is California." }];
    const res = await runDistill(input(deps, { gate: undefined }));
    expect(res.written).toBe(1);
    expect(H.prompts[0].user).not.toContain("Saved memory");
    expect(deps.loadExistingFacts).not.toHaveBeenCalled();
  });

  it("both extractor prompts carry the gate rules and offer no steering note types", () => {
    expect(CHAT_DISTILL_SYSTEM_PROMPT).toContain("CHECK EVERY FACT AGAINST SAVED MEMORY");
    expect(AGENT_RUN_DISTILL_SYSTEM_PROMPT).toContain("CHECK EVERY FACT AGAINST SAVED MEMORY");
    for (const p of [CHAT_DISTILL_SYSTEM_PROMPT, AGENT_RUN_DISTILL_SYSTEM_PROMPT]) {
      expect(p).not.toMatch(/"note_type":[^\n]*agent_procedural/);
      expect(p).not.toMatch(/"note_type":[^\n]*operator_preference/);
    }
  });
});

describe("standing instructions are rules, not memory", () => {
  const OPERATOR = "Engineer, from now on   ALWAYS open a draft PR and never merge directly.";
  const steering = (note_type: string, over: Record<string, unknown> = {}) => ({
    action: "add",
    note_type,
    title: "Always open a draft PR",
    body_markdown: "Open a draft PR for every change; never merge directly.",
    subject: "engineer pr flow",
    attribute: "merge policy",
    source: "user_stated",
    user_quote: "ALWAYS open a draft PR and never merge directly",
    ...over,
  });
  const chatInput = (deps: ReturnType<typeof makeDeps>) =>
    input(deps, { agent_slug: "engineer", operator_message: OPERATOR });

  it("an agent_procedural quoted verbatim from the operator is still not saved, and is logged", async () => {
    const deps = makeDeps([]);
    H.modelOut = [steering("agent_procedural")];
    const res = await runDistill(chatInput(deps));
    expect(H.writes).toHaveLength(0);
    expect(res.written).toBe(0);
    expect(deps.recordWrites.mock.calls[0][1][0]).toMatchObject({
      action: "rejected",
      reason: "standing_instruction_is_a_rule",
      candidate_note_type: "agent_procedural",
    });
  });

  it("an operator_preference is not saved either", async () => {
    const deps = makeDeps([]);
    H.modelOut = [steering("operator_preference")];
    await runDistill(chatInput(deps));
    expect(H.writes).toHaveLength(0);
    expect(deps.recordWrites.mock.calls[0][1][0]).toMatchObject({ reason: "standing_instruction_is_a_rule" });
  });

  it("a plain fact in the same turn is still saved", async () => {
    const deps = makeDeps([]);
    H.modelOut = [
      steering("agent_procedural"),
      { action: "add", note_type: "tenant_reference", title: "Repo is monorepo", body_markdown: "The codebase is one monorepo.", subject: "codebase", attribute: "layout", source: "user_stated" },
    ];
    const res = await runDistill(chatInput(deps));
    expect(res.written).toBe(1);
    expect(H.writes).toHaveLength(1);
  });

  it("the chat prompt says standing instructions are not saved here", () => {
    expect(CHAT_DISTILL_SYSTEM_PROMPT).toContain("STANDING INSTRUCTIONS ARE NOT SAVED HERE");
    expect(CHAT_DISTILL_SYSTEM_PROMPT).not.toContain('"user_quote"');
  });

  it("a verdict carrying an unknown proposal ref and no action is dropped, not read as add", async () => {
    const deps = makeDeps([]);
    H.modelOut = [{ proposal_ref: "P11", note_type: "tenant_reference", title: "Take rate", body_markdown: "Take rate is 15%." }];
    await runDistill(input(deps));
    expect(H.writes).toHaveLength(0);
  });

  it("operatorSentencesFor returns the operator's whole sentence around the quote", () => {
    expect(operatorSentencesFor("never merge", "Hi there. Please never merge directly, open a PR! Thanks.")).toBe("Please never merge directly, open a PR!");
    expect(operatorSentencesFor("not in it", "Hi there.")).toBeNull();
  });
});

describe("memory_write proposals are judged by the gate", () => {
  const KEPT: ExistingFact = {
    ...R1,
    ref: "E1",
    note_id: "kept-12",
    body: "Current take rate is 12%.",
    source_class: "user_stated",
    trust_tier: 0,
    recalled: false,
  };
  const P15 = { id: "prop-1", title: "Take rate", body: "Take rate is 15%.", tags: [] as string[], thread_id: null as string | null };
  const withProposals = (deps: ReturnType<typeof makeDeps>, items = [P15], agent_slug: string | null = "operator") =>
    input(deps, {
      source: "auto_distill_agent_run",
      systemPrompt: AGENT_RUN_DISTILL_SYSTEM_PROMPT,
      thread_id: undefined,
      gate: { ceiling: 2, queryText: "run output", run_id: RUN, deps },
      proposals: { agent_slug, items },
    });

  it("shows the proposals to the extractor as untrusted agent requests, with more output budget", async () => {
    const deps = makeDeps([KEPT]);
    await runDistill(withProposals(deps));
    const user = H.prompts[0].user;
    expect(user).toContain("Facts the agent asked to save");
    expect(user).toContain("agent_memory_proposals");
    expect(user).toContain("[P1] Take rate: Take rate is 15%.");
    expect(user.indexOf("[P1]")).toBeLessThan(user.indexOf("Saved memory closest"));
    expect((deps.loadExistingFacts.mock.calls[0] as unknown as [string, { queryText: string }])[1].queryText).toContain("Take rate is 15%.");
  });

  it("a proposed 15% against the kept 12% opens a two-values pair instead of a silent live note", async () => {
    const deps = makeDeps([KEPT]);
    H.modelOut = [
      {
        action: "update", target: "E1", proposal_ref: "P1", note_type: "tenant_reference", title: "Take rate",
        body_markdown: "Take rate is 15%.", subject: "take rate", attribute: "current value", value_kind: "rate",
        source: "agent_inferred",
      },
    ];
    H.writeIds = ["new-15"];
    await runDistill(withProposals(deps));
    expect(deps.supersedeForUpdate).not.toHaveBeenCalled();
    expect(deps.openConflictPair).toHaveBeenCalledWith(TENANT, expect.objectContaining({ existing_note_id: "kept-12", new_note_id: "new-15" }));
    expect(H.writes[0]).toMatchObject({ source: "auto_distill_agent_run", trust_tier: 2, subject: "take rate" });
    expect(deps.markProposalsDecided).toHaveBeenCalledWith(TENANT, ["prop-1"]);
  });

  it("a rejected proposal is logged and decided, never written", async () => {
    const deps = makeDeps([]);
    H.modelOut = [{ action: "reject", proposal_ref: "P1", reason: "the agent's guess" }];
    await runDistill(withProposals(deps));
    expect(H.writes).toHaveLength(0);
    const log = deps.recordWrites.mock.calls[0][1];
    expect(log[0]).toMatchObject({ action: "rejected", candidate_body: "Take rate is 15%.", run_id: RUN });
    expect(deps.markProposalsDecided).toHaveBeenCalledWith(TENANT, ["prop-1"]);
  });

  it("a proposal with no verdict stays pending; an unknown ref counts for nothing", async () => {
    const deps = makeDeps([]);
    H.modelOut = [{ action: "reject", proposal_ref: "P7", note_type: "tenant_reference", title: "x", body_markdown: "Something else entirely." }];
    await runDistill(withProposals(deps));
    expect(deps.markProposalsDecided).not.toHaveBeenCalled();
  });

  it("when a write fails nothing is marked decided (the retry re-judges)", async () => {
    const deps = makeDeps([]);
    H.writeThrows = true;
    H.modelOut = [{ action: "add", proposal_ref: "P1", note_type: "tenant_reference", title: "Geo", body_markdown: "Primary geo is California.", source: "agent_inferred" }];
    const res = await runDistill(withProposals(deps));
    expect(res.failed).toBe(1);
    expect(deps.markProposalsDecided).not.toHaveBeenCalled();
  });

  it("an accepted proposal from a custom-agent run gets that agent's provenance", async () => {
    const deps = makeDeps([]);
    H.modelOut = [{ action: "add", proposal_ref: "P1", note_type: "tenant_reference", title: "Geo", body_markdown: "Primary geo is California.", source: "agent_inferred" }];
    H.writeIds = ["geo-note"];
    await runDistill(withProposals(deps, [P15], "c-aaaaaaaa01"));
    expect(deps.stampCustomAgentProvenance).toHaveBeenCalledWith(TENANT, RUN, "c-aaaaaaaa01", "geo-note");
  });

  it("a fact the extractor found on its own gets no custom-agent provenance", async () => {
    const deps = makeDeps([]);
    H.modelOut = [{ action: "add", note_type: "tenant_reference", title: "Geo", body_markdown: "Primary geo is California.", source: "agent_inferred" }];
    await runDistill(withProposals(deps, [P15], "c-aaaaaaaa01"));
    expect(deps.stampCustomAgentProvenance).not.toHaveBeenCalled();
  });

  it("the agent's tags and the run's thread ride onto the accepted note", async () => {
    const deps = makeDeps([]);
    H.modelOut = [{ action: "add", proposal_ref: "P1", note_type: "tenant_reference", title: "Audit", body_markdown: "Homepage has no meta description.", source: "agent_inferred", tags: ["seo"] }];
    await runDistill(withProposals(deps, [{ ...P15, tags: ["seo_audit"], thread_id: "55555555-5555-5555-5555-555555555555" }]));
    expect(H.writes[0].tags).toEqual(expect.arrayContaining(["seo_audit", "seo"]));
    expect(H.writes[0].thread_id).toBe("55555555-5555-5555-5555-555555555555");
  });

  it("a proposal verdict with no action is not read as add: nothing written, still pending", async () => {
    const deps = makeDeps([KEPT]);
    H.modelOut = [{ proposal_ref: "P1", note_type: "tenant_reference", title: "Take rate", body_markdown: "Take rate is 15%." }];
    await runDistill(withProposals(deps));
    expect(H.writes).toHaveLength(0);
    expect(deps.markProposalsDecided).not.toHaveBeenCalled();
  });

  it("a failed decided stamp fails the distill so the worker retries", async () => {
    const deps = makeDeps([]);
    deps.markProposalsDecided.mockRejectedValueOnce(new Error("memory proposal decided stamp failed: db"));
    H.modelOut = [{ action: "reject", proposal_ref: "P1" }];
    await expect(runDistill(withProposals(deps))).rejects.toThrow(/decided stamp failed/);
  });

  const BIG = [1685, 2243, 2324, 2601].map((n, i) => ({ ...P15, id: `big-${i + 1}`, body: "x".repeat(n) }));

  it("long proposals get an output budget sized to them, and the budget is capped", async () => {
    const deps = makeDeps([]);
    await runDistill(withProposals(deps, BIG));
    expect(H.maxTokens[0]).toBe(1500 + 4 * 1500);
    expect(distillBudgetTokens(1500, [{ body: "x".repeat(10000) }])).toBe(1500 + 4000);
    expect(distillBudgetTokens(1500, Array.from({ length: 10 }, () => ({ body: "x".repeat(4000) })))).toBe(12000);
  });

  it("a ~2,500-char note of 10 facts is shown to the extractor in full, last fact included", async () => {
    const deps = makeDeps([]);
    const facts = Array.from({ length: 10 }, (_, i) => `- Fact ${i + 1}: ${"detail ".repeat(33)}`).join("\n");
    expect(facts.length).toBeGreaterThan(2400);
    await runDistill(withProposals(deps, [{ ...P15, body: facts }]));
    expect(H.prompts[0].user).toContain("Fact 10:");
  });

  it("a cut-off answer with proposals is a failed review: warned, nothing decided", async () => {
    const deps = makeDeps([]);
    H.rawText = '{"artifacts":[{"action":"reject","proposal_ref":"P1","reason":"the ag';
    await runDistill(withProposals(deps, BIG));
    expect(deps.markProposalsDecided).not.toHaveBeenCalled();
    expect(vi.mocked(logReview).mock.calls[0][0]).toMatchObject({ feature: "memory_write", outcome: "failed" });
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", code: "memory_write.distill_unparseable", meta: { count: 4, output_tokens: 1, cap: 7500 } }),
    );
  });

  it("a clean answer for long proposals decides them as before, with no warning", async () => {
    const deps = makeDeps([]);
    H.modelOut = BIG.map((_, i) => ({ action: "reject", proposal_ref: `P${i + 1}`, reason: "dup" }));
    await runDistill(withProposals(deps, BIG));
    expect(deps.markProposalsDecided).toHaveBeenCalledWith(TENANT, ["big-1", "big-2", "big-3", "big-4"]);
    expect(vi.mocked(logReview).mock.calls[0][0]).toMatchObject({ outcome: "ok" });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("a readable answer that skips a proposal is a failed review; only the judged one is decided", async () => {
    const deps = makeDeps([]);
    H.modelOut = [{ action: "reject", proposal_ref: "P1", reason: "dup" }];
    await runDistill(withProposals(deps, BIG.slice(0, 2)));
    expect(deps.markProposalsDecided).toHaveBeenCalledWith(TENANT, ["big-1"]);
    expect(vi.mocked(logReview).mock.calls[0][0]).toMatchObject({ outcome: "failed" });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("proposals are ignored without the gate", async () => {
    const deps = makeDeps([]);
    await runDistill({ ...withProposals(deps), gate: undefined });
    expect(H.prompts[0].user).not.toContain("[P1]");
  });
});
