
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { serverClientFromBearer } from "@/services/supabase";
import { filterTenantVisibleTabs } from "@/services/agents/visibility";
import { scrubForeignThreadBindings } from "@/services/workspace/scrubThreadBindings";
import { scrubForeignBuildSessions } from "@/services/workspace/scrubBuildSessionBindings";

export async function workspaceTabsSessionGet(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const supabase = serverClientFromBearer(auth.access_token);
  const { data, error } = await supabase.rpc("get_tabs_session");
  if (error) {
    res.status(500).json({
      error: { code: "rpc_failed", message: error.message },
    });
    return;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const raw = (row ?? { tabs: [], active_tab_id: null }) as {
    tabs: Array<{
      id?: string;
      payload?: { kind?: string; slug?: string; threadId?: string | null };
    }>;
    active_tab_id: string | null;
  };
  const visibleTabs = await filterTenantVisibleTabs(
    raw.tabs ?? [],
    auth.tenant_id,
  );
  const threadScrubbed = await scrubForeignThreadBindings(
    visibleTabs,
    auth.tenant_id,
    auth.user_id,
  );
  const tabs = await scrubForeignBuildSessions(threadScrubbed, auth.tenant_id);
  const surviving = new Set(
    tabs.map((t) => t.id).filter((x): x is string => typeof x === "string"),
  );
  const active_tab_id =
    raw.active_tab_id && surviving.has(raw.active_tab_id) ? raw.active_tab_id : null;
  res.json({ tabs, active_tab_id });
}

const PostBody = z.object({
  tabs: z.array(z.any()),
  active_tab_id: z.string().nullable(),
});

export async function workspaceTabsSessionPost(
  req: Request,
  res: Response,
): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(req.body ?? {});
  } catch (e) {
    res
      .status(400)
      .json({ error: { code: "validation", message: (e as Error).message } });
    return;
  }

  const supabase = serverClientFromBearer(auth.access_token);
  const { error } = await supabase.rpc("set_tabs_session", {
    p_tabs: body.tabs,
    p_active_tab_id: body.active_tab_id,
  });
  if (error) {
    res.status(500).json({
      error: { code: "rpc_failed", message: error.message },
    });
    return;
  }
  res.json({ ok: true });
}
