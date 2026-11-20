
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { backfillNoActionSignals } from "@/services/agents/engagement";
import { writeNote } from "@/services/memory";
import {
  runExternalLearningStep,
  defaultGuardedFetch,
  externalLearningEnabled,
  type LearningSourceRow,
} from "@/services/agents/external-learning";
import { renderUntrustedBlock } from "@/services/agents/prompt-injection";

const REACTIVE_AGENT_SLUGS = [
  "support-lead",
  "dispute-response",
  "qa",
] as const;

const ENGAGEMENT_WINDOW_DAYS = 30;
const PREDICTION_STALE_DAYS = 30;
const MIN_SIGNALS_FOR_LEARNING = 5;
const NO_ACTION_RATE_THRESHOLD = 0.8;

type EngagementRow = {
  tenant_id: string;
  agent_slug: string;
  signal_type: string;
  category: string | null;
};

export const agentLearnWeeklyFn = inngest.createFunction(
  { id: "agent-learn-weekly" },
  { cron: "0 8 * * 0" },
  async ({ logger }) => {
    const stats = {
      backfilled: 0,
      learnings_written: 0,
      predictions_marked_unverifiable: 0,
      external_notes_written: 0,
      external_enabled: false,
    };

    try {
      const { count } = await backfillNoActionSignals({ hours: 24 });
      stats.backfilled = count;
    } catch (e) {
      logger.warn(`agent-learn-weekly: backfill failed: ${(e as Error).message}`);
    }

    try {
      const sb = serviceClient();
      const cutoff = new Date(
        Date.now() - ENGAGEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { data: signals, error } = await sb
        .from("agent_engagement_signals")
        .select("tenant_id,agent_slug,signal_type,category")
        .in("agent_slug", REACTIVE_AGENT_SLUGS as readonly string[])
        .gt("captured_at", cutoff)
        .limit(10000);
      if (error) {
        logger.warn(`agent-learn-weekly: engagement query failed: ${error.message}`);
      } else if (signals && signals.length > 0) {
        const buckets = new Map<
          string,
          { tenant_id: string; agent_slug: string; category: string; total: number; no_action: number }
        >();
        for (const s of signals as EngagementRow[]) {
          if (!s.category) continue;
          const key = `${s.tenant_id}::${s.agent_slug}::${s.category}`;
          let b = buckets.get(key);
          if (!b) {
            b = {
              tenant_id: s.tenant_id,
              agent_slug: s.agent_slug,
              category: s.category,
              total: 0,
              no_action: 0,
            };
            buckets.set(key, b);
          }
          b.total += 1;
          if (s.signal_type === "no_action_after_24h" || s.signal_type === "dismissed") {
            b.no_action += 1;
          }
        }
        for (const b of buckets.values()) {
          if (b.total < MIN_SIGNALS_FOR_LEARNING) continue;
          const rate = b.no_action / b.total;
          if (rate < NO_ACTION_RATE_THRESHOLD) continue;
          const { data: existing } = await sb
            .from("memory_note")
            .select("id")
            .eq("tenant_id", b.tenant_id)
            .contains("tags", [`agent:${b.agent_slug}`, "type:learning", `category:${b.category}`])
            .gt("created_at", cutoff)
            .limit(1);
          if (existing && existing.length > 0) continue;
          const title = `Deprioritize ${b.category} for ${b.agent_slug}`;
          const body = `Over the last ${ENGAGEMENT_WINDOW_DAYS} days, the operator ignored ${b.no_action} of ${b.total} ${b.agent_slug} runs in the \`${b.category}\` category (no-action rate ${Math.round(rate * 100)}%). Treat this category as low-signal: skip it unless the run shows a NEW pattern, and lead with higher-priority categories first.`;
          const { error: insErr } = await sb.from("memory_note").insert({
            tenant_id: b.tenant_id,
            title,
            body_markdown: body,
            source: "auto_distill_agent_run",
            source_ref: `agent-learn-weekly/${b.agent_slug}/${b.category}`,
            tags: [
              `agent:${b.agent_slug}`,
              "type:learning",
              `category:${b.category}`,
              "source:auto_distill_agent_run",
            ],
          });
          if (insErr) {
            logger.warn(
              `agent-learn-weekly: learning insert failed for ${b.agent_slug}/${b.category}: ${insErr.message}`,
            );
          } else {
            stats.learnings_written += 1;
          }
        }
      }
    } catch (e) {
      logger.warn(`agent-learn-weekly: engagement aggregation failed: ${(e as Error).message}`);
    }

    try {
      const staleCutoff = new Date(
        Date.now() - PREDICTION_STALE_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const { count, error } = await serviceClient()
        .from("agent_prediction_signals")
        .update(
          { outcome: "unverifiable", outcome_at: new Date().toISOString(), outcome_reason: "auto: still pending after 30d, no LLM audit in v1" },
          { count: "exact" },
        )
        .is("outcome", null)
        .lt("predicted_at", staleCutoff);
      if (error) {
        logger.warn(`agent-learn-weekly: prediction stale-mark failed: ${error.message}`);
      } else {
        stats.predictions_marked_unverifiable = count ?? 0;
      }
    } catch (e) {
      logger.warn(`agent-learn-weekly: prediction stale-mark threw: ${(e as Error).message}`);
    }

    try {
      stats.external_enabled = externalLearningEnabled();
      const ext = await runExternalLearningStep({
        db: {
          async readEnabledSources(): Promise<LearningSourceRow[]> {
            const { data, error } = await serviceClient()
              .from("agent_learning_sources")
              .select(
                "id,tenant_id,agent_slug,source_url,domain_allowlist,enabled,fetch_cap,content_hash,etag,failure_count",
              )
              .eq("enabled", true)
              .limit(500);
            if (error) throw new Error(error.message);
            return (data as LearningSourceRow[]) ?? [];
          },
        },
        fetchSource: defaultGuardedFetch,
        wrapSearch: (label, raw) => renderUntrustedBlock(label, raw),
        async writeNote(input) {
          const res = await writeNote(input.tenant_id, {
            title: input.title,
            body_markdown: input.body_markdown,
            source: "external_learning_distill",
            source_ref: input.source_ref,
            tags: input.tags,
            note_type: "learning",
            agent_slug: input.agent_slug,
            trust_tier: 3,
            metadata: input.metadata,
          });
          return { note_id: res.note_id };
        },
        logger,
      });
      stats.external_notes_written = ext.notes_written;
    } catch (e) {
      logger.warn(`agent-learn-weekly: external-learning step threw: ${(e as Error).message}`);
    }

    logger.info(
      `agent-learn-weekly: backfilled=${stats.backfilled} learnings_written=${stats.learnings_written} predictions_marked_unverifiable=${stats.predictions_marked_unverifiable} external_enabled=${stats.external_enabled} external_notes_written=${stats.external_notes_written}`,
    );
    return stats;
  },
);
