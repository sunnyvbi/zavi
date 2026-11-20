import { describe, it, expect } from "vitest";
import { verifyDeferredPromise, deferredPromiseFamilies} from "../receipt-verifier";

const ok = (name: string) => ({ name, status: "ok" as const });

describe("verifyDeferredPromise (A3 fleet-wide deferred-promise hedge)", () => {
  it("hedges 'opening a PR now — I'll post the link when it's ready' with no tools", () => {
    const r = verifyDeferredPromise({
      reply: "Opening a PR now — I'll post the link in this thread when it's ready.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(true);
    expect(r.text.toLowerCase()).toContain("nothing was started");
    expect(r.text).toContain("Opening a PR now");
  });

  it("hedges a handoff 'I'll post the result back' when no dispatch tool ran", () => {
    const r = verifyDeferredPromise({
      reply: "Handing off to research. I'll post the result back in this thread when it finishes.",
      toolCalls: [ok("memory__search")],
    });
    expect(r.hedged).toBe(true);
  });

  it("does NOT hedge when a backing tool (open_pr) actually ran", () => {
    const r = verifyDeferredPromise({
      reply: "Opening a PR now — I'll post the link when it's ready.",
      toolCalls: [ok("github__open_pr")],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge a handoff promise when praxis__handoff ran", () => {
    const r = verifyDeferredPromise({
      reply: "I'll post the result back here when it finishes.",
      toolCalls: [ok("praxis__handoff")],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge when the backing tool ERRORED (action did not start)", () => {
    const r = verifyDeferredPromise({
      reply: "Opening a PR now — link coming.",
      toolCalls: [{ name: "github__open_pr", status: "tool_error" }],
    });
    expect(r.flags.has_deferred_promise).toBe(true);
    expect(r.hedged).toBe(true);
  });

  it("does NOT hedge an offer ('want me to open a PR?')", () => {
    const r = verifyDeferredPromise({ reply: "Want me to open a PR for this?", toolCalls: [] });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge vague intent ('I'll look into the PR review process')", () => {
    const r = verifyDeferredPromise({
      reply: "I'll look into the PR review process and get back to you.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge a plain answer with no promise", () => {
    const r = verifyDeferredPromise({
      reply: "The bug is in the null guard at line 42; here's why.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge a completed-action claim (that's verifyReceipt's job, not this)", () => {
    const r = verifyDeferredPromise({ reply: "I opened the PR: #123.", toolCalls: [] });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge a NEGATED promise ('I recommend not opening a PR yet')", () => {
    const r = verifyDeferredPromise({
      reply: "I recommend not opening a PR yet — the interface isn't settled.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge explanatory 'it is coming from the cache'", () => {
    const r = verifyDeferredPromise({
      reply: "The stale value is coming from the cache, not the DB.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge 'hold off on opening a PR'", () => {
    const r = verifyDeferredPromise({
      reply: "Let's hold off on opening a PR until the spec lands.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("hedges when the backing tool THREW (status 'throw' is not success)", () => {
    const r = verifyDeferredPromise({
      reply: "Opening a PR now — I'll post the link when it's ready.",
      toolCalls: [{ name: "github__open_pr", status: "throw" }],
    });
    expect(r.hedged).toBe(true);
  });

  it("hedges when only a READ-ONLY slack tool ran (list/history back nothing)", () => {
    const r = verifyDeferredPromise({
      reply: "Opening a PR now — I'll post the link here.",
      toolCalls: [ok("slack__list_channels"), ok("slack__get_channel_history")],
    });
    expect(r.hedged).toBe(true);
  });

  it("does NOT hedge when a slack WRITE tool posted (slack__post_message)", () => {
    const r = verifyDeferredPromise({
      reply: "I'll post the result back here when it finishes.",
      toolCalls: [ok("slack__post_message")],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge advisory 'I recommend opening a PR after the spec lands'", () => {
    const r = verifyDeferredPromise({
      reply: "I recommend opening a PR after the spec lands.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge instructional 'Before opening a PR, run the tests'", () => {
    const r = verifyDeferredPromise({
      reply: "Before opening a PR, run the tests locally.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge 'the link is coming from the cache'", () => {
    const r = verifyDeferredPromise({
      reply: "The stale link is coming from the cache, not the DB.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("STILL hedges 'I'm opening a PR' with no backing tool", () => {
    const r = verifyDeferredPromise({ reply: "I'm opening a PR for the fix.", toolCalls: [] });
    expect(r.hedged).toBe(true);
  });

  it("STILL hedges 'the PR is on its way'", () => {
    const r = verifyDeferredPromise({ reply: "The PR is on its way.", toolCalls: [] });
    expect(r.hedged).toBe(true);
  });

  it("STILL hedges when only a READ-only PR tool ran (list_open_prs backs nothing)", () => {
    const r = verifyDeferredPromise({
      reply: "Opening a PR now — I'll post the link.",
      toolCalls: [ok("github__list_open_prs")],
    });
    expect(r.hedged).toBe(true);
  });

  it("does NOT hedge when a server-side dispatch was recorded (dispatched_actions)", () => {
    const r = verifyDeferredPromise({
      reply: "I'll post the result back here when it finishes.",
      toolCalls: [],
      dispatchedActions: [{ agent: "research", run_id: "abc" }],
    });
    expect(r.hedged).toBe(false);
  });

  it("hedges when dispatched_actions is empty (nothing enqueued)", () => {
    const r = verifyDeferredPromise({
      reply: "I'll post the result back here.",
      toolCalls: [],
      dispatchedActions: [],
    });
    expect(r.hedged).toBe(true);
  });

  it("does NOT hedge 'I do not recommend opening a PR now'", () => {
    const r = verifyDeferredPromise({
      reply: "I do not recommend opening a PR now — the API isn't stable.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge \"I don't want to open a PR yet\"", () => {
    const r = verifyDeferredPromise({
      reply: "I don't want to open a PR yet, let's discuss first.",
      toolCalls: [],
    });
    expect(r.hedged).toBe(false);
  });

  it("STILL hedges a PR promise when only an UNRELATED tool (slack post) ran", () => {
    const r = verifyDeferredPromise({
      reply: "Opening a PR now — I'll post the link.",
      toolCalls: [ok("slack__post_message"), ok("gmail__send_email")],
    });
    expect(r.hedged).toBe(true);
  });

  it("does NOT hedge a PR promise when a PR-family tool ran", () => {
    const r = verifyDeferredPromise({
      reply: "Opening a PR now — link coming.",
      toolCalls: [ok("github__open_pr")],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge an email promise backed by gmail__send", () => {
    const r = verifyDeferredPromise({
      reply: "I'll send you the summary email shortly.",
      toolCalls: [ok("gmail__send_email")],
    });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge conditional offer 'If you'd like, I'll open a PR'", () => {
    const r = verifyDeferredPromise({ reply: "If you'd like, I'll open a PR for this.", toolCalls: [] });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge trailing conditional 'I'll open a PR if you want'", () => {
    const r = verifyDeferredPromise({ reply: "I'll open a PR if you want me to.", toolCalls: [] });
    expect(r.hedged).toBe(false);
  });

  it("does NOT hedge advisory 'I recommend opening a PR now'", () => {
    const r = verifyDeferredPromise({ reply: "I recommend opening a PR now.", toolCalls: [] });
    expect(r.hedged).toBe(false);
  });

  it("STILL hedges a PR promise 'backed' only by jira create_issue (not a PR)", () => {
    const r = verifyDeferredPromise({
      reply: "Opening a PR now — link coming.",
      toolCalls: [ok("jira__create_issue")],
    });
    expect(r.hedged).toBe(true);
  });

  it("STILL hedges an email promise 'backed' only by slack__send_message", () => {
    const r = verifyDeferredPromise({
      reply: "I'll send you the summary email shortly.",
      toolCalls: [ok("slack__send_message")],
    });
    expect(r.hedged).toBe(true);
  });

  it("does NOT hedge 'The PR is on its way' when github__open_pr ran", () => {
    const r = verifyDeferredPromise({
      reply: "The PR is on its way.",
      toolCalls: [ok("github__open_pr")],
    });
    expect(r.hedged).toBe(false);
  });

  it("hedges uncontracted 'I will open a PR for this'", () => {
    expect(verifyDeferredPromise({ reply: "I will open a PR for this.", toolCalls: [] }).hedged).toBe(true);
  });

  it("hedges \"we'll open a PR\"", () => {
    expect(verifyDeferredPromise({ reply: "We'll open a PR shortly.", toolCalls: [] }).hedged).toBe(true);
  });

  it("hedges 'I'll email you the summary shortly'", () => {
    expect(verifyDeferredPromise({ reply: "I'll email you the summary shortly.", toolCalls: [] }).hedged).toBe(true);
  });

  it("does NOT hedge 'If you would like, I'll open a PR'", () => {
    expect(verifyDeferredPromise({ reply: "If you would like, I'll open a PR.", toolCalls: [] }).hedged).toBe(false);
  });

  it("is idempotent — an already-hedged text is not re-bannered", () => {
    const first = verifyDeferredPromise({ reply: "Opening a PR now.", toolCalls: [] });
    expect(first.hedged).toBe(true);
    const second = verifyDeferredPromise({ reply: first.text, toolCalls: [] });
    expect(second.hedged).toBe(false);
    expect(second.text).toBe(first.text);
    expect(second.text.split("Nothing was started yet").length - 1).toBe(1);
  });
});

describe("verifyDeferredPromise — hasActiveThreadRun (prior-turn dispatch)", () => {
  const REPLY =
    "The engineer is already working on this — run dccb57f2 is in flight and " +
    "will open the PR when done. I'll post the link here as soon as it lands.";

  it("hedges the reply when nothing is in flight (unchanged behaviour)", () => {
    const r = verifyDeferredPromise({ reply: REPLY, toolCalls: [] });
    expect(r.hedged).toBe(true);
    expect(r.flags.has_deferred_promise).toBe(true);
    expect(r.flags.backed).toBe(false);
  });

  it("does NOT hedge when a prior turn's run is still in flight", () => {
    const r = verifyDeferredPromise({
      reply: REPLY,
      toolCalls: [],
      hasActiveThreadRun: true,
    });
    expect(r.hedged).toBe(false);
    expect(r.text).toBe(REPLY);
    expect(r.flags.backed).toBe(true);
    expect(r.flags.has_deferred_promise).toBe(true);
  });

  it("fail-closed: false/undefined leaves the guard exactly as strict as before", () => {
    for (const v of [false, undefined]) {
      const r = verifyDeferredPromise({
        reply: REPLY,
        toolCalls: [],
        hasActiveThreadRun: v,
      });
      expect(r.hedged, String(v)).toBe(true);
    }
  });

  it("does not resurrect a promise that was never made", () => {
    const r = verifyDeferredPromise({
      reply: "The logo is currently 'Frameworks'.",
      toolCalls: [],
      hasActiveThreadRun: true,
    });
    expect(r.hedged).toBe(false);
    expect(r.flags.has_deferred_promise).toBe(false);
  });
});

describe("deferredPromiseFamilies", () => {
  it("returns [] when the reply promises nothing — caller can skip the lookup", () => {
    expect(deferredPromiseFamilies("The logo is currently 'Frameworks'.")).toEqual([]);
    expect(deferredPromiseFamilies("")).toEqual([]);
  });

  it("reports the pr family for a deferred PR promise", () => {
    expect(deferredPromiseFamilies("I'll open a PR and post the link here.")).toContain("pr");
  });

  it("returns [] for an already-bannered reply (idempotent with the guard)", () => {
    const bannered = verifyDeferredPromise({
      reply: "I'll open a PR shortly.",
      toolCalls: [],
    });
    expect(bannered.hedged).toBe(true);
    expect(deferredPromiseFamilies(bannered.text)).toEqual([]);
  });

  it("agrees with the guard: families non-empty exactly when a promise is detected", () => {
    for (const reply of [
      "I'll open a PR and post the link here.",
      "The logo is currently 'Frameworks'.",
      "Handing off to the engineer — I'll post the result back.",
    ]) {
      const detected = verifyDeferredPromise({ reply, toolCalls: [] }).flags.has_deferred_promise;
      expect(deferredPromiseFamilies(reply).length > 0, reply).toBe(detected);
    }
  });
});
