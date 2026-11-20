
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";

const PostBody = z.object({
  tenant_id: z.string().uuid(),
  slack_user_id: z.string().min(1),
});

export async function staffErasureSlackPost(
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
  const { tenant_id, slack_user_id } = parsed.data;

  const sb = serviceClient();

  const { count: rowCount, error: countErr } = await sb
    .from("slack_message_index")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", tenant_id)
    .eq("author_user_id", slack_user_id);
  if (countErr) {
    res.status(500).json({
      error: { code: "count_failed", message: countErr.message },
    });
    return;
  }

  const { error: updErr } = await sb
    .from("slack_message_index")
    .update({ author_user_id: null })
    .eq("tenant_id", tenant_id)
    .eq("author_user_id", slack_user_id);
  if (updErr) {
    res.status(500).json({
      error: { code: "erasure_failed", message: updErr.message },
    });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "slack_erasure_slack",
    target_table: "slack_message_index",
    target_id: `${tenant_id}/${slack_user_id}`,
    meta: {
      tenant_id,
      slack_user_id,
      rows_nullified: rowCount ?? 0,
    },
  });

  res.json({
    ok: true,
    tenant_id,
    slack_user_id,
    rows_nullified: rowCount ?? 0,
  });
}
