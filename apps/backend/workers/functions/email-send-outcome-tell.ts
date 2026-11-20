import { inngest } from "../client";
import type { SendOutcome } from "@/services/email-cards/outcome";
import type { RebuiltOutcome } from "@/services/email-cards/outcome-rebuild";
import { EMAIL_SEND_OUTCOME_TELL_EVENT, type SendOutcomeRef } from "@/services/email-cards/outcome-tell";

export { EMAIL_SEND_OUTCOME_TELL_EVENT, emailSendOutcomeTellEventId } from "@/services/email-cards/outcome-tell";

export type TellStep = { run<T>(id: string, fn: () => Promise<T>): Promise<T> };

export type TellWorkerDeps = {
  rebuild: (tenantId: string, ref: SendOutcomeRef) => Promise<RebuiltOutcome>;
  tell: (o: SendOutcome) => Promise<boolean>;
  keep: (o: SendOutcome) => Promise<boolean>;
};

const LIVE: TellWorkerDeps = {
  rebuild: async (tenantId, ref) => (await import("@/services/email-cards/outcome-rebuild")).rebuildSendOutcome(tenantId, ref),
  tell: async (o) => (await import("@/services/email-cards/outcome")).notifyEmailSendOutcomeOrThrow(o),
  keep: async (o) => (await import("@/services/email-cards/outcome")).keepEmailSendOutcomeLine(o),
};

const RAILS: ReadonlySet<string> = new Set(["decisions", "channel_actions"]);
const OUTCOMES: ReadonlySet<string> = new Set(["sent", "failed", "unknown"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ParsedTell = { tenantId: string; ref: SendOutcomeRef };

function parseRef(data: unknown): ParsedTell | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const tenantId = typeof d.tenant_id === "string" && UUID.test(d.tenant_id) ? d.tenant_id : null;
  if (!tenantId) return null;
  if (typeof d.rail !== "string" || !RAILS.has(d.rail)) return null;
  if (typeof d.card_id !== "string" || !UUID.test(d.card_id)) return null;
  if (typeof d.outcome !== "string" || !OUTCOMES.has(d.outcome)) return null;
  if (d.kind !== undefined && d.kind !== null && d.kind !== "" && d.kind !== "audience_mismatch") return null;
  return {
    tenantId,
    ref: {
      rail: d.rail as SendOutcomeRef["rail"],
      card_id: d.card_id,
      outcome: d.outcome as SendOutcomeRef["outcome"],
      ...(d.kind === "audience_mismatch" ? { kind: "audience_mismatch" as const } : {}),
    },
  };
}

function fromRef(tenantId: string, ref: SendOutcomeRef): SendOutcome {
  return { tenant_id: tenantId, rail: ref.rail, card_id: ref.card_id, outcome: ref.outcome, sent: null, ...(ref.kind ? { kind: ref.kind } : {}) };
}

export async function runEmailSendOutcomeTell(data: unknown, step: TellStep, depsIn: Partial<TellWorkerDeps> = {}): Promise<{ told: boolean }> {
  const deps = { ...LIVE, ...depsIn };
  const parsed = parseRef(data);
  if (!parsed) return { told: false };
  const { tenantId, ref } = parsed;
  try {
    const told = await step.run("tell-outcome", async () => {
      const r = await deps.rebuild(tenantId, ref);
      if (r && "pending" in r) throw new Error("send not settled yet");
      if (r && r.o.tenant_id === tenantId) return deps.tell(r.o);
      await deps.keep(fromRef(tenantId, ref));
      return false;
    });
    return { told };
  } catch (e) {
    console.warn(`[email-send-outcome-tell] ${ref.rail}/${ref.card_id}: outcome not told after retries: ${(e as Error).message}`);
    await step
      .run("keep-line", async () => {
        const r = await deps.rebuild(tenantId, ref).catch(() => null);
        return deps.keep(r && "o" in r && r.o.tenant_id === tenantId ? r.o : fromRef(tenantId, ref));
      })
      .catch((k) => console.warn(`[email-send-outcome-tell] ${ref.rail}/${ref.card_id}: outcome line not kept: ${(k as Error).message}`));
    return { told: false };
  }
}

export const emailSendOutcomeTellFn = inngest.createFunction(
  { id: "email-send-outcome-tell", retries: 4 },
  { event: EMAIL_SEND_OUTCOME_TELL_EVENT },
  async ({ event, step }) => runEmailSendOutcomeTell(event.data, step as unknown as TellStep),
);
