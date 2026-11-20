import { describe, it, expect } from "vitest";
import { labelQuery, parseJudgeReply, extractQuestionText, type Candidate, type Judge } from "../judge-labeler";

const CANDS: Candidate[] = [
  { note_id: "n1", title: "Payout timing", body: "Hosts paid Mondays." },
  { note_id: "n2", title: "Cancellation", body: "Free cancel 24h." },
  { note_id: "n3", title: "Insurance", body: "Covered up to X." },
];

const judgePicking = (ids: string[]): { family: string; judge: Judge } => ({
  family: `mock-${ids.join("")}`,
  judge: async () => ids,
});
const throwingJudge = (family: string): { family: string; judge: Judge } => ({
  family,
  judge: async () => {
    throw new Error("boom");
  },
});

describe("parseJudgeReply", () => {
  it("maps 1-based indices to note_ids", () => {
    expect(parseJudgeReply('{"best": [1]}', CANDS)).toEqual(["n1"]);
    expect(parseJudgeReply('here: {"best":[1,3]} ok', CANDS)).toEqual(["n1", "n3"]);
  });
  it("ignores out-of-range / garbage / empty", () => {
    expect(parseJudgeReply('{"best": [9]}', CANDS)).toEqual([]);
    expect(parseJudgeReply("no json", CANDS)).toEqual([]);
    expect(parseJudgeReply('{"best": []}', CANDS)).toEqual([]);
  });
  it("dedups repeats", () => {
    expect(parseJudgeReply('{"best": [1,1]}', CANDS)).toEqual(["n1"]);
  });
});

describe("extractQuestionText", () => {
  it("passes through a plain question", () => {
    expect(extractQuestionText("how fast do hosts get paid?")).toBe("how fast do hosts get paid?");
    expect(extractQuestionText("  trimmed  ")).toBe("trimmed");
  });
  it("unwraps current_message (string and .text)", () => {
    expect(extractQuestionText('{"prior_messages":[],"current_message":"why is X slow?"}')).toBe("why is X slow?");
    expect(extractQuestionText('{"current_message":{"text":"nested q here"}}')).toBe("nested q here");
  });
  it("returns null for structured-only payloads", () => {
    expect(extractQuestionText('{"mode":"delivery"}')).toBeNull();
    expect(extractQuestionText('{"slack":{"channel_id":"D0","event_id":"E"}}')).toBeNull();
    expect(extractQuestionText('{"pulse_breaches":[{"current_value":null}]}')).toBeNull();
  });
  it("returns null for empty / letterless / malformed-json envelopes", () => {
    expect(extractQuestionText("")).toBeNull();
    expect(extractQuestionText("12345 ---")).toBeNull();
    expect(extractQuestionText("{not valid json")).toBeNull();
    expect(extractQuestionText('{"current_message":"   "}')).toBeNull();
  });
  it("keeps a real question that starts with '[' (not a JSON envelope)", () => {
    expect(extractQuestionText("[urgent] how fast do hosts get paid?")).toBe("[urgent] how fast do hosts get paid?");
  });
  it("nulls a current_message that is itself a JSON blob", () => {
    expect(extractQuestionText('{"current_message":"{\\"mode\\":\\"delivery\\"}"}')).toBeNull();
  });
});

describe("labelQuery consensus", () => {
  it("unanimous → agreement 1.0, high confidence", async () => {
    const r = await labelQuery("q", CANDS, [judgePicking(["n1"]), judgePicking(["n1"])]);
    expect(r.expected_note_ids).toEqual(["n1"]);
    expect(r.agreement).toBe(1);
    expect(r.low_confidence).toBe(false);
    expect(r.families_voted).toBe(2);
  });

  it("split (no majority) → low confidence, agreement < 1", async () => {
    const r = await labelQuery("q", CANDS, [judgePicking(["n1"]), judgePicking(["n2"])]);
    expect(r.expected_note_ids).toEqual([]);
    expect(r.agreement).toBe(0.5);
    expect(r.low_confidence).toBe(true);
  });

  it("3 families, 2 agree → majority wins, agreement 2/3", async () => {
    const r = await labelQuery("q", CANDS, [
      judgePicking(["n1"]),
      judgePicking(["n1"]),
      judgePicking(["n2"]),
    ]);
    expect(r.expected_note_ids).toEqual(["n1"]);
    expect(r.agreement).toBeCloseTo(0.6667, 3);
    expect(r.low_confidence).toBe(true);
  });

  it("errored judge excluded from denominator, never a silent pass", async () => {
    const r = await labelQuery("q", CANDS, [judgePicking(["n1"]), throwingJudge("openai")]);
    expect(r.families_voted).toBe(1);
    expect(r.low_confidence).toBe(true);
    expect(r.votes.find((v) => v.family === "openai")?.error).toBeTruthy();
    expect(r.expected_note_ids).toEqual(["n1"]);
  });

  it("single-family floor: 1 family voting is always low_confidence", async () => {
    const r = await labelQuery("q", CANDS, [judgePicking(["n1"])]);
    expect(r.families_voted).toBe(1);
    expect(r.low_confidence).toBe(true);
  });

  it("runs judges CONCURRENTLY and waits for the slow one (result reflects both)", async () => {
    const order: string[] = [];
    const slow: { family: string; judge: Judge } = {
      family: "slow",
      judge: async () => {
        await new Promise((r) => setTimeout(r, 40));
        order.push("slow");
        return ["n1"];
      },
    };
    const fast: { family: string; judge: Judge } = {
      family: "fast",
      judge: async () => {
        order.push("fast");
        return ["n1"];
      },
    };
    const t0 = Date.now();
    const r = await labelQuery("q", CANDS, [slow, fast]);
    expect(order).toEqual(["fast", "slow"]);
    expect(r.families_voted).toBe(2);
    expect(r.expected_note_ids).toEqual(["n1"]);
    expect(r.agreement).toBe(1);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
