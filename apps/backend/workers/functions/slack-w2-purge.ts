
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";

const CHUNK_SIZE = 1000;
const CHUNK_GAP_MS = 100;
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

export const slackW2PurgeFn = inngest.createFunction(
  { id: "slack-w2-purge", concurrency: 1, retries: 1 },
  { event: "slack.w2.purge.requested" },
  async ({ event, step, logger }) => {
    const tenant_id = event.data.tenant_id;
    const reason = event.data.reason ?? "unknown";
    if (!tenant_id || typeof tenant_id !== "string") {
      logger.warn("slack-w2-purge: missing tenant_id in event data");
      return { status: "skip", reason: "missing_tenant_id" };
    }

    const tenantExists = await step.run("verify-tenant", async () => {
      const sb = serviceClient();
      const { data, error } = await sb
        .from("tenants")
        .select("id")
        .eq("id", tenant_id)
        .maybeSingle();
      if (error) {
        throw new Error(`tenants re-verify failed: ${error.message}`);
      }
      return data !== null;
    });
    if (!tenantExists) {
      logger.warn(
        `slack-w2-purge: tenant_id=${tenant_id} not found in tenants (forged/stale event?) — skip`,
      );
      return { status: "skip", reason: "tenant_not_found", tenant_id };
    }

    let totalIndexDeleted = 0;
    let chunkIdx = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const chunk = await step.run(`purge-index-chunk-${chunkIdx}`, async () => {
        const sb = serviceClient();
        const { data: rows, error: selErr } = await sb
          .from("slack_message_index")
          .select("channel_id, ts")
          .eq("tenant_id", tenant_id)
          .limit(CHUNK_SIZE);
        if (selErr) throw new Error(`slack_message_index select: ${selErr.message}`);
        const pks =
          (rows as Array<{ channel_id: string; ts: string }> | null) ?? [];
        if (pks.length === 0) return { deleted: 0, done: true };

        let deleted = 0;
        for (const r of pks) {
          const { error: delErr } = await sb
            .from("slack_message_index")
            .delete()
            .eq("tenant_id", tenant_id)
            .eq("channel_id", r.channel_id)
            .eq("ts", r.ts);
          if (delErr) {
            logger.warn(
              `slack-w2-purge: per-row delete failed (${r.channel_id}/${r.ts}): ${delErr.message}`,
            );
            continue;
          }
          deleted += 1;
        }
        return { deleted, done: pks.length < CHUNK_SIZE };
      });

      totalIndexDeleted += chunk.deleted;
      chunkIdx += 1;
      if (chunk.done) break;
      await step.sleep(`gap-index-${chunkIdx}`, `${CHUNK_GAP_MS}ms`);
    }

    let totalMemoryDeleted = 0;
    let mChunkIdx = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const chunk = await step.run(`purge-memory-chunk-${mChunkIdx}`, async () => {
        const sb = serviceClient();
        const { data: rows, error: selErr } = await sb
          .from("memory_note")
          .select("id")
          .eq("tenant_id", tenant_id)
          .eq("source", "auto_distill_slack")
          .limit(CHUNK_SIZE);
        if (selErr) throw new Error(`memory_note select: ${selErr.message}`);
        const ids = ((rows as Array<{ id: string }> | null) ?? []).map((r) => r.id);
        if (ids.length === 0) return { deleted: 0, done: true };

        const { error: delErr } = await sb
          .from("memory_note")
          .delete()
          .eq("tenant_id", tenant_id)
          .in("id", ids);
        if (delErr) throw new Error(`memory_note delete: ${delErr.message}`);
        return { deleted: ids.length, done: ids.length < CHUNK_SIZE };
      });

      totalMemoryDeleted += chunk.deleted;
      mChunkIdx += 1;
      if (chunk.done) break;
      await step.sleep(`gap-memory-${mChunkIdx}`, `${CHUNK_GAP_MS}ms`);
    }

    const now = new Date().toISOString();
    await step.run("mark-purged", async () => {
      const sb = serviceClient();
      const { error: stateErr } = await sb
        .from("tenant_slack_index_state")
        .update({
          purged_at: now,
          purge_row_count: totalIndexDeleted,
          updated_at: now,
        })
        .eq("tenant_id", tenant_id);
      if (stateErr) {
        logger.warn(
          `slack-w2-purge: state update failed for tenant=${tenant_id}: ${stateErr.message}`,
        );
      }
      const { error: auditErr } = await sb.from("staff_audit_log").insert({
        actor_user_id: SYSTEM_ACTOR,
        actor_email: "system@zavi",
        action: "slack_w2_purge",
        target_table: "tenant_slack_index_state",
        target_id: tenant_id,
        tenant_id,
        meta: {
          tenant_id,
          reason,
          slack_message_index_deleted: totalIndexDeleted,
          memory_note_deleted: totalMemoryDeleted,
        },
      });
      if (auditErr && auditErr.code !== "23505") {
        logger.warn(
          `slack-w2-purge: audit insert failed for tenant=${tenant_id}: ${auditErr.message}`,
        );
      }
    });

    logger.info(
      `slack-w2-purge tenant=${tenant_id} reason=${reason} slack_index_deleted=${totalIndexDeleted} memory_note_deleted=${totalMemoryDeleted}`,
    );
    return {
      tenant_id,
      reason,
      slack_message_index_deleted: totalIndexDeleted,
      memory_note_deleted: totalMemoryDeleted,
    };
  },
);
