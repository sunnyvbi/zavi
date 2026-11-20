
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import {
  RuleError,
  activateRule,
  addRule,
  deleteAllRules,
  deleteRule,
  dismissRule,
  editRule,
  listRules,
  setSuggestionsPaused,
} from "@/services/rules/store";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RuleBody = z
  .object({
    text: z.string().min(1).max(280),
    scope_kind: z.enum(["all", "agent", "channel"]),
    scope_slug: z.string().regex(SLUG).nullable().optional(),
  })
  .refine((b) => (b.scope_kind === "all") === !b.scope_slug, { message: "scope and slug do not match" });

type Authed = NonNullable<Awaited<ReturnType<typeof requireAuth>>>;

async function authed(req: Request, res: Response, write: boolean): Promise<Authed | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (write && (auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({
      error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." },
    });
    return null;
  }
  return auth;
}

function ruleId(req: Request, res: Response): string | null {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) {
    res.status(404).json({ error: { code: "not_found", message: "That rule no longer exists." } });
    return null;
  }
  return id;
}

function fail(res: Response, e: unknown, what: string): void {
  if (e instanceof RuleError) {
    const status = e.code === "forbidden" ? 403 : e.code === "failed" ? 500 : e.code === "cap" ? 409 : 400;
    res.status(status).json({ error: { code: e.code, message: e.message } });
    return;
  }
  console.warn(`[rules] ${what}: ${(e as Error).message}`);
  res.status(500).json({ error: { code: "failed", message: "Something went wrong. Try again." } });
}

function notFoundOr(res: Response, r: { status: string }, ok: string): void {
  if (r.status === "not_found") {
    res.status(404).json({ error: { code: "not_found", message: "That rule no longer exists." } });
    return;
  }
  res.json({ ...r, ok: r.status === ok || r.status === "active" });
}

export async function rulesList(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, false);
  if (!auth) return;
  try {
    res.json(await listRules(auth.tenant_id, auth.user_id));
  } catch (e) {
    fail(res, e, "list");
  }
}

export async function rulesAdd(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, true);
  if (!auth) return;
  const body = RuleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid", message: "A rule needs up to 280 characters and a scope." } });
    return;
  }
  try {
    res.json(
      await addRule(auth.tenant_id, auth.user_id, {
        text: body.data.text,
        scope_kind: body.data.scope_kind,
        scope_slug: body.data.scope_slug ?? null,
        origin: "rules_page",
      }),
    );
  } catch (e) {
    fail(res, e, "add");
  }
}

export async function rulesActivate(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, true);
  if (!auth || !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = ruleId(req, res);
  if (!id) return;
  try {
    notFoundOr(res, await activateRule(auth.tenant_id, auth.user_id, id), "active");
  } catch (e) {
    fail(res, e, "activate");
  }
}

export async function rulesEdit(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, true);
  if (!auth || !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = ruleId(req, res);
  if (!id) return;
  const body = RuleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid", message: "A rule needs up to 280 characters and a scope." } });
    return;
  }
  try {
    notFoundOr(
      res,
      await editRule(auth.tenant_id, auth.user_id, id, {
        text: body.data.text,
        scope_kind: body.data.scope_kind,
        scope_slug: body.data.scope_slug ?? null,
      }),
      "active",
    );
  } catch (e) {
    fail(res, e, "edit");
  }
}

export async function rulesDismiss(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, true);
  if (!auth || !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = ruleId(req, res);
  if (!id) return;
  try {
    notFoundOr(res, await dismissRule(auth.tenant_id, auth.user_id, id), "dismissed");
  } catch (e) {
    fail(res, e, "dismiss");
  }
}

export async function rulesDelete(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, true);
  if (!auth || !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const id = ruleId(req, res);
  if (!id) return;
  try {
    notFoundOr(res, await deleteRule(auth.tenant_id, auth.user_id, id), "deleted");
  } catch (e) {
    fail(res, e, "delete");
  }
}

export async function rulesDeleteAll(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, true);
  if (!auth || !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  try {
    res.json(await deleteAllRules(auth.tenant_id, auth.user_id));
  } catch (e) {
    fail(res, e, "delete_all");
  }
}

export async function rulesSettings(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, true);
  if (!auth || !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const body = z.object({ suggestions_paused: z.boolean() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid", message: "suggestions_paused must be true or false." } });
    return;
  }
  try {
    res.json(await setSuggestionsPaused(auth.tenant_id, auth.user_id, body.data.suggestions_paused));
  } catch (e) {
    fail(res, e, "settings");
  }
}

const Place = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  kind: z.enum(["Country", "State", "City", "Zip", "Region", "Other"]),
  platform: z.enum(["meta", "google"]),
});
const AdGuardBody = z.object({
  allowed_places: z.array(Place).max(50),
  blocked_places: z.array(Place).max(50),
  banned_phrases: z.array(z.string().trim().min(1).max(80)).max(50),
});

export async function rulesAdGuardGet(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, false);
  if (!auth) return;
  try {
    const { readAdGuard } = await import("@/services/rules/ad-guard");
    res.json({ ad_guard: await readAdGuard(auth.tenant_id) });
  } catch (e) {
    fail(res, e, "ad_guard_get");
  }
}

export async function rulesAdGuardPut(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, true);
  if (!auth || !(await requireTenantRole(auth, ["owner", "admin"], res))) return;
  const body = AdGuardBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid", message: "Up to 50 places in each list and 50 phrases of up to 80 characters." } });
    return;
  }
  try {
    const { saveAdGuard } = await import("@/services/rules/ad-guard");
    res.json({ ad_guard: await saveAdGuard(auth.tenant_id, auth.user_id, body.data) });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.startsWith("rules: ")) {
      res.status(400).json({ error: { code: "invalid", message: msg.slice(7) } });
      return;
    }
    fail(res, e, "ad_guard_put");
  }
}

export async function agentFeedbackRule(req: Request, res: Response): Promise<void> {
  const auth = await authed(req, res, true);
  if (!auth) return;
  const body = z
    .object({ slug: z.string().regex(SLUG), text: z.string().min(1).max(280) })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: { code: "invalid", message: "Usage: /feedback <a rule of up to 280 characters>" } });
    return;
  }
  try {
    res.json(
      await addRule(auth.tenant_id, auth.user_id, {
        text: body.data.text,
        scope_kind: "agent",
        scope_slug: body.data.slug,
        origin: "feedback_command",
      }),
    );
  } catch (e) {
    fail(res, e, "feedback");
  }
}
