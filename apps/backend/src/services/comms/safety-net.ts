
import { serviceClient } from "@/services/supabase";

export type CommsChannel = "email" | "sms" | "slack_dm";

export type CommsSafetyInput = {
  tenant_id: string;
  channel: CommsChannel;
  recipient: string;
};

export type CommsSafetyDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "unsubscribed"
        | "suppressed"
        | "cap_exceeded"
        | "unsubscribe_unavailable"
        | "suppression_unavailable"
        | "cap_unavailable"
        | "invalid_input";
      detail?: string;
    };

export interface CommsSafetyStore {
  isUnsubscribed(tenant_id: string, channel: CommsChannel, recipient: string): Promise<boolean>;
  isSuppressed(tenant_id: string, channel: CommsChannel, recipient: string): Promise<boolean>;
  getRolling24hCount(
    tenant_id: string,
    channel: CommsChannel,
  ): Promise<{ sent24h: number; cap: number | null }>;
  consumeSend(
    tenant_id: string,
    channel: CommsChannel,
    recipient: string,
  ): Promise<boolean>;
}

export const supabaseCommsSafetyStore: CommsSafetyStore = {
  async isUnsubscribed(tenant_id, channel, recipient) {
    const { data, error } = await serviceClient().rpc("comms_is_unsubscribed", {
      p_tenant_id: tenant_id,
      p_channel: channel,
      p_recipient: recipient,
    });
    if (error) throw new Error(`comms_is_unsubscribed failed: ${error.message}`);
    return data === true;
  },

  async isSuppressed(tenant_id, channel, recipient) {
    const { data, error } = await serviceClient().rpc("comms_is_suppressed", {
      p_tenant_id: tenant_id,
      p_channel: channel,
      p_recipient: recipient,
    });
    if (error) throw new Error(`comms_is_suppressed failed: ${error.message}`);
    return (data as string | null) != null;
  },

  async getRolling24hCount(tenant_id, channel) {
    const { data, error } = await serviceClient().rpc("comms_rolling_24h_count", {
      p_tenant_id: tenant_id,
      p_channel: channel,
    });
    if (error) throw new Error(`comms_rolling_24h_count failed: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { sent24h: number | null; cap: number | null }
      | null
      | undefined;
    return {
      sent24h: Number(row?.sent24h ?? 0),
      cap: row?.cap ?? null,
    };
  },

  async consumeSend(tenant_id, channel, recipient) {
    const { data, error } = await serviceClient().rpc(
      "consume_comms_send_or_reject",
      {
        p_tenant_id: tenant_id,
        p_channel: channel,
        p_recipient: recipient,
      },
    );
    if (error) {
      throw new Error(`consume_comms_send_or_reject failed: ${error.message}`);
    }
    return data === true;
  },
};

export async function enforceCommsSafety(
  input: CommsSafetyInput,
  store: CommsSafetyStore = supabaseCommsSafetyStore,
): Promise<CommsSafetyDecision> {
  if (!input.tenant_id || !input.recipient || !input.channel) {
    return {
      allowed: false,
      reason: "invalid_input",
      detail: "tenant_id, channel, and recipient are all required",
    };
  }

  let unsubscribed: boolean;
  try {
    unsubscribed = await store.isUnsubscribed(
      input.tenant_id,
      input.channel,
      input.recipient,
    );
  } catch (e) {
    return {
      allowed: false,
      reason: "unsubscribe_unavailable",
      detail: (e as Error).message,
    };
  }
  if (unsubscribed) {
    return { allowed: false, reason: "unsubscribed" };
  }

  let suppressed: boolean;
  try {
    suppressed = await store.isSuppressed(
      input.tenant_id,
      input.channel,
      input.recipient,
    );
  } catch (e) {
    return {
      allowed: false,
      reason: "suppression_unavailable",
      detail: (e as Error).message,
    };
  }
  if (suppressed) {
    return { allowed: false, reason: "suppressed" };
  }

  let counts: { sent24h: number; cap: number | null };
  try {
    counts = await store.getRolling24hCount(input.tenant_id, input.channel);
  } catch (e) {
    return {
      allowed: false,
      reason: "cap_unavailable",
      detail: (e as Error).message,
    };
  }
  if (counts.cap != null && counts.sent24h >= counts.cap) {
    return {
      allowed: false,
      reason: "cap_exceeded",
      detail: `sent ${counts.sent24h} / cap ${counts.cap} in last 24h on ${input.channel}`,
    };
  }

  return { allowed: true };
}
