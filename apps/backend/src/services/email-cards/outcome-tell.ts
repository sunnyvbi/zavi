import type { EmailCardRail } from "./cards";
import type { EmailSendOutcomeKind, EmailSendOutcomeTell, SendOutcome } from "./outcome";
import type { RebuiltOutcome } from "./outcome-rebuild";

export type SendOutcomeRef = { rail: EmailCardRail; card_id: string; outcome: EmailSendOutcomeKind; kind?: "audience_mismatch" };

export const EMAIL_SEND_OUTCOME_TELL_EVENT = "email-send-outcome/tell.requested" as const;

export type EmailSendOutcomeTellEvent = {
  id: string;
  name: typeof EMAIL_SEND_OUTCOME_TELL_EVENT;
  data: SendOutcomeRef & { tenant_id: string };
};

export function emailSendOutcomeTellEventId(o: SendOutcomeRef): string {
  return `email-send-outcome-tell:${o.rail}:${o.card_id}:${o.outcome}:${o.kind ?? ""}`;
}

export function sendOutcomeRef(o: SendOutcomeRef): SendOutcomeRef {
  return { rail: o.rail, card_id: o.card_id, outcome: o.outcome, ...(o.kind ? { kind: o.kind } : {}) };
}

export type TellOrQueueDeps = {
  tell: (o: SendOutcome) => Promise<EmailSendOutcomeTell>;
  rebuild: (tenantId: string, ref: SendOutcomeRef) => Promise<RebuiltOutcome>;
  enqueue: (e: EmailSendOutcomeTellEvent) => Promise<unknown>;
  keep: (o: SendOutcome) => Promise<boolean>;
};

const LIVE: TellOrQueueDeps = {
  tell: async (o) => (await import("./outcome")).tellEmailSendOutcome(o),
  rebuild: async (tenantId, ref) => (await import("./outcome-rebuild")).rebuildSendOutcome(tenantId, ref),
  enqueue: async (e) => (await import("@/../workers/client")).inngest.send(e),
  keep: async (o) => (await import("./outcome")).keepEmailSendOutcomeLine(o),
};

export type TellOrQueueResult = EmailSendOutcomeTell | "queued" | "kept";

export async function tellEmailSendOutcomeOrQueue(o: SendOutcome, depsIn: Partial<TellOrQueueDeps> = {}): Promise<TellOrQueueResult> {
  const deps = { ...LIVE, ...depsIn };
  const r = await deps.tell(o).catch((e) => {
    console.warn(`[email-send-outcome] ${o.rail}/${o.card_id}: tell threw: ${(e as Error).message}`);
    return "retry" as const;
  });
  if (r !== "retry") return r;
  const ref = sendOutcomeRef(o);
  const rebuilt = await deps.rebuild(o.tenant_id, ref).catch((e) => {
    console.warn(`[email-send-outcome] ${o.rail}/${o.card_id}: outcome not read back: ${(e as Error).message}`);
    return { pending: true } as const;
  });
  const queueable = !!rebuilt && ("pending" in rebuilt || rebuilt.o.tenant_id === o.tenant_id);
  if (queueable) {
    try {
      await deps.enqueue({ id: emailSendOutcomeTellEventId(ref), name: EMAIL_SEND_OUTCOME_TELL_EVENT, data: { tenant_id: o.tenant_id, ...ref } });
      return "queued";
    } catch (e) {
      console.warn(`[email-send-outcome] ${o.rail}/${o.card_id}: outcome retry not queued: ${(e as Error).message}`);
    }
  }
  try {
    await deps.keep(o);
  } catch (e) {
    console.warn(`[email-send-outcome] ${o.rail}/${o.card_id}: outcome line not kept: ${(e as Error).message}`);
    return "retry";
  }
  return "kept";
}
