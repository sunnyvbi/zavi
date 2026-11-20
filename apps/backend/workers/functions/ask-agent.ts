
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { enqueueAgentRun } from "@/services/agents/runner";
import {
  handleAskDeadline,
  handleChildCompleted,
  sweepStaleAsks,
  type AskDeps,
} from "@/services/agents/ask-agent";

function deps(): AskDeps {
  return {
    svc: serviceClient(),
    enqueue: enqueueAgentRun,
    sendEvent: (evt) => inngest.send(evt as never),
  };
}

export const askChildCompletedFn = inngest.createFunction(
  {
    id: "ask-agent-child-completed",
    idempotency: "event.data.child_run_id",
    retries: 3,
  },
  { event: "agent.child.completed" },
  async ({ event, step }) => {
    const child_run_id = event.data?.child_run_id;
    if (typeof child_run_id !== "string" || !child_run_id) {
      return { status: "skip", reason: "missing_child_run_id" };
    }
    const result = await step.run("settle-child", () => handleChildCompleted(child_run_id, deps()));
    return { status: "ok", result };
  },
);

export const askDeadlineFn = inngest.createFunction(
  {
    id: "ask-agent-deadline",
    idempotency: "event.data.ask_id",
    retries: 3,
  },
  { event: "agent.ask.deadline" },
  async ({ event, step }) => {
    const ask_id = event.data?.ask_id;
    if (typeof ask_id !== "string" || !ask_id) {
      return { status: "skip", reason: "missing_ask_id" };
    }
    const deadline = await step.run("read-deadline", async () => {
      const { data } = await serviceClient()
        .from("agent_asks")
        .select("deadline_at, outcome")
        .eq("id", ask_id)
        .maybeSingle<{ deadline_at: string; outcome: string | null }>();
      return data ?? null;
    });
    if (!deadline) return { status: "skip", reason: "ask_missing" };
    if (deadline.outcome) return { status: "skip", reason: `already_${deadline.outcome}` };
    await step.sleepUntil("until-ask-deadline", new Date(deadline.deadline_at));
    const result = await step.run("claim-timeout", () => handleAskDeadline(ask_id, deps()));
    return { status: "ok", result };
  },
);

export const askSweepFn = inngest.createFunction(
  { id: "ask-agent-sweep", concurrency: 1 },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const result = await step.run("sweep", () => sweepStaleAsks(deps()));
    return { status: "ok", ...result };
  },
);
