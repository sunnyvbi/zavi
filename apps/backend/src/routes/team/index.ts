
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { inngest } from "@/../workers/client";

const VALID_PROVIDERS = ["github", "slack", "jira"] as const;

const discoverBody = z.object({
  providers: z
    .array(z.enum(VALID_PROVIDERS))
    .min(1)
    .default(["github", "slack", "jira"]),
});

const updateBody = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  primary_email: z
    .string()
    .trim()
    .max(254)
    .refine((s) => s === "" || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), {
      message: "must be a valid email or empty",
    })
    .optional(),
  kind: z.enum(["human", "bot", "service_account"]).optional(),
});

const mergeBody = z.object({
  keep_id: z.string().uuid(),
  drop_id: z.string().uuid(),
});

type StableError = {
  status: number;
  body: { error: { code: string; message: string } };
};

function mapPgError(err: { code?: string; message?: string }): StableError {
  const msg = err.message ?? "";
  if (err.code === "42501") {
    return {
      status: 403,
      body: { error: { code: "not_authorized", message: "Not a member of the active tenant." } },
    };
  }
  if (err.code === "42704") {
    return {
      status: 404,
      body: { error: { code: "not_found", message: "Member not found." } },
    };
  }
  if (err.code === "22023") {
    const code = msg.includes("provider")
      ? "invalid_provider"
      : msg.includes("kind")
        ? "invalid_kind"
        : "invalid_argument";
    return { status: 400, body: { error: { code, message: msg || "Invalid argument." } } };
  }
  if (err.code === "23505") {
    return {
      status: 409,
      body: { error: { code: "email_conflict", message: "Another active member already uses this email." } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "internal_error", message: "Team operation failed. Try again." } },
  };
}

export async function teamDiscover(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = discoverBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "bad_request", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  const { data, error } = await sb.rpc("trigger_team_discover", {
    p_providers: parsed.data.providers,
  });
  if (error) {
    const m = mapPgError(error);
    res.status(m.status).json(m.body);
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const jobId: string | undefined = row?.job_id;
  const created: boolean = row?.created === true;
  if (!jobId) {
    res.status(500).json({ error: { code: "internal_error", message: "No job id returned." } });
    return;
  }

  if (created) {
    try {
      await inngest.send({
        name: "team.discover.requested",
        data: { job_id: jobId },
      });
    } catch (e) {
      console.warn("team-discover: inngest send failed", { job_id: jobId, error: (e as Error).message });
    }
  }

  res.json({ job_id: jobId, created });
}

export async function teamMembersList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const sb = serverClientFromBearer(auth.access_token);
  const { data, error } = await sb.rpc("list_team_members");
  if (error) {
    const m = mapPgError(error);
    res.status(m.status).json(m.body);
    return;
  }
  res.json({ members: data ?? [] });
}

export async function teamMemberDetail(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = req.params.id;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid member id" } });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  const { data, error } = await sb.rpc("get_team_member_detail", { p_member_id: id });
  if (error) {
    const m = mapPgError(error);
    res.status(m.status).json(m.body);
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    res.status(404).json({ error: { code: "not_found", message: "Member not found." } });
    return;
  }
  res.json({ member: row });
}

export async function teamMemberUpdate(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const id = req.params.id;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    res.status(400).json({ error: { code: "bad_request", message: "invalid member id" } });
    return;
  }
  const parsed = updateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "bad_request", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  const { data, error } = await sb.rpc("update_team_member", {
    p_member_id: id,
    p_display_name: parsed.data.display_name ?? null,
    p_primary_email: parsed.data.primary_email ?? null,
    p_kind: parsed.data.kind ?? null,
  });
  if (error) {
    const m = mapPgError(error);
    res.status(m.status).json(m.body);
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  res.json({ member: row });
}

export async function teamMembersMerge(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const parsed = mergeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: { code: "bad_request", message: parsed.error.issues.map((i) => i.message).join("; ") },
    });
    return;
  }

  const sb = serverClientFromBearer(auth.access_token);
  const { data, error } = await sb.rpc("merge_team_members", {
    p_keep_id: parsed.data.keep_id,
    p_drop_id: parsed.data.drop_id,
  });
  if (error) {
    const m = mapPgError(error);
    res.status(m.status).json(m.body);
    return;
  }
  res.json({ member: data });
}
