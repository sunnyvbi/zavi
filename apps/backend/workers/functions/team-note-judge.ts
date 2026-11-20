
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { getBoolSetting, getNumberSetting } from "@/services/settings";
import { logEvent } from "@/services/logging/logEvent";
import {
  canOffer, claimJudgement, offerNote, promoteNote, recordJudgement, type JudgementVerdict,
} from "@/services/team-notes/store";
import { haikuTransport, judgeWith } from "@/services/team-notes/judge";
import {
  DEFAULT_TOOL_LOOP_THRESHOLD, DEFAULT_TOOL_THRASH_THRESHOLD, TOOL_FACT_SIGNALS,
  buildRunToolFacts, classifyRunError, isHardRunFailure, noteSurface, sortBySignalPrecedence, teamNoteFingerprint,
} from "@/services/team-notes/signals";

type Msg = {
  id: string; tenant_id: string; thread_id: string; sender_role: string;
  body: string | null; created_at: string; meta?: Record<string, unknown> | null;
};
const numberOr = async (key: "team_note_tool_loop_threshold" | "team_note_tool_thrash_threshold", fallback: number) => {
  try { return await getNumberSetting(key); } catch { return fallback; }
};
const WAIT_POLLS = 9;

export const teamNoteJudgeFn = inngest.createFunction(
  {
    id: "team-note-judge",
    retries: 1,
    idempotency: "event.data.run_id + '-' + event.data.source",
    concurrency: { key: "event.data.run_id", limit: 1 },
  },
  { event: "team_note.candidate" },
  async ({ event, step, logger }) => {
    const d = event.data as {
      run_id?: string; source?: string; signals?: string[]; fingerprint?: string;
      correction_message_id?: string; edited_message_id?: string;
    };
    if (!d.run_id || !d.source || !Array.isArray(d.signals) || d.signals.length === 0) {
      return { offered: false, reason: "bad_event" };
    }
    const runId = d.run_id;
    const signals = sortBySignalPrecedence(d.signals);
    const source = d.source as "run_end" | "correction" | "rephrase" | "edit";
    let tenantForLog: string | null = null;
    let agentForLog: string | undefined;

    try {
      const wantsFacts = source === "run_end" && signals.some((s) => TOOL_FACT_SIGNALS.has(s));
      const run = await step.run("load-run", async () => {
        const { data } = await serviceClient().from("agent_runs")
          .select(wantsFacts
            ? "id, tenant_id, agent_slug, trigger, payload, status, error, tool_calls"
            : "id, tenant_id, agent_slug, trigger, payload, status, error")
          .eq("id", runId).maybeSingle();
        const r = data as { tenant_id: string; agent_slug: string; trigger: string; status?: string | null;
          error?: string | null; payload: { thread_id?: string; user_message_id?: string } | null;
          tool_calls?: unknown } | null;
        if (!r || r.trigger !== "chat" || !r.payload?.thread_id) return null;
        const runFacts = wantsFacts
          ? buildRunToolFacts(r.tool_calls, {
              loopThreshold: await numberOr("team_note_tool_loop_threshold", DEFAULT_TOOL_LOOP_THRESHOLD),
              thrashThreshold: await numberOr("team_note_tool_thrash_threshold", DEFAULT_TOOL_THRASH_THRESHOLD),
            })
          : [];
        const failed = typeof r.status === "string" && r.status !== "success" && r.status !== "cancelled";
        return { tenantId: r.tenant_id, agentSlug: r.agent_slug, threadId: r.payload.thread_id,
          askId: r.payload.user_message_id ?? null, runFacts,
          errorClass: failed && r.error ? classifyRunError(r.error) : null,
          hardFailed: isHardRunFailure(r.status, r.error) };
      });
      if (!run) return { offered: false, reason: "not_found" };
      tenantForLog = run.tenantId;
      agentForLog = run.agentSlug;
      const skip = (reason: string, stage: string) => {
        void logEvent({ level: "info", source: "team-note-judge", code: `team_note.skip.${reason}`,
          tenant_id: run.tenantId, run_id: runId, meta: { agent_slug: run.agentSlug, stage } });
        return { offered: false, reason };
      };
      if (!(await getBoolSetting("team_note_enabled", run.tenantId))) return skip("disabled", "precheck");

      const readReply = (label: string) => step.run(label, async () => {
        let q = serviceClient().from("agent_thread_messages")
          .select("id, tenant_id, thread_id, sender_role, body, created_at, meta")
          .eq("agent_run_id", runId).eq("tenant_id", run.tenantId).eq("thread_id", run.threadId)
          .eq("sender_role", "assistant");
        if (source !== "edit") q = q.filter("meta->>superseded_by", "is", null);
        const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
        return (data as Msg | null) ?? null;
      });

      let reply = await readReply("load-reply");
      for (let i = 0; !reply && i < WAIT_POLLS; i++) {
        await step.sleep(`wait-reply-${i}`, "20s");
        reply = await readReply(`load-reply-${i}`);
      }
      if (!reply?.body || reply.meta?.stopped === true) return skip("no_reply", "load");
      const replyId = reply.id;
      const replyBody = reply.body;

      const texts = await step.run("load-texts", async () => {
        const sb = serviceClient();
        let ask: Msg | null = null;
        if (run.askId) {
          const { data } = await sb.from("agent_thread_messages")
            .select("id, tenant_id, thread_id, sender_role, body, created_at")
            .eq("id", run.askId).eq("tenant_id", run.tenantId).eq("thread_id", run.threadId).maybeSingle();
          ask = (data as Msg | null)?.sender_role === "user" ? (data as Msg) : null;
        }
        let followUp: string | null = null;
        if (source !== "run_end") {
          if (!d.correction_message_id) return null;
          if (source === "edit" && d.edited_message_id !== run.askId) return null;
          const { data } = await sb.from("agent_thread_messages")
            .select("id, tenant_id, thread_id, sender_role, body, created_at")
            .eq("id", d.correction_message_id).eq("tenant_id", run.tenantId).maybeSingle();
          const cm = data as Msg | null;
          if (!cm || cm.thread_id !== run.threadId || cm.sender_role !== "user") return null;
          if (ask && cm.created_at <= ask.created_at) return null;
          followUp = cm.body;
        }
        return { ask: ask?.body ?? "", followUp };
      });
      if (!texts) return skip("follow_up_mismatch", "load");

      const enabled = () => getBoolSetting("team_note_enabled", run.tenantId);
      const proposed = noteSurface({ signals, errorClass: run.errorClass });
      const surface = proposed === "strip" && source === "run_end" && !run.hardFailed ? "flag" : proposed;
      const pushback = source === "correction";
      const anchor = surface !== "strip" ? null
        : source === "run_end" ? replyId
        : pushback ? (d.correction_message_id ?? null)
        : null;
      if (surface === "strip" && !anchor) return skip("no_anchor", "precheck");

      const promote = async (stage: string) => {
        if (!anchor) return skip("no_anchor", stage);
        const p = await step.run(`promote-${stage}`, async () =>
          (await enabled()) ? promoteNote(run.tenantId, { messageId: replyId, anchorMessageId: anchor, signals }) : null);
        if (!p) return skip("disabled", stage);
        void logEvent({ level: "info", source: "team-note-judge",
          code: p.promoted ? "team_note.promoted" : `team_note.skip.${p.reason ?? "unknown"}`,
          tenant_id: run.tenantId, run_id: runId, meta: { agent_slug: run.agentSlug, stage } });
        return { offered: false, promoted: p.promoted, ...(p.promoted ? {} : { reason: p.reason ?? "unknown" }) };
      };

      const pre = await step.run("precheck", () =>
        canOffer(run.tenantId, replyId, { applyCaps: surface === "strip" && source === "run_end" }));
      if (pre === "already_offered" && pushback) return await promote("precheck");
      if (pre !== "ok") return skip(pre, "precheck");

      const claimed = await step.run("claim", async () =>
        (await enabled())
          ? await claimJudgement(run.tenantId, replyId, source, signals, run.hardFailed)
          : "disabled");
      if (claimed === "disabled") return skip("disabled", "claim");
      if (claimed === "offered" && pushback) return await promote("claim");
      if (claimed !== "claimed" && claimed !== "upgraded") return skip("already_judged", "claim");

      const judged = await step.run("judge", async () => {
        if (!(await enabled())) return null;
        return judgeWith(
          { ask: texts.ask, reply: replyBody, correction: texts.followUp, signals, runFacts: run.runFacts },
          haikuTransport({ tenantId: run.tenantId, runId }),
        );
      });
      if (!judged) return skip("disabled", "judge");
      if (judged.usage) {
        void logEvent({ level: "info", source: "team-note-judge", code: "team_note.judge_usage",
          tenant_id: run.tenantId, run_id: runId,
          meta: { agent_slug: run.agentSlug, stage: "judge",
                  input_tokens: judged.usage.input_tokens, output_tokens: judged.usage.output_tokens } });
      }
      const verdict = judged.verdict;
      const outcome: JudgementVerdict = verdict.bad ? "bad" : (verdict.failed ?? "no");

      const record = () => step.run("record-judgement", async () => {
        try {
          return await recordJudgement(run.tenantId, {
            messageId: replyId, source, signals, verdict: outcome,
            judgeSignal: verdict.bad ? verdict.signal : null, surface: verdict.bad ? surface : null,
          });
        } catch {
          void logEvent({ level: "warn", source: "team-note-judge", code: "team_note.judgement_record_failed",
            tenant_id: run.tenantId, run_id: runId, meta: { agent_slug: run.agentSlug, stage: "record" } });
          return false;
        }
      });

      if (!verdict.bad) {
        await record();
        if (verdict.failed) {
          void logEvent({ level: "warn", source: "team-note-judge", code: `team_note.judge_failed.${verdict.failed}`,
            tenant_id: run.tenantId, run_id: runId, meta: { agent_slug: run.agentSlug, stage: "judge" } });
        }
        return { offered: false, reason: verdict.failed ? `judge_${verdict.failed}` : "judge_no" };
      }

      const fingerprint = source === "run_end" && /^[0-9a-f]{16}$/.test(d.fingerprint ?? "")
        ? (d.fingerprint as string)
        : teamNoteFingerprint({ agentSlug: run.agentSlug, signal: signals[0], tool: null, errorCode: null, failureShape: null });

      const res = await step.run("draft", () =>
        offerNote(run.tenantId, {
          messageId: replyId, source, signal: verdict.signal, signals, fingerprint, note: verdict.note,
          surface, anchorMessageId: anchor,
        }),
      );
      await record();
      if (!res.offered && res.reason === "already_offered" && pushback) return await promote("draft");
      void logEvent({ level: "info", source: "team-note-judge",
        code: res.offered ? "team_note.drafted" : `team_note.skip.${res.reason ?? "unknown"}`,
        tenant_id: run.tenantId, run_id: runId, meta: { agent_slug: run.agentSlug, stage: "draft", surface } });
      logger.info(`[team-note-judge] ${runId}: drafted=${res.offered}`);
      return { offered: res.offered };
    } catch (e) {
      void logEvent({ level: "warn", source: "team-note-judge", code: "team_note.worker_error",
        tenant_id: tenantForLog, run_id: runId,
        meta: { ...(agentForLog ? { agent_slug: agentForLog } : {}), stage: "worker" } });
      throw e;
    }
  },
);
