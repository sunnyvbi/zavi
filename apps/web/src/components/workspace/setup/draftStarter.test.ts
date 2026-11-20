import { describe, it, expect, vi } from "vitest";
import { runDraftStarter, shouldAutoStartDraft } from "./draftStarter";

describe("draft starter", () => {
  it("asks until the answer is terminal", async () => {
    const answers = [{ retry: true }, { retry: true }, { status: "queued", run_id: "r1" }];
    const post = vi.fn(async () => ({ ok: true, json: async () => answers.shift() }) as unknown as Response);
    const out = await runDraftStarter(post, { retry: false, attempts: 5, sleep: async () => {} });
    expect(out).toEqual({ status: "queued", run_id: "r1" });
    expect(post).toHaveBeenCalledTimes(3);
  });
  it("a 409 is terminal, a 5xx or a throw is retried", async () => {
    const seq = [() => { throw new Error("net"); }, () => ({ ok: false, status: 502 }), () => ({ ok: false, status: 409, json: async () => ({}) })];
    const post = vi.fn(async () => seq.shift()!() as unknown as Response);
    expect(await runDraftStarter(post, { retry: false, attempts: 5, sleep: async () => {} })).toEqual({ refused: true });
  });
  it("a 402 (not enough credits for the hold) is terminal and says so", async () => {
    const post = vi.fn(async () => ({ ok: false, status: 402, json: async () => ({ error: { code: "insufficient_credits" } }) }) as unknown as Response);
    expect(await runDraftStarter(post, { retry: false, attempts: 5, sleep: async () => {} })).toEqual({ insufficientCredits: true });
    expect(post).toHaveBeenCalledOnce();
  });
  it("auto-starts only when step 2 is answered and no draft exists yet", () => {
    const s = { enabled: true, done: false, home_seen: false, docs: { status: "done", files: 1, facts: 1 }, connectors: { status: "skipped" }, draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: false } } as const;
    expect(shouldAutoStartDraft(s)).toBe(true);
    expect(shouldAutoStartDraft({ ...s, connectors: { status: "pending" } })).toBe(false);
    expect(shouldAutoStartDraft({ ...s, draft: { ...s.draft, status: "running" } })).toBe(false);
  });
});
