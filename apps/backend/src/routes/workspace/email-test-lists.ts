
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { loadTenantRole, requireTenantRole } from "@/services/auth/tenant-role";
import { readGmailSender, readTestLists, setTestList, TEST_LIST_ROUTES, zaviListsFor } from "@/services/email-test-lists/lists";

const Body = z
  .object({ route: z.enum(TEST_LIST_ROUTES), list_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), marked: z.boolean() })
  .strict();

const STATUS: Record<string, number> = {
  bad_list: 400,
  not_authorized: 403,
  list_not_found: 404,
  could_not_check: 409,
  not_connected: 409,
  channel_missing: 409,
};

export function emailTestListHandlers(
  deps: {
    read: typeof readTestLists;
    set: typeof setTestList;
    gmail?: (tenantId: string) => ReturnType<typeof readGmailSender>;
    role?: typeof loadTenantRole;
  } = { read: readTestLists, set: setTestList, gmail: readGmailSender, role: loadTenantRole },
) {
  return {
    async list(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        res.setHeader("Cache-Control", "no-store");
        const role = await (deps.role ?? loadTenantRole)(auth).catch(() => null);
        const own = role === "owner" || role === "admin" ? {} : { zaviLists: zaviListsFor(false) };
        const [view, gmail] = await Promise.all([deps.read(auth.tenant_id, own), deps.gmail ? deps.gmail(auth.tenant_id) : null]);
        res.json(gmail ? { ...view, gmail } : view);
      } catch {
        console.error("[email-test-lists] read failed");
        res.status(500).json({ error: { code: "internal_error", message: "Test lists could not be loaded. Try again." } });
      }
    },
    async set(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      if (auth.tenant_overridden === true) {
        res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
        return;
      }
      if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
      const body = Body.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: { code: "bad_list", message: "That list is not one Zavi knows." } });
        return;
      }
      try {
        const out = await deps.set(auth.tenant_id, auth.user_id, body.data.route, body.data.list_id, body.data.marked);
        if (!out.ok) {
          res.status(STATUS[out.code] ?? 409).json({ error: { code: out.code, message: out.message } });
          return;
        }
        res.json(out);
      } catch {
        console.error("[email-test-lists] set failed");
        res.status(500).json({ error: { code: "internal_error", message: "That did not save. Try again." } });
      }
    },
  };
}

const live = emailTestListHandlers();
export const getEmailTestListsHandler = live.list;
export const postEmailTestListHandler = live.set;
