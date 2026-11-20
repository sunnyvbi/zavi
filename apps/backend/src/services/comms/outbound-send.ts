
import {
  enforceCommsSafety,
  supabaseCommsSafetyStore,
  type CommsSafetyDecision,
  type CommsSafetyStore,
  type CommsChannel,
} from "./safety-net";

export type OutboundMessage = {
  tenant_id: string;
  channel: CommsChannel;
  to: string;
  subject: string;
  body_text: string;
  body_html?: string;
};

export type OutboundSendResult =
  | { ok: true; message_id: string; channel: CommsChannel }
  | {
      ok: false;
      status: "blocked" | "not_connected";
      reason: string;
      detail?: string;
    };

export interface OutboundWireSender {
  send(msg: OutboundMessage): Promise<{ message_id: string } | null>;
}

function normalizeRecipient(channel: CommsChannel, to: string): string {
  if (channel === "email") return to.trim().toLowerCase();
  return to.trim();
}

export type SendOutboundDeps = {
  safetyStore?: CommsSafetyStore;
  wireSender: OutboundWireSender;
};

export async function sendOutbound(
  msg: OutboundMessage,
  deps: SendOutboundDeps,
): Promise<OutboundSendResult> {
  const recipient = normalizeRecipient(msg.channel, msg.to);

  const decision: CommsSafetyDecision = await enforceCommsSafety(
    {
      tenant_id: msg.tenant_id,
      channel: msg.channel,
      recipient,
    },
    deps.safetyStore,
  );

  if (!decision.allowed) {
    return {
      ok: false,
      status: "blocked",
      reason: decision.reason,
      detail: decision.detail,
    };
  }

  const store: CommsSafetyStore = deps.safetyStore ?? supabaseCommsSafetyStore;
  let charged: boolean;
  try {
    charged = await store.consumeSend(msg.tenant_id, msg.channel, recipient);
  } catch (e) {
    return {
      ok: false,
      status: "blocked",
      reason: "cap_unavailable",
      detail: (e as Error).message,
    };
  }
  if (!charged) {
    return {
      ok: false,
      status: "blocked",
      reason: "cap_exceeded",
      detail: `rolling-24h ${msg.channel} cap reached for tenant ${msg.tenant_id}`,
    };
  }

  const sent = await deps.wireSender.send({ ...msg, to: recipient });
  if (sent == null) {
    return {
      ok: false,
      status: "not_connected",
      reason: "no_sender_credential",
      detail: `no connected ${msg.channel} sender for tenant ${msg.tenant_id}`,
    };
  }

  return { ok: true, message_id: sent.message_id, channel: msg.channel };
}
