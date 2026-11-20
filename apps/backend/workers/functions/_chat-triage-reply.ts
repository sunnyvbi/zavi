
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import {
  selectReplyTextFromRow,
  type TerminalRunRow,
} from "@/services/agents/terminal-reply-text";
import { handoffChildReplyText, isHandoffChildPayload } from "@/services/agents/handoff-result";
import type { RunOutcome } from "@/services/agents/outcome-model";

const MAX_BODY = 28_000;

type Svc = ReturnType<typeof serviceClient>;

type RunRow = {
  tenant_id: string;
  trigger: string | null;
  status: string | null;
  output_text: string | null;
  error: string | null;
  parse_error: string | null;
  agent_slug: string | null;
  outcome: TerminalRunRow["outcome"];
  payload: Record<string, unknown> | null;
  parsed: Record<string, unknown> | null;
};

export type ChatReplyResult =
  | { ok: true; chunks: number }
  | { ok: false; disabled?: boolean; gone?: boolean; sent: number; error: string };

export type ChatTriageReplySpec<R> = {
  trigger: string;
  claimsTable: string;
  routing: (payload: Record<string, unknown> | null) => R | null;
  binding: (svc: Svc, r: R, tenantId: string) => Promise<unknown>;
  post: (r: R, text: string) => Promise<ChatReplyResult>;
  onGone?: (svc: Svc, r: R, tenantId: string) => Promise<void>;
  goneSkip: string;
  canSend?: (r: R) => boolean;
};

export function makeChatTriageReply<R>(spec: ChatTriageReplySpec<R>) {
  const { trigger } = spec;
  const source = `${trigger}-triage-reply`;
  const delegatedKey = `${trigger}_reply_delegated`;

  return async function replyOne(run_id: string): Promise<unknown> {
    const svc = serviceClient();

    const { data: run } = await svc
      .from("agent_runs")
      .select("tenant_id, trigger, status, output_text, error, parse_error, agent_slug, outcome, payload, parsed")
      .eq("id", run_id)
      .maybeSingle<RunRow>();
    if (!run) return { skip: "run_not_found" };
    if (run.trigger !== trigger) return { skip: `not_${trigger}_triage` };

    if (run.payload?.[delegatedKey] === true) return { skip: delegatedKey };

    const routing = spec.routing(run.payload);
    if (!routing) return { skip: `no_${trigger}_routing` };
    if (spec.canSend && !spec.canSend(routing)) return { skip: "destination_not_served" };

    const binding = await spec.binding(svc, routing, run.tenant_id);
    if (!binding) {
      await logEvent({
        level: "warn",
        source,
        code: `${trigger}.reply.binding_stale`,
        message: `${trigger} run ${run_id}: destination is no longer an enabled binding for this tenant; reply dropped`,
        tenant_id: run.tenant_id,
      });
      return { skip: "binding_not_current" };
    }

    const { error: claimErr } = await svc
      .from(spec.claimsTable)
      .insert({ run_id, tenant_id: run.tenant_id });
    if (claimErr) return { skip: "reply_already_handled" };

    async function releaseClaim() {
      await svc.from(spec.claimsTable).delete().eq("run_id", run_id);
    }

    const reply = selectReplyTextFromRow({
      status: run.status,
      output_text: run.output_text,
      error: run.error,
      parse_error: run.parse_error,
      agent_slug: run.agent_slug,
      outcome: run.outcome,
    });
    if (reply.isError) {
      await logEvent({
        level: "warn",
        source,
        code: `${trigger}.reply.run_failed`,
        message: `${trigger} run ${run_id} status=${run.status}; posting the failure note`,
        tenant_id: run.tenant_id,
      });
    }

    let body = isHandoffChildPayload(run.payload)
      ? handoffChildReplyText(
          { ...run, outcome: run.outcome as Partial<RunOutcome> | null },
          run_id,
        )
      : (reply.markdown ?? "").trim();
    if (!body) {
      await releaseClaim();
      return { skip: "empty_output" };
    }
    if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);

    const result = await spec.post(routing, body);
    if (result.ok) return { sent: true, run_id, chunks: result.chunks, failure: reply.isError };

    if (result.gone) {
      if (spec.onGone) await spec.onGone(svc, routing, run.tenant_id);
      await logEvent({
        level: "warn",
        source,
        code: `${trigger}.reply.${spec.goneSkip}`,
        message: `${trigger} destination gone for run ${run_id}: ${result.error}`,
        tenant_id: run.tenant_id,
      });
      return { skip: spec.goneSkip, error: result.error };
    }
    if (result.sent > 0) {
      await logEvent({
        level: "warn",
        source,
        code: `${trigger}.reply.partial_send`,
        message: `${trigger} run ${run_id}: ${result.sent} chunk(s) sent before failure (${result.error}); tail dropped, claim kept`,
        tenant_id: run.tenant_id,
      });
      return { skip: "partial_send", sent: result.sent, error: result.error, run_id };
    }
    if (result.disabled) {
      await releaseClaim();
      return { skip: `${trigger}_disabled`, run_id };
    }
    await releaseClaim();
    throw new Error(`${trigger}_send_failed run=${run_id}: ${result.error}`);
  };
}
