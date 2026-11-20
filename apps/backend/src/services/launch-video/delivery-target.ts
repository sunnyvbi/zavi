
export type VideoDeliveryTarget =
  | { kind: "slack"; channel_id: string; thread_ts?: string; team_id?: string | null }
  | { kind: "chat"; thread_id: string };

export type ChannelActionDeliveryTarget = { kind: "channel_action"; action_id: string; claim_id: string };

export type VideoRenderTarget = VideoDeliveryTarget | ChannelActionDeliveryTarget;

export function resolveVideoDeliveryTarget(args: {
  slack_routing?: { channel_id?: string; thread_ts?: string; team_id?: string } | null;
  chat_thread_id?: string | null;
}): VideoDeliveryTarget | null {
  const channel_id = args.slack_routing?.channel_id;
  if (channel_id) {
    return {
      kind: "slack",
      channel_id,
      thread_ts: args.slack_routing?.thread_ts,
      team_id: args.slack_routing?.team_id ?? null,
    };
  }
  const thread_id = args.chat_thread_id;
  if (thread_id) return { kind: "chat", thread_id };
  return null;
}

export const NO_DELIVERY_SURFACE_MESSAGE =
  "I don't have anywhere to deliver the video — ask me from a chat thread or from Slack.";
