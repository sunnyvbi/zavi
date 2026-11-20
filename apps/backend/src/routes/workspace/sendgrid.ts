
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { resolveSendgridAccount } from "@/services/connectors/email-campaign/sendgrid-account";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";

const ID = z.union([z.string(), z.number()]).transform((v) => String(v));
const Sender = z.object({ id: ID, from_email: z.string().max(320), from_name: z.string().max(200).nullable().optional(), verified: z.boolean() });
const Group = z.object({ id: ID, name: z.string().max(300), is_default: z.boolean().optional() });
const List = z.object({ id: z.string().max(128), name: z.string().max(300), contact_count: z.number().int().nonnegative().optional() });

export type SendgridReadDeps = {
  resolve: typeof resolveSendgridAccount;
  fetch: typeof fetch;
};
const LIVE: SendgridReadDeps = { resolve: resolveSendgridAccount, fetch: (...a) => fetch(...a) };

type Op = "SENDGRID_VERIFIED_SENDERS" | "SENDGRID_SUPPRESSION_GROUPS" | "SENDGRID_LISTS";

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

async function readOne(req: Request, res: Response, deps: SendgridReadDeps, op: Op, args: Record<string, unknown>): Promise<unknown | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (auth.tenant_overridden === true) {
    refuse(res, 403, "tenant_override_forbidden", "Not available for an overridden workspace.");
    return null;
  }
  let account;
  try {
    account = await deps.resolve(auth.tenant_id);
  } catch {
    refuse(res, 500, "internal_error", "Something went wrong. Try again.");
    return null;
  }
  if (!account) {
    refuse(res, 409, "sendgrid_not_connected", "SendGrid is not connected for campaigns. Connect it on the Connectors page with a key that has every campaign permission.");
    return null;
  }
  const r = await sendgridHttpCall(account.api_key, deps.fetch)(op, args);
  if (r.ok) return r.data;
  if (r.status === 401 || r.status === 403) {
    refuse(res, 409, "sendgrid_key_rejected", "SendGrid did not accept the saved key, or it lacks a permission. Reconnect SendGrid on the Connectors page.");
  } else if (r.status === 429) {
    refuse(res, 429, "sendgrid_rate_limited", "SendGrid is busy right now. Try again in a minute.");
  } else {
    refuse(res, 502, "sendgrid_unreachable", "Zavi could not read SendGrid right now. Try again in a minute.");
  }
  return null;
}

function rows<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const p = schema.safeParse(x);
    return p.success ? [p.data] : [];
  });
}

export function sendgridReadHandlers(deps: SendgridReadDeps = LIVE) {
  return {
    async senders(req: Request, res: Response): Promise<void> {
      const data = await readOne(req, res, deps, "SENDGRID_VERIFIED_SENDERS", { query: { limit: 100 } });
      if (data === null) return;
      const senders = rows(Sender, (data as { results?: unknown })?.results).map((s) => ({
        id: s.id,
        from_email: s.from_email,
        from_name: s.from_name ?? null,
        verified: s.verified,
      }));
      res.json({ senders });
    },
    async suppressionGroups(req: Request, res: Response): Promise<void> {
      const data = await readOne(req, res, deps, "SENDGRID_SUPPRESSION_GROUPS", {});
      if (data === null) return;
      res.json({ groups: rows(Group, data).map((g) => ({ id: g.id, name: g.name, is_default: g.is_default === true })) });
    },
    async lists(req: Request, res: Response): Promise<void> {
      const data = await readOne(req, res, deps, "SENDGRID_LISTS", { query: { page_size: 1000 } });
      if (data === null) return;
      res.json({ lists: rows(List, (data as { result?: unknown })?.result).map((l) => ({ id: l.id, name: l.name, people: l.contact_count ?? null })) });
    },
  };
}

const live = sendgridReadHandlers();
export const getSendgridSendersHandler = live.senders;
export const getSendgridSuppressionGroupsHandler = live.suppressionGroups;
export const getSendgridListsHandler = live.lists;
