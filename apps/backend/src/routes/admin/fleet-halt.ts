
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";

const PostBody = z.object({
  halted: z.boolean(),
});

type ConfigRow = {
  blob: Record<string, unknown>;
  updated_at: string | null;
  updated_by: string | null;
};

export async function staffFleetHaltGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const { data, error } = await serviceClient()
    .from("system_config")
    .select("blob, updated_at, updated_by")
    .eq("id", 1)
    .maybeSingle<ConfigRow>();
  if (error) {
    res.status(500).json({
      error: { code: "fleet_halt_read_failed", message: error.message },
    });
    return;
  }
  const blob = (data?.blob ?? {}) as Record<string, unknown>;
  res.json({
    halted: blob.fleet_halt === true,
    updated_at: data?.updated_at ?? null,
    updated_by: data?.updated_by ?? null,
  });
}

export async function staffFleetHaltPost(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);

  const parsed = PostBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "invalid_body", message: parsed.error.message },
    });
    return;
  }
  const { halted } = parsed.data;

  const sb = serviceClient();

  const { data: current, error: readErr } = await sb
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> }>();
  if (readErr) {
    res.status(500).json({
      error: { code: "fleet_halt_read_failed", message: readErr.message },
    });
    return;
  }

  const before = current?.blob ?? {};
  const after = { ...before, fleet_halt: halted };

  const { error: upsertErr } = await sb
    .from("system_config")
    .upsert(
      {
        id: 1,
        blob: after,
        updated_at: new Date().toISOString(),
        updated_by: staff.user_id,
      },
      { onConflict: "id" },
    );
  if (upsertErr) {
    res.status(500).json({
      error: { code: "fleet_halt_write_failed", message: upsertErr.message },
    });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: `fleet_halt.${halted ? "engage" : "clear"}`,
    target_table: "system_config",
    target_id: "1",
    meta: {
      halted,
      previous: before.fleet_halt === true,
    },
  });

  res.json({ ok: true, halted });
}
