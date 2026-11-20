
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import { inngest } from "@/../workers/client";

const PostBody = z.object({
  tenant_id: z.string().uuid(),
  action: z.enum(["disable", "enable"]),
});

export async function staffSlackW2KillswitchPost(
  req: Request,
  res: Response,
): Promise<void> {
  const staff = assertStaff(req);

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.message },
    });
    return;
  }
  const { tenant_id, action } = parsed.data;

  const sb = serviceClient();

  const { data: current, error: readErr } = await sb
    .from("tenant_slack_index_state")
    .select("disabled_at, purged_at")
    .eq("tenant_id", tenant_id)
    .maybeSingle<{ disabled_at: string | null; purged_at: string | null }>();
  if (readErr) {
    res.status(500).json({
      error: { code: "state_read_failed", message: readErr.message },
    });
    return;
  }
  const wasDisabled = !!current?.disabled_at;

  const now = new Date().toISOString();
  const upsertRow: Record<string, unknown> = {
    tenant_id,
    updated_at: now,
    updated_by: staff.user_id,
  };
  if (action === "disable") {
    upsertRow.disabled_at = now;
  } else {
    upsertRow.disabled_at = null;
  }

  const { error: upsertErr } = await sb
    .from("tenant_slack_index_state")
    .upsert(upsertRow, { onConflict: "tenant_id" });
  if (upsertErr) {
    res.status(500).json({
      error: { code: "state_write_failed", message: upsertErr.message },
    });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: `slack_w2_killswitch.${action}`,
    target_table: "tenant_slack_index_state",
    target_id: tenant_id,
    meta: {
      tenant_id,
      action,
      previous_disabled_at: current?.disabled_at ?? null,
      previous_purged_at: current?.purged_at ?? null,
    },
  });

  if (action === "disable" && !wasDisabled) {
    try {
      await inngest.send({
        name: "slack.w2.purge.requested",
        data: { tenant_id, reason: "killswitch" },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[slack-w2-killswitch] purge enqueue failed for tenant=${tenant_id}: ${(e as Error).message}`,
      );
    }
  }

  res.json({
    ok: true,
    tenant_id,
    action,
    purge_enqueued: action === "disable" && !wasDisabled,
  });
}
