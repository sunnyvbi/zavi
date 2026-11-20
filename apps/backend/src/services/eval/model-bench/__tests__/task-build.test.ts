import { describe, it, expect } from "vitest";
import { HarnessFailure } from "@/services/eval/shadow-harness";
import { assertBenchTenant, BENCH_TENANTS } from "../tenants";
import {
  isTrivialRequest,
  onlyTrivialRuns,
  requestText,
  selectTaskSeeds,
  validRowsForUnit,
  type SourceRunRow,
} from "../miner";
import {
  assertFixtureTenant,
  fixtureToShadowMap,
  mergeFillCaptures,
  type TaskFixture,
} from "../fixtures";
import { buildJudgePrompt } from "../scorer";

const UPCAR = "73db45ff-457e-4541-bc8f-bdb625390204";
const APNA = "f47c4bdc-c90d-424f-ab68-bf8b045ac8c0";
const STRANGER = "11c9df69-0000-4000-8000-000000000000";
const SNAP = "--- system ---\nYou are pm.\n\n--- initial user ---\nWhat should we ship next quarter, given churn and onboarding drop-off?";
const SECRET_ANSWER = "SOURCE-RUN-ANSWER-SENTINEL-7f3a: ship the referral loop";

const row = (over: Partial<SourceRunRow> = {}): SourceRunRow => ({
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  tenant_id: UPCAR,
  agent_slug: "pm",
  trigger: "cron",
  payload: { ask: "plan" },
  prompt_snapshot: SNAP,
  enqueued_at: "2026-09-01T00:00:00Z",
  raw_response_text: SECRET_ANSWER,
  output_text: SECRET_ANSWER,
  ...over,
});

const fixture = (over: Partial<TaskFixture> = {}): TaskFixture => ({
  fixture_version: 1,
  task_id: "upcar-ai.pm.aaaaaaaa",
  tenant_id: UPCAR,
  company: "upcar-ai",
  agent_slug: "pm",
  unit: "pm",
  cohort: "role",
  source_run_id: "aaaaaaaa",
  input: { trigger: "cron", payload: { ask: "plan" }, prompt: { system: "S", initial_user: "What should we ship next quarter, given churn and onboarding drop-off?" } },
  evidence: [{ tenant_id: UPCAR, tool_name: "memory__search", input: { q: "x" }, content: "signups 412 last week", is_error: false }],
  filled_by: ["claude-shared"],
  ...over,
});

describe("test 3 — bench tenant allowlist", () => {
  it("allows exactly the pinned D7 tenants", () => {
    expect(assertBenchTenant(UPCAR).company).toBe("upcar-ai");
    expect(assertBenchTenant(APNA).company).toBe("apna-tutor");
  });

  it("refuses any other tenant, a prefix, or garbage — fail-closed", () => {
    for (const t of [STRANGER, "73db45ff", "", null, undefined, 42, UPCAR.toUpperCase()]) {
      expect(() => assertBenchTenant(t)).toThrow(HarnessFailure);
    }
  });

  it("couple-app is allowed by its exact full id only; a different id with the same prefix is refused", () => {
    const couple = BENCH_TENANTS.find((b) => b.company === "couple-app")!;
    expect(couple.id).toBe("b2cbf8d4-725c-499d-b346-d23b537a19a0");
    expect(assertBenchTenant("b2cbf8d4-725c-499d-b346-d23b537a19a0").company).toBe("couple-app");
    expect(() => assertBenchTenant(`${couple.id_prefix}-0000-4000-8000-000000000000`)).toThrow(HarnessFailure);
  });

  it("task mining refuses a non-bench row BEFORE keeping any data", () => {
    expect(() => selectTaskSeeds([row(), row({ id: "bbbbbbbb-2222-4222-8222-222222222222", tenant_id: STRANGER })])).toThrow(HarnessFailure);
  });

  it("every fixture carries exactly one tenant, matching its task; a foreign record poisons the whole fixture", () => {
    expect(() => assertFixtureTenant(fixture(), UPCAR)).not.toThrow();
    expect(() => assertFixtureTenant(fixture(), APNA)).toThrow(HarnessFailure);
    const poisoned = fixture({
      evidence: [
        ...fixture().evidence,
        { tenant_id: APNA, tool_name: "memory__search", input: { q: "y" }, content: "apna data", is_error: false },
      ],
    });
    expect(() => assertFixtureTenant(poisoned, UPCAR)).toThrow(HarnessFailure);
    expect(() => fixtureToShadowMap(poisoned, UPCAR)).toThrow(HarnessFailure);
  });

  it("merging fill captures refuses a record from another tenant", () => {
    expect(() =>
      mergeFillCaptures(UPCAR, [
        [{ tenant_id: APNA, tool_name: "memory__search", input: {}, content: "x", is_error: false }],
      ]),
    ).toThrow(HarnessFailure);
  });

  it("merge keeps the longest per-signature sequence any one model saw, in first-capture order", () => {
    const r = (q: string, c: string) => ({ tenant_id: UPCAR, tool_name: "memory__search", input: { q }, content: c, is_error: false });
    const merged = mergeFillCaptures(UPCAR, [
      [r("a", "a1"), r("b", "b1")],
      [r("a", "a1"), r("a", "a2"), r("c", "c1")],
    ]);
    expect(merged.map((m) => m.content)).toEqual(["a1", "a2", "b1", "c1"]);
  });
});

describe("test 4 — source-answer hygiene", () => {
  it("task seeds drop the source run's answer entirely", () => {
    const [seed] = selectTaskSeeds([row()]);
    expect(JSON.stringify(seed)).not.toContain("SOURCE-RUN-ANSWER-SENTINEL");
  });

  it("the judge prompt is task input + evidence + the two answers (never the source answer)", () => {
    const [seed] = selectTaskSeeds([row()]);
    const prompt = buildJudgePrompt(fixture({ input: seed.input }), "ANSWER-ONE", "ANSWER-TWO");
    expect(prompt).not.toContain("SOURCE-RUN-ANSWER-SENTINEL");
    expect(prompt).toContain("signups 412 last week");
    expect(prompt).toContain("What should we ship next quarter, given churn and onboarding drop-off?");
    expect(prompt.indexOf("ANSWER-ONE")).toBeLessThan(prompt.indexOf("ANSWER-TWO"));
  });
});

describe("mining skips trivial requests", () => {
  const LONG = "Draft a PRD for host onboarding that cuts the drop-off at the ID-check step";
  const snap = (u: string) => `--- system ---\nYou are pm.\n\n--- initial user ---\n${u}`;

  it("the request is the payload's user text, else the last user message, else the snapshot's user turn", () => {
    expect(requestText({ trigger: "cron", payload: { idea: "try again" }, prompt_snapshot: snap(LONG) })).toBe("try again");
    expect(requestText({ trigger: "chat", payload: { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "retry" }] }, prompt_snapshot: snap(LONG) })).toBe("retry");
    expect(requestText({ trigger: "cron", payload: { ask: "plan" }, prompt_snapshot: snap(LONG) })).toBe(LONG);
  });

  it("trivial = a retry opener, or a bare go-ahead as the whole message", () => {
    for (const t of ["idea: try again".slice(6), "Try again please, same as before but longer than forty chars", "ok", "   continue   ", "yes do it", "go", "Go ahead."]) {
      expect(isTrivialRequest(t), t).toBe(true);
    }
    expect(isTrivialRequest(LONG)).toBe(false);
    expect(isTrivialRequest("What should we ship next?")).toBe(false);
    expect(isTrivialRequest("Go to market plan for the Phoenix launch")).toBe(false);
    expect(isTrivialRequest("Continue the referral experiment with a higher credit")).toBe(false);
    expect(isTrivialRequest("")).toBe(false);
  });

  it("an id-only chat row is unusable: never mined, never counted as trivial; an older real run wins", () => {
    const idOnly = row({ id: "eeeeeeee-5555-4555-8555-555555555555", trigger: "chat", payload: { thread_id: "t", user_message_id: "m" }, prompt_snapshot: snap(""), enqueued_at: "2026-09-09T00:00:00Z" });
    const real = row({ id: "ffffffff-6666-4666-8666-666666666666", payload: { idea: LONG }, enqueued_at: "2026-09-02T00:00:00Z" });
    expect(validRowsForUnit([idOnly], 1)).toEqual([]);
    expect(onlyTrivialRuns([idOnly])).toBe(false);
    expect(selectTaskSeeds([idOnly, real]).map((x) => x.source_run_id)).toEqual([real.id]);
  });

  it("a payload-only ask becomes the seed's user turn", () => {
    const r = row({ trigger: "chat", payload: { thread_id: "t", task_description: "Add a refund button to the payout page" }, prompt_snapshot: snap("") });
    expect(selectTaskSeeds([r])[0].input.prompt.initial_user).toBe("Add a refund button to the payout page");
  });

  it("a chat run's stored task_description / current_message is the request", () => {
    expect(requestText({ trigger: "chat", payload: { thread_id: "t", task_description: "Add a refund button" }, prompt_snapshot: snap("") })).toBe("Add a refund button");
    expect(requestText({ trigger: "chat", payload: { current_message: "Why did signups drop?" }, prompt_snapshot: snap("") })).toBe("Why did signups drop?");
  });

  it("the newest SUBSTANTIVE run is taken; a trivial newer run is skipped", () => {
    const newer = row({ id: "cccccccc-3333-4333-8333-333333333333", payload: { idea: "try again" }, enqueued_at: "2026-09-05T00:00:00Z" });
    const older = row({ id: "dddddddd-4444-4444-8444-444444444444", payload: { idea: LONG }, enqueued_at: "2026-09-02T00:00:00Z" });
    const seeds = selectTaskSeeds([newer, older]);
    expect(seeds.map((s) => s.source_run_id)).toEqual([older.id]);
    expect(validRowsForUnit([newer, older], 1).map((r) => r.id)).toEqual([older.id]);
  });

  it("a unit whose usable runs are all trivial is 'no substantive run', distinct from 'no usable run'", () => {
    const trivial = row({ payload: { idea: "try again" } });
    expect(selectTaskSeeds([trivial])).toEqual([]);
    expect(onlyTrivialRuns([trivial])).toBe(true);
    expect(onlyTrivialRuns([row({ prompt_snapshot: null })])).toBe(false);
    expect(onlyTrivialRuns([])).toBe(false);
    expect(onlyTrivialRuns([trivial, row({ payload: { idea: LONG } })])).toBe(false);
  });
});
