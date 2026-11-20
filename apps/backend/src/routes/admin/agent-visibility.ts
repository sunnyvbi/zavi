
import type { Request, Response } from "express";
import { z } from "zod";
import { assertStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";
import { writeStaffAudit } from "@/services/staff/audit";
import {
  getAgentDefaultState,
  listAgents,
  listAlwaysOnSlugs,
} from "@/services/agents/registry";
import { getGlobalDisabledSlugsStrict } from "@/services/agents/visibility";

export async function staffAgentVisibilityGet(
  req: Request,
  res: Response,
): Promise<void> {
  assertStaff(req);

  let disabled: ReadonlySet<string>;
  try {
    disabled = await getGlobalDisabledSlugsStrict();
  } catch (e) {
    res.status(500).json({
      error: { code: "config_query_failed", message: (e as Error).message },
    });
    return;
  }

  const { data: meta, error: metaErr } = await serviceClient()
    .from("system_config")
    .select("updated_at, updated_by")
    .eq("id", 1)
    .maybeSingle<{ updated_at: string | null; updated_by: string | null }>();
  if (metaErr) {
    res.status(500).json({
      error: { code: "config_query_failed", message: metaErr.message },
    });
    return;
  }

  const slugs = listAgents()
    .map((a) => {
      const default_state =
        a.metadata_praxis.visibility?.default_state ?? "enabled";
      return {
        slug: a.slug,
        name: a.name,
        description: a.description,
        hidden: disabled.has(a.slug),
        default_state,
        is_locked: default_state === "always_on",
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  res.json({
    slugs,
    updated_at: meta?.updated_at ?? null,
    updated_by: meta?.updated_by ?? null,
  });
}

const PostBody = z.object({
  disabled_agent_slugs: z.array(z.string()),
});

export async function staffAgentVisibilityPost(
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

  const submitted = parsed.data.disabled_agent_slugs;
  const deduped = Array.from(new Set(submitted));

  const known = new Set(listAgents().map((a) => a.slug));
  const unknown = deduped.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    res.status(400).json({
      error: {
        code: "unknown_slug",
        message: `Unknown agent slug(s): ${unknown.join(", ")}`,
      },
    });
    return;
  }

  const alwaysOn = new Set(listAlwaysOnSlugs());
  const locked = deduped.filter((s) => alwaysOn.has(s));
  if (locked.length > 0) {
    res.status(400).json({
      error: {
        code: "always_on_locked",
        message: `Cannot hide always_on agent(s): ${locked.join(", ")}. Edit the agent.md visibility.default_state to change lock status.`,
      },
    });
    return;
  }

  const sb = serviceClient();
  const { data: current, error: getErr } = await sb
    .from("system_config")
    .select("blob")
    .eq("id", 1)
    .maybeSingle<{ blob: Record<string, unknown> }>();
  if (getErr) {
    res.status(500).json({
      error: { code: "config_read_failed", message: getErr.message },
    });
    return;
  }

  const before = current?.blob ?? {};
  const after = { ...before, disabled_agent_slugs: deduped };

  const { error: upsertErr } = await sb.from("system_config").upsert(
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
      error: { code: "config_write_failed", message: upsertErr.message },
    });
    return;
  }

  await writeStaffAudit({
    actor_user_id: staff.user_id,
    actor_email: staff.email,
    action: "agent_visibility.update",
    target_table: "system_config",
    target_id: "1",
    meta: { before, after, disabled_agent_slugs: deduped },
  });

  res.json({ ok: true, disabled_agent_slugs: deduped });
}
