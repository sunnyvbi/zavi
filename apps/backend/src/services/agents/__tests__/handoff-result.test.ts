import { describe, it, expect, vi } from "vitest";
import {
  composeHandoffBody,
  handoffChildReplyText,
  postHandoffResultToOperatorThread,
  parentReplyPending,
  waitForParentReply,
} from "../handoff-result";
import {
  scrubAgentEgress,
  PII_SCRUB_AGENT_SLUGS,
} from "../scrub-agent-egress";

describe("composeHandoffBody", () => {
  const base = {
    tenant_id: "t1",
    run_id: "r1",
    operator_thread_id: "th1",
    from_agent_slug: "pm",
  } as const;

  it("cgo answer with only internal vocabulary posts an honest line, never 'Done.'", () => {
    const body = composeHandoffBody({
      ...base,
      from_agent_slug: "cgo",
      payload: { operator_thread_id: "th1" },
      status: "success",
      output_text: "I checked mcp__growth__read_ads_perf first.\n\nSee the sandbox log.",
      outcome: { side_effect: { kind: "refused" } } as never,
    });
    expect(body).toBe(
      "Your CGO couldn't put together a usable answer this time. Ask again and it will try once more.",
    );
    expect(body).not.toMatch(/Done\.|No changes were made|\u2014/);
  });

  it("success path: a clean output_text is the whole body, no status line, no prefix", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "Your roadmap now leads with the checkout fix.",
    });
    expect(body).toBe("Your roadmap now leads with the checkout fix.");
    expect(body).not.toMatch(/handed off from/);
  });

  it("engineer no_change: leads with the engineer's answer, never 'didn't finish'", () => {
    const summary = "Row-level security is already on for every table, so there is nothing to fix.";
    const body = composeHandoffBody({
      ...base,
      from_agent_slug: "engineer",
      status: "success",
      output_text: "Checked every table: all have RLS enabled.",
      outcome: {
        deliverable: "Checked every table: all have RLS enabled.",
        side_effect: { kind: "refused", reason: "refused_envelope", reason_code: "no_change" },
        customer_summary: summary,
      },
    });
    expect(body).toBe(`${summary}\n\nNo changes were made.`);
    expect(body).not.toMatch(/didn't finish/);
  });

  it("raw_response_text is never shown, even when output_text is empty", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "",
      raw_response_text: "raw output",
    });
    expect(body).toBe("Finished.");
  });

  it("no text at all: status line only, no run id", () => {
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: "",
      raw_response_text: "",
    });
    expect(body).toBe("Finished.");
    expect(body).not.toContain("r1");
  });

  it("failure path: error-shaped body, humanised (no raw error echoed)", () => {
    const body = composeHandoffBody({
      ...base,
      status: "failed",
      error: "boom",
    });
    expect(body.startsWith("This didn't finish. Nothing was saved. I can try again.")).toBe(true);
    expect(body).not.toContain("boom");
    expect(body).not.toMatch(/@pm/);
  });

  it("failure path never uses a failed run's output_text as the summary", () => {
    const body = composeHandoffBody({
      ...base,
      status: "failed",
      output_text: "Error: boom at src/x.ts:1",
    });
    expect(body.startsWith("This didn't finish. Nothing was saved. I can try again.")).toBe(true);
    expect(body).not.toContain("boom");
    expect(body).not.toContain("x.ts");
  });

  it("missing error string still produces a humanised failure body", () => {
    const body = composeHandoffBody({
      ...base,
      status: "error",
    });
    expect(body.startsWith("This didn't finish.")).toBe(true);
    expect(body).not.toContain("unknown error");
  });

  it("NEVER leaks internal control-plane vocabulary to the customer", () => {
    for (const raw of [
      "resolve-repo-creds: GitHub App not connected for this tenant. Install via /connectors before running sandbox agents.",
      "worktree_insufficient_disk: per-run worktree create failed for run=abc",
      "boot_reap: container restarted",
    ]) {
      const body = composeHandoffBody({ ...base, status: "failed", error: raw });
      expect(body).not.toContain("resolve-repo-creds");
      expect(body).not.toContain("/connectors");
      expect(body).not.toContain("sandbox agents");
      expect(body).not.toContain("worktree_insufficient_disk");
      expect(body).not.toContain("boot_reap");
    }
  });

  it("parse_failed: the couldnt phrase; a clean deliverable follows as the summary (run a524dd47)", () => {
    const body = composeHandoffBody({
      ...base,
      status: "failed",
      parse_failed: true,
      output_text: "Here is the ticket spec ready to paste.",
      raw_response_text: "RAW Here is the ticket spec ready to paste...",
      error: "no <product_pm_backlog>...</product_pm_backlog> block found",
    });
    expect(body).toBe(
      "This didn't finish. Nothing was saved. I can try again.\n\nHere is the ticket spec ready to paste.",
    );
    expect(body).not.toContain("product_pm_backlog");
    expect(body).not.toContain("RAW");
  });

  it("parse_failed with no deliverable: the couldnt phrase alone", () => {
    const body = composeHandoffBody({
      ...base,
      status: "failed",
      parse_failed: true,
      raw_response_text: "useful prose here",
    });
    expect(body).toBe("This didn't finish. Nothing was saved. I can try again.");
  });

  it("real failure (not parse_failed): keeps the run-failed shape", () => {
    const body = composeHandoffBody({
      ...base,
      status: "failed",
      parse_failed: false,
      raw_response_text: "shouldn't surface — the run actually crashed",
      error: "tool_iter_cap_exceeded",
    });
    expect(body.startsWith("This didn't finish.")).toBe(true);
    expect(body).not.toContain("tool_iter_cap_exceeded");
    expect(body).not.toContain("shouldn't surface");
  });

  it("caps body to 32000 chars (codex C-P2-10)", () => {
    const huge = "x".repeat(40000);
    const body = composeHandoffBody({
      ...base,
      status: "success",
      output_text: huge,
    });
    expect(body.length).toBe(32000);
    expect(body).toBe(huge.slice(0, 32000));
  });
});

describe("a handed-off specialist's answer on every surface", () => {
  it("email, Teams, Telegram, Discord and WhatsApp get only the answer", () => {
    for (const payload of [{ handoff_child: true }, { whatsapp_handoff_child: true }, { slack_handoff_child: true }]) {
      const text = handoffChildReplyText(
        { status: "success", output_text: "Spend the next $500 on search.", agent_slug: "meta_ads", payload },
        "r1",
      );
      expect(text).toBe("Spend the next $500 on search.");
    }
  });

  it("a surface with no answer still gets a status line, not an empty message", () => {
    const text = handoffChildReplyText(
      { status: "success", output_text: "See the sandbox log.", agent_slug: "meta_ads", payload: { handoff_child: true } },
      "r1",
    );
    expect(text).toBe("Finished.");
  });

  it("a failed handoff keeps the failure line and its detail", () => {
    const body = composeHandoffBody({
      tenant_id: "t1",
      run_id: "r1",
      operator_thread_id: "th1",
      from_agent_slug: "meta_ads",
      status: "failed",
      output_text: "half an answer",
      error: "boom",
    });
    expect(body.startsWith("This didn't finish.")).toBe(true);
    expect(body).not.toContain("half an answer");
  });
});

describe("postHandoffResultToOperatorThread", () => {
  const args = {
    tenant_id: "t1",
    run_id: "r1",
    operator_thread_id: "th1",
    from_agent_slug: "pm",
    status: "success" as const,
    output_text: "Your roadmap now leads with the checkout fix.",
  };

  it("calls recordRpc with composed body + correct param names", async () => {
    const recordRpc = vi.fn().mockResolvedValue({ error: null });
    await postHandoffResultToOperatorThread(args, recordRpc);
    expect(recordRpc).toHaveBeenCalledTimes(1);
    const call = recordRpc.mock.calls[0][0];
    expect(call.p_operator_thread_id).toBe("th1");
    expect(call.p_tenant_id).toBe("t1");
    expect(call.p_run_id).toBe("r1");
    expect(call.p_body).toBe("Your roadmap now leads with the checkout fix.");
  });

  it("swallows RPC error and logs with full context (codex C-P2-9)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recordRpc = vi.fn().mockResolvedValue({
      error: { message: "boom", code: "42501" },
    });
    await postHandoffResultToOperatorThread(args, recordRpc);
    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls[0][0] as string;
    expect(logged).toContain("r1");
    expect(logged).toContain("th1");
    expect(logged).toContain("t1");
    expect(logged).toContain("pm");
    expect(logged).toContain("42501");
    warnSpy.mockRestore();
  });

  it("swallows thrown RPC and logs", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recordRpc = vi.fn().mockRejectedValue(new Error("network down"));
    await postHandoffResultToOperatorThread(args, recordRpc);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain("network down");
    warnSpy.mockRestore();
  });
});

describe("I16 handoff output_text scrubbing (runner.ts block)", () => {
  function selectHandoffOutputText(
    updateOutputText: unknown,
    childResultOutputText: string,
  ): string {
    return typeof updateOutputText === "string" && updateOutputText.length > 0
      ? updateOutputText
      : childResultOutputText;
  }

  function selectHandoffRawResponseText(
    rawResponseText: string | null | undefined,
    agentSlug: string,
  ): string | null {
    return rawResponseText
      ? scrubAgentEgress(rawResponseText, {
          surface: "persist",
          agentSlug,
          scrubPii: PII_SCRUB_AGENT_SLUGS.has(agentSlug),
        }).text
      : null;
  }

  it("uses scrubbed update.output_text, not raw result.output_text", () => {
    const raw = "Here is the answer via generic-dispatcher.ts internals";
    const scrubbed = scrubAgentEgress(raw, {
      surface: "persist",
      agentSlug: "research",
    }).text;

    expect(scrubbed).not.toContain("generic-dispatcher");
    expect(scrubbed).not.toEqual(raw);

    const chosen = selectHandoffOutputText(scrubbed, raw);
    expect(chosen).toBe(scrubbed);
    expect(chosen).not.toContain("generic-dispatcher");
  });

  it("falls back to childResult.output_text only when update.output_text is empty", () => {
    expect(selectHandoffOutputText("", "child-fallback")).toBe("child-fallback");
    expect(selectHandoffOutputText(undefined, "child-fallback")).toBe(
      "child-fallback",
    );
    expect(selectHandoffOutputText("scrubbed-value", "child-fallback")).toBe(
      "scrubbed-value",
    );
  });

  it("scrubs raw_response_text in the parse_failed fallback path", () => {
    const raw = "useful prose mentioning chat-dispatcher.ts internals";
    const out = selectHandoffRawResponseText(raw, "research");
    expect(out).not.toBeNull();
    expect(out).not.toContain("chat-dispatcher");
    expect(out).not.toEqual(raw);
  });

  it("raw_response_text null/empty stays null (no scrub call needed)", () => {
    expect(selectHandoffRawResponseText(null, "research")).toBeNull();
    expect(selectHandoffRawResponseText(undefined, "research")).toBeNull();
    expect(selectHandoffRawResponseText("", "research")).toBeNull();
  });
});

describe("parentReplyPending", () => {
  function fakeSb(opts: { replies?: unknown[]; status?: string | null; replyErr?: boolean; throws?: boolean }) {
    return {
      from: (table: string) => {
        if (opts.throws) throw new Error("boom");
        const chain: Record<string, unknown> = {};
        const self = () => chain;
        chain.select = self;
        chain.eq = self;
        chain.limit = async () =>
          opts.replyErr ? { data: null, error: { message: "x" } } : { data: opts.replies ?? [], error: null };
        chain.maybeSingle = async () => ({
          data: opts.status === null ? null : { status: opts.status ?? "running" },
          error: null,
        });
        void table;
        return chain;
      },
    } as never;
  }

  it("pending while the parent runs and has no reply yet", async () => {
    expect(await parentReplyPending(fakeSb({ status: "running" }), "t1", "p1")).toBe(true);
  });
  it("not pending once the parent's reply is in the thread", async () => {
    expect(await parentReplyPending(fakeSb({ replies: [{ id: "m1" }], status: "running" }), "t1", "p1")).toBe(false);
  });
  it("not pending when the parent finished without a reply", async () => {
    expect(await parentReplyPending(fakeSb({ status: "failed" }), "t1", "p1")).toBe(false);
  });
  it("not pending with no parent, a missing parent, or a read error", async () => {
    expect(await parentReplyPending(fakeSb({}), "t1", null)).toBe(false);
    expect(await parentReplyPending(fakeSb({ status: null }), "t1", "p1")).toBe(false);
    expect(await parentReplyPending(fakeSb({ replyErr: true }), "t1", "p1")).toBe(false);
    expect(await parentReplyPending(fakeSb({ throws: true }), "t1", "p1")).toBe(false);
  });
});

describe("waitForParentReply", () => {
  it("posts at once when nothing is pending", async () => {
    const sleep = vi.fn(async () => {});
    expect(await waitForParentReply(async () => false, { sleep })).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("waits until the parent's reply lands", async () => {
    const answers = [true, true, false];
    const sleep = vi.fn(async () => {});
    const waited = await waitForParentReply(async () => answers.shift() ?? false, { pollMs: 3000, sleep });
    expect(waited).toBe(6000);
  });
  it("gives up at the cap so the answer is never lost", async () => {
    const sleep = vi.fn(async () => {});
    const waited = await waitForParentReply(async () => true, { maxMs: 120_000, pollMs: 3000, sleep });
    expect(waited).toBe(120_000);
    expect(sleep).toHaveBeenCalledTimes(40);
  });
});
