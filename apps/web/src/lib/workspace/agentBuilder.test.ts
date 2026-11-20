import { describe, expect, it } from "vitest";
import {
  findBuilderAgent,
  nextRun,
  pastWhen,
  receiptLine,
  receiptsByRun,
  runStatus,
  whenItRuns,
  type BuilderAgent,
  type BuilderTrigger,
} from "./agentBuilder";
import { plainRunText } from "./agentBuilder";

const trig = (over: Partial<BuilderTrigger>): BuilderTrigger => ({
  id: "t1",
  kind: "schedule",
  cron: "0 9 * * 1-5",
  tz: "America/Los_Angeles",
  interval_minutes: null,
  condition: null,
  enabled: true,
  next_due_at: null,
  ...over,
});

describe("whenItRuns", () => {
  it("says the schedule in plain words, reusing the chat card's wording", () => {
    expect(whenItRuns([trig({})])).toBe("Weekdays at 9:00 AM (PT)");
    expect(whenItRuns([trig({ kind: "watch", cron: null, interval_minutes: 60, condition: "the pricing page changes" })])).toBe(
      "Checks every 60 min: the pricing page changes",
    );
    expect(whenItRuns([])).toBe("Only when you run it");
  });
});

describe("runStatus", () => {
  it("maps run statuses to the page's words", () => {
    expect(runStatus({ status: "success", test: false }).label).toBe("Finished");
    expect(runStatus({ status: "success", test: true }).label).toBe("Finished");
    expect(runStatus({ status: "error", test: false }).label).toBe("Did not finish");
    expect(runStatus({ status: "running", test: false }).label).toBe("Running");
  });
});

describe("nextRun", () => {
  const now = new Date("2026-09-25T20:00:00Z");
  const agent = (over: Partial<BuilderAgent>): Pick<BuilderAgent, "status" | "triggers"> => ({
    status: "active",
    triggers: [],
    ...over,
  });
  it("paused, unscheduled, soon and tomorrow", () => {
    expect(nextRun(agent({ status: "paused", triggers: [trig({ next_due_at: "2026-09-26T16:00:00Z" })] }), now)).toBe("Paused");
    expect(nextRun(agent({}), now)).toBe("Not scheduled");
    expect(nextRun(agent({ triggers: [trig({ next_due_at: "2026-09-25T20:42:00Z" })] }), now)).toBe("In 42 min");
    expect(nextRun(agent({ triggers: [trig({ next_due_at: "2026-09-26T16:00:00Z" })] }), now)).toBe("Tomorrow, 9:00 AM (PT)");
  });
  it("ignores a disabled trigger", () => {
    expect(nextRun(agent({ triggers: [trig({ enabled: false, next_due_at: "2026-09-26T16:00:00Z" })] }), now)).toBe("Not scheduled");
  });
});

describe("pastWhen", () => {
  it("today / yesterday / a date", () => {
    const now = new Date("2026-09-25T20:00:00Z");
    expect(pastWhen("2026-09-25T16:00:00Z", now, "America/Los_Angeles")).toBe("Today, 9:00 AM");
    expect(pastWhen("2026-09-24T16:00:00Z", now, "America/Los_Angeles")).toBe("Yesterday, 9:00 AM");
    expect(pastWhen("2026-09-22T16:00:00Z", now, "America/Los_Angeles")).toBe("Sep 22, 9:00 AM");
  });
});

describe("receipts", () => {
  it("one plain line per write, grouped by run", () => {
    const rs = [
      { id: "a", run_id: "r1", tool_name: "praxis__action", decision_class: "meta_ads.budget_change", outcome: "succeeded" as const },
      { id: "b", run_id: "r1", tool_name: "slack__post_message", decision_class: null, outcome: "failed" as const },
      { id: "c", run_id: null, tool_name: "x", decision_class: null, outcome: "succeeded" as const },
    ];
    expect(receiptLine(rs[0])).toBe("Meta ads budget change");
    expect(receiptLine(rs[1])).toBe("Post message (did not go through)");
    expect(receiptsByRun(rs).get("r1")?.map((r) => r.id)).toEqual(["a", "b"]);
    expect(receiptsByRun(rs).size).toBe(1);
  });
});

describe("findBuilderAgent", () => {
  it("finds by id or by slug", () => {
    const a = { id: "id-1", slug: "c-abcdefgh01" } as BuilderAgent;
    expect(findBuilderAgent([a], "id-1")).toBe(a);
    expect(findBuilderAgent([a], "c-abcdefgh01")).toBe(a);
    expect(findBuilderAgent([a], "other")).toBeNull();
  });
});

describe("plainRunText links (B3)", () => {
  it("a markdown link becomes its text with the address in brackets", () => {
    expect(plainRunText("[Zavi](https://zaviagent.com) — source: recent runs")).toBe("Zavi (https://zaviagent.com) — source: recent runs");
  });
});

describe("results page helpers", () => {
  it("sends-to says a scheduled result also goes by email, unless it already does", async () => {
    const { sendsResultsLine } = await import("./agentBuilder");
    expect(sendsResultsLine({ kind: "chat_thread", thread_id: "t" })).toBe("This conversation, and by email");
    expect(sendsResultsLine({ kind: "email" })).toBe("Email, to your workspace's recipients");
    expect(sendsResultsLine(null)).toBe("Not delivered anywhere yet");
  });

  it("the result markdown drops a watch's machine block", async () => {
    const { runResultMarkdown } = await import("./agentBuilder");
    expect(runResultMarkdown("Price dropped\n\n```watch_result\n{\"a\":1}\n```\n")).toBe("Price dropped");
  });
});
