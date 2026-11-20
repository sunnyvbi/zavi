
import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "@/services/auth/middleware";
import { checkAgentTier } from "@/services/agents/entitlement";
import { emailSendHttpRefusal } from "@/services/agents/email-send-tier";
import {
  approveEmailCard,
  cardView,
  EMAIL_CARD_MESSAGES,
  EMAIL_CARD_RAILS,
  emailCardViewState,
  liveCardCount,
  cardCountKey,
  cardVendorReads,
  cardSenderWarning,
  EmailToolKeyRejected,
  editEmailCardVersion,
  sendEmailCardTest,
  cardSuppression,
  sendgridGroupName,
  cardOnTestList,
  plannedForCard,
  liveCardSend,
  stopEmailCardSend,
  type CardDeps,
} from "@/services/email-cards/cards";

const Params = z.object({ rail: z.enum(EMAIL_CARD_RAILS), id: z.string().uuid() });
const TestBody = z.object({ variant: z.number().int().min(1).max(3) }).strict();
const Seen = z.string().regex(/^[0-9a-f]{64}$/);
const EditBody = z.object({ content: z.unknown(), seen: Seen.optional() }).strict();
const VariantParam = z.coerce.number().int().min(1).max(3);
const ApproveBody = z.object({ variant: z.number().int().min(1).max(3), request_id: z.string().min(8).max(200), seen: Seen.optional(), seen_people: z.number().int().min(0).optional() }).strict();

const STOP_NOT_AUTHORIZED = "Only an owner or admin can stop a send. Ask one of them to stop it.";

const STATUS: Record<string, number> = {
  not_found: 404,
  bad_variant: 400,
  bad_content: 400,
  not_authorized: 403,
  test_required: 409,
  not_open: 409,
  redraft_required: 409,
  card_changed: 409,
  version_changed: 409,
  count_required: 409,
  list_grew_since_shown: 409,
  all_suppressed: 409,
  tool_key_rejected: 409,
  not_stoppable: 409,
  email_paused: 409,
  exec_partial_no_retry: 409,
  rate_limited: 429,
  email_unverified: 409,
  not_connected: 409,
  sender_not_ready: 409,
  provider_refused: 422,
  sending_address_not_verified: 422,
  provider_unavailable: 502,
  test_list: 409,
};

function refuse(res: Response, code: string, message?: string): void {
  res.status(STATUS[code] ?? 409).json({ error: { code, message: message ?? EMAIL_CARD_MESSAGES[code] ?? "That could not be done." } });
}

function internal(res: Response, where: string): void {
  console.error(`[email-cards] ${where} failed`);
  res.status(500).json({ error: { code: "internal_error", message: "Something went wrong. Try again." } });
}

async function authed(req: Request, res: Response): Promise<{ auth: AuthedRequest; rail: (typeof EMAIL_CARD_RAILS)[number]; id: string } | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (auth.tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden workspace." } });
    return null;
  }
  const p = Params.safeParse(req.params);
  if (!p.success) {
    refuse(res, "not_found");
    return null;
  }
  return { auth, rail: p.data.rail, id: p.data.id };
}

export function emailCardHandlers(
  deps: Partial<CardDeps> = {},
  testListsOf?: (tenantId: string) => Promise<ReadonlySet<string>>,
  winLineOf?: typeof import("@/services/email-results/card").cardWinLine,
  tierCheck: typeof checkAgentTier = checkAgentTier,
) {
  const reads = cardVendorReads();
  return {
    async view(req: Request, res: Response): Promise<void> {
      const a = await authed(req, res);
      if (!a) return;
      try {
        const s = await emailCardViewState(a.auth.tenant_id, a.rail, a.id, a.auth.user_id, deps);
        if (!s.ok) return refuse(res, s.code);
        const tenant = a.auth.tenant_id;
        const group = reads(tenant, `group:${String(s.body.sendgrid_suppression_group_id)}`, () => (deps.groupName ?? sendgridGroupName)(tenant, s.body));
        const win = reads(tenant, `win:${a.rail}:${a.id}`, async () => {
          const { cardWinLine } = await import("@/services/email-results/card");
          return (winLineOf ?? cardWinLine)(tenant, a.rail, a.id, s.class, s.body);
        });
        const suppressed = s.open
          ? reads(tenant, `suppression:${String(s.body.audience_id)}:${String(s.body.sendgrid_suppression_group_id)}`, () => (deps.suppression ?? cardSuppression)(tenant, s.body))
          : null;
        const [testList, planned, { send, pause_hold, outcome }, viewer_email] = await Promise.all([
          cardOnTestList(tenant, s.class, s.body, testListsOf).catch((): null => null),
          plannedForCard(tenant, a.rail, a.id, deps),
          liveCardSend(tenant, a.rail, a.id, s, deps),
          (deps.confirmedEmail ?? (async (u: string) => (await import("@/services/email-cards/test-send")).confirmedEmailOf(u)))(a.auth.user_id).catch(() => null),
        ]);
        const unsent = s.open || send.retryable || (s.retryable === true && testList === false);
        const counted = unsent || s.class === "bulk_outbound.send"
          ? reads(tenant, cardCountKey(s.class, s.body), () => (deps.liveCount ?? liveCardCount)(tenant, s.class, s.body))
          : null;
        const [{ value: groupName }, { value: win_line }, suppression, count] = await Promise.all([group, win, suppressed, counted]);
        const planned_expected = typeof (s.body as Record<string, unknown>).planned_send_id === "string";
        const suppressionShown = suppression?.late && suppression.value === null ? { suppressed: 0, complete: false } : suppression?.value ?? null;
        const view = cardView(a.rail, a.id, s, groupName, testList, suppressionShown);
        const sendable = count?.value ?? null;
        res.json({
          card: {
            ...view,
            ...send,
            list: typeof sendable === "number" ? { ...view.list, people: sendable, ...(count?.late ? { unchecked: true } : {}) } : unsent ? { ...view.list, people: null, unchecked: true } : view.list,
            pause_hold,
            outcome,
            retryable: pause_hold !== "paused" && send.retryable && (view.retryable || send.status === "queued" || send.status === "approved" || send.status === "held"),
            win_line,
            planned,
            planned_expected,
            ...(viewer_email ? { viewer_email } : {}),
          },
        });
      } catch {
        internal(res, "view");
      }
    },

    async count(req: Request, res: Response): Promise<void> {
      const a = await authed(req, res);
      if (!a) return;
      try {
        const s = await emailCardViewState(a.auth.tenant_id, a.rail, a.id, a.auth.user_id, deps);
        if (!s.ok) return refuse(res, s.code);
        const [people, senderWarning] = await Promise.all([
          (deps.liveCount ?? liveCardCount)(a.auth.tenant_id, s.class, s.body),
          (deps.senderWarning ?? cardSenderWarning)(a.auth.tenant_id, s.class, s.body),
        ]);
        if (people === null) return refuse(res, "count_required");
        res.json(senderWarning ? { people, sender_warning: senderWarning } : { people });
      } catch (e) {
        if (e instanceof EmailToolKeyRejected) return refuse(res, "tool_key_rejected");
        internal(res, "count");
      }
    },

    async test(req: Request, res: Response): Promise<void> {
      const a = await authed(req, res);
      if (!a) return;
      const b = TestBody.safeParse(req.body);
      if (!b.success) return refuse(res, "bad_variant", "Send {variant} only: the test always goes to your own login address.");
      try {
        const r = await sendEmailCardTest(a.auth.tenant_id, a.rail, a.id, b.data.variant, a.auth.user_id, deps);
        if (!r.ok) return refuse(res, r.code, r.message);
        res.json(r.warning ? { ok: true, sent_with: r.via, warning: r.warning } : { ok: true, sent_with: r.via });
      } catch {
        internal(res, "test");
      }
    },

    async editVariant(req: Request, res: Response): Promise<void> {
      const a = await authed(req, res);
      if (!a) return;
      const n = VariantParam.safeParse((req.params as { n?: string }).n);
      const b = EditBody.safeParse(req.body);
      if (!n.success || !b.success) {
        return refuse(res, "bad_content", "Send {content} only. To change the list, the sender or the unsubscribe group, ask Zavi in chat for a new draft.");
      }
      try {
        const r = await editEmailCardVersion(a.auth.tenant_id, a.rail, a.id, n.data, a.auth.user_id, b.data.content, deps, b.data.seen ?? null);
        if (!r.ok) return refuse(res, r.code, r.message);
        res.json({ ok: true });
      } catch {
        internal(res, "edit");
      }
    },

    async stop(req: Request, res: Response): Promise<void> {
      const a = await authed(req, res);
      if (!a) return;
      try {
        const r = await stopEmailCardSend(a.auth.tenant_id, a.rail, a.id, a.auth.user_id, deps);
        if (!r.ok) return refuse(res, r.code, r.code === "not_authorized" ? STOP_NOT_AUTHORIZED : undefined);
        res.json({ stopped: r.stopped, already_sent: r.already_sent });
      } catch {
        internal(res, "stop");
      }
    },

    async approve(req: Request, res: Response): Promise<void> {
      const a = await authed(req, res);
      if (!a) return;
      const b = ApproveBody.safeParse(req.body);
      if (!b.success) return refuse(res, "bad_variant", "Send {variant, request_id}.");
      const tier = await emailSendHttpRefusal(a.auth.tenant_id, tierCheck);
      if (tier) {
        res.status(tier.status).json(tier.body);
        return;
      }
      try {
        const r = await approveEmailCard(a.auth.tenant_id, a.rail, a.id, b.data.variant, a.auth.user_id, b.data.request_id, deps, b.data.seen ?? null, b.data.seen_people ?? null);
        if (!r.ok) return refuse(res, r.code, r.message);
        res.json(r.paused ? { ok: true, queued: r.queued, changed: r.changed, paused: true } : { ok: true, queued: r.queued, changed: r.changed });
      } catch {
        internal(res, "approve");
      }
    },
  };
}

const live = emailCardHandlers();
export const getEmailCardHandler = live.view;
export const getEmailCardCountHandler = live.count;
export const postEmailCardTestHandler = live.test;
export const postEmailCardApproveHandler = live.approve;
export const patchEmailCardVariantHandler = live.editVariant;
export const postEmailCardStopHandler = live.stop;
