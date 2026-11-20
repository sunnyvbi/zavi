
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { staffCrossTenantClient } from "@/services/tenant-client";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  attachDuplicateWarnings,
  describeGeneration,
  generateGrowthSuggestionPreview,
  growthSuggestionCategorySchema,
  growthSuggestionPrioritySchema,
} from "@/services/growth-suggestions/generate";
import {
  getSuggestionSession,
  listSuggestionSessions,
  recordSuggestionTurn,
  type SuggestionChatMessage,
} from "@/services/growth-suggestions/chat";

const CreateBody = z.object({
  tenant_id: z.string().uuid(),
  session_id: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(5000),
  category: growthSuggestionCategorySchema,
  priority: growthSuggestionPrioritySchema,
});

const GenerateBody = z.object({
  tenant_id: z.string().uuid(),
  notes: z.string().max(5000).optional(),
  session_id: z.string().uuid().nullable().optional(),
});

const DEFAULT_STAFF_PROMPT = "Generate growth suggestions from this client's ads.";

const PatchBody = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  body: z.string().trim().min(1).max(5000).optional(),
  category: growthSuggestionCategorySchema.optional(),
  priority: growthSuggestionPrioritySchema.optional(),
  duplicate_of: z.string().uuid().nullable().optional(),
}).refine((body) => Object.keys(body).length > 0, "at least one field is required");

const TenantBody = z.object({ tenant_id: z.string().uuid() });
const PushBatchBody = z.object({
  tenant_id: z.string().uuid(),
  suggestion_ids: z.array(z.string().uuid()).min(1).max(20),
});

const SUGGESTION_COLUMNS = [
  "id",
  "tenant_id",
  "title",
  "body",
  "category",
  "priority",
  "status",
  "source",
  "source_payload",
  "owner_staff_id",
  "owner_staff_email",
  "created_by_staff_id",
  "created_by_staff_email",
  "decision_id",
  "duplicate_of",
  "pushed_at",
  "resolved_at",
  "created_at",
  "updated_at",
].join(", ");

const STAFF_REASON = "admin growth-suggestions: staff curation cockpit for one tenant";

function staffSb() {
  return staffCrossTenantClient(STAFF_REASON);
}

type SuggestionRow = {
  id: string;
  tenant_id: string;
  title: string;
  status: string;
  source: string;
  duplicate_of: string | null;
  [key: string]: unknown;
};

type MessageWithSuggestions = SuggestionChatMessage & { suggestions: SuggestionRow[] };

function messageSuggestionIds(message: SuggestionChatMessage): string[] {
  const ids = (message.meta as { suggestion_ids?: unknown }).suggestion_ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

async function loadSuggestions(tenant_id: string, ids: string[]): Promise<SuggestionRow[]> {
  if (ids.length === 0) return [];
  const sb = staffSb();
  const { data, error } = await sb
    .from("growth_suggestions")
    .select(SUGGESTION_COLUMNS)
    .eq("tenant_id", tenant_id)
    .in("id", ids);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as SuggestionRow[];
  const duplicateIds = [...new Set(rows.map((row) => row.duplicate_of).filter((id): id is string => !!id))];
  const titles = new Map<string, { title: string; status: string }>();
  if (duplicateIds.length > 0) {
    const { data: duplicates, error: duplicateError } = await sb
      .from("growth_suggestions")
      .select("id, title, status")
      .eq("tenant_id", tenant_id)
      .in("id", duplicateIds);
    if (duplicateError) throw new Error(duplicateError.message);
    for (const row of (duplicates ?? []) as Array<{ id: string; title: string; status: string }>) {
      titles.set(row.id, { title: row.title, status: row.status });
    }
  }
  return rows.map((row) => ({
    ...row,
    duplicate: row.duplicate_of && titles.has(row.duplicate_of)
      ? { id: row.duplicate_of, ...titles.get(row.duplicate_of)! }
      : null,
  }));
}

async function attachSuggestions(
  tenant_id: string,
  messages: SuggestionChatMessage[],
): Promise<MessageWithSuggestions[]> {
  const ids = [...new Set(messages.flatMap(messageSuggestionIds))];
  const rows = await loadSuggestions(tenant_id, ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return messages.map((message) => ({
    ...message,
    suggestions: messageSuggestionIds(message)
      .map((id) => byId.get(id))
      .filter((row): row is SuggestionRow => !!row),
  }));
}

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: { code: "bad_request", message: error.issues.map((issue) => issue.message).join("; ") },
  });
}

export async function staffSuggestionsGenerate(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = GenerateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }
  const { tenant_id, session_id } = parsed.data;
  const staffBody = parsed.data.notes?.trim() || DEFAULT_STAFF_PROMPT;

  try {
    const generated = await generateGrowthSuggestionPreview(parsed.data);
    if (generated.status !== "ready") {
      const turn = await recordSuggestionTurn({
        tenant_id,
        session_id,
        staff,
        staff_body: staffBody,
        zavi_body: generated.message,
        meta: { status: generated.status },
      });
      res.json({
        ...generated,
        reply: generated.message,
        session_id: turn.session_id,
        messages: turn.messages.map((message) => ({ ...message, suggestions: [] })),
      });
      return;
    }
    const sb = staffSb();
    const { data: existing, error } = await sb
      .from("growth_suggestions")
      .select("id, title, body, status")
      .eq("tenant_id", tenant_id)
      .in("status", ["draft", "awaiting_client"])
      .order("updated_at", { ascending: false })
      .limit(1000);
    if (error) {
      res.status(500).json({ error: { code: "duplicate_query_failed", message: error.message } });
      return;
    }
    const previews = attachDuplicateWarnings(generated.suggestions, existing ?? []);
    const { data: inserted, error: insertError } = await sb
      .from("growth_suggestions")
      .insert(
        previews.map((preview) => ({
          tenant_id,
          title: preview.title,
          body: preview.body,
          category: preview.category,
          priority: preview.priority,
          source: preview.source,
          source_payload: preview.source_payload,
          duplicate_of: preview.duplicate?.id ?? null,
          owner_staff_id: staff.user_id,
          owner_staff_email: staff.email,
          created_by_staff_id: staff.user_id,
          created_by_staff_email: staff.email,
        })),
      )
      .select(SUGGESTION_COLUMNS);
    if (insertError) {
      res.status(500).json({ error: { code: "suggestion_create_failed", message: insertError.message } });
      return;
    }
    const rows = (inserted ?? []) as unknown as SuggestionRow[];
    for (const row of rows) {
      await writeStaffAudit({
        actor_user_id: staff.user_id,
        actor_email: staff.email,
        action: "growth_suggestion.create",
        target_table: "growth_suggestions",
        target_id: row.id,
        tenant_id,
        meta: { source: row.source },
      });
    }
    const duplicates = previews.filter((preview) => preview.duplicate).length;
    const reply = describeGeneration(rows.length, duplicates);
    const turn = await recordSuggestionTurn({
      tenant_id,
      session_id,
      staff,
      staff_body: staffBody,
      zavi_body: reply,
      meta: {
        status: "ready",
        suggestions: rows.length,
        duplicates,
        suggestion_ids: rows.map((row) => row.id),
      },
    });
    res.json({
      status: "ready",
      reply,
      session_id: turn.session_id,
      messages: await attachSuggestions(tenant_id, turn.messages),
    });
  } catch (error) {
    console.warn(`[growth-suggestions] generation failed: ${(error as Error).message}`);
    res.status(502).json({
      error: {
        code: "generation_failed",
        message: "Could not generate grounded suggestions from Meta Ads right now. Try again or add one manually.",
      },
    });
  }
}

export async function staffSuggestionsCreate(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = CreateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }
  const { tenant_id, session_id, ...item } = parsed.data;
  const { data, error } = await staffSb()
    .from("growth_suggestions")
    .insert({
      tenant_id,
      ...item,
      source: "manual",
      source_payload: {},
      owner_staff_id: staff.user_id,
      owner_staff_email: staff.email,
      created_by_staff_id: staff.user_id,
      created_by_staff_email: staff.email,
    })
    .select(SUGGESTION_COLUMNS)
    .maybeSingle();
  if (error || !data) {
    res.status(500).json({
      error: { code: "suggestion_create_failed", message: error?.message ?? "insert returned no row" },
    });
    return;
  }
  const row = data as unknown as SuggestionRow;
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "growth_suggestion.create",
    target_table: "growth_suggestions",
    target_id: row.id,
    tenant_id,
    meta: { source: row.source },
  });
  const turn = await recordSuggestionTurn({
    tenant_id,
    session_id,
    staff,
    staff_body: `Add a suggestion manually: ${row.title}`,
    zavi_body: "Saved as a draft. Edit it or push it to the client whenever you're ready.",
    meta: { status: "manual", suggestions: 1, suggestion_ids: [row.id] },
  });
  res.status(201).json({
    ok: true,
    session_id: turn.session_id,
    messages: await attachSuggestions(tenant_id, turn.messages),
  });
}

export async function staffSuggestionsPatch(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const id = z.string().uuid().safeParse(req.params.id);
  const parsed = PatchBody.safeParse(req.body ?? {});
  if (!id.success || !parsed.success) {
    if (!parsed.success) badRequest(res, parsed.error);
    else res.status(400).json({ error: { code: "bad_request", message: "suggestion id must be a UUID" } });
    return;
  }

  const sb = staffSb();
  const { data: before, error: readError } = await sb
    .from("growth_suggestions")
    .select(SUGGESTION_COLUMNS)
    .eq("id", id.data)
    .maybeSingle();
  if (readError) {
    res.status(500).json({ error: { code: "suggestion_query_failed", message: readError.message } });
    return;
  }
  if (!before) {
    res.status(404).json({ error: { code: "not_found", message: "suggestion not found" } });
    return;
  }
  const beforeRow = before as unknown as { status: string; tenant_id: string };
  if (beforeRow.status !== "draft") {
    res.status(409).json({ error: { code: "not_draft", message: "only draft suggestions can be edited" } });
    return;
  }
  if (parsed.data.duplicate_of) {
    if (parsed.data.duplicate_of === id.data) {
      res.status(400).json({ error: { code: "invalid_duplicate", message: "a suggestion cannot duplicate itself" } });
      return;
    }
    const { data: duplicate, error: duplicateError } = await sb
      .from("growth_suggestions")
      .select("id")
      .eq("id", parsed.data.duplicate_of)
      .eq("tenant_id", beforeRow.tenant_id)
      .maybeSingle();
    if (duplicateError) {
      res.status(500).json({ error: { code: "suggestion_query_failed", message: duplicateError.message } });
      return;
    }
    if (!duplicate) {
      res.status(400).json({
        error: { code: "invalid_duplicate", message: "duplicate_of must reference this tenant's suggestion" },
      });
      return;
    }
  }

  const { data: after, error } = await sb
    .from("growth_suggestions")
    .update(parsed.data)
    .eq("id", id.data)
    .eq("status", "draft")
    .select(SUGGESTION_COLUMNS)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: { code: "suggestion_update_failed", message: error.message } });
    return;
  }
  if (!after) {
    res.status(409).json({ error: { code: "not_draft", message: "suggestion changed before it could be edited" } });
    return;
  }
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "growth_suggestion.update",
    target_table: "growth_suggestions",
    target_id: id.data,
    tenant_id: beforeRow.tenant_id,
    meta: { before, after },
  });
  res.json({ ok: true, suggestion: after });
}

export async function staffSuggestionsArchive(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const id = z.string().uuid().safeParse(req.params.id);
  const tenant = TenantBody.safeParse(req.body ?? {});
  if (!id.success || !tenant.success) {
    res.status(400).json({ error: { code: "bad_request", message: "valid suggestion id and tenant_id required" } });
    return;
  }
  const { data, error } = await staffSb()
    .from("growth_suggestions")
    .update({ status: "archived", resolved_at: new Date().toISOString() })
    .eq("id", id.data)
    .eq("tenant_id", tenant.data.tenant_id)
    .eq("status", "draft")
    .select(SUGGESTION_COLUMNS)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: { code: "suggestion_archive_failed", message: error.message } });
    return;
  }
  if (!data) {
    res.status(409).json({ error: { code: "not_draft", message: "only an existing draft can be archived" } });
    return;
  }
  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "growth_suggestion.archive",
    target_table: "growth_suggestions",
    target_id: id.data,
    tenant_id: tenant.data.tenant_id,
  });
  res.json({ ok: true, suggestion: data });
}

async function pushSuggestions(
  staff: ReturnType<typeof assertStaff>,
  tenant_id: string,
  suggestion_ids: string[],
  res: Response,
): Promise<void> {
  const { data, error } = await staffSb().rpc("push_growth_suggestions", {
    p_suggestion_ids: suggestion_ids,
    p_tenant_id: tenant_id,
    p_staff_id: staff.user_id,
  });
  if (error) {
    const conflict = /only draft|not found|duplicates|approval queue/i.test(error.message);
    res.status(conflict ? 409 : 500).json({
      error: { code: conflict ? "push_conflict" : "suggestion_push_failed", message: error.message },
    });
    return;
  }
  const pushed = (Array.isArray(data) ? data : []) as Array<{ suggestion_id: string; decision_id: string }>;
  for (const row of pushed) {
    await writeStaffAudit({
      actor_user_id: staff.user_id,
      actor_email: staff.email,
      action: "growth_suggestion.push",
      target_table: "growth_suggestions",
      target_id: row.suggestion_id,
      tenant_id,
      meta: { decision_id: row.decision_id },
    });
  }
  res.json({ ok: true, pushed, suggestions: await loadSuggestions(tenant_id, pushed.map((row) => row.suggestion_id)) });
}

export async function staffSuggestionPush(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const id = z.string().uuid().safeParse(req.params.id);
  const tenant = TenantBody.safeParse(req.body ?? {});
  if (!id.success || !tenant.success) {
    res.status(400).json({ error: { code: "bad_request", message: "valid suggestion id and tenant_id required" } });
    return;
  }
  await pushSuggestions(staff, tenant.data.tenant_id, [id.data], res);
}

export async function staffSuggestionsPushBatch(req: Request, res: Response): Promise<void> {
  const staff = assertStaff(req);
  const parsed = PushBatchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    badRequest(res, parsed.error);
    return;
  }
  if (new Set(parsed.data.suggestion_ids).size !== parsed.data.suggestion_ids.length) {
    res.status(400).json({ error: { code: "bad_request", message: "suggestion_ids must be unique" } });
    return;
  }
  await pushSuggestions(staff, parsed.data.tenant_id, parsed.data.suggestion_ids, res);
}

export async function staffSuggestionSessionsList(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const tenant = z.string().uuid().safeParse(req.query.tenant_id);
  if (!tenant.success) {
    res.status(400).json({ error: { code: "bad_request", message: "tenant_id (uuid) is required" } });
    return;
  }
  try {
    res.json({ sessions: await listSuggestionSessions(tenant.data) });
  } catch (error) {
    res.status(500).json({ error: { code: "sessions_query_failed", message: (error as Error).message } });
  }
}

export async function staffSuggestionSessionGet(req: Request, res: Response): Promise<void> {
  assertStaff(req);
  const id = z.string().uuid().safeParse(req.params.id);
  const tenant = z.string().uuid().safeParse(req.query.tenant_id);
  if (!id.success || !tenant.success) {
    res.status(400).json({ error: { code: "bad_request", message: "valid session id and tenant_id required" } });
    return;
  }
  try {
    const found = await getSuggestionSession(id.data, tenant.data);
    if (!found) {
      res.status(404).json({ error: { code: "not_found", message: "session not found" } });
      return;
    }
    res.json({ session: found.session, messages: await attachSuggestions(tenant.data, found.messages) });
  } catch (error) {
    res.status(500).json({ error: { code: "session_query_failed", message: (error as Error).message } });
  }
}
