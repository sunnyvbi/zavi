
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { requireTenantRole } from "@/services/auth/tenant-role";
import { LOOK_AGAIN_MESSAGES, lookAgain, markLearningsSeen, readDismissedLearnings, readLearnings, setLearning } from "@/services/email-learnings/api";

const Action = z
  .object({
    action: z.enum(["add", "edit", "dismiss", "restore", "activate"]),
    id: z.string().uuid().optional(),
    text: z.string().max(600).optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict();
const Seen = z.object({ items: z.array(z.object({ id: z.string().uuid(), version: z.number().int().min(1) }).strict()).max(50) }).strict();

const STATUS: Record<string, number> = { bad_request: 400, bad_text: 400, not_authorized: 403, not_found: 404, card_changed: 409, list_full: 409, suggestions_full: 409 };

export type LearningHandlerDeps = {
  read: typeof readLearnings;
  removed: typeof readDismissedLearnings;
  set: typeof setLearning;
  seen: typeof markLearningsSeen;
  lookAgain: typeof lookAgain;
};

const internal = (res: Response, what: string) => {
  console.error(`[email-learnings] ${what} failed`);
  res.status(500).json({ error: { code: "internal_error", message: "That did not work. Try again." } });
};

export function emailLearningHandlers(
  deps: LearningHandlerDeps = { read: readLearnings, removed: readDismissedLearnings, set: setLearning, seen: markLearningsSeen, lookAgain },
) {
  return {
    async list(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        res.setHeader("Cache-Control", "no-store");
        res.json(await deps.read(auth.tenant_id, auth.user_id, { seed: auth.tenant_overridden !== true }));
      } catch {
        internal(res, "read");
      }
    },
    async removed(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        res.setHeader("Cache-Control", "no-store");
        res.json({ items: await deps.removed(auth.tenant_id) });
      } catch {
        internal(res, "removed");
      }
    },
    async set(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      if (auth.tenant_overridden === true) {
        res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
        return;
      }
      const body = Action.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: { code: "bad_request", message: "That did not make sense. Try again." } });
        return;
      }
      try {
        const out = await deps.set(auth.tenant_id, auth.user_id, body.data);
        if (!out.ok) {
          res.status(STATUS[out.code] ?? 409).json({ error: { code: out.code, message: out.message } });
          return;
        }
        res.json(out);
      } catch {
        internal(res, "set");
      }
    },
    async lookAgain(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      if (auth.tenant_overridden === true) {
        res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
        return;
      }
      if (!(await requireTenantRole(auth, ["owner", "admin"], res))) return;
      try {
        const status = await deps.lookAgain(auth.tenant_id, auth.user_id);
        if (status === "failed") {
          res.status(500).json({ error: { code: "look_again_failed", message: LOOK_AGAIN_MESSAGES.failed } });
          return;
        }
        if (status === "not_authorized" || status === "already_retried_today") {
          res.status(status === "not_authorized" ? 403 : 409).json({ error: { code: status, message: LOOK_AGAIN_MESSAGES[status] } });
          return;
        }
        res.json({ ok: true, status, queued: status === "queued", message: LOOK_AGAIN_MESSAGES[status] });
      } catch {
        internal(res, "look again");
      }
    },
    async seen(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      if (auth.tenant_overridden === true) {
        res.json({ ok: true, marked: 0 });
        return;
      }
      const body = Seen.safeParse(req.body ?? {});
      if (!body.success) {
        res.status(400).json({ error: { code: "bad_request", message: "That did not make sense." } });
        return;
      }
      try {
        res.json({ ok: true, marked: await deps.seen(auth.tenant_id, auth.user_id, body.data.items) });
      } catch {
        internal(res, "seen");
      }
    },
  };
}

const live = emailLearningHandlers();
export const getEmailLearningsHandler = live.list;
export const getRemovedEmailLearningsHandler = live.removed;
export const postEmailLearningHandler = live.set;
export const postEmailLearningsSeenHandler = live.seen;
export const postEmailLearningsLookAgainHandler = live.lookAgain;
