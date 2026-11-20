
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { serverClientFromBearer } from "@/services/supabase";

type GlobalRow = {
  slug: string;
  default_autonomy: string;
  description: string | null;
  dispatch_handler: string | null;
  never_auto: boolean | null;
  click_allowlistable: boolean | null;
};
type OverrideRow = { decision_class: string; autonomy: string | null };

export async function autonomyList(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const supabase = serverClientFromBearer(auth.access_token);

  const [globalsRes, overridesRes] = await Promise.all([
    supabase
      .from("decision_classes")
      .select("slug, default_autonomy, description, dispatch_handler, never_auto, click_allowlistable")
      .order("slug"),
    supabase.from("tenant_decision_class_overrides").select("decision_class, autonomy"),
  ]);

  if (globalsRes.error) {
    res.status(500).json({ error: { code: "list_globals_failed", message: globalsRes.error.message } });
    return;
  }
  if (overridesRes.error) {
    res.status(500).json({ error: { code: "list_overrides_failed", message: overridesRes.error.message } });
    return;
  }

  const overrideMap = new Map<string, string>();
  for (const o of (overridesRes.data ?? []) as OverrideRow[]) {
    if (o.autonomy !== null) overrideMap.set(o.decision_class, o.autonomy);
  }

  const classes = ((globalsRes.data ?? []) as GlobalRow[]).map((g) => {
    const never_auto = g.never_auto === true;
    const effective = never_auto
      ? "approval"
      : overrideMap.get(g.slug) ?? g.default_autonomy;
    return {
      slug: g.slug,
      description: g.description,
      handler: g.dispatch_handler,
      default_autonomy: g.default_autonomy,
      tenant_override: overrideMap.get(g.slug) ?? null,
      effective,
      never_auto,
      click_allowlistable: g.click_allowlistable === true,
    };
  });

  res.json({ classes });
}

export async function autonomySet(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = (req.body ?? {}) as {
    decision_class?: string;
    autonomy?: string | null;
  };
  if (!body.decision_class) {
    res
      .status(400)
      .json({
        error: { code: "bad_request", message: "decision_class required" },
      });
    return;
  }
  const autonomy = body.autonomy;
  const supabase = serverClientFromBearer(auth.access_token);

  if (autonomy === null) {
    const { error } = await supabase.rpc("clear_tenant_autonomy", {
      p_tenant_id: auth.tenant_id,
      p_decision_class: body.decision_class,
    });
    if (error) {
      res
        .status(500)
        .json({ error: { code: "clear_autonomy_failed", message: error.message } });
      return;
    }
    res.json({ ok: true });
    return;
  }

  if (
    autonomy !== "auto" &&
    autonomy !== "approval" &&
    autonomy !== "forbidden"
  ) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: "autonomy must be one of: auto, approval, forbidden",
      },
    });
    return;
  }
  if (autonomy === "auto") {
    if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  }

  const { error } = await supabase.rpc("set_tenant_autonomy", {
    p_tenant_id: auth.tenant_id,
    p_decision_class: body.decision_class,
    p_autonomy: autonomy,
  });
  if (error) {
    res
      .status(500)
      .json({ error: { code: "set_autonomy_failed", message: error.message } });
    return;
  }
  res.json({ ok: true });
}
